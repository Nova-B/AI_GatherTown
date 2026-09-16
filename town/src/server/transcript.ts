/**
 * Transcript interrupt watcher (Claude Code only).
 *
 * Esc fires no hook. The only immediate trace is a line Claude Code appends
 * to the session transcript within a few seconds:
 *   {"type":"user", ... "content":"[Request interrupted by user for tool use]" ...}
 * (observed 2026-09-16, ~3 s after the interrupted PreToolUse).
 *
 * This watcher follows the transcript files of known Claude sessions and,
 * when such a marker appears while the session's turn is still "running",
 * emits a synthetic `turn.failed` (reason `interrupted`, source
 * `transcript`, evidence `observed`) through the normal store/broadcast path.
 *
 * Boundaries:
 * - Reads only bytes appended after the watcher first saw the file (never
 *   replays history) and only looks for the marker; no prompt, response or
 *   tool text is kept. The path is derived from the session's cwd and id
 *   (`<projects>/<cwd with non-alphanumerics → '-'>/<session>.jsonl`), so
 *   the hook sender forwards nothing new.
 * - The transcript format is not a stable contract: if it changes, this
 *   detector simply finds nothing and the hook-based rules (next
 *   UserPromptSubmit) still close the turn.
 * - One marker per turn; a marker older than the turn start is ignored.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ownValues } from '../shared/dict.js';
import type { AgentEvent } from '../shared/events.js';
import { MAIN_AGENT_ID } from '../shared/events.js';
import type { SessionState, TownState, TurnState } from '../shared/state.js';

export const INTERRUPT_MARKER = '[Request interrupted by user';
const MAX_READ_PER_TICK = 1024 * 1024;
const FOLLOW_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_FOLLOWED = 32;
const MARKER_SKEW_MS = 5000;

/** Claude Code's project directory name for a working directory. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Expand the `~` the hook sender put in place of the home directory. */
export function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) return homeDir + p.slice(1);
  return p;
}

export function transcriptPathFor(
  projectsDir: string,
  homeDir: string,
  cwdMasked: string | null,
  sessionId: string,
): string | null {
  if (!cwdMasked || !sessionId || /[\\/]/.test(sessionId) || sessionId.includes('..')) return null;
  const cwd = expandHome(cwdMasked, homeDir);
  return path.join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

export interface MarkerHit {
  timestamp: string | null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

/** Interrupt markers among transcript lines (JSONL). Only `type: "user"` lines count. */
export function findInterruptMarkers(lines: string[]): MarkerHit[] {
  const hits: MarkerHit[] = [];
  for (const raw of lines) {
    if (!raw.includes(INTERRUPT_MARKER)) continue;
    let obj: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
    if (!obj || obj.type !== 'user') continue;
    const message = obj.message as { content?: unknown } | undefined;
    const text = textOf(message?.content ?? obj.content);
    if (!text.includes(INTERRUPT_MARKER)) continue;
    hits.push({ timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null });
  }
  return hits;
}

export interface TranscriptWatchStats {
  enabled: boolean;
  watching: number;
  markers: number;
  lastMarkerAt: string | null;
  lastError: string | null;
}

interface Followed {
  path: string;
  offset: number;
  rest: Buffer;
  emittedForTurn: string | null;
}

export interface TranscriptWatcherOptions {
  projectsDir: string;
  homeDir: string;
  state: TownState;
  emit(ev: AgentEvent): void;
  intervalMs?: number;
  now?: () => Date;
}

export class TranscriptWatcher {
  readonly stats: TranscriptWatchStats = { enabled: true, watching: 0, markers: 0, lastMarkerAt: null, lastError: null };
  private files = new Map<string, Followed>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly opts: TranscriptWatcherOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.stats.lastError = err instanceof Error ? err.message : String(err);
      }
    }, this.opts.intervalMs ?? 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One polling pass; public so tests can drive it deterministically. */
  tick(): void {
    const now = this.now();
    const nowMs = now.getTime();
    let watching = 0;
    const seen = new Set<string>();
    const candidates = ownValues(this.opts.state.sessions)
      .filter((s) => s.provider === 'claude' && s.lifecycle !== 'ended' && !!s.cwd)
      .filter((s) => nowMs - (Date.parse(s.lastEventAt) || 0) <= FOLLOW_WINDOW_MS)
      .sort((a, b) => (Date.parse(b.lastEventAt) || 0) - (Date.parse(a.lastEventAt) || 0))
      .slice(0, MAX_FOLLOWED);
    for (const s of candidates) {
      seen.add(s.key);
      const p = transcriptPathFor(this.opts.projectsDir, this.opts.homeDir, s.cwd, s.sessionId);
      if (!p) continue;
      let size: number;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue; // transcript not written yet (or not this machine)
      }
      let f = this.files.get(s.key);
      if (!f || f.path !== p) {
        // First sight: start at the end so history is never replayed.
        f = { path: p, offset: size, rest: Buffer.alloc(0), emittedForTurn: null };
        this.files.set(s.key, f);
        watching++;
        continue;
      }
      watching++;
      if (size < f.offset) {
        f.offset = size; // truncated or replaced: resync at the new end
        f.rest = Buffer.alloc(0);
        continue;
      }
      if (size === f.offset) continue;
      const toRead = Math.min(size - f.offset, MAX_READ_PER_TICK);
      const chunk = readRange(p, f.offset, toRead);
      f.offset += chunk.length;
      const buf = f.rest.length ? Buffer.concat([f.rest, chunk]) : chunk;
      const cut = buf.lastIndexOf(10); // '\n'
      if (cut < 0) {
        f.rest = buf;
        continue;
      }
      const lines = buf.subarray(0, cut).toString('utf8').split('\n');
      f.rest = Buffer.from(buf.subarray(cut + 1));
      const hits = findInterruptMarkers(lines);
      if (hits.length === 0) continue;
      this.consider(s, f, hits, now);
    }
    for (const key of [...this.files.keys()]) if (!seen.has(key)) this.files.delete(key);
    this.stats.watching = watching;
  }

  private consider(s: SessionState, f: Followed, hits: MarkerHit[], now: Date): void {
    const turn: TurnState | null = s.currentTurn;
    // Markers read while no turn is running belong to something already closed
    // (or never observed): nothing to interrupt, nothing is invented.
    if (!turn || turn.status !== 'running') return;
    const turnKey = turn.turnId ?? `@${turn.startedAt}`;
    if (f.emittedForTurn === turnKey) return;
    const turnStart = Date.parse(turn.startedAt);
    const hit = hits.find((h) => !h.timestamp || !Number.isFinite(turnStart) || Date.parse(h.timestamp) >= turnStart - MARKER_SKEW_MS);
    if (!hit) return;
    f.emittedForTurn = turnKey;
    this.stats.markers++;
    this.stats.lastMarkerAt = now.toISOString();
    this.opts.emit(interruptEvent(s, turn, hit, now));
  }
}

function readRange(p: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return n === length ? buf : buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function interruptEvent(s: SessionState, turn: TurnState, hit: MarkerHit, now: Date): AgentEvent {
  const stamp = hit.timestamp ?? now.toISOString();
  return {
    schemaVersion: 1,
    eventId: `transcript:${s.sessionId}:${turn.turnId ?? turn.startedAt}:${stamp}`,
    provider: 'claude',
    source: 'transcript',
    hookEventName: 'TranscriptInterrupt',
    sessionId: s.sessionId,
    turnId: turn.turnId,
    agentId: MAIN_AGENT_ID,
    agentIdOrigin: 'internal-main',
    parentAgentId: null,
    toolCallId: null,
    kind: 'turn.failed',
    evidence: 'observed',
    cwd: s.cwd,
    occurredAt: hit.timestamp,
    receivedAt: now.toISOString(),
    ingestSeq: 0,
    payload: { reason: 'interrupted', hookEventName: 'TranscriptInterrupt', note: '트랜스크립트의 사용자 중단 표시' },
  };
}
