/**
 * Derives what the office scene needs from the (possibly frozen) TownState.
 * Pure data; no Phaser types here.
 */
import { ACTIVITY_LABEL_KO } from '../shared/activity.js';
import { getOwn, ownValues } from '../shared/dict.js';
import type { ActivityClass, Provider } from '../shared/events.js';
import {
  agentDisplayStatus,
  type AgentDisplayStatus,
  type AgentState,
  agentWorkSummary,
  type SessionState,
  type TownState,
  workSummaryLabel,
} from '../shared/state.js';
import type { Selection, TimelineFilters } from './store.js';

/** Sessions with no event for this long are labelled "최근 활동 없음" (never ended/failed). */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * A finished employee (subagent whose response ended) stays in the office
 * this long after its last activity, showing what it did, then leaves.
 * Ended sessions and ended agents leave immediately. The panels still list
 * every agent; only the office scene hides them.
 */
export const DONE_LINGER_MS = 8000;

/** True when the agent should not be drawn in the office at `now`. */
export function isAgentHidden(s: SessionState, a: AgentState, now: number): boolean {
  if (s.lifecycle === 'ended' || a.lifecycle === 'ended') return true;
  if (a.role !== 'subagent') return false;
  if (a.lifecycle === 'active' || a.pendingApprovalIds.length > 0 || a.waitingForInput) return false;
  const last = Date.parse(a.lastActivityAt);
  return Number.isFinite(last) && now - last > DONE_LINGER_MS;
}

/** Bubble for an employee whose response ended: the task it was given and what it did. */
export function doneBubble(s: SessionState, a: AgentState): { title: string; detail: string | null; extra: number } {
  const work = workSummaryLabel(agentWorkSummary(s, a));
  if (a.role !== 'subagent') return { title: '응답 완료', detail: null, extra: 0 };
  const what = a.task ?? a.agentType;
  return { title: what ? `완료 · ${what}` : '완료', detail: work, extra: 0 };
}

export interface CharacterVM {
  /** Collision-safe key (JSON of provider, session id, agent id). */
  key: string;
  sessionKey: string;
  agentId: string;
  provider: Provider;
  role: 'main' | 'subagent';
  podIndex: number;
  /** Seat index within the pod: -1 for the lead seat, 0..n for employees. */
  seatIndex: number;
  characterIndex: number;
  status: AgentDisplayStatus;
  activity: ActivityClass | null;
  label: string;
  bubble: { title: string; detail: string | null; extra: number } | null;
  selected: boolean;
  dimmed: boolean;
  /** Key of the known immediate parent (null when unknown). */
  parentKey: string | null;
  stale: boolean;
}

export interface RoomVM {
  podIndex: number;
  sessionKey: string | null;
  title: string;
  subtitle: string;
  provider: Provider | null;
}

export interface OfficeVM {
  characters: CharacterVM[];
  rooms: RoomVM[];
  isDemo: boolean;
  /** Sessions that had no free room (still listed in the panel). */
  unseatedSessionKeys: string[];
  /** Room allocation to feed back as `previous` next time (stickiness). */
  roomMap: RoomMap;
}

export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

export function characterKey(provider: Provider, sessionId: string, agentId: string): string {
  return JSON.stringify([provider, sessionId, agentId]);
}

export function roleLabel(a: AgentState): string {
  if (a.role === 'main') return '팀장';
  return a.agentType ? `직원 · ${a.agentType}` : '직원';
}

/** sessionKey -> room index. Persisted by the view between frames (per view mode). */
export type RoomMap = Record<string, number>;

/**
 * Sticky room assignment.
 * - A session keeps its room for as long as it exists (no reshuffling on events).
 * - Active (not ended) sessions win: an unseated active session evicts an
 *   ended session from its room, never another active one.
 * - Free rooms go to unseated sessions in creation order, active first.
 * The function is pure given `previous`; the caller stores the result.
 */
export function allocateRooms(sessions: SessionState[], maxPods: number, previous: RoomMap): RoomMap {
  const byKey = new Map(sessions.map((s) => [s.key, s] as const));
  const next: RoomMap = {};
  const used = new Set<number>();
  // 1. Keep existing rooms for sessions that still exist.
  for (const [key, room] of Object.entries(previous)) {
    if (!byKey.has(key) || room < 0 || room >= maxPods || used.has(room)) continue;
    next[key] = room;
    used.add(room);
  }
  const isActive = (s: SessionState): boolean => s.lifecycle !== 'ended';
  const unseated = sessions.filter((s) => !(s.key in next));
  const unseatedActive = unseated.filter(isActive);
  const unseatedEnded = unseated.filter((s) => !isActive(s));
  const freeRooms = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < maxPods; i++) if (!used.has(i)) out.push(i);
    return out;
  };
  const seat = (s: SessionState, room: number): void => {
    next[s.key] = room;
    used.add(room);
  };
  // 2. Free rooms to active sessions first (creation order), then ended ones.
  for (const s of unseatedActive) {
    const free = freeRooms();
    if (free.length === 0) break;
    seat(s, free[0]!);
  }
  // 3. Still-unseated active sessions evict seated ended sessions (oldest first).
  const stillActive = unseatedActive.filter((s) => !(s.key in next));
  if (stillActive.length > 0) {
    const evictable = sessions
      .filter((s) => s.key in next && !isActive(s))
      .sort((a, b) => Date.parse(a.lastEventAt) - Date.parse(b.lastEventAt));
    for (const s of stillActive) {
      const victim = evictable.shift();
      if (!victim) break;
      const room = next[victim.key]!;
      delete next[victim.key];
      seat(s, room);
    }
  }
  for (const s of unseatedEnded) {
    const free = freeRooms();
    if (free.length === 0) break;
    seat(s, free[0]!);
  }
  return next;
}

/** Convenience for callers without a previous map (tests, first frame). */
export function assignRooms(
  sessions: SessionState[],
  maxPods: number,
  previous: RoomMap = {},
): { roomed: Array<SessionState | undefined>; unseated: SessionState[]; map: RoomMap } {
  const map = allocateRooms(sessions, maxPods, previous);
  const roomed: Array<SessionState | undefined> = new Array(maxPods).fill(undefined);
  const byKey = new Map(sessions.map((s) => [s.key, s] as const));
  for (const [key, room] of Object.entries(map)) roomed[room] = byKey.get(key);
  return { roomed, unseated: sessions.filter((s) => !(s.key in map)), map };
}

export function isStale(s: SessionState, now: number): boolean {
  if (s.lifecycle === 'ended') return false;
  const t = Date.parse(s.lastEventAt);
  return Number.isFinite(t) && now - t > STALE_AFTER_MS;
}

export function buildOfficeVM(
  state: TownState,
  selection: Selection,
  filters: TimelineFilters,
  isDemo: boolean,
  maxPods: number,
  now: number = Date.now(),
  previousRooms: RoomMap = {},
): OfficeVM {
  const rooms: RoomVM[] = [];
  const characters: CharacterVM[] = [];
  // Ended sessions leave the office entirely (their room is freed); they stay
  // in the session list and details.
  const visible = state.sessionOrder
    .map((k) => getOwn(state.sessions, k))
    .filter((s): s is SessionState => !!s && filters.providers[s.provider] && s.lifecycle !== 'ended');
  const { roomed, unseated, map } = assignRooms(visible, maxPods, previousRooms);
  for (let i = 0; i < maxPods; i++) {
    const s = roomed[i];
    const stale = s ? isStale(s, now) : false;
    rooms.push({
      podIndex: i,
      sessionKey: s?.key ?? null,
      title: s ? (s.projectName ?? s.sessionId.slice(0, 12)) : '빈 자리',
      subtitle: s
        ? `${PROVIDER_LABEL[s.provider]} · ${s.model ?? s.sessionId.slice(0, 8)}${s.lifecycle === 'ended' ? ' · 종료' : stale ? ' · 최근 활동 없음' : ''}`
        : '세션 없음',
      provider: s?.provider ?? null,
    });
  }
  roomed.forEach((s, podIndex) => {
    if (!s) return;
    const stale = isStale(s, now);
    const agents = ownValues(s.agents);
    let seat = 0;
    for (const a of agents) {
      if (isAgentHidden(s, a, now)) continue;
      const status = agentDisplayStatus(s, a);
      const running = a.activeToolIds
        .map((id) => getOwn(s.toolCalls, id))
        .filter((t): t is NonNullable<typeof t> => !!t);
      const current = running[running.length - 1] ?? null;
      const last = a.lastToolId ? getOwn(s.toolCalls, a.lastToolId) : undefined;
      let bubble: CharacterVM['bubble'] = null;
      if (current) {
        bubble = { title: current.toolName, detail: current.target, extra: running.length - 1 };
      } else if (status === 'awaiting_approval') {
        const apId = a.pendingApprovalIds[0];
        const ap = apId ? getOwn(s.approvals, apId) : undefined;
        bubble = {
          title: '승인 대기',
          detail: ap?.toolName ? `${ap.toolName}${ap.target ? ' · ' + ap.target : ''}` : '도구 미확인',
          extra: 0,
        };
      } else if (status === 'failed' && last && (last.status === 'failed' || last.status === 'denied')) {
        bubble = { title: `${last.toolName} 실패`, detail: last.error ?? last.target, extra: 0 };
      } else if (status === 'failed') {
        bubble = { title: a.lastError ?? '실패', detail: null, extra: 0 };
      } else if (status === 'waiting_input') {
        bubble = { title: '입력 대기', detail: null, extra: 0 };
      } else if (status === 'done') {
        bubble = doneBubble(s, a);
      } else if (status === 'working') {
        // Turn running, no tool call observed: only the lifecycle is known.
        bubble = { title: '응답 진행 중', detail: null, extra: 0 };
      }
      const activity: ActivityClass | null = current ? current.activity : null;
      const selected = selection.sessionKey === s.key && selection.agentId === a.id;
      const dimmed =
        (selection.sessionKey !== null && selection.sessionKey !== s.key) ||
        a.lifecycle === 'ended' ||
        stale;
      characters.push({
        key: characterKey(s.provider, s.sessionId, a.id),
        sessionKey: s.key,
        agentId: a.id,
        provider: s.provider,
        role: a.role,
        podIndex,
        seatIndex: a.role === 'main' ? -1 : seat++,
        characterIndex: a.role === 'main' ? podIndex % 6 : (podIndex + a.characterIndex + 2) % 6,
        status,
        activity,
        label: a.role === 'main' ? `${PROVIDER_LABEL[s.provider]} 팀장` : roleLabel(a),
        bubble,
        selected,
        dimmed,
        parentKey: a.parentAgentId ? characterKey(s.provider, s.sessionId, a.parentAgentId) : null,
        stale,
      });
    }
  });
  return { characters, rooms, isDemo, unseatedSessionKeys: unseated.map((s) => s.key), roomMap: map };
}

export function activityLabel(a: ActivityClass | null): string {
  return a ? ACTIVITY_LABEL_KO[a] : '';
}
