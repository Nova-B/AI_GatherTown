import { describe, expect, it } from 'vitest';

import { normalizeClaude } from '../src/shared/providers/claude.js';
import { normalizeCodex } from '../src/shared/providers/codex.js';
import type { NormalizeContext } from '../src/shared/providers/common.js';
import { summarizeToolResponse } from '../src/shared/providers/common.js';

const ctx: NormalizeContext = {
  eventId: 'e1',
  receivedAt: '2026-09-13T00:00:00.000Z',
  homeDir: 'C:\\Users\\tester',
  source: 'hook',
};

describe('Claude normalizer', () => {
  it('maps PreToolUse with tool_use_id and masks the home path', () => {
    const e = normalizeClaude(
      {
        session_id: 's1',
        hook_event_name: 'PreToolUse',
        cwd: 'C:\\Users\\tester\\proj',
        tool_name: 'Read',
        tool_use_id: 'toolu_1',
        tool_input: { file_path: 'C:\\Users\\tester\\proj\\src\\a.ts' },
      },
      ctx,
    );
    expect(e?.kind).toBe('tool.started');
    expect(e?.toolCallId).toBe('toolu_1');
    expect(e?.agentId).toBe('main');
    expect(e?.agentIdOrigin).toBe('internal-main');
    expect(e?.cwd).toBe('~\\proj');
    expect(e?.payload.toolTarget).toBe('…/src/a.ts');
    expect(e?.payload.activity).toBe('read');
  });

  it('keeps agent_id on tool events inside a subagent', () => {
    const e = normalizeClaude(
      { session_id: 's1', hook_event_name: 'PostToolUse', agent_id: 'ag-9', tool_name: 'Grep', tool_use_id: 't2', tool_response: {} },
      ctx,
    );
    expect(e?.kind).toBe('tool.completed');
    expect(e?.agentId).toBe('ag-9');
    expect(e?.agentIdOrigin).toBe('source');
  });

  it('marks a PreToolUse without tool_use_id as unknown id (null), never invents one', () => {
    const e = normalizeClaude({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, ctx);
    expect(e?.toolCallId).toBeNull();
  });

  it('SubagentStart creates agent.started for the child with parent main', () => {
    const e = normalizeClaude({ session_id: 's1', hook_event_name: 'SubagentStart', agent_id: 'child-1', agent_type: 'Explore' }, ctx);
    expect(e?.kind).toBe('agent.started');
    expect(e?.agentId).toBe('child-1');
    expect(e?.parentAgentId).toBe('main');
    expect(e?.payload.agentType).toBe('Explore');
  });

  it('SubagentStop is response completion, not session end', () => {
    const e = normalizeClaude({ session_id: 's1', hook_event_name: 'SubagentStop', agent_id: 'child-1' }, ctx);
    expect(e?.kind).toBe('agent.response_completed');
    expect(e?.agentId).toBe('child-1');
  });

  it('Stop maps to response completion for main; SessionEnd to session.ended', () => {
    expect(normalizeClaude({ session_id: 's1', hook_event_name: 'Stop' }, ctx)?.kind).toBe('agent.response_completed');
    expect(normalizeClaude({ session_id: 's1', hook_event_name: 'SessionEnd', reason: 'other' }, ctx)?.kind).toBe('session.ended');
  });

  it('never carries the prompt text', () => {
    const e = normalizeClaude({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'my secret plan sk-abcdefghijklmnop' }, ctx);
    expect(e?.kind).toBe('turn.started');
    expect(JSON.stringify(e)).not.toContain('secret plan');
    expect(JSON.stringify(e)).not.toContain('sk-abcdefghijklmnop');
  });

  it('PostToolUseFailure carries a masked error', () => {
    const e = normalizeClaude(
      { session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't3', error: 'token=abcdef123456 failed at C:\\Users\\tester\\x' },
      ctx,
    );
    expect(e?.kind).toBe('tool.failed');
    expect(e?.payload.error).toContain('[REDACTED]');
    expect(e?.payload.error).not.toContain('abcdef123456');
    expect(e?.payload.error).toContain('~\\x');
  });

  it('PostToolUse with an MCP isError result is a failure', () => {
    const e = normalizeClaude(
      { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'mcp__db__query', tool_use_id: 't4', tool_response: { isError: true, content: [{ type: 'text', text: 'boom' }] } },
      ctx,
    );
    expect(e?.kind).toBe('tool.failed');
    expect(e?.payload.outcome).toBe('failed');
    expect(e?.payload.activity).toBe('mcp');
  });

  it('Notification permission_prompt is an approval request with unknown tool id', () => {
    const e = normalizeClaude({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, ctx);
    expect(e?.kind).toBe('approval.requested');
    expect(e?.toolCallId).toBeNull();
  });

  it('returns null when session_id is missing', () => {
    expect(normalizeClaude({ hook_event_name: 'Stop' }, ctx)).toBeNull();
  });

  it('unknown hook names are preserved as unknown events', () => {
    const e = normalizeClaude({ session_id: 's1', hook_event_name: 'TaskCreated' }, ctx);
    expect(e?.kind).toBe('unknown');
    expect(e?.payload.hookEventName).toBe('TaskCreated');
  });

  it('path-like and free-text inputs are masked before truncation', () => {
    const e = normalizeClaude(
      {
        session_id: 's1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_use_id: 't5',
        tool_input: { file_path: 'C:/Users/tester/proj/sk-ant-api03-supersecretvalue1234567890/x.ts' },
      },
      ctx,
    );
    expect(JSON.stringify(e)).not.toContain('supersecretvalue');
    const f = normalizeClaude(
      { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Custom', tool_use_id: 't6', tool_input: 'password=hunter2222 ' + 'x'.repeat(200) },
      ctx,
    );
    expect(f?.payload.toolTarget).toContain('[REDACTED]');
    expect(f?.payload.toolTarget).not.toContain('hunter2222');
  });
});

describe('Codex normalizer', () => {
  it('maps PreToolUse with turn_id and command summary', () => {
    const e = normalizeCodex(
      { session_id: 'c1', hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'exec_command', tool_use_id: 'call_1', tool_input: { command: 'npm test\nsecond line' } },
      ctx,
    );
    expect(e?.kind).toBe('tool.started');
    expect(e?.turnId).toBe('turn-1');
    expect(e?.payload.toolTarget).toBe('npm test');
    expect(e?.payload.activity).toBe('shell');
  });

  it('derives failure from PostToolUse exit_code', () => {
    const e = normalizeCodex(
      { session_id: 'c1', hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_use_id: 'call_1', tool_response: { exit_code: 2, error: 'boom' } },
      ctx,
    );
    expect(e?.kind).toBe('tool.failed');
    expect(e?.payload.exitCode).toBe(2);
    expect(e?.payload.error).toBe('boom');
  });

  it('PostToolUse with an explicit success signal is completed; with no signal it is unknown', () => {
    const ok = normalizeCodex({ session_id: 'c1', hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'call_2', tool_response: { success: true } }, ctx);
    expect(ok?.kind).toBe('tool.completed');
    expect(ok?.payload.outcome).toBe('completed');
    const none = normalizeCodex({ session_id: 'c1', hook_event_name: 'PostToolUse', tool_name: 'mcp__x__y', tool_use_id: 'call_3', tool_response: { content: [] } }, ctx);
    expect(none?.kind).toBe('tool.completed');
    expect(none?.payload.outcome).toBe('unknown');
  });

  it('MCP isError / is_error responses are failures', () => {
    for (const resp of [{ isError: true }, { is_error: true }, { ok: false }, { success: false, error: 'x' }]) {
      const e = normalizeCodex({ session_id: 'c1', hook_event_name: 'PostToolUse', tool_name: 'mcp__srv__tool', tool_use_id: 'm1', tool_response: resp }, ctx);
      expect(e?.kind, JSON.stringify(resp)).toBe('tool.failed');
    }
  });

  it('apply_patch target lists file headers from tool_input.command and never stores the patch', () => {
    const e = normalizeCodex(
      {
        session_id: 'c1',
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_use_id: 'call_3',
        tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n+const key = "sk-verysecretkey12345";\n*** Add File: C:/Users/tester/proj/b.ts\n*** End Patch' },
      },
      ctx,
    );
    expect(e?.payload.toolTarget).toBe('src/a.ts, …/proj/b.ts');
    expect(JSON.stringify(e)).not.toContain('verysecretkey');
    expect(JSON.stringify(e)).not.toContain('Begin Patch');
  });

  it('SubagentStart uses parent session_id and child agent_id with an unknown immediate parent', () => {
    const e = normalizeCodex({ session_id: 'parent-s', hook_event_name: 'SubagentStart', turn_id: 't', agent_id: 'sub-1', agent_type: 'worker' }, ctx);
    expect(e?.sessionId).toBe('parent-s');
    expect(e?.agentId).toBe('sub-1');
    expect(e?.parentAgentId).toBeNull();
    expect(e?.kind).toBe('agent.started');
  });

  it('Interrupt becomes turn.failed with reason interrupted', () => {
    const e = normalizeCodex({ session_id: 'c1', hook_event_name: 'Interrupt', turn_id: 't' }, ctx);
    expect(e?.kind).toBe('turn.failed');
    expect(e?.payload.reason).toBe('interrupted');
  });

  it('Stop is response completion', () => {
    expect(normalizeCodex({ session_id: 'c1', hook_event_name: 'Stop' }, ctx)?.kind).toBe('agent.response_completed');
  });
});

describe('summarizeToolResponse', () => {
  it('distinguishes failed / completed / unknown', () => {
    expect(summarizeToolResponse({ exit_code: 0 }, null).outcome).toBe('completed');
    expect(summarizeToolResponse({ exit_code: 1 }, null).outcome).toBe('failed');
    expect(summarizeToolResponse({ isError: false }, null).outcome).toBe('completed');
    expect(summarizeToolResponse({ output: 'hi' }, null).outcome).toBe('unknown');
    expect(summarizeToolResponse('plain text', null).outcome).toBe('unknown');
    expect(summarizeToolResponse(undefined, null).outcome).toBe('unknown');
    expect(summarizeToolResponse({ error: 'nope' }, null).outcome).toBe('failed');
  });
});
