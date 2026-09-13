import { classifyTool } from '../activity.js';
import type { ActivityClass, AgentEvent, AgentEventPayload, Provider } from '../events.js';
import { MAIN_AGENT_ID } from '../events.js';
import { mask, sanitizeText, shortPath, truncate } from '../redact.js';

export const MAX_TARGET = 120;
export const MAX_ERROR = 300;
export const MAX_NOTE = 160;
export const MAX_ID = 128;

export interface NormalizeContext {
  /** Delivery envelope id from the hook sender (used for dedupe). */
  eventId: string;
  receivedAt: string;
  homeDir: string | null;
  source: 'hook' | 'demo';
}

export type RawPayload = Record<string, unknown>;

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ASCII control characters (0x00-0x1f, 0x7f), built from char codes so the
// source file itself contains no control bytes.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/**
 * Identifier from an untrusted payload: bounded, control characters stripped.
 * Prototype-like names ("__proto__", "constructor", "prototype") are kept as
 * values; every dictionary in the state uses own-key access (shared/dict.ts),
 * so they can never resolve through Object.prototype.
 */
export function idStr(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const cleaned = s.replace(CONTROL_CHARS, '');
  if (!cleaned) return undefined;
  return cleaned.length > MAX_ID ? cleaned.slice(0, MAX_ID) : cleaned;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function obj(v: unknown): RawPayload | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as RawPayload) : undefined;
}

const PATCH_HEADER = /^\*\*\* (Add|Update|Delete|Move to) File: (.+)$/;

/** File names named in apply_patch headers; the patch body is never returned. */
export function patchFiles(patch: string, homeDir: string | null): string[] {
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = PATCH_HEADER.exec(line.trim());
    if (m && m[2]) files.push(shortPath(m[2].trim(), homeDir));
    if (files.length >= 3) break;
  }
  return files;
}

/**
 * Build a short masked "target" for a tool call from its input. Only a small
 * allowlist of well-known argument names is read; everything else is ignored.
 * Never returns file contents, full commands, patch bodies or prompts.
 */
export function summarizeToolInput(
  toolName: string | undefined,
  toolInput: unknown,
  homeDir: string | null,
  activity: ActivityClass,
): string | undefined {
  const input = obj(toolInput);
  if (!input) {
    if (typeof toolInput === 'string') return sanitizeText(toolInput, 60, homeDir);
    return undefined;
  }
  const lowerName = toolName?.toLowerCase();
  if (lowerName === 'apply_patch') {
    // Codex docs: the patch text is under `command`; other shapes use patch/input.
    const patch = str(input.command) ?? str(input.patch) ?? str(input.input);
    if (patch) {
      const files = patchFiles(patch, homeDir);
      return files.length ? truncate(files.join(', '), MAX_TARGET) : '(patch)';
    }
  }
  const pathLike =
    str(input.file_path) ??
    str(input.path) ??
    str(input.notebook_path) ??
    str(input.filePath) ??
    str(input.target_file);
  if (pathLike) return truncate(shortPath(pathLike, homeDir), MAX_TARGET);

  if (activity === 'shell') {
    const cmd =
      str(input.command) ??
      str(input.cmd) ??
      (Array.isArray(input.command) ? input.command.map(String).join(' ') : undefined) ??
      (Array.isArray(input.cmd) ? input.cmd.map(String).join(' ') : undefined);
    if (cmd) {
      const head = cmd.split(/\r?\n/)[0] ?? cmd;
      return sanitizeText(head, 80, homeDir);
    }
    if (str(input.chars)) return '(stdin 입력)';
  }
  const pattern = str(input.pattern) ?? str(input.query) ?? str(input.glob);
  if (pattern) return sanitizeText(pattern, 60, homeDir);
  const url = str(input.url);
  if (url) {
    try {
      const u = new URL(url);
      return truncate(mask(`${u.hostname}${u.pathname}`, homeDir), 80);
    } catch {
      return sanitizeText(url, 60, homeDir);
    }
  }
  const description =
    str(input.description) ?? str(input.subagent_type) ?? str(input.prompt_title);
  if (description) return sanitizeText(description, 80, homeDir);
  const keys = Object.keys(input).slice(0, 4);
  return keys.length ? `{${keys.map((k) => mask(k, homeDir).slice(0, 24)).join(', ')}}` : undefined;
}

export interface ResponseSummary {
  exitCode?: number;
  error?: string;
  /** 'failed' | 'completed' when the response states it; 'unknown' when it does not. */
  outcome: 'failed' | 'completed' | 'unknown';
}

/**
 * Bounded, masked outcome summary from a tool response.
 * Explicit failure signals: exit_code/exitCode/returncode != 0, is_error /
 * isError (MCP CallToolResult) true, success/ok false, a non-empty `error`.
 * Explicit success signals: exit_code 0, success/ok true, is_error/isError false.
 * Anything else is 'unknown' - the caller decides what that means for its CLI.
 */
export function summarizeToolResponse(
  toolResponse: unknown,
  homeDir: string | null,
): ResponseSummary {
  const r = obj(toolResponse);
  if (!r) return { outcome: 'unknown' };
  const exitCode = num(r.exit_code) ?? num(r.exitCode) ?? num(r.returncode);
  const errorFlag =
    (typeof r.is_error === 'boolean' && r.is_error) ||
    (typeof r.isError === 'boolean' && r.isError) ||
    (typeof r.success === 'boolean' && !r.success) ||
    (typeof r.ok === 'boolean' && !r.ok);
  const okFlag =
    (typeof r.is_error === 'boolean' && !r.is_error) ||
    (typeof r.isError === 'boolean' && !r.isError) ||
    (typeof r.success === 'boolean' && r.success) ||
    (typeof r.ok === 'boolean' && r.ok);
  const errorText = sanitizeText(r.error ?? r.stderr_summary ?? r.message, MAX_ERROR, homeDir);
  const hasErrorText = typeof r.error === 'string' && r.error.trim().length > 0;
  const failed = errorFlag || (exitCode !== undefined && exitCode !== 0) || hasErrorText;
  const out: ResponseSummary = {
    outcome: failed ? 'failed' : okFlag || exitCode === 0 ? 'completed' : 'unknown',
  };
  if (exitCode !== undefined) out.exitCode = exitCode;
  if (failed && errorText) out.error = errorText;
  return out;
}

export interface BaseParts {
  sessionId: string;
  hookEventName: string;
  cwd: string | null;
  turnId: string | null;
  agentId: string;
  agentIdOrigin: 'source' | 'internal-main';
}

export function baseParts(raw: RawPayload, homeDir: string | null): BaseParts | null {
  const sessionId = idStr(raw.session_id);
  const hookEventName = idStr(raw.hook_event_name);
  if (!sessionId || !hookEventName) return null;
  const cwdRaw = str(raw.cwd);
  const cwd = cwdRaw ? truncate(mask(cwdRaw, homeDir), 200) : null;
  const turnId = idStr(raw.turn_id) ?? idStr(raw.prompt_id) ?? null;
  const agentId = idStr(raw.agent_id);
  return {
    sessionId,
    hookEventName,
    cwd,
    turnId,
    agentId: agentId ?? MAIN_AGENT_ID,
    agentIdOrigin: agentId ? 'source' : 'internal-main',
  };
}

export function makeEvent(
  provider: Provider,
  ctx: NormalizeContext,
  base: BaseParts,
  kind: AgentEvent['kind'],
  payload: AgentEventPayload,
  extra: Partial<
    Pick<AgentEvent, 'agentId' | 'agentIdOrigin' | 'parentAgentId' | 'toolCallId' | 'evidence'>
  > = {},
): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: ctx.eventId,
    provider,
    source: ctx.source,
    hookEventName: base.hookEventName,
    sessionId: base.sessionId,
    turnId: base.turnId,
    agentId: extra.agentId ?? base.agentId,
    agentIdOrigin: extra.agentIdOrigin ?? base.agentIdOrigin,
    parentAgentId: extra.parentAgentId ?? null,
    toolCallId: extra.toolCallId ?? null,
    kind,
    evidence: extra.evidence ?? 'observed',
    cwd: base.cwd,
    occurredAt: null,
    receivedAt: ctx.receivedAt,
    ingestSeq: 0,
    payload,
  };
}

export function toolPayload(raw: RawPayload, homeDir: string | null): AgentEventPayload {
  const toolName = idStr(raw.tool_name);
  const activity = classifyTool(toolName);
  const target = summarizeToolInput(toolName, raw.tool_input, homeDir, activity);
  const payload: AgentEventPayload = { activity };
  if (toolName) payload.toolName = mask(toolName, homeDir);
  if (target) payload.toolTarget = target;
  return payload;
}

export { classifyTool };
