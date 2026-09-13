import { beforeEach, describe, expect, it } from 'vitest';

import { getOwn, ownValues } from '../src/shared/dict.js';
import { sessionKey } from '../src/shared/events.js';
import { agentDisplayStatus, applyEvent, applyEvents, createInitialState, toolKey, type TownState } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

beforeEach(() => resetCounter());

const sess = (st: TownState, provider: 'claude' | 'codex', id: string) => getOwn(st.sessions, sessionKey(provider, id))!;
const call = (st: TownState, provider: 'claude' | 'codex', sid: string, agent: string, tool: string) =>
  getOwn(sess(st, provider, sid).toolCalls, toolKey(agent, tool));

describe('reducer: sessions and identity', () => {
  it('keeps Claude and Codex sessions with the same session_id separate', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 'same', hook_event_name: 'SessionStart', cwd: 'C:/p/a' }),
      ev('codex', { session_id: 'same', hook_event_name: 'SessionStart', cwd: 'C:/p/b' }),
      ev('claude', { session_id: 'same', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'x', tool_input: { file_path: 'a.ts' } }),
      ev('codex', { session_id: 'same', hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'x', tool_input: { command: 'ls' } }),
    ]);
    expect(Object.keys(st.sessions)).toHaveLength(2);
    const c = sess(st, 'claude', 'same');
    const x = sess(st, 'codex', 'same');
    expect(c.agents.main!.activeToolIds).toEqual([toolKey('main', 'x')]);
    expect(x.agents.main!.activeToolIds).toEqual([toolKey('main', 'x')]);
    expect(call(st, 'claude', 'same', 'main', 'x')!.toolName).toBe('Read');
    expect(call(st, 'codex', 'same', 'main', 'x')!.toolName).toBe('exec_command');
    expect(c.podIndex).toBe(0);
    expect(x.podIndex).toBe(1);
    applyEvent(st, ev('codex', { session_id: 'same', hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_use_id: 'x', tool_response: { exit_code: 0 } }));
    expect(call(st, 'claude', 'same', 'main', 'x')!.status).toBe('running');
    expect(call(st, 'codex', 'same', 'main', 'x')!.status).toBe('completed');
  });

  it('creates subagents only from lifecycle evidence, not from the Agent tool name', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: 'explore' } }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(Object.keys(s.agents)).toEqual(['main']);
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'child-a', agent_type: 'Explore' }));
    expect(Object.keys(s.agents)).toEqual(['main', 'child-a']);
    expect(getOwn(s.agents, 'child-a')!.parentAgentId).toBe('main');
    expect(getOwn(s.agents, 'child-a')!.parentEvidence).toBe('provider-semantics');
    expect(getOwn(s.agents, 'child-a')!.role).toBe('subagent');
  });

  it('Codex children have session membership but an unknown immediate parent', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('codex', { session_id: 'p', hook_event_name: 'SessionStart' }),
      ev('codex', { session_id: 'p', hook_event_name: 'SubagentStart', agent_id: 'sub-1' }),
      ev('codex', { session_id: 'p', hook_event_name: 'PreToolUse', agent_id: 'sub-1', tool_name: 'exec_command', tool_use_id: 'c1', tool_input: { command: 'pytest' } }),
    ]);
    const s = sess(st, 'codex', 'p');
    const child = getOwn(s.agents, 'sub-1')!;
    expect(child.parentAgentId).toBeNull();
    expect(child.parentEvidence).toBe('unknown');
    expect(child.activeToolIds).toEqual([toolKey('sub-1', 'c1')]);
    expect(s.agents.main!.activeToolIds).toEqual([]);
  });
});

describe('reducer: concurrent tools', () => {
  it('finishing one of three parallel tools leaves the other two running', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'a' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 't2', tool_input: { pattern: 'b' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'c' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 't2', tool_response: {} }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(s.agents.main!.activeToolIds).toEqual([toolKey('main', 't1'), toolKey('main', 't3')]);
    expect(call(st, 'claude', 's', 'main', 't2')!.status).toBe('completed');
    expect(call(st, 'claude', 's', 'main', 't1')!.status).toBe('running');
    expect(call(st, 'claude', 's', 'main', 't3')!.status).toBe('running');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('working');
  });

  it('ignores duplicate completion and never resurrects a completed call on a late start', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1', tool_response: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1', tool_response: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: {} }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(call(st, 'claude', 's', 'main', 't1')!.status).toBe('completed');
    expect(s.agents.main!.activeToolIds).toEqual([]);
    expect(s.duplicatesIgnored).toBe(2);
    expect(ownValues(s.toolCalls)).toHaveLength(1);
  });

  it('handles completion arriving before start (out of order) as terminal', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('codex', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_use_id: 'c1', tool_response: { exit_code: 0 } }),
      ev('codex', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'c1', tool_input: { command: 'ls' } }),
    ]);
    const s = sess(st, 'codex', 's');
    const tc = call(st, 'codex', 's', 'main', 'c1')!;
    expect(tc.status).toBe('completed');
    expect(tc.outOfOrder).toBe(true);
    expect(tc.target).toBe('ls');
    expect(s.agents.main!.activeToolIds).toEqual([]);
  });

  it('a failure stays a failure even if a later completed event arrives', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'x' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1', error: 'exit 1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_response: {} }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(call(st, 'claude', 's', 'main', 't1')!.status).toBe('failed');
    expect(call(st, 'claude', 's', 'main', 't1')!.error).toBe('exit 1');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('failed');
  });

  it('records tools without ids as separate unknown-id calls, never linked by time', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'a' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: {} }),
    ]);
    const s = sess(st, 'claude', 's');
    const calls = ownValues(s.toolCalls);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => !c.idKnown && c.sourceId === null)).toBe(true);
    expect(calls.filter((c) => c.status === 'running')).toHaveLength(1);
  });

  it('Codex PostToolUse without any outcome signal ends the call with an unknown outcome', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('codex', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_use_id: 'c1', tool_input: {} }),
      ev('codex', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'mcp__x__y', tool_use_id: 'c1' }),
    ]);
    expect(call(st, 'codex', 's', 'main', 'c1')!.status).toBe('ended');
  });
});

describe('reducer: lifecycle', () => {
  it('Stop completes the response and marks still-running tools unresolved (not completed)', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'Stop' }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(s.lifecycle).toBe('active');
    expect(s.agents.main!.lifecycle).toBe('idle');
    const tc = call(st, 'claude', 's', 'main', 't1')!;
    expect(tc.status).toBe('unresolved');
    expect(tc.endedByTurn).toBe(true);
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('done');
    expect(s.currentTurn?.turnId).toBe('p1');
    expect(s.currentTurn?.status).toBe('completed');
  });

  it('SubagentStop idles the child only; the parent keeps working and its turn stays open', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'c1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'm1', tool_input: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'c1' }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(getOwn(s.agents, 'c1')!.lifecycle).toBe('idle');
    expect(s.agents.main!.lifecycle).toBe('active');
    expect(s.agents.main!.activeToolIds).toEqual([toolKey('main', 'm1')]);
    expect(s.currentTurn?.status).toBe('running');
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'c1' }));
    expect(Object.keys(s.agents).sort()).toEqual(['c1', 'main']);
    expect(getOwn(s.agents, 'c1')!.lifecycle).toBe('active');
  });

  it('a bare SessionStart is idle, not working; a running turn is working; inactivity is never success', () => {
    const st = createInitialState();
    applyEvent(st, ev('codex', { session_id: 's', hook_event_name: 'SessionStart' }));
    const s = sess(st, 'codex', 's');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('idle');
    applyEvent(st, ev('codex', { session_id: 's', hook_event_name: 'UserPromptSubmit', turn_id: 't1' }));
    expect(s.currentTurn?.status).toBe('running');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('working');
  });

  it('Interrupt marks the turn interrupted and the agent failed, not done', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('codex', { session_id: 's', hook_event_name: 'UserPromptSubmit', turn_id: 't1' }),
      ev('codex', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'c1', tool_input: {} }),
      ev('codex', { session_id: 's', hook_event_name: 'Interrupt', turn_id: 't1' }),
    ]);
    const s = sess(st, 'codex', 's');
    expect(s.currentTurn?.status).toBe('interrupted');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('failed');
    expect(call(st, 'codex', 's', 'main', 'c1')!.status).toBe('unresolved');
  });

  it('SessionEnd ends every agent and marks the session ended', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'c1' }),
      ev('claude', { session_id: 's', hook_event_name: 'SessionEnd', reason: 'logout' }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(s.lifecycle).toBe('ended');
    expect(getOwn(s.agents, 'c1')!.lifecycle).toBe('ended');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('ended');
  });
});

describe('reducer: approvals', () => {
  it('keeps an approval pending until the same tool id completes', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('codex', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'c1', tool_input: { command: 'git push' } }),
      ev('codex', { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'exec_command', tool_use_id: 'c1', tool_input: { command: 'git push' } }),
    ]);
    const s = sess(st, 'codex', 's');
    const ap = getOwn(s.approvals, toolKey('main', 'c1'))!;
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('awaiting_approval');
    expect(ap.status).toBe('pending');
    expect(ap.sourceId).toBe('c1');
    applyEvent(st, ev('codex', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_use_id: 'c1', tool_response: { exit_code: 0 } }));
    expect(ap.status).toBe('resolved');
    expect(ap.decision).toBe('allowed');
    expect(ap.resolutionEvidence).toBe('observed');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('idle');
  });

  it('PermissionDenied resolves the approval as denied and fails the tool', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm -rf x' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(getOwn(s.approvals, toolKey('main', 't1'))!.decision).toBe('denied');
    expect(call(st, 'claude', 's', 'main', 't1')!.status).toBe('denied');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('failed');
  });

  it('approvals are scoped per agent like tool calls', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'b' }),
      ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', agent_id: 'a', tool_name: 'Bash', tool_use_id: 'same' }),
      ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', agent_id: 'b', tool_name: 'Bash', tool_use_id: 'same' }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', agent_id: 'a', tool_name: 'Bash', tool_use_id: 'same' }),
    ]);
    const s = sess(st, 'claude', 's');
    expect(getOwn(s.agents, 'a')!.pendingApprovalIds).toHaveLength(0);
    expect(getOwn(s.agents, 'b')!.pendingApprovalIds).toHaveLength(1);
  });

  it('an approval without tool id is only resolved by turn end, and labelled inferred', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' }),
    ]);
    const s = sess(st, 'claude', 's');
    const ap = ownValues(s.approvals)[0]!;
    expect(ap.idKnown).toBe(false);
    expect(ap.status).toBe('pending');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('awaiting_approval');
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'Stop' }));
    expect(ap.status).toBe('resolved');
    expect(ap.decision).toBe('unknown');
    expect(ap.resolutionEvidence).toBe('inferred');
  });
});

describe('reducer: determinism', () => {
  it('replaying the same events yields an identical state', () => {
    const events = [
      ev('claude', { session_id: 's', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'c1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'c1', tool_name: 'Read', tool_use_id: 't1', tool_input: {} }),
      ev('codex', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 't1', tool_input: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', agent_id: 'c1', tool_name: 'Read', tool_use_id: 't1', tool_response: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'c1' }),
    ];
    const a = applyEvents(createInitialState(), events);
    const b = applyEvents(createInitialState(), events);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
