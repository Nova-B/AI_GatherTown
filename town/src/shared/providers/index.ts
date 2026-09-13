import type { AgentEvent, Provider } from '../events.js';
import { normalizeClaude } from './claude.js';
import { normalizeCodex } from './codex.js';
import type { NormalizeContext, RawPayload } from './common.js';

export type { NormalizeContext, RawPayload } from './common.js';
export { CLAUDE_HOOK_EVENTS } from './claude.js';
export { CODEX_HOOK_EVENTS } from './codex.js';

export function normalize(
  provider: Provider,
  raw: RawPayload,
  ctx: NormalizeContext,
): AgentEvent | null {
  switch (provider) {
    case 'claude':
      return normalizeClaude(raw, ctx);
    case 'codex':
      return normalizeCodex(raw, ctx);
    default:
      return null;
  }
}

export function isProvider(v: unknown): v is Provider {
  return v === 'claude' || v === 'codex';
}
