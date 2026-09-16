import { useEffect, useMemo, useRef, useState } from 'react';

import { toolLabel } from '../../shared/activity.js';
import { getOwn } from '../../shared/dict.js';
import type { AgentEvent, AgentEventKind } from '../../shared/events.js';
import { sessionKey } from '../../shared/events.js';
import { clock } from '../format.js';
import { store, type TimelineFilters, useStore } from '../store.js';
import { PROVIDER_LABEL } from '../viewModel.js';

const KIND_LABEL: Record<AgentEventKind, string> = {
  'session.started': '세션 시작',
  'session.ended': '세션 종료',
  'turn.started': '요청 시작',
  'turn.completed': '요청 완료',
  'turn.failed': '턴 실패/중단',
  'agent.started': '에이전트 생성',
  'agent.response_completed': '응답 완료',
  'tool.started': '도구 시작',
  'tool.completed': '도구 완료',
  'tool.failed': '도구 실패',
  'approval.requested': '승인 요청',
  'approval.resolved': '승인 처리',
  notification: '알림',
  unknown: '해석 불가',
};

type KindGroup = keyof TimelineFilters['kinds'];

function groupOf(ev: AgentEvent): KindGroup {
  switch (ev.kind) {
    case 'tool.started':
    case 'tool.completed':
      return 'tool';
    case 'tool.failed':
    case 'turn.failed':
      return 'error';
    case 'agent.started':
    case 'agent.response_completed':
      return 'agent';
    case 'approval.requested':
    case 'approval.resolved':
      return 'approval';
    default:
      return 'session';
  }
}

function isErrorish(ev: AgentEvent): boolean {
  return (
    ev.kind === 'tool.failed' ||
    ev.kind === 'turn.failed' ||
    ev.payload.outcome === 'failed' ||
    ev.payload.outcome === 'denied'
  );
}

export function Timeline(): React.JSX.Element {
  const s = useStore();
  const events = store.viewEvents();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const filtered = useMemo(() => {
    const out: AgentEvent[] = [];
    for (const ev of events) {
      if (!s.filters.providers[ev.provider]) continue;
      const g = isErrorish(ev) ? 'error' : groupOf(ev);
      if (!s.filters.kinds[g]) continue;
      if (s.selection.sessionKey && sessionKey(ev.provider, ev.sessionId) !== s.selection.sessionKey) continue;
      out.push(ev);
    }
    return out.slice(-600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, events.length, s.filters, s.selection.sessionKey, s.replayCursor, s.mode]);

  useEffect(() => {
    if (follow && listRef.current && s.mode !== 'replay') {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered.length, follow, s.mode]);

  const kinds: Array<[KindGroup, string]> = [
    ['tool', '도구'],
    ['agent', '에이전트'],
    ['approval', '승인'],
    ['error', '오류'],
    ['session', '세션/턴'],
  ];

  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline-head">
        <h2>타임라인</h2>
        <div className="timeline-filters" role="group" aria-label="이벤트 필터">
          {kinds.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`chip ${s.filters.kinds[k] ? 'on' : ''}`}
              onClick={() => store.toggleKind(k)}
              aria-pressed={s.filters.kinds[k]}
              data-testid={`kind-${k}`}
            >
              {label}
            </button>
          ))}
        </div>
        {s.selection.sessionKey && (
          <button type="button" className="chip on" onClick={() => store.select(null, null)} title="세션 필터 해제">
            선택 세션만 ✕
          </button>
        )}
        <label className="toggle">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          따라가기
        </label>
        <span className="muted small">
          {filtered.length}개 표시
          {s.mode === 'live' && s.liveTruncated ? ' · 오래된 이벤트는 이력 모드에서' : ''}
        </span>
        {s.mode === 'replay' && (
          <div className="scrubber" data-testid="scrubber">
            <input
              type="range"
              min={0}
              max={s.replayEvents.length}
              value={s.replayCursor}
              onChange={(e) => store.setReplayCursor(Number(e.target.value))}
              aria-label="이력 위치"
            />
            <span className="muted small">
              {s.replayCursor} / {s.replayEvents.length}
              {s.replayTruncated ? ' (최근 5000개 범위)' : ''}
              {s.replayBase && s.replayBase.historyFromSeq > 0 ? ` · 순번 ${s.replayBase.historyFromSeq} 이전 이력 삭제됨` : ''}
            </span>
            <button type="button" className="btn tiny" onClick={() => store.setReplayCursor(Math.max(0, s.replayCursor - 1))}>
              ◀
            </button>
            <button type="button" className="btn tiny" onClick={() => store.setReplayCursor(Math.min(s.replayEvents.length, s.replayCursor + 1))}>
              ▶
            </button>
          </div>
        )}
      </div>
      <div className="timeline-list" ref={listRef} role="list">
        {filtered.length === 0 && <div className="muted small pad">표시할 이벤트가 없습니다.</div>}
        {filtered.map((ev) => {
          const key = sessionKey(ev.provider, ev.sessionId);
          const sess = getOwn(store.viewState().sessions, key);
          const err = isErrorish(ev);
          return (
            <div
              key={`${ev.ingestSeq}:${ev.eventId}`}
              role="listitem"
              className={`tl-row ${err ? 'tl-error' : ''} kind-${groupOf(ev)}`}
              onClick={() => store.select(key, ev.agentId)}
              data-testid="timeline-row"
            >
              <span className="tl-seq mono">{ev.ingestSeq}</span>
              <span className="tl-time mono">{clock(ev.receivedAt)}</span>
              <span className={`badge badge-${ev.provider}`}>{PROVIDER_LABEL[ev.provider]}</span>
              <span className="tl-session" title={ev.sessionId}>{sess?.projectName ?? ev.sessionId.slice(0, 8)}</span>
              <span className="tl-agent mono">{ev.agentId === 'main' ? '팀장' : ev.agentId.slice(0, 10)}</span>
              <span className="tl-kind">{KIND_LABEL[ev.kind]}</span>
              <span className="tl-detail">
                {ev.payload.toolName ? <b>{toolLabel(ev.payload.toolName)}</b> : null}
                {ev.payload.toolTarget ? ` · ${ev.payload.toolTarget}` : ''}
                {ev.payload.agentType ? ` · ${ev.payload.agentType}` : ''}
                {ev.payload.reason ? ` · ${ev.payload.reason}` : ''}
                {ev.payload.notificationType ? ` · ${ev.payload.notificationType}` : ''}
                {ev.payload.error ? ` · ${ev.payload.error}` : ''}
                {ev.payload.exitCode !== undefined ? ` · exit ${ev.payload.exitCode}` : ''}
                {ev.toolCallId === null && (ev.kind.startsWith('tool.') || ev.kind.startsWith('approval.')) ? ' · ID 없음' : ''}
                {ev.evidence === 'inferred' ? ' · 추정' : ''}
                {ev.source === 'transcript' ? ' · 트랜스크립트 기록' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
