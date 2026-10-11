import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { actionBatchSchema } from '../src/contracts.js';

describe('persistent store and protocol', () => {
  it('retains message identities, ordering and author on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonthread-store-'));
    const path = join(dir, 'room.sqlite');
    const first = new Store(path);
    const room = { id: randomUUID(), title: 'Room', goal: 'Goal', mode: 'demo' as const, createdAt: new Date().toISOString() };
    first.put('rooms', room);
    const message = first.append({ id: randomUUID(), roomId: room.id, author: 'claude', kind: 'message', body: 'Explicit public contribution', createdAt: room.createdAt });
    first.close();
    const second = new Store(path);
    expect(second.require('rooms', room.id)).toEqual(room);
    expect(second.messages(room.id)).toEqual([message]);
    second.close(); rmSync(dir, { recursive: true });
  });
  it('rolls back an entire transaction on failure', () => {
    const store = new Store();
    expect(() => store.transaction(() => {
      store.put('rooms', { id: 'a', title: 'a', goal: 'a', mode: 'demo', createdAt: '' });
      throw new Error('fail');
    })).toThrow('fail');
    expect(store.list('rooms')).toEqual([]); store.close();
  });
  it('rejects author impersonation and malformed review output', () => {
    expect(actionBatchSchema.safeParse([{ type: 'post_message', body: 'Hi', author: 'human' }]).success).toBe(false);
    expect(actionBatchSchema.safeParse([{ type: 'submit_review', artifactRef: { artifactId: randomUUID(), version: 1 }, summary: 'Clean' }]).success).toBe(false);
    expect(actionBatchSchema.safeParse([{ type: 'post_message', body: 'Hi', recipient: 'codex' }]).success).toBe(true);
  });
});
