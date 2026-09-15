/**
 * Retrospective material: metrics and Markdown built from observed events only.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getOwn } from '../src/shared/dict.js';
import { buildRetrospect, fmtDuration, USER_NOTES_MARKER, withUserNotes } from '../src/shared/retrospect.js';
import { applyEvents, createInitialState, type TownState } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

beforeEach(() => resetCounter());

/** A two-turn session: lead reads serially, delegates, one approval, one repeated failure. */
function sample(): { st: TownState; events: ReturnType<typeof ev>[] } {
  const st = createInitialState();
  const events = [
    ev('claude', { session_id: 's', hook_event_name: 'SessionStart', cwd: 'C:/p/webshop', model: 'claude-fable-5-1' }),
    ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'src/a.ts' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_response: {} }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r2', tool_input: { file_path: 'src/b.ts' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r2', tool_response: {} }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'login' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_response: {} }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: '쿠키 처리 탐색', subagent_type: 'Explore' } }),
    ev('claude', { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'kid', agent_type: 'Explore' }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', agent_id: 'kid', tool_name: 'Grep', tool_use_id: 'kg', tool_input: { pattern: 'cookie' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', agent_id: 'kid', tool_name: 'Grep', tool_use_id: 'kg', tool_response: {} }),
    ev('claude', { session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'kid', agent_type: 'Explore' }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_response: {} }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_response: { exit_code: 0 } }),
    ev('claude', { session_id: 's', hook_event_name: 'Stop', prompt_id: 'p1' }),
    ev('claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p2' }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'src/a.ts' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_use_id: 'e1', error: 'not found' }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'e2', tool_input: { file_path: 'src/a.ts' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_use_id: 'e2', error: 'not found' }),
    ev('claude', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'e3', tool_input: { file_path: 'src/a.ts' } }),
    ev('claude', { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'e3', tool_response: {} }),
    ev('claude', { session_id: 's', hook_event_name: 'Stop', prompt_id: 'p2' }),
  ];
  applyEvents(st, events);
  return { st, events };
}

describe('buildRetrospect', () => {
  it('segments turns, counts agents and tools, and measures approval wait', () => {
    const { st, events } = sample();
    const r = buildRetrospect(st, events, { sessionKey: 'claude:s' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.metrics.turns).toBe(2);
    expect(r.metrics.agents).toBe(2);
    expect(r.metrics.subagents).toBe(1);
    expect(r.metrics.toolCalls).toBe(9);
    expect(r.metrics.toolFailed).toBe(2);
    expect(r.metrics.waits.approvals).toBe(1);
    expect(r.metrics.waits.approvalMs).toBe(4000); // PermissionRequest at t13 → PostToolUse at t17 (1 s per event)
    expect(r.eventCount).toBe(events.length);
    expect(r.metrics.partialHistory).toBe(false);
  });

  it('measures tool parallelism from observed intervals', () => {
    const { st, events } = sample();
    const r = buildRetrospect(st, events, { sessionKey: 'claude:s' });
    if ('error' in r) throw new Error(r.error);
    // Agent a1 (t9-t16), kid Grep (t11-t14) and Bash b1 (t12-t17) overlap → 3 at once.
    expect(r.metrics.parallel.max).toBe(3);
    expect(r.metrics.parallel.soloRatio).toBeLessThan(1);
    expect(r.metrics.parallel.activeMs).toBeGreaterThan(0);
    expect(r.metrics.subagentsAtOnce).toBe(1);
  });

  it('flags a serial exploration chain, a light delegation and a repeated failure as candidates, not conclusions', () => {
    const { st, events } = sample();
    const r = buildRetrospect(st, events, { sessionKey: 'claude:s' });
    if ('error' in r) throw new Error(r.error);
    const kinds = r.metrics.candidates.map((c) => c.kind);
    expect(kinds).toContain('serial-chain'); // lead: Read, Read, Grep back to back
    expect(kinds).toContain('light-delegation'); // kid: one Grep
    expect(kinds).toContain('repeated-failure'); // Edit src/a.ts failed twice then succeeded
    expect(kinds).toContain('approval-wait');
    expect(kinds).toContain('model-choice'); // kid explored only, on the session model
    const fail = r.metrics.candidates.find((c) => c.kind === 'repeated-failure')!;
    expect(fail.text).toContain('2회 실패 후 성공');
    expect(r.markdown).toContain('## 3. 검토 후보 (지표가 가리킨 것, 결론 아님)');
  });

  it('writes a Markdown document with header, summary, per-turn timeline, task link label and questions', () => {
    const { st, events } = sample();
    const r = buildRetrospect(st, events, { sessionKey: 'claude:s' });
    if ('error' in r) throw new Error(r.error);
    const md = r.markdown;
    expect(md.startsWith('# 작업 회고 요청 — webshop · s ·')).toBe(true);
    expect(md).toContain(`## 0. 사용자 관찰 (먼저 읽을 것)\n${USER_NOTES_MARKER}\n(없음)`);
    expect(md).toContain('모델 claude-fable-5-1');
    expect(md).toContain('### 턴 1 (');
    expect(md).toContain('### 턴 2 (');
    expect(md).toContain('팀장 Read src/a.ts (완료 1초)');
    expect(md).toContain('직원 시작 · Explore — 담당 "쿠키 처리 탐색" (추정 연결)');
    expect(md).toContain('승인 요청 Bash npm test');
    expect(md).toContain('Edit src/a.ts (실패: not found)');
    expect(md).toContain('## 4. 회고 질문');
    // Nothing that is not observed: no prompt, no transcript, no file body.
    expect(md).not.toMatch(/prompt|transcript/i);
  });

  it('last-turn scope keeps only the final turn', () => {
    const { st, events } = sample();
    const r = buildRetrospect(st, events, { sessionKey: 'claude:s', scope: 'last-turn' });
    if ('error' in r) throw new Error(r.error);
    expect(r.metrics.turns).toBe(1);
    expect(r.metrics.toolCalls).toBe(3);
    expect(r.metrics.subagents).toBe(0);
    expect(r.markdown).toContain('마지막 턴만');
    expect(r.markdown).not.toContain('### 턴 1 (');
    expect(r.markdown).toContain('### 턴 2 (');
  });

  it('a seq upper bound (paused/replay view) cuts the material there and marks the history partial', () => {
    const { st, events } = sample();
    const cut = events[17]!.ingestSeq; // through the first Stop
    const r = buildRetrospect(st, events, { sessionKey: 'claude:s', toSeq: cut });
    if ('error' in r) throw new Error(r.error);
    expect(r.metrics.turns).toBe(1);
    expect(r.toSeq).toBe(cut);
    expect(r.metrics.partialHistory).toBe(true);
    expect(r.metrics.toolCalls).toBe(6);
  });

  it('refuses unknown and demo sessions and empty ranges', () => {
    const { st, events } = sample();
    expect(buildRetrospect(st, events, { sessionKey: 'claude:nope' })).toEqual({ error: 'unknown-session' });
    expect(buildRetrospect(st, events, { sessionKey: 'claude:s', fromSeq: 10_000 })).toEqual({ error: 'no-events' });
    const demo = createInitialState();
    const d = ev('claude', { session_id: 'd', hook_event_name: 'SessionStart' });
    d.source = 'demo';
    applyEvents(demo, [d]);
    expect(getOwn(demo.sessions, 'claude:d')!.source).toBe('demo');
    expect(buildRetrospect(demo, [d], { sessionKey: 'claude:d' })).toEqual({ error: 'demo-session' });
  });

  it('ignores other sessions\' events mixed into the input', () => {
    const { st, events } = sample();
    const other = ev('codex', { session_id: 'x', hook_event_name: 'SessionStart' });
    applyEvents(st, [other]);
    const r = buildRetrospect(st, [other, ...events], { sessionKey: 'claude:s' });
    if ('error' in r) throw new Error(r.error);
    expect(r.eventCount).toBe(events.length);
  });

  it('with no candidates the section says so', () => {
    const st = createInitialState();
    const events = [
      ev('codex', { session_id: 'q', hook_event_name: 'SessionStart' }),
      ev('codex', { session_id: 'q', hook_event_name: 'UserPromptSubmit', turn_id: 't1' }),
      ev('codex', { session_id: 'q', hook_event_name: 'Stop', turn_id: 't1' }),
    ];
    applyEvents(st, events);
    const r = buildRetrospect(st, events, { sessionKey: 'codex:q' });
    if ('error' in r) throw new Error(r.error);
    expect(r.metrics.candidates).toEqual([]);
    expect(r.markdown).toContain('- 지표상 두드러진 후보 없음');
    expect(r.markdown).toContain('### 턴 시작 전');
  });
});

describe('withUserNotes / fmtDuration', () => {
  it('inserts the user notes under §0 and leaves the placeholder when empty', () => {
    const md = `## 0\n${USER_NOTES_MARKER}\n(없음)\n\n## 1`;
    expect(withUserNotes(md, '  ')).toBe(md);
    expect(withUserNotes(md, '팀장이 다 했다\r\n둘째 줄')).toBe(`## 0\n${USER_NOTES_MARKER}\n팀장이 다 했다\n둘째 줄\n\n## 1`);
  });

  it('formats durations in Korean', () => {
    expect(fmtDuration(400)).toBe('400ms');
    expect(fmtDuration(4000)).toBe('4초');
    expect(fmtDuration(65_000)).toBe('1분 5초');
    expect(fmtDuration(3_720_000)).toBe('1시간 2분');
  });
});
