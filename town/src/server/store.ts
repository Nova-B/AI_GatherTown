/**
 * SQLite event store (node:sqlite, bundled with Node 22.13+).
 *
 * Only sanitized canonical events are written. `seq` is an AUTOINCREMENT
 * primary key, so it stays monotonic even after retention deletes rows.
 * `event_id` is UNIQUE: a retried delivery with the same id is ignored.
 *
 * The `checkpoint` table holds the reducer state at a given seq. Retention
 * (see retention.ts) advances the checkpoint before deleting events at or
 * below it, so `checkpoint + events after it` always equals the live state.
 */
import { DatabaseSync } from 'node:sqlite';

import type { AgentEvent } from '../shared/events.js';
import { type TownState, upgradeState } from '../shared/state.js';

export interface Checkpoint {
  seq: number;
  state: TownState;
  savedAt: string;
}

export class EventStore {
  private db: DatabaseSync;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        received_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(provider, session_id);
      CREATE TABLE IF NOT EXISTS checkpoint (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        seq INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Insert; returns the event with its ingestSeq, or null when a duplicate. */
  insert(ev: AgentEvent): AgentEvent | null {
    const existing = this.db
      .prepare('SELECT seq FROM events WHERE event_id = ?')
      .get(ev.eventId) as { seq: number } | undefined;
    if (existing) return null;
    const stmt = this.db.prepare(
      `INSERT INTO events (event_id, provider, session_id, agent_id, kind, received_at, json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      ev.eventId,
      ev.provider,
      ev.sessionId,
      ev.agentId,
      ev.kind,
      ev.receivedAt,
      JSON.stringify({ ...ev, ingestSeq: 0 }),
    );
    const seq = Number(result.lastInsertRowid);
    return { ...ev, ingestSeq: seq };
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return row.n;
  }

  lastSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number | null };
    return row.s ?? 0;
  }

  firstSeq(): number {
    const row = this.db.prepare('SELECT MIN(seq) AS s FROM events').get() as { s: number | null };
    return row.s ?? 0;
  }

  private rowsToEvents(rows: Array<{ seq: number; json: string }>): AgentEvent[] {
    return rows.map((row) => {
      const ev = JSON.parse(row.json) as AgentEvent;
      ev.ingestSeq = row.seq;
      return ev;
    });
  }

  /** Events with seq in (sinceSeq, untilSeq], ascending, bounded. */
  list(sinceSeq: number, limit: number, untilSeq = Number.MAX_SAFE_INTEGER): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT seq, json FROM events WHERE seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?')
      .all(sinceSeq, untilSeq, limit) as Array<{ seq: number; json: string }>;
    return this.rowsToEvents(rows);
  }

  /** Iterate all events after sinceSeq in pages (bounded memory). */
  *iterate(sinceSeq = 0, pageSize = 2000): Generator<AgentEvent> {
    let cursor = sinceSeq;
    for (;;) {
      const page = this.list(cursor, pageSize);
      if (page.length === 0) return;
      for (const ev of page) {
        cursor = ev.ingestSeq;
        yield ev;
      }
    }
  }

  /** Most recent N events in ascending seq order. */
  recent(limit: number): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT seq, json FROM events ORDER BY seq DESC LIMIT ?')
      .all(limit) as Array<{ seq: number; json: string }>;
    return this.rowsToEvents(rows.reverse());
  }

  sizeBytes(): number {
    const pc = this.db.prepare('PRAGMA page_count').get() as { page_count: number };
    const ps = this.db.prepare('PRAGMA page_size').get() as { page_size: number };
    return pc.page_count * ps.page_size;
  }

  /** Highest seq whose received_at is older than `iso` (0 if none). */
  maxSeqBefore(iso: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS s FROM events WHERE received_at < ?')
      .get(iso) as { s: number | null };
    return row.s ?? 0;
  }

  /** Seq of the n-th oldest event (1-based); 0 when n <= 0 or beyond the table. */
  seqOfNthOldest(n: number): number {
    if (n <= 0) return 0;
    const row = this.db
      .prepare('SELECT seq FROM events ORDER BY seq ASC LIMIT 1 OFFSET ?')
      .get(n - 1) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  deleteUpTo(seq: number): number {
    return Number(this.db.prepare('DELETE FROM events WHERE seq <= ?').run(seq).changes);
  }

  loadCheckpoint(): Checkpoint | null {
    const row = this.db
      .prepare('SELECT seq, state_json, saved_at FROM checkpoint WHERE id = 1')
      .get() as { seq: number; state_json: string; saved_at: string } | undefined;
    if (!row) return null;
    // Older checkpoints (schema 2) are upgraded in memory; the stored row is
    // left untouched until the next retention pass writes a current one.
    return { seq: row.seq, state: upgradeState(JSON.parse(row.state_json) as TownState), savedAt: row.saved_at };
  }

  saveCheckpoint(seq: number, state: TownState, savedAt = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO checkpoint (id, seq, state_json, saved_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, state_json = excluded.state_json, saved_at = excluded.saved_at`,
      )
      .run(seq, JSON.stringify(state), savedAt);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.close();
  }
}
