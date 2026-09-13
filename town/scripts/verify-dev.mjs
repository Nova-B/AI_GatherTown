// Bounded check that `npm run dev` comes up: waits for Vite, calls the
// bootstrap endpoint through the proxy, opens a WebSocket through the proxy,
// then kills the whole process tree. Uses a temporary data dir.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

const townRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-town-dev-'));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const child = spawn(npmCmd, ['run', 'dev'], {
  cwd: townRoot,
  env: { ...process.env, AGENT_TOWN_DATA_DIR: dataDir, AGENT_TOWN_PORT: '4317' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
let log = '';
child.stdout.on('data', (d) => (log += String(d)));
child.stderr.on('data', (d) => (log += String(d)));

function killTree() {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitFor(fn, label, timeout = 40000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let ok = false;
try {
  const viteUrl = await waitFor(() => {
    const m = log.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/);
    return m ? m[1] : null;
  }, 'vite url');
  await waitFor(() => fs.existsSync(path.join(dataDir, 'server.json')), 'server.json');
  const boot = await fetch(`${viteUrl}/api/bootstrap`);
  const body = await boot.json();
  console.log(`bootstrap via proxy: ${boot.status} ${body.sessionToken ? 'token issued' : JSON.stringify(body)}`);
  if (boot.status !== 200 || !body.sessionToken) throw new Error('bootstrap through proxy failed');
  const wsUrl = viteUrl.replace('http', 'ws') + '/ws';
  const got = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Origin: viteUrl } });
    const t = setTimeout(() => reject(new Error('ws timeout')), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', sessionToken: body.sessionToken })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'snapshot') {
        clearTimeout(t);
        ws.close();
        resolve(m.type);
      }
    });
    ws.on('error', reject);
  });
  console.log(`websocket via proxy: ${got}`);
  const html = await fetch(viteUrl).then((r) => r.text());
  console.log(`vite index served: ${html.includes('Agent Town') ? 'yes' : 'no'}`);
  ok = html.includes('Agent Town');
} catch (e) {
  console.error(e.message);
} finally {
  killTree();
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(ok ? 'dev mode OK' : 'dev mode FAILED');
process.exit(ok ? 0 : 1);
