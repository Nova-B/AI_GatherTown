/**
 * Agent Town state model and reducer.
 *
 * The reducer is pure with respect to its inputs (state + event) and is shared
 * by the server (live state, restart reconstruction, retention checkpoints)
 * and the client (incremental updates, history scrubbing). Replaying the same
 * event sequence always yields the same state.
 *
 * Correctness rules (see supervision/development-plan.md §7):
 * - Tool calls are identified by (agent, provider tool_use_id). Two agents
 *   using the same agent-local id never collide. A call whose id is missing
 *   becomes an explicit "unknown id" record, never linked by time.
 * - completed/failed/denied/ended are terminal: a later duplicate or late
 *   "started" never resurrects them and never reactivates the agent.
 * - "unresolved" (the agent's response ended while the call was still open)
 *   is provisional: a later explicit outcome for the same call refines it.
 * - Out-of-order completion creates a terminal record immediately.
 * - Response completion (Stop / SubagentStop) marks that agent idle and, for
 *   the root agent only, completes the current turn exactly once. It never
 *   ends the session and never marks running tools as successful.
 * - Approvals stay pending until explicit evidence (an outcome for the same
 *   call, PermissionDenied) or - as a labelled inference - the turn of that
 *   agent completes.
 * - Inactivity is never turned into success or failure; an agent with no
 *   running turn is "idle", not "working".
 * - Dictionaries keyed by provider-chosen ids use the safe helpers in dict.ts.
 */

import { ACTIVITY_LABEL_KO } from './activity.js';
import { createDict, deleteOwn, getOwn, hasOwn, ownKeys, ownValues, setOwn, type Dict } from './dict.js';
import type { ActivityClass, AgentEvent, Evidence, Provider, ToolOutcome } from './events.js';
import { MAIN_AGENT_ID, sessionKey } from './events.js';

export type ToolStatus = 'running' | 'completed' | 'failed' | 'denied' | 'ended' | 'unresolved';

/** Separator inside internal keys; a NUL never appears in cleaned ids. */
export const KEY_SEP = String.fromCharCode(0);

export interface ToolCallState {
  /** Internal key: agentId + KEY_SEP + sourceId (or an unknown marker). */
  id: string;
  /** Provider tool_use_id verbatim, or null when the payload had none. */
  sourceId: string | null;
  idKnown: boolean;
  agentId: string;
  toolName: string;
  target: string | null;
  activity: ActivityClass;
  status: ToolStatus;
  startedAt: string | null;
  endedAt: string | null;
  startSeq: number;
  endSeq: number | null;
  error: string | null;
  exitCode: number | null;
  /** True when a terminal event arrived before the start event. */
  outOfOrder: boolean;
  /** True when the call was still running when its agent's response ended. */
  endedByTurn: boolean;
  /** True when an explicit outcome arrived after the call had been marked unresolved. */
  lateOutcome: boolean;
  duplicateEvents: number;
  /** Delegation calls only (activity 'agent'): what the caller requested. */
  subagentType: string | null;
  subagentModel: string | null;
  taskDescription: string | null;
  /** Child agent this delegation call was linked to (inferred, see linkSpawnCall). */
  spawnedAgentId: string | null;
}

export type ApprovalStatus = 'pending' | 'resolved';

export interface ApprovalState {
  /** Internal key, same scheme as tool calls. */
  id: string;
  sourceId: string | null;
  idKnown: boolean;
  agentId: string;
  toolName: string | null;
  target: string | null;
  status: ApprovalStatus;
  decision: 'allowed' | 'denied' | 'unknown' | null;
  resolutionEvidence: Evidence | null;
  requestedAt: string;
  resolvedAt: string | null;
  requestSeq: number;
}

export type AgentLifecycle = 'active' | 'idle' | 'ended';

export interface AgentState {
  id: string;
  idOrigin: 'source' | 'internal-main';
  role: 'main' | 'subagent';
  agentType: string | null;
  /** Immediate parent when the provider semantics establish it; null = unknown. */
  parentAgentId: string | null;
  /** Why parentAgentId is set (or why it is unknown). */
  parentEvidence: 'provider-semantics' | 'unknown';
  lifecycle: AgentLifecycle;
  lastResponse: 'completed' | 'failed' | 'interrupted' | null;
  startedAt: string;
  lastActivityAt: string;
  /** Internal tool-call keys currently running for this agent. */
  activeToolIds: string[];
  pendingApprovalIds: string[];
  lastToolId: string | null;
  lastError: string | null;
  characterIndex: number;
  responsesCompleted: number;
  waitingForInput: boolean;
  /**
   * Model requested for this agent by the delegation call (Agent tool `model`).
   * null = not stated by any payload; the session model then applies (see
   * effectiveModel). Never guessed.
   */
  model: string | null;
  /** Task description from the linked delegation call (null = none linked). */
  task: string | null;
  /** Always 'inferred': no provider payload links a child to its Agent call by id. */
  taskEvidence: 'inferred' | null;
  /** Internal key of the linked delegation call. */
  taskToolId: string | null;
  /**
   * False when the agent is known only from its response ending (a
   * SubagentStop with no SubagentStart and no tool activity). Such an agent
   * did nothing observable, so the office does not draw it; the panels list
   * it with a "시작 미관측" tag. Becomes true on agent.started or any tool
   * activity.
   */
  startObserved: boolean;
}

export type SessionLifecycle = 'active' | 'ended' | 'unknown';

export interface TurnState {
  turnId: string | null;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  endedAt: string | null;
  /**
   * 'observed' when a Stop/Interrupt/turn end named this turn; 'inferred'
   * when the end was deduced (a newer turn started, or Claude reported
   * waiting for input, while this turn had no end event - the Esc case).
   */
  endEvidence: Evidence | null;
}

export interface SessionState {
  key: string;
  provider: Provider;
  sessionId: string;
  source: 'hook' | 'demo';
  cwd: string | null;
  projectName: string | null;
  model: string | null;
  lifecycle: SessionLifecycle;
  startedAt: string;
  lastEventAt: string;
  lastSeq: number;
  eventCount: number;
  currentTurn: TurnState | null;
  turnsCompleted: number;
  /** Ids of turns already seen (bounded, newest last) - detects stale re-deliveries. */
  recentTurnIds: string[];
  /** Turn-scoped terminal events that named an older turn and were ignored. */
  staleTurnEvents: number;
  agents: Dict<AgentState>;
  toolCalls: Dict<ToolCallState>;
  approvals: Dict<ApprovalState>;
  podIndex: number;
  unknownEvents: number;
  duplicatesIgnored: number;
}

/**
 * 2 = pass-2 checkpoints (no turn tracking fields); 3 = turn tracking;
 * 4 = per-agent model/task and delegation-call fields (pass 5);
 * 5 = agent.startObserved and turn.endEvidence (pass 7).
 */
export const STATE_SCHEMA_VERSION = 5;

export interface TownState {
  schemaVersion: number;
  sessions: Dict<SessionState>;
  lastSeq: number;
  eventsApplied: number;
  /** Session keys in creation order (stable pod assignment). */
  sessionOrder: string[];
  /** Events with seq <= historyFromSeq are no longer available for replay. */
  historyFromSeq: number;
  /** Sessions removed from state by retention (their history is gone). */
  prunedSessions: number;
}

export function createInitialState(): TownState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sessions: createDict(),
    lastSeq: 0,
    eventsApplied: 0,
    sessionOrder: [],
    historyFromSeq: 0,
    prunedSessions: 0,
  };
}

/**
 * Bring a stored/serialized state up to the current schema in place.
 * Non-destructive and idempotent: existing sessions, agents, calls, approval
 * decisions, current turn, counters and history boundaries are untouched;
 * only missing fields receive defaults.
 *
 * v2 → v3: `recentTurnIds` and `staleTurnEvents` were added per session. No
 * past turn identity is invented: the only id seeded is the stored current
 * turn's own id (when present), which the v3 reducer would have recorded.
 * v3 → v4: agents gained `model`/`task`/`taskEvidence`/`taskToolId`, tool
 * calls gained `subagentType`/`subagentModel`/`taskDescription`/
 * `spawnedAgentId`. All default to null: no task or model is invented for
 * agents whose delegation call was not observed.
 */
export function upgradeState(state: TownState): TownState {
  const raw = state as Partial<TownState> & { schemaVersion?: number };
  if (typeof raw.schemaVersion !== 'number') raw.schemaVersion = 2;
  if (!raw.sessions || typeof raw.sessions !== 'object') raw.sessions = createDict();
  if (!Array.isArray(raw.sessionOrder)) raw.sessionOrder = ownKeys(raw.sessions);
  if (typeof raw.lastSeq !== 'number') raw.lastSeq = 0;
  if (typeof raw.eventsApplied !== 'number') raw.eventsApplied = 0;
  if (typeof raw.historyFromSeq !== 'number') raw.historyFromSeq = 0;
  if (typeof raw.prunedSessions !== 'number') raw.prunedSessions = 0;
  for (const s of ownValues(raw.sessions)) upgradeSession(s);
  raw.schemaVersion = STATE_SCHEMA_VERSION;
  return state;
}

/** Per-session part of upgradeState; also used as a guard by the reducer. */
function upgradeSession(s: SessionState): SessionState {
  const raw = s as Partial<SessionState>;
  if (!Array.isArray(raw.recentTurnIds)) {
    raw.recentTurnIds = raw.currentTurn?.turnId ? [raw.currentTurn.turnId] : [];
  }
  if (typeof raw.staleTurnEvents !== 'number') raw.staleTurnEvents = 0;
  if (raw.agents) {
    for (const a of ownValues(raw.agents)) {
      const ra = a as Partial<AgentState>;
      if (ra.model === undefined) ra.model = null;
      if (ra.task === undefined) ra.task = null;
      if (ra.taskEvidence === undefined) ra.taskEvidence = null;
      if (ra.taskToolId === undefined) ra.taskToolId = null;
      // v4 → v5: whether the start was observed is unknown for stored agents; keep them visible.
      if (ra.startObserved === undefined) ra.startObserved = true;
    }
  }
  if (raw.currentTurn && (raw.currentTurn as Partial<TurnState>).endEvidence === undefined) {
    (raw.currentTurn as Partial<TurnState>).endEvidence = raw.currentTurn.status === 'running' ? null : 'observed';
  }
  if (raw.toolCalls) {
    for (const tc of ownValues(raw.toolCalls)) {
      const rt = tc as Partial<ToolCallState>;
      if (rt.subagentType === undefined) rt.subagentType = null;
      if (rt.subagentModel === undefined) rt.subagentModel = null;
      if (rt.taskDescription === undefined) rt.taskDescription = null;
      if (rt.spawnedAgentId === undefined) rt.spawnedAgentId = null;
    }
  }
  return s;
}

export function cloneState(state: TownState): TownState {
  return upgradeState(JSON.parse(JSON.stringify(state)) as TownState);
}

export function toolKey(agentId: string, sourceId: string): string {
  return `${agentId}${KEY_SEP}${sourceId}`;
}

function projectNameFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function newAgent(
  id: string,
  idOrigin: AgentState['idOrigin'],
  role: AgentState['role'],
  at: string,
  characterIndex: number,
): AgentState {
  return {
    id,
    idOrigin,
    role,
    agentType: null,
    parentAgentId: null,
    parentEvidence: 'unknown',
    lifecycle: 'active',
    lastResponse: null,
    startedAt: at,
    lastActivityAt: at,
    activeToolIds: [],
    pendingApprovalIds: [],
    lastToolId: null,
    lastError: null,
    characterIndex,
    responsesCompleted: 0,
    waitingForInput: false,
    model: null,
    task: null,
    taskEvidence: null,
    taskToolId: null,
    startObserved: false,
  };
}

function ensureSession(state: TownState, ev: AgentEvent): SessionState {
  const key = sessionKey(ev.provider, ev.sessionId);
  let s = getOwn(state.sessions, key);
  if (!s) {
    s = {
      key,
      provider: ev.provider,
      sessionId: ev.sessionId,
      source: ev.source,
      cwd: ev.cwd,
      projectName: projectNameFromCwd(ev.cwd),
      model: ev.payload.model ?? null,
      lifecycle: 'unknown',
      startedAt: ev.receivedAt,
      lastEventAt: ev.receivedAt,
      lastSeq: 0,
      eventCount: 0,
      currentTurn: null,
      turnsCompleted: 0,
      recentTurnIds: [],
      staleTurnEvents: 0,
      agents: createDict(),
      toolCalls: createDict(),
      approvals: createDict(),
      podIndex: state.sessionOrder.length + state.prunedSessions,
      unknownEvents: 0,
      duplicatesIgnored: 0,
    };
    setOwn(state.sessions, key, s);
    state.sessionOrder.push(key);
    // Every session has an explicit root agent; providers that omit a root
    // agent id map it to 'main' (idOrigin 'internal-main').
    const main = newAgent(MAIN_AGENT_ID, 'internal-main', 'main', ev.receivedAt, 0);
    main.startObserved = true;
    setOwn(s.agents, MAIN_AGENT_ID, main);
  }
  if (!s.cwd && ev.cwd) {
    s.cwd = ev.cwd;
    s.projectName = projectNameFromCwd(ev.cwd);
  }
  // Latest stated model wins: SessionStart, a model switch, or (Codex) the
  // turn's model. Only session-level payloads carry `model`; a delegation
  // call's requested model travels as `subagentModel` and never lands here.
  if (ev.payload.model) s.model = ev.payload.model;
  // A session loaded from an older checkpoint may lack v3 fields; defaults are
  // added here so the reducer never depends on the caller having upgraded.
  return upgradeSession(s);
}

function ensureAgent(s: SessionState, ev: AgentEvent, role?: 'main' | 'subagent'): AgentState {
  let a = getOwn(s.agents, ev.agentId);
  if (!a) {
    const isMain = ev.agentId === MAIN_AGENT_ID || ev.agentIdOrigin === 'internal-main';
    a = newAgent(
      ev.agentId,
      ev.agentIdOrigin,
      role ?? (isMain ? 'main' : 'subagent'),
      ev.receivedAt,
      Object.keys(s.agents).length,
    );
    a.agentType = ev.payload.agentType ?? null;
    if (ev.parentAgentId) {
      a.parentAgentId = ev.parentAgentId;
      a.parentEvidence = 'provider-semantics';
    }
    // An agent first seen through its own end (SubagentStop) or the session's
    // end did nothing observable; anything else proves it was active.
    a.startObserved = ev.kind !== 'agent.response_completed' && ev.kind !== 'session.ended';
    setOwn(s.agents, ev.agentId, a);
  } else {
    if (!a.agentType && ev.payload.agentType) a.agentType = ev.payload.agentType;
    if (!a.parentAgentId && ev.parentAgentId) {
      a.parentAgentId = ev.parentAgentId;
      a.parentEvidence = 'provider-semantics';
    }
  }
  a.lastActivityAt = ev.receivedAt;
  return a;
}

function removeFrom(list: string[], id: string): void {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

function callKey(ev: AgentEvent): { id: string; sourceId: string | null; known: boolean } {
  if (ev.toolCallId) {
    return { id: toolKey(ev.agentId, ev.toolCallId), sourceId: ev.toolCallId, known: true };
  }
  return { id: `${ev.agentId}${KEY_SEP}unknown:${ev.eventId}`, sourceId: null, known: false };
}

function outcomeToStatus(outcome: ToolOutcome | undefined, kind: AgentEvent['kind']): ToolStatus {
  if (outcome === 'denied') return 'denied';
  if (outcome === 'failed' || kind === 'tool.failed') return 'failed';
  if (outcome === 'unknown') return 'ended';
  return 'completed';
}

const TERMINAL: ReadonlySet<ToolStatus> = new Set(['completed', 'failed', 'denied', 'ended']);

/**
 * Resolve (or refine) an approval.
 * - pending → resolved with the given decision/evidence.
 * - resolved by inference (turn ended, decision unknown) → refined when later
 *   OBSERVED evidence for the same agent-scoped call arrives.
 * - resolved by observation → never rewritten (no contradictions).
 */
function resolveApproval(
  s: SessionState,
  approvalId: string,
  ev: AgentEvent,
  decision: ApprovalState['decision'],
  evidence: Evidence,
): void {
  const ap = getOwn(s.approvals, approvalId);
  if (!ap) return;
  if (ap.status === 'resolved') {
    if (ap.resolutionEvidence === 'inferred' && evidence === 'observed') {
      ap.decision = decision;
      ap.resolutionEvidence = 'observed';
      ap.resolvedAt = ev.receivedAt;
    }
    return;
  }
  ap.status = 'resolved';
  ap.decision = decision;
  ap.resolutionEvidence = evidence;
  ap.resolvedAt = ev.receivedAt;
  const a = getOwn(s.agents, ap.agentId);
  if (a) removeFrom(a.pendingApprovalIds, approvalId);
}

/** What a tool outcome says about the approval that preceded it. */
function approvalDecisionFor(status: ToolStatus): ApprovalState['decision'] {
  if (status === 'denied') return 'denied';
  // 'ended' = the source supplied no outcome: the call ended but nothing more.
  if (status === 'ended') return 'unknown';
  return 'allowed';
}

const MAX_RECENT_TURNS = 50;

function rememberTurn(s: SessionState, turnId: string | null): void {
  if (!turnId) return;
  if (s.recentTurnIds.includes(turnId)) return;
  s.recentTurnIds.push(turnId);
  if (s.recentTurnIds.length > MAX_RECENT_TURNS) s.recentTurnIds.shift();
}

type TurnScope = 'current' | 'stale' | 'unknown' | 'unscoped';

/**
 * Relate a turn-scoped event to the session's current turn using source turn
 * ids only. Without ids on both sides no chronology is guessed ('unscoped' =
 * apply to the current turn as before).
 */
function turnScope(s: SessionState, ev: AgentEvent): TurnScope {
  if (!ev.turnId || !s.currentTurn || !s.currentTurn.turnId) return 'unscoped';
  if (ev.turnId === s.currentTurn.turnId) return 'current';
  if (s.recentTurnIds.includes(ev.turnId)) return 'stale';
  return 'unknown';
}

function newCall(
  ev: AgentEvent,
  key: { id: string; sourceId: string | null; known: boolean },
  status: ToolStatus,
): ToolCallState {
  const running = status === 'running';
  return {
    id: key.id,
    sourceId: key.sourceId,
    idKnown: key.known,
    agentId: ev.agentId,
    toolName: ev.payload.toolName ?? 'unknown',
    target: ev.payload.toolTarget ?? null,
    activity: ev.payload.activity ?? 'other',
    status,
    startedAt: running ? ev.receivedAt : null,
    endedAt: running ? null : ev.receivedAt,
    startSeq: ev.ingestSeq,
    endSeq: running ? null : ev.ingestSeq,
    error: running ? null : (ev.payload.error ?? null),
    exitCode: running ? null : (ev.payload.exitCode ?? null),
    outOfOrder: !running,
    endedByTurn: false,
    lateOutcome: false,
    duplicateEvents: 0,
    subagentType: ev.payload.subagentType ?? null,
    subagentModel: ev.payload.subagentModel ?? null,
    taskDescription: ev.payload.taskDescription ?? null,
    spawnedAgentId: null,
  };
}

/**
 * Link a newly started child agent to the delegation call (Agent/Task/
 * spawn_agent) that most plausibly created it. No provider payload carries
 * an id that ties a SubagentStart to its Agent tool_use_id, so this is an
 * inference and is recorded as such (`taskEvidence: 'inferred'`):
 * - candidates are running, still-unlinked delegation calls of another agent
 *   (the known parent when there is one);
 * - a candidate whose requested subagent type contradicts the child's
 *   reported type is excluded; typed matches are preferred over untyped;
 * - the oldest remaining candidate is chosen (delegations start in order).
 * With no candidate the child simply has no task; nothing is invented.
 */
function linkSpawnCall(s: SessionState, a: AgentState): void {
  if (a.role !== 'subagent' || a.taskToolId) return;
  const candidates = ownValues(s.toolCalls).filter(
    (tc) =>
      tc.activity === 'agent' &&
      tc.status === 'running' &&
      !tc.spawnedAgentId &&
      tc.agentId !== a.id &&
      (!a.parentAgentId || tc.agentId === a.parentAgentId) &&
      (!tc.subagentType || !a.agentType || tc.subagentType === a.agentType),
  );
  if (candidates.length === 0) return;
  const typed = a.agentType ? candidates.filter((tc) => tc.subagentType === a.agentType) : [];
  const pool = typed.length > 0 ? typed : candidates;
  pool.sort((x, y) => x.startSeq - y.startSeq);
  const tc = pool[0]!;
  tc.spawnedAgentId = a.id;
  a.taskToolId = tc.id;
  a.task = tc.taskDescription ?? tc.target;
  a.taskEvidence = 'inferred';
  if (!a.model && tc.subagentModel) a.model = tc.subagentModel;
}

function finishTool(s: SessionState, ev: AgentEvent, status: ToolStatus): ToolCallState {
  const key = callKey(ev);
  const a = ensureAgent(s, ev);
  let tc = getOwn(s.toolCalls, key.id);
  if (tc) {
    if (TERMINAL.has(tc.status)) {
      // Terminal status is sticky: a duplicate or conflicting completion never
      // rewrites history. Count it for diagnostics.
      tc.duplicateEvents++;
      s.duplicatesIgnored++;
      return tc;
    }
    if (tc.status === 'unresolved') tc.lateOutcome = true;
    tc.status = status;
    tc.endedAt = ev.receivedAt;
    tc.endSeq = ev.ingestSeq;
    tc.error = ev.payload.error ?? null;
    tc.exitCode = ev.payload.exitCode ?? null;
  } else {
    // Completion arrived before (or without) a start event. Record it as a
    // terminal call and mark it out-of-order; a later start will not reopen it.
    tc = newCall(ev, key, status);
    setOwn(s.toolCalls, key.id, tc);
  }
  removeFrom(a.activeToolIds, key.id);
  a.lastToolId = key.id;
  if (status === 'failed' || status === 'denied') {
    a.lastError = tc.error ?? (status === 'denied' ? '승인 거부' : '도구 실패');
  }
  // An outcome for this call is explicit evidence about the approval for the
  // same agent-scoped call (also refines an earlier inferred resolution).
  if (key.known && hasOwn(s.approvals, key.id)) {
    resolveApproval(s, key.id, ev, approvalDecisionFor(status), 'observed');
  }
  return tc;
}

/** Mark an agent's running tools as unresolved when its response ends. */
function closeRunningTools(s: SessionState, a: AgentState, ev: AgentEvent): void {
  for (const id of [...a.activeToolIds]) {
    const tc = getOwn(s.toolCalls, id);
    if (tc && tc.status === 'running') {
      tc.status = 'unresolved';
      tc.endedAt = ev.receivedAt;
      tc.endSeq = ev.ingestSeq;
      tc.endedByTurn = true;
    }
    removeFrom(a.activeToolIds, id);
  }
}

function inferApprovalsOnTurnEnd(s: SessionState, a: AgentState, ev: AgentEvent): void {
  for (const id of [...a.pendingApprovalIds]) {
    resolveApproval(s, id, ev, 'unknown', 'inferred');
  }
}

/**
 * Claude Code announces one permission prompt twice: `PermissionRequest`
 * (with the tool_use_id) and `Notification: permission_prompt` (without any
 * id). The id-less record cannot be matched to an outcome, so on its own it
 * would stay pending until the turn ends - long after the user answered and
 * the tool ran ("승인 대기" shown while the command is executing). It is
 * therefore resolved (decision unknown, evidence inferred) as soon as the
 * agent is observed to proceed: a known-id request for the same agent (the
 * same prompt, now tracked precisely), any tool start/outcome of that agent,
 * or an observed approval resolution. Known-id approvals are never touched
 * by this; they still wait for their own outcome or PermissionDenied.
 */
function resolveIdlessApprovals(s: SessionState, a: AgentState, ev: AgentEvent): void {
  for (const id of [...a.pendingApprovalIds]) {
    const ap = getOwn(s.approvals, id);
    if (ap && !ap.idKnown) resolveApproval(s, id, ev, 'unknown', 'inferred');
  }
}

function hasPendingKnownApproval(s: SessionState, a: AgentState): boolean {
  return a.pendingApprovalIds.some((id) => getOwn(s.approvals, id)?.idKnown === true);
}

/** Complete the session's current turn exactly once. */
function completeTurn(
  s: SessionState,
  ev: AgentEvent,
  status: Exclude<TurnState['status'], 'running'>,
  evidence: Evidence = 'observed',
): void {
  if (s.currentTurn && s.currentTurn.status === 'running') {
    s.currentTurn.status = status;
    s.currentTurn.endedAt = ev.receivedAt;
    s.currentTurn.endEvidence = evidence;
    rememberTurn(s, s.currentTurn.turnId);
    if (status === 'completed') s.turnsCompleted++;
  }
}

/**
 * The Esc case. Claude Code fires no Stop when the user interrupts a turn:
 * the next observable facts are a new UserPromptSubmit (a different turn id
 * while this one is still "running") or an idle_prompt notification
 * (Claude has been waiting for input for 60 s+). Either proves the running
 * turn ended without an end event. It is closed as `interrupted` with
 * evidence `inferred`; every agent's running tools become `unresolved`
 * (never completed), pending approvals resolve as inferred, and active
 * agents go idle with lastResponse `interrupted`. Any later tool activity
 * makes an agent active again, so nothing is lost if it was in fact still
 * working. Returns true when a turn was closed.
 */
function interruptOpenTurn(s: SessionState, ev: AgentEvent): boolean {
  if (!s.currentTurn || s.currentTurn.status !== 'running') return false;
  completeTurn(s, ev, 'interrupted', 'inferred');
  for (const a of ownValues(s.agents)) {
    closeRunningTools(s, a, ev);
    inferApprovalsOnTurnEnd(s, a, ev);
    if (a.lifecycle === 'active') {
      a.lifecycle = 'idle';
      a.lastResponse = 'interrupted';
    }
    a.waitingForInput = false;
  }
  return true;
}

/**
 * Turn-scoped terminal events (Stop, Interrupt, turn completion) that name a
 * turn other than the current one are not evidence about the current turn.
 * Returns true when the event must be ignored.
 */
function ignoreIfOtherTurn(s: SessionState, ev: AgentEvent): boolean {
  const scope = turnScope(s, ev);
  if (scope === 'stale') {
    s.staleTurnEvents++;
    return true;
  }
  if (scope === 'unknown') {
    // A turn we never saw start: cannot be related to anything. Counted, not applied.
    s.unknownEvents++;
    return true;
  }
  return false;
}

/** Apply one event. Mutates and returns `state`. */
export function applyEvent(state: TownState, ev: AgentEvent): TownState {
  const s = ensureSession(state, ev);
  s.eventCount++;
  s.lastEventAt = ev.receivedAt;
  if (ev.ingestSeq > s.lastSeq) s.lastSeq = ev.ingestSeq;
  if (ev.ingestSeq > state.lastSeq) state.lastSeq = ev.ingestSeq;
  state.eventsApplied++;

  switch (ev.kind) {
    case 'session.started': {
      s.lifecycle = 'active';
      const a = ensureAgent(s, ev, 'main');
      a.lifecycle = 'active';
      break;
    }
    case 'session.ended': {
      s.lifecycle = 'ended';
      for (const a of ownValues(s.agents)) {
        closeRunningTools(s, a, ev);
        a.lifecycle = 'ended';
      }
      completeTurn(s, ev, 'interrupted');
      break;
    }
    case 'turn.started': {
      if (ev.turnId) {
        if (s.currentTurn?.turnId === ev.turnId && s.currentTurn.status === 'running') {
          s.duplicatesIgnored++; // duplicate start of the running turn
          break;
        }
        if (s.recentTurnIds.includes(ev.turnId)) {
          s.staleTurnEvents++; // re-delivered start of a finished turn: never reopened
          break;
        }
      }
      // A new turn while the previous one never ended = the previous one was
      // interrupted (Esc): close it and its leftovers before starting fresh.
      interruptOpenTurn(s, ev);
      if (s.currentTurn) rememberTurn(s, s.currentTurn.turnId);
      if (s.lifecycle !== 'ended') s.lifecycle = 'active';
      s.currentTurn = { turnId: ev.turnId, startedAt: ev.receivedAt, status: 'running', endedAt: null, endEvidence: null };
      rememberTurn(s, ev.turnId);
      const a = ensureAgent(s, ev);
      a.lifecycle = 'active';
      a.startObserved = true;
      a.lastResponse = null;
      a.lastError = null;
      a.waitingForInput = false;
      break;
    }
    case 'turn.completed': {
      if (ignoreIfOtherTurn(s, ev)) break;
      completeTurn(s, ev, 'completed');
      break;
    }
    case 'turn.failed': {
      if (ignoreIfOtherTurn(s, ev)) break;
      const a = ensureAgent(s, ev);
      const interrupted = ev.payload.reason === 'interrupted';
      completeTurn(s, ev, interrupted ? 'interrupted' : 'failed');
      a.lastResponse = interrupted ? 'interrupted' : 'failed';
      a.lifecycle = 'idle';
      a.lastError = ev.payload.error ?? (interrupted ? '사용자 중단' : '턴 실패');
      closeRunningTools(s, a, ev);
      inferApprovalsOnTurnEnd(s, a, ev);
      break;
    }
    case 'agent.started': {
      const a = ensureAgent(s, ev, ev.agentId === MAIN_AGENT_ID ? 'main' : 'subagent');
      a.lifecycle = 'active';
      a.startObserved = true;
      a.lastResponse = null;
      if (ev.payload.agentType) a.agentType = ev.payload.agentType;
      if (s.lifecycle !== 'ended') s.lifecycle = 'active';
      linkSpawnCall(s, a);
      break;
    }
    case 'agent.response_completed': {
      if (ignoreIfOtherTurn(s, ev)) break;
      const a = ensureAgent(s, ev);
      a.lifecycle = 'idle';
      a.lastResponse = 'completed';
      a.responsesCompleted++;
      a.waitingForInput = false;
      closeRunningTools(s, a, ev);
      inferApprovalsOnTurnEnd(s, a, ev);
      // Only the root agent's response completion ends the session turn.
      if (a.role === 'main') completeTurn(s, ev, 'completed');
      break;
    }
    case 'tool.started': {
      const key = callKey(ev);
      const a = ensureAgent(s, ev);
      const existing = getOwn(s.toolCalls, key.id);
      if (existing) {
        // Duplicate start, or a start arriving after its own completion:
        // never changes status and never reactivates the agent.
        existing.duplicateEvents++;
        s.duplicatesIgnored++;
        if (existing.startedAt === null) {
          existing.startedAt = ev.receivedAt;
          if (!existing.target && ev.payload.toolTarget) existing.target = ev.payload.toolTarget;
          if (existing.toolName === 'unknown' && ev.payload.toolName) {
            existing.toolName = ev.payload.toolName;
            existing.activity = ev.payload.activity ?? existing.activity;
          }
        }
        break;
      }
      a.lifecycle = 'active';
      a.startObserved = true;
      if (s.lifecycle !== 'ended') s.lifecycle = 'active';
      setOwn(s.toolCalls, key.id, newCall(ev, key, 'running'));
      a.activeToolIds.push(key.id);
      // The agent moved on: an id-less permission prompt is no longer pending.
      resolveIdlessApprovals(s, a, ev);
      break;
    }
    case 'tool.completed':
    case 'tool.failed': {
      finishTool(s, ev, outcomeToStatus(ev.payload.outcome, ev.kind));
      resolveIdlessApprovals(s, ensureAgent(s, ev), ev);
      break;
    }
    case 'approval.requested': {
      const a = ensureAgent(s, ev);
      const key = callKey(ev);
      if (hasOwn(s.approvals, key.id)) {
        s.duplicatesIgnored++;
        break;
      }
      if (key.known) {
        // The precise request supersedes the id-less prompt notification of the same agent.
        resolveIdlessApprovals(s, a, ev);
      } else if (hasPendingKnownApproval(s, a)) {
        // The prompt is already tracked by its tool id; a second, id-less
        // record would only linger. Counted, not created.
        s.duplicatesIgnored++;
        break;
      }
      const tc = getOwn(s.toolCalls, key.id);
      const ap: ApprovalState = {
        id: key.id,
        sourceId: key.sourceId,
        idKnown: key.known,
        agentId: ev.agentId,
        toolName: ev.payload.toolName ?? tc?.toolName ?? null,
        target: ev.payload.toolTarget ?? tc?.target ?? null,
        status: 'pending',
        decision: null,
        resolutionEvidence: null,
        requestedAt: ev.receivedAt,
        resolvedAt: null,
        requestSeq: ev.ingestSeq,
      };
      setOwn(s.approvals, key.id, ap);
      if (tc && TERMINAL.has(tc.status)) {
        // The call already finished: the request is stale evidence.
        ap.status = 'resolved';
        ap.decision = approvalDecisionFor(tc.status);
        ap.resolutionEvidence = 'observed';
        ap.resolvedAt = ev.receivedAt;
      } else {
        a.pendingApprovalIds.push(key.id);
      }
      break;
    }
    case 'approval.resolved': {
      const a = ensureAgent(s, ev);
      const decision = ev.payload.decision ?? 'unknown';
      if (!ev.toolCallId) {
        // No id: cannot link to a specific request. Do not guess.
        s.unknownEvents++;
        break;
      }
      const key = callKey(ev);
      resolveIdlessApprovals(s, a, ev);
      if (hasOwn(s.approvals, key.id)) {
        resolveApproval(s, key.id, ev, decision, 'observed');
      } else {
        setOwn(s.approvals, key.id, {
          id: key.id,
          sourceId: key.sourceId,
          idKnown: true,
          agentId: ev.agentId,
          toolName: ev.payload.toolName ?? null,
          target: ev.payload.toolTarget ?? null,
          status: 'resolved',
          decision,
          resolutionEvidence: 'observed',
          requestedAt: ev.receivedAt,
          resolvedAt: ev.receivedAt,
          requestSeq: ev.ingestSeq,
        });
      }
      if (decision === 'denied') {
        const tc = getOwn(s.toolCalls, key.id);
        if (tc && !TERMINAL.has(tc.status)) {
          if (tc.status === 'unresolved') tc.lateOutcome = true;
          tc.status = 'denied';
          tc.endedAt = ev.receivedAt;
          tc.endSeq = ev.ingestSeq;
          removeFrom(a.activeToolIds, key.id);
          a.lastToolId = key.id;
          a.lastError = '승인 거부';
        } else if (!tc) {
          setOwn(s.toolCalls, key.id, newCall(ev, key, 'denied'));
          a.lastToolId = key.id;
          a.lastError = '승인 거부';
        }
      }
      break;
    }
    case 'notification': {
      const a = ensureAgent(s, ev);
      const t = ev.payload.notificationType;
      if (t === 'idle_prompt' || t === 'agent_needs_input') {
        // Claude has been waiting for input for 60 s+. If the root agent's
        // turn is still "running" and nothing is awaiting a permission
        // answer, the turn ended without a Stop (interrupted with Esc).
        if (a.role === 'main' && s.currentTurn?.status === 'running' && a.pendingApprovalIds.length === 0) {
          interruptOpenTurn(s, ev);
        }
        a.waitingForInput = true;
      }
      break;
    }
    case 'unknown':
    default: {
      s.unknownEvents++;
    }
  }
  return state;
}

export function applyEvents(state: TownState, events: Iterable<AgentEvent>): TownState {
  for (const ev of events) applyEvent(state, ev);
  return state;
}

/**
 * Remove sessions whose whole history is being discarded by retention. Called
 * with the same rule on the checkpoint state and on the live state so that a
 * restart reconstructs exactly the live state.
 */
export function pruneSessions(state: TownState, shouldPrune: (s: SessionState) => boolean): number {
  let n = 0;
  for (const key of [...state.sessionOrder]) {
    const s = getOwn(state.sessions, key);
    if (!s || !shouldPrune(s)) continue;
    deleteOwn(state.sessions, key);
    removeFrom(state.sessionOrder, key);
    n++;
  }
  state.prunedSessions += n;
  return n;
}

/** Representative display status for an agent (computed, never stored). */
export type AgentDisplayStatus =
  | 'working'
  | 'awaiting_approval'
  | 'waiting_input'
  | 'failed'
  | 'done'
  | 'idle'
  | 'ended'
  | 'unknown';

export function agentDisplayStatus(s: SessionState, a: AgentState): AgentDisplayStatus {
  if (a.lifecycle === 'ended' || s.lifecycle === 'ended') return 'ended';
  if (a.pendingApprovalIds.length > 0) return 'awaiting_approval';
  if (a.waitingForInput) return 'waiting_input';
  if (a.activeToolIds.length > 0) return 'working';
  if (a.lastResponse === 'failed' || a.lastResponse === 'interrupted') return 'failed';
  const lastStatus = a.lastToolId ? getOwn(s.toolCalls, a.lastToolId)?.status : undefined;
  if (a.lifecycle === 'active') {
    if (lastStatus === 'failed' || lastStatus === 'denied') return 'failed';
    // Active with no running tool: only a running turn (observed
    // UserPromptSubmit) justifies "working". A bare SessionStart is idle.
    if (s.currentTurn?.status === 'running') return 'working';
    return 'idle';
  }
  if (a.lastResponse === 'completed') return 'done';
  return 'unknown';
}

export const AGENT_STATUS_LABEL_KO: Record<AgentDisplayStatus, string> = {
  working: '작업 중',
  awaiting_approval: '승인 대기',
  waiting_input: '입력 대기',
  failed: '실패',
  done: '응답 완료',
  idle: '대기',
  ended: '세션 종료',
  unknown: '상태 미확인',
};

/**
 * Model shown for an agent: the model its delegation call requested, else the
 * session's model. `source` says which, so the UI can label inheritance.
 */
export function effectiveModel(
  s: SessionState,
  a: AgentState,
): { model: string | null; source: 'agent' | 'session' | 'none' } {
  if (a.model) return { model: a.model, source: 'agent' };
  if (s.model) return { model: s.model, source: 'session' };
  return { model: null, source: 'none' };
}

export interface AgentWorkSummary {
  /** Tool calls observed for the agent (any status). */
  total: number;
  failed: number;
  /** Per activity class, most frequent first. */
  byActivity: Array<{ activity: ActivityClass; count: number }>;
  /** Most recently started call, running or not. */
  lastCall: ToolCallState | null;
}

/** What an agent actually did, from observed tool calls only (computed, never stored). */
export function agentWorkSummary(s: SessionState, a: AgentState): AgentWorkSummary {
  const counts = new Map<ActivityClass, number>();
  let total = 0;
  let failed = 0;
  let lastCall: ToolCallState | null = null;
  for (const tc of ownValues(s.toolCalls)) {
    if (tc.agentId !== a.id) continue;
    total++;
    if (tc.status === 'failed' || tc.status === 'denied') failed++;
    counts.set(tc.activity, (counts.get(tc.activity) ?? 0) + 1);
    if (!lastCall || tc.startSeq > lastCall.startSeq) lastCall = tc;
  }
  const byActivity = [...counts.entries()]
    .map(([activity, count]) => ({ activity, count }))
    .sort((x, y) => y.count - x.count);
  return { total, failed, byActivity, lastCall };
}

/** Korean one-liner for a work summary, e.g. "읽기 3 · 검색 2 · 수정 1"; null when no tool was observed. */
export function workSummaryLabel(w: AgentWorkSummary, maxParts = 4): string | null {
  if (w.total === 0) return null;
  const parts = w.byActivity.slice(0, maxParts).map((p) => `${ACTIVITY_LABEL_KO[p.activity]} ${p.count}`);
  if (w.byActivity.length > maxParts) parts.push('…');
  const failed = w.failed > 0 ? ` · 실패 ${w.failed}` : '';
  return `${parts.join(' · ')}${failed}`;
}

export const TOOL_STATUS_LABEL_KO: Record<ToolStatus, string> = {
  running: '진행 중',
  completed: '완료',
  failed: '실패',
  denied: '승인 거부',
  ended: '종료 · 결과 미확인',
  unresolved: '종료 근거 없음',
};
