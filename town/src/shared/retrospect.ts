/**
 * Retrospective material for one session ("작업 회고 자료").
 *
 * Turns the observed hook events of a session into a Markdown document the
 * user pastes into the CLI session that did the work, plus the metrics the
 * document is built from. Pure: no I/O, shared by server and tests.
 *
 * Honesty rules (see 809_Dev/AI_GatherTown/Agent_Town_작업회고_버튼_설계.md):
 * - Only observed facts go in: ids, tool names, masked targets, times,
 *   statuses. No prompts, no tool responses, no file contents.
 * - "검토 후보" are what the metrics point at, explicitly not conclusions:
 *   a serial chain may be a legitimate dependency the hooks cannot see.
 * - The child ↔ delegation link is an inference and is labelled as such.
 * - The user's own observations come first (USER_NOTES_MARKER); the server
 *   never sees them - the client inserts them after generation.
 */
import { ACTIVITY_LABEL_KO } from './activity.js';
import { getOwn, ownValues } from './dict.js';
import type { ActivityClass, AgentEvent } from './events.js';
import { MAIN_AGENT_ID } from './events.js';
import {
  type AgentState,
  agentWorkSummary,
  effectiveModel,
  type ToolCallState,
  toolKey,
  type TownState,
  workSummaryLabel,
} from './state.js';

export const USER_NOTES_MARKER = '<!-- agent-town:user-notes -->';
const USER_NOTES_EMPTY = '(없음)';

/** Gap between two exploration calls of one agent that still counts as "back to back". */
const SERIAL_GAP_MS = 3000;
const SERIAL_MIN_LENGTH = 3;
const LEAD_EXPLORATION_MIN = 6;
const LIGHT_DELEGATION_MAX_TOOLS = 2;
const MAX_TIMELINE_ROWS_PER_TURN = 50;

export type RetrospectScope = 'all' | 'last-turn';

export interface RetrospectOptions {
  sessionKey: string;
  scope?: RetrospectScope;
  fromSeq?: number;
  toSeq?: number;
  /** Wall clock for the header date; defaults to the last event's time. */
  now?: number;
}

export type CandidateKind =
  | 'serial-chain'
  | 'lead-exploration'
  | 'light-delegation'
  | 'repeated-failure'
  | 'approval-wait'
  | 'model-choice';

export interface Candidate {
  kind: CandidateKind;
  text: string;
}

export interface RetrospectMetrics {
  turns: number;
  /** First to last event in range. */
  spanMs: number;
  agents: number;
  subagents: number;
  toolCalls: number;
  toolFailed: number;
  /** Concurrency of running tool calls, time-weighted. */
  parallel: { max: number; mean: number; soloRatio: number; activeMs: number };
  /** Peak number of subagents alive at once. */
  subagentsAtOnce: number;
  waits: { approvals: number; approvalMs: number; inputNotifications: number };
  candidates: Candidate[];
  /** Some of the session's history was retained away or fell outside the range. */
  partialHistory: boolean;
}

export interface RetrospectResult {
  markdown: string;
  metrics: RetrospectMetrics;
  fromSeq: number;
  toSeq: number;
  eventCount: number;
}

export type RetrospectError = { error: 'unknown-session' | 'demo-session' | 'no-events' };

interface Turn {
  index: number;
  turnId: string | null;
  startSeq: number;
  endSeq: number | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  events: AgentEvent[];
}

function ms(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.max(0, y - x);
}

export function fmtDuration(msTotal: number): string {
  const s = Math.round(msTotal / 1000);
  if (s < 1) return `${Math.round(msTotal)}ms`;
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

function clock(iso: string | null): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dateStamp(iso: string | null, now: number | undefined): string {
  const d = iso ? new Date(iso) : new Date(now ?? Date.now());
  if (Number.isNaN(d.getTime())) return '----';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function agentLabel(a: AgentState | undefined, id: string): string {
  if (!a) return id === MAIN_AGENT_ID ? '팀장' : `에이전트 ${id.slice(0, 8)}`;
  if (a.role === 'main') return '팀장';
  return a.agentType ? `직원 · ${a.agentType}` : `직원 ${a.id.slice(0, 8)}`;
}

const EXPLORATION: ReadonlySet<ActivityClass> = new Set(['read', 'search']);

/** Split the session's events (ascending) into turns; events before the first turn go to `preamble`. */
function segmentTurns(events: AgentEvent[]): { turns: Turn[]; preamble: AgentEvent[] } {
  const turns: Turn[] = [];
  const preamble: AgentEvent[] = [];
  let current: Turn | null = null;
  const close = (ev: AgentEvent, status: Turn['status']): void => {
    if (!current || current.status !== 'running') return;
    current.status = status;
    current.endSeq = ev.ingestSeq;
    current.endedAt = ev.receivedAt;
  };
  for (const ev of events) {
    if (ev.kind === 'turn.started') {
      // A new turn without a close for the previous one leaves the previous
      // turn "running" (its end was not observed); nothing is guessed.
      current = {
        index: turns.length + 1,
        turnId: ev.turnId,
        startSeq: ev.ingestSeq,
        endSeq: null,
        startedAt: ev.receivedAt,
        endedAt: null,
        status: 'running',
        events: [ev],
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      preamble.push(ev);
      continue;
    }
    current.events.push(ev);
    if (ev.kind === 'turn.completed') close(ev, 'completed');
    else if (ev.kind === 'turn.failed') close(ev, ev.payload.reason === 'interrupted' ? 'interrupted' : 'failed');
    else if (ev.kind === 'agent.response_completed' && ev.agentId === MAIN_AGENT_ID) close(ev, 'completed');
    else if (ev.kind === 'session.ended') close(ev, 'interrupted');
  }
  return { turns, preamble };
}

interface Interval {
  start: number;
  end: number;
}

/** Time-weighted concurrency over a set of intervals. */
function concurrency(intervals: Interval[]): { max: number; mean: number; soloRatio: number; activeMs: number } {
  const points: Array<{ t: number; d: number }> = [];
  for (const iv of intervals) {
    if (!(iv.end > iv.start)) continue;
    points.push({ t: iv.start, d: 1 }, { t: iv.end, d: -1 });
  }
  if (points.length === 0) return { max: 0, mean: 0, soloRatio: 0, activeMs: 0 };
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let level = 0;
  let max = 0;
  let activeMs = 0;
  let soloMs = 0;
  let weighted = 0;
  let prev = points[0]!.t;
  for (const p of points) {
    const span = p.t - prev;
    if (span > 0 && level > 0) {
      activeMs += span;
      weighted += span * level;
      if (level === 1) soloMs += span;
    }
    level += p.d;
    if (level > max) max = level;
    prev = p.t;
  }
  return {
    max,
    mean: activeMs > 0 ? Math.round((weighted / activeMs) * 100) / 100 : 0,
    soloRatio: activeMs > 0 ? Math.round((soloMs / activeMs) * 100) / 100 : 0,
    activeMs,
  };
}

function toolInterval(tc: ToolCallState, rangeEndIso: string): Interval | null {
  const start = tc.startedAt ?? tc.endedAt;
  const end = tc.endedAt ?? rangeEndIso;
  if (!start) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { start: a, end: Math.max(a, b) };
}

function toolStatusText(tc: ToolCallState | undefined): string {
  if (!tc) return '';
  switch (tc.status) {
    case 'running':
      return '진행 중';
    case 'completed':
      return `완료${tc.startedAt && tc.endedAt ? ' ' + fmtDuration(ms(tc.startedAt, tc.endedAt)) : ''}`;
    case 'failed':
      return `실패${tc.error ? ': ' + tc.error : ''}${tc.exitCode !== null ? ' (exit ' + tc.exitCode + ')' : ''}`;
    case 'denied':
      return '승인 거부';
    case 'ended':
      return '종료 · 결과 미확인';
    case 'unresolved':
      return '응답 종료 시점에 미완료';
    default:
      return tc.status;
  }
}

/**
 * Build the retrospective for one session from the final state plus that
 * session's events in ascending seq order. `events` may contain other
 * sessions' events; they are ignored.
 */
export function buildRetrospect(
  state: TownState,
  events: AgentEvent[],
  opts: RetrospectOptions,
): RetrospectResult | RetrospectError {
  const session = getOwn(state.sessions, opts.sessionKey);
  if (!session) return { error: 'unknown-session' };
  if (session.source === 'demo') return { error: 'demo-session' };
  const fromSeq = opts.fromSeq ?? 0;
  const toSeq = opts.toSeq ?? Number.MAX_SAFE_INTEGER;
  let scoped = events
    .filter(
      (ev) =>
        ev.provider === session.provider &&
        ev.sessionId === session.sessionId &&
        ev.source !== 'demo' &&
        ev.ingestSeq > fromSeq &&
        ev.ingestSeq <= toSeq,
    )
    .sort((a, b) => a.ingestSeq - b.ingestSeq);
  if (scoped.length === 0) return { error: 'no-events' };

  let { turns, preamble } = segmentTurns(scoped);
  let rangeFrom = scoped[0]!.ingestSeq;
  let rangeTo = scoped[scoped.length - 1]!.ingestSeq;
  if (opts.scope === 'last-turn' && turns.length > 0) {
    const last = turns[turns.length - 1]!;
    scoped = last.events;
    turns = [last];
    preamble = [];
    rangeFrom = last.startSeq;
    rangeTo = last.endSeq ?? scoped[scoped.length - 1]!.ingestSeq;
  }
  const firstAt = scoped[0]!.receivedAt;
  const lastAt = scoped[scoped.length - 1]!.receivedAt;
  const partialHistory = session.eventCount > scoped.length && opts.scope !== 'last-turn';

  // Tool calls that started (or, out of order, ended) inside the range.
  const calls = ownValues(session.toolCalls)
    .filter((tc) => tc.startSeq > rangeFrom - 1 && tc.startSeq <= rangeTo)
    .sort((a, b) => a.startSeq - b.startSeq);
  const callByKey = new Map(calls.map((tc) => [tc.id, tc] as const));
  const agentIds = new Set<string>([MAIN_AGENT_ID]);
  for (const ev of scoped) agentIds.add(ev.agentId);
  for (const tc of calls) agentIds.add(tc.agentId);
  const agents = [...agentIds]
    .map((id) => getOwn(session.agents, id))
    .filter((a): a is AgentState => !!a)
    .sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : a.startedAt.localeCompare(b.startedAt)));
  const subagents = agents.filter((a) => a.role === 'subagent');

  // ---- metrics ------------------------------------------------------------
  const toolIntervals = calls.map((tc) => toolInterval(tc, lastAt)).filter((iv): iv is Interval => !!iv);
  const parallel = concurrency(toolIntervals);

  const agentIntervals: Interval[] = [];
  const openAgents = new Map<string, number>();
  for (const ev of scoped) {
    if (ev.agentId === MAIN_AGENT_ID) continue;
    const t = Date.parse(ev.receivedAt);
    if (!Number.isFinite(t)) continue;
    if (ev.kind === 'agent.started') openAgents.set(ev.agentId, t);
    else if (ev.kind === 'agent.response_completed' || ev.kind === 'session.ended') {
      const start = openAgents.get(ev.agentId);
      if (start !== undefined) {
        agentIntervals.push({ start, end: t });
        openAgents.delete(ev.agentId);
      }
    }
  }
  const endT = Date.parse(lastAt);
  for (const start of openAgents.values()) agentIntervals.push({ start, end: Number.isFinite(endT) ? endT : start });
  const subagentsAtOnce = concurrency(agentIntervals).max;

  const approvals = ownValues(session.approvals).filter((ap) => ap.requestSeq > rangeFrom - 1 && ap.requestSeq <= rangeTo);
  const approvalMs = approvals.reduce((n, ap) => n + ms(ap.requestedAt, ap.resolvedAt ?? lastAt), 0);
  const inputNotifications = scoped.filter(
    (ev) => ev.kind === 'notification' && (ev.payload.notificationType === 'idle_prompt' || ev.payload.notificationType === 'agent_needs_input'),
  ).length;

  const candidates: Candidate[] = [];
  // Serial exploration chains per agent.
  for (const a of agents) {
    const mine = calls.filter((tc) => tc.agentId === a.id && EXPLORATION.has(tc.activity) && tc.startedAt);
    let chain: ToolCallState[] = [];
    const flush = (): void => {
      if (chain.length >= SERIAL_MIN_LENGTH) {
        const first = chain[0]!;
        const last = chain[chain.length - 1]!;
        const targets = chain
          .map((tc) => tc.target)
          .filter((t): t is string => !!t)
          .slice(0, 4);
        const kinds = [...new Set(chain.map((tc) => ACTIVITY_LABEL_KO[tc.activity]))].join('·');
        candidates.push({
          kind: 'serial-chain',
          text: `${agentLabel(a, a.id)}: ${kinds} ${chain.length}회 연속 (${clock(first.startedAt)}~${clock(last.endedAt ?? last.startedAt)}, ${fmtDuration(ms(first.startedAt, last.endedAt ?? last.startedAt))})${targets.length ? ' — ' + targets.join(', ') + (chain.length > targets.length ? ' …' : '') : ''}. 앞 결과가 다음 입력을 정하지 않았다면 한 번에 요청할 수 있었던 구간`,
        });
      }
      chain = [];
    };
    for (const tc of mine) {
      const prev = chain[chain.length - 1];
      if (prev) {
        const prevEnd = prev.endedAt ? Date.parse(prev.endedAt) : NaN;
        const curStart = Date.parse(tc.startedAt!);
        const backToBack = Number.isFinite(prevEnd) && curStart >= prevEnd && curStart - prevEnd <= SERIAL_GAP_MS;
        if (!backToBack) flush();
      }
      chain.push(tc);
    }
    flush();
  }
  // Lead doing the exploration itself.
  const explorationAll = calls.filter((tc) => EXPLORATION.has(tc.activity));
  const explorationLead = explorationAll.filter((tc) => tc.agentId === MAIN_AGENT_ID);
  if (explorationLead.length >= LEAD_EXPLORATION_MIN) {
    const share = explorationAll.length ? Math.round((explorationLead.length / explorationAll.length) * 100) : 100;
    if (subagents.length === 0) {
      candidates.push({
        kind: 'lead-exploration',
        text: `탐색성 호출(읽기·검색) ${explorationLead.length}회를 팀장이 직접 수행했고 위임은 없었음. 탐색을 직원에게 맡기고 팀장은 판단만 할 수 있었는지`,
      });
    } else if (share >= 70) {
      candidates.push({
        kind: 'lead-exploration',
        text: `탐색성 호출 ${explorationAll.length}회 중 팀장 직접 ${explorationLead.length}회(${share}%). 직원이 있었는데도 탐색이 팀장에 몰린 이유`,
      });
    }
  }
  // Delegations that did almost nothing.
  for (const a of subagents) {
    const w = agentWorkSummary(session, a);
    if (a.lifecycle !== 'active' && w.total <= LIGHT_DELEGATION_MAX_TOOLS) {
      candidates.push({
        kind: 'light-delegation',
        text: `${agentLabel(a, a.id)}${a.task ? ` ("${a.task}", 추정 연결)` : ''}: 도구 ${w.total}개로 종료. 위임 비용(컨텍스트 전달·대기) 대비 가벼운 작업이었는지`,
      });
    }
  }
  // Repeated failures on the same tool/target.
  const failKey = new Map<string, ToolCallState[]>();
  for (const tc of calls) {
    if (tc.status !== 'failed' && tc.status !== 'denied') continue;
    const k = `${tc.agentId}|${tc.toolName}|${tc.target ?? ''}`;
    const list = failKey.get(k) ?? [];
    list.push(tc);
    failKey.set(k, list);
  }
  for (const list of failKey.values()) {
    if (list.length < 2) continue;
    const tc = list[0]!;
    const recovered = calls.some(
      (c) => c.agentId === tc.agentId && c.toolName === tc.toolName && c.target === tc.target && c.status === 'completed' && c.startSeq > list[list.length - 1]!.startSeq,
    );
    candidates.push({
      kind: 'repeated-failure',
      text: `${agentLabel(getOwn(session.agents, tc.agentId), tc.agentId)}: ${tc.toolName}${tc.target ? ' · ' + tc.target : ''} ${list.length}회 실패${recovered ? ' 후 성공' : ', 성공 없음'}${tc.error ? ` (${tc.error})` : ''}. 첫 실패 뒤 접근을 바꿨는지`,
    });
  }
  // Approval waits.
  if (approvals.length > 0) {
    const tools = [...new Set(approvals.map((ap) => ap.toolName ?? '도구 미확인'))].slice(0, 4).join(', ');
    candidates.push({
      kind: 'approval-wait',
      text: `승인 요청 ${approvals.length}회, 대기 합계 ${fmtDuration(approvalMs)} (${tools}). 반복되는 승인이면 사전 허용 규칙으로 줄일 수 있는지`,
    });
  }
  // Model choice for exploration-only delegations.
  for (const a of subagents) {
    const w = agentWorkSummary(session, a);
    const model = effectiveModel(session, a);
    const explorationOnly = w.total > 0 && w.byActivity.every((p) => EXPLORATION.has(p.activity));
    if (explorationOnly && model.source === 'session' && model.model) {
      candidates.push({
        kind: 'model-choice',
        text: `${agentLabel(a, a.id)}: 탐색만 수행했는데 모델 지정 없이 세션 모델(${model.model})을 사용. 가벼운 모델로 충분했는지`,
      });
    }
  }

  const metrics: RetrospectMetrics = {
    turns: turns.length,
    spanMs: ms(firstAt, lastAt),
    agents: agents.length,
    subagents: subagents.length,
    toolCalls: calls.length,
    toolFailed: calls.filter((tc) => tc.status === 'failed' || tc.status === 'denied').length,
    parallel,
    subagentsAtOnce,
    waits: { approvals: approvals.length, approvalMs, inputNotifications },
    candidates,
    partialHistory,
  };

  // ---- markdown -----------------------------------------------------------
  const L: string[] = [];
  const project = session.projectName ?? session.sessionId.slice(0, 12);
  L.push(`# 작업 회고 요청 — ${project} · ${session.sessionId.slice(0, 8)} · ${dateStamp(lastAt, opts.now)}`);
  L.push('');
  L.push('> Agent Town이 훅으로 관측한 사실만 담았습니다. 프롬프트, 응답 본문, 파일 내용은 없습니다.');
  L.push('> "검토 후보"는 지표가 가리킨 것이지 결론이 아닙니다. 훅은 도구 사이의 입력 의존을 보지 못합니다.');
  L.push(
    `> 범위: seq ${rangeFrom}~${rangeTo} · 이벤트 ${scoped.length}개${opts.scope === 'last-turn' ? ' · 마지막 턴만' : ''}${partialHistory ? ' · 이 세션의 다른 이벤트 일부는 범위 밖이거나 보관 기간 종료로 삭제됨' : ''}`,
  );
  L.push('');
  L.push('## 0. 사용자 관찰 (먼저 읽을 것)');
  L.push(USER_NOTES_MARKER);
  L.push(USER_NOTES_EMPTY);
  L.push('');
  L.push('## 1. 요약');
  L.push(`- 세션: ${session.provider === 'claude' ? 'Claude Code' : 'Codex CLI'} · 모델 ${session.model ?? '미제공'} · 프로젝트 ${project}`);
  L.push(
    `- 턴 ${turns.length}개, 관측 구간 ${fmtDuration(metrics.spanMs)}, 에이전트 ${agents.length}개(직원 ${subagents.length}), 도구 호출 ${calls.length}개(실패·거부 ${metrics.toolFailed})`,
  );
  L.push(
    `- 병렬도(도구): 최대 ${parallel.max}, 평균 ${parallel.mean}, 도구 1개만 진행된 시간 비율 ${Math.round(parallel.soloRatio * 100)}% (도구 활동 ${fmtDuration(parallel.activeMs)}) · 직원 동시 최대 ${subagentsAtOnce}`,
  );
  L.push(`- 대기: 승인 ${approvals.length}회 합계 ${fmtDuration(approvalMs)} · 입력 대기 알림 ${inputNotifications}회`);
  L.push('- 에이전트:');
  for (const a of agents) {
    const model = effectiveModel(session, a);
    const w = agentWorkSummary(session, a);
    const modelText = model.model ? `${model.model}${model.source === 'session' ? ' (세션 모델)' : ''}` : '모델 미제공';
    const task = a.role === 'subagent' ? (a.task ? ` — 담당 "${a.task}" (Agent 호출과 추정 연결)` : ' — 담당 작업 미연결') : '';
    const lifecycle = a.lifecycle === 'active' ? '진행 중' : a.lifecycle === 'ended' ? '종료' : a.lastResponse === 'completed' ? '응답 완료' : a.lastResponse ?? '대기';
    L.push(`  - ${agentLabel(a, a.id)}${task} · ${modelText} · ${workSummaryLabel(w, 6) ?? '도구 호출 없음'} · ${lifecycle}`);
  }
  L.push('');
  L.push('## 2. 타임라인');
  const row = (ev: AgentEvent): string | null => {
    const who = agentLabel(getOwn(session.agents, ev.agentId), ev.agentId);
    const t = clock(ev.receivedAt);
    switch (ev.kind) {
      case 'tool.started': {
        const tc = ev.toolCallId ? callByKey.get(toolKey(ev.agentId, ev.toolCallId)) : undefined;
        const name = ev.payload.toolName ?? '도구';
        const target = ev.payload.toolTarget ? ` ${ev.payload.toolTarget}` : '';
        const extra = ev.payload.activity === 'agent' && ev.payload.subagentType ? ` → ${ev.payload.subagentType}${ev.payload.subagentModel ? ' (' + ev.payload.subagentModel + ')' : ''}` : '';
        return `- ${t} ${who} ${name}${target}${extra} (${toolStatusText(tc) || '결과 미기록'})`;
      }
      case 'tool.completed':
      case 'tool.failed': {
        // Completion is folded into the start row; only out-of-order completions get their own line.
        const tc = ev.toolCallId ? callByKey.get(toolKey(ev.agentId, ev.toolCallId)) : undefined;
        if (tc && !tc.outOfOrder) return null;
        return `- ${t} ${who} ${ev.payload.toolName ?? '도구'} 종료 먼저 수신 (${toolStatusText(tc) || ev.kind})`;
      }
      case 'agent.started': {
        const a = getOwn(session.agents, ev.agentId);
        return `- ${t} 직원 시작 · ${ev.payload.agentType ?? ev.agentId.slice(0, 8)}${a?.task ? ` — 담당 "${a.task}" (추정 연결)` : ''}`;
      }
      case 'agent.response_completed': {
        if (ev.agentId === MAIN_AGENT_ID) return `- ${t} 팀장 응답 종료`;
        const a = getOwn(session.agents, ev.agentId);
        const w = a ? agentWorkSummary(session, a) : null;
        return `- ${t} ${who} 종료 · ${w ? (workSummaryLabel(w) ?? '도구 호출 없음') : ''}`;
      }
      case 'approval.requested':
        return `- ${t} ${who} 승인 요청 ${ev.payload.toolName ?? '(도구 미확인)'}${ev.payload.toolTarget ? ' ' + ev.payload.toolTarget : ''}`;
      case 'approval.resolved':
        return `- ${t} ${who} 승인 ${ev.payload.decision === 'denied' ? '거부' : ev.payload.decision === 'allowed' ? '허용' : '결과 미확인'}`;
      case 'turn.failed':
        return `- ${t} 턴 ${ev.payload.reason === 'interrupted' ? '중단' : '실패'}${ev.payload.error ? ': ' + ev.payload.error : ''}`;
      case 'notification':
        if (ev.payload.notificationType === 'idle_prompt' || ev.payload.notificationType === 'agent_needs_input') return `- ${t} ${who} 입력 대기`;
        if (ev.payload.notificationType === 'PostModelSwitch') return `- ${t} 모델 전환 ${ev.payload.note ?? ev.payload.model ?? ''}`;
        return null;
      case 'session.started':
        return `- ${t} 세션 시작${ev.payload.model ? ' · 모델 ' + ev.payload.model : ''}`;
      case 'session.ended':
        return `- ${t} 세션 종료${ev.payload.reason ? ' (' + ev.payload.reason + ')' : ''}`;
      default:
        return null;
    }
  };
  const emitRows = (list: AgentEvent[]): void => {
    const rows = list.map(row).filter((r): r is string => r !== null);
    for (const r of rows.slice(0, MAX_TIMELINE_ROWS_PER_TURN)) L.push(r);
    if (rows.length > MAX_TIMELINE_ROWS_PER_TURN) L.push(`- … 외 ${rows.length - MAX_TIMELINE_ROWS_PER_TURN}개 행 생략`);
    if (rows.length === 0) L.push('- (표시할 이벤트 없음)');
  };
  if (preamble.length > 0) {
    L.push('### 턴 시작 전');
    emitRows(preamble);
  }
  for (const turn of turns) {
    const status =
      turn.status === 'completed' ? '완료' : turn.status === 'failed' ? '실패' : turn.status === 'interrupted' ? '중단' : '종료 미관측';
    const end = turn.endedAt ?? turn.events[turn.events.length - 1]!.receivedAt;
    L.push(`### 턴 ${turn.index} (${clock(turn.startedAt)} ~ ${clock(end)}, ${fmtDuration(ms(turn.startedAt, end))}) — ${status}`);
    emitRows(turn.events);
  }
  if (turns.length === 0 && preamble.length === 0) L.push('- (이벤트 없음)');
  L.push('');
  L.push('## 3. 검토 후보 (지표가 가리킨 것, 결론 아님)');
  if (candidates.length === 0) L.push('- 지표상 두드러진 후보 없음');
  for (const c of candidates) L.push(`- ${c.text}`);
  L.push('');
  L.push('## 4. 회고 질문');
  L.push('이 실행을 수행한 세션에게 묻습니다. 위 검토 후보 각각에 대해:');
  L.push('1. 실제로 그렇게 한 이유가 있었는가? (앞 결과가 다음 입력을 결정했는가, 규칙이나 권한 때문이었는가)');
  L.push('2. 같은 결과를 더 적은 턴, 더 짧은 대기, 더 적은 도구 호출로 얻을 방법이 있었는가? 병렬 호출이나 위임이 가능했다면 어디에서였는가?');
  L.push('3. 사용자의 요청 방식(범위, 순서, 사전 허용, 컨텍스트 제공)이 바뀌면 달라졌을 부분은 무엇인가?');
  L.push('근거가 관측 자료에 없는 개선안은 "추정"이라고 표시해 주세요. 위 §0의 사용자 관찰에 먼저 답해 주세요.');
  L.push('');

  return { markdown: L.join('\n'), metrics, fromSeq: rangeFrom, toSeq: rangeTo, eventCount: scoped.length };
}

/** Insert the user's own observations under §0. Empty notes leave the "(없음)" placeholder. */
export function withUserNotes(markdown: string, notes: string): string {
  const trimmed = notes.replace(/\r\n/g, '\n').trim();
  const placeholder = `${USER_NOTES_MARKER}\n${USER_NOTES_EMPTY}`;
  if (!trimmed) return markdown;
  return markdown.replace(placeholder, `${USER_NOTES_MARKER}\n${trimmed}`);
}
