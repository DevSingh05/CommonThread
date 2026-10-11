import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { buildContext } from '../src/core/context.js';
import type { Room, Session, Task, Turn } from '../src/contracts.js';

describe('bounded context selection', () => {
  it('preserves oldest undelivered cursor, latest human guidance and pinned references without copying raw artifacts', () => {
    const store = new Store();
    const room: Room = { id: randomUUID(), title: 'Room', goal: 'Goal', mode: 'demo', createdAt: '' };
    store.put('rooms', room);
    const messages = Array.from({ length: 60 }, (_, index) => store.append({ id: randomUUID(), roomId: room.id, author: index === 59 ? 'human' : 'claude', kind: 'message', body: `${index} ${'content '.repeat(1500)}`, createdAt: '', data: { sensitiveProviderDetail: 'must not copy raw metadata' } }));
    const task: Task = { id: randomUUID(), roomId: room.id, runId: randomUUID(), title: 'Task', status: 'in_progress', owner: 'codex', correctionCount: 0, unresolvedIssues: [], createdAt: '' };
    const turn: Turn = { id: randomUUID(), roomId: room.id, runId: task.runId, taskId: task.id, agent: 'codex', generation: 1, status: 'running', request: 'Review', relevantMessageIds: [messages[0]!.id], artifactRefs: [], attempts: 1, createdAt: '' };
    const session: Session = { id: randomUUID(), roomId: room.id, agent: 'codex', state: 'ready', deliveredCursor: messages[1]!.seq, createdAt: '', updatedAt: '' };
    const context = buildContext(store, room, turn, session, task);
    expect(context.messages[0]?.seq).toBe(messages[2]?.seq);
    expect(context.deliveryCursor).toBe(context.messages.at(-1)?.seq);
    expect(context.deliveryCursor).toBeLessThan(messages.at(-1)!.seq);
    expect(context.hasMoreMessages).toBe(true);
    expect(context.humanGuidance[0]?.id).toBe(messages[59]?.id);
    expect(context.referencedMessages[0]?.author).toBe('claude');
    expect(context.truncatedMessageIds).toContain(messages[0]!.id);
    expect(context.messages.every(m => m.body.length <= 2000 && m.data === undefined)).toBe(true);
    expect(JSON.stringify(context).length).toBeLessThan(40_000);
    store.close();
  });
});
