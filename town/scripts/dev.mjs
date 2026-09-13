// Runs the Node server (tsx watch) and the Vite dev server together.
// Vite proxies /api and /ws to the server, so open the Vite URL it prints.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const townRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(script) {
  const child = spawn(npmCmd, ['run', script], {
    cwd: townRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, AGENT_TOWN_DEV: '1' },
  });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[dev] ${script} exited with code ${code}`);
    }
  });
  return child;
}

const children = [run('dev:server'), run('dev:client')];

function shutdown() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
