import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { createDemoAdapters } from '../src/adapters/demo.js';
import { Bootstrap, RoomSnapshot, StreamEvent } from '../src/web/contract.js';

describe('real engine to UI contract', () => {
  it('validates bootstrap, stream events and reviewed artifact snapshots throughout a full conversation', async () => {
    const store = new Store();
    const engine = new Engine(store, { demoAdapters: createDemoAdapters(0) });
    try {
      expect(Bootstrap.parse({ token: 'local-token', capabilities: engine.capabilities() }).capabilities.live.available).toBe(false);
      let streams = 0;
      engine.subscribe(event => { if (event.type === 'stream') { StreamEvent.parse(event); streams++; } });
      const room = engine.createRoom({ title: 'Contract', goal: 'Review a fix' }, randomUUID());
      engine.postHuman(room.id, { body: '@claude start' }, randomUUID());
      await engine.waitForIdle();
      const first = RoomSnapshot.parse(engine.snapshot(room.id));
      expect(first.reviews[0]?.findings[0]?.severity).toBe('high');
      expect(first.sessions[0]?.deliveredCursor).toBeGreaterThan(0);
      const question = first.messages.find(m => m.kind === 'question')!;
      engine.postHuman(room.id, { body: 'Keep the API unchanged', replyTo: question.id }, randomUUID());
      await engine.waitForIdle();
      const final = RoomSnapshot.parse(engine.snapshot(room.id));
      expect(final.run?.status).toBe('completed');
      expect(final.artifacts).toHaveLength(2);
      expect(final.reviews[1]?.findings[0]?.nextAction).toContain('integration test');
      expect(streams).toBeGreaterThan(0);
    } finally { await engine.shutdown(); store.close(); }
  });
});
