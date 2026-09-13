/**
 * DEMO player: feeds the fixture payloads through the real provider
 * normalizers into the isolated demo state. Never touches the server.
 */
import { DEMO_STEPS } from '../fixtures/demo.js';
import { normalize } from '../shared/providers/index.js';
import { store } from './store.js';

let timer: number | null = null;
let seq = 0;

export function startDemo(speed = 1): void {
  stopDemoPlayback();
  store.startDemo();
  seq = 0;
  let index = 0;
  const step = (): void => {
    if (index >= DEMO_STEPS.length) {
      store.demoFinished();
      timer = null;
      return;
    }
    const s = DEMO_STEPS[index]!;
    index++;
    const ev = normalize(s.provider, s.payload, {
      eventId: `demo-${seq + 1}`,
      receivedAt: new Date().toISOString(),
      homeDir: 'C:/Users/demo',
      source: 'demo',
    });
    if (ev) {
      seq++;
      ev.ingestSeq = seq;
      store.applyDemoEvent(ev);
    }
    const next = DEMO_STEPS[index];
    timer = window.setTimeout(step, next ? Math.max(50, next.after / speed) : 0);
  };
  timer = window.setTimeout(step, 200);
}

export function stopDemoPlayback(): void {
  if (timer) window.clearTimeout(timer);
  timer = null;
}

export function exitDemo(): void {
  stopDemoPlayback();
  store.stopDemo();
}
