import {
  Activity,
  History,
  Maximize2,
  Pause,
  Play,
  PlugZap,
  Radio,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { fetchReplayWindow } from '../connection.js';
import { exitDemo, startDemo } from '../demo.js';
import { playChime, saveSoundEnabled } from '../sound.js';
import { store, useStore } from '../store.js';

export function TopBar(): React.JSX.Element {
  const s = useStore();
  const connColor = s.connection === 'open' ? 'ok' : s.connection === 'closed' ? 'bad' : 'warn';
  const connLabel =
    s.connection === 'open'
      ? '연결됨'
      : s.connection === 'connecting'
        ? '연결 중'
        : s.connection === 'reconnecting'
          ? '재연결 중'
          : '연결 끊김';

  const onReplay = async (): Promise<void> => {
    try {
      const { baseState, events, truncated } = await fetchReplayWindow();
      store.enterReplay(baseState, events, truncated);
    } catch (err) {
      store.setConnection(s.connection, `이력 불러오기 실패: ${(err as Error).message}`);
    }
  };

  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar-row">
        <div className="brand">
          <span className="brand-name">Agent Town</span>
          <span className="brand-sub">Claude · Codex 픽셀 사무실 관측</span>
        </div>
        <div className="topbar-spacer" />
        <div className={`conn conn-${connColor}`} data-testid="conn-status" title={s.connectionDetail}>
          {s.connection === 'open' ? <Activity size={14} /> : <PlugZap size={14} />}
          <span>{connLabel}</span>
        </div>
      </div>
      <div className="topbar-row topbar-controls">
        <div className="topbar-group" role="group" aria-label="CLI 필터">
          <button
            type="button"
            className={`chip chip-claude ${s.filters.providers.claude ? 'on' : ''}`}
            onClick={() => store.toggleProvider('claude')}
            data-testid="filter-claude"
            aria-pressed={s.filters.providers.claude}
          >
            Claude
          </button>
          <button
            type="button"
            className={`chip chip-codex ${s.filters.providers.codex ? 'on' : ''}`}
            onClick={() => store.toggleProvider('codex')}
            data-testid="filter-codex"
            aria-pressed={s.filters.providers.codex}
          >
            Codex
          </button>
        </div>
        <div className="topbar-group" role="group" aria-label="보기 모드">
          {s.mode === 'demo' ? (
            <button type="button" className="btn btn-demo on" onClick={() => exitDemo()} data-testid="demo-toggle">
              <Radio size={14} /> DEMO 종료
            </button>
          ) : (
            <>
              {s.mode === 'live' ? (
                <button type="button" className="btn" onClick={() => store.pause()} data-testid="pause-btn" title="화면을 멈추고 실시간 수집은 계속">
                  <Pause size={14} /> <span className="btn-label">일시정지</span>
                </button>
              ) : (
                <button type="button" className="btn btn-live" onClick={() => store.resumeLive()} data-testid="live-btn">
                  <Play size={14} /> <span className="btn-label">실시간</span>
                </button>
              )}
              <button type="button" className={`btn ${s.mode === 'replay' ? 'on' : ''}`} onClick={() => void onReplay()} data-testid="replay-btn" title="저장된 이력을 순번으로 재생">
                <History size={14} /> <span className="btn-label">이력</span>
              </button>
              <button type="button" className="btn btn-demo" onClick={() => startDemo()} data-testid="demo-toggle" title="가상 데이터로 화면을 확인 (실제 세션과 분리)">
                <Radio size={14} /> DEMO
              </button>
            </>
          )}
        </div>
        <div className="topbar-group" role="group" aria-label="카메라">
          <button type="button" className="btn icon" onClick={() => store.camera('zoomOut')} title="축소" aria-label="축소" data-testid="zoom-out">
            <ZoomOut size={15} />
          </button>
          <button type="button" className="btn icon" onClick={() => store.camera('zoomIn')} title="확대" aria-label="확대" data-testid="zoom-in">
            <ZoomIn size={15} />
          </button>
          <button type="button" className="btn icon" onClick={() => store.camera('reset')} title="전체 보기" aria-label="전체 보기" data-testid="zoom-reset">
            <Maximize2 size={15} />
          </button>
        </div>
        <label className="toggle topbar-motion" title="캐릭터 이동 애니메이션 줄이기">
          <input type="checkbox" checked={s.reduceMotion} onChange={(e) => store.setReduceMotion(e.target.checked)} />
          이동 효과 축소
        </label>
        <label className="toggle topbar-sound" title="세션이 턴 작업을 마치면 알림음 (실시간 이벤트만, DEMO·이력 재생 제외)">
          <input
            type="checkbox"
            checked={s.soundEnabled}
            data-testid="sound-toggle"
            onChange={(e) => {
              const on = e.target.checked;
              store.setSoundEnabled(on);
              saveSoundEnabled(on);
              // Preview inside the click: also unlocks audio for later chimes.
              if (on) playChime('completed');
            }}
          />
          완료 알림음
        </label>
      </div>
    </header>
  );
}
