import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconstructState, runRetention, stateBefore } from '../src/server/retention.js';
import { EventStore } from '../src/server/store.js';
import { getOwn } from '../src/shared/dict.js';
import { sessionKey } from '../src/shared/events.js';
import { applyEvent, createInitialState, toolKey, type TownState } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

let dir: string;
let store: EventStore;

const BIG = { maxAgeDays: 3650, maxEvents: 1_000_000, maxBytes: 1 << 30 };

beforeEach(() => {
  resetCounter();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-store-'));
  store = new EventStore(path.join(dir, 'events.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Ingest into both the store and a live state the way the server does. */
function ingest(live: TownState, e: ReturnType<typeof ev>): void {
  const stored = store.insert(e)!;
  applyEvent(live, stored);
}

function reopen(): void {
  store.close();
  store = new EventStore(path.join(dir, 'events.sqlite'));
}

describe('EventStore', () => {
  it('assigns monotonic seq and ignores duplicate event ids', () => {
    const a = store.insert(ev('claude', { session_id: 's', hook_event_name: 'SessionStart' }));
    const b = store.insert(ev('claude', { session_id: 's', hook_event_name: 'Stop' }));
    expect(a!.ingestSeq).toBe(1);
    expect(b!.ingestSeq).toBe(2);
    expect(store.insert({ ...a!, ingestSeq: 0 })).toBeNull();
    expect(store.count()).toBe(2);
    expect(store.list(0, 10).map((e) => e.ingestSeq)).toEqual([1, 2]);
  });

  it('reconstructs state from stored events after a restart', () => {
    const live = createInitialState();
    ingest(live, ev('claude', { session_id: 's', hook_event_name: 'SessionStart', cwd: 'C:/p/app' }));
    ingest(live, ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'c1' }));
    ingest(live, ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'c1', tool_name: 'Read', tool_use_id: 't1', tool_input: {} }));
    ingest(live, ev('codex', { session_id: 's', hook_event_name: 'SessionStart' }));
    reopen();
    const state = reconstructState(store);
    expect(Object.keys(state.sessions)).toHaveLength(2);
    const s = getOwn(state.sessions, sessionKey('claude', 's'))!;
    expect(getOwn(s.agents, 'c1')!.activeToolIds).toEqual([toolKey('c1', 't1')]);
    expect(s.projectName).toBe('app');
    expect(state.lastSeq).toBe(4);
    expect(JSON.stringify(state)).toBe(JSON.stringify(live));
  });
});

describe('retention with checkpoint', () => {
  it('count-based retention keeps live == restart and marks unavailable history', () => {
    const live = createInitialState();
    // Session A: long-running, still active. Session B: ended early.
    ingest(live, ev('claude', { session_id: 'A', hook_event_name: 'SessionStart' }));
    ingest(live, ev('claude', { session_id: 'A', hook_event_name: 'UserPromptSubmit' }));
    ingest(live, ev('claude', { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1' }));
    ingest(live, ev('codex', { session_id: 'B', hook_event_name: 'SessionStart' }));
    ingest(live, ev('codex', { session_id: 'B', hook_event_name: 'SessionEnd' }));
    for (let i = 0; i < 6; i++) ingest(live, ev('claude', { session_id: 'A', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: `x${i}` }));
    expect(store.count()).toBe(11);

    const result = runRetention(store, live, { ...BIG, maxEvents: 4 });
    expect(result.deletedEvents).toBe(7);
    expect(result.pruneSeq).toBe(7);
    expect(result.prunedSessions).toBe(1); // B ended and fully before the prune seq
    expect(store.count()).toBe(4);
    expect(store.loadCheckpoint()?.seq).toBe(7);
    expect(live.historyFromSeq).toBe(7);
    expect(live.prunedSessions).toBe(1);
    expect(getOwn(live.sessions, 'codex:B')).toBeUndefined();
    // Session A survives with the state built from its now-deleted early events.
    const a = getOwn(live.sessions, 'claude:A')!;
    expect(a.agents.main!.activeToolIds).toEqual([toolKey('main', 'r1')]);
    expect(a.currentTurn?.status).toBe('running');

    reopen();
    const rebuilt = reconstructState(store);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(live));

    // New events keep working after retention, on both sides.
    ingest(live, ev('claude', { session_id: 'A', hook_event_name: 'Stop' }));
    expect(getOwn(live.sessions, 'claude:A')!.currentTurn?.status).toBe('completed');
    reopen();
    expect(JSON.stringify(reconstructState(store))).toBe(JSON.stringify(live));
    // seq keeps increasing after deletes.
    expect(store.lastSeq()).toBe(12);
  });

  it('age-based retention prunes silent sessions and keeps recent ones', () => {
    const live = createInitialState();
    const old = ev('claude', { session_id: 'old', hook_event_name: 'SessionStart' });
    old.receivedAt = '2020-01-01T00:00:00.000Z';
    ingest(live, old);
    const fresh = ev('claude', { session_id: 'fresh', hook_event_name: 'SessionStart' });
    fresh.receivedAt = new Date().toISOString();
    ingest(live, fresh);
    const r = runRetention(store, live, { maxAgeDays: 7, maxEvents: 1000, maxBytes: 1 << 30 });
    expect(r.deletedEvents).toBe(1);
    expect(r.prunedSessions).toBe(1);
    expect(getOwn(live.sessions, 'claude:old')).toBeUndefined();
    expect(getOwn(live.sessions, 'claude:fresh')).toBeDefined();
    reopen();
    expect(JSON.stringify(reconstructState(store))).toBe(JSON.stringify(live));
  });

  it('a second retention pass is idempotent and stateBefore gives a correct replay base', () => {
    const live = createInitialState();
    for (let i = 0; i < 10; i++) ingest(live, ev('codex', { session_id: 'S', hook_event_name: i === 0 ? 'SessionStart' : 'Stop' }));
    runRetention(store, live, { ...BIG, maxEvents: 5 });
    const again = runRetention(store, live, { ...BIG, maxEvents: 5 });
    expect(again.deletedEvents).toBe(0);
    // Replay base for the retained window equals the checkpoint state.
    const base = stateBefore(store, store.firstSeq());
    expect(base.lastSeq).toBe(store.loadCheckpoint()!.seq);
    const replayed = base;
    for (const e of store.list(0, 100)) applyEvent(replayed, e);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(live));
  });
});
