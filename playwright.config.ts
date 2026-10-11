import { defineConfig, devices } from '@playwright/test';

const apiPort = 4399;
const webPort = 5199;

/**
 * Browser acceptance tests run the real UI (Vite dev server) against the
 * test-only mock engine. They prove UI behaviour, not engine or provider
 * behaviour; rerun them against the real engine after integration.
 */
export default defineConfig({
  testDir: 'test/web/browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' } }],
  webServer: [
    {
      command: 'node test/web/mock-engine/main.ts',
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env: { PORT: String(apiPort), MOCK_TURN_MS: '1500' },
      reuseExistingServer: false,
    },
    {
      command: 'npx vite',
      url: `http://127.0.0.1:${webPort}`,
      env: { COMMONTHREAD_API_PORT: String(apiPort), COMMONTHREAD_WEB_PORT: String(webPort) },
      reuseExistingServer: false,
    },
  ],
});
