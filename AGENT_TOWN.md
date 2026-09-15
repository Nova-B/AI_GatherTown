# Agent Town

Agent Town is a local Windows app that shows your running **Claude Code** and **Codex CLI** sessions as characters in a Gather-Town-style pixel office: one lead character per session, real child agents as employees, tool speech bubbles, approval/failure/completion states, an agent detail panel and an event timeline.

It lives entirely in [`town/`](town/) and is a self-contained application (own `package.json` and lockfile). The rest of this repository is the upstream [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) checkout, kept intact for its assets and as a visual reference. See [`town/docs/architecture.md`](town/docs/architecture.md) for why the upstream runtime was not reused.

## Quick start (Windows)

```bat
Start-AgentTown.cmd
```

The launcher installs `town/` dependencies on first run, builds, starts the server on `http://127.0.0.1:4317/` (or the next free port) and opens the browser. Close the window to stop.

Manual equivalent:

```bat
cd town
npm install --legacy-peer-deps
npm run build
npm start
```

Then open `http://127.0.0.1:4317/`.

With no hooks installed you will see the empty office. Click **DEMO** to play a bundled fixture (clearly badged, never persisted) to see what a live session looks like.

**완료 알림음** (toolbar, on by default) plays a short chime when a live session finishes a turn, a lower note when the turn failed or was interrupted. Browsers need one click on the page before audio can play.

## Connect your CLIs (per project)

Hooks are installed **per project folder**, never into user-wide settings:

```bat
cd C:\path\to\your\project
node C:\Users\admin\Desktop\Dev\AgentTown\town\hook\install.mjs status
node C:\Users\admin\Desktop\Dev\AgentTown\town\hook\install.mjs install --dry-run
node C:\Users\admin\Desktop\Dev\AgentTown\town\hook\install.mjs install
```

- Claude Code: writes `.claude/settings.local.json` (`--shared` targets `.claude/settings.json`).
- Codex: writes `.codex/hooks.json`. Codex only runs hooks you have reviewed and trusted: open Codex in that project and run `/hooks`. The installer cannot and does not bypass that review.
- `uninstall` removes only Agent Town's own entries; unrelated hooks are preserved. A timestamped backup is written before every change. Malformed settings files are refused, not rewritten.

Then start Agent Town, and use Claude Code / Codex in that project as usual. Characters appear when hook events arrive. Details of what each hook does and does not cover: [`town/docs/hooks.md`](town/docs/hooks.md).

## Development

```bat
cd town
npm run dev        # Vite UI on http://127.0.0.1:5173 + server on 4317 (proxied)
npm run typecheck
npm test           # Vitest: providers, reducer, redaction, SQLite store, server auth, installer, hook sender
npm run build
npm run smoke      # Playwright browser smoke test against the built app (uses Edge/Chrome if present)
npm run verify:dev # bounded check that dev mode starts, proxies /api and /ws, then exits
```

`npm install` on npm 10.9 needs `--legacy-peer-deps` (a peer-range crash inside npm's resolver); the launcher passes it.

Data (SQLite events, ingest token, spool) lives in `%USERPROFILE%\.agent-town` by default (`AGENT_TOWN_DATA_DIR` to override). Nothing is written into this repository at runtime except `town/public/assets`, a regenerated copy of the upstream PNGs.

## Documents

- [`town/docs/architecture.md`](town/docs/architecture.md) - decision record, data flow, security model, known limits
- [`town/docs/hooks.md`](town/docs/hooks.md) - supported/unsupported hook cases per CLI
- [`town/docs/assets.md`](town/docs/assets.md) - asset provenance and slicing
- [`town/docs/implementation-report.md`](town/docs/implementation-report.md) - what was delivered and verified in this pass
- [`supervision/development-plan.md`](supervision/development-plan.md) - the original plan (Korean)
