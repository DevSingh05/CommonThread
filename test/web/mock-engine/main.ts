// Test-only mock engine for UI development before the real engine is merged.
// Usage: npm run mock-engine   (then npm run dev:web in another terminal)
import { startMockServer } from './server.ts';

const port = Number(process.env.PORT ?? 4317);
const turnMs = Number(process.env.MOCK_TURN_MS ?? 1500);
const mock = await startMockServer(port, { turnMs });
console.log(`CommonThread MOCK engine (simulated, in-memory) on ${mock.url}`);

const shutdown = () => {
  void mock.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
