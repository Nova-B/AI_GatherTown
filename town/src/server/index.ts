import { spawn } from 'node:child_process';

import { APP_VERSION, loadConfig, removeServerJson, writeServerJson } from './config.js';
import { startServer } from './http.js';
import { EventStore } from './store.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new EventStore(cfg.dbPath);

  const town = await startServer(cfg, store);
  const first = town.applyRetention();
  if (first.deletedEvents > 0 || first.prunedSessions > 0) {
    console.log(
      `[agent-town] retention removed ${first.deletedEvents} events, ${first.prunedSessions} sessions (history from seq ${first.pruneSeq + 1})`,
    );
  }
  writeServerJson(cfg, town.port);

  const retentionTimer = setInterval(
    () => {
      try {
        const n = town.applyRetention();
        if (n.deletedEvents > 0 || n.prunedSessions > 0) {
          console.log(`[agent-town] retention removed ${n.deletedEvents} events, ${n.prunedSessions} sessions`);
        }
      } catch (err) {
        console.error('[agent-town] retention failed', err);
      }
    },
    60 * 60 * 1000,
  );
  retentionTimer.unref();

  const url = `http://${cfg.host}:${town.port}/`;
  console.log(`[agent-town] v${APP_VERSION} listening on ${url}`);
  console.log(`[agent-town] data dir: ${cfg.dataDir}`);
  console.log(
    `[agent-town] stored events: ${store.count()}, sessions: ${Object.keys(town.state.sessions).length}`,
  );
  if (!cfg.clientDir) {
    console.log('[agent-town] UI bundle not found (dist/client). In development open the Vite URL instead.');
  }
  if (town.port !== cfg.port) {
    console.log(
      `[agent-town] note: requested port ${cfg.port} was busy; hooks read the actual port from server.json`,
    );
  }
  if (process.env.AGENT_TOWN_OPEN === '1' && process.platform === 'win32') {
    // Opened after listening so the URL reflects the actual (possibly fallback) port.
    try {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* browser launch is best-effort */
    }
  }

  const shutdown = async (): Promise<void> => {
    clearInterval(retentionTimer);
    removeServerJson(cfg);
    await town.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[agent-town] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
