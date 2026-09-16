import { Crosshair } from 'lucide-react';
import { Fragment } from 'react';

import { getOwn, ownValues } from '../../shared/dict.js';
import { agentDisplayStatus, type SessionState } from '../../shared/state.js';
import { relTime } from '../format.js';
import { store, useStore } from '../store.js';
import { isStale, PROVIDER_LABEL, SESSION_GROUP_LABEL_KO, type SessionGroup, sessionGroup, sortSessions } from '../viewModel.js';

function lifecycleLabel(s: SessionState, stale: boolean): string {
  if (s.lifecycle === 'ended') return '종료';
  if (stale) return '최근 활동 없음';
  if (s.currentTurn?.status === 'running') return '작업 중';
  if (s.currentTurn?.status === 'failed') return '턴 실패';
  if (s.currentTurn?.status === 'interrupted') return '중단';
  if (s.lifecycle === 'active') return '대기';
  return '상태 미확인';
}

export function SessionList(): React.JSX.Element {
  const s = useStore();
  const view = store.viewState();
  const now = Date.now();
  const sessions = sortSessions(
    view.sessionOrder
      .map((k) => getOwn(view.sessions, k))
      .filter((x): x is SessionState => !!x && s.filters.providers[x.provider]),
    now,
  );
  let lastGroup: SessionGroup | null = null;
  return (
    <div className="section">
      <div className="section-head">
        <h2>세션</h2>
        <span className="muted">{sessions.length}개</span>
        {view.prunedSessions > 0 && (
          <span className="muted small" title="보관 기간이 지나 이력이 삭제된 세션">
            삭제 {view.prunedSessions}
          </span>
        )}
      </div>
      {sessions.length === 0 && <p className="muted small">세션 없음</p>}
      <ul className="session-list" role="listbox" aria-label="세션 목록">
        {sessions.map((sess) => {
          const agents = ownValues(sess.agents);
          const running = agents.reduce((n, a) => n + a.activeToolIds.length, 0);
          const approvals = agents.reduce((n, a) => n + a.pendingApprovalIds.length, 0);
          const failed = agents.some((a) => agentDisplayStatus(sess, a) === 'failed');
          const stale = isStale(sess, now);
          const selected = s.selection.sessionKey === sess.key;
          const stateClass =
            sess.lifecycle === 'ended' || stale
              ? 'ended'
              : failed
                ? 'failed'
                : approvals > 0
                  ? 'approval'
                  : sess.currentTurn?.status === 'running'
                    ? 'working'
                    : 'idle';
          const group = sessionGroup(sess);
          const showHeader = group !== lastGroup;
          lastGroup = group;
          return (
            <Fragment key={sess.key}>
              {showHeader && (
                <li role="presentation" className={`session-group session-group-${group}`} data-testid="session-group">
                  {SESSION_GROUP_LABEL_KO[group]}
                </li>
              )}
            <li
              className={`session-item ${selected ? 'selected' : ''} ${sess.lifecycle === 'ended' ? 'ended' : ''}`}
              data-group={group}
              role="option"
              aria-selected={selected}
              tabIndex={0}
              data-testid="session-item"
              onClick={() => store.select(sess.key, null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  store.select(sess.key, null);
                }
              }}
            >
              <div className="session-row">
                <span className={`badge badge-${sess.provider}`}>{PROVIDER_LABEL[sess.provider]}</span>
                <span className="session-name" title={sess.cwd ?? sess.sessionId}>
                  {sess.projectName ?? sess.sessionId.slice(0, 12)}
                </span>
                <button
                  type="button"
                  className="btn icon tiny"
                  title="사무실에서 위치 보기"
                  aria-label="사무실에서 위치 보기"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.focus(sess.key, null);
                  }}
                >
                  <Crosshair size={13} />
                </button>
              </div>
              <div className="session-meta">
                <span className={`state state-${stateClass}`}>
                  {approvals > 0 ? `승인 대기 ${approvals}` : failed ? '실패 있음' : lifecycleLabel(sess, stale)}
                </span>
                <span className="muted mono" title="모델 (SessionStart/모델 전환 훅 기준)">
                  {sess.model ?? '모델 미제공'}
                </span>
                <span className="muted">에이전트 {agents.length}</span>
                <span className="muted">도구 {running}</span>
                <span className="muted">{relTime(sess.lastEventAt, now)}</span>
              </div>
              {sess.source === 'demo' && <span className="demo-tag">DEMO</span>}
            </li>
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
}
