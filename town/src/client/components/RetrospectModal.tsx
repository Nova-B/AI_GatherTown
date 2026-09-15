/**
 * "작업 회고 자료" modal: fetches the retrospective Markdown for one session
 * from the server, lets the user write their own observations first (kept
 * in the browser only), and copies the merged text for pasting into the CLI
 * session that did the work. No LLM is called from here.
 */
import { Check, Copy, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { fmtDuration, type RetrospectScope, withUserNotes } from '../../shared/retrospect.js';
import { fetchRetrospect, type RetrospectResponse } from '../connection.js';

interface Props {
  sessionKey: string;
  title: string;
  /** Upper seq bound (paused/replay views); null = everything stored. */
  toSeq: number | null;
  onClose(): void;
}

export function RetrospectModal({ sessionKey, title, toSeq, onClose }: Props): React.JSX.Element {
  const [scope, setScope] = useState<RetrospectScope>('all');
  const [notes, setNotes] = useState('');
  const [data, setData] = useState<RetrospectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRetrospect(sessionKey, { scope, toSeq })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setData(null);
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey, scope, toSeq]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const text = useMemo(() => (data ? withUserNotes(data.markdown, notes) : ''), [data, notes]);

  const copy = async (): Promise<void> => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = textRef.current;
      if (ta) {
        ta.focus();
        ta.select();
        document.execCommand('copy');
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const m = data?.metrics ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="retrospect-modal">
      <div className="modal" role="dialog" aria-modal="true" aria-label="작업 회고 자료" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>작업 회고 자료 · {title}</h2>
          <button type="button" className="btn icon" onClick={onClose} aria-label="닫기" data-testid="retrospect-close">
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="muted small">
            훅으로 관측된 사실(턴·에이전트·도구·승인)만 담깁니다. 프롬프트나 응답 본문은 없습니다. 복사한 뒤 이 작업을 수행한
            CLI 세션에 붙여넣어 회고를 요청하세요. 아래 관찰 메모는 브라우저 밖으로 나가지 않습니다.
          </p>
          <div className="modal-row">
            <span className="muted small">범위</span>
            <label className="toggle">
              <input type="radio" name="retro-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> 전체 세션
            </label>
            <label className="toggle">
              <input type="radio" name="retro-scope" checked={scope === 'last-turn'} onChange={() => setScope('last-turn')} /> 마지막 턴
            </label>
            {m && (
              <span className="muted small modal-metrics" data-testid="retrospect-metrics">
                턴 {m.turns} · 도구 {m.toolCalls}(실패 {m.toolFailed}) · 병렬 최대 {m.parallel.max} · 승인 대기{' '}
                {fmtDuration(m.waits.approvalMs)} · 후보 {m.candidates.length}
                {m.partialHistory ? ' · 이력 일부 범위 밖' : ''}
              </span>
            )}
          </div>
          <label className="modal-label" htmlFor="retro-notes">
            0. 사용자 관찰 — 이 실행에서 직접 눈에 걸린 점을 먼저 적으세요
          </label>
          <textarea
            id="retro-notes"
            className="modal-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="예: 팀장이 파일을 하나씩 읽는 동안 나는 기다리기만 했다. 승인 3번은 전부 같은 명령이었다."
            data-testid="retrospect-notes"
          />
          {!notes.trim() && (
            <p className="muted small">관찰을 먼저 적으면 회고가 달라집니다. 비워 둔 채 복사해도 됩니다.</p>
          )}
          {loading && <p className="muted small">생성 중…</p>}
          {error && <p className="error-text small">불러오기 실패: {error}</p>}
          {data && (
            <textarea
              ref={textRef}
              className="modal-text mono"
              readOnly
              value={text}
              spellCheck={false}
              data-testid="retrospect-text"
            />
          )}
          {data?.truncated && <p className="warn-tag">이벤트가 상한(5000)에 걸려 앞부분이 생략되었습니다.</p>}
        </div>
        <div className="modal-foot">
          <span className="muted small">{data ? `seq ${data.fromSeq}~${data.toSeq} · 이벤트 ${data.eventCount}개` : ''}</span>
          <button type="button" className={`btn ${copied ? 'on' : ''}`} onClick={() => void copy()} disabled={!data} data-testid="retrospect-copy">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? '복사됨' : '복사'}
          </button>
        </div>
      </div>
    </div>
  );
}
