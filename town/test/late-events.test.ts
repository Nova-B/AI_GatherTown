/**
 * Lasting copies of supervision/supervisor-late-events.mts plus the
 * neighbouring cases: turn-scoped terminal events and approval refinement.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getOwn, ownValues } from '../src/shared/dict.js';
import { agentDisplayStatus, applyEvent, createInitialState, toolKey, type TownState } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

const SID = 'late-event-review';
const x = (st: TownState, hook: string, fields: Record<string, unknown> = {}) => {
  applyEvent(st, ev('codex', { session_id: SID, hook_event_name: hook, ...fields }));
  return getOwn(st.sessions, 'codex:' + SID)!;
};
const c = (st: TownState, hook: string, fields: Record<string, unknown> = {}) => {
  applyEvent(st, ev('claude', { session_id: SID, hook_event_name: hook, ...fields }));
  return getOwn(st.sessions, 'claude:' + SID)!;
};

beforeEach(() => resetCounter());

describe('turn-scoped terminal events', () => {
  it('a late Stop for an older known turn does not complete the newer running turn', () => {
    const st = createInitialState();
    x(st, 'UserPromptSubmit', { turn_id: 'turn-one' });
    x(st, 'Stop', { turn_id: 'turn-one' });
    x(st, 'UserPromptSubmit', { turn_id: 'turn-two' });
    const s = x(st, 'Stop', { turn_id: 'turn-one' });
    expect(s.currentTurn?.turnId).toBe('turn-two');
    expect(s.currentTurn?.status).toBe('running');
    expect(s.turnsCompleted).toBe(1);
    expect(s.staleTurnEvents).toBe(1);
    expect(s.agents.main!.lifecycle).toBe('active');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('working');
  });

  it('a stale Stop leaves the newer turn\'s tools, approvals and waiting state untouched', () => {
    const st = createInitialState();
    c(st, 'UserPromptSubmit', { prompt_id: 'p1' });
    c(st, 'Stop', { prompt_id: 'p1' });
    c(st, 'UserPromptSubmit', { prompt_id: 'p2' });
    c(st, 'PreToolUse', { prompt_id: 'p2', tool_name: 'Bash', tool_use_id: 't2' });
    c(st, 'PermissionRequest', { prompt_id: 'p2', tool_name: 'Bash', tool_use_id: 't2' });
    c(st, 'Notification', { prompt_id: 'p2', notification_type: 'idle_prompt' });
    const s = c(st, 'Stop', { prompt_id: 'p1' });
    expect(getOwn(s.toolCalls, toolKey('main', 't2'))!.status).toBe('running');
    expect(getOwn(s.approvals, toolKey('main', 't2'))!.status).toBe('pending');
    expect(s.agents.main!.waitingForInput).toBe(true);
    expect(s.agents.main!.lifecycle).toBe('active');
    expect(s.currentTurn?.status).toBe('running');
    // The genuine Stop for p2 then completes everything as usual.
    c(st, 'Stop', { prompt_id: 'p2' });
    expect(s.currentTurn?.status).toBe('completed');
    expect(s.turnsCompleted).toBe(2);
    expect(getOwn(s.toolCalls, toolKey('main', 't2'))!.status).toBe('unresolved');
    expect(s.agents.main!.waitingForInput).toBe(false);
  });

  it('a stale Interrupt (turn.failed) for an older turn does not fail the newer turn', () => {
    const st = createInitialState();
    x(st, 'UserPromptSubmit', { turn_id: 'a' });
    x(st, 'Stop', { turn_id: 'a' });
    x(st, 'UserPromptSubmit', { turn_id: 'b' });
    x(st, 'PreToolUse', { turn_id: 'b', tool_name: 'exec_command', tool_use_id: 'cb' });
    const s = x(st, 'Interrupt', { turn_id: 'a' });
    expect(s.currentTurn?.status).toBe('running');
    expect(s.agents.main!.lastResponse).toBeNull();
    expect(getOwn(s.toolCalls, toolKey('main', 'cb'))!.status).toBe('running');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('working');
    // The current turn's own Interrupt still applies.
    x(st, 'Interrupt', { turn_id: 'b' });
    expect(s.currentTurn?.status).toBe('interrupted');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('failed');
  });

  it('ordinary current-turn completion and re-delivered turn starts', () => {
    const st = createInitialState();
    x(st, 'UserPromptSubmit', { turn_id: 't1' });
    x(st, 'UserPromptSubmit', { turn_id: 't1' }); // duplicate start
    let s = x(st, 'Stop', { turn_id: 't1' });
    expect(s.currentTurn?.status).toBe('completed');
    expect(s.turnsCompleted).toBe(1);
    expect(s.duplicatesIgnored).toBe(1);
    s = x(st, 'UserPromptSubmit', { turn_id: 't1' }); // stale re-delivery never reopens
    expect(s.currentTurn?.status).toBe('completed');
    expect(s.staleTurnEvents).toBe(1);
    s = x(st, 'UserPromptSubmit', { turn_id: 't2' });
    expect(s.currentTurn?.turnId).toBe('t2');
    expect(s.recentTurnIds).toEqual(['t1', 't2']);
  });

  it('without source turn ids no chronology is guessed: Stop applies to the current turn', () => {
    const st = createInitialState();
    c(st, 'UserPromptSubmit');
    c(st, 'Stop');
    c(st, 'UserPromptSubmit');
    const s = c(st, 'Stop');
    expect(s.currentTurn?.status).toBe('completed');
    expect(s.turnsCompleted).toBe(2);
    expect(s.staleTurnEvents).toBe(0);
  });

  it('a Stop naming a turn that was never observed is counted, not applied', () => {
    const st = createInitialState();
    x(st, 'UserPromptSubmit', { turn_id: 'known' });
    const s = x(st, 'Stop', { turn_id: 'never-seen' });
    expect(s.currentTurn?.status).toBe('running');
    expect(s.unknownEvents).toBe(1);
  });

  it('a late outcome for an older turn\'s tool still refines that specific tool only', () => {
    const st = createInitialState();
    x(st, 'UserPromptSubmit', { turn_id: 'one' });
    x(st, 'PreToolUse', { turn_id: 'one', tool_name: 'exec_command', tool_use_id: 'old' });
    x(st, 'Stop', { turn_id: 'one' });
    x(st, 'UserPromptSubmit', { turn_id: 'two' });
    x(st, 'PreToolUse', { turn_id: 'two', tool_name: 'exec_command', tool_use_id: 'new' });
    const s = x(st, 'PostToolUse', { turn_id: 'one', tool_name: 'exec_command', tool_use_id: 'old', tool_response: { exit_code: 0 } });
    const old = getOwn(s.toolCalls, toolKey('main', 'old'))!;
    expect(old.status).toBe('completed');
    expect(old.lateOutcome).toBe(true);
    expect(getOwn(s.toolCalls, toolKey('main', 'new'))!.status).toBe('running');
    expect(s.currentTurn?.turnId).toBe('two');
    expect(s.currentTurn?.status).toBe('running');
  });
});

describe('approval refinement', () => {
  const tool = { turn_id: 'turn-a', tool_use_id: 'tool-a', tool_name: 'Bash', tool_input: { command: 'node --version' } };

  it('a late observed success refines an inferred unknown resolution to allowed', () => {
    const st = createInitialState();
    x(st, 'UserPromptSubmit', { turn_id: 'turn-a' });
    x(st, 'PreToolUse', tool);
    x(st, 'PermissionRequest', tool);
    let s = x(st, 'Stop', { turn_id: 'turn-a' });
    let ap = ownValues(s.approvals)[0]!;
    expect(ap.decision).toBe('unknown');
    expect(ap.resolutionEvidence).toBe('inferred');
    s = x(st, 'PostToolUse', { ...tool, tool_response: { exit_code: 0 } });
    ap = ownValues(s.approvals)[0]!;
    expect(ap.decision).toBe('allowed');
    expect(ap.resolutionEvidence).toBe('observed');
    expect(s.agents.main!.pendingApprovalIds).toEqual([]);
  });

  it('a late PermissionDenied refines an inferred unknown resolution to denied', () => {
    const st = createInitialState();
    c(st, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'd1' });
    c(st, 'PermissionRequest', { tool_name: 'Bash', tool_use_id: 'd1' });
    c(st, 'Stop');
    const s = c(st, 'PermissionDenied', { tool_name: 'Bash', tool_use_id: 'd1' });
    const ap = getOwn(s.approvals, toolKey('main', 'd1'))!;
    expect(ap.decision).toBe('denied');
    expect(ap.resolutionEvidence).toBe('observed');
    expect(getOwn(s.toolCalls, toolKey('main', 'd1'))!.status).toBe('denied');
  });

  it('an observed decision is never rewritten by a later contradiction', () => {
    const st = createInitialState();
    c(st, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'k1' });
    c(st, 'PermissionRequest', { tool_name: 'Bash', tool_use_id: 'k1' });
    c(st, 'PermissionDenied', { tool_name: 'Bash', tool_use_id: 'k1' });
    const s = c(st, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'k1', tool_response: { exit_code: 0 } });
    const ap = getOwn(s.approvals, toolKey('main', 'k1'))!;
    expect(ap.decision).toBe('denied');
    expect(getOwn(s.toolCalls, toolKey('main', 'k1'))!.status).toBe('denied');
  });

  it('refinement is agent-scoped: another agent\'s same-named call does not refine it', () => {
    const st = createInitialState();
    c(st, 'SubagentStart', { agent_id: 'kid' });
    c(st, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'same' });
    c(st, 'PermissionRequest', { tool_name: 'Bash', tool_use_id: 'same' });
    c(st, 'Stop');
    const s = c(st, 'PostToolUse', { agent_id: 'kid', tool_name: 'Bash', tool_use_id: 'same', tool_response: {} });
    const ap = getOwn(s.approvals, toolKey('main', 'same'))!;
    expect(ap.decision).toBe('unknown');
    expect(ap.resolutionEvidence).toBe('inferred');
  });

  it('keeps the decision unknown when the source supplies no outcome (Codex PostToolUse without signals)', () => {
    const st = createInitialState();
    x(st, 'UserPromptSubmit', { turn_id: 'u' });
    x(st, 'PreToolUse', { turn_id: 'u', tool_name: 'mcp__srv__op', tool_use_id: 'm1' });
    x(st, 'PermissionRequest', { turn_id: 'u', tool_name: 'mcp__srv__op', tool_use_id: 'm1' });
    x(st, 'Stop', { turn_id: 'u' });
    const s = x(st, 'PostToolUse', { turn_id: 'u', tool_name: 'mcp__srv__op', tool_use_id: 'm1', tool_response: { content: [] } });
    const ap = getOwn(s.approvals, toolKey('main', 'm1'))!;
    expect(getOwn(s.toolCalls, toolKey('main', 'm1'))!.status).toBe('ended');
    expect(ap.status).toBe('resolved');
    expect(ap.decision).toBe('unknown');
    expect(ap.resolutionEvidence).toBe('observed');
  });
});
