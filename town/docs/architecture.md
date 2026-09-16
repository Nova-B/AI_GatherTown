# Agent Town architecture

## Decision: self-contained app in `town/`, upstream kept for assets

Upstream Pixel Agents (commit `3537e140c2094761beae748592aeb92ece8edfdd`, MIT) was evaluated as the extension base. It was not extended because its runtime assumes a single active provider with module-level provider state, and its Claude normalization synthesizes tool ids from `Date.now()` and ends the "current" call on completion. Accurate dual-provider observation with concurrent tool calls keyed by real ids would have required replacing that runtime and the wire protocol. The upstream code, notices and assets are preserved untouched; Agent Town reuses only the PNG assets (see `assets.md`) and the visual conventions (16 px tiles, character sheet slicing, wall auto-tiling).

## Data flow

```
Claude Code ──hook stdin──▶ hook/agent-town-hook.mjs ──POST /api/ingest──▶ Node server
Codex CLI   ──hook stdin──▶ (same sender, --provider codex)                 │
                                                                            ├─ shared/providers/{claude,codex}.ts  normalize → AgentEvent
                                                                            ├─ SQLite (node:sqlite)   events(seq AUTOINCREMENT, event_id UNIQUE) + checkpoint
                                                                            ├─ shared/state.ts reducer                live TownState
                                                                            └─ WebSocket /ws                          snapshot + incremental events
Browser (React + Phaser) ── same reducer ── office scene, panels, timeline, replay
```

- `src/shared/` is provider-agnostic and shared by server and client: event schema, redaction, activity classification, the reducer, safe dictionaries, and the provider normalizers (pure functions, so the DEMO mode can run them in the browser).
- The reducer is deterministic: `checkpoint + events after it` reconstructs the live state on restart and drives the history scrubber.

## Identity and state rules (implemented in `src/shared/state.ts`)

| Situation | Behaviour |
|---|---|
| Same `session_id` in both CLIs | Separate sessions keyed `provider:sessionId` |
| Root agent | Explicit `main`, `agentIdOrigin: internal-main`, created with the session |
| Child agent | Only from `SubagentStart`/`SubagentStop` (with `agent_id`). The `Agent`/`Task` tool name never creates a character |
| Child ↔ delegation call | No payload links a child to the parent's `Agent` tool_use_id. On `agent.started` the child is linked to the oldest running, unlinked delegation call (activity `agent`) of its parent (any agent when the parent is unknown) whose requested `subagent_type` does not contradict the child's `agent_type`, typed matches first. Stored as `task`/`taskToolId`/`taskEvidence: 'inferred'` on the agent and `spawnedAgentId` on the call; no candidate → no task. Displayed with an "추정 연결" tag |
| Model | Session: latest stated `model` (SessionStart; Claude `PostModelSwitch` `to_model`; Codex turn). Agent: the delegation call's requested `model` (alias such as `sonnet` kept as given), else the session model, labelled "(세션 모델)"; nothing else is inferred. A tool payload never touches the session model |
| Immediate parent | Claude: the session root (`parentEvidence: provider-semantics`, subagents cannot spawn subagents). Codex: unknown (`null`); the hook only proves session membership and Codex agents may be nested. The UI shows "세션 소속" and "직접 상위" separately |
| Tool calls | Keyed by (agent id, `tool_use_id`); the provider id is kept in `sourceId`. Two agents using the same agent-local id never collide. Missing id → explicit unknown record, never linked by time |
| Concurrency | Finishing one call never touches others |
| Terminal statuses | completed / failed / denied / ended are sticky: duplicates and late starts are counted, never applied, and never reactivate the agent |
| `unresolved` | Provisional: set when the agent's response ended with the call open; a later explicit outcome refines it (`lateOutcome` flag) |
| Out-of-order completion | Terminal record created immediately, flagged `outOfOrder` |
| Stop / SubagentStop | Agent → `idle`. Running tools → `unresolved`. The **root** agent's Stop also completes the session turn exactly once; a child's Stop never touches the parent's turn |
| Turn scoping | Stop / Interrupt / turn completion carrying a source turn id (`turn_id`, Claude `prompt_id`) that names a turn other than the current one are not evidence about the current turn: a known older turn → counted in `staleTurnEvents` and ignored (no tool closing, approval resolution, waiting-state or lifecycle change); an unseen turn → counted in `unknownEvents` and ignored. Without ids on both sides no chronology is guessed and the event applies to the current turn. Re-delivered starts of finished turns never reopen them. Tool outcomes are keyed by call, so a late outcome for an older turn's tool still refines that tool only |
| Approval refinement | An approval resolved by inference (turn ended, decision unknown) is refined when later **observed** evidence for the same agent-scoped call arrives (outcome → allowed, denied → denied). Observed decisions are never rewritten. An outcome without any source signal (`ended`) resolves the approval with decision `unknown` |
| Esc (no end event) | Claude Code fires no Stop when the user interrupts. The running turn is closed as `interrupted` with `endEvidence: 'inferred'` when either a new `turn.started` with a different turn id arrives or an `idle_prompt`/`agent_needs_input` notification reaches the root agent with no pending approval (Claude waited 60 s+ for input). Every agent's running tools become `unresolved`, pending approvals resolve as inferred, active agents go idle with `lastResponse: 'interrupted'`; any later tool activity reactivates an agent. A re-delivered start of the same turn id (a message sent mid-turn) is a duplicate, not an interruption |
| Start never observed | An agent first seen through its own `SubagentStop` (no SubagentStart, no tool call) gets `startObserved: false`: it stays in the state and panels ("시작 미관측") but is not drawn in the office. Any tool activity of that id flips it to true. Real recordings show several such stops per session |
| SessionEnd | Session and all agents `ended` |
| Interrupt (Codex) | Turn `interrupted`, agent shown as failed, not done |
| Approvals | Per (agent, call). Pending until an outcome for the same call / `PermissionDenied` (observed). On turn end they resolve with decision `unknown`, evidence `inferred`, labelled in the UI |
| Id-less prompts | Claude announces one prompt twice: `PermissionRequest` (tool id) and `Notification: permission_prompt` (no id). The id-less record is resolved (decision `unknown`, evidence `inferred`) as soon as the same agent is observed to proceed - a known-id request, any tool start/outcome, an observed approval resolution - and is not created at all while a known-id approval of that agent is pending (counted as duplicate). Known-id approvals are never touched by this rule. Prevents "승인 대기" lingering while the approved command runs |
| Display status | `working` only with a running tool or a running turn (observed UserPromptSubmit). A bare SessionStart is `idle`; sessions silent for 10 min are labelled "최근 활동 없음". Inactivity is never success or failure |
| Untrusted ids | All dictionaries keyed by provider ids use own-key access (`shared/dict.ts`); `__proto__`, `constructor`, `prototype` become own records and never touch `Object.prototype`. Control characters are stripped from ids |

## Security model

- Server binds `127.0.0.1` only (default port 4317, auto-fallback to the next free port unless `AGENT_TOWN_PORT` is set).
- Every request must present an allowed `Host` (loopback + port). Wrong Host → 421. URLs over 2 KB → 414. Bad percent-encoding → 4xx. Every request handler and socket message is wrapped; malformed input never crashes the process.
- `POST /api/ingest`: `Authorization: Bearer <ingest token>` compared in constant time on UTF-8 bytes (no length-mismatch throw); the token is generated once into `<dataDir>/ingest-token` (0600) and handed to the hook sender through `<dataDir>/server.json`. Requests carrying a browser `Origin` are rejected. Bodies over 256 KB → 413.
- Browser: `GET /api/bootstrap` (same-origin only, cross-site `Origin`/`Sec-Fetch-Site` rejected) returns a 24 h session token in the JSON body. It is sent as the first WebSocket message and as the `X-Agent-Town-Session` header. No token ever appears in a URL. WebSocket frames that are not `{type: auth|resync|ping}` objects are ignored.
- Static files: paths are decoded once, must not contain NUL or dot-segments, and must resolve strictly inside `dist/client` with a path-separator boundary (no sibling-prefix or encoded traversal). Nothing outside the built UI (data dir, supervision files) is served.
- There is no endpoint that executes commands, answers approvals, or modifies CLI settings.
- Redaction happens twice: in the hook sender before transmission and again in the server normalizer before storage. Masking runs before truncation. Covered: full `Authorization` headers (Bearer/Basic/...), bare `Bearer x`, JSON-quoted `"token": "..."`, `key=value`, `--token VALUE`/`--api-key=VALUE`, well-known key prefixes, JWTs, private keys, basic-auth URLs; the home directory becomes `~`. Only ids, tool names and bounded masked summaries are persisted (never prompts, transcripts, tool responses or file contents). `test/redact.test.ts` runs the same samples through the TypeScript and the plain-JS sender implementations.
- The hook sender only talks to a `server.json` whose host is loopback.

## State schema compatibility

`TownState.schemaVersion` is 4 (pass 3 added per-session `recentTurnIds` and `staleTurnEvents`; pass 5 added per-agent `model`/`task`/`taskEvidence`/`taskToolId` and per-call `subagentType`/`subagentModel`/`taskDescription`/`spawnedAgentId`, all defaulting to null so nothing is re-derived for stored agents). `upgradeState()` in `src/shared/state.ts` brings any older serialized state up to date in place: it only adds missing fields with defaults (`staleTurnEvents = 0`; `recentTurnIds = [currentTurn.turnId]` when a current turn id is stored, otherwise `[]`, so no past turn identity is invented) and leaves sessions, agents, calls, approval decisions, the current turn, counters and history boundaries untouched. It is idempotent and applied at every load boundary: `EventStore.loadCheckpoint` (the stored row is not rewritten until the next retention pass writes a current checkpoint), `reconstructState`/`stateBefore`, the client snapshot, the replay base and `cloneState`. The reducer additionally guards each session on access, so an old-shape state applied directly still works. Stale-turn protection stays fully active on upgraded state.

## Persistence and retention

- `events` table with monotonic `seq` (AUTOINCREMENT survives deletes) and UNIQUE `event_id` for idempotent retries.
- `checkpoint` table: reducer state at a seq. Retention (`src/server/retention.ts`, on start and hourly) picks a prune seq from the age (7 days), count (200 000) and size (250 MB) limits, advances the checkpoint by replaying the rows about to be deleted, prunes sessions whose whole history is discarded (ended, or silent longer than the age limit) from the checkpoint **and** the live state with the same rule, then deletes the rows in one transaction. `historyFromSeq` and `prunedSessions` are shown in diagnostics and the replay scrubber. Restart == live is covered by `test/store.test.ts`.
- `/api/replay` returns the last N events plus the state just before them, so the scrubber starts from a correct base even after retention.
- Hook spool: one file per envelope in `<dataDir>/spool/` (atomic tmp + rename), bounded to 400 files / 512 KB (bytes), claimed batches for concurrent flushers, oldest first. A live event queues behind any pending or in-flight backlog so source chronology is preserved (offline PreToolUse → reconnect Stop is delivered in order).

## UI

- Fixed world of 49×31 tiles: 6 rooms (3×2), each with a lead desk, three employee desks, bookshelf corner (read/search zone), whiteboard corner (shell zone), sofa (waiting-for-input zone).
- Rooms are sticky (`viewModel.allocateRooms`): a session keeps its room; free rooms go to unseated sessions in creation order, active first; an unseated active session may evict an ended session but never an active one. Over capacity, sessions are listed and flagged "자리 없음". Room maps are kept per view mode so DEMO/replay never disturb the live office.
- Office visibility (`viewModel.isAgentHidden`): an ended session is not drawn at all and its room is freed; an ended agent is not drawn; a finished employee (subagent whose response ended, no pending approval, not waiting for input) stays at its desk with a "완료 · {task}" bubble and an observed tool summary ("읽기 3 · 검색 1") until the user starts the session's next turn (an observed `turn.started` at or after the employee's last activity); then the previous task's employees leave. The state and the panels keep every session and agent; only the scene hides them. `OfficeView` still re-derives the view model once a second for the time-based "최근 활동 없음" labels; in replay mode the clock is the last replayed event's time.
- Session list order (`viewModel.sortSessions`): 진행 중 (running turn, running tool or pending approval) → 대기 중 (active, nothing running; stale ones last) → 종료, most recent activity first inside a group, with a small group caption where the group changes.
- Labels: the lead is "팀장"; helpers are named by their requested type ("탐색 담당 · Explore", "설계 담당 · Plan", "실무 담당 · general-purpose", "{type} 담당"), never "직원", with a per-type name-tag colour and a per-type sprite that is never the lead's. Several tool calls running at once are one agent's parallelism: the bubble reads "Read(읽기) · 병렬 3" and the tag "⇉3"; no extra character is ever drawn for a tool call. Tool names carry a Korean explanation from `activity.toolLabel` ("Grep(내용 검색)", "Bash(명령 실행)", "Skill(스킬 실행)", MCP tools as "search(MCP server)"); unknown names stay bare.
- Completion chime (`client/sound.ts`, toggle "완료 알림음" in the toolbar, persisted in `localStorage`, on by default): the store reports a live hook event that ends a session's running turn (`store.onTurnEnd`); `main.tsx` plays a two-note chime for `completed` and a low note for `failed`/`interrupted`, synthesized with the Web Audio API (no asset, no network). DEMO and replay never chime. Browsers require a user gesture before audio: the context is unlocked on the first click/key, and enabling the toggle plays a preview inside that click.
- Two Phaser cameras: the world camera zooms/pans; a second UI camera at zoom 1 renders bubbles, name tags and room labels in screen space (each camera ignores the other layer), so text is transformed once and stays anchored at any zoom. Overlap resolution uses the current projected rect even for hidden bubbles, so they reappear after movement.
- View modes: live, paused (frozen copy; live collection continues), replay (server window ≤5000 events on a correct base state, scrubber), DEMO (isolated in-memory state fed by fixtures through the same normalizers; badged everywhere; never persisted).
- Responsive toolbar: brand + connection on the first row, mode/camera controls on a wrapping second row; on narrow screens button labels collapse to icons so the brand, DEMO toggle and camera buttons stay visible.

## Known limits

- Live integration with the installed CLIs (Claude 2.1.270, Codex 0.154.0) was **not** exercised; all verification used fixture-shaped payloads matching the official hook documentation and `hook_runtime.rs`. Field-level differences in real payloads must be verified on first use.
- Codex hosted tools (e.g. WebSearch) do not fire local tool hooks and never appear.
- Codex tool outcome comes from `PostToolUse.tool_response` (`exit_code`, `isError`/`is_error`, `success`/`ok`, `error`); with no signal the call is "종료 · 결과 미확인", never success. Whether Codex tool hooks inside a subagent carry `agent_id` is inferred from `hook_runtime.rs` (the subagent context is passed to every tool request builder) but not verified live.
- Claude `Notification: permission_prompt` has no tool id; such approvals are shown as "tool unknown" and only resolved by turn end (labelled inferred).
- One character per agent; characters stay in their room; targets changing faster than ~1.8 s do not re-route the character (bubble updates immediately).
- Session logs / transcripts are not read; only hooks are used. No usage/token display. Single host, single environment.
