import Phaser from 'phaser';
import { useEffect, useMemo, useRef, useState } from 'react';

import { POD_COUNT } from './layout.js';
import { OfficeScene } from './OfficeScene.js';
import { store, useStore } from '../store.js';
import { buildOfficeVM, type RoomMap } from '../viewModel.js';

/** Time-dependent parts of the view model (finished employees leaving) are re-evaluated at this rate. */
const TICK_MS = 1000;

export function OfficeView(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const s = useStore();
  const view = store.viewState();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), TICK_MS);
    return () => window.clearInterval(t);
  }, []);
  // Sticky room allocation, kept separately per view mode so DEMO/replay
  // never disturb the live office's rooms.
  const roomMaps = useRef<Record<string, RoomMap>>({});
  const vm = useMemo(
    () => {
      const previous = roomMaps.current[s.mode] ?? {};
      // In replay the clock is the scrubbed history's clock, not the wall clock,
      // so employees that had just finished at the cursor are still shown.
      let now = Date.now();
      if (s.mode === 'replay') {
        const events = store.viewEvents();
        const lastAt = events.length > 0 ? Date.parse(events[events.length - 1]!.receivedAt) : NaN;
        if (Number.isFinite(lastAt)) now = lastAt;
      }
      const built = buildOfficeVM(view, s.selection, s.filters, s.mode === 'demo', POD_COUNT, now, previous);
      roomMaps.current[s.mode] = built.roomMap;
      return built;
    },
    // The store mutates state in place; the version-triggered render is the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, s.selection, s.filters, s.mode, s.live.eventsApplied, s.demo.eventsApplied, s.replayCursor, s.pausedView, tick],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new OfficeScene({
      onSelect: (sessionKey, agentId) => store.select(sessionKey, agentId),
      onReady: () => {
        host.dataset.ready = '1';
      },
    });
    sceneRef.current = scene;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      backgroundColor: '#23262f',
      pixelArt: true,
      roundPixels: true,
      antialias: false,
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      scene: [scene],
      render: { pixelArt: true },
      audio: { noAudio: true },
      banner: false,
    });
    gameRef.current = game;
    // Exposed for the browser smoke test (scripts/browser-smoke.mjs); harmless otherwise.
    (window as unknown as { __agentTown?: unknown }).__agentTown = { game, scene };
    return () => {
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
      delete (window as unknown as { __agentTown?: unknown }).__agentTown;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setViewModel(vm);
  }, [vm]);

  useEffect(() => {
    sceneRef.current?.setReduceMotion(s.reduceMotion);
  }, [s.reduceMotion]);

  useEffect(() => {
    const req = s.focusRequest;
    const scene = sceneRef.current;
    if (!req || !scene) return;
    if (req.agentId) {
      const c = vm.characters.find((ch) => ch.sessionKey === req.sessionKey && ch.agentId === req.agentId);
      if (c) scene.focusCharacter(c.key);
    } else {
      const room = vm.rooms.find((r) => r.sessionKey === req.sessionKey);
      if (room) scene.focusPod(room.podIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.focusRequest]);

  useEffect(() => {
    const req = s.cameraRequest;
    const scene = sceneRef.current;
    if (!req || !scene) return;
    if (req.kind === 'reset') scene.fitCamera();
    else if (req.kind === 'zoomIn') scene.zoomBy(1.25);
    else scene.zoomBy(1 / 1.25);
  }, [s.cameraRequest]);

  return (
    <div className="office" data-testid="office">
      <div ref={hostRef} className="office-canvas" data-testid="office-canvas" />
      {s.mode === 'demo' && (
        <div className="office-badge office-badge-demo" data-testid="demo-badge">
          DEMO · 가상 데이터 재생 중
        </div>
      )}
      {s.mode === 'paused' && <div className="office-badge">일시정지 · 실시간 수집은 계속됩니다</div>}
      {s.mode === 'replay' && <div className="office-badge">이력 재생 · 실시간 수집은 계속됩니다</div>}
      {vm.characters.length === 0 && (
        <div className="office-empty" data-testid="office-empty">
          {s.mode === 'demo' ? '데모 준비 중' : '관측 중인 세션 없음'}
        </div>
      )}
      {vm.unseatedSessionKeys.length > 0 && (
        <div className="office-badge office-badge-right">자리 없음 {vm.unseatedSessionKeys.length}개 세션 (목록 참고)</div>
      )}
    </div>
  );
}
