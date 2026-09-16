/**
 * Pass 7, from real hook recordings of 2026-09-15/16:
 * - Esc fires no Stop; the next UserPromptSubmit (new prompt_id) or an
 *   idle_prompt notification is the first evidence the turn ended.
 * - SubagentStop arrives for agents that never had a SubagentStart.
 * - Tool names get a Korean explanation; helpers are labelled by type;
 *   parallel calls of one agent are shown as parallelism, not as people.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildOfficeVM, isAgentHidden, roleLabel } from '../src/client/viewModel.js';
import { classifyTool, toolDescription, toolLabel } from '../src/shared/activity.js';
import { getOwn } from '../src/shared/dict.js';
import {
  agentDisplayStatus,
  applyEvent,
  applyEvents,
  createInitialState,
  STATE_SCHEMA_VERSION,
  toolKey,
  type TownState,
  upgradeState,
} from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

const filters = { providers: { claude: true, codex: true }, kinds: { tool: true, agent: true, approval: true, error: true, session: true } };
const noSel = { sessionKey: null, agentId: null };
const sess = (st: TownState) => getOwn(st.sessions, 'claude:s')!;

beforeEach(() => resetCounter());

describe('Esc: a turn that never ends', () => {
  it('a new prompt while the previous turn is running closes it as interrupted (inferred) and unresolves its tools', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.md' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', prompt_id: 'p1', tool_name: 'Read', tool_use_id: 'r1', tool_response: {} }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' } }),
      // Esc here: no PostToolUse for g1, no Stop.
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p2' }),
    ]);
    const s = sess(st);
    expect(s.currentTurn?.turnId).toBe('p2');
    expect(s.currentTurn?.status).toBe('running');
    expect(s.recentTurnIds).toEqual(['p1', 'p2']);
    expect(s.turnsCompleted).toBe(0);
    const g1 = getOwn(s.toolCalls, toolKey('main', 'g1'))!;
    expect(g1.status).toBe('unresolved');
    expect(g1.endedByTurn).toBe(true);
    expect(s.agents.main!.activeToolIds).toEqual([]);
    expect(s.agents.main!.lifecycle).toBe('active');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('working');
    // A late outcome for the interrupted tool still refines that record only.
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', prompt_id: 'p1', tool_name: 'Grep', tool_use_id: 'g1', tool_response: {} }));
    expect(g1.status).toBe('completed');
    expect(g1.lateOutcome).toBe(true);
    expect(s.currentTurn?.turnId).toBe('p2');
  });

  it('a mid-turn message (same prompt_id) is a duplicate start, not an interruption', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }),
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
    ]);
    const s = sess(st);
    expect(s.currentTurn?.status).toBe('running');
    expect(s.currentTurn?.endEvidence).toBeNull();
    expect(getOwn(s.toolCalls, toolKey('main', 'b1'))!.status).toBe('running');
    expect(s.duplicatesIgnored).toBe(1);
  });

  it('helpers active at the interruption go idle as interrupted and leave the office; tool activity brings one back', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'Explore' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', prompt_id: 'p1', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' } }),
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p2' }),
    ]);
    const s = sess(st);
    const kid = getOwn(s.agents, 'kid')!;
    expect(kid.lifecycle).toBe('idle');
    expect(kid.lastResponse).toBe('interrupted');
    expect(getOwn(s.toolCalls, toolKey('kid', 'g1'))!.status).toBe('unresolved');
    expect(isAgentHidden(s, kid, Date.now())).toBe(true);
    // It was in fact still running: its next tool makes it active and visible again.
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', prompt_id: 'p2', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.md' } }));
    expect(kid.lifecycle).toBe('active');
    expect(isAgentHidden(s, kid, Date.now())).toBe(false);
  });

  it('idle_prompt with no pending approval ends the running turn (inferred) and shows waiting for input', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' } }),
      ev('claude', { session_id: 's', hook_event_name: 'Notification', prompt_id: 'p1', notification_type: 'idle_prompt' }),
    ]);
    const s = sess(st);
    expect(s.currentTurn?.status).toBe('interrupted');
    expect(s.currentTurn?.endEvidence).toBe('inferred');
    expect(getOwn(s.toolCalls, toolKey('main', 'g1'))!.status).toBe('unresolved');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('waiting_input');
    // The next prompt starts cleanly.
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p2' }));
    expect(s.currentTurn?.turnId).toBe('p2');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('working');
  });

  it('idle_prompt while a permission answer is pending does not end the turn', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'git push' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', prompt_id: 'p1', tool_name: 'Bash', tool_use_id: 'b1' }),
      ev('claude', { session_id: 's', hook_event_name: 'Notification', prompt_id: 'p1', notification_type: 'idle_prompt' }),
    ]);
    const s = sess(st);
    expect(s.currentTurn?.status).toBe('running');
    expect(getOwn(s.toolCalls, toolKey('main', 'b1'))!.status).toBe('running');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('awaiting_approval');
  });

  it('a normal Stop still ends the turn as observed', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'Stop', prompt_id: 'p1' }),
    ]);
    expect(sess(st).currentTurn?.endEvidence).toBe('observed');
  });
});

describe('SubagentStop without SubagentStart', () => {
  it('records the agent but does not draw it; a later tool call of that id makes it a real helper', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'ghost' }),
    ]);
    const s = sess(st);
    const ghost = getOwn(s.agents, 'ghost')!;
    expect(ghost.startObserved).toBe(false);
    expect(roleLabel(ghost)).toBe('보조 에이전트 · 시작 미관측');
    let vm = buildOfficeVM(st, noSel, filters, false, 6);
    expect(vm.characters.map((c) => c.agentId)).toEqual(['main']);
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'ghost', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.md' } }));
    expect(ghost.startObserved).toBe(true);
    vm = buildOfficeVM(st, noSel, filters, false, 6);
    expect(vm.characters.map((c) => c.agentId).sort()).toEqual(['ghost', 'main']);
  });
});

describe('labels', () => {
  it('tool names carry a Korean explanation; MCP tools name their server; unknown names stay bare', () => {
    expect(toolLabel('Read')).toBe('Read(읽기)');
    expect(toolLabel('Grep')).toBe('Grep(내용 검색)');
    expect(toolLabel('Bash')).toBe('Bash(명령 실행)');
    expect(toolLabel('Skill')).toBe('Skill(스킬 실행)');
    expect(toolLabel('apply_patch')).toBe('apply_patch(패치 적용)');
    expect(toolLabel('SubagentHandback')).toBe('SubagentHandback(결과 넘김)');
    expect(toolLabel('mcp__claude_ai_Notion__search')).toBe('search(MCP claude_ai_Notion)');
    expect(toolLabel('SomethingNew')).toBe('SomethingNew');
    expect(toolDescription('SomethingNew')).toBeNull();
    expect(toolLabel(null)).toBe('도구');
    expect(classifyTool('SubagentHandback')).toBe('agent');
  });

  it('helpers are named by type, never as "직원"; the lead is 팀장', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'e', agent_type: 'Explore' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'p', agent_type: 'Plan' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'g', agent_type: 'general-purpose' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'c', agent_type: 'my-reviewer' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'n' }),
    ]);
    const s = sess(st);
    expect(roleLabel(s.agents.main!)).toBe('팀장');
    expect(roleLabel(getOwn(s.agents, 'e')!)).toBe('탐색 담당 · Explore');
    expect(roleLabel(getOwn(s.agents, 'p')!)).toBe('설계 담당 · Plan');
    expect(roleLabel(getOwn(s.agents, 'g')!)).toBe('실무 담당 · general-purpose');
    expect(roleLabel(getOwn(s.agents, 'c')!)).toBe('my-reviewer 담당');
    expect(roleLabel(getOwn(s.agents, 'n')!)).toBe('보조 에이전트');
    const vm = buildOfficeVM(st, noSel, filters, false, 6);
    expect(vm.characters.every((c) => !c.label.includes('직원'))).toBe(true);
    // Explore and Plan get different tag colours and sprites from the lead.
    const e = vm.characters.find((c) => c.agentId === 'e')!;
    const p = vm.characters.find((c) => c.agentId === 'p')!;
    const main = vm.characters.find((c) => c.agentId === 'main')!;
    expect(e.tagColor).not.toBe(p.tagColor);
    expect(e.tagColor).not.toBe(main.tagColor);
    expect(e.characterIndex).not.toBe(main.characterIndex);
  });

  it('parallel tool calls of one agent are shown as parallelism on that character, not as extra characters', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'a' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'g2', tool_input: { pattern: 'b' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c.md' } }),
    ]);
    const vm = buildOfficeVM(st, noSel, filters, false, 6);
    expect(vm.characters).toHaveLength(1);
    const main = vm.characters[0]!;
    expect(main.parallel).toBe(3);
    expect(main.label).toBe('Claude 팀장 ⇉3');
    expect(main.bubble?.title).toBe('Read(읽기) · 병렬 3');
    expect(main.bubble?.extra).toBe(0);
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_response: {} }));
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'g2', tool_response: {} }));
    const vm2 = buildOfficeVM(st, noSel, filters, false, 6);
    expect(vm2.characters[0]!.bubble?.title).toBe('Grep(내용 검색)');
    expect(vm2.characters[0]!.label).toBe('Claude 팀장');
  });
});

describe('schema 4 → 5 upgrade', () => {
  it('defaults startObserved to true and endEvidence by turn status, idempotently', () => {
    const live = createInitialState();
    applyEvents(live, [
      ev('claude', { session_id: 'old', hook_event_name: 'UserPromptSubmit', prompt_id: 'p' }),
      ev('claude', { session_id: 'old', hook_event_name: 'SubagentStop', agent_id: 'k' }),
    ]);
    const raw = JSON.parse(JSON.stringify(live)) as Record<string, unknown>;
    raw.schemaVersion = 4;
    for (const s of Object.values(raw.sessions as Record<string, Record<string, unknown>>)) {
      for (const a of Object.values(s.agents as Record<string, Record<string, unknown>>)) delete a.startObserved;
      delete (s.currentTurn as Record<string, unknown>).endEvidence;
    }
    const state = raw as unknown as TownState;
    upgradeState(state);
    expect(state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    const s = getOwn(state.sessions, 'claude:old')!;
    expect(getOwn(s.agents, 'k')!.startObserved).toBe(true); // unknown for stored agents: stay visible
    expect(s.currentTurn?.endEvidence).toBeNull(); // still running
    const once = JSON.stringify(state);
    upgradeState(state);
    expect(JSON.stringify(state)).toBe(once);
  });
});
