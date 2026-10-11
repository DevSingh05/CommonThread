import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDemoAdapters } from '../adapters/demo.js';
import { Engine } from '../core/engine.js';
import { AppError } from '../core/errors.js';
import { Store } from '../core/store.js';
import { startHttpServer } from './http.js';
import { acquireProcessLock } from './process-lock.js';

async function main(): Promise<void> {
  const dataDirectory = resolve(process.env.COMMONTHREAD_DATA_DIR ?? '.commonthread');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const port = Number(process.env.COMMONTHREAD_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('INVALID_CONFIG', 'COMMONTHREAD_PORT must be 1–65535.');
  const unlock = acquireProcessLock(resolve(dataDirectory, 'server.lock'));
  let store: Store | undefined;
  try {
    store = new Store(resolve(dataDirectory, 'commonthread.sqlite'));
    const engine = new Engine(store, { demoAdapters: createDemoAdapters(300), turnTimeoutMs: Number(process.env.COMMONTHREAD_TURN_TIMEOUT_MS ?? 120_000) });
    const http = await startHttpServer(engine, {
      port, webDirectory: resolve('dist/web'),
      devOrigins: process.env.COMMONTHREAD_DEV_ORIGINS?.split(',').filter(Boolean),
    });
    console.log(`CommonThread: ${http.url}\nDemo agents are simulated. Live execution awaits repository safeguards.\nBrowser UI is served from dist/web. API workflow: npm run demo`);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      const settled = await engine.shutdown();
      await http.close();
      if (settled) store?.close();
      unlock();
      process.exit(settled ? 0 : 1);
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
  } catch (error) { store?.close(); unlock(); throw error; }
}
main().catch(error => {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? ` (${error.code})` : '';
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : `CommonThread could not start${code}. Check port availability, data directory access, and Node version.`);
  process.exitCode = 1;
});
