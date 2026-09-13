/**
 * Bounded retention with a consistent checkpoint.
 *
 * Invariant: `reconstructState(store)` (checkpoint + events after it) equals
 * the server's live state at all times, including right after retention.
 *
 * Retention picks a `pruneSeq` (age, count and size limits), advances the
 * checkpoint to that seq by replaying the events being discarded on top of
 * the previous checkpoint, prunes sessions whose entire history is being
 * discarded (ended sessions, or sessions silent for longer than the age
 * limit) from BOTH the checkpoint and the live state with the same rule, and
 * only then deletes the rows. History before `historyFromSeq` is marked as
 * unavailable for replay.
 */
import type { RetentionInfo } from '../shared/protocol.js';
import { applyEvent, createInitialState, pruneSessions, type SessionState, type TownState } from '../shared/state.js';
import type { EventStore } from './store.js';

export interface RetentionResult {
  pruneSeq: number;
  deletedEvents: number;
  prunedSessions: number;
}

/** Rebuild the state exactly as the live server holds it. */
export function reconstructState(store: EventStore): TownState {
  const cp = store.loadCheckpoint();
  const state = cp ? cp.state : createInitialState();
  if (cp) state.historyFromSeq = Math.max(state.historyFromSeq, cp.seq);
  for (const ev of store.iterate(cp?.seq ?? 0)) applyEvent(state, ev);
  return state;
}

/** State just before `seq` (checkpoint + events up to seq-1), for replay bases. */
export function stateBefore(store: EventStore, seq: number): TownState {
  const cp = store.loadCheckpoint();
  const state = cp ? cp.state : createInitialState();
  if (cp) state.historyFromSeq = Math.max(state.historyFromSeq, cp.seq);
  const from = cp?.seq ?? 0;
  if (seq - 1 > from) {
    for (const ev of store.list(from, Number.MAX_SAFE_INTEGER, seq - 1)) applyEvent(state, ev);
  }
  return state;
}

function choosePruneSeq(store: EventStore, r: RetentionInfo, now: Date): number {
  const cutoff = new Date(now.getTime() - r.maxAgeDays * 86_400_000).toISOString();
  let pruneSeq = store.maxSeqBefore(cutoff);
  const count = store.count();
  if (count > r.maxEvents) pruneSeq = Math.max(pruneSeq, store.seqOfNthOldest(count - r.maxEvents));
  const size = store.sizeBytes();
  if (size > r.maxBytes && count > 0) {
    // Drop enough of the oldest rows to get ~10% under the limit.
    const fraction = Math.min(1, 1 - r.maxBytes / size + 0.1);
    pruneSeq = Math.max(pruneSeq, store.seqOfNthOldest(Math.ceil(count * fraction)));
  }
  return pruneSeq;
}

/**
 * Apply retention. `live` is mutated to stay equal to what a restart would
 * reconstruct. Returns what happened.
 */
export function runRetention(
  store: EventStore,
  live: TownState,
  r: RetentionInfo,
  now = new Date(),
): RetentionResult {
  const pruneSeq = choosePruneSeq(store, r, now);
  const cp = store.loadCheckpoint();
  const cpSeq = cp?.seq ?? 0;
  if (pruneSeq <= cpSeq) return { pruneSeq: cpSeq, deletedEvents: 0, prunedSessions: 0 };

  const cutoffMs = now.getTime() - r.maxAgeDays * 86_400_000;
  const shouldPrune = (s: SessionState): boolean =>
    s.lastSeq <= pruneSeq && (s.lifecycle === 'ended' || Date.parse(s.lastEventAt) < cutoffMs);

  // Advance the checkpoint to pruneSeq by replaying the rows about to be deleted.
  const next = cp ? cp.state : createInitialState();
  for (const ev of store.list(cpSeq, Number.MAX_SAFE_INTEGER, pruneSeq)) applyEvent(next, ev);
  next.historyFromSeq = pruneSeq;
  const prunedInCheckpoint = pruneSessions(next, shouldPrune);

  const deleted = store.transaction(() => {
    store.saveCheckpoint(pruneSeq, next, now.toISOString());
    return store.deleteUpTo(pruneSeq);
  });
  if (store.sizeBytes() > r.maxBytes) store.vacuum();

  // Same rule on the live state so restart == live.
  live.historyFromSeq = Math.max(live.historyFromSeq, pruneSeq);
  const prunedLive = pruneSessions(live, shouldPrune);
  if (prunedLive !== prunedInCheckpoint) {
    // Should never happen (same rule, same data); recorded for diagnostics.
    console.warn(`[agent-town] retention pruned ${prunedLive} live vs ${prunedInCheckpoint} checkpoint sessions`);
  }
  return { pruneSeq, deletedEvents: deleted, prunedSessions: prunedLive };
}
