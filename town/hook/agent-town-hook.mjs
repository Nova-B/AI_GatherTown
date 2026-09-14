#!/usr/bin/env node
// Agent Town hook sender. Dependency-free (Node built-ins only).
//
// Usage (installed automatically by hook/install.mjs):
//   node agent-town-hook.mjs --provider claude|codex [--data-dir <dir>]
//
// Behaviour contract:
// - Reads one JSON object from stdin (max 1 MiB of bytes), redacts BEFORE
//   sending: prompts, transcripts, tool responses and file contents are
//   dropped; only an allowlist of identity/metadata fields plus bounded,
//   secret-masked summaries are forwarded.
// - POSTs to the running Agent Town server described by <data-dir>/server.json
//   (loopback hosts only; anything else is refused and nothing is sent).
// - Never blocks the CLI: total budget ~1.5 s, then exits 0 regardless.
// - Never writes to stdout (an empty stdout is the neutral response for both
//   Claude Code and Codex: the action proceeds, no context is injected, no
//   permission decision is made). Exit code is always 0. Never prints payloads.
// - Offline: the envelope is spooled as its own file in <data-dir>/spool/
//   (atomic write + rename, so concurrent hooks never clobber each other).
//   Later invocations flush the backlog IN ORDER before their own event, so a
//   spooled PreToolUse is always delivered before the Stop that follows it.
//   The spool is bounded by file count and bytes; the oldest files are dropped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_STDIN_BYTES = 1024 * 1024;
const TOTAL_BUDGET_MS = 1500;
const REQUEST_TIMEOUT_MS = 800;
const SPOOL_MAX_FILES = 400;
const SPOOL_MAX_BYTES = 512 * 1024;
const SPOOL_FLUSH_BATCH = 50;
const CLAIM_STALE_MS = 30_000;

const startedAt = Date.now();
const remaining = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - startedAt));

// Optional diagnostics: AGENT_TOWN_HOOK_LOG=<file> appends one short line per
// step (event names and statuses only, never payload content).
const debugLog = process.env.AGENT_TOWN_HOOK_LOG;
function dbg(line) {
  if (!debugLog) return;
  try {
    fs.appendFileSync(debugLog, `${new Date().toISOString()} ${process.pid} ${line}\n`);
  } catch {
    /* never break the hook */
  }
}

function parseArgs(argv) {
  const out = { provider: null, dataDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i] ?? null;
    else if (a === '--data-dir') out.dataDir = argv[++i] ?? null;
  }
  return out;
}

// ---- redaction (kept in sync with src/shared/redact.ts; test/redact.test.ts
// compares both implementations on the same samples) ---------------------
const REDACTED = '[REDACTED]';
const SECRET_PATTERNS = [
  [/\b((?:proxy-)?authorization)\s*[:=]\s*["']?\s*(?:bearer|basic|token|digest|negotiate|apikey|api-key)?\s*[^\s"',;]{4,}/gi, `$1: ${REDACTED}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
  [/(["'](?:[a-z0-9_-]*(?:token|api[_-]?key|secret|password|passwd|pwd|credential|authorization)[a-z0-9_-]*)["']\s*[:=]\s*)["'][^"']{4,}["']/gi, `$1"${REDACTED}"`],
  [/\b([a-z0-9_-]*(?:token|api[_-]?key|secret|password|passwd|pwd|credential)[a-z0-9_-]*)\s*[:=]\s*["']?[^\s"',;]{4,}/gi, `$1=${REDACTED}`],
  [/(--?(?:[a-z-]*(?:token|api-?key|secret|password|passwd|credential)[a-z-]*))(\s+|=)["']?[^\s"']{4,}/gi, `$1$2${REDACTED}`],
  [/((?:https?|ftp|redis|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
];

export function redactSecrets(text) {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function maskHome(text, homeDir) {
  if (!homeDir || homeDir.length < 3) return text;
  let out = text;
  for (const v of new Set([homeDir, homeDir.replace(/\\/g, '/'), homeDir.replace(/\//g, '\\')])) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '~');
  }
  return out;
}

/** Mask first, then bound - a truncated value can never leak a credential prefix. */
function cleanString(value, max, homeDir) {
  if (typeof value !== 'string') return undefined;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  const masked = maskHome(redactSecrets(oneLine), homeDir);
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

// ASCII control characters (0x00-0x1f, 0x7f), built from char codes so the
// source file itself contains no control bytes.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);
function cleanId(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const cleaned = value.replace(CONTROL_CHARS, '');
  return cleaned ? cleaned.slice(0, 200) : undefined;
}

const ID_FIELDS = [
  'session_id',
  'hook_event_name',
  'agent_id',
  'agent_type',
  'tool_name',
  'tool_use_id',
  'call_id',
  'turn_id',
  'prompt_id',
  'permission_mode',
  'model',
  'from_model',
  'to_model',
  'reason',
  'source',
  'trigger',
  'notification_type',
  'target',
];

const TOOL_INPUT_STRING_FIELDS = [
  'file_path',
  'path',
  'notebook_path',
  'filePath',
  'target_file',
  'pattern',
  'query',
  'glob',
  'url',
  'description',
  'subagent_type',
  'model',
  'prompt_title',
];

const PATCH_HEADER = /^\*\*\* (Add|Update|Delete|Move to) File: (.+)$/;

function summarizeToolInput(toolName, input, homeDir) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return typeof input === 'string' ? { _text: cleanString(input, 80, homeDir) } : undefined;
  }
  const out = {};
  const isPatch = typeof toolName === 'string' && toolName.toLowerCase() === 'apply_patch';
  const cmdRaw = Array.isArray(input.command) ? input.command.map(String).join(' ') : input.command ?? input.cmd;
  if (isPatch) {
    // Codex puts the patch under `command`; only file headers are forwarded.
    const patch =
      typeof cmdRaw === 'string'
        ? cmdRaw
        : typeof input.patch === 'string'
          ? input.patch
          : typeof input.input === 'string'
            ? input.input
            : null;
    if (patch) {
      const headers = patch
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => PATCH_HEADER.test(l))
        .slice(0, 5)
        .map((l) => cleanString(l, 200, homeDir))
        .filter(Boolean);
      out.command = headers.length ? headers.join('\n') : '(patch)';
    }
  } else if (typeof cmdRaw === 'string') {
    const v = cleanString(cmdRaw.split(/\r?\n/)[0] ?? '', 120, homeDir);
    if (v) out.command = v;
  }
  for (const key of TOOL_INPUT_STRING_FIELDS) {
    const v = cleanString(input[key], 200, homeDir);
    if (v) out[key] = v;
  }
  if (typeof input.chars === 'string') out.chars = '(stdin)';
  return out;
}

function summarizeToolResponse(resp, homeDir) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return undefined;
  const out = {};
  for (const key of ['exit_code', 'exitCode', 'returncode']) {
    if (typeof resp[key] === 'number' && Number.isFinite(resp[key])) out[key] = resp[key];
  }
  for (const key of ['is_error', 'isError', 'success', 'ok']) {
    if (typeof resp[key] === 'boolean') out[key] = resp[key];
  }
  const err = cleanString(resp.error ?? resp.message, 300, homeDir);
  if (err) out.error = err;
  return out;
}

export function redactPayload(raw, homeDir) {
  const out = {};
  for (const key of ID_FIELDS) {
    const v = cleanId(raw[key]);
    if (v !== undefined) out[key] = v;
  }
  if (typeof raw.cwd === 'string') out.cwd = cleanString(raw.cwd, 300, homeDir);
  if (typeof raw.stop_hook_active === 'boolean') out.stop_hook_active = raw.stop_hook_active;
  if ('tool_input' in raw) {
    const s = summarizeToolInput(raw.tool_name, raw.tool_input, homeDir);
    if (s) out.tool_input = s;
  }
  if ('tool_response' in raw) {
    const s = summarizeToolResponse(raw.tool_response, homeDir);
    if (s) out.tool_response = s;
  }
  if (typeof raw.error === 'string') out.error = cleanString(raw.error, 300, homeDir);
  if (typeof raw.message === 'string') out.message = cleanString(raw.message, 160, homeDir);
  // Deliberately dropped: prompt, last_assistant_message, transcript_path,
  // agent_transcript_path, tool_input free text, tool_response bodies.
  return out;
}

// ---- transport -------------------------------------------------------------
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function readServerJson(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
    if (
      raw &&
      typeof raw.port === 'number' &&
      Number.isInteger(raw.port) &&
      raw.port > 0 &&
      raw.port < 65536 &&
      typeof raw.ingestToken === 'string' &&
      typeof raw.host === 'string' &&
      LOOPBACK_HOSTS.has(raw.host.toLowerCase())
    ) {
      return raw;
    }
    dbg('server.json rejected (not loopback or malformed)');
  } catch {
    /* not running */
  }
  return null;
}

function post(server, body) {
  return new Promise((resolve) => {
    const timeout = Math.min(REQUEST_TIMEOUT_MS, remaining());
    if (timeout <= 20) return resolve(false);
    let settled = false;
    const finish = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const req = http.request(
        {
          host: server.host,
          port: server.port,
          path: '/api/ingest',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.ingestToken}`,
            Host: `${server.host}:${server.port}`,
          },
          timeout,
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            dbg(`post status=${res.statusCode}`);
            finish(res.statusCode !== undefined && res.statusCode < 300);
          });
        },
      );
      req.on('error', (err) => {
        dbg(`post error=${err.code ?? err.message}`);
        finish(false);
      });
      req.on('timeout', () => {
        dbg('post timeout');
        req.destroy();
        finish(false);
      });
      req.end(body);
    } catch {
      finish(false);
    }
  });
}

// ---- spool (one file per envelope, atomic rename, claimed batches) ----------
function spoolDir(dataDir) {
  return path.join(dataDir, 'spool');
}

/** Lexicographically sortable name: zero-padded ms timestamp + random suffix. */
function spoolName() {
  const ms = String(Date.now()).padStart(15, '0');
  return `${ms}-${crypto.randomBytes(4).toString('hex')}.json`;
}

export function appendSpool(dataDir, envelope) {
  try {
    const dir = spoolDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const name = spoolName();
    const tmp = path.join(dir, `${name}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, name));
    enforceSpoolBounds(dir);
    return true;
  } catch (err) {
    dbg(`spool write failed ${err.code ?? ''}`);
    return false;
  }
}

function listSpool(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).sort();
}

/**
 * Backlog still pending = unclaimed files OR files claimed by another hook
 * whose delivery is in flight. A live event must queue behind both, otherwise
 * it could overtake an older event mid-flush.
 */
function pendingSpool(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  return names.filter((n) => n.endsWith('.json') || n.includes('.json.claimed-')).length;
}

/** Drop the oldest files when over the count or byte bound. */
function enforceSpoolBounds(dir) {
  const names = listSpool(dir);
  let total = 0;
  const sizes = new Map();
  for (const n of names) {
    try {
      const size = fs.statSync(path.join(dir, n)).size;
      sizes.set(n, size);
      total += size;
    } catch {
      sizes.set(n, 0);
    }
  }
  let i = 0;
  while ((names.length - i > SPOOL_MAX_FILES || total > SPOOL_MAX_BYTES) && i < names.length) {
    const n = names[i++];
    try {
      fs.unlinkSync(path.join(dir, n));
    } catch {
      /* already gone */
    }
    total -= sizes.get(n) ?? 0;
  }
  // Also clean up abandoned temp/claim files from crashed hooks.
  let others;
  try {
    others = fs.readdirSync(dir).filter((n) => !n.endsWith('.json'));
  } catch {
    return;
  }
  for (const n of others) {
    try {
      const p = path.join(dir, n);
      if (Date.now() - fs.statSync(p).mtimeMs > CLAIM_STALE_MS) {
        if (n.includes('.claimed-')) fs.renameSync(p, path.join(dir, n.split('.claimed-')[0]));
        else fs.unlinkSync(p);
      }
    } catch {
      /* raced with another hook */
    }
  }
}

/**
 * Flush the oldest spooled envelopes, in order. Each file is claimed by
 * renaming it (rename is atomic; a concurrent flusher loses the race and
 * skips the file). On success the claimed files are deleted; on failure they
 * are renamed back so no event is lost. Returns true when the spool is empty
 * or the batch was delivered.
 */
export async function flushSpool(dataDir, server) {
  const dir = spoolDir(dataDir);
  const names = listSpool(dir);
  if (names.length === 0) return true;
  const claimed = [];
  const batch = [];
  for (const n of names.slice(0, SPOOL_FLUSH_BATCH)) {
    const from = path.join(dir, n);
    const to = `${from}.claimed-${process.pid}`;
    try {
      fs.renameSync(from, to);
    } catch {
      continue; // another hook claimed it
    }
    try {
      batch.push(JSON.parse(fs.readFileSync(to, 'utf8')));
      claimed.push(to);
    } catch {
      try {
        fs.unlinkSync(to); // corrupt file: drop it
      } catch {
        /* ignore */
      }
    }
  }
  if (batch.length === 0) return names.length === 0;
  const ok = await post(server, JSON.stringify({ events: batch }));
  dbg(`flush batch=${batch.length} ok=${ok}`);
  for (const to of claimed) {
    try {
      if (ok) fs.unlinkSync(to);
      else fs.renameSync(to, to.split('.claimed-')[0]);
    } catch {
      /* ignore */
    }
  }
  return ok;
}

// ---- main ------------------------------------------------------------------
async function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), 700);
    process.stdin.on('data', (c) => {
      if (done) return;
      size += c.length; // bytes, so multibyte (Korean) text is bounded correctly
      if (size > MAX_STDIN_BYTES) {
        finish('');
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(''));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = args.provider;
  if (provider !== 'claude' && provider !== 'codex') return;
  const dataDir =
    args.dataDir || process.env.AGENT_TOWN_DATA_DIR || path.join(os.homedir(), '.agent-town');
  const homeDir = os.homedir();

  const input = await readStdin();
  let raw;
  try {
    raw = JSON.parse(input);
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;

  const envelope = {
    eventId: crypto.randomUUID(),
    provider,
    sentAt: new Date().toISOString(),
    payload: redactPayload(raw, homeDir),
  };
  const eventName = typeof raw.hook_event_name === 'string' ? raw.hook_event_name.slice(0, 40) : '?';

  const server = readServerJson(dataDir);
  if (!server) {
    dbg(`no server event=${eventName} -> spool`);
    appendSpool(dataDir, envelope);
    return;
  }
  // Older backlog first, so source chronology is preserved on the server.
  let backlogOk = true;
  let rounds = 0;
  while (listSpool(spoolDir(dataDir)).length > 0 && remaining() > 250 && rounds < 4) {
    rounds++;
    backlogOk = await flushSpool(dataDir, server);
    if (!backlogOk) break;
  }
  if (!backlogOk || pendingSpool(spoolDir(dataDir)) > 0) {
    // Backlog still pending (unclaimed, or claimed by a concurrent hook whose
    // POST is in flight): keep order by spooling this event behind it.
    dbg(`backlog pending event=${eventName} -> spool`);
    appendSpool(dataDir, envelope);
    return;
  }
  const ok = await post(server, JSON.stringify(envelope));
  dbg(`event=${eventName} ok=${ok} remaining=${remaining()}`);
  if (!ok) appendSpool(dataDir, envelope);
}

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return !!entry && path.resolve(fileURLToPath(import.meta.url)) === entry;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const hardExit = setTimeout(() => process.exit(0), TOTAL_BUDGET_MS + 300);
  hardExit.unref();
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
