/**
 * GET /api/retrospect: browser-session protected, session-scoped, built from
 * stored events; demo and unknown sessions refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type ServerConfig } from '../src/server/config.js';
import { startServer, type TownServer } from '../src/server/http.js';
import { EventStore } from '../src/server/store.js';
import type { RetrospectResult } from '../src/shared/retrospect.js';

let dir: string;
let cfg: ServerConfig;
let store: EventStore;
let town: TownServer;

const base = (): string => `http://127.0.0.1:${town.port}`;

async function ingest(provider: 'claude' | 'codex', payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base()}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.ingestToken}` },
    body: JSON.stringify({ eventId: `e-${Math.random().toString(36).slice(2)}`, provider, payload }),
  });
  expect(res.status).toBe(200);
}

async function token(): Promise<string> {
  const boot = await fetch(`${base()}/api/bootstrap`);
  return ((await boot.json()) as { sessionToken: string }).sessionToken;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-retro-'));
  const clientDir = path.join(dir, 'client');
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Agent Town</title>');
  cfg = loadConfig({
    dataDir: dir,
    port: 0,
    portExplicit: true,
    clientDir,
    devMode: false,
    homeDir: 'C:\\Users\\tester',
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

describe('GET /api/retrospect', () => {
  it('requires a browser session token', async () => {
    const res = await fetch(`${base()}/api/retrospect?session=claude:s`);
    expect(res.status).toBe(401);
  });

  it('returns Markdown and metrics for a stored session, scoped to that session only', async () => {
    await ingest('claude', { session_id: 's', hook_event_name: 'SessionStart', cwd: 'C:/p/shop', model: 'claude-opus-5' });
    await ingest('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' });
    await ingest('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'C:/Users/tester/p/shop/src/x.ts' } });
    await ingest('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_response: {} });
    await ingest('claude', { session_id: 's', hook_event_name: 'Stop', prompt_id: 'p1' });
    await ingest('codex', { session_id: 'other', hook_event_name: 'SessionStart' });
    const t = await token();
    const res = await fetch(`${base()}/api/retrospect?session=claude:s`, { headers: { 'X-Agent-Town-Session': t } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RetrospectResult & { truncated: boolean };
    expect(body.eventCount).toBe(5);
    expect(body.truncated).toBe(false);
    expect(body.metrics.turns).toBe(1);
    expect(body.metrics.toolCalls).toBe(1);
    expect(body.markdown).toContain('# 작업 회고 요청 — shop · s ·');
    expect(body.markdown).toContain('모델 claude-opus-5');
    expect(body.markdown).toContain('Read …/src/x.ts');
    expect(body.markdown).not.toContain('C:/Users/tester'); // home masked at ingest
    expect(body.markdown).not.toContain('other');
  });

  it('honours scope=last-turn and an upper seq bound', async () => {
    await ingest('codex', { session_id: 'c', hook_event_name: 'SessionStart' });
    await ingest('codex', { session_id: 'c', hook_event_name: 'UserPromptSubmit', turn_id: 't1' });
    await ingest('codex', { session_id: 'c', hook_event_name: 'Stop', turn_id: 't1' });
    await ingest('codex', { session_id: 'c', hook_event_name: 'UserPromptSubmit', turn_id: 't2' });
    await ingest('codex', { session_id: 'c', hook_event_name: 'PreToolUse', turn_id: 't2', tool_name: 'exec_command', tool_use_id: 'x', tool_input: { command: 'ls' } });
    const t = await token();
    const last = (await (await fetch(`${base()}/api/retrospect?session=codex:c&scope=last-turn`, { headers: { 'X-Agent-Town-Session': t } })).json()) as RetrospectResult;
    expect(last.metrics.turns).toBe(1);
    expect(last.metrics.toolCalls).toBe(1);
    expect(last.markdown).toContain('마지막 턴만');
    const bounded = (await (await fetch(`${base()}/api/retrospect?session=codex:c&to=3`, { headers: { 'X-Agent-Town-Session': t } })).json()) as RetrospectResult;
    expect(bounded.eventCount).toBe(3);
    expect(bounded.metrics.toolCalls).toBe(0);
    expect(bounded.metrics.partialHistory).toBe(true);
  });

  it('refuses unknown sessions and malformed keys without crashing', async () => {
    const t = await token();
    for (const q of ['session=claude:nope', 'session=', 'session=%ZZ', 'session=__proto__']) {
      const res = await fetch(`${base()}/api/retrospect?${q}`, { headers: { 'X-Agent-Town-Session': t } });
      expect([400, 404]).toContain(res.status);
    }
  });
});
