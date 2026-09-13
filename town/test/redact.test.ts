import { describe, expect, it } from 'vitest';

import { maskHome, redactSecrets, sanitizeText, shortPath } from '../src/shared/redact.js';
// The hook sender is plain JS; import its exported helpers to keep them in sync.
import { redactPayload, redactSecrets as redactSecretsJs } from '../hook/agent-town-hook.mjs';

const SAMPLES: Array<[string, string[]]> = [
  ['curl -H "Authorization: Bearer supervisor_fake_credential_123456" https://example.test', ['supervisor_fake_credential_123456']],
  ['Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', ['dXNlcjpwYXNzd29yZDEyMw==']],
  ['authorization=Bearer abcdefgh.ijklmnop.qrstuvwx', ['abcdefgh.ijklmnop.qrstuvwx']],
  ['{"api_key": "AKIAIOSFODNN7EXAMPLE1", "token":"tok_livesecret_998877"}', ['AKIAIOSFODNN7EXAMPLE1', 'tok_livesecret_998877']],
  ["--token 'ghpFAKE_but_long_credential_value' --api-key=ak_1234567890abcdef", ['ghpFAKE_but_long_credential_value', 'ak_1234567890abcdef']],
  ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 and AKIAABCDEFGHIJKLMNOP', ['abcdefghijklmnopqrstuvwxyz', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234', 'AKIAABCDEFGHIJKLMNOP']],
  ['PASSWORD=hunter22 ok', ['hunter22']],
  ['postgres://admin:s3cretpass@db.internal:5432/app', ['s3cretpass']],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', ['dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U']],
];

describe('redaction (server TypeScript and hook JavaScript stay in sync)', () => {
  it.each(SAMPLES)('masks %s', (text, secrets) => {
    const ts = redactSecrets(text);
    const js = redactSecretsJs(text);
    for (const secret of secrets) {
      expect(ts, 'ts').not.toContain(secret);
      expect(js, 'js').not.toContain(secret);
    }
    expect(ts).toContain('[REDACTED]');
    expect(js).toBe(ts);
  });

  it('keeps readable labels and does not mangle harmless text', () => {
    expect(redactSecrets('PASSWORD=hunter22 ok')).toBe('PASSWORD=[REDACTED] ok');
    expect(redactSecrets('curl -H "Authorization: Bearer abc123456789" x')).toContain('Authorization: [REDACTED]');
    expect(redactSecrets('npm test -- --grep login')).toBe('npm test -- --grep login');
    expect(redactSecrets('Read src/auth/token-service.ts')).toBe('Read src/auth/token-service.ts');
  });

  it('masks the home directory in both slash styles', () => {
    expect(maskHome('C:\\Users\\tester\\proj\\a.ts', 'C:\\Users\\tester')).toBe('~\\proj\\a.ts');
    expect(maskHome('C:/Users/tester/proj/a.ts', 'C:\\Users\\tester')).toBe('~/proj/a.ts');
  });

  it('shortPath keeps only the last two segments and redacts secrets inside paths', () => {
    expect(shortPath('C:/Users/tester/proj/src/deep/file.ts', 'C:/Users/tester')).toBe('…/deep/file.ts');
    expect(shortPath('C:/tmp/sk-ant-api03-hiddenkeyvalue123/x.ts', null)).not.toContain('hiddenkeyvalue');
  });

  it('sanitizeText redacts BEFORE truncating (no credential prefix survives)', () => {
    const secret = 'Bearer verylongfakecredential_0123456789';
    const out = sanitizeText(`Authorization: ${secret} ${'x'.repeat(500)}`, 30, null)!;
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).not.toContain('verylongfake');
    expect(out).toContain('[REDACTED]');
  });
});

describe('hook sender redaction (plain JS)', () => {
  it('drops prompt, transcript paths and full tool responses; keeps identity fields', () => {
    const raw = {
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      transcript_path: 'C:/Users/tester/.claude/projects/x/transcript.jsonl',
      cwd: 'C:/Users/tester/proj',
      prompt: 'please use sk-abcdefghijklmnopqrstuvwxyz',
      tool_name: 'Bash',
      tool_use_id: 't1',
      tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x\nrm -rf /', description: 'fetch' },
      tool_response: { stdout: 'BEGIN-FILE-CONTENT ' + 'z'.repeat(10_000), exit_code: 1, error: 'boom at C:/Users/tester/proj' },
      last_assistant_message: 'secret answer',
    };
    const out = redactPayload(raw, 'C:\\Users\\tester') as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(out.session_id).toBe('s1');
    expect(out.tool_use_id).toBe('t1');
    expect(json).not.toContain('transcript.jsonl');
    expect(json).not.toContain('please use');
    expect(json).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(json).not.toContain('secret answer');
    expect(json).not.toContain('BEGIN-FILE-CONTENT');
    expect(json).not.toContain('abcdefghijklmnop');
    expect(json).not.toContain('rm -rf');
    expect(out.cwd).toBe('~/proj');
    expect((out.tool_response as Record<string, unknown>).exit_code).toBe(1);
    expect((out.tool_response as Record<string, unknown>).error).toBe('boom at ~/proj');
    expect(json.length).toBeLessThan(1000);
  });

  it('forwards apply_patch file headers from tool_input.command only, and MCP isError', () => {
    const out = redactPayload(
      {
        session_id: 's',
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_use_id: 'p1',
        tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n+SECRET_LINE_CONTENT\n*** End Patch' },
      },
      null,
    ) as { tool_input: { command: string } };
    expect(out.tool_input.command).toBe('*** Update File: src/a.ts');
    const mcp = redactPayload(
      { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'mcp__a__b', tool_use_id: 'm1', tool_response: { isError: true, content: [{ text: 'PRIVATE' }] } },
      null,
    ) as { tool_response: Record<string, unknown> };
    expect(mcp.tool_response).toEqual({ isError: true });
  });

  it('bounds Korean text by characters after masking and strips control characters from ids', () => {
    const out = redactPayload(
      { session_id: 'id\u0000\u0007x', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: '한글 '.repeat(200) } },
      null,
    ) as { session_id: string; tool_input: { command: string } };
    expect(out.session_id).toBe('idx');
    expect(out.tool_input.command.length).toBeLessThanOrEqual(120);
  });
});
