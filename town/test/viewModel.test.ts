import { beforeEach, describe, expect, it } from 'vitest';

import { assignRooms, buildOfficeVM, characterKey } from '../src/client/viewModel.js';
import { getOwn } from '../src/shared/dict.js';
import { applyEvent, createInitialState, type SessionState, type TownState } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

const filters = { providers: { claude: true, codex: true }, kinds: { tool: true, agent: true, approval: true, error: true, session: true } };
const noSel = { sessionKey: null, agentId: null };

function session(st: TownState, id: string, opts: { ended?: boolean; at?: number } = {}): SessionState {
  const start = ev('claude', { session_id: id, hook_event_name: 'SessionStart' });
  if (opts.at) start.receivedAt = new Date(opts.at).toISOString();
  applyEvent(st, start);
  if (opts.ended) {
    const end = ev('claude', { session_id: id, hook_event_name: 'SessionEnd' });
    if (opts.at) end.receivedAt = new Date(opts.at + 1000).toISOString();
    applyEvent(st, end);
  }
  return getOwn(st.sessions, `claude:${id}`)!;
}

beforeEach(() => resetCounter());

describe('room assignment', () => {
  it('exactly maxPods active sessions plus old ended sessions: every active session keeps a room', () => {
    const st = createInitialState();
    const now = Date.now();
    for (let i = 0; i < 4; i++) session(st, `ended-${i}`, { ended: true, at: now - 100_000 + i });
    for (let i = 0; i < 6; i++) session(st, `active-${i}`, { at: now - 50_000 + i * 1000 });
    const vm = buildOfficeVM(st, noSel, filters, false, 6, now);
    const roomKeys = vm.rooms.map((r) => r.sessionKey);
    expect(roomKeys.every((k) => k?.startsWith('claude:active-'))).toBe(true);
    expect(new Set(roomKeys).size).toBe(6);
    expect(vm.unseatedSessionKeys).toHaveLength(4);
  });

  it('more than maxPods active sessions: seated ones keep their rooms, the rest are reported unseated', () => {
    const st = createInitialState();
    const now = Date.now();
    for (let i = 0; i < 9; i++) session(st, `a-${i}`, { at: now - 90_000 + i * 1000 });
    const vm = buildOfficeVM(st, noSel, filters, false, 6, now);
    const roomKeys = vm.rooms.map((r) => r.sessionKey);
    expect(roomKeys).toEqual(['claude:a-0', 'claude:a-1', 'claude:a-2', 'claude:a-3', 'claude:a-4', 'claude:a-5']);
    expect(vm.unseatedSessionKeys.sort()).toEqual(['claude:a-6', 'claude:a-7', 'claude:a-8']);
    expect(vm.characters.every((c) => c.podIndex >= 0 && c.podIndex < 6)).toBe(true);
  });

  it('ended sessions only fill rooms left over by active ones', () => {
    const st = createInitialState();
    const now = Date.now();
    session(st, 'e1', { ended: true, at: now - 10_000 });
    session(st, 'e2', { ended: true, at: now - 20_000 });
    session(st, 'act', { at: now - 1000 });
    const { roomed } = assignRooms(Object.values(st.sessions), 2);
    expect(roomed.map((s) => s?.sessionId)).toEqual(['act', 'e1']);
  });

  it('rooms are sticky: new events never move a seated session, and an active newcomer evicts only ended sessions', () => {
    const st = createInitialState();
    const now = Date.now();
    const a = session(st, 'A', { at: now - 30_000 });
    session(st, 'B', { at: now - 20_000 });
    let vm = buildOfficeVM(st, noSel, filters, false, 2, now);
    expect(vm.roomMap).toEqual({ 'claude:A': 0, 'claude:B': 1 });
    // B becomes the most recently active; A keeps room 0.
    applyEvent(st, ev('claude', { session_id: 'B', hook_event_name: 'UserPromptSubmit' }));
    vm = buildOfficeVM(st, noSel, filters, false, 2, now, vm.roomMap);
    expect(vm.roomMap).toEqual({ 'claude:A': 0, 'claude:B': 1 });
    // A third active session cannot evict an active one.
    session(st, 'C', { at: now - 1000 });
    vm = buildOfficeVM(st, noSel, filters, false, 2, now, vm.roomMap);
    expect(vm.roomMap).toEqual({ 'claude:A': 0, 'claude:B': 1 });
    expect(vm.unseatedSessionKeys).toEqual(['claude:C']);
    // When A ends, C takes A's room; B stays put.
    applyEvent(st, ev('claude', { session_id: 'A', hook_event_name: 'SessionEnd' }));
    expect(a.lifecycle).toBe('ended');
    vm = buildOfficeVM(st, noSel, filters, false, 2, now, vm.roomMap);
    expect(vm.roomMap).toEqual({ 'claude:B': 1, 'claude:C': 0 });
    // Characters follow the sticky rooms.
    expect(vm.characters.find((c) => c.sessionKey === 'claude:B')!.podIndex).toBe(1);
    expect(vm.characters.find((c) => c.sessionKey === 'claude:C')!.podIndex).toBe(0);
  });
});

describe('characters', () => {
  it('uses collision-safe keys (ids containing the separator cannot collide)', () => {
    expect(characterKey('claude', 's:a', 'b')).not.toBe(characterKey('claude', 's', 'a:b'));
  });

  it('gives many employees distinct seat indexes and marks unknown parents as unlinked', () => {
    const st = createInitialState();
    applyEvent(st, ev('codex', { session_id: 'big', hook_event_name: 'SessionStart' }));
    for (let i = 0; i < 12; i++) applyEvent(st, ev('codex', { session_id: 'big', hook_event_name: 'SubagentStart', agent_id: `w${i}` }));
    const vm = buildOfficeVM(st, noSel, filters, false, 6);
    const employees = vm.characters.filter((c) => c.role === 'subagent');
    expect(employees).toHaveLength(12);
    expect(new Set(employees.map((c) => c.seatIndex)).size).toBe(12);
    expect(employees.every((c) => c.parentKey === null)).toBe(true);
    expect(vm.characters.find((c) => c.role === 'main')!.seatIndex).toBe(-1);
  });

  it('a bare old SessionStart is idle and stale, with no bubble and no working status', () => {
    const st = createInitialState();
    const s = session(st, 'quiet', { at: Date.now() - 60 * 60 * 1000 });
    const vm = buildOfficeVM(st, noSel, filters, false, 6);
    const main = vm.characters[0]!;
    expect(main.status).toBe('idle');
    expect(main.bubble).toBeNull();
    expect(main.stale).toBe(true);
    expect(vm.rooms[0]!.subtitle).toContain('최근 활동 없음');
    expect(s.currentTurn).toBeNull();
  });

  it('a running turn without tools shows "응답 진행 중", never a fabricated task', () => {
    const st = createInitialState();
    applyEvent(st, ev('claude', { session_id: 't', hook_event_name: 'UserPromptSubmit' }));
    const vm = buildOfficeVM(st, noSel, filters, false, 6);
    expect(vm.characters[0]!.bubble?.title).toBe('응답 진행 중');
  });
});
