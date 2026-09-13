# Hook support matrix

Reference docs consulted 2026-09-13: <https://code.claude.com/docs/en/hooks> (Claude Code, installed 2.1.270), <https://learn.chatgpt.com/docs/hooks> and <https://github.com/openai/codex/blob/main/codex-rs/core/src/hook_runtime.rs> (Codex, installed 0.154.0). Agent Town's normalizers live in `src/shared/providers/`. **Live payloads from the installed CLIs were not captured**; the mapping follows the documented field names and must be confirmed on first real use (the diagnostics panel shows the last hook event name and any rejected payloads; `AGENT_TOWN_HOOK_LOG=<file>` makes the sender log event names and statuses, never content).

## Sender contract (`hook/agent-town-hook.mjs`)

- Node built-ins only; reads stdin JSON (≤1 MiB of bytes); redacts; POSTs to the server described by `<dataDir>/server.json` (loopback host required); spools on failure.
- Total budget 1.5 s, request timeout 0.8 s, always exit 0, never writes to stdout. An empty stdout with exit 0 is the neutral response for both CLIs: no context injection, no permission decision, the action proceeds. Nothing from the payload is ever printed.
- Forwarded fields (allowlist, control characters stripped): `session_id, hook_event_name, agent_id, agent_type, tool_name, tool_use_id, call_id, turn_id, prompt_id, permission_mode, model, reason, source, trigger, notification_type, target, stop_hook_active`, masked `cwd`, a bounded summary of `tool_input` (path-like fields, first line of a command, `apply_patch` file headers only, pattern/query/url/description), a bounded summary of `tool_response` (`exit_code`/`exitCode`/`returncode`, `is_error`/`isError`/`success`/`ok`, masked `error`), masked `error`/`message` (≤300/≤160 chars). Masking precedes truncation.
- Dropped: `prompt`, `last_assistant_message`, `transcript_path`, `agent_transcript_path`, tool response bodies, patch bodies, file contents.
- Spool: `<dataDir>/spool/<timestamp>-<rand>.json`, atomic write, 400 files / 512 KB bound, oldest dropped. Backlog is flushed in order before the current event; if backlog remains (or another hook is mid-flush), the current event is spooled behind it.

## Claude Code

| Hook | Installed | Mapped to | Notes |
|---|---|---|---|
| SessionStart | yes | session.started | `reason`/`source`, `model` kept; agent shown as idle until a turn starts |
| SessionEnd | yes | session.ended | ends session and all agents |
| UserPromptSubmit | yes | turn.started | prompt text never forwarded; `prompt_id` used as turn id |
| PreToolUse | yes | tool.started | keyed by (agent, `tool_use_id`); `agent_id` present → child agent |
| PostToolUse | yes | tool.completed, or tool.failed when the response states an error (`isError`/`is_error`, non-zero `exit_code`, `success:false`, `error`) | Claude fires PostToolUse only after success, so no signal = completed |
| PostToolUseFailure | yes | tool.failed | masked `error` |
| PermissionRequest | yes | approval.requested | keyed by (agent, `tool_use_id`) |
| PermissionDenied | yes | approval.resolved (denied) + tool denied | |
| Notification | yes | approval.requested (`permission_prompt`, no tool id) / notification (`idle_prompt`, `agent_needs_input` → waiting for input) | |
| Stop | yes | agent.response_completed (main) → also completes the turn | not session end |
| SubagentStart | yes | agent.started (child, immediate parent = main, provider semantics) | |
| SubagentStop | yes | agent.response_completed (child) | child stays as an idle character; parent turn untouched |
| TaskCreated/TaskCompleted, TeammateIdle, PostToolBatch, Setup, compaction, model switch, worktree, elicitation hooks | no | (unknown if received) | not installed; Agent Teams / teammates are not modelled |

## Codex

| Hook | Installed | Mapped to | Notes |
|---|---|---|---|
| SessionStart | yes | session.started | `source`, `model` |
| SessionEnd | yes | session.ended | 1 s default timeout in Codex; the sender stays well below |
| UserPromptSubmit | yes | turn.started | `turn_id` kept |
| PreToolUse | yes | tool.started | local function tools only: shell/`exec_command`/`write_stdin`, `apply_patch` (patch under `tool_input.command`; only `*** Update File:` style headers are kept), MCP tools |
| PostToolUse | yes | tool.failed (signal), tool.completed (`exit_code 0`, `success/ok true`, `isError false`), or tool.completed with outcome **unknown** → "종료 · 결과 미확인" when no signal exists | Codex has no PostToolUseFailure |
| PermissionRequest | yes | approval.requested | resolved by a later outcome of the same call or, inferred, by turn end |
| Stop | yes | agent.response_completed | `target` (Stop/SubagentStop) and `agent_id` decide the agent |
| Interrupt | yes | turn.failed (`interrupted`) | shown as failure, never as success |
| SubagentStart / SubagentStop | yes | agent.started / agent.response_completed | `session_id` is the parent session, `agent_id` the child; **immediate parent unknown** (nested agents are possible and the payload names no spawner) |
| PreCompact / PostCompact | no (mapped if received) | notification | |

Not covered by design: hosted tools such as **WebSearch** (no local hook fires), `exec_command` output that arrives on a later `write_stdin` (the later PostToolUse carries the id it belongs to; a call left open when the response ended is "unresolved" and refined when the outcome arrives), transcript files (not a stable contract). Live Codex child-tool attribution has not been tested: `hook_runtime.rs` passes the subagent context to every tool request builder, so `agent_id` is expected on tool hooks inside a subagent, but this is an inference from source, not an observed payload.

## Installer (`hook/install.mjs`)

- Project-scoped only: `<project>/.claude/settings.local.json` (or `settings.json` with `--shared`) and `<project>/.codex/hooks.json`. User-global settings are never targeted.
- Entries are `{ "hooks": [{ "type": "command", "command": "node \"<hook>\" --provider <p> --data-dir \"<dir>\"", "timeout": 5 }] }` without a matcher (matches every event).
- Ownership rule: a hook is ours only if its command has exactly the shape above **and** the quoted script path resolves to this checkout's `hook/agent-town-hook.mjs` (case-insensitive on Windows). Commands that merely mention the file name, run a same-named script elsewhere, wrap the path in another program, or append extra shell are foreign and are never modified or removed. Mixed groups keep their foreign hooks.
- `status` reports installed/stale/missing events, foreign entries kept, whether the server is running; `install --dry-run` prints the resulting file; `uninstall` removes only owned entries; unparseable JSON, a non-object `hooks`, a non-array event list or a non-array `hooks[]` inside a group is refused with exit code 2 and nothing written; a timestamped backup precedes every write.
- Codex trust: after installing, run `/hooks` inside Codex in that project and trust the definition. Changing the command (e.g. a different data dir) changes its hash and requires re-trusting.
