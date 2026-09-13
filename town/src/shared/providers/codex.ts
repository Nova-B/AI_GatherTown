/**
 * Codex CLI hook normalizer (checked 2026-09-13 against
 * https://learn.chatgpt.com/docs/hooks and
 * https://github.com/openai/codex/blob/main/codex-rs/core/src/hook_runtime.rs;
 * target CLI version 0.154.0).
 *
 * Identity rules:
 * - `session_id` is the session, `turn_id` the turn (turn-scoped hooks only).
 * - SubagentStart/SubagentStop carry the PARENT `session_id` and the child's
 *   `agent_id`/`agent_type`. That proves session membership only: Codex agents
 *   can be nested, and the payload names no immediate spawner. The immediate
 *   parent is therefore recorded as unknown (parentAgentId null), and the UI
 *   shows "세션 소속" separately from "상위 미확인".
 * - hook_runtime.rs passes the subagent hook context to every tool request
 *   builder, so tool hooks fired inside a subagent are expected to carry
 *   `agent_id`; this has not been verified against a live run.
 * - Tool hooks (PreToolUse/PostToolUse/PermissionRequest) cover local
 *   function tools only: shell/exec_command/write_stdin, apply_patch and MCP
 *   tools. Hosted tools such as WebSearch never reach these hooks.
 * - apply_patch input lives under `tool_input.command`; only file headers are
 *   extracted, the patch body is never stored.
 * - Codex has no PostToolUseFailure hook. PostToolUse outcome comes from
 *   `tool_response` (exit_code, isError/is_error, success/ok, error). With no
 *   signal the call is recorded as ended with an unknown outcome, never as
 *   success.
 * - Stop = turn/response completion. Interrupt = the turn was interrupted.
 */
import type { AgentEvent, AgentEventPayload } from '../events.js';
import { MAIN_AGENT_ID } from '../events.js';
import { sanitizeText } from '../redact.js';
import {
  baseParts,
  idStr,
  makeEvent,
  MAX_NOTE,
  type NormalizeContext,
  type RawPayload,
  str,
  summarizeToolResponse,
  toolPayload,
} from './common.js';

/** Hook events Agent Town installs for Codex. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt',
  'SubagentStart',
  'SubagentStop',
] as const;

export function normalizeCodex(raw: RawPayload, ctx: NormalizeContext): AgentEvent | null {
  const base = baseParts(raw, ctx.homeDir);
  if (!base) return null;
  const home = ctx.homeDir;
  const toolCallId = idStr(raw.tool_use_id) ?? idStr(raw.call_id) ?? null;

  switch (base.hookEventName) {
    case 'SessionStart': {
      const payload: AgentEventPayload = {};
      const reason = str(raw.source) ?? str(raw.reason);
      if (reason) payload.reason = reason.slice(0, 32);
      const model = idStr(raw.model);
      if (model) payload.model = model;
      const pm = str(raw.permission_mode);
      if (pm) payload.permissionMode = pm.slice(0, 32);
      return makeEvent('codex', ctx, base, 'session.started', payload, {
        agentId: MAIN_AGENT_ID,
        agentIdOrigin: 'internal-main',
      });
    }
    case 'SessionEnd': {
      const payload: AgentEventPayload = {};
      const reason = str(raw.reason);
      if (reason) payload.reason = reason.slice(0, 32);
      return makeEvent('codex', ctx, base, 'session.ended', payload, {
        agentId: MAIN_AGENT_ID,
        agentIdOrigin: 'internal-main',
      });
    }
    case 'UserPromptSubmit': {
      const payload: AgentEventPayload = {};
      const model = idStr(raw.model);
      if (model) payload.model = model;
      return makeEvent('codex', ctx, base, 'turn.started', payload);
    }
    case 'PreToolUse': {
      return makeEvent('codex', ctx, base, 'tool.started', toolPayload(raw, home), {
        toolCallId,
      });
    }
    case 'PostToolUse': {
      const payload = toolPayload(raw, home);
      const summary = summarizeToolResponse(raw.tool_response, home);
      if (summary.exitCode !== undefined) payload.exitCode = summary.exitCode;
      if (summary.outcome === 'failed') {
        payload.outcome = 'failed';
        if (summary.error) payload.error = summary.error;
        return makeEvent('codex', ctx, base, 'tool.failed', payload, { toolCallId });
      }
      payload.outcome = summary.outcome === 'completed' ? 'completed' : 'unknown';
      return makeEvent('codex', ctx, base, 'tool.completed', payload, { toolCallId });
    }
    case 'PermissionRequest': {
      return makeEvent('codex', ctx, base, 'approval.requested', toolPayload(raw, home), {
        toolCallId,
      });
    }
    case 'Stop': {
      // hook_runtime.rs: Stop carries `target` (Stop | SubagentStop). A Stop
      // with a subagent target and agent_id belongs to that child.
      return makeEvent('codex', ctx, base, 'agent.response_completed', {});
    }
    case 'Interrupt': {
      const payload: AgentEventPayload = { reason: 'interrupted' };
      const note = sanitizeText(raw.reason, MAX_NOTE, home);
      if (note) payload.note = note;
      return makeEvent('codex', ctx, base, 'turn.failed', payload);
    }
    case 'SubagentStart': {
      const childId = idStr(raw.agent_id);
      if (!childId) {
        return makeEvent('codex', ctx, base, 'unknown', {
          hookEventName: base.hookEventName,
          note: 'SubagentStart without agent_id',
        });
      }
      const payload: AgentEventPayload = {};
      const agentType = idStr(raw.agent_type);
      if (agentType) payload.agentType = agentType;
      return makeEvent('codex', ctx, base, 'agent.started', payload, {
        agentId: childId,
        agentIdOrigin: 'source',
        parentAgentId: null,
      });
    }
    case 'SubagentStop': {
      const childId = idStr(raw.agent_id);
      if (!childId) {
        return makeEvent('codex', ctx, base, 'unknown', {
          hookEventName: base.hookEventName,
          note: 'SubagentStop without agent_id',
        });
      }
      const payload: AgentEventPayload = {};
      const agentType = idStr(raw.agent_type);
      if (agentType) payload.agentType = agentType;
      return makeEvent('codex', ctx, base, 'agent.response_completed', payload, {
        agentId: childId,
        agentIdOrigin: 'source',
        parentAgentId: null,
      });
    }
    case 'PreCompact':
    case 'PostCompact': {
      const payload: AgentEventPayload = { notificationType: base.hookEventName };
      const trigger = str(raw.trigger);
      if (trigger) payload.reason = trigger.slice(0, 32);
      return makeEvent('codex', ctx, base, 'notification', payload);
    }
    default: {
      return makeEvent('codex', ctx, base, 'unknown', { hookEventName: base.hookEventName });
    }
  }
}
