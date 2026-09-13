import type { AgentEvent, Provider } from './events.js';
import type { TownState } from './state.js';

/** Messages from server to browser over the WebSocket. */
export type ServerMessage =
  | { type: 'hello'; serverTime: string; version: string; retention: RetentionInfo }
  | { type: 'snapshot'; state: TownState; recentEvents: AgentEvent[]; seq: number }
  | { type: 'event'; event: AgentEvent }
  | { type: 'diagnostics'; diagnostics: Diagnostics }
  | { type: 'error'; message: string };

/** Messages from browser to server. */
export type ClientMessage =
  | { type: 'auth'; sessionToken: string }
  | { type: 'resync'; since: number }
  | { type: 'ping' };

export interface RetentionInfo {
  maxAgeDays: number;
  maxEvents: number;
  maxBytes: number;
}

export interface ProviderDiagnostics {
  provider: Provider;
  lastEventAt: string | null;
  eventsReceived: number;
  rejected: number;
  lastHookEventName: string | null;
  lastError: string | null;
}

export interface Diagnostics {
  serverStartedAt: string;
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  storedEvents: number;
  /** Events at or below this seq have been retained away (no replay). */
  historyFromSeq: number;
  /** Sessions removed by retention together with their history. */
  prunedSessions: number;
  ingestTokenFile: string;
  providers: Record<Provider, ProviderDiagnostics>;
  spool: { available: boolean };
}

export interface BootstrapResponse {
  ok: true;
  version: string;
  wsPath: string;
}
