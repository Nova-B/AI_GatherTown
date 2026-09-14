/**
 * Claude Code hook normalizer (checked against https://code.claude.com/docs/en/hooks
 * on 2026-09-13; target CLI version 2.1.270).
 *
 * Input: the JSON that Claude Code writes to the hook's stdin, after the hook
 * sender has already dropped prompt text, transcripts and tool responses.
 *
 * Identity rules:
 * - `session_id` is the session. `prompt_id` is used as turn id when present.
 * - `agent_id` is present only inside subagent contexts; without it the event
 *   belongs to the explicit root agent 'main'.
 * - SubagentStart/SubagentStop fire in the parent session with the child's
 *   `agent_id`; Claude Code subagents cannot spawn subagents (Agent tool is
 *   unavailable inside a subagent), so a child's immediate parent is the
 *   session root. That is recorded with parentEvidence 'provider-semantics'.
 * - Stop = the main agent finished a response (turn), not session end.
 * - SubagentStop = the child finished its response.
 */
import type { AgentEvent, AgentEventPayload } from '../events.js';
import { MAIN_AGENT_ID } from '../events.js';
import { sanitizeText } from '../redact.js';
import {
  baseParts,
  idStr,
  makeEvent,
  MAX_ERROR,
  MAX_NOTE,
  type NormalizeContext,
  type RawPayload,
  str,
  summarizeToolResponse,
  toolPayload,
} from './common.js';

/** Hook events Agent Town installs for Claude Code. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PostModelSwitch',
] as const;

export function normalizeClaude(raw: RawPayload, ctx: NormalizeContext): AgentEvent | null {
  const base = baseParts(raw, ctx.homeDir);
  if (!base) return null;
  const home = ctx.homeDir;
  const toolCallId = idStr(raw.tool_use_id) ?? null;

  switch (base.hookEventName) {
    case 'SessionStart': {
      const payload: AgentEventPayload = {};
      const reason = str(raw.reason) ?? str(raw.source);
      if (reason) payload.reason = reason.slice(0, 32);
      const model = idStr(raw.model);
      if (model) payload.model = model;
      const pm = str(raw.permission_mode);
      if (pm) payload.permissionMode = pm.slice(0, 32);
      return makeEvent('claude', ctx, base, 'session.started', payload, {
        agentId: MAIN_AGENT_ID,
        agentIdOrigin: 'internal-main',
      });
    }
    case 'SessionEnd': {
      const payload: AgentEventPayload = {};
      const reason = str(raw.reason);
      if (reason) payload.reason = reason.slice(0, 32);
      return makeEvent('claude', ctx, base, 'session.ended', payload, {
        agentId: MAIN_AGENT_ID,
        agentIdOrigin: 'internal-main',
      });
    }
    case 'UserPromptSubmit': {
      // The prompt text is never carried; only the fact that a turn started.
      const payload: AgentEventPayload = {};
      const pm = str(raw.permission_mode);
      if (pm) payload.permissionMode = pm.slice(0, 32);
      return makeEvent('claude', ctx, base, 'turn.started', payload);
    }
    case 'PreToolUse': {
      return makeEvent('claude', ctx, base, 'tool.started', toolPayload(raw, home), {
        toolCallId,
      });
    }
    case 'PostToolUse': {
      // Claude Code fires PostToolUse only after a tool completed; failures
      // arrive as PostToolUseFailure. A response that nevertheless states an
      // error (e.g. MCP CallToolResult isError, non-zero exit_code) is
      // recorded as failed; no signal at all means completed.
      const payload = toolPayload(raw, home);
      const summary = summarizeToolResponse(raw.tool_response, home);
      if (summary.exitCode !== undefined) payload.exitCode = summary.exitCode;
      if (summary.outcome === 'failed') {
        payload.outcome = 'failed';
        if (summary.error) payload.error = summary.error;
        return makeEvent('claude', ctx, base, 'tool.failed', payload, { toolCallId });
      }
      payload.outcome = 'completed';
      return makeEvent('claude', ctx, base, 'tool.completed', payload, { toolCallId });
    }
    case 'PostToolUseFailure': {
      const payload = toolPayload(raw, home);
      payload.outcome = 'failed';
      const error = sanitizeText(raw.error, MAX_ERROR, home);
      if (error) payload.error = error;
      return makeEvent('claude', ctx, base, 'tool.failed', payload, { toolCallId });
    }
    case 'PermissionRequest': {
      const payload = toolPayload(raw, home);
      return makeEvent('claude', ctx, base, 'approval.requested', payload, { toolCallId });
    }
    case 'PermissionDenied': {
      const payload = toolPayload(raw, home);
      payload.decision = 'denied';
      payload.outcome = 'denied';
      return makeEvent('claude', ctx, base, 'approval.resolved', payload, { toolCallId });
    }
    case 'Notification': {
      const type = (str(raw.notification_type) ?? 'unknown').slice(0, 48);
      const payload: AgentEventPayload = { notificationType: type };
      const note = sanitizeText(raw.message, MAX_NOTE, home);
      if (note) payload.note = note;
      if (type === 'permission_prompt') {
        // Permission prompt notification carries no tool_use_id: it is an
        // approval request whose exact tool cannot be linked.
        return makeEvent('claude', ctx, base, 'approval.requested', payload, {
          toolCallId: null,
        });
      }
      return makeEvent('claude', ctx, base, 'notification', payload);
    }
    case 'Stop': {
      // Response finished for whichever agent context fired it (main unless
      // agent_id is present).
      const payload: AgentEventPayload = {};
      if (typeof raw.stop_hook_active === 'boolean' && raw.stop_hook_active) {
        payload.note = 'stop_hook_active';
      }
      return makeEvent('claude', ctx, base, 'agent.response_completed', payload);
    }
    case 'SubagentStart': {
      const childId = idStr(raw.agent_id);
      if (!childId) {
        return makeEvent('claude', ctx, base, 'unknown', {
          hookEventName: base.hookEventName,
          note: 'SubagentStart without agent_id',
        });
      }
      const payload: AgentEventPayload = {};
      const agentType = idStr(raw.agent_type);
      if (agentType) payload.agentType = agentType;
      return makeEvent('claude', ctx, base, 'agent.started', payload, {
        agentId: childId,
        agentIdOrigin: 'source',
        parentAgentId: MAIN_AGENT_ID,
      });
    }
    case 'SubagentStop': {
      const childId = idStr(raw.agent_id);
      if (!childId) {
        return makeEvent('claude', ctx, base, 'unknown', {
          hookEventName: base.hookEventName,
          note: 'SubagentStop without agent_id',
        });
      }
      const payload: AgentEventPayload = {};
      const agentType = idStr(raw.agent_type);
      if (agentType) payload.agentType = agentType;
      return makeEvent('claude', ctx, base, 'agent.response_completed', payload, {
        agentId: childId,
        agentIdOrigin: 'source',
        parentAgentId: MAIN_AGENT_ID,
      });
    }
    case 'PostModelSwitch': {
      // `model` is only ever supplied on SessionStart (and not always); a
      // /model switch is the only later evidence of the session's model.
      const payload: AgentEventPayload = { notificationType: 'PostModelSwitch' };
      const to = idStr(raw.to_model);
      const from = idStr(raw.from_model);
      if (to) payload.model = to;
      if (from || to) payload.note = `${from ?? '?'} → ${to ?? '?'}`;
      return makeEvent('claude', ctx, base, 'notification', payload);
    }
    default: {
      return makeEvent('claude', ctx, base, 'unknown', { hookEventName: base.hookEventName });
    }
  }
}
