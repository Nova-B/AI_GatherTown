import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { pingDiagnostics } from '../connection.js';
import { relTime } from '../format.js';
import { useStore } from '../store.js';

export function DiagnosticsPanel(): React.JSX.Element {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const d = s.diagnostics;
  return (
    <div className="section section-diag" data-testid="diagnostics">
      <button type="button" className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <h2>연결 · 수집 상태</h2>
        <span className={`conn-dot conn-${s.connection === 'open' ? 'ok' : s.connection === 'closed' ? 'bad' : 'warn'}`} />
      </button>
      {open && (
        <div className="diag-body">
          <dl className="kv">
            <dt>브라우저 연결</dt>
            <dd>{s.connectionDetail}</dd>
            <dt>서버</dt>
            <dd>{d ? `${d.host}:${d.port} · v${s.serverVersion ?? '?'}` : '정보 없음'}</dd>
            <dt>데이터 폴더</dt>
            <dd className="mono small">{d?.dataDir ?? '-'}</dd>
            <dt>저장 이벤트</dt>
            <dd>{d ? `${d.storedEvents}개` : '-'}{s.retention ? ` · 보관 ${s.retention.maxAgeDays}일 / ${s.retention.maxEvents.toLocaleString()}개` : ''}</dd>
            {d && d.historyFromSeq > 0 && (
              <>
                <dt>삭제된 이력</dt>
                <dd>순번 {d.historyFromSeq} 이하 · 세션 {d.prunedSessions}개</dd>
              </>
            )}
            <dt>Esc 감지</dt>
            <dd title="Claude 트랜스크립트에 남는 사용자 중단 표시를 1초 간격으로 확인합니다. 본문은 읽지 않습니다.">
              {d?.transcript
                ? `켜짐 · 감시 ${d.transcript.watching}개 세션 · 감지 ${d.transcript.markers}회${d.transcript.lastMarkerAt ? ` · 마지막 ${relTime(d.transcript.lastMarkerAt)}` : ''}${d.transcript.lastError ? ` · 오류 ${d.transcript.lastError}` : ''}`
                : '꺼짐 (다음 프롬프트에서만 반영)'}
            </dd>
          </dl>
          {d &&
            (['claude', 'codex'] as const).map((p) => {
              const pd = d.providers[p];
              return (
                <div key={p} className="diag-provider">
                  <span className={`badge badge-${p}`}>{p === 'claude' ? 'Claude' : 'Codex'}</span>
                  <span className="muted">
                    {pd.eventsReceived > 0
                      ? `수신 ${pd.eventsReceived}개 · 마지막 ${relTime(pd.lastEventAt)} (${pd.lastHookEventName})`
                      : '이 서버 실행 후 수신 없음'}
                  </span>
                  {pd.rejected > 0 && <span className="warn-tag">거부 {pd.rejected}{pd.lastError ? ` · ${pd.lastError}` : ''}</span>}
                </div>
              );
            })}
          <dl className="kv">
            <dt>훅 설치</dt>
            <dd className="mono small">node town/hook/install.mjs install --project &lt;폴더&gt;</dd>
            <dt>상태 확인</dt>
            <dd className="mono small">node town/hook/install.mjs status --project &lt;폴더&gt;</dd>
            <dt>Codex</dt>
            <dd className="small">CLI에서 /hooks 로 신뢰 확인 필요</dd>
          </dl>
          <button type="button" className="btn tiny" onClick={() => pingDiagnostics()}>
            <RefreshCw size={12} /> 새로고침
          </button>
        </div>
      )}
    </div>
  );
}
