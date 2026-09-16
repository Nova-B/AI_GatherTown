/**
 * Derives what the office scene needs from the (possibly frozen) TownState.
 * Pure data; no Phaser types here.
 */
import { ACTIVITY_LABEL_KO, toolLabel } from '../shared/activity.js';
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
 * Office visibility. Ended sessions and ended agents leave immediately. A
 * finished employee (subagent whose response ended) stays at its desk,
 * showing what it did, until the user starts the next turn of that session
 * (an observed `turn.started` after the employee's last activity); then the
 * previous task's employees clear out. The panels still list every agent;
 * only the office scene hides them. `now` is unused here but kept so the
 * rule can become time-based again without changing callers.
 */
export function isAgentHidden(s: SessionState, a: AgentState, _now: number): boolean {
  if (s.lifecycle === 'ended' || a.lifecycle === 'ended') return true;
  if (a.role !== 'subagent') return false;
  if (a.lifecycle === 'active' || a.pendingApprovalIds.length > 0 || a.waitingForInput) return false;
  // Known only from its SubagentStop: nothing to show at a desk.
  if (!a.startObserved) return true;
  const turn = s.currentTurn;
  if (!turn) return false;
  const turnStart = Date.parse(turn.startedAt);
  const last = Date.parse(a.lastActivityAt);
  return Number.isFinite(turnStart) && Number.isFinite(last) && turnStart >= last;
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
  /** Name-tag colour: provider colour for the lead, agent-type colour for helpers. */
  tagColor: string;
  /** Tool calls running at once for this agent (0 when idle). */
  parallel: number;
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

/** Korean role per subagent type (lower-cased provider `agent_type`). */
export const AGENT_TYPE_LABEL_KO: Record<string, string> = {
  explore: '탐색',
  plan: '설계',
  'general-purpose': '실무',
  claude: '실무',
  'claude-code-guide': '안내',
  worker: '작업',
  reviewer: '검토',
};

export const PROVIDER_COLOR: Record<Provider, string> = { claude: '#c2410c', codex: '#0e7490' };

const AGENT_TYPE_COLOR: Record<string, string> = {
  explore: '#0f766e',
  plan: '#6d28d9',
  'general-purpose': '#475569',
  claude: '#475569',
  worker: '#475569',
  reviewer: '#b45309',
  'claude-code-guide': '#b45309',
};
const AGENT_TYPE_COLOR_FALLBACK = '#1d4ed8';
const AGENT_UNKNOWN_COLOR = '#64748b';

/**
 * Helpers are named by what they were asked to be, not lumped as "직원":
 * "탐색 담당 · Explore", "설계 담당 · Plan", "실무 담당 · general-purpose",
 * a custom type as "{type} 담당". An agent whose start was never observed
 * (SubagentStop only) is labelled so and is not drawn in the office.
 */
export function roleLabel(a: AgentState): string {
  if (a.role === 'main') return '팀장';
  if (!a.agentType) return a.startObserved ? '보조 에이전트' : '보조 에이전트 · 시작 미관측';
  const ko = AGENT_TYPE_LABEL_KO[a.agentType.toLowerCase()];
  return ko ? `${ko} 담당 · ${a.agentType}` : `${a.agentType} 담당`;
}

export function agentTagColor(s: SessionState, a: AgentState): string {
  if (a.role === 'main') return PROVIDER_COLOR[s.provider];
  if (!a.agentType) return AGENT_UNKNOWN_COLOR;
  return AGENT_TYPE_COLOR[a.agentType.toLowerCase()] ?? AGENT_TYPE_COLOR_FALLBACK;
}

/** Stable sprite per helper type so every Explore looks alike; the lead keeps the room's sprite. */
function helperSprite(a: AgentState, podIndex: number): number {
  const key = (a.agentType ?? a.id).toLowerCase();
  let h = 7;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const lead = podIndex % 6;
  const pick = 1 + (h % 5); // 1..5
  return (lead + pick) % 6; // never the lead's own sprite
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

/** Session list groups, in display order. */
export type SessionGroup = 'working' | 'idle' | 'ended';

export const SESSION_GROUP_LABEL_KO: Record<SessionGroup, string> = {
  working: '진행 중',
  idle: '대기 중',
  ended: '종료',
};

/**
 * 진행 중 = a running turn, a running tool or a pending approval (it needs
 * the user or is doing work); 대기 중 = active but nothing running (stale
 * ones sort last inside the group); 종료 = SessionEnd received.
 */
export function sessionGroup(s: SessionState): SessionGroup {
  if (s.lifecycle === 'ended') return 'ended';
  if (s.currentTurn?.status === 'running') return 'working';
  for (const a of ownValues(s.agents)) {
    if (a.activeToolIds.length > 0 || a.pendingApprovalIds.length > 0) return 'working';
  }
  return 'idle';
}

const GROUP_ORDER: Record<SessionGroup, number> = { working: 0, idle: 1, ended: 2 };

/** Sort for the session list: group order, then non-stale before stale, then most recent activity first. */
export function sortSessions(sessions: SessionState[], now: number): SessionState[] {
  return sessions
    .map((s, i) => ({ s, i, g: GROUP_ORDER[sessionGroup(s)], stale: isStale(s, now) ? 1 : 0, t: Date.parse(s.lastEventAt) || 0 }))
    .sort((a, b) => a.g - b.g || a.stale - b.stale || b.t - a.t || b.i - a.i)
    .map((x) => x.s);
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
        // Several calls at once are the same agent working in parallel, not extra people.
        const title = running.length > 1 ? `${toolLabel(current.toolName)} · 병렬 ${running.length}` : toolLabel(current.toolName);
        bubble = { title, detail: current.target, extra: 0 };
      } else if (status === 'awaiting_approval') {
        const apId = a.pendingApprovalIds[0];
        const ap = apId ? getOwn(s.approvals, apId) : undefined;
        bubble = {
          title: '승인 대기',
          detail: ap?.toolName ? `${toolLabel(ap.toolName)}${ap.target ? ' · ' + ap.target : ''}` : '도구 미확인',
          extra: 0,
        };
      } else if (status === 'failed' && last && (last.status === 'failed' || last.status === 'denied')) {
        bubble = { title: `${toolLabel(last.toolName)} 실패`, detail: last.error ?? last.target, extra: 0 };
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
        characterIndex: a.role === 'main' ? podIndex % 6 : helperSprite(a, podIndex),
        status,
        activity,
        label: `${a.role === 'main' ? `${PROVIDER_LABEL[s.provider]} 팀장` : roleLabel(a)}${running.length > 1 ? ` ⇉${running.length}` : ''}`,
        tagColor: agentTagColor(s, a),
        parallel: running.length,
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
