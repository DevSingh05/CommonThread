import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The engine listens on 127.0.0.1:4317 by default. Override for tests or a
// non-default engine port with COMMONTHREAD_API_PORT.
const apiPort = Number(process.env.COMMONTHREAD_API_PORT ?? 4317);
const webPort = Number(process.env.COMMONTHREAD_WEB_PORT ?? 5173);
const apiTarget = `http://127.0.0.1:${apiPort}`;
const devOrigins = new Set([`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`]);

export default defineConfig({
  root: '.',
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          // The engine only accepts same-origin mutations. Requests that come
          // from this dev server's own page are presented as same-origin; any
          // other Origin is forwarded untouched so the engine still rejects it.
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin;
            if (origin !== undefined && devOrigins.has(origin)) {
              proxyReq.setHeader('origin', apiTarget);
            }
          });
        },
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
  },
});
