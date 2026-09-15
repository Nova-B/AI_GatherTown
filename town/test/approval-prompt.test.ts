/**
 * Claude Code announces a permission prompt twice (PermissionRequest with a
 * tool_use_id, Notification permission_prompt without one). The id-less
 * record must not keep the agent in "승인 대기" after the user answered and
 * the tool ran.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getOwn, ownValues } from '../src/shared/dict.js';
import { agentDisplayStatus, applyEvent, applyEvents, createInitialState, toolKey, type TownState } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

beforeEach(() => resetCounter());

const sess = (st: TownState) => getOwn(st.sessions, 'claude:s')!;

describe('permission prompt announced twice', () => {
  it('Notification then PermissionRequest then PostToolUse: the agent works, then is done - never stuck awaiting', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }),
      ev('claude', { session_id: 's', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
    ]);
    const s = sess(st);
    const main = s.agents.main!;
    expect(agentDisplayStatus(s, main)).toBe('awaiting_approval');
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }));
    // Still awaiting (the precise request is pending), but only one pending record remains.
    expect(agentDisplayStatus(s, main)).toBe('awaiting_approval');
    expect(main.pendingApprovalIds).toEqual([toolKey('main', 'b1')]);
    const idless = ownValues(s.approvals).find((ap) => !ap.idKnown)!;
    expect(idless.status).toBe('resolved');
    expect(idless.resolutionEvidence).toBe('inferred');
    expect(idless.decision).toBe('unknown');
    // User approved in the CLI; the tool ran and completed.
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_response: { exit_code: 0 } }));
    expect(main.pendingApprovalIds).toEqual([]);
    expect(agentDisplayStatus(s, main)).toBe('working'); // turn still running
    const precise = getOwn(s.approvals, toolKey('main', 'b1'))!;
    expect(precise.decision).toBe('allowed');
    expect(precise.resolutionEvidence).toBe('observed');
  });

  it('PermissionRequest then Notification: the id-less record is not created at all', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'git push' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'b1' }),
      ev('claude', { session_id: 's', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' }),
    ]);
    const s = sess(st);
    expect(ownValues(s.approvals)).toHaveLength(1);
    expect(s.duplicatesIgnored).toBe(1);
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('awaiting_approval');
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_response: {} }));
    expect(agentDisplayStatus(s, s.agents.main!)).not.toBe('awaiting_approval');
  });

  it('Notification only (no PermissionRequest hook): the next tool activity of that agent clears it, labelled inferred', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
      ev('claude', { session_id: 's', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' }),
    ]);
    const s = sess(st);
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('awaiting_approval');
    applyEvent(st, ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'a.ts' } }));
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('working');
    const ap = ownValues(s.approvals)[0]!;
    expect(ap.status).toBe('resolved');
    expect(ap.resolutionEvidence).toBe('inferred');
    expect(ap.decision).toBe('unknown');
  });

  it('a known-id approval of the same agent is never cleared by another tool finishing', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.ts' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm -rf dist' } }),
      ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'b1' }),
      ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_response: {} }),
    ]);
    const s = sess(st);
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('awaiting_approval');
    expect(getOwn(s.approvals, toolKey('main', 'b1'))!.status).toBe('pending');
  });

  it('id-less prompts are scoped per agent: a child proceeding does not clear the lead\'s prompt', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 's', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' }),
      ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid' }),
      ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' } }),
    ]);
    const s = sess(st);
    expect(agentDisplayStatus(s, s.agents.main!)).toBe('awaiting_approval');
  });
});
