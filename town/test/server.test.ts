import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type ServerConfig } from '../src/server/config.js';
import { bearerMatches, resolveStaticPath, safeInt, startServer, type TownServer } from '../src/server/http.js';
import { EventStore } from '../src/server/store.js';
import type { ServerMessage } from '../src/shared/protocol.js';

let dir: string;
let clientDir: string;
let cfg: ServerConfig;
let store: EventStore;
let town: TownServer;

function base(): string {
  return `http://127.0.0.1:${town.port}`;
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base()}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${cfg.ingestToken}` };
}

function envelope(provider: 'claude' | 'codex', payload: Record<string, unknown>, id = `e-${Math.random()}`) {
  return { eventId: id.replace(/[^A-Za-z0-9_.:-]/g, ''), provider, payload };
}

async function bootstrapToken(): Promise<string> {
  const boot = await fetch(`${base()}/api/bootstrap`);
  return ((await boot.json()) as { sessionToken: string }).sessionToken;
}

/** Raw request so we can send headers/paths fetch() would normalise away. */
function rawRequest(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: town.port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers ?? {} },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += String(d)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-srv-'));
  clientDir = path.join(dir, 'client');
  fs.mkdirSync(path.join(clientDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Agent Town</title>');
  fs.writeFileSync(path.join(clientDir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'client-secret.txt'), 'SIBLING-PREFIX-SECRET');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'OUTSIDE');
  fs.mkdirSync(path.join(clientDir, '.data'));
  fs.writeFileSync(path.join(clientDir, '.data', 'x.txt'), 'DOTFILE');
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

describe('ingest endpoint', () => {
  it('rejects requests without the ingest token', async () => {
    const res = await post(envelope('claude', { session_id: 's', hook_event_name: 'Stop' }));
    expect(res.status).toBe(401);
  });

  it('rejects a wrong Host header (DNS rebinding guard)', async () => {
    const body = JSON.stringify(envelope('claude', { session_id: 's', hook_event_name: 'Stop' }));
    const r = await rawRequest({
      method: 'POST',
      path: '/api/ingest',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...authHeaders(), Host: 'evil.example:80' },
      body,
    });
    expect(r.status).toBe(421);
  });

  it('rejects browser-originated ingest', async () => {
    const res = await post(envelope('claude', { session_id: 's', hook_event_name: 'Stop' }), {
      ...authHeaders(),
      Origin: `http://127.0.0.1:${town.port}`,
    });
    expect(res.status).toBe(403);
  });

  it('accepts, stores, dedupes and updates live state', async () => {
    const env = envelope('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'C:\\Users\\tester\\proj\\a.ts' } }, 'fixed-1');
    const r1 = await post(env, authHeaders());
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    const r2 = await post(env, authHeaders());
    expect(await r2.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(store.count()).toBe(1);
    const stored = store.list(0, 10)[0]!;
    expect(stored.payload.toolTarget).toBe('…/proj/a.ts');
    expect(JSON.stringify(stored)).not.toContain('Users\\\\tester');
    expect(town.state.sessions['claude:s']!.agents.main!.activeToolIds).toHaveLength(1);
  });

  it('accepts batches and rejects oversized or malformed payloads', async () => {
    const batch = { events: [envelope('codex', { session_id: 'c', hook_event_name: 'SessionStart' }), envelope('codex', { session_id: 'c', hook_event_name: 'Stop' })] };
    const ok = await post(batch, authHeaders());
    expect(await ok.json()).toMatchObject({ accepted: 2 });
    const bad = await post({ eventId: 'x', provider: 'nope', payload: {} }, authHeaders());
    expect(bad.status).toBe(400);
    const big = await fetch(`${base()}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(envelope('claude', { session_id: 's', hook_event_name: 'Stop', junk: 'x'.repeat(300 * 1024) })),
    });
    expect(big.status).toBe(413);
  });

  it('ignores payloads without session_id but counts them in diagnostics', async () => {
    const res = await post(envelope('claude', { hook_event_name: 'Stop' }), authHeaders());
    expect(await res.json()).toMatchObject({ accepted: 0, ignored: 1 });
    expect(town.diagnostics().providers.claude.rejected).toBe(1);
  });
});

describe('browser access', () => {
  it('requires a bootstrap session for state/events and rejects cross-site origins', async () => {
    const noAuth = await fetch(`${base()}/api/state`);
    expect(noAuth.status).toBe(401);
    const cross = await fetch(`${base()}/api/bootstrap`, { headers: { Origin: 'http://attacker.example' } });
    expect(cross.status).toBe(403);
    const sessionToken = await bootstrapToken();
    const state = await fetch(`${base()}/api/state`, { headers: { 'X-Agent-Town-Session': sessionToken } });
    expect(state.status).toBe(200);
    const events = await fetch(`${base()}/api/events?since=0&limit=10`, { headers: { 'X-Agent-Town-Session': sessionToken } });
    expect(events.status).toBe(200);
    const replay = await fetch(`${base()}/api/replay?limit=10`, { headers: { 'X-Agent-Town-Session': sessionToken } });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ baseSeq: 0, events: [] });
  });

  it('WebSocket requires the session token as first message, then streams snapshot and events', async () => {
    const sessionToken = await bootstrapToken();
    const ws = new WebSocket(`ws://127.0.0.1:${town.port}/ws`, { headers: { Origin: `http://127.0.0.1:${town.port}` } });
    const messages: ServerMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', sessionToken })));
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        messages.push(m);
        if (m.type === 'snapshot') resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
    expect(messages.map((m) => m.type)).toContain('hello');
    const eventPromise = new Promise<ServerMessage>((resolve) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        if (m.type === 'event') resolve(m);
      });
    });
    await post(envelope('codex', { session_id: 'live', hook_event_name: 'SessionStart' }), authHeaders());
    expect((await eventPromise).type).toBe('event');
    ws.close();
  });

  it('closes an unauthenticated WebSocket and rejects bad origins at upgrade', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${town.port}/ws`, { headers: { Origin: 'http://attacker.example' } });
    await new Promise<void>((resolve) => {
      bad.on('error', () => resolve());
      bad.on('close', () => resolve());
    });
    const ws = new WebSocket(`ws://127.0.0.1:${town.port}/ws`);
    const code = await new Promise<number>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', sessionToken: 'wrong' })));
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4003);
  });
});

describe('robustness: bad input never takes the server down', () => {
  it('malformed percent-encoding, odd query values and multibyte auth headers get 4xx, then normal requests work', async () => {
    const sessionToken = await bootstrapToken();
    const badUrl = await rawRequest({ path: '/%E0%A4%A', headers: { Host: `127.0.0.1:${town.port}` } });
    expect([400, 404]).toContain(badUrl.status);
    const badApi = await rawRequest({ path: '/api/%ZZ', headers: { Host: `127.0.0.1:${town.port}`, 'X-Agent-Town-Session': sessionToken } });
    expect([400, 404]).toContain(badApi.status);
    for (const q of ['limit=abc', 'limit=1e400', 'limit=Infinity', 'limit=1.5', 'limit=-5', 'since=999999999999999999999', 'limit=' + '9'.repeat(400)]) {
      const r = await fetch(`${base()}/api/events?${q}`, { headers: { 'X-Agent-Town-Session': sessionToken } });
      expect(r.status, q).toBe(200);
    }
    // Same character length as the real header but different UTF-8 byte length
    // (Node only allows Latin-1 in outgoing headers, so use U+00E9 on the wire).
    const body = JSON.stringify(envelope('claude', { session_id: 's', hook_event_name: 'Stop' }));
    const multi = await rawRequest({
      method: 'POST',
      path: '/api/ingest',
      headers: { Host: `127.0.0.1:${town.port}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), Authorization: `Bearer ${'é'.repeat(cfg.ingestToken.length)}` },
      body,
    });
    expect(multi.status).toBe(401);
    expect(bearerMatches(`Bearer ${'한'.repeat(cfg.ingestToken.length)}`, cfg.ingestToken)).toBe(false);
    expect(bearerMatches(`Bearer ${cfg.ingestToken}`, cfg.ingestToken)).toBe(true);
    expect(bearerMatches(undefined, cfg.ingestToken)).toBe(false);
    // Still alive and functional.
    const ok = await post(envelope('claude', { session_id: 's', hook_event_name: 'SessionStart' }), authHeaders());
    expect(ok.status).toBe(200);
    expect(safeInt('12', 0, 0, 100)).toBe(12);
    expect(safeInt('1e400', 7, 0, 100)).toBe(7);
    expect(safeInt('999', 7, 0, 100)).toBe(100);
  });

  it('WebSocket ignores null/array/garbage frames and keeps serving', async () => {
    const sessionToken = await bootstrapToken();
    const ws = new WebSocket(`ws://127.0.0.1:${town.port}/ws`, { headers: { Origin: `http://127.0.0.1:${town.port}` } });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send('null');
        ws.send('[]');
        ws.send('"str"');
        ws.send('{not json');
        ws.send(JSON.stringify({ type: 'auth', sessionToken }));
      });
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        if (m.type === 'snapshot') resolve();
      });
      ws.on('error', reject);
      ws.on('close', (c) => reject(new Error(`closed ${c}`)));
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
    ws.send('null');
    ws.send('{"type":123}');
    const diag = await new Promise<ServerMessage>((resolve) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        if (m.type === 'diagnostics') resolve(m);
      });
      ws.send(JSON.stringify({ type: 'ping' }));
    });
    expect(diag.type).toBe('diagnostics');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('static file containment', () => {
  it('serves the UI and assets but never traversal, sibling-prefix, dotfiles or outside files', async () => {
    const host = { Host: `127.0.0.1:${town.port}` };
    expect((await rawRequest({ path: '/', headers: host })).body).toContain('Agent Town');
    expect((await rawRequest({ path: '/assets/app.js', headers: host })).status).toBe(200);
    expect((await rawRequest({ path: '/some/route', headers: host })).body).toContain('Agent Town');
    for (const p of [
      '/../outside.txt',
      '/..%2foutside.txt',
      '/%2e%2e/outside.txt',
      '/assets/..%5c..%5coutside.txt',
      '/..\\outside.txt',
      '/../client-secret.txt',
      '/.data/x.txt',
      '/%00index.html',
      '/assets/%2e%2e/%2e%2e/outside.txt',
    ]) {
      const r = await rawRequest({ path: p, headers: host });
      expect(r.status, p).not.toBe(200);
      expect(r.body, p).not.toContain('OUTSIDE');
      expect(r.body, p).not.toContain('SIBLING');
      expect(r.body, p).not.toContain('DOTFILE');
    }
    expect(resolveStaticPath(clientDir, '/../outside.txt')).toBeNull();
    expect(resolveStaticPath(clientDir, '/.data/x.txt')).toBeNull();
    expect(resolveStaticPath(clientDir, '/assets/app.js')).toBe(path.join(path.resolve(clientDir), 'assets', 'app.js'));
    // Sibling directory with the client dir as a prefix.
    expect(resolveStaticPath(clientDir, '/../client-secret.txt')).toBeNull();
  });
});
