/**
 * Same-origin bootstrap + reconnecting WebSocket.
 *
 * The browser session token is fetched from GET /api/bootstrap (JSON body,
 * same-origin only) and sent as the FIRST WebSocket message. It never appears
 * in a URL, so it cannot leak into access logs or browser history.
 */
import type { AgentEvent } from '../shared/events.js';
import type { ServerMessage } from '../shared/protocol.js';
import type { RetrospectMetrics, RetrospectScope } from '../shared/retrospect.js';
import type { TownState } from '../shared/state.js';
import { store } from './store.js';

let sessionToken: string | null = null;
let ws: WebSocket | null = null;
let attempt = 0;
let closedByUser = false;
let retryTimer: number | null = null;

async function bootstrap(): Promise<string> {
  const res = await fetch('/api/bootstrap', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`bootstrap failed (${res.status})`);
  const body = (await res.json()) as { sessionToken?: string; version?: string };
  if (!body.sessionToken) throw new Error('bootstrap: no session token');
  store.patch({ serverVersion: body.version ?? null });
  return body.sessionToken;
}

export async function apiGet<T>(path: string): Promise<T> {
  if (!sessionToken) sessionToken = await bootstrap();
  const res = await fetch(path, {
    headers: { 'X-Agent-Town-Session': sessionToken, Accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    sessionToken = await bootstrap();
    return apiGet(path);
  }
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return (await res.json()) as T;
}

export interface ReplayWindow {
  baseState: TownState;
  events: AgentEvent[];
  truncated: boolean;
  historyFromSeq: number;
}

/** Last N events plus the state just before them (correct even after retention). */
export async function fetchReplayWindow(): Promise<ReplayWindow> {
  return apiGet<ReplayWindow>('/api/replay?limit=5000');
}

export interface RetrospectResponse {
  markdown: string;
  metrics: RetrospectMetrics;
  fromSeq: number;
  toSeq: number;
  eventCount: number;
  truncated: boolean;
  historyFromSeq: number;
}

/** Retrospective material for one session, built server-side from stored events only. */
export async function fetchRetrospect(
  sessionKey: string,
  opts: { scope: RetrospectScope; toSeq: number | null },
): Promise<RetrospectResponse> {
  const q = new URLSearchParams({ session: sessionKey, scope: opts.scope });
  if (opts.toSeq !== null) q.set('to', String(opts.toSeq));
  return apiGet<RetrospectResponse>(`/api/retrospect?${q.toString()}`);
}

function scheduleReconnect(): void {
  if (closedByUser) return;
  attempt++;
  const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
  store.setConnection('reconnecting', `재연결 대기 (${Math.round(delay / 1000)}초)`);
  if (retryTimer) window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => void connect(), delay);
}

export async function connect(): Promise<void> {
  closedByUser = false;
  try {
    store.setConnection(attempt === 0 ? 'connecting' : 'reconnecting', '서버 세션 준비 중');
    sessionToken = await bootstrap();
  } catch (err) {
    store.setConnection('reconnecting', `서버 응답 없음: ${(err as Error).message}`);
    scheduleReconnect();
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'auth', sessionToken }));
  };
  socket.onmessage = (e) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(e.data)) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        attempt = 0;
        store.patch({
          connection: 'open',
          connectionDetail: '실시간 수신 중',
          serverVersion: msg.version,
          retention: msg.retention,
        });
        break;
      case 'snapshot':
        store.applySnapshot(msg.state, msg.recentEvents);
        break;
      case 'event':
        store.applyLiveEvent(msg.event);
        break;
      case 'diagnostics':
        store.patch({ diagnostics: msg.diagnostics });
        break;
      case 'error':
        store.setConnection('open', msg.message);
        break;
    }
  };
  socket.onclose = (e) => {
    if (ws === socket) ws = null;
    if (closedByUser) {
      store.setConnection('closed', '연결 종료');
      return;
    }
    store.setConnection('reconnecting', `연결 끊김 (${e.code})`);
    scheduleReconnect();
  };
  socket.onerror = () => {
    /* onclose follows */
  };
}

export function disconnect(): void {
  closedByUser = true;
  if (retryTimer) window.clearTimeout(retryTimer);
  ws?.close();
}

export function requestResync(): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resync', since: 0 }));
}

export function pingDiagnostics(): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
}
