import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This suite uses the compiled server, SQLite, real dispatcher, and built React UI.
// Providers remain deterministic and explicitly simulated; no test-only HTTP endpoints exist.
export default defineConfig({
  testDir: 'test/integration',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4398',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dist/server/server/main.js',
    url: 'http://127.0.0.1:4398/api/health',
    env: { COMMONTHREAD_PORT: '4398', COMMONTHREAD_LIVE: '0', COMMONTHREAD_DATA_DIR: join(tmpdir(), `commonthread-browser-${process.pid}`) },
    reuseExistingServer: false,
  },
});
