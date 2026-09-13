import { Crosshair } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ACTIVITY_LABEL_KO } from '../../shared/activity.js';
import { getOwn, ownValues } from '../../shared/dict.js';
import {
  AGENT_STATUS_LABEL_KO,
  agentDisplayStatus,
  type SessionState,
  TOOL_STATUS_LABEL_KO,
} from '../../shared/state.js';
import { elapsed, relTime } from '../format.js';
import { store, useStore } from '../store.js';
import { isStale, PROVIDER_LABEL, roleLabel } from '../viewModel.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export function DetailsPanel(): React.JSX.Element {
  const s = useStore();
  const now = useNow();
  const view = store.viewState();
  const session = s.selection.sessionKey ? getOwn(view.sessions, s.selection.sessionKey) : undefined;
  const agent = session && s.selection.agentId ? getOwn(session.agents, s.selection.agentId) : undefined;

  return (
    <div className="details">
      {!session && (
        <div className="section">
          <div className="section-head">
            <h2>상세</h2>
            <span className="muted small">선택 없음</span>
          </div>
        </div>
      )}
      {session && !agent && <SessionDetails session={session} now={now} />}
      {session && agent && <AgentDetails session={session} agentId={agent.id} now={now} />}
      <DiagnosticsPanel />
    </div>
  );
}

function SessionDetails({ session, now }: { session: SessionState; now: number }): React.JSX.Element {
  const agents = ownValues(session.agents);
  const stale = isStale(session, now);
  return (
    <div className="section" data-testid="session-details">
      <div className="section-head">
        <h2>세션</h2>
        <span className={`badge badge-${session.provider}`}>{PROVIDER_LABEL[session.provider]}</span>
      </div>
      <dl className="kv">
        <dt>프로젝트</dt>
        <dd title={session.cwd ?? ''}>{session.projectName ?? '-'}</dd>
        <dt>세션 ID</dt>
        <dd className="mono">{session.sessionId}</dd>
        <dt>모델</dt>
        <dd>{session.model ?? '미제공'}</dd>
        <dt>상태</dt>
        <dd>
          {session.lifecycle === 'ended' ? '종료' : session.lifecycle === 'active' ? '활성' : '미확인'}
          {stale ? ' · 최근 활동 없음' : ''}
        </dd>
        <dt>현재 턴</dt>
        <dd>
          {session.currentTurn
            ? `${session.currentTurn.status === 'running' ? '진행 중' : session.currentTurn.status === 'completed' ? '완료' : session.currentTurn.status === 'failed' ? '실패' : '중단'} · ${elapsed(session.currentTurn.startedAt, session.currentTurn.endedAt, now)}`
            : '없음'}
        </dd>
        <dt>마지막 이벤트</dt>
        <dd>{relTime(session.lastEventAt, now)}</dd>
        <dt>이벤트</dt>
        <dd>
          {session.eventCount}개{session.duplicatesIgnored > 0 ? ` · 중복 무시 ${session.duplicatesIgnored}` : ''}
          {session.unknownEvents > 0 ? ` · 해석 불가 ${session.unknownEvents}` : ''}
        </dd>
      </dl>
      <h3>에이전트</h3>
      <ul className="agent-list">
        {agents.map((a) => {
          const st = agentDisplayStatus(session, a);
          return (
            <li key={a.id}>
              <button type="button" className="agent-row" onClick={() => store.select(session.key, a.id)} data-testid="agent-row">
                <span className={`dot dot-${st}`} />
                <span className="agent-name">{roleLabel(a)}</span>
                <span className="muted">{AGENT_STATUS_LABEL_KO[st]}</span>
                {a.activeToolIds.length > 0 && <span className="muted">도구 {a.activeToolIds.length}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AgentDetails({ session, agentId, now }: { session: SessionState; agentId: string; now: number }): React.JSX.Element {
  const a = getOwn(session.agents, agentId)!;
  const st = agentDisplayStatus(session, a);
  const calls = ownValues(session.toolCalls)
    .filter((t) => t.agentId === a.id)
    .sort((x, y) => y.startSeq - x.startSeq);
  const running = calls.filter((t) => t.status === 'running');
  const recent = calls.filter((t) => t.status !== 'running').slice(0, 8);
  const approvals = ownValues(session.approvals)
    .filter((ap) => ap.agentId === a.id)
    .sort((x, y) => y.requestSeq - x.requestSeq);
  const parent = a.parentAgentId ? getOwn(session.agents, a.parentAgentId) : undefined;
  return (
    <div className="section" data-testid="agent-details">
      <div className="section-head">
        <h2>{roleLabel(a)}</h2>
        <span className={`badge badge-${session.provider}`}>{PROVIDER_LABEL[session.provider]}</span>
        <button type="button" className="btn icon tiny" title="캐릭터로 이동" aria-label="캐릭터로 이동" onClick={() => store.focus(session.key, a.id)}>
          <Crosshair size={13} />
        </button>
      </div>
      <div className={`status-line status-${st}`} data-testid="agent-status">
        {AGENT_STATUS_LABEL_KO[st]}
      </div>
      <dl className="kv">
        <dt>세션 소속</dt>
        <dd>
          <button type="button" className="linkish" onClick={() => store.select(session.key, null)}>
            {session.projectName ?? session.sessionId.slice(0, 12)}
          </button>
        </dd>
        <dt>에이전트 ID</dt>
        <dd className="mono">
          {a.id}
          {a.idOrigin === 'internal-main' ? ' (내부 지정)' : ''}
        </dd>
        {a.agentType && (
          <>
            <dt>유형</dt>
            <dd>{a.agentType}</dd>
          </>
        )}
        <dt>직접 상위</dt>
        <dd data-testid="agent-parent">
          {a.role === 'main' ? '없음 (루트)' : parent ? roleLabel(parent) : '미확인'}
        </dd>
        <dt>시작</dt>
        <dd>{relTime(a.startedAt, now)}</dd>
        <dt>마지막 활동</dt>
        <dd>{relTime(a.lastActivityAt, now)}</dd>
        <dt>응답 완료</dt>
        <dd>
          {a.responsesCompleted}회
          {a.lastResponse ? ` · 최근: ${a.lastResponse === 'completed' ? '완료' : a.lastResponse === 'failed' ? '실패' : '중단'}` : ''}
        </dd>
        {a.lastError && (
          <>
            <dt>마지막 오류</dt>
            <dd className="error-text">{a.lastError}</dd>
          </>
        )}
      </dl>

      <h3>진행 중 도구 ({running.length})</h3>
      {running.length === 0 && <p className="muted small">없음</p>}
      <ul className="tool-list" data-testid="running-tools">
        {running.map((t) => (
          <li key={t.id} className="tool-item running">
            <span className="tool-name">{t.toolName}</span>
            <span className="tool-target" title={t.target ?? ''}>{t.target ?? ''}</span>
            <span className="muted">
              {ACTIVITY_LABEL_KO[t.activity]} · {elapsed(t.startedAt, null, now)}
            </span>
            {!t.idKnown && <span className="warn-tag">ID 없음</span>}
          </li>
        ))}
      </ul>

      {approvals.some((ap) => ap.status === 'pending') && (
        <>
          <h3>승인 대기</h3>
          <ul className="tool-list" data-testid="pending-approvals">
            {approvals
              .filter((ap) => ap.status === 'pending')
              .map((ap) => (
                <li key={ap.id} className="tool-item approval">
                  <span className="tool-name">{ap.toolName ?? '도구 미확인'}</span>
                  <span className="tool-target">{ap.target ?? ''}</span>
                  <span className="muted">{relTime(ap.requestedAt, now)} · 원래 CLI에서 처리</span>
                  {!ap.idKnown && <span className="warn-tag">도구 연결 불가</span>}
                </li>
              ))}
          </ul>
        </>
      )}

      <h3>최근 도구</h3>
      {recent.length === 0 && <p className="muted small">없음</p>}
      <ul className="tool-list" data-testid="recent-tools">
        {recent.map((t) => (
          <li key={t.id} className={`tool-item ${t.status}`}>
            <span className="tool-name">{t.toolName}</span>
            <span className="tool-target" title={t.sourceId ?? ''}>{t.target ?? ''}</span>
            <span className={`tool-status tool-status-${t.status}`}>
              {TOOL_STATUS_LABEL_KO[t.status]}
              {t.exitCode !== null && t.exitCode !== undefined ? ` · exit ${t.exitCode}` : ''}
            </span>
            {t.error && <span className="error-text small">{t.error}</span>}
            {t.outOfOrder && <span className="warn-tag">종료 먼저 수신</span>}
            {t.lateOutcome && <span className="warn-tag">응답 종료 후 결과 수신</span>}
            {!t.idKnown && <span className="warn-tag">ID 없음</span>}
          </li>
        ))}
      </ul>
      {approvals.some((ap) => ap.status === 'resolved') && (
        <>
          <h3>승인 이력</h3>
          <ul className="tool-list">
            {approvals
              .filter((ap) => ap.status === 'resolved')
              .slice(0, 5)
              .map((ap) => (
                <li key={ap.id} className="tool-item">
                  <span className="tool-name">{ap.toolName ?? '도구 미확인'}</span>
                  <span className="muted">
                    {ap.decision === 'allowed' ? '진행됨' : ap.decision === 'denied' ? '거부됨' : '결과 미확인'}
                    {ap.resolutionEvidence === 'inferred' ? ' (턴 종료로 추정)' : ''}
                  </span>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}
