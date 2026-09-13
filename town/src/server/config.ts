import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RetentionInfo } from '../shared/protocol.js';

export const APP_VERSION = '0.1.0';
export const DEFAULT_PORT = 4317;

export interface ServerConfig {
  host: string;
  /** Requested port; the actual listening port may differ when auto-selected. */
  port: number;
  portExplicit: boolean;
  dataDir: string;
  dbPath: string;
  serverJsonPath: string;
  ingestTokenPath: string;
  ingestToken: string;
  homeDir: string;
  clientDir: string | null;
  devMode: boolean;
  retention: RetentionInfo;
  /** Extra browser origins allowed for WS/API (dev proxy). */
  extraOrigins: string[];
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultDataDir(): string {
  return process.env.AGENT_TOWN_DATA_DIR || path.join(os.homedir(), '.agent-town');
}

function loadOrCreateIngestToken(tokenPath: string): string {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[a-f0-9]{48,}$/.test(existing)) return existing;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const ingestTokenPath = path.join(dataDir, 'ingest-token');
  const ingestToken = overrides.ingestToken ?? loadOrCreateIngestToken(ingestTokenPath);
  const portEnv = process.env.AGENT_TOWN_PORT;
  const port = overrides.port ?? (portEnv ? Number(portEnv) : DEFAULT_PORT);
  const clientDirCandidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'client',
  );
  const clientDir =
    overrides.clientDir !== undefined
      ? overrides.clientDir
      : fs.existsSync(path.join(clientDirCandidate, 'index.html'))
        ? clientDirCandidate
        : null;
  const extra = (process.env.AGENT_TOWN_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    host: overrides.host ?? process.env.AGENT_TOWN_HOST ?? '127.0.0.1',
    port: Number.isFinite(port) && port >= 0 ? port : DEFAULT_PORT,
    portExplicit: overrides.portExplicit ?? !!portEnv,
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'events.sqlite'),
    serverJsonPath: path.join(dataDir, 'server.json'),
    ingestTokenPath,
    ingestToken,
    homeDir: overrides.homeDir ?? os.homedir(),
    clientDir,
    devMode: overrides.devMode ?? process.env.AGENT_TOWN_DEV === '1',
    retention: overrides.retention ?? {
      maxAgeDays: intEnv('AGENT_TOWN_RETENTION_DAYS', 7),
      maxEvents: intEnv('AGENT_TOWN_RETENTION_EVENTS', 200_000),
      maxBytes: intEnv('AGENT_TOWN_RETENTION_MB', 250) * 1024 * 1024,
    },
    extraOrigins: overrides.extraOrigins ?? extra,
  };
}

/** Written for the hook sender: where to POST and which token to use. */
export interface ServerJson {
  version: string;
  host: string;
  port: number;
  ingestToken: string;
  pid: number;
  startedAt: string;
}

export function writeServerJson(cfg: ServerConfig, port: number): void {
  const data: ServerJson = {
    version: APP_VERSION,
    host: cfg.host,
    port,
    ingestToken: cfg.ingestToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const tmp = `${cfg.serverJsonPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cfg.serverJsonPath);
}

export function removeServerJson(cfg: ServerConfig): void {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.serverJsonPath, 'utf8')) as Partial<ServerJson>;
    if (raw.pid === process.pid) fs.unlinkSync(cfg.serverJsonPath);
  } catch {
    /* ignore */
  }
}
