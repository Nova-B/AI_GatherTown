import type { AgentEvent, Provider } from '../src/shared/events.js';
import { normalize, type RawPayload } from '../src/shared/providers/index.js';

let counter = 0;
const BASE = Date.now() - 60 * 60 * 1000;

/** Normalize a raw hook payload the way the server does and assign a seq. */
export function ev(provider: Provider, payload: RawPayload, seq?: number): AgentEvent {
  counter++;
  const out = normalize(provider, payload, {
    eventId: `${provider}:t-${counter}`,
    receivedAt: new Date(BASE + counter * 1000).toISOString(),
    homeDir: 'C:\\Users\\tester',
    source: 'hook',
  });
  if (!out) throw new Error(`normalize returned null for ${JSON.stringify(payload)}`);
  out.ingestSeq = seq ?? counter;
  return out;
}

export function resetCounter(): void {
  counter = 0;
}
