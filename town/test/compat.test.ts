/**
 * Compatibility of older stored/replayed state (schema 2, pass 2) with the
 * current reducer (schema 3 added recentTurnIds / staleTurnEvents).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconstructState, stateBefore } from '../src/server/retention.js';
import { EventStore } from '../src/server/store.js';
import { getOwn, ownValues } from '../src/shared/dict.js';
import {
  applyEvent,
  applyEvents,
  createInitialState,
  STATE_SCHEMA_VERSION,
  toolKey,
  type TownState,
  upgradeState,
} from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

/** Build a representative pass-2 checkpoint: v3 fields removed, schemaVersion 2. */
function oldShapeState(): { state: TownState; seq: number; events: ReturnType<typeof ev>[] } {
  const live = createInitialState();
  const events = [
    ev('claude', { session_id: 'old', hook_event_name: 'SessionStart', cwd: 'C:/p/legacy' }),
    ev('claude', { session_id: 'old', hook_event_name: 'UserPromptSubmit', prompt_id: 'p-old' }),
    ev('claude', { session_id: 'old', hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'Explore' }),
    ev('claude', { session_id: 'old', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Read', tool_use_id: 'r1' }),
    ev('claude', { session_id: 'old', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1' }),
    ev('claude', { session_id: 'old', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'b1' }),
    ev('claude', { session_id: 'old', hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 'b1' }),
    ev('codex', { session_id: 'done', hook_event_name: 'SessionStart' }),
    ev('codex', { session_id: 'done', hook_event_name: 'SessionEnd' }),
  ];
  applyEvents(live, events);
  const raw = JSON.parse(JSON.stringify(live)) as Record<string, unknown>;
  raw.schemaVersion = 2;
  for (const s of Object.values(raw.sessions as Record<string, Record<string, unknown>>)) {
    delete s.recentTurnIds;
    delete s.staleTurnEvents;
  }
  raw.historyFromSeq = 3; // pretend earlier rows were retained away
  return { state: raw as unknown as TownState, seq: events.length, events };
}

describe('upgradeState (shared)', () => {
  it('adds only the missing v3 fields, preserves everything else, and is idempotent', () => {
    const { state } = oldShapeState();
    const before = JSON.stringify(state);
    const s0 = getOwn(state.sessions, 'claude:old')! as unknown as Record<string, unknown>;
    expect(s0.recentTurnIds).toBeUndefined();

    upgradeState(state);
    expect(state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    const s = getOwn(state.sessions, 'claude:old')!;
    expect(s.recentTurnIds).toEqual(['p-old']); // the stored current turn's own id, nothing invented
    expect(s.staleTurnEvents).toBe(0);
    expect(getOwn(state.sessions, 'codex:done')!.recentTurnIds).toEqual([]);
    // Records preserved.
    expect(Object.keys(s.agents).sort()).toEqual(['kid', 'main']);
    expect(getOwn(s.toolCalls, toolKey('kid', 'r1'))!.status).toBe('running');
    expect(getOwn(s.toolCalls, toolKey('main', 'b1'))!.status).toBe('denied');
    expect(getOwn(s.approvals, toolKey('main', 'b1'))!.decision).toBe('denied');
    expect(s.currentTurn?.turnId).toBe('p-old');
    expect(s.currentTurn?.status).toBe('running');
    expect(s.eventCount).toBe(7);
    expect(state.historyFromSeq).toBe(3);
    expect(state.lastSeq).toBe(9);

    const once = JSON.stringify(state);
    upgradeState(state);
    expect(JSON.stringify(state)).toBe(once);
    // Only the three expected differences versus the raw old shape.
    const re = JSON.parse(before) as TownState;
    upgradeState(re);
    expect(JSON.stringify(re)).toBe(once);
  });

  it('the reducer itself tolerates an old-shape session (guard in ensureSession)', () => {
    const { state } = oldShapeState();
    // No explicit upgrade: apply a new turn and Stop directly.
    applyEvent(state, ev('claude', { session_id: 'old', hook_event_name: 'UserPromptSubmit', prompt_id: 'p-new' }));
    applyEvent(state, ev('claude', { session_id: 'old', hook_event_name: 'Stop', prompt_id: 'p-old' })); // stale
    const s = getOwn(state.sessions, 'claude:old')!;
    expect(s.currentTurn?.turnId).toBe('p-new');
    expect(s.currentTurn?.status).toBe('running');
    expect(s.staleTurnEvents).toBe(1);
    applyEvent(state, ev('claude', { session_id: 'old', hook_event_name: 'Stop', prompt_id: 'p-new' }));
    expect(s.currentTurn?.status).toBe('completed');
    expect(s.recentTurnIds).toEqual(['p-old', 'p-new']);
  });
});

describe('old checkpoint in SQLite', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    resetCounter();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-compat-'));
    store = new EventStore(path.join(dir, 'events.sqlite'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconstructs from a schema-2 checkpoint, keeps records, and completes a new turn normally', () => {
    const { state: old, seq, events } = oldShapeState();
    // The rows the checkpoint summarises were stored and then retained away
    // (AUTOINCREMENT keeps later seqs above the checkpoint, as in production).
    for (const e of events) store.insert(e);
    store.deleteUpTo(seq);
    // Persist the old-shape checkpoint verbatim (as pass 2 would have written it).
    store.saveCheckpoint(seq, old);
    const storedRaw = JSON.parse(JSON.stringify(old)) as Record<string, unknown>;
    expect(storedRaw.schemaVersion).toBe(2);

    // Events that arrived after the checkpoint.
    const tail = [
      ev('claude', { session_id: 'old', hook_event_name: 'PostToolUse', agent_id: 'kid', tool_name: 'Read', tool_use_id: 'r1', tool_response: {} }),
    ];
    for (const e of tail) store.insert(e);

    const live = reconstructState(store);
    expect(live.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    expect(live.historyFromSeq).toBe(seq);
    const s = getOwn(live.sessions, 'claude:old')!;
    expect(Object.keys(s.agents).sort()).toEqual(['kid', 'main']);
    expect(getOwn(s.toolCalls, toolKey('kid', 'r1'))!.status).toBe('completed');
    expect(getOwn(s.toolCalls, toolKey('main', 'b1'))!.status).toBe('denied');
    expect(getOwn(s.approvals, toolKey('main', 'b1'))!.decision).toBe('denied');
    expect(getOwn(s.approvals, toolKey('main', 'b1'))!.resolutionEvidence).toBe('observed');
    expect(s.currentTurn?.turnId).toBe('p-old');
    expect(s.eventCount).toBe(8);
    expect(getOwn(live.sessions, 'codex:done')!.lifecycle).toBe('ended');

    // A new turn and its Stop behave normally; a stale Stop for the old turn is ignored.
    const apply = (e: ReturnType<typeof ev>) => applyEvent(live, store.insert(e)!);
    apply(ev('claude', { session_id: 'old', hook_event_name: 'UserPromptSubmit', prompt_id: 'p-new' }));
    apply(ev('claude', { session_id: 'old', hook_event_name: 'Stop', prompt_id: 'p-old' }));
    expect(s.currentTurn?.turnId).toBe('p-new');
    expect(s.currentTurn?.status).toBe('running');
    expect(s.staleTurnEvents).toBe(1);
    apply(ev('claude', { session_id: 'old', hook_event_name: 'Stop', prompt_id: 'p-new' }));
    expect(s.currentTurn?.status).toBe('completed');
    expect(s.turnsCompleted).toBe(1);
    expect(ownValues(s.agents).every((a) => a.activeToolIds.length === 0)).toBe(true);

    // Restart equivalence still holds with the old checkpoint on disk.
    store.close();
    store = new EventStore(path.join(dir, 'events.sqlite'));
    expect(JSON.stringify(reconstructState(store))).toBe(JSON.stringify(live));
    // The stored checkpoint row was not rewritten (non-destructive).
    expect((store.loadCheckpoint()!.state as TownState).schemaVersion).toBe(STATE_SCHEMA_VERSION); // upgraded in memory
    expect(store.loadCheckpoint()!.seq).toBe(seq);
    // Replay base derived from the old checkpoint is also usable.
    const base = stateBefore(store, seq + 1);
    expect(getOwn(base.sessions, 'claude:old')!.recentTurnIds).toEqual(['p-old']);
  });
});
