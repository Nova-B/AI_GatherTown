// Browser smoke test for Agent Town.
//
// Starts the BUILT server (dist/) on an ephemeral port with a temporary data
// dir, opens the UI in a real browser (Playwright), and checks:
//   - desktop (1440x960) and mobile (390x844) viewports render the app shell,
//     including the brand and mode/camera controls while DEMO is active
//   - the Phaser canvas is non-blank, verified by decoding a screenshot PNG
//     (never by reading the WebGL buffer), with many distinct colours and a
//     large share of non-background pixels
//   - ingesting fixture-shaped hook payloads (NOT a live CLI) creates a session,
//     characters and selectable details; provider filters, pause, replay and
//     DEMO isolation work
//   - screen-space text (bubbles, name tags) stays anchored to its character at
//     fit zoom and after zooming in, on desktop and mobile
// Screenshots go to town/smoke-results/.
//
// Usage: npm run build && npm run smoke
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const townRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(townRoot, 'smoke-results');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function launchBrowser(playwright) {
  const attempts = [{ channel: 'msedge' }, { channel: 'chrome' }, {}];
  let lastErr;
  for (const opts of attempts) {
    try {
      const browser = await playwright.chromium.launch({ headless: true, ...opts });
      return { browser, how: opts.channel ?? 'bundled chromium' };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `No Chromium-based browser available for Playwright. Install one with "npx playwright install chromium". Last error: ${lastErr?.message}`,
  );
}

/**
 * Non-blank check from a PNG screenshot of the canvas element: the PNG is
 * decoded by the browser's image decoder into a 2D canvas (not the WebGL
 * drawing buffer), then sampled.
 */
async function canvasPixels(page) {
  const canvas = page.locator('[data-testid=office-canvas] canvas').first();
  const png = await canvas.screenshot({ type: 'png' });
  const b64 = png.toString('base64');
  return page.evaluate(
    (data) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const cv = document.createElement('canvas');
          cv.width = img.width;
          cv.height = img.height;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
          const colors = new Set();
          let nonBg = 0;
          let total = 0;
          for (let i = 0; i < px.length; i += 4 * 13) {
            total++;
            const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
            colors.add(key);
            // background is #23262f
            if (Math.abs(px[i] - 0x23) + Math.abs(px[i + 1] - 0x26) + Math.abs(px[i + 2] - 0x2f) > 24) nonBg++;
          }
          resolve({ distinctColors: colors.size, nonBackgroundRatio: nonBg / total, w: cv.width, h: cv.height });
        };
        img.onerror = () => reject(new Error('png decode failed'));
        img.src = `data:image/png;base64,${data}`;
      }),
    b64,
  );
}

/** Max distance between each character's projected feet and its own bubble/name anchors. */
async function anchorError(page) {
  return page.evaluate(() => {
    const snap = window.__agentTown.scene.characterSnapshot();
    let worst = 0;
    for (const c of snap) {
      worst = Math.max(worst, Math.abs(c.nameAnchorX - c.screenX), Math.abs(c.nameAnchorY - (c.screenY + 2)));
      if (c.bubbleAnchorX !== null) worst = Math.max(worst, Math.abs(c.bubbleAnchorX - c.screenX));
    }
    return { worst, count: snap.length, zoom: window.__agentTown.scene.cameraZoom() };
  });
}

async function main() {
  if (!fs.existsSync(path.join(townRoot, 'dist', 'server', 'index.js'))) {
    throw new Error('dist/ missing - run `npm run build` first');
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-smoke-'));
  const server = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', path.join(townRoot, 'dist', 'server', 'index.js')],
    {
      env: { ...process.env, AGENT_TOWN_DATA_DIR: dataDir, AGENT_TOWN_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += String(d)));
  server.stderr.on('data', (d) => (serverLog += String(d)));

  let browser;
  try {
    const serverJsonPath = path.join(dataDir, 'server.json');
    const serverJson = await waitFor(
      () => {
        try {
          return JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
        } catch {
          return null;
        }
      },
      { label: 'server.json' },
    );
    const base = `http://127.0.0.1:${serverJson.port}`;
    check('server started on ephemeral port', serverJson.port > 0, `port ${serverJson.port}`);

    const playwright = await import('playwright');
    const launched = await launchBrowser(playwright);
    browser = launched.browser;
    check('browser launched', true, launched.how);

    const httpFailures = [];
    const consoleErrors = [];
    const attach = (page) => {
      page.on('pageerror', (e) => consoleErrors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('response', (r) => {
        if (r.status() >= 400) httpFailures.push(`${r.status()} ${r.url()}`);
      });
    };

    // ---- desktop 1440x960 ------------------------------------------------------
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    attach(page);
    await page.goto(base, { waitUntil: 'load' });
    await waitFor(() => page.evaluate(() => !!window.__agentTown?.scene?.ready), { label: 'scene ready' });
    check('title shows Agent Town', (await page.textContent('.brand-name'))?.trim() === 'Agent Town');
    check('connection becomes open', await waitFor(async () => (await page.getAttribute('[data-testid=conn-status]', 'class'))?.includes('conn-ok'), { label: 'ws open' }));
    check('empty office message shown with no sessions', await page.isVisible('[data-testid=office-empty]'));

    const textures = await page.evaluate(() => {
      const t = window.__agentTown.game.textures;
      const c = t.get('char_0').getSourceImage();
      const desk = t.get('DESK_FRONT').getSourceImage();
      const wall = t.get('wall_0').getSourceImage();
      return { charW: c.width, charH: c.height, deskW: desk.width, deskH: desk.height, wallW: wall.width, wallH: wall.height, count: Object.keys(t.list).length };
    });
    check('character sheet loaded (112x96)', textures.charW === 112 && textures.charH === 96, JSON.stringify(textures));
    check('furniture and wall PNGs loaded', textures.deskW === 48 && textures.wallH === 128);

    await page.waitForTimeout(300);
    const px0 = await canvasPixels(page);
    check('canvas is non-blank (PNG decode: many colours, mostly non-background)', px0.distinctColors > 60 && px0.nonBackgroundRatio > 0.3, JSON.stringify(px0));
    await page.screenshot({ path: path.join(outDir, 'desktop-empty.png') });

    // ---- ingest fixture-shaped payloads (labelled: not a live CLI) --------------
    const post = async (provider, payload) =>
      fetch(`${base}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serverJson.ingestToken}` },
        body: JSON.stringify({ eventId: `smoke-${Math.random().toString(36).slice(2)}`, provider, payload }),
      });
    const cwd = 'C:/Users/smoke/projects/checkout';
    const cwdB = 'C:/Users/smoke/projects/billing';
    await post('claude', { session_id: 'smoke-claude-1', hook_event_name: 'SessionStart', cwd, reason: 'startup' });
    await post('claude', { session_id: 'smoke-claude-1', hook_event_name: 'UserPromptSubmit', cwd, prompt_id: 'p1' });
    await post('claude', { session_id: 'smoke-claude-1', hook_event_name: 'PreToolUse', cwd, tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: `${cwd}/src/cart.ts` } });
    await post('claude', { session_id: 'smoke-claude-1', hook_event_name: 'SubagentStart', cwd, agent_id: 'sub-a', agent_type: 'Explore' });
    await post('claude', { session_id: 'smoke-claude-1', hook_event_name: 'PreToolUse', cwd, agent_id: 'sub-a', tool_name: 'Grep', tool_use_id: 't2', tool_input: { pattern: 'discount' } });
    await post('codex', { session_id: 'smoke-codex-1', hook_event_name: 'SessionStart', cwd: cwdB, source: 'startup' });
    await post('codex', { session_id: 'smoke-codex-1', hook_event_name: 'UserPromptSubmit', cwd: cwdB, turn_id: 'tt' });
    await post('codex', { session_id: 'smoke-codex-1', hook_event_name: 'PreToolUse', cwd: cwdB, turn_id: 'tt', tool_name: 'exec_command', tool_use_id: 'c1', tool_input: { command: 'npm test' } });
    await post('codex', { session_id: 'smoke-codex-1', hook_event_name: 'PermissionRequest', cwd: cwdB, turn_id: 'tt', tool_name: 'exec_command', tool_use_id: 'c1', tool_input: { command: 'npm test' } });
    // A session that only ever started (must be idle, not working).
    await post('codex', { session_id: 'smoke-codex-quiet', hook_event_name: 'SessionStart', cwd: 'C:/Users/smoke/projects/quiet' });

    await waitFor(async () => (await page.locator('[data-testid=session-item]').count()) === 3, { label: '3 sessions in list' });
    check('three sessions listed after ingest', true);
    const chars = await waitFor(async () => {
      const n = await page.evaluate(() => window.__agentTown.scene.characterCount());
      return n === 4 ? n : null;
    }, { label: '4 characters' });
    check('four characters (claude main + subagent, codex main, quiet main)', chars === 4);
    const snap = await page.evaluate(() => window.__agentTown.scene.characterSnapshot());
    check('bubbles show tool names with a Korean explanation', snap.some((c) => c.bubble === 'Read(읽기)') && snap.some((c) => c.bubble === 'Grep(내용 검색)'), JSON.stringify(snap.map((c) => [c.key, c.status, c.bubble])));
    check('codex main shows approval wait', snap.some((c) => c.key.includes('smoke-codex-1') && c.status === 'awaiting_approval'));
    check('a bare SessionStart is idle with no bubble (no fabricated work)', snap.some((c) => c.key.includes('smoke-codex-quiet') && c.status === 'idle' && c.bubble === null));
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, 'desktop-live.png') });

    // Anchoring at fit zoom and after zooming in (separate UI camera).
    const a0 = await anchorError(page);
    check('text anchored to characters at fit zoom', a0.worst <= 2 && a0.count === 4, JSON.stringify(a0));
    await page.click('[data-testid=zoom-in]');
    await page.click('[data-testid=zoom-in]');
    await page.click('[data-testid=zoom-in]');
    await page.waitForTimeout(250);
    const a1 = await anchorError(page);
    check('text anchored to characters after zoom in', a1.worst <= 2 && a1.zoom > a0.zoom, JSON.stringify(a1));
    const pxZoom = await canvasPixels(page);
    check('zoomed canvas non-blank', pxZoom.distinctColors > 40 && pxZoom.nonBackgroundRatio > 0.3, JSON.stringify(pxZoom));
    await page.screenshot({ path: path.join(outDir, 'desktop-zoom.png') });
    await page.click('[data-testid=zoom-reset]');
    await page.waitForTimeout(200);

    // Selection via session list -> agent row -> details
    await page.locator('[data-testid=session-item]').filter({ hasText: 'checkout' }).first().click();
    await page.waitForSelector('[data-testid=session-details]');
    await page.locator('[data-testid=agent-row]').filter({ hasText: '탐색 담당 · Explore' }).first().click();
    await page.waitForSelector('[data-testid=agent-details]');
    const status = await page.textContent('[data-testid=agent-status]');
    check('subagent details show working status with Grep running', status?.includes('작업 중') && (await page.textContent('[data-testid=running-tools]'))?.includes('Grep(내용 검색)'), status ?? '');
    check('Claude child shows main as immediate parent (provider semantics)', (await page.textContent('[data-testid=agent-parent]'))?.includes('팀장'));
    await page.screenshot({ path: path.join(outDir, 'desktop-selected.png') });

    const rows = await page.locator('[data-testid=timeline-row]').count();
    check('timeline shows rows for the selected session', rows >= 4, `${rows} rows`);
    const timeCell = await page.locator('[data-testid=timeline-row] .tl-time').first().textContent();
    check('timeline time is fixed HH:mm:ss', /^\d{2}:\d{2}:\d{2}$/.test(timeCell?.trim() ?? ''), timeCell ?? '');

    // Provider filter
    await page.click('[data-testid=filter-claude]');
    await waitFor(async () => (await page.locator('[data-testid=session-item]').count()) === 2, { label: 'filter hides claude' });
    const afterFilter = await page.evaluate(() => window.__agentTown.scene.characterCount());
    check('provider filter hides Claude session and characters', afterFilter === 2, `${afterFilter} characters`);
    await page.click('[data-testid=filter-claude]');
    await waitFor(async () => (await page.locator('[data-testid=session-item]').count()) === 3, { label: 'filter restores' });

    // Pause keeps the view frozen while live continues
    await page.click('[data-testid=pause-btn]');
    await post('codex', { session_id: 'smoke-codex-2', hook_event_name: 'SessionStart', cwd: 'C:/Users/smoke/projects/other' });
    await page.waitForTimeout(400);
    const pausedCount = await page.locator('[data-testid=session-item]').count();
    await page.click('[data-testid=live-btn]');
    await waitFor(async () => (await page.locator('[data-testid=session-item]').count()) === 4, { label: 'live shows 4' });
    check('pause froze the view (3) and live resumed (4)', pausedCount === 3);

    // Replay/scrubber
    await page.click('[data-testid=replay-btn]');
    await page.waitForSelector('[data-testid=scrubber]');
    await page.locator('[data-testid=scrubber] input[type=range]').fill('1');
    await page.waitForTimeout(200);
    const replayChars = await page.evaluate(() => window.__agentTown.scene.characterCount());
    check('replay cursor at 1 event shows one character', replayChars === 1, `${replayChars}`);
    await page.click('[data-testid=live-btn]');

    // DEMO mode is isolated and badged
    await page.click('[data-testid=demo-toggle]');
    await page.waitForSelector('[data-testid=demo-badge]');
    await waitFor(async () => (await page.locator('[data-testid=session-item]').count()) >= 1, { label: 'demo sessions' });
    const demoTags = await page.locator('.demo-tag').count();
    const demoItems = await page.locator('[data-testid=session-item]').count();
    check('demo badge visible and every listed session is tagged DEMO', demoTags === demoItems && demoItems > 0, `${demoItems} demo sessions`);
    check('ingested live sessions are not shown in demo view', !(await page.textContent('[data-testid=panel-sessions]'))?.includes('checkout'));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, 'desktop-demo.png') });
    await page.click('[data-testid=demo-toggle]');
    await waitFor(async () => (await page.locator('[data-testid=session-item]').count()) === 4, { label: 'live restored after demo' });
    check('exiting demo restores the live sessions', true);
    const stored = await fetch(`${base}/api/bootstrap`).then((r) => r.json()).then((b) => fetch(`${base}/api/events?since=0&limit=100`, { headers: { 'X-Agent-Town-Session': b.sessionToken } })).then((r) => r.json());
    check('demo events were never persisted', stored.events.every((e) => e.source === 'hook'), `${stored.events.length} stored events`);
    await page.close();

    // ---- mobile 390x844 --------------------------------------------------------
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    attach(mobile);
    await mobile.goto(base, { waitUntil: 'load' });
    await waitFor(() => mobile.evaluate(() => !!window.__agentTown?.scene?.ready), { label: 'mobile scene ready' });
    check('mobile shows tab bar and canvas', (await mobile.isVisible('[data-testid=tab-sessions]')) && (await mobile.isVisible('[data-testid=office-canvas]')));
    check('completion chime toggle is present and on by default', await mobile.isChecked('[data-testid=sound-toggle]'));
    // 4 sessions by now (smoke-codex-2 was added during the pause test) = 5 characters.
    await waitFor(async () => (await mobile.evaluate(() => window.__agentTown.scene.characterCount())) === 5, { label: 'mobile characters' });
    await mobile.waitForTimeout(300);
    const m0 = await anchorError(mobile);
    check('mobile text anchored at fit zoom', m0.worst <= 2, JSON.stringify(m0));
    const mpx = await canvasPixels(mobile);
    check('mobile canvas non-blank (PNG decode)', mpx.distinctColors > 40 && mpx.nonBackgroundRatio > 0.15, JSON.stringify(mpx));
    await mobile.screenshot({ path: path.join(outDir, 'mobile-office.png') });
    await mobile.click('[data-testid=demo-toggle]');
    await mobile.waitForSelector('[data-testid=demo-badge]');
    const brandBox = await mobile.locator('.brand-name').boundingBox();
    const resetBox = await mobile.locator('[data-testid=zoom-reset]').boundingBox();
    const demoBox = await mobile.locator('[data-testid=demo-toggle]').boundingBox();
    const inView = (b) => !!b && b.x >= 0 && b.x + b.width <= 390 && b.y >= 0;
    check('mobile toolbar keeps brand, DEMO and camera controls visible during DEMO', inView(brandBox) && inView(resetBox) && inView(demoBox), JSON.stringify({ brandBox, resetBox, demoBox }));
    await mobile.click('[data-testid=zoom-in]');
    await mobile.click('[data-testid=zoom-in]');
    await mobile.waitForTimeout(2500);
    const m1 = await anchorError(mobile);
    check('mobile text anchored after zoom in', m1.worst <= 2 && m1.zoom > m0.zoom, JSON.stringify(m1));
    await mobile.screenshot({ path: path.join(outDir, 'mobile-zoom.png') });
    await mobile.click('[data-testid=demo-toggle]');
    await mobile.click('[data-testid=tab-sessions]');
    await waitFor(async () => (await mobile.locator('[data-testid=session-item]').count()) === 4, { label: 'mobile sessions' });
    check('mobile sessions tab lists sessions', true);
    await mobile.click('[data-testid=tab-timeline]');
    check('mobile timeline tab renders', await mobile.isVisible('[data-testid=timeline]'));
    await mobile.screenshot({ path: path.join(outDir, 'mobile-timeline.png') });
    await mobile.close();

    check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('no HTTP 4xx/5xx for page or asset requests', httpFailures.length === 0, httpFailures.join(' | '));
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (results.some((r) => !r.ok)) {
      console.log('\nserver log:\n' + serverLog);
    }
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`smoke failed: ${err.message}`);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify([...results, { name: 'fatal', ok: false, detail: err.message }], null, 2));
  process.exit(1);
});
