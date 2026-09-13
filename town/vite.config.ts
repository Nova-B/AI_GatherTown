import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client is served by our own Node server in production (dist/client).
// In development, Vite proxies /api and /ws to the local server so the
// browser stays same-origin and no token ever appears in a URL.
export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    // changeOrigin rewrites Host to 127.0.0.1:4317 so the server's Host guard
    // accepts proxied requests; the browser Origin (5173) is allowed because
    // scripts/dev.mjs sets AGENT_TOWN_DEV=1 for the server.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true, changeOrigin: true },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
