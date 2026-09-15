/**
 * Pass 5: office visibility of ended/finished agents, per-agent model, and the
 * (inferred) link between a child agent and the delegation call that made it.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildOfficeVM, doneBubble, isAgentHidden } from '../src/client/viewModel.js';
import { getOwn } from '../src/shared/dict.js';
import { normalizeClaude } from '../src/shared/providers/claude.js';
import {
  agentWorkSummary,
  applyEvent,
  applyEvents,
  createInitialState,
  effectiveModel,
  type SessionState,
  STATE_SCHEMA_VERSION,
  toolKey,
  type TownState,
  upgradeState,
  workSummaryLabel,
} from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

const filters = { providers: { claude: true, codex: true }, kinds: { tool: true, agent: true, approval: true, error: true, session: true } };
const noSel = { sessionKey: null, agentId: null };
const ctx = { eventId: 'e', receivedAt: new Date().toISOString(), homeDir: 'C:\\Users\\tester', source: 'hook' as const };

function sess(st: TownState, key: string): SessionState {
  return getOwn(st.sessions, key)!;
}

beforeEach(() => resetCounter());

describe('office visibility', () => {
  it('an ended session has no characters and frees its room; it is still in the state', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 'a', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 'a', hook_event_name: 'SubagentStart', agent_id: 'kid' }),
      ev('claude', { session_id: 'b', hook_event_name: 'SessionStart' }),
    ]);
    let vm = buildOfficeVM(st, noSel, filters, false, 1);
    expect(vm.rooms[0]!.sessionKey).toBe('claude:a');
    expect(vm.unseatedSessionKeys).toEqual(['claude:b']);
    applyEvent(st, ev('claude', { session_id: 'a', hook_event_name: 'SessionEnd' }));
    vm = buildOfficeVM(st, noSel, filters, false, 1, Date.now(), vm.roomMap);
    expect(vm.characters.filter((c) => c.sessionKey === 'claude:a')).toHaveLength(0);
    expect(vm.rooms[0]!.sessionKey).toBe('claude:b');
    expect(vm.unseatedSessionKeys).toEqual([]);
    expect(sess(st, 'claude:a').lifecycle).toBe('ended');
    expect(Object.keys(sess(st, 'claude:a').agents).sort()).toEqual(['kid', 'main']);
  });

  it('a finished employee stays (showing its task) until the user starts the next turn, then leaves; the lead stays', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: '쿠키 처리 코드 탐색', subagent_type: 'Explore' } }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'Explore' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'cookie' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'src/a.ts' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', agent_id: 'kid', tool_name: 'Read', tool_use_id: 'r1', tool_response: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Read', tool_use_id: 'r2', tool_input: { file_path: 'src/b.ts' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', agent_id: 'kid', tool_name: 'Read', tool_use_id: 'r2', tool_response: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', agent_id: 'kid', tool_name: 'Grep', tool_use_id: 'g1', tool_response: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'kid', agent_type: 'Explore' }),
    ]);
    const s = sess(st, 'claude:s');
    const kid = getOwn(s.agents, 'kid')!;
    const stoppedAt = Date.parse(kid.lastActivityAt);
    // After the stop: still in the office, bubble says what it did - however long it takes.
    let vm = buildOfficeVM(st, noSel, filters, false, 6, stoppedAt + 1000);
    const c = vm.characters.find((x) => x.agentId === 'kid');
    expect(c).toBeDefined();
    expect(c!.status).toBe('done');
    expect(c!.bubble).toEqual({ title: '완료 · 쿠키 처리 코드 탐색', detail: '읽기 2 · 검색 1', extra: 0 });
    expect(isAgentHidden(s, kid, stoppedAt + 60 * 60 * 1000)).toBe(false);
    // The lead finishing its response does not clear the employee either.
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'Stop', prompt_id: 'p1' }));
    vm = buildOfficeVM(st, noSel, filters, false, 6, stoppedAt + 5000);
    expect(vm.characters.map((x) => x.agentId).sort()).toEqual(['kid', 'main']);
    // The user starts the next turn: the previous task's employee leaves; state untouched.
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p2' }));
    vm = buildOfficeVM(st, noSel, filters, false, 6, stoppedAt + 6000);
    expect(vm.characters.map((x) => x.agentId)).toEqual(['main']);
    expect(getOwn(s.agents, 'kid')!.lifecycle).toBe('idle');
    // A restarted child comes back immediately.
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'Explore' }));
    vm = buildOfficeVM(st, noSel, filters, false, 6, stoppedAt + 7000);
    expect(vm.characters.map((x) => x.agentId).sort()).toEqual(['kid', 'main']);
  });

  it('a finished employee with a pending approval or waiting for input never leaves, even after a new turn', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm -rf build' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', agent_id: 'kid', tool_name: 'Bash', tool_use_id: 'b1' }),
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p2' }),
    ]);
    const s = sess(st, 'claude:s');
    const kid = getOwn(s.agents, 'kid')!;
    expect(isAgentHidden(s, kid, Date.now())).toBe(false);
  });

  it('the lead of a finished session shows "응답 완료" without a fabricated task', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'Stop', prompt_id: 'p1' }),
    ]);
    const s = sess(st, 'claude:s');
    expect(doneBubble(s, s.agents.main!)).toEqual({ title: '응답 완료', detail: null, extra: 0 });
  });
});

describe('model per session and agent', () => {
  it('session model comes from SessionStart and follows a model switch; agents inherit it', () => {
    const st = createInitialState();
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'SessionStart', model: 'claude-opus-5' }));
    const s = sess(st, 'claude:s');
    expect(s.model).toBe('claude-opus-5');
    expect(effectiveModel(s, s.agents.main!)).toEqual({ model: 'claude-opus-5', source: 'session' });
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5', to_model: 'claude-fable-5-1' }));
    expect(s.model).toBe('claude-fable-5-1');
  });

  it('a delegation call that names a model gives the child that model; a tool payload never rewrites the session model', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'SessionStart', model: 'claude-fable-5-1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: '빠른 검색', subagent_type: 'Explore', model: 'haiku' } }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'Explore' }),
    ]);
    const s = sess(st, 'claude:s');
    expect(s.model).toBe('claude-fable-5-1');
    const kid = getOwn(s.agents, 'kid')!;
    expect(kid.model).toBe('haiku');
    expect(effectiveModel(s, kid)).toEqual({ model: 'haiku', source: 'agent' });
    const call = getOwn(s.toolCalls, toolKey('main', 'a1'))!;
    expect(call.subagentModel).toBe('haiku');
    expect(call.subagentType).toBe('Explore');
    expect(call.taskDescription).toBe('빠른 검색');
  });

  it('with no model anywhere nothing is invented', () => {
    const st = createInitialState();
    applyEvent(st, ev('codex', { session_id: 's', hook_event_name: 'SessionStart' }));
    const s = sess(st, 'codex:s');
    expect(effectiveModel(s, s.agents.main!)).toEqual({ model: null, source: 'none' });
  });

  it('PostModelSwitch normalizes to a notification carrying the new model, never a turn or tool event', () => {
    const e = normalizeClaude({ session_id: 's', hook_event_name: 'PostModelSwitch', from_model: 'a', to_model: 'b' }, ctx);
    expect(e?.kind).toBe('notification');
    expect(e?.payload.model).toBe('b');
    expect(e?.payload.notificationType).toBe('PostModelSwitch');
  });
});

describe('child ↔ delegation call link (inferred)', () => {
  it('links a child to the oldest running delegation call of the same type and records the inference', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: '첫 번째 탐색', subagent_type: 'Explore' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a2', tool_input: { description: '수정 작업', subagent_type: 'general-purpose' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a3', tool_input: { description: '두 번째 탐색', subagent_type: 'Explore' } }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'fix', agent_type: 'general-purpose' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'ex1', agent_type: 'Explore' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'ex2', agent_type: 'Explore' }),
    ]);
    const s = sess(st, 'claude:s');
    expect(getOwn(s.agents, 'fix')!.task).toBe('수정 작업');
    expect(getOwn(s.agents, 'ex1')!.task).toBe('첫 번째 탐색');
    expect(getOwn(s.agents, 'ex2')!.task).toBe('두 번째 탐색');
    for (const id of ['fix', 'ex1', 'ex2']) expect(getOwn(s.agents, id)!.taskEvidence).toBe('inferred');
    expect(getOwn(s.toolCalls, toolKey('main', 'a1'))!.spawnedAgentId).toBe('ex1');
    expect(getOwn(s.toolCalls, toolKey('main', 'a2'))!.spawnedAgentId).toBe('fix');
    expect(getOwn(s.toolCalls, toolKey('main', 'a3'))!.spawnedAgentId).toBe('ex2');
    // Still no character for the Agent tool itself.
    expect(Object.keys(s.agents).sort()).toEqual(['ex1', 'ex2', 'fix', 'main']);
  });

  it('a child with no matching delegation call has no task (nothing invented); a finished call is never reused', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: '끝난 위임', subagent_type: 'Explore' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_response: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a2', tool_input: { description: '다른 유형', subagent_type: 'Plan' } }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'Explore' }),
    ]);
    const s = sess(st, 'claude:s');
    const kid = getOwn(s.agents, 'kid')!;
    expect(kid.task).toBeNull();
    expect(kid.taskEvidence).toBeNull();
    expect(kid.model).toBeNull();
    expect(getOwn(s.toolCalls, toolKey('main', 'a2'))!.spawnedAgentId).toBeNull();
    expect(doneBubble(s, kid).title).toBe('완료 · Explore');
  });

  it('Codex children (unknown parent) link to a running spawn call anywhere in the session; an untyped call accepts any child', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('codex', { session_id: 'p', hook_event_name: 'SessionStart' }),
      ev('codex', { session_id: 'p', hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', tool_use_id: 'c1', tool_input: { description: '테스트 실행' } }),
      ev('codex', { session_id: 'p', hook_event_name: 'SubagentStart', agent_id: 'w1', agent_type: 'worker' }),
    ]);
    const s = sess(st, 'codex:p');
    expect(getOwn(s.agents, 'w1')!.task).toBe('테스트 실행');
    expect(getOwn(s.agents, 'w1')!.parentAgentId).toBeNull();
  });

  it('work summary counts observed calls per activity, failures included', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'a.ts' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUseFailure', agent_id: 'kid', tool_name: 'Edit', tool_use_id: 'e1', error: 'not found' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }),
    ]);
    const s = sess(st, 'claude:s');
    const w = agentWorkSummary(s, getOwn(s.agents, 'kid')!);
    expect(w.total).toBe(2);
    expect(w.failed).toBe(1);
    expect(w.lastCall?.toolName).toBe('Bash');
    expect(workSummaryLabel(w)).toBe('수정 1 · 명령 실행 1 · 실패 1');
    expect(workSummaryLabel(agentWorkSummary(s, s.agents.main!))).toBeNull();
  });
});

describe('schema 3 → 4 upgrade', () => {
  it('adds the new agent/tool-call fields as null, preserves everything else, and is idempotent', () => {
    const live = createInitialState();
    applyEvents(live, [
      ev('claude', { session_id: 'old', hook_event_name: 'SessionStart', model: 'm' }),
      ev('claude', { session_id: 'old', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: 'd', subagent_type: 'Explore' } }),
      ev('claude', { session_id: 'old', hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'Explore' }),
    ]);
    const raw = JSON.parse(JSON.stringify(live)) as Record<string, unknown>;
    raw.schemaVersion = 3;
    for (const s of Object.values(raw.sessions as Record<string, Record<string, unknown>>)) {
      for (const a of Object.values(s.agents as Record<string, Record<string, unknown>>)) {
        delete a.model;
        delete a.task;
        delete a.taskEvidence;
        delete a.taskToolId;
      }
      for (const t of Object.values(s.toolCalls as Record<string, Record<string, unknown>>)) {
        delete t.subagentType;
        delete t.subagentModel;
        delete t.taskDescription;
        delete t.spawnedAgentId;
      }
    }
    const state = raw as unknown as TownState;
    upgradeState(state);
    expect(state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    const s = sess(state, 'claude:old');
    const kid = getOwn(s.agents, 'kid')!;
    expect(kid.task).toBeNull(); // the old link is not re-derived from a stored checkpoint
    expect(kid.model).toBeNull();
    expect(kid.taskEvidence).toBeNull();
    expect(kid.parentAgentId).toBe('main');
    expect(s.model).toBe('m');
    const call = getOwn(s.toolCalls, toolKey('main', 'a1'))!;
    expect(call.status).toBe('running');
    expect(call.spawnedAgentId).toBeNull();
    expect(call.target).toBe('d');
    const once = JSON.stringify(state);
    upgradeState(state);
    expect(JSON.stringify(state)).toBe(once);
    // The reducer keeps working on the upgraded state: a new child links to a new call.
    applyEvents(state, [
      ev('claude', { session_id: 'old', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a2', tool_input: { description: 'later', subagent_type: 'Plan' } }),
      ev('claude', { session_id: 'old', hook_event_name: 'SubagentStart', agent_id: 'kid2', agent_type: 'Plan' }),
    ]);
    expect(getOwn(s.agents, 'kid2')!.task).toBe('later');
  });
});
