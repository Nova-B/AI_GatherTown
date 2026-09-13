#!/usr/bin/env node
// Agent Town project-scoped hook installer / status / uninstaller.
//
//   node hook/install.mjs status    [--project <dir>] [--provider claude|codex|both]
//   node hook/install.mjs install   [--project <dir>] [--provider ...] [--dry-run] [--shared] [--data-dir <dir>]
//   node hook/install.mjs uninstall [--project <dir>] [--provider ...] [--dry-run] [--shared]
//
// Targets (project-scoped only; user-wide settings are never touched):
//   Claude Code : <project>/.claude/settings.local.json   (or .claude/settings.json with --shared)
//   Codex       : <project>/.codex/hooks.json
//
// Guarantees:
// - Unparseable JSON or a malformed `hooks` section => refuse, write nothing.
// - Ownership is the exact invocation shape
//     node "<this repo's hook/agent-town-hook.mjs>" --provider <p> --data-dir "<dir>"
//   where the script path must resolve to THIS installer's sibling hook file.
//   A command that merely mentions the file name, runs a same-named script
//   elsewhere, or wraps the path in another program is not ours and is never
//   modified or removed. Mixed groups keep their foreign hooks.
// - A timestamped backup is written next to the file before every change.
// - --dry-run prints the resulting file without writing.
// - Codex additionally requires the user to trust the hook definition inside
//   the Codex CLI (/hooks). This installer cannot and does not bypass that.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_TIMEOUT_SEC = 5;

export const CLAUDE_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
];

export const CODEX_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt',
  'SubagentStart',
  'SubagentStop',
];

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HOOK_PATH = path.join(here, 'agent-town-hook.mjs');

export function defaultDataDir() {
  return process.env.AGENT_TOWN_DATA_DIR || path.join(os.homedir(), '.agent-town');
}

function toSlash(p) {
  return p.replace(/\\/g, '/');
}

/** Canonical comparable form of a filesystem path (Windows is case-insensitive). */
function canonicalPath(p) {
  const resolved = toSlash(path.resolve(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function buildCommand(provider, hookPath, dataDir) {
  return `node "${toSlash(path.resolve(hookPath))}" --provider ${provider} --data-dir "${toSlash(path.resolve(dataDir))}"`;
}

const OWNED_COMMAND = /^node "([^"]+)" --provider (claude|codex) --data-dir "([^"]+)"$/;

/** Parse a command string; returns its parts only when it has the exact owned shape. */
export function parseOwnedCommand(command) {
  if (typeof command !== 'string') return null;
  const m = OWNED_COMMAND.exec(command);
  if (!m) return null;
  return { script: m[1], provider: m[2], dataDir: m[3] };
}

/** True only for a command that runs OUR hook script with the owned invocation shape. */
export function isOwnedHook(hook, hookPath = DEFAULT_HOOK_PATH) {
  if (!hook || typeof hook !== 'object' || hook.type !== 'command') return false;
  const parsed = parseOwnedCommand(hook.command);
  if (!parsed) return false;
  return canonicalPath(parsed.script) === canonicalPath(hookPath);
}

export function settingsPathFor(provider, projectDir, shared = false) {
  if (provider === 'claude') {
    return path.join(projectDir, '.claude', shared ? 'settings.json' : 'settings.local.json');
  }
  if (provider === 'codex') return path.join(projectDir, '.codex', 'hooks.json');
  throw new Error(`unknown provider ${provider}`);
}

export function eventsFor(provider) {
  return provider === 'claude' ? CLAUDE_EVENTS : CODEX_EVENTS;
}

export class SettingsError extends Error {}

/** Parse a settings/hooks file. Missing file => {}. Malformed => SettingsError. */
export function readSettings(file) {
  if (!fs.existsSync(file)) return { exists: false, data: {} };
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return { exists: true, data: {} };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new SettingsError(`${file} is not valid JSON (${e.message}); refusing to modify it`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SettingsError(`${file} must contain a JSON object; refusing to modify it`);
  }
  return { exists: true, data };
}

function validateHooksSection(data, file, events) {
  if (data.hooks === undefined) return;
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    throw new SettingsError(`${file}: "hooks" is not an object; fix or remove it first`);
  }
  for (const ev of Object.keys(data.hooks)) {
    if (!events.includes(ev)) continue;
    const groups = data.hooks[ev];
    if (!Array.isArray(groups)) {
      throw new SettingsError(`${file}: hooks.${ev} is not an array; fix or remove it first`);
    }
    for (const g of groups) {
      if (g !== null && typeof g === 'object' && 'hooks' in g && !Array.isArray(g.hooks)) {
        throw new SettingsError(`${file}: hooks.${ev}[].hooks is not an array; fix or remove it first`);
      }
    }
  }
}

/** Pure: returns a new settings object with our hooks merged in, plus a change list. */
export function planInstall(data, provider, command, file = '<settings>', hookPath = DEFAULT_HOOK_PATH) {
  const events = eventsFor(provider);
  validateHooksSection(data, file, events);
  const next = structuredClone(data);
  if (!next.hooks) next.hooks = {};
  const changes = [];
  for (const ev of events) {
    const groups = Array.isArray(next.hooks[ev]) ? next.hooks[ev] : (next.hooks[ev] = []);
    let found = false;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!isOwnedHook(hook, hookPath)) continue;
        if (found) continue; // a second owned entry is left alone (removed by uninstall)
        found = true;
        if (hook.command !== command || hook.timeout !== HOOK_TIMEOUT_SEC) {
          hook.command = command;
          hook.timeout = HOOK_TIMEOUT_SEC;
          changes.push(`update ${ev}`);
        }
      }
    }
    if (!found) {
      groups.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] });
      changes.push(`add ${ev}`);
    }
  }
  return { next, changes };
}

/** Pure: returns a new settings object with our hooks removed, plus a change list. */
export function planUninstall(data, provider, file = '<settings>', hookPath = DEFAULT_HOOK_PATH) {
  const events = eventsFor(provider);
  validateHooksSection(data, file, events);
  const next = structuredClone(data);
  const changes = [];
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) return { next, changes };
  for (const ev of Object.keys(next.hooks)) {
    const groups = next.hooks[ev];
    if (!Array.isArray(groups)) continue;
    let removed = 0;
    const keptGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const keptHooks = group.hooks.filter((h) => {
        if (isOwnedHook(h, hookPath)) {
          removed++;
          return false;
        }
        return true;
      });
      if (keptHooks.length === group.hooks.length) keptGroups.push(group);
      else if (keptHooks.length > 0) keptGroups.push({ ...group, hooks: keptHooks });
      // A group left with zero hooks (all ours) is dropped.
    }
    if (removed > 0) {
      changes.push(`remove ${removed} from ${ev}`);
      if (keptGroups.length === 0) delete next.hooks[ev];
      else next.hooks[ev] = keptGroups;
    }
  }
  const hadHooks = data.hooks && typeof data.hooks === 'object' && Object.keys(data.hooks).length > 0;
  if (hadHooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next, changes };
}

export function statusFor(provider, projectDir, opts = {}) {
  const hookPath = opts.hookPath ?? DEFAULT_HOOK_PATH;
  const file = settingsPathFor(provider, projectDir, opts.shared);
  const expected = buildCommand(provider, hookPath, opts.dataDir ?? defaultDataDir());
  const result = {
    provider,
    file,
    exists: false,
    parseError: null,
    installedEvents: [],
    missingEvents: [...eventsFor(provider)],
    staleEvents: [],
    foreignEntries: 0,
  };
  let parsed;
  try {
    parsed = readSettings(file);
  } catch (e) {
    result.parseError = e.message;
    return result;
  }
  result.exists = parsed.exists;
  const hooks = parsed.data.hooks;
  if (!hooks || typeof hooks !== 'object') return result;
  for (const ev of Object.keys(hooks)) {
    const groups = hooks[ev];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isOwnedHook(hook, hookPath)) {
          if (hook.command === expected) result.installedEvents.push(ev);
          else result.staleEvents.push(ev);
        } else {
          result.foreignEntries++;
        }
      }
    }
  }
  result.missingEvents = eventsFor(provider).filter(
    (ev) => !result.installedEvents.includes(ev) && !result.staleEvents.includes(ev),
  );
  return result;
}

function backupPath(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.agent-town.bak-${stamp}`;
}

function writeSettings(file, data, existed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (existed) {
    backup = backupPath(file);
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.agent-town-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return backup;
}

/**
 * Perform install/uninstall for one provider. Returns a report object; throws
 * SettingsError for malformed files (nothing written).
 */
export function apply(action, provider, projectDir, opts = {}) {
  const hookPath = opts.hookPath ?? DEFAULT_HOOK_PATH;
  const file = settingsPathFor(provider, projectDir, opts.shared);
  const { exists, data } = readSettings(file);
  const command = buildCommand(provider, hookPath, opts.dataDir ?? defaultDataDir());
  const plan =
    action === 'install'
      ? planInstall(data, provider, command, file, hookPath)
      : planUninstall(data, provider, file, hookPath);
  const report = {
    provider,
    file,
    changes: plan.changes,
    written: false,
    backup: null,
    dryRun: !!opts.dryRun,
    next: plan.next,
  };
  if (plan.changes.length === 0) return report;
  if (opts.dryRun) return report;
  if (action === 'uninstall' && !exists) return report;
  report.backup = writeSettings(file, plan.next, exists);
  report.written = true;
  return report;
}

// ---- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    action: argv[0],
    provider: 'both',
    project: process.cwd(),
    dryRun: false,
    shared: false,
    dataDir: null,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i];
    else if (a === '--project') out.project = path.resolve(argv[++i] ?? '.');
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--shared') out.shared = true;
    else if (a === '--data-dir') out.dataDir = path.resolve(argv[++i] ?? '.');
    else if (a === '--help' || a === '-h') out.action = 'help';
  }
  return out;
}

function providersOf(v) {
  if (v === 'both' || !v) return ['claude', 'codex'];
  if (v === 'claude' || v === 'codex') return [v];
  throw new Error(`--provider must be claude, codex or both (got ${v})`);
}

function printHelp() {
  console.log(`Agent Town hook installer (project-scoped)

  node hook/install.mjs status    [--project <dir>] [--provider claude|codex|both] [--shared]
  node hook/install.mjs install   [--project <dir>] [--provider ...] [--dry-run] [--shared] [--data-dir <dir>]
  node hook/install.mjs uninstall [--project <dir>] [--provider ...] [--dry-run] [--shared]

Claude Code target: <project>/.claude/settings.local.json (--shared: .claude/settings.json)
Codex target      : <project>/.codex/hooks.json  (then run /hooks inside Codex to trust it)
Data dir          : ${defaultDataDir()} (override with --data-dir or AGENT_TOWN_DATA_DIR)
`);
}

function serverStatus(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
    return `server.json found (port ${raw.port}, pid ${raw.pid})`;
  } catch {
    return 'server.json not found (Agent Town server not running; events will be spooled)';
  }
}

function cli() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir ?? defaultDataDir();
  if (!args.action || args.action === 'help') {
    printHelp();
    return 0;
  }
  const providers = providersOf(args.provider);
  const opts = { dryRun: args.dryRun, shared: args.shared, dataDir };
  if (args.action === 'status') {
    console.log(`project : ${args.project}`);
    console.log(`data dir: ${dataDir}`);
    console.log(`hook    : ${DEFAULT_HOOK_PATH}`);
    console.log(`server  : ${serverStatus(dataDir)}`);
    for (const p of providers) {
      const s = statusFor(p, args.project, opts);
      console.log(`\n[${p}] ${s.file}`);
      if (s.parseError) {
        console.log(`  MALFORMED: ${s.parseError}`);
        continue;
      }
      console.log(`  file exists      : ${s.exists}`);
      console.log(
        `  installed events : ${s.installedEvents.length}/${eventsFor(p).length}${s.installedEvents.length ? ' (' + s.installedEvents.join(', ') + ')' : ''}`,
      );
      if (s.staleEvents.length) console.log(`  stale (different data dir): ${s.staleEvents.join(', ')}`);
      if (s.missingEvents.length) console.log(`  missing          : ${s.missingEvents.join(', ')}`);
      console.log(`  other hooks kept : ${s.foreignEntries}`);
      if (p === 'codex') console.log('  note: Codex only runs hooks you have trusted via /hooks in the Codex CLI.');
    }
    return 0;
  }
  if (args.action !== 'install' && args.action !== 'uninstall') {
    printHelp();
    return 1;
  }
  let exit = 0;
  for (const p of providers) {
    try {
      const r = apply(args.action, p, args.project, opts);
      console.log(`[${p}] ${r.file}`);
      if (r.changes.length === 0) {
        console.log('  no changes needed');
        continue;
      }
      console.log(`  changes: ${r.changes.join('; ')}`);
      if (r.dryRun) {
        console.log('  dry-run: file would become:');
        console.log(JSON.stringify(r.next, null, 2).replace(/^/gm, '    '));
      } else {
        console.log(`  written: ${r.written}${r.backup ? `, backup: ${r.backup}` : ''}`);
      }
      if (p === 'codex' && args.action === 'install') {
        console.log('  next: open Codex in this project and run /hooks to review and trust the hook definition.');
      }
    } catch (e) {
      exit = 2;
      console.error(`[${p}] ERROR: ${e.message}`);
    }
  }
  return exit;
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
  process.exit(cli());
}
