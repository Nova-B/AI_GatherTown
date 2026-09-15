/**
 * Local HTTP + WebSocket server.
 *
 * Security model (loopback-only observer):
 * - Binds 127.0.0.1 by default. Every request must carry a Host header that
 *   names this loopback server (DNS-rebinding guard).
 * - POST /api/ingest requires `Authorization: Bearer <ingest token>` and must
 *   NOT carry a browser Origin header (hooks are processes, not pages).
 * - Browser API/WS access uses a short-lived session token obtained from the
 *   same-origin GET /api/bootstrap (JSON body, never a URL). The WebSocket
 *   sends it as its first message. Cross-site pages are rejected by Origin /
 *   Sec-Fetch-Site checks before the token is ever issued.
 * - There is no endpoint that executes commands or answers approvals.
 * - Every request and every socket message is wrapped so malformed input
 *   yields a 4xx/5xx or an ignored frame, never a crashed process.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import type { AgentEvent, Provider } from '../shared/events.js';
import type {
  BootstrapResponse,
  ClientMessage,
  Diagnostics,
  ProviderDiagnostics,
  ServerMessage,
} from '../shared/protocol.js';
import { getOwn } from '../shared/dict.js';
import { buildRetrospect, type RetrospectScope } from '../shared/retrospect.js';
import { applyEvent, type TownState } from '../shared/state.js';
import { APP_VERSION, type ServerConfig } from './config.js';
import { ingestEnvelope, parseEnvelopes } from './ingest.js';
import { reconstructState, type RetentionResult, runRetention, stateBefore } from './retention.js';
import type { EventStore } from './store.js';

export { reconstructState } from './retention.js';

const MAX_BODY_BYTES = 256 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_EVENTS_ON_SNAPSHOT = 400;
const MAX_LIST_LIMIT = 5000;
const MAX_URL_LENGTH = 2048;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface TownServer {
  server: http.Server;
  port: number;
  state: TownState;
  diagnostics(): Diagnostics;
  /** Run retention against the store and live state, then resync clients. */
  applyRetention(now?: Date): RetentionResult;
  close(): Promise<void>;
}

interface AuthedSocket {
  ws: WebSocket;
  authed: boolean;
}

function emptyProviderDiag(provider: Provider): ProviderDiagnostics {
  return {
    provider,
    lastEventAt: null,
    eventsReceived: 0,
    rejected: 0,
    lastHookEventName: null,
    lastError: null,
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/** Parse a query integer safely: non-integer, NaN, Infinity or huge -> fallback. */
export function safeInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') return fallback;
  if (!/^-?\d{1,15}$/.test(value)) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Constant-time bearer comparison that never throws on length mismatch. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  const actual = Buffer.from(header, 'utf8');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Resolve a URL path inside `root`. Returns null for traversal, encoded
 * traversal, sibling-prefix escapes, NUL bytes, dotfiles or bad encoding.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/\\/g, '/');
  if (rel.split('/').some((seg) => seg.startsWith('.') && seg !== '')) return null;
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  const rootWithSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (full !== rootAbs && !full.startsWith(rootWithSep)) return null;
  return full;
}

/**
 * Read a request body up to `max` bytes. Oversized bodies are drained (so the
 * client receives a proper 413 instead of a reset) up to a hard ceiling, after
 * which the socket is destroyed.
 */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (overflow) {
        if (size > max * 8) {
          finish(null);
          req.destroy();
        }
        return;
      }
      if (size > max) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(overflow ? null : Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

export async function startServer(cfg: ServerConfig, store: EventStore): Promise<TownServer> {
  const state = reconstructState(store);
  const startedAt = new Date().toISOString();
  const providerDiag: Record<Provider, ProviderDiagnostics> = {
    claude: emptyProviderDiag('claude'),
    codex: emptyProviderDiag('codex'),
  };
  const sessions = new Map<string, number>(); // browser session token -> expiry
  const sockets = new Set<AuthedSocket>();
  let listeningPort = cfg.port;

  const allowedHosts = (): Set<string> => {
    const p = listeningPort;
    return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, `${cfg.host}:${p}`]);
  };

  const allowedOrigins = (): Set<string> => {
    const set = new Set<string>();
    for (const h of allowedHosts()) set.add(`http://${h}`);
    for (const o of cfg.extraOrigins) set.add(o);
    return set;
  };

  const isDevLoopbackOrigin = (origin: string): boolean => {
    if (!cfg.devMode) return false;
    try {
      const u = new URL(origin);
      return (
        u.protocol === 'http:' &&
        (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
      );
    } catch {
      return false;
    }
  };

  const hostOk = (req: http.IncomingMessage): boolean => {
    const host = req.headers.host;
    return typeof host === 'string' && allowedHosts().has(host.toLowerCase());
  };

  const browserOriginOk = (req: http.IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      return allowedOrigins().has(origin) || isDevLoopbackOrigin(origin);
    }
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
    return true;
  };

  const pruneBrowserSessions = (): void => {
    const now = Date.now();
    for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
  };

  const browserAuthOk = (req: http.IncomingMessage): boolean => {
    pruneBrowserSessions();
    const token = req.headers['x-agent-town-session'];
    return typeof token === 'string' && sessions.has(token);
  };

  const diagnostics = (): Diagnostics => ({
    serverStartedAt: startedAt,
    port: listeningPort,
    host: cfg.host,
    dataDir: cfg.dataDir,
    dbPath: cfg.dbPath,
    storedEvents: store.count(),
    historyFromSeq: state.historyFromSeq,
    prunedSessions: state.prunedSessions,
    ingestTokenFile: cfg.ingestTokenPath,
    providers: providerDiag,
    spool: { available: true },
  });

  const send = (s: AuthedSocket, msg: ServerMessage): void => {
    if (s.ws.readyState !== WebSocket.OPEN) return;
    try {
      s.ws.send(JSON.stringify(msg));
    } catch {
      /* socket may be closing */
    }
  };

  const broadcast = (msg: ServerMessage): void => {
    for (const s of sockets) if (s.authed) send(s, msg);
  };

  const sendSnapshot = (s: AuthedSocket): void => {
    send(s, {
      type: 'snapshot',
      state,
      recentEvents: store.recent(RECENT_EVENTS_ON_SNAPSHOT),
      seq: state.lastSeq,
    });
    send(s, { type: 'diagnostics', diagnostics: diagnostics() });
  };

  const onStored = (ev: AgentEvent): void => {
    applyEvent(state, ev);
    const d = providerDiag[ev.provider];
    d.eventsReceived++;
    d.lastEventAt = ev.receivedAt;
    d.lastHookEventName = ev.hookEventName;
    broadcast({ type: 'event', event: ev });
  };

  const applyRetention = (now = new Date()): RetentionResult => {
    const result = runRetention(store, state, cfg.retention, now);
    if (result.deletedEvents > 0 || result.prunedSessions > 0) {
      for (const s of sockets) if (s.authed) sendSnapshot(s);
    }
    return result;
  };

  const serveStatic = (res: http.ServerResponse, urlPath: string): void => {
    if (!cfg.clientDir) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('UI not built. Run `npm run build` in town/ or use `npm run dev`.');
      return;
    }
    let rel = urlPath;
    if (rel === '/' || rel === '') rel = '/index.html';
    let target = resolveStaticPath(cfg.clientDir, rel);
    if (!target) {
      res.writeHead(404);
      res.end();
      return;
    }
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(target);
    } catch {
      stat = null;
    }
    if (!stat || stat.isDirectory()) {
      // SPA fallback for unknown paths without an extension.
      if (path.extname(rel) === '') {
        target = path.join(cfg.clientDir, 'index.html');
        if (!fs.existsSync(target)) {
          res.writeHead(404);
          res.end();
          return;
        }
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    const ext = path.extname(target).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    const immutable = rel.startsWith('/assets/') && ext !== '.html';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=3600' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    const stream = fs.createReadStream(target);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    if (rawUrl.length > MAX_URL_LENGTH) {
      json(res, 414, { error: 'url too long' });
      return;
    }
    if (!hostOk(req)) {
      json(res, 421, { error: 'host not allowed' });
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://local');
    } catch {
      json(res, 400, { error: 'bad url' });
      return;
    }
    const pathname = url.pathname;

    if (pathname === '/api/ingest') {
      if (method !== 'POST') {
        json(res, 405, { error: 'method not allowed' });
        return;
      }
      if (typeof req.headers.origin === 'string') {
        json(res, 403, { error: 'browser origin not accepted on ingest' });
        return;
      }
      if (!bearerMatches(req.headers.authorization, cfg.ingestToken)) {
        json(res, 401, { error: 'invalid ingest token' });
        return;
      }
      const body = await readBody(req, MAX_BODY_BYTES);
      if (!body) {
        json(res, 413, { error: 'body too large or unreadable' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        json(res, 400, { error: 'invalid json' });
        return;
      }
      const envs = parseEnvelopes(parsed);
      if ('error' in envs) {
        json(res, 400, { error: envs.error });
        return;
      }
      let accepted = 0;
      let duplicates = 0;
      let ignored = 0;
      for (const env of envs.envelopes) {
        const result = ingestEnvelope(env, {
          homeDir: cfg.homeDir,
          insert: (ev) => store.insert(ev),
          onStored,
          now: () => new Date(),
        });
        if (!result.ok) {
          providerDiag[env.provider].rejected++;
          providerDiag[env.provider].lastError = result.error;
          continue;
        }
        if (result.duplicate) duplicates++;
        else if (result.ignored) {
          ignored++;
          providerDiag[env.provider].rejected++;
          providerDiag[env.provider].lastError = 'payload without session_id/hook_event_name';
        } else accepted++;
      }
      if (accepted > 0) broadcast({ type: 'diagnostics', diagnostics: diagnostics() });
      json(res, 200, { ok: true, accepted, duplicates, ignored });
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!browserOriginOk(req)) {
        json(res, 403, { error: 'origin not allowed' });
        return;
      }
      if (pathname === '/api/bootstrap') {
        if (method !== 'GET') {
          json(res, 405, { error: 'method not allowed' });
          return;
        }
        pruneBrowserSessions();
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        const body: BootstrapResponse & { sessionToken: string } = {
          ok: true,
          version: APP_VERSION,
          wsPath: '/ws',
          sessionToken: token,
        };
        json(res, 200, body);
        return;
      }
      if (!browserAuthOk(req)) {
        json(res, 401, { error: 'browser session required' });
        return;
      }
      if (pathname === '/api/state') {
        json(res, 200, { state, seq: state.lastSeq });
        return;
      }
      if (pathname === '/api/events') {
        const since = safeInt(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = safeInt(url.searchParams.get('limit'), 2000, 1, MAX_LIST_LIMIT);
        const events = store.list(since, limit);
        json(res, 200, {
          events,
          truncated: events.length === limit,
          lastSeq: store.lastSeq(),
          historyFromSeq: state.historyFromSeq,
        });
        return;
      }
      if (pathname === '/api/replay') {
        // Last `limit` events plus the state just before them, so a client
        // can scrub from a correct base even when older rows were retained away.
        const limit = safeInt(url.searchParams.get('limit'), 2000, 1, MAX_LIST_LIMIT);
        const events = store.recent(limit);
        const firstSeq = events[0]?.ingestSeq ?? store.lastSeq() + 1;
        const baseState = stateBefore(store, firstSeq);
        json(res, 200, {
          baseState,
          baseSeq: firstSeq - 1,
          events,
          truncated: events.length === limit && firstSeq > store.firstSeq(),
          historyFromSeq: state.historyFromSeq,
        });
        return;
      }
      if (pathname === '/api/retrospect') {
        // Retrospective material for one session: Markdown built from the
        // stored events only (no outbound call, no prompts). The user's own
        // notes are added client-side and never reach the server.
        const key = url.searchParams.get('session') ?? '';
        const session = getOwn(state.sessions, key);
        if (!session) {
          json(res, 404, { error: 'unknown session' });
          return;
        }
        if (session.source === 'demo') {
          json(res, 400, { error: 'demo session' });
          return;
        }
        const scopeParam = url.searchParams.get('scope');
        const scope: RetrospectScope = scopeParam === 'last-turn' ? 'last-turn' : 'all';
        const from = safeInt(url.searchParams.get('from'), 0, 0, Number.MAX_SAFE_INTEGER);
        const to = safeInt(url.searchParams.get('to'), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
        const events = store.listSession(session.provider, session.sessionId, from, to, MAX_LIST_LIMIT);
        const result = buildRetrospect(state, events, { sessionKey: key, scope, fromSeq: from, toSeq: to });
        if ('error' in result) {
          json(res, result.error === 'no-events' ? 404 : 400, { error: result.error });
          return;
        }
        json(res, 200, { ...result, truncated: events.length === MAX_LIST_LIMIT, historyFromSeq: state.historyFromSeq });
        return;
      }
      if (pathname === '/api/diagnostics') {
        json(res, 200, diagnostics());
        return;
      }
      json(res, 404, { error: 'not found' });
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    serveStatic(res, pathname);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[agent-town] request failed', err instanceof Error ? err.message : err);
      try {
        json(res, 500, { error: 'internal error' });
      } catch {
        res.destroy();
      }
    });
  });
  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      socket.destroy();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const parseClientMessage = (data: unknown): ClientMessage | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const type = (parsed as { type?: unknown }).type;
    if (type !== 'auth' && type !== 'resync' && type !== 'ping') return null;
    return parsed as ClientMessage;
  };

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = req.url ?? '';
      if (!url.startsWith('/ws') || !hostOk(req) || !browserOriginOk(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const entry: AuthedSocket = { ws, authed: false };
        sockets.add(entry);
        const authTimer = setTimeout(() => {
          if (!entry.authed) ws.close(4001, 'auth timeout');
        }, 5000);
        ws.on('message', (data) => {
          try {
            const msg = parseClientMessage(data);
            if (!msg) return; // ignore malformed frames, keep the socket
            if (!entry.authed) {
              pruneBrowserSessions();
              if (msg.type === 'auth' && typeof msg.sessionToken === 'string' && sessions.has(msg.sessionToken)) {
                entry.authed = true;
                clearTimeout(authTimer);
                send(entry, {
                  type: 'hello',
                  serverTime: new Date().toISOString(),
                  version: APP_VERSION,
                  retention: cfg.retention,
                });
                sendSnapshot(entry);
              } else {
                ws.close(4003, 'unauthorized');
              }
              return;
            }
            if (msg.type === 'resync') sendSnapshot(entry);
            else if (msg.type === 'ping') send(entry, { type: 'diagnostics', diagnostics: diagnostics() });
          } catch (err) {
            console.error('[agent-town] ws message failed', err instanceof Error ? err.message : err);
          }
        });
        ws.on('close', () => {
          clearTimeout(authTimer);
          sockets.delete(entry);
        });
        ws.on('error', () => {
          sockets.delete(entry);
        });
      });
    } catch {
      socket.destroy();
    }
  });

  listeningPort = await listenWithFallback(server, cfg);

  const heartbeat = setInterval(() => {
    for (const s of sockets) {
      if (s.ws.readyState === WebSocket.OPEN) {
        try {
          s.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }
  }, 25_000);

  return {
    server,
    port: listeningPort,
    state,
    diagnostics,
    applyRetention,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const s of sockets) s.ws.close(1001, 'server shutdown');
        wss.close();
        server.close(() => resolve());
        setTimeout(resolve, 1500).unref();
      }),
  };
}

/** Listen on the requested port; if busy and not explicit, try the next ten. */
function listenWithFallback(server: http.Server, cfg: ServerConfig): Promise<number> {
  const tryPort = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, cfg.host);
    });
  const attempt = async (port: number, remaining: number): Promise<number> => {
    try {
      return await tryPort(port);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EADDRINUSE') {
        if (cfg.portExplicit || remaining <= 0) {
          throw new Error(
            `Port ${port} on ${cfg.host} is already in use. Stop the other process or set AGENT_TOWN_PORT.`,
          );
        }
        console.warn(`[agent-town] port ${port} busy, trying ${port + 1}`);
        return attempt(port + 1, remaining - 1);
      }
      throw err;
    }
  };
  return attempt(cfg.port, 10);
}
