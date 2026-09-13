/**
 * Ingest pipeline: validate the delivery envelope, normalize through the
 * provider, and hand the sanitized canonical event to the store.
 *
 * Bounds: the HTTP layer caps the body; here every id is length-capped and the
 * raw payload is only read through the provider allowlists. Nothing from the
 * raw payload is stored verbatim except ids, tool names and short masked
 * summaries.
 */
import type { AgentEvent, Provider } from '../shared/events.js';
import { isProvider, normalize, type RawPayload } from '../shared/providers/index.js';

export const MAX_BATCH = 100;
export const MAX_EVENT_ID = 80;

export interface Envelope {
  eventId: string;
  provider: Provider;
  sentAt?: string;
  payload: RawPayload;
}

export type IngestResult =
  | { ok: true; event: AgentEvent | null; duplicate: boolean; ignored: boolean }
  | { ok: false; error: string };

export function parseEnvelopes(body: unknown): { envelopes: Envelope[] } | { error: string } {
  const list: unknown[] = Array.isArray((body as { events?: unknown })?.events)
    ? ((body as { events: unknown[] }).events)
    : [body];
  if (list.length === 0) return { error: 'empty batch' };
  if (list.length > MAX_BATCH) return { error: `batch larger than ${MAX_BATCH}` };
  const envelopes: Envelope[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'envelope must be an object' };
    }
    const e = item as Record<string, unknown>;
    const eventId = e.eventId;
    if (typeof eventId !== 'string' || !eventId || eventId.length > MAX_EVENT_ID) {
      return { error: 'invalid eventId' };
    }
    if (!/^[A-Za-z0-9_.:-]+$/.test(eventId)) return { error: 'invalid eventId characters' };
    if (!isProvider(e.provider)) return { error: 'unknown provider' };
    const payload = e.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { error: 'payload must be an object' };
    }
    const env: Envelope = { eventId, provider: e.provider, payload: payload as RawPayload };
    if (typeof e.sentAt === 'string' && e.sentAt.length <= 40) env.sentAt = e.sentAt;
    envelopes.push(env);
  }
  return { envelopes };
}

export interface IngestDeps {
  homeDir: string;
  insert(ev: AgentEvent): AgentEvent | null;
  onStored(ev: AgentEvent): void;
  now(): Date;
}

export function ingestEnvelope(env: Envelope, deps: IngestDeps): IngestResult {
  const receivedAt = deps.now().toISOString();
  const normalized = normalize(env.provider, env.payload, {
    eventId: `${env.provider}:${env.eventId}`,
    receivedAt,
    homeDir: deps.homeDir,
    source: 'hook',
  });
  if (!normalized) {
    // Missing session_id / hook_event_name: cannot attribute; ignore but count.
    return { ok: true, event: null, duplicate: false, ignored: true };
  }
  const stored = deps.insert(normalized);
  if (!stored) return { ok: true, event: null, duplicate: true, ignored: false };
  deps.onStored(stored);
  return { ok: true, event: stored, duplicate: false, ignored: false };
}
