/**
 * Agent Town canonical event model.
 *
 * This is the product-internal schema. Providers (src/server/providers/*)
 * translate raw Claude Code / Codex hook payloads into these events. Nothing
 * downstream (store, reducer, UI) ever looks at CLI-specific field names.
 *
 * Rules that keep the model honest:
 * - IDs are copied from the source when present. When the source omits an ID
 *   the event says so explicitly (`toolCallId: null`, `agentIdOrigin`), and the
 *   reducer creates an "unknown" record instead of guessing by timestamp.
 * - `evidence` is 'observed' for facts directly stated by the hook payload and
 *   'inferred' for product interpretations (for example: a pending approval
 *   that was never explicitly resolved but whose turn has ended).
 * - `payload` never contains prompts, file contents, or full tool responses.
 */

export type Provider = 'claude' | 'codex';

export type EventSource = 'hook' | 'demo';

export type AgentEventKind =
  | 'session.started'
  | 'session.ended'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'agent.started'
  | 'agent.response_completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'notification'
  | 'unknown';

export type Evidence = 'observed' | 'inferred';

/** Product-level activity classification for a tool call (drives animation/zone). */
export type ActivityClass =
  | 'read'
  | 'search'
  | 'edit'
  | 'shell'
  | 'web'
  | 'mcp'
  | 'agent'
  | 'plan'
  | 'other';

/** 'unknown' = the tool ended but the provider response carried no outcome signal. */
export type ToolOutcome = 'completed' | 'failed' | 'denied' | 'unknown';

export interface AgentEventPayload {
  /** Provider tool name exactly as supplied (e.g. "Bash", "apply_patch", "mcp__x__y"). */
  toolName?: string;
  /** Short masked target (file name, command head, pattern). Never full content. */
  toolTarget?: string;
  activity?: ActivityClass;
  outcome?: ToolOutcome;
  /** Masked, truncated error text. */
  error?: string;
  /** Exit code when the provider response exposes one. */
  exitCode?: number;
  /** SessionStart reason/source, SessionEnd reason, Interrupt reason, etc. */
  reason?: string;
  /** Subagent type/name as reported by the provider. */
  agentType?: string;
  /** Provider model id when supplied. */
  model?: string;
  /** Provider permission mode when supplied. */
  permissionMode?: string;
  /** Notification type (Claude Notification hook). */
  notificationType?: string;
  /** Approval decision when known. */
  decision?: 'allowed' | 'denied' | 'unknown';
  /** Raw hook event name, kept for diagnostics of 'unknown' events. */
  hookEventName?: string;
  /** Free-form short note (masked). */
  note?: string;
}

export interface AgentEvent {
  schemaVersion: 1;
  /** Unique per delivery attempt group (retries reuse it) - used for dedupe. */
  eventId: string;
  provider: Provider;
  source: EventSource;
  /** Raw provider hook event name (e.g. "PreToolUse"). */
  hookEventName: string;
  /** Provider session id verbatim. */
  sessionId: string;
  /** Provider turn id when supplied (Codex turn_id, Claude prompt_id). */
  turnId: string | null;
  /**
   * Agent this event belongs to. 'main' is the explicit internal id for the
   * session's root agent when the provider does not give one.
   */
  agentId: string;
  agentIdOrigin: 'source' | 'internal-main';
  /**
   * Immediate parent agent id only when the provider semantics establish it
   * (Claude Code: subagents cannot spawn subagents, so a child's parent is
   * the session root). Codex subagent hooks only state session membership,
   * so the immediate parent stays null (unknown) there.
   */
  parentAgentId: string | null;
  /** Provider tool_use_id verbatim; null when the payload had none. */
  toolCallId: string | null;
  kind: AgentEventKind;
  evidence: Evidence;
  /** Masked working directory (home replaced by ~). */
  cwd: string | null;
  /** Provider-reported time when supplied; hooks usually do not supply one. */
  occurredAt: string | null;
  /** Server receive time (ISO). */
  receivedAt: string;
  /** Monotonic server ingest sequence; 0 until stored. */
  ingestSeq: number;
  payload: AgentEventPayload;
}

export function sessionKey(provider: Provider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

export function agentKey(provider: Provider, sessionId: string, agentId: string): string {
  return `${provider}:${sessionId}:${agentId}`;
}

export const MAIN_AGENT_ID = 'main';
