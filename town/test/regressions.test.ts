/**
 * Lasting copies of the supervisor regressions (supervision/supervisor-regressions.mts)
 * plus the neighbouring cases they imply. Synthetic payloads only.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getOwn, ownValues } from '../src/shared/dict.js';
import { normalizeClaude } from '../src/shared/providers/claude.js';
import { redactSecrets } from '../src/shared/redact.js';
import { agentDisplayStatus, applyEvent, createInitialState, toolKey } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

const SID = 'supervisor-session';
const c = (name: string, fields: Record<string, unknown> = {}) =>
  ev('claude', { session_id: SID, hook_event_name: name, ...fields });

beforeEach(() => resetCounter());

describe('supervisor regressions', () => {
  it('root Stop completes the current turn exactly once; a child Stop does not', () => {
    const st = createInitialState();
    applyEvent(st, c('UserPromptSubmit'));
    applyEvent(st, c('SubagentStart', { agent_id: 'child-1' }));
    applyEvent(st, c('SubagentStop', { agent_id: 'child-1' }));
    const s = getOwn(st.sessions, 'claude:' + SID)!;
    expect(s.currentTurn?.status).toBe('running');
    applyEvent(st, c('Stop'));
    expect(s.currentTurn?.status).toBe('completed');
    expect(s.turnsCompleted).toBe(1);
    applyEvent(st, c('Stop'));
    expect(s.turnsCompleted).toBe(1);
  });

  it('a delayed explicit outcome refines an unresolved call', () => {
    const st = createInitialState();
    applyEvent(st, c('PreToolUse', { tool_use_id: 'call-1', tool_name: 'Bash' }));
    applyEvent(st, c('Stop'));
    const s = getOwn(st.sessions, 'claude:' + SID)!;
    const tc = getOwn(s.toolCalls, toolKey('main', 'call-1'))!;
    expect(tc.status).toBe('unresolved');
    applyEvent(st, c('PostToolUse', { tool_use_id: 'call-1', tool_name: 'Bash', tool_response: { exit_code: 0 } }));
    expect(tc.status).toBe('completed');
    expect(tc.lateOutcome).toBe(true);
    // The agent was not reactivated by the late outcome.
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('done');
    // A later failure for the same, now terminal, call is ignored.
    applyEvent(st, c('PostToolUseFailure', { tool_use_id: 'call-1', tool_name: 'Bash', error: 'late' }));
    expect(tc.status).toBe('completed');
  });

  it('a late duplicate start never reactivates a finished agent', () => {
    const st = createInitialState();
    applyEvent(st, c('PreToolUse', { tool_use_id: 'call-2', tool_name: 'Read' }));
    applyEvent(st, c('PostToolUse', { tool_use_id: 'call-2', tool_name: 'Read' }));
    applyEvent(st, c('Stop'));
    applyEvent(st, c('PreToolUse', { tool_use_id: 'call-2', tool_name: 'Read' }));
    const s = getOwn(st.sessions, 'claude:' + SID)!;
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('done');
    expect(s.agents.main!.activeToolIds).toEqual([]);
    expect(s.agents.main!.lifecycle).toBe('idle');
    expect(s.duplicatesIgnored).toBe(1);
  });

  it('two children can use the same agent-local tool id independently', () => {
    const st = createInitialState();
    applyEvent(st, c('SubagentStart', { agent_id: 'child-a', agent_type: 'Explore' }));
    applyEvent(st, c('SubagentStart', { agent_id: 'child-b', agent_type: 'Explore' }));
    applyEvent(st, c('PreToolUse', { agent_id: 'child-a', tool_use_id: 'local-call', tool_name: 'Read' }));
    applyEvent(st, c('PreToolUse', { agent_id: 'child-b', tool_use_id: 'local-call', tool_name: 'Grep' }));
    const s = getOwn(st.sessions, 'claude:' + SID)!;
    expect(getOwn(s.agents, 'child-a')!.activeToolIds).toHaveLength(1);
    expect(getOwn(s.agents, 'child-b')!.activeToolIds).toHaveLength(1);
    expect(ownValues(s.toolCalls)).toHaveLength(2);
    // Finishing child-a's call leaves child-b's running, and source ids are preserved.
    applyEvent(st, c('PostToolUse', { agent_id: 'child-a', tool_use_id: 'local-call', tool_name: 'Read' }));
    expect(getOwn(s.agents, 'child-a')!.activeToolIds).toHaveLength(0);
    expect(getOwn(s.agents, 'child-b')!.activeToolIds).toHaveLength(1);
    const calls = ownValues(s.toolCalls);
    expect(calls.every((t) => t.sourceId === 'local-call')).toBe(true);
    expect(calls.map((t) => t.status).sort()).toEqual(['completed', 'running']);
  });

  it('Authorization bearer credentials are fully redacted', () => {
    const sample = 'curl -H "Authorization: Bearer supervisor_fake_credential_123456" https://example.test';
    expect(redactSecrets(sample)).not.toContain('supervisor_fake_credential_123456');
  });

  it('prototype-like source agent ids become own records and never touch Object.prototype', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      const st = createInitialState();
      applyEvent(st, c('SubagentStart', { agent_id: id, agent_type: 'Explore' }));
      applyEvent(st, c('PreToolUse', { agent_id: id, tool_use_id: '__proto__', tool_name: 'Read' }));
      applyEvent(st, c('PermissionRequest', { agent_id: id, tool_use_id: 'constructor', tool_name: 'Bash' }));
      const s = getOwn(st.sessions, 'claude:' + SID)!;
      expect(Object.hasOwn(s.agents, id)).toBe(true);
      expect(getOwn(s.agents, id)!.activeToolIds).toHaveLength(1);
      expect(getOwn(s.agents, id)!.pendingApprovalIds).toHaveLength(1);
      expect((Object.prototype as Record<string, unknown>).lifecycle).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>).activeToolIds).toBeUndefined();
      expect(JSON.parse(JSON.stringify(s)).agents[id].id).toBe(id);
    }
  });

  it('prototype-like session ids are isolated too', () => {
    const st = createInitialState();
    applyEvent(st, ev('claude', { session_id: '__proto__', hook_event_name: 'SessionStart' }));
    applyEvent(st, ev('codex', { session_id: 'constructor', hook_event_name: 'SessionStart' }));
    expect(Object.hasOwn(st.sessions, 'claude:__proto__')).toBe(true);
    expect(Object.hasOwn(st.sessions, 'codex:constructor')).toBe(true);
    expect((Object.prototype as Record<string, unknown>).agents).toBeUndefined();
  });

  it('normalizer strips control characters from ids but keeps prototype-like names', () => {
    const nul = String.fromCharCode(0);
    const e = normalizeClaude(
      { session_id: `s${nul}x`, hook_event_name: 'SubagentStart', agent_id: '__proto__' },
      { eventId: 'x', receivedAt: new Date().toISOString(), homeDir: null, source: 'hook' },
    );
    expect(e?.sessionId).toBe('sx');
    expect(e?.agentId).toBe('__proto__');
  });
});
