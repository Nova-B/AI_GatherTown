# Implementation report - Agent Town (pass 7: Esc, model switch check, helper labels, tool explanations)

Date: 2026-09-13 (passes 1-4), 2026-09-14 (pass 5), 2026-09-15 (pass 6), 2026-09-16 (pass 7). Environment: Windows 11 Pro 10.0.26200, Node v22.17.x, npm 10.9.2. Repository: pixel-agents at `3537e140c2094761beae748592aeb92ece8edfdd` (untouched) plus the new `town/` application, `AGENT_TOWN.md` and `Start-AgentTown.cmd`.

This report covers the first vertical slice, the pass-2 supervisor corrections, the pass-3 late-event corrections, the pass-4 checkpoint compatibility fix, the pass-5 user-requested UI changes, the pass-6 fixes and the pass-7 changes. The retrospect button lives on branch `feature/retrospect-button` (its own report section is on that branch). It is **not** the whole six-week plan: no Agent Teams/teammates, no transcript reading, no usage display, no multi-room walking, no WSL/remote hosts.

## Pass 7: Esc, model switch, helper labels, tool explanations (user feedback 2026-09-16)

**First real recordings.** Hooks were installed into the user's own project on 2026-09-15; `~/.agent-town/events.sqlite` held 72 Claude Code events from 3 sessions (13 hook types incl. `PostModelSwitch`). Read-only inspection established, before any change:

- Esc fires **no** `Stop`: seq 13 `PreToolUse Grep` is followed directly by seq 14 `UserPromptSubmit` with a new `prompt_id`; the Grep never completes. A message sent mid-turn re-fires `UserPromptSubmit` with the **same** `prompt_id` (seq 53 → 60).
- `/model` works end to end: seq 9 `PostModelSwitch` `claude-fable-5-1 → claude-opus-5[1m]` was ingested and the session model follows it. A `SessionStart` after `/clear` carries no `model`, the switch right after does; a `SessionStart` on `resume` carries the model. No code change was needed for the model itself.
- `SubagentStop` arrived 8 times for **1** `SubagentStart` (ids that never started and never used a tool): with the old rule each became a "직원 · 완료" character out of nowhere.
- A new tool name `SubagentHandback` appears inside a subagent; helpers run tools in parallel (two Greps at once).

| # | Request | Change | Where |
|---|---|---|---|
| 1 | Esc leaves the state wrong | `interruptOpenTurn`: a running turn is closed as `interrupted` with `endEvidence: 'inferred'` when a `turn.started` with a different id arrives, or an `idle_prompt`/`agent_needs_input` reaches the root agent with no pending approval. Running tools → `unresolved` (`endedByTurn`), approvals inferred, active agents idle/`interrupted` (re-activated by any later tool activity). Same-id re-delivery stays a duplicate. Details show "(종료 이벤트 없음 · 추정)" | `state.ts`, `DetailsPanel.tsx` |
| 2 | Is `/model` reflected? | Verified from recordings (above); tests already cover SessionStart + PostModelSwitch. No change | - |
| 3 | Do not lump helpers as "직원"; parallel work is not people | Helpers labelled by requested type ("탐색 담당 · Explore", "설계 담당 · Plan", "실무 담당 · general-purpose", "{type} 담당") with a per-type name-tag colour and a sprite that is never the lead's. A tool call never creates a character; parallel calls of one agent read "Read(읽기) · 병렬 3" in the bubble, "⇉3" on the tag, "병렬 N" in the agent row and "병렬 실행" in details. Stop-only agents get `startObserved: false`, are listed with "시작 미관측" and are not drawn | `viewModel.ts` (`roleLabel`, `agentTagColor`, `helperSprite`, `isAgentHidden`), `OfficeScene.ts`, `state.ts`, `DetailsPanel.tsx` |
| 4 | Tool names are not self-explanatory | `activity.toolLabel` → "Read(읽기)", "Grep(내용 검색)", "Bash(명령 실행)", "Skill(스킬 실행)", "apply_patch(패치 적용)", "SubagentHandback(결과 넘김)", MCP as "search(MCP server)"; unknown names stay bare. Used in bubbles, details (with a tooltip) and the timeline. `SubagentHandback`/`SendMessage`/`ListAgents` classified as `agent` | `activity.ts`, `viewModel.ts`, `DetailsPanel.tsx`, `Timeline.tsx` |
| 5 | Schema 4 → 5 | `startObserved` (default true for stored agents), `TurnState.endEvidence` (null while running, `observed` otherwise) | `state.ts` |

Tests: `test/interrupt.test.ts` (11 cases: new prompt closes the open turn and unresolves its tools with a late outcome still refining; same-id re-delivery is a duplicate; helpers active at Esc go idle and leave, tool activity brings one back; idle_prompt ends the turn only without a pending approval; Stop stays observed; stop-only agent hidden until it uses a tool; tool labels incl. MCP/unknown/null; role labels for Explore/Plan/general-purpose/custom/untyped, no "직원", distinct colours and sprites; parallel bubble/label/extra; schema 4 → 5 idempotent). Smoke updated for the new bubble text and the Explore row label.

Commands run (pass 7):

```
cd town
node inspect-db.mjs (read-only, scratch)   # 72 events, 3 sessions - findings above
npm run typecheck                          # no errors
npx vitest run                             # Test Files 14 passed, Tests 148 passed
npm run build                              # dist/client js ~1,514 kB (gzip ~417 kB)
node scripts/browser-smoke.mjs             # 37/37 checks passed (msedge channel)
```

Not verified live: the office after an actual Esc (the recordings show the events; the unit tests replay them), and whether the stop-only SubagentStops are internal helper processes or missed SubagentStarts - either way they no longer produce characters.

## Pass 6: stale "승인 대기", completion chime, employee departure timing (user feedback 2026-09-15)

| # | Request | Cause / change | Where |
|---|---|---|---|
| 1 | After the user approved a command, the character still showed "승인 대기" while the command ran | Claude Code announces one prompt twice: `PermissionRequest` (with `tool_use_id`) and `Notification: permission_prompt` (no id). The id-less record could only be resolved by turn end, so it outlived the approval. Now it is resolved (decision `unknown`, evidence `inferred`) as soon as the same agent is observed to proceed - a known-id request, any tool start/outcome, an observed approval resolution - and is not created while a known-id approval of that agent is pending. Known-id approvals keep their exact rule | `src/shared/state.ts` (`resolveIdlessApprovals`, `hasPendingKnownApproval`) |
| 2 | A sound when a session finishes its work | `store.onTurnEnd` fires when a live hook event turns a running turn into completed/failed/interrupted (same turn, not a replacement). `client/sound.ts` synthesizes a two-note chime (completed) or a low note (failed) with the Web Audio API; toolbar toggle "완료 알림음" persisted in `localStorage`, on by default, preview on enable (which also satisfies the browser's user-gesture rule). DEMO and replay never chime | `src/client/store.ts`, `src/client/sound.ts`, `main.tsx`, `TopBar.tsx` |
| 3 | Employees disappeared 8 s after finishing; they should leave when the user starts the next task | `isAgentHidden`: a finished employee stays until the session's `currentTurn.startedAt` is at or after the employee's last activity, i.e. the next `UserPromptSubmit`. Active employees, pending approvals and input waits never hide. `DONE_LINGER_MS` removed | `src/client/viewModel.ts` |

Tests: `test/approval-prompt.test.ts` (5 cases: Notification → PermissionRequest → PostToolUse never stuck; PermissionRequest → Notification creates no second record; Notification-only cleared by the agent's next tool, labelled inferred; a known-id approval is never cleared by another tool; per-agent scoping). `test/agent-task.test.ts` departure cases rewritten for the new rule (stays through the lead's Stop, leaves on the next UserPromptSubmit, returns on restart; pending approval survives a new turn). Smoke: chime toggle present and on by default.

Commands run (pass 6):

```
cd town
npm run typecheck                # no errors
npx vitest run                   # Test Files 13 passed, Tests 137 passed
npm run build                    # dist/client js ~1,510 kB (gzip ~416 kB)
node scripts/browser-smoke.mjs   # 37/37 checks passed (msedge channel)
```

Not verified live: the chime in a real browser session (unit tests cannot exercise Web Audio; the smoke test only checks the toggle), and the exact ordering of `PermissionRequest` vs `Notification` on the installed CLI - both orders are handled.

## Pass 5: departures, per-agent model, subagent task (user feedback 2026-09-14)

Requests: (1) ended sessions and finished employees kept standing in the office; (2) no way to see which model a session or agent runs on; (3) a finished employee only said "응답 완료" with no hint of what it had been responsible for.

What changed (all label-honest: nothing is shown that no payload stated, inferences are tagged):

| # | Change | Where | Rule |
|---|---|---|---|
| 1 | Ended sessions leave the office and free their room; ended agents are not drawn; a finished employee (subagent whose response ended, no pending approval, not waiting for input) lingers `DONE_LINGER_MS` = 8 s after its last activity and then leaves. State, session list, details and timeline keep every agent | `src/client/viewModel.ts` (`isAgentHidden`, `visible` filter), `OfficeView.tsx` (1 s tick; replay uses the last replayed event's time as the clock) | Visibility only - the reducer is untouched by this item |
| 2 | Session model = latest stated `model` (SessionStart; new Claude `PostModelSwitch` hook → `to_model`; Codex turn). Agent model = the delegation call's requested `model` (`Agent` tool input, alias kept as given), else the session model labelled "(세션 모델)". Shown in the session list, room label, agent rows and agent details | `state.ts` (`effectiveModel`, `ensureSession`), `providers/claude.ts` + `common.ts`, hook sender allowlist (`from_model`, `to_model`, `tool_input.model`), installer (`PostModelSwitch` added to the Claude event list) | Claude supplies `model` only on SessionStart and not always (docs), so "모델 미제공" is a legitimate value |
| 3 | On `agent.started` a child is linked to the oldest running, unlinked delegation call (activity `agent`) of its parent (any agent when the parent is unknown) whose `subagent_type` does not contradict the child's `agent_type`, typed matches first. Stored as `task`/`taskToolId`/`taskEvidence: 'inferred'`; the call records `spawnedAgentId`. The done bubble becomes "완료 · {task}" with an observed tool summary ("읽기 2 · 검색 1"); details show "담당 작업" with an "Agent 호출과 추정 연결" tag and "작업 요약" | `state.ts` (`linkSpawnCall`, `agentWorkSummary`, `workSummaryLabel`), `DetailsPanel.tsx`, `viewModel.ts` (`doneBubble`) | No payload carries an id tying `SubagentStart` to the parent's `tool_use_id`; the link is an inference and is labelled. No candidate → no task shown. `last_assistant_message` stays dropped |
| 4 | Schema 3 → 4: new agent/call fields default to null in `upgradeState`; stored agents never get a task re-derived | `state.ts` | Idempotent, tested |

DEMO fixture now includes the two `Agent` delegation calls (with `description`, `subagent_type`, one with `model: 'sonnet'`) before the two `SubagentStart`s and their `PostToolUse`s after the stops, so the demo shows the new bubbles and departures.

Tests (`test/agent-task.test.ts`, 13 cases): ended session leaves and frees its room while staying in state; finished employee lingers with the task bubble then leaves, lead stays, restarted child returns; pending approval never hides; lead done bubble unchanged; session model from SessionStart and PostModelSwitch; delegation model on the child while the session model is untouched by tool payloads; no model → nothing invented; PostModelSwitch normalization; link by type and order across three parallel delegations; no candidate / finished call never reused / contradicting type excluded; Codex untyped spawn call; work summary with failures; schema 3 → 4 upgrade preserving records and staying idempotent. `test/viewModel.test.ts` room test updated (ended sessions are no longer "unseated", they are absent).

Commands run (pass 5):

```
cd town
npm install --legacy-peer-deps   # fresh clone on this PC
npm run typecheck                # tsc client + server: no errors
npx vitest run                   # Test Files 12 passed, Tests 132 passed
npm run build                    # copy-assets 82 files; dist/client js ~1,508 kB (gzip ~415 kB)
node scripts/browser-smoke.mjs   # 36/36 checks passed (msedge channel)
```

Not verified in pass 5: a live Claude Code session with the `PostModelSwitch` hook installed, and the real field names of `SubagentStart` (`agent_type`) versus the `Agent` tool's `subagent_type` on the installed CLI; the smoke test's own sessions never end, so the departure behaviour is covered by unit tests and the DEMO fixture only.

## Real CLI integration evidence (supervisor-run, not by this pass)

The supervisor ran a real, read-only Claude Code (Fable) parallel-agent hook session against the built server; the artefacts are in `supervision/live-check-20260913-215748/` (`observed-events.json`, `observed-state.json`, `server.log`, the project-scoped `settings.json` used). Reported result: 16 hook events ingested, one main agent plus 2 real child agents, 4 completed tool calls, state reconstructed as expected. This pass did not re-run it. **Real Codex CLI hook ingestion has not been tested**; the Codex mapping remains based on the official docs and `hook_runtime.rs` only.

## Pass 4: old checkpoint compatibility (schema 2 → 3)

Problem (reproduced independently by the reviewer): pass 3 added the required `SessionState.recentTurnIds` and `staleTurnEvents`, but `schemaVersion` stayed 2 and `loadCheckpoint` parsed pass-2 checkpoints without defaults, so applying a new turn to such a state threw `TypeError: undefined.includes`.

Fix (narrow, non-destructive, idempotent):

- `src/shared/state.ts`: `STATE_SCHEMA_VERSION = 3`; new exported `upgradeState(state)` adds only missing fields (`staleTurnEvents = 0`; `recentTurnIds = [currentTurn.turnId]` if a current turn id is stored, else `[]`; top-level counters/boundaries defaulted only when absent) and preserves agents, calls, approval decisions, current turn, event/sequence counts and `historyFromSeq`/`prunedSessions`. No past turn identity is invented. `ensureSession` guards each session with the same per-session upgrade so the reducer never depends on the caller. `cloneState` upgrades its copy.
- `src/server/store.ts`: `loadCheckpoint` upgrades in memory; the stored row is left as is until the next retention pass writes a current checkpoint (no data deleted).
- `src/client/store.ts`: snapshot and replay base are upgraded on receipt.
- Stale-turn protection is unchanged and active on upgraded state.

Tests (`test/compat.test.ts`, 3 cases): (a) `upgradeState` on a representative pass-2 state adds exactly the missing fields, preserves every record and counter, and is idempotent; (b) the reducer applied directly to an old-shape session handles a new turn, a stale Stop and a genuine Stop; (c) SQLite: rows inserted then retained away, a schema-2 checkpoint persisted verbatim, a post-checkpoint event stored, `reconstructState` keeps agents/calls/denied approval/current turn/counts and `historyFromSeq`, a new turn plus stale and genuine Stop complete normally, restart reconstruction equals live, and the replay base carries the upgraded fields.

Changed files in pass 4: `src/shared/state.ts`, `src/server/store.ts`, `src/client/store.ts`, `test/compat.test.ts` (new), `docs/architecture.md`, `docs/implementation-report.md`.

## Pass 3: late-event state bugs (supervisor-late-events.mts)

`node node_modules/tsx/dist/cli.mjs ../supervision/supervisor-late-events.mts` (from `town/`) went from 0 / 2 passed to **2 / 2 passed** with the script unchanged; `supervisor-regressions.mts` still passes 6 / 6. Lasting tests: `town/test/late-events.test.ts` (12 cases).

| # | Bug | Fix | Tests |
|---|---|---|---|
| 1 | Late `Stop(turn-one)` after `UserPromptSubmit(turn-two)` completed turn-two | Turn-scoped terminal events (`agent.response_completed`, `turn.failed`, `turn.completed`) are related to the current turn by source turn id (`turn_id` / Claude `prompt_id`). A known older turn (tracked in a bounded `recentTurnIds`) → `staleTurnEvents++`, ignored: no tool closing, no approval resolution, no waiting-state or lifecycle change. A never-seen turn id → `unknownEvents++`, ignored. No ids on either side → applies to the current turn (no chronology guessed). Re-delivered `UserPromptSubmit` of a finished turn never reopens it; a duplicate start of the running turn is counted | stale Stop (Codex turn ids and Claude prompt ids: tools stay running, approval pending, waiting state kept, lifecycle active, root status working); stale Interrupt; ordinary current-turn Stop/Interrupt; no-id case; unseen turn id; late outcome for the older turn's tool still refines that tool only while the new turn keeps running |
| 2 | Late observed `PostToolUse(tool-a)` after an inferred-unknown approval left the decision unknown | `resolveApproval` refines an inference (`inferred`/`unknown`) when later observed evidence for the same agent-scoped call arrives; observed decisions are never rewritten; an outcome with no source signal (`ended`) yields decision `unknown` with observed evidence | late success → allowed/observed; late PermissionDenied → denied; observed denial not overwritten by a later "success"; agent-scoped (another agent's same call id does not refine); Codex no-signal outcome keeps unknown |

## Pass 2 summary (supervisor review)

### Supervisor regressions (confirmed and fixed in pass 2)

`node node_modules/tsx/dist/cli.mjs ../supervision/supervisor-regressions.mts` (run from `town/`) went from 1 passed / 5 failed on the pass-1 tree to **6 passed / 0 failed** without touching the script. Each case now also lives in `town/test/regressions.test.ts`.

| # | Regression | Fix | Test |
|---|---|---|---|
| 1 | Root Stop left the turn running | `agent.response_completed` for the root agent completes the turn exactly once; a child's Stop never touches it | regressions, reducer |
| 2 | Delayed PostToolUse could not refine `unresolved` | `unresolved` is provisional (`lateOutcome` flag); completed/failed/denied/ended stay sticky | regressions |
| 3 | Stale duplicate PreToolUse reactivated a finished agent | duplicate check runs before any lifecycle change | regressions |
| 4 | Agent-local tool ids collided session-wide | tool calls and approvals keyed by (agent, `tool_use_id`), `sourceId` preserved; all consumers updated | regressions, reducer (approvals per agent, colliding Claude/Codex session ids) |
| 5 | `Authorization: Bearer <cred>` leaked | new pattern set (full auth headers, bare Bearer/Basic, JSON quoted keys, `--token VALUE`, basic-auth URLs); masking before truncation; paths and string inputs masked; sender JS and server TS tested on the same samples | redact |
| 6 | `agent_id = "__proto__"` mutated `Object.prototype` | null-prototype dictionaries plus own-key helpers (`shared/dict.ts`) for sessions, agents, tool calls, approvals; control characters stripped from ids; `__proto__`/`constructor`/`prototype` covered for agents, tools, approvals and sessions | regressions |

### Additional review items (pass 2)

| # | Item | What changed | Test |
|---|---|---|---|
| 7 | HTTP/WS crash inputs | per-request and per-socket try/catch; `decodeURIComponent` failures → 4xx; URL length cap; query ints parsed with `safeInt` (non-integer/Infinity/huge → fallback, clamped); WS frames that are not `{type}` objects ignored; bearer compared on UTF-8 byte length (no `timingSafeEqual` throw); `clientError` handler | server (robustness) |
| 8 | Static containment | `resolveStaticPath`: decode once, reject NUL and dot-segments, resolve, require the root + separator prefix; SPA fallback only for extension-less paths | server (static): traversal, encoded traversal, backslash, sibling prefix `client-secret.txt`, `.data/`, NUL |
| 9 | Retention vs live state | `checkpoint` table + `retention.ts`: prune seq from age/count/size, checkpoint advanced by replaying discarded rows, complete-session pruning applied to checkpoint **and** live state with one rule, transactional delete, `historyFromSeq`/`prunedSessions` in state, diagnostics and scrubber; `/api/replay` returns a correct base state | store: restart == live after count and age retention, idempotent second pass, replay base |
| 10 | Installer ownership | exact invocation shape + script path equality (case-insensitive on Windows); lookalikes (echo, same basename elsewhere, wrapper, appended shell, http hook) survive install and uninstall; mixed groups preserved; nested `hooks[]` validated | installer |
| 11 | Response signals / apply_patch | `isError`/`is_error`/`success`/`ok`/`exit_code`/`error` recognised; outcome `unknown` preserved (Codex: "종료 · 결과 미확인"); apply_patch headers read from `tool_input.command` (Codex docs), patch body never stored | providers, redact (sender) |
| 12 | Fabricated state / ancestry | bare SessionStart → `idle` (no bubble); "working" only with a running tool or an observed running turn; sessions silent >10 min labelled "최근 활동 없음"; Codex child immediate parent = unknown, UI shows "세션 소속" vs "직접 상위"; link line only for known parents; instructional paragraphs removed (short status text + setup diagnostics only); "생각 중" replaced by "응답 진행 중" | viewModel, reducer, providers, smoke |
| 13 | Room assignment | sticky allocator: sessions keep rooms, active sessions win, unseated active evicts only ended sessions, creation order for free rooms; collision-safe character keys (JSON tuple); 12 employees get distinct seats; over-capacity sessions flagged "자리 없음" | viewModel (exactly 6 active + old ended, 9 active, stickiness across events/eviction) |
| 14 | Screen-space text under zoom | separate UI camera at zoom 1 (world camera ignores the UI layer and vice-versa); bubble rect updated every frame even when hidden; responsive two-row toolbar with icon-only buttons on narrow screens; fixed `HH:mm:ss` timeline column | smoke: anchoring ≤0.5 px at fit and after zoom on desktop and mobile; toolbar visibility during DEMO; PNG-decoded non-blank canvas |
| 15 | Spool concurrency/order | one file per envelope (atomic rename), claimed batches, byte-bounded (`Buffer.byteLength`), backlog flushed in order before the live event, live event queued behind any pending or in-flight backlog, loopback-only `server.json`, log lines never contain payloads | hook-sender: offline PreToolUse → reconnect Stop keeps order and leaves the tool unresolved (not running); 12 concurrent writers + 4 concurrent flushers, no loss, no duplicates; non-loopback server.json refused; Korean byte bounds |

## Commands run and results (final state)

```
cd town
node node_modules/tsx/dist/cli.mjs ../supervision/supervisor-late-events.mts  # both cases passed: true
node node_modules/tsx/dist/cli.mjs ../supervision/supervisor-regressions.mts   # {"passed":6,"failed":0,"total":6}
npm run typecheck                                                              # tsc client + server: no errors
npx vitest run                                                                 # Test Files 11 passed, Tests 119 passed
npm run build                                                                  # copy-assets 82 files; dist/client js ~1,502 kB (gzip ~413 kB)
node scripts/browser-smoke.mjs                                                 # (pass 3 build) 36/36 checks passed (msedge channel); pass 4 changed no UI code
node scripts/verify-dev.mjs                                                    # (pass 2) bootstrap via proxy 200, websocket snapshot, Vite index served: dev mode OK
```

Smoke screenshots kept for review: `smoke-results/desktop-empty.png`, `desktop-live.png`, `desktop-zoom.png`, `desktop-selected.png`, `desktop-demo.png` (1440×960), `mobile-office.png`, `mobile-zoom.png`, `mobile-timeline.png` (390×844 @2x). `results.json` lists every check with its measured values (anchoring error, colour counts, toolbar boxes).

No dev server or built server is left running (connecting to 127.0.0.1:4317 afterwards gives ECONNREFUSED). Every test and script used a temporary data dir; nothing was installed into any real project or user settings.

## Verification honesty

- The engineering passes used **fixture-shaped hook payloads** derived from the official documentation and `hook_runtime.rs`. A real Claude Code session was connected once by the supervisor (see "Real CLI integration evidence"); **no real Codex session has been connected.** Codex field names, especially `agent_id` on tool hooks inside subagents and the exact shape of `tool_response`, must be confirmed on the first Codex run (`AGENT_TOWN_HOOK_LOG=<file>` logs event names and statuses only).
- Codex immediate-parent identity is deliberately left unknown; the office shows session membership only. Claude's child → root link relies on the documented rule that subagents cannot spawn subagents.
- The Playwright smoke ran with the Edge channel available on this PC; a machine without Edge/Chrome needs `npx playwright install chromium`.
- Performance targets from the plan (hook latency p95, 20 characters at 50 events/s) were not measured.

## Permission denials during this pass

None in passes 2, 3 or 4. (Pass 1: reading `~/.codex`/`~/.claude`, the CLI version commands, the npm debug log via grep, several multi-operation Bash pipelines and a final `git status` were auto-denied; none blocked the work.)

## Known limitations

- See `docs/architecture.md` "Known limits" and `docs/hooks.md`. In short: fixture-only verification, hosted Codex tools invisible, Codex outcome depends on `tool_response` signals, Claude `permission_prompt` notifications carry no tool id, one character per agent within its room, six rooms (extra sessions listed with a "자리 없음" badge), replay window ≤5000 events on a checkpoint base.
- `npm install` on npm 10.9 needs `--legacy-peer-deps` (resolver crash on a peer range); the launcher passes it.
- Source files contain no literal control bytes (a scan is part of the pass-2 checks); the NUL key separator and control-character regex are built from `String.fromCharCode`.

## Suggested next work

1. Connect one real Claude Code and one real Codex session in a scratch project, capture the redacted payloads, and adjust the normalizers/fixtures to the observed fields (especially Codex subagent tool hooks and `tool_response`).
2. Measure hook latency and UI update latency; add the synthetic load test (20 characters, 50 events/s).
3. Optional transcript/log adapter for sessions that started before hooks were installed (marked "history only").
4. Agent Teams (Claude teammates) and Codex spawner identity if a future hook exposes it.
5. Keyboard navigation for the office, carpet marching squares, and a denser layout for many employees.
