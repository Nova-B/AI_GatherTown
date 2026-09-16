/** Session list order: 진행 중 → 대기 중 → 종료, then recency. */
import { beforeEach, describe, expect, it } from 'vitest';

import { sessionGroup, sortSessions, STALE_AFTER_MS } from '../src/client/viewModel.js';
import { getOwn } from '../src/shared/dict.js';
import { applyEvent, applyEvents, createInitialState, type SessionState } from '../src/shared/state.js';
import { ev, resetCounter } from './helpers.js';

beforeEach(() => resetCounter());

describe('session groups and order', () => {
  it('groups by running turn / running tool / pending approval, idle, ended', () => {
    const st = createInitialState();
    applyEvents(st, [
      ev('claude', { session_id: 'turn', hook_event_name: 'UserPromptSubmit', prompt_id: 'p' }),
      ev('claude', { session_id: 'tool', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 'tool', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'ls' } }),
      ev('claude', { session_id: 'appr', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 'appr', hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
      ev('claude', { session_id: 'idle', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 'done', hook_event_name: 'UserPromptSubmit', prompt_id: 'q' }),
      ev('claude', { session_id: 'done', hook_event_name: 'Stop', prompt_id: 'q' }),
      ev('claude', { session_id: 'end', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 'end', hook_event_name: 'SessionEnd' }),
    ]);
    const g = (id: string) => sessionGroup(getOwn(st.sessions, `claude:${id}`)!);
    expect(g('turn')).toBe('working');
    expect(g('tool')).toBe('working');
    expect(g('appr')).toBe('working');
    expect(g('idle')).toBe('idle');
    expect(g('done')).toBe('idle');
    expect(g('end')).toBe('ended');
  });

  it('sorts working first, then idle (stale last), then ended; recency inside a group', () => {
    const st = createInitialState();
    const now = Date.now();
    const at = (s: SessionState, msAgo: number) => {
      s.lastEventAt = new Date(now - msAgo).toISOString();
    };
    applyEvents(st, [
      ev('claude', { session_id: 'old-work', hook_event_name: 'UserPromptSubmit', prompt_id: 'a' }),
      ev('claude', { session_id: 'ended', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 'ended', hook_event_name: 'SessionEnd' }),
      ev('claude', { session_id: 'stale-idle', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 'fresh-idle', hook_event_name: 'SessionStart' }),
      ev('claude', { session_id: 'new-work', hook_event_name: 'UserPromptSubmit', prompt_id: 'b' }),
    ]);
    const s = (id: string) => getOwn(st.sessions, `claude:${id}`)!;
    at(s('old-work'), 60_000);
    at(s('new-work'), 1_000);
    at(s('stale-idle'), STALE_AFTER_MS + 60_000);
    at(s('fresh-idle'), 5_000);
    at(s('ended'), 500); // most recent of all, still last
    const order = sortSessions(Object.values(st.sessions), now).map((x) => x.sessionId);
    expect(order).toEqual(['new-work', 'old-work', 'fresh-idle', 'stale-idle', 'ended']);
    // A session that starts working moves up without any other change.
    applyEvent(st, ev('claude', { session_id: 'fresh-idle', hook_event_name: 'UserPromptSubmit', prompt_id: 'c' }));
    at(s('fresh-idle'), 0);
    expect(sortSessions(Object.values(st.sessions), now).map((x) => x.sessionId)[0]).toBe('fresh-idle');
  });
});
