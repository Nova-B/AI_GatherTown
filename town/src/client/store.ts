/**
 * Client store: live state (server-fed), an optional frozen/replay view, and
 * an isolated DEMO state. Components subscribe through useSyncExternalStore
 * with a version counter; the state objects themselves are mutated in place
 * by the shared reducer for speed.
 */
import { useSyncExternalStore } from 'react';

import { getOwn } from '../shared/dict.js';
import type { AgentEvent, Provider } from '../shared/events.js';
import { sessionKey } from '../shared/events.js';
import type { Diagnostics, RetentionInfo } from '../shared/protocol.js';
import { applyEvent, cloneState, createInitialState, type TownState, type TurnState, upgradeState } from '../shared/state.js';

/** Fired when a live (hook) event ends a session's running turn. */
export type TurnEndListener = (info: { sessionKey: string; status: Exclude<TurnState['status'], 'running'> }) => void;

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type ViewMode = 'live' | 'paused' | 'replay' | 'demo';

export interface TimelineFilters {
  providers: Record<Provider, boolean>;
  kinds: {
    tool: boolean;
    agent: boolean;
    approval: boolean;
    error: boolean;
    session: boolean;
  };
}

export interface Selection {
  sessionKey: string | null;
  agentId: string | null;
}

export interface StoreState {
  connection: ConnectionStatus;
  connectionDetail: string;
  serverVersion: string | null;
  retention: RetentionInfo | null;
  diagnostics: Diagnostics | null;
  live: TownState;
  /** Events known to the client for the live view (bounded window). */
  liveEvents: AgentEvent[];
  liveTruncated: boolean;
  mode: ViewMode;
  /** Frozen copy used while paused. */
  pausedView: TownState | null;
  /** Replay window (fetched from the server), its base state and cursor. */
  replayBase: TownState | null;
  replayEvents: AgentEvent[];
  replayTruncated: boolean;
  replayCursor: number;
  replayView: TownState | null;
  demo: TownState;
  demoEvents: AgentEvent[];
  demoPlaying: boolean;
  selection: Selection;
  filters: TimelineFilters;
  reduceMotion: boolean;
  /** Play a chime when a session's turn ends (live events only, never DEMO/replay). */
  soundEnabled: boolean;
  /** Camera focus request consumed by the scene. */
  focusRequest: { sessionKey: string; agentId: string | null; nonce: number } | null;
  cameraRequest: { kind: 'reset' | 'zoomIn' | 'zoomOut'; nonce: number } | null;
}

const MAX_LIVE_EVENTS = 3000;
const MAX_DEMO_EVENTS = 2000;

type Listener = () => void;

class TownStore {
  state: StoreState;
  private version = 0;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = {
      connection: 'connecting',
      connectionDetail: '서버 연결 시도 중',
      serverVersion: null,
      retention: null,
      diagnostics: null,
      live: createInitialState(),
      liveEvents: [],
      liveTruncated: false,
      mode: 'live',
      pausedView: null,
      replayBase: null,
      replayEvents: [],
      replayTruncated: false,
      replayCursor: 0,
      replayView: null,
      demo: createInitialState(),
      demoEvents: [],
      demoPlaying: false,
      selection: { sessionKey: null, agentId: null },
      filters: {
        providers: { claude: true, codex: true },
        kinds: { tool: true, agent: true, approval: true, error: true, session: true },
      },
      reduceMotion: false,
      soundEnabled: true,
      focusRequest: null,
      cameraRequest: null,
    };
  }

  private turnEndListeners = new Set<TurnEndListener>();

  /** Subscribe to live turn endings (used for the completion chime). */
  onTurnEnd(l: TurnEndListener): () => void {
    this.turnEndListeners.add(l);
    return () => this.turnEndListeners.delete(l);
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  patch(p: Partial<StoreState>): void {
    Object.assign(this.state, p);
    this.emit();
  }

  // ---- connection -----------------------------------------------------------
  setConnection(status: ConnectionStatus, detail: string): void {
    this.patch({ connection: status, connectionDetail: detail });
  }

  applySnapshot(state: TownState, recentEvents: AgentEvent[]): void {
    this.state.live = upgradeState(state);
    this.state.liveEvents = recentEvents.slice(-MAX_LIVE_EVENTS);
    this.state.liveTruncated = recentEvents.length > 0 && recentEvents[0]!.ingestSeq > 1;
    this.emit();
  }

  applyLiveEvent(ev: AgentEvent): void {
    if (ev.ingestSeq <= this.state.live.lastSeq) return; // duplicate delivery
    const key = sessionKey(ev.provider, ev.sessionId);
    const before = getOwn(this.state.live.sessions, key)?.currentTurn;
    const wasRunning = before?.status === 'running';
    const beforeStart = before?.startedAt ?? null;
    applyEvent(this.state.live, ev);
    const after = getOwn(this.state.live.sessions, key)?.currentTurn;
    // A running turn that is now ended (and was not replaced by a newer turn) = the session finished its work.
    if (wasRunning && after && after.startedAt === beforeStart && after.status !== 'running' && ev.source !== 'demo') {
      for (const l of this.turnEndListeners) l({ sessionKey: key, status: after.status });
    }
    this.state.liveEvents.push(ev);
    if (this.state.liveEvents.length > MAX_LIVE_EVENTS) {
      this.state.liveEvents.splice(0, this.state.liveEvents.length - MAX_LIVE_EVENTS);
      this.state.liveTruncated = true;
    }
    this.emit();
  }

  // ---- view modes -----------------------------------------------------------
  /** The state currently shown in the office and panels. */
  viewState(): TownState {
    const s = this.state;
    switch (s.mode) {
      case 'paused':
        return s.pausedView ?? s.live;
      case 'replay':
        return s.replayView ?? s.live;
      case 'demo':
        return s.demo;
      default:
        return s.live;
    }
  }

  viewEvents(): AgentEvent[] {
    const s = this.state;
    switch (s.mode) {
      case 'replay':
        return s.replayEvents.slice(0, s.replayCursor);
      case 'demo':
        return s.demoEvents;
      case 'paused':
        return s.liveEvents.filter((e) => e.ingestSeq <= (s.pausedView?.lastSeq ?? Infinity));
      default:
        return s.liveEvents;
    }
  }

  pause(): void {
    if (this.state.mode === 'demo') return;
    this.patch({ mode: 'paused', pausedView: cloneState(this.state.live) });
  }

  resumeLive(): void {
    this.patch({ mode: 'live', pausedView: null, replayView: null });
  }

  enterReplay(baseState: TownState, events: AgentEvent[], truncated: boolean): void {
    const cursor = events.length;
    this.state.replayBase = upgradeState(baseState);
    this.state.replayEvents = events;
    this.state.replayTruncated = truncated;
    this.state.replayCursor = cursor;
    this.state.replayView = reduceTo(baseState, events, cursor);
    this.state.mode = 'replay';
    this.emit();
  }

  setReplayCursor(cursor: number): void {
    const c = Math.max(0, Math.min(this.state.replayEvents.length, cursor));
    this.state.replayCursor = c;
    this.state.replayView = reduceTo(this.state.replayBase, this.state.replayEvents, c);
    this.emit();
  }

  // ---- demo -----------------------------------------------------------------
  startDemo(): void {
    this.state.demo = createInitialState();
    this.state.demoEvents = [];
    this.state.demoPlaying = true;
    this.state.mode = 'demo';
    this.state.selection = { sessionKey: null, agentId: null };
    this.emit();
  }

  applyDemoEvent(ev: AgentEvent): void {
    applyEvent(this.state.demo, ev);
    this.state.demoEvents.push(ev);
    if (this.state.demoEvents.length > MAX_DEMO_EVENTS) this.state.demoEvents.shift();
    this.emit();
  }

  demoFinished(): void {
    this.patch({ demoPlaying: false });
  }

  stopDemo(): void {
    this.state.demoPlaying = false;
    this.state.mode = 'live';
    this.state.demo = createInitialState();
    this.state.demoEvents = [];
    this.state.selection = { sessionKey: null, agentId: null };
    this.emit();
  }

  // ---- selection / filters ----------------------------------------------------
  select(sessionKey: string | null, agentId: string | null): void {
    this.patch({ selection: { sessionKey, agentId } });
  }

  focus(sessionKey: string, agentId: string | null): void {
    this.patch({
      selection: { sessionKey, agentId },
      focusRequest: { sessionKey, agentId, nonce: Date.now() },
    });
  }

  camera(kind: 'reset' | 'zoomIn' | 'zoomOut'): void {
    this.patch({ cameraRequest: { kind, nonce: Date.now() } });
  }

  toggleProvider(p: Provider): void {
    const providers = { ...this.state.filters.providers, [p]: !this.state.filters.providers[p] };
    this.patch({ filters: { ...this.state.filters, providers } });
  }

  toggleKind(k: keyof TimelineFilters['kinds']): void {
    const kinds = { ...this.state.filters.kinds, [k]: !this.state.filters.kinds[k] };
    this.patch({ filters: { ...this.state.filters, kinds } });
  }

  setReduceMotion(v: boolean): void {
    this.patch({ reduceMotion: v });
  }

  setSoundEnabled(v: boolean): void {
    this.patch({ soundEnabled: v });
  }
}

/** Reduce `events[0..cursor)` on top of a copy of `base` (the state before them). */
export function reduceTo(base: TownState | null, events: AgentEvent[], cursor: number): TownState {
  const state = base ? cloneState(base) : createInitialState();
  for (let i = 0; i < cursor && i < events.length; i++) applyEvent(state, events[i]!);
  return state;
}

export const store = new TownStore();

export function useStore(): StoreState {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store.state;
}

export function useVersion(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
}
