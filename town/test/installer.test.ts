import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  apply,
  buildCommand,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  isOwnedHook,
  planInstall,
  planUninstall,
  settingsPathFor,
  statusFor,
} from '../hook/install.mjs';

let project: string;
const hookPath = 'C:/tools/town/hook/agent-town-hook.mjs';
const dataDir = 'C:/Users/tester/.agent-town';
const opts = { hookPath, dataDir };

/** Commands that mention our file name but are NOT ours. */
const LOOKALIKES = [
  { type: 'command', command: 'echo agent-town-hook.mjs' },
  { type: 'command', command: 'node "C:/elsewhere/agent-town-hook.mjs" --provider claude --data-dir "C:/x"' },
  { type: 'command', command: `wrapper.cmd "${hookPath}" --provider claude` },
  { type: 'command', command: `node "${hookPath}" --provider claude --data-dir "C:/x" && rm -rf /` },
  { type: 'command', command: `bash -c 'node "${hookPath}" --provider codex --data-dir "C:/x"'` },
  { type: 'http', url: 'http://127.0.0.1/agent-town-hook.mjs' },
];

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-proj-'));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('ownership rule', () => {
  it('matches only the exact owned invocation of our script path', () => {
    const ours = { type: 'command', command: buildCommand('claude', hookPath, dataDir) };
    expect(isOwnedHook(ours, hookPath)).toBe(true);
    // Different data dir is still ours (stale install).
    expect(isOwnedHook({ type: 'command', command: buildCommand('codex', hookPath, 'C:/other') }, hookPath)).toBe(true);
    // Case/slash differences on Windows still resolve to the same file.
    if (process.platform === 'win32') {
      expect(isOwnedHook({ type: 'command', command: buildCommand('claude', 'C:\\Tools\\Town\\hook\\agent-town-hook.mjs', dataDir) }, hookPath)).toBe(true);
    }
    for (const l of LOOKALIKES) expect(isOwnedHook(l, hookPath), JSON.stringify(l)).toBe(false);
  });
});

describe('installer plans', () => {
  it('adds one owned entry per event and preserves foreign hooks and lookalikes', () => {
    const existing = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
          { hooks: LOOKALIKES },
        ],
        Custom: 'not-our-business',
      },
    };
    const cmd = buildCommand('claude', hookPath, dataDir);
    const { next, changes } = planInstall(existing, 'claude', cmd, '<f>', hookPath);
    expect(changes).toHaveLength(CLAUDE_EVENTS.length);
    expect(next.permissions).toEqual(existing.permissions);
    expect(next.hooks.Custom).toBe('not-our-business');
    expect(next.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(next.hooks.PreToolUse[1]).toEqual({ hooks: LOOKALIKES });
    expect(next.hooks.PreToolUse[2].hooks[0].command).toBe(cmd);
    expect(planInstall(next, 'claude', cmd, '<f>', hookPath).changes).toHaveLength(0);
  });

  it('updates a stale owned entry in place instead of duplicating it', () => {
    const oldCmd = buildCommand('codex', hookPath, 'C:/old-data');
    const first = planInstall({}, 'codex', oldCmd, '<f>', hookPath).next;
    const newCmd = buildCommand('codex', hookPath, dataDir);
    const { next, changes } = planInstall(first, 'codex', newCmd, '<f>', hookPath);
    expect(changes.every((c) => c.startsWith('update'))).toBe(true);
    for (const ev of CODEX_EVENTS) {
      expect(next.hooks[ev]).toHaveLength(1);
      expect(next.hooks[ev][0].hooks[0].command).toBe(newCmd);
    }
  });

  it('uninstall removes only owned entries, keeps mixed groups and lookalikes, drops emptied events', () => {
    const cmd = buildCommand('claude', hookPath, dataDir);
    const mixed = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: cmd, timeout: 5 }] }],
        PreToolUse: [{ hooks: LOOKALIKES }],
      },
    };
    const withOurs = planInstall(mixed, 'claude', cmd, '<f>', hookPath).next;
    const { next, changes } = planUninstall(withOurs, 'claude', '<f>', hookPath);
    expect(changes.length).toBeGreaterThan(0);
    expect(next.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }]);
    expect(next.hooks.PreToolUse).toEqual([{ hooks: LOOKALIKES }]);
    expect(next.hooks.SessionStart).toBeUndefined();
  });

  it('refuses malformed hooks sections', () => {
    expect(() => planInstall({ hooks: [] }, 'claude', 'x')).toThrow(/not an object/);
    expect(() => planInstall({ hooks: { PreToolUse: { bad: true } } }, 'claude', 'x')).toThrow(/not an array/);
    expect(() => planInstall({ hooks: { PreToolUse: [{ hooks: 'nope' }] } }, 'claude', 'x')).toThrow(/not an array/);
  });
});

describe('installer file operations (temp project)', () => {
  it('dry-run writes nothing', () => {
    const r = apply('install', 'claude', project, { dryRun: true, ...opts });
    expect(r.changes.length).toBeGreaterThan(0);
    expect(fs.existsSync(r.file)).toBe(false);
  });

  it('install writes project-scoped files with backups, status reports, uninstall restores', () => {
    const claudeFile = settingsPathFor('claude', project);
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    const original = { permissions: { allow: ['Read'] }, hooks: { PreToolUse: [{ hooks: LOOKALIKES }] } };
    fs.writeFileSync(claudeFile, JSON.stringify(original, null, 2));

    const r1 = apply('install', 'claude', project, opts);
    expect(r1.written).toBe(true);
    expect(r1.backup && fs.existsSync(r1.backup)).toBe(true);
    const written = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    expect(written.permissions).toEqual({ allow: ['Read'] });
    expect(Object.keys(written.hooks)).toEqual([...new Set(['PreToolUse', ...CLAUDE_EVENTS])]);
    expect(written.hooks.PreToolUse[0]).toEqual({ hooks: LOOKALIKES });

    const r2 = apply('install', 'codex', project, opts);
    expect(r2.written).toBe(true);
    expect(r2.file).toBe(path.join(project, '.codex', 'hooks.json'));
    expect(Object.keys(JSON.parse(fs.readFileSync(r2.file, 'utf8')).hooks)).toEqual([...CODEX_EVENTS]);

    const st = statusFor('claude', project, opts);
    expect(st.installedEvents).toHaveLength(CLAUDE_EVENTS.length);
    expect(st.missingEvents).toHaveLength(0);
    expect(st.foreignEntries).toBe(LOOKALIKES.length);
    const stale = statusFor('claude', project, { hookPath, dataDir: 'C:/somewhere-else' });
    expect(stale.staleEvents).toHaveLength(CLAUDE_EVENTS.length);
    // Seen from a different installation, our 12 entries are foreign; the one
    // lookalike that really runs that other path is that installation's (stale) entry.
    const other = statusFor('claude', project, { hookPath: 'C:/elsewhere/agent-town-hook.mjs', dataDir });
    expect(other.installedEvents).toHaveLength(0);
    expect(other.staleEvents).toHaveLength(1);
    expect(other.foreignEntries).toBe(LOOKALIKES.length - 1 + CLAUDE_EVENTS.length);

    const r3 = apply('uninstall', 'claude', project, opts);
    expect(r3.written).toBe(true);
    expect(JSON.parse(fs.readFileSync(claudeFile, 'utf8'))).toEqual(original);
  });

  it('refuses to touch an unparseable settings file', () => {
    const file = settingsPathFor('claude', project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    expect(() => apply('install', 'claude', project, opts)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
    expect(statusFor('claude', project, opts).parseError).toMatch(/not valid JSON/);
  });

  it('never targets user-global settings', () => {
    expect(settingsPathFor('claude', project)).toBe(path.join(project, '.claude', 'settings.local.json'));
    expect(settingsPathFor('claude', project, true)).toBe(path.join(project, '.claude', 'settings.json'));
    expect(settingsPathFor('codex', project)).toBe(path.join(project, '.codex', 'hooks.json'));
    expect(settingsPathFor('claude', project)).not.toContain(os.homedir() + path.sep + '.claude');
  });
});
