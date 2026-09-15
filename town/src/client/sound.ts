/**
 * Completion chime, synthesized with the Web Audio API (no asset files, no
 * network). Browsers only allow audio after a user gesture, so the context
 * is created lazily and unlocked on the first pointer/key event; a chime
 * requested while the context is still suspended is skipped, never queued.
 */
export type ChimeKind = 'completed' | 'failed';

const STORAGE_KEY = 'agent-town.sound';

let ctx: AudioContext | null = null;
let unlockInstalled = false;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** Resume the context on the first user gesture so later chimes can play. */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const unlock = (): void => {
    const c = audioContext();
    if (c && c.state === 'suspended') void c.resume();
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

export function loadSoundEnabled(): boolean {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

export function saveSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* private mode or storage disabled: setting lives for this page only */
  }
}

function tone(c: AudioContext, at: number, freq: number, duration: number, gain: number, type: OscillatorType): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(g).connect(c.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

/**
 * Play the chime. Returns false when audio is unavailable or still locked
 * (no user gesture yet), so callers can decide whether to mention it.
 */
export function playChime(kind: ChimeKind): boolean {
  const c = audioContext();
  if (!c) return false;
  if (c.state === 'suspended') {
    void c.resume();
    if (c.state === 'suspended') return false;
  }
  const t = c.currentTime + 0.01;
  if (kind === 'completed') {
    // Two rising notes: E5 → A5.
    tone(c, t, 659.25, 0.16, 0.18, 'sine');
    tone(c, t + 0.15, 880, 0.28, 0.18, 'sine');
  } else {
    // One low, slightly rough note.
    tone(c, t, 220, 0.35, 0.16, 'triangle');
  }
  return true;
}
