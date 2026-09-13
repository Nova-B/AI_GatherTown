/**
 * Redaction helpers shared by the server ingest path and tests. The hook
 * sender (hook/agent-town-hook.mjs) carries an identical plain-JS copy of
 * SECRET_PATTERNS; test/redact.test.ts checks both behave the same.
 *
 * Order matters: redaction always runs BEFORE truncation so a cut-off value
 * can never leak a prefix of a credential.
 */

const REDACTED = '[REDACTED]';

/** [pattern, replacement]. `$1` keeps a label so the text stays readable. */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Full HTTP Authorization / Proxy-Authorization header values (any scheme).
  [/\b((?:proxy-)?authorization)\s*[:=]\s*["']?\s*(?:bearer|basic|token|digest|negotiate|apikey|api-key)?\s*[^\s"',;]{4,}/gi, `$1: ${REDACTED}`],
  // Bare scheme + credential.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Well-known key formats.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED], // JWT
  // JSON / YAML quoted key: "value".
  [/(["'](?:[a-z0-9_-]*(?:token|api[_-]?key|secret|password|passwd|pwd|credential|authorization)[a-z0-9_-]*)["']\s*[:=]\s*)["'][^"']{4,}["']/gi, `$1"${REDACTED}"`],
  // key=value / key: value.
  [/\b([a-z0-9_-]*(?:token|api[_-]?key|secret|password|passwd|pwd|credential)[a-z0-9_-]*)\s*[:=]\s*["']?[^\s"',;]{4,}/gi, `$1=${REDACTED}`],
  // CLI flags: --token VALUE, --password=VALUE, -p VALUE is too ambiguous and left alone.
  [/(--?(?:[a-z-]*(?:token|api-?key|secret|password|passwd|credential)[a-z-]*))(\s+|=)["']?[^\s"']{4,}/gi, `$1$2${REDACTED}`],
  // Basic-auth URLs: scheme://user:pass@host
  [/((?:https?|ftp|redis|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Replace the user's home directory (and common Windows/Unix variants) with ~. */
export function maskHome(text: string, homeDir: string | null): string {
  if (!homeDir) return text;
  const variants = new Set<string>();
  variants.add(homeDir);
  variants.add(homeDir.replace(/\\/g, '/'));
  variants.add(homeDir.replace(/\//g, '\\'));
  let out = text;
  for (const v of variants) {
    if (!v || v.length < 3) continue;
    const escaped = v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '~');
  }
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Mask secrets and home, then bound. Never truncates before masking. */
export function mask(text: string, homeDir: string | null): string {
  return maskHome(redactSecrets(text), homeDir);
}

/** One-line, masked, bounded string suitable for storage and display. */
export function sanitizeText(
  value: unknown,
  max: number,
  homeDir: string | null,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return truncate(mask(oneLine, homeDir), max);
}

/** Masked basename with a short parent hint for readability. */
export function shortPath(value: string, homeDir: string | null): string {
  const masked = mask(value, homeDir).replace(/\\/g, '/');
  const parts = masked.split('/').filter(Boolean);
  if (parts.length <= 2) return masked;
  return `…/${parts.slice(-2).join('/')}`;
}
