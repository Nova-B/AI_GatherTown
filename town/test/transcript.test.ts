/**
 * Esc detection from the Claude transcript marker.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type ServerConfig } from '../src/server/config.js';
import { startServer, type TownServer } from '../src/server/http.js';
import { EventStore } from '../src/server/store.js';
import {
  encodeProjectDir,
  expandHome,
  findInterruptMarkers,
  INTERRUPT_MARKER,
  TranscriptWatcher,
  transcriptPathFor,
} from '../src/server/transcript.js';
import { getOwn } from '../src/shared/dict.js';
import type { AgentEvent } from '../src/shared/events.js';
import { agentDisplayStatus, applyEvent, applyEvents, createInitialState, toolKey, type TownState } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

const HOME = 'C:\\Users\\tester';

function userLine(text: string, timestamp: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp, uuid: 'u1' });
}

beforeEach(() => resetCounter());

describe('paths and markers', () => {
  it('derives the transcript path from the masked cwd and session id the way Claude Code names it', () => {
    expect(encodeProjectDir('C:\\Users\\user\\Desktop\\MindPalace_Nova')).toBe('C--Users-user-Desktop-MindPalace-Nova');
    expect(expandHome('~\\Desktop\\p', HOME)).toBe('C:\\Users\\tester\\Desktop\\p');
    expect(expandHome('~/Desktop/p', HOME)).toBe('C:\\Users\\tester/Desktop/p');
    expect(transcriptPathFor('P', HOME, '~\\Desktop\\MindPalace_Nova', 'abc')).toBe(path.join('P', 'C--Users-tester-Desktop-MindPalace-Nova', 'abc.jsonl'));
    expect(transcriptPathFor('P', HOME, null, 'abc')).toBeNull();
    expect(transcriptPathFor('P', HOME, '~\\x', '..\\..\\etc')).toBeNull();
  });

  it('finds the marker only on user lines, with the timestamp; ignores assistant text, other users, garbage', () => {
    const hits = findInterruptMarkers([
      userLine('[Request interrupted by user for tool use]', '2026-09-16T13:32:40.902Z'),
      JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I saw "[Request interrupted by user" in a file' }] }, timestamp: 'x' }),
      userLine('please continue', '2026-09-16T13:33:00.000Z'),
      '{not json [Request interrupted by user',
      '',
    ]);
    expect(hits).toEqual([{ timestamp: '2026-09-16T13:32:40.902Z' }, { timestamp: null }]);
    expect(INTERRUPT_MARKER).toBe('[Request interrupted by user');
  });
});

describe('TranscriptWatcher', () => {
  let dir: string;
  let projects: string;
  let file: string;
  let st: TownState;
  let emitted: AgentEvent[];
  let clock: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-transcript-'));
    projects = path.join(dir, 'projects');
    st = createInitialState();
    emitted = [];
    clock = Date.parse('2026-09-16T13:30:00.000Z');
    // A Claude session in ~\proj (masked by the normalizer) with a running turn.
    applyEvents(st, [
      ev('claude', { session_id: 'sid', hook_event_name: 'SessionStart', cwd: 'C:\\Users\\tester\\proj' }),
      ev('claude', { session_id: 'sid', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', cwd: 'C:\\Users\\tester\\proj' }),
      ev('claude', { session_id: 'sid', hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'sleep 100' } }),
    ]);
    const s = getOwn(st.sessions, 'claude:sid')!;
    s.currentTurn!.startedAt = '2026-09-16T13:30:00.000Z';
    file = transcriptPathFor(projects, HOME, s.cwd, 'sid')!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, userLine('[Request interrupted by user]', '2026-09-16T13:00:00.000Z') + '\n'); // old history
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function watcher(): TranscriptWatcher {
    return new TranscriptWatcher({ projectsDir: projects, homeDir: HOME, state: st, emit: (e) => emitted.push(e), now: () => new Date(clock) });
  }

  it('emits one observed interruption for the running turn when the marker is appended; never replays history', () => {
    const w = watcher();
    w.tick(); // registers the file at its current end
    expect(w.stats.watching).toBe(1);
    expect(emitted).toHaveLength(0);
    clock += 40_000;
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) + '\n');
    w.tick();
    expect(emitted).toHaveLength(0);
    fs.appendFileSync(file, userLine('[Request interrupted by user for tool use]', '2026-09-16T13:30:40.902Z') + '\n');
    w.tick();
    expect(emitted).toHaveLength(1);
    const e = emitted[0]!;
    expect(e.kind).toBe('turn.failed');
    expect(e.source).toBe('transcript');
    expect(e.evidence).toBe('observed');
    expect(e.turnId).toBe('p1');
    expect(e.payload.reason).toBe('interrupted');
    expect(e.occurredAt).toBe('2026-09-16T13:30:40.902Z');
    expect(w.stats.markers).toBe(1);
    // Applying it closes the turn and its tools like any observed interruption.
    applyEvent(st, { ...e, ingestSeq: 99 });
    const s = getOwn(st.sessions, 'claude:sid')!;
    expect(s.currentTurn?.status).toBe('interrupted');
    expect(s.currentTurn?.endEvidence).toBe('observed');
    expect(getOwn(s.toolCalls, toolKey('main', 'b1'))!.status).toBe('unresolved');
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('failed');
    // Same marker is not emitted twice; a second tick with nothing new is quiet.
    w.tick();
    expect(emitted).toHaveLength(1);
  });

  it('a marker older than the turn start, or seen while no turn runs, is ignored; a new turn can be interrupted again', () => {
    const w = watcher();
    w.tick();
    fs.appendFileSync(file, userLine('[Request interrupted by user]', '2026-09-16T13:29:00.000Z') + '\n'); // before the turn started
    w.tick();
    expect(emitted).toHaveLength(0);
    // Turn ends normally; a marker now has nothing to interrupt.
    applyEvent(st, ev('claude', { session_id: 'sid', hook_event_name: 'Stop', prompt_id: 'p1' }));
    fs.appendFileSync(file, userLine('[Request interrupted by user]', '2026-09-16T13:31:00.000Z') + '\n');
    w.tick();
    expect(emitted).toHaveLength(0);
    // Next turn, next Esc.
    applyEvent(st, ev('claude', { session_id: 'sid', hook_event_name: 'UserPromptSubmit', prompt_id: 'p2' }));
    getOwn(st.sessions, 'claude:sid')!.currentTurn!.startedAt = '2026-09-16T13:32:00.000Z';
    fs.appendFileSync(file, userLine('[Request interrupted by user for tool use]', '2026-09-16T13:32:10.000Z') + '\n');
    w.tick();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.turnId).toBe('p2');
  });

  it('handles a line split across reads and a missing transcript without errors', () => {
    const w = watcher();
    w.tick();
    const line = userLine('[Request interrupted by user for tool use]', '2026-09-16T13:30:40.902Z');
    fs.appendFileSync(file, line.slice(0, 20));
    w.tick();
    expect(emitted).toHaveLength(0);
    fs.appendFileSync(file, line.slice(20) + '\n');
    w.tick();
    expect(emitted).toHaveLength(1);
    // A session whose transcript does not exist is skipped silently.
    applyEvent(st, ev('claude', { session_id: 'other', hook_event_name: 'UserPromptSubmit', prompt_id: 'q', cwd: 'C:\\Users\\tester\\elsewhere' }));
    w.tick();
    expect(w.stats.lastError).toBeNull();
    expect(w.stats.watching).toBe(1);
  });
});

describe('server integration', () => {
  let dir: string;
  let cfg: ServerConfig;
  let store: EventStore;
  let town: TownServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-transcript-srv-'));
    const clientDir = path.join(dir, 'client');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Agent Town</title>');
    cfg = loadConfig({
      dataDir: dir,
      port: 0,
      portExplicit: true,
      clientDir,
      devMode: false,
      homeDir: HOME,
      claudeProjectsDir: path.join(dir, 'projects'),
      transcriptWatch: true,
      retention: { maxAgeDays: 7, maxEvents: 1000, maxBytes: 1 << 30 },
    });
    store = new EventStore(cfg.dbPath);
    town = await startServer(cfg, store);
  });

  afterEach(async () => {
    await town.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores the synthesized interruption once, applies it to the live state and reports it in diagnostics', async () => {
    const post = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${town.port}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.ingestToken}` },
        body: JSON.stringify({ eventId: `e-${Math.random().toString(36).slice(2)}`, provider: 'claude', payload }),
      });
    await post({ session_id: 'sid', hook_event_name: 'SessionStart', cwd: 'C:\\Users\\tester\\proj' });
    await post({ session_id: 'sid', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', cwd: 'C:\\Users\\tester\\proj' });
    const s = getOwn(town.state.sessions, 'claude:sid')!;
    const file = transcriptPathFor(cfg.claudeProjectsDir, HOME, s.cwd, 'sid')!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    const w = town.transcriptWatcher!;
    w.tick();
    fs.appendFileSync(file, userLine('[Request interrupted by user for tool use]', new Date().toISOString()) + '\n');
    w.tick();
    w.tick();
    expect(s.currentTurn?.status).toBe('interrupted');
    expect(store.count()).toBe(3);
    const stored = store.recent(1)[0]!;
    expect(stored.source).toBe('transcript');
    expect(stored.kind).toBe('turn.failed');
    const d = town.diagnostics();
    expect(d.transcript?.markers).toBe(1);
    expect(d.transcript?.enabled).toBe(true);
  });
});
