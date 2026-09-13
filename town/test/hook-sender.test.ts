import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type ServerConfig, writeServerJson } from '../src/server/config.js';
import { startServer, type TownServer } from '../src/server/http.js';
import { EventStore } from '../src/server/store.js';
import { getOwn } from '../src/shared/dict.js';
import { toolKey } from '../src/shared/state.js';
import { readServerJson } from '../hook/agent-town-hook.mjs';

const HOOK = path.resolve(__dirname, '..', 'hook', 'agent-town-hook.mjs');

let dir: string;
let cfg: ServerConfig;
let store: EventStore;
let town: TownServer;

/** Spawn the hook asynchronously (the in-process test server must stay responsive). */
function runHook(
  provider: string,
  payload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string; ms: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, '--provider', provider, '--data-dir', dir], {
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - start }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

function spoolFiles(): string[] {
  const p = path.join(dir, 'spool');
  return fs.existsSync(p) ? fs.readdirSync(p).filter((n) => n.endsWith('.json')) : [];
}

async function restartServer(): Promise<void> {
  town = await startServer(cfg, store);
  writeServerJson(cfg, town.port);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-hook-'));
  cfg = loadConfig({ dataDir: dir, port: 0, portExplicit: true, clientDir: null, devMode: false, homeDir: os.homedir() });
  store = new EventStore(cfg.dbPath);
  await restartServer();
});

afterEach(async () => {
  await town.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hook sender process', () => {
  it('delivers a redacted event, prints nothing, exits 0', async () => {
    const r = await runHook('claude', {
      session_id: 'hook-s',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 't1',
      tool_input: { file_path: 'C:/x/y.ts' },
      prompt: 'DO NOT SEND',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    await new Promise((res) => setTimeout(res, 100));
    expect(store.count()).toBe(1);
    const stored = store.list(0, 1)[0]!;
    expect(stored.toolCallId).toBe('t1');
    expect(JSON.stringify(stored)).not.toContain('DO NOT SEND');
  });

  it('offline PreToolUse then reconnect Stop: backlog is delivered first, in order, so the tool is not left running', async () => {
    const bad = await runHook('codex', '{ not json');
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe('');

    await town.close();
    fs.unlinkSync(cfg.serverJsonPath);
    const offline = await runHook('codex', { session_id: 'sp', hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_use_id: 'c1', tool_input: { command: 'sleep 5' } });
    expect(offline.status).toBe(0);
    expect(offline.ms).toBeLessThan(3000);
    expect(spoolFiles()).toHaveLength(1);

    await restartServer();
    const logFile = path.join(dir, 'hook.log');
    const online = await runHook('codex', { session_id: 'sp', hook_event_name: 'Stop' }, { AGENT_TOWN_HOOK_LOG: logFile });
    expect(online.status).toBe(0);
    await new Promise((res) => setTimeout(res, 150));
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
    expect(store.count(), log).toBe(2);
    expect(store.list(0, 10).map((e) => e.hookEventName)).toEqual(['PreToolUse', 'Stop']);
    expect(spoolFiles()).toHaveLength(0);
    const s = getOwn(town.state.sessions, 'codex:sp')!;
    expect(getOwn(s.toolCalls, toolKey('main', 'c1'))!.status).toBe('unresolved');
    expect(s.agents.main!.activeToolIds).toHaveLength(0);
    // Log lines never contain payload content.
    expect(log).not.toContain('sleep 5');
  });

  it('concurrent offline writers never lose events, and concurrent flushers deliver each exactly once', async () => {
    await town.close();
    fs.unlinkSync(cfg.serverJsonPath);
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runHook('claude', { session_id: 'par', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: `t${i}` }),
      ),
    );
    expect(spoolFiles()).toHaveLength(N);

    await restartServer();
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        runHook('claude', { session_id: 'par', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: `t${i}` }),
      ),
    );
    await new Promise((res) => setTimeout(res, 200));
    // Possibly one more flush round if a hook ran out of budget.
    if (spoolFiles().length > 0) await runHook('claude', { session_id: 'par', hook_event_name: 'Stop' });
    await new Promise((res) => setTimeout(res, 150));
    const kinds = store.list(0, 100).map((e) => e.hookEventName);
    expect(kinds.filter((k) => k === 'PreToolUse')).toHaveLength(N);
    expect(kinds.filter((k) => k === 'PostToolUse')).toHaveLength(4);
    expect(spoolFiles()).toHaveLength(0);
    const s = getOwn(town.state.sessions, 'claude:par')!;
    expect(s.duplicatesIgnored).toBe(0);
  });

  it('refuses a non-loopback server.json and spools instead of sending the token anywhere', async () => {
    fs.writeFileSync(cfg.serverJsonPath, JSON.stringify({ host: 'evil.example', port: town.port, ingestToken: cfg.ingestToken, version: '0', pid: 1, startedAt: '' }));
    expect(readServerJson(dir)).toBeNull();
    const r = await runHook('claude', { session_id: 'x', hook_event_name: 'Stop' });
    expect(r.status).toBe(0);
    expect(store.count()).toBe(0);
    expect(spoolFiles()).toHaveLength(1);
  });

  it('bounds the spool by bytes (Korean text counted as bytes) and stays fail-open', async () => {
    await town.close();
    fs.unlinkSync(cfg.serverJsonPath);
    // Each event carries ~3 KB of Korean characters in a description (masked, then truncated to 200 chars ~ 600 bytes).
    for (let i = 0; i < 6; i++) {
      await runHook('claude', { session_id: 'b', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `k${i}`, tool_input: { description: '가'.repeat(1000) } });
    }
    const files = spoolFiles();
    expect(files.length).toBe(6);
    const bytes = files.reduce((n, f) => n + fs.statSync(path.join(dir, 'spool', f)).size, 0);
    expect(bytes).toBeLessThan(512 * 1024);
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, 'spool', f), 'utf8');
      expect(Buffer.byteLength(text)).toBeLessThan(2000);
    }
  });
});
