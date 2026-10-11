import { RoomSnapshot, type Message, type Turn } from '../../../src/web/contract';

let seq = 0;

export function message(overrides: Partial<Message> & Pick<Message, 'author'>): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    seq,
    roomId: 'r1',
    kind: 'chat',
    body: `message ${seq}`,
    createdAt: '2026-10-11T20:00:00.000Z',
    recipient: null,
    replyTo: null,
    taskId: null,
    runId: null,
    artifactRefs: [],
    data: null,
    ...overrides,
  };
}

export function turn(overrides: Partial<Turn> & Pick<Turn, 'agent' | 'status'>): Turn {
  return { id: `t-${overrides.agent}-${overrides.status}`, roomId: 'r1', generation: 1, attempts: 1, ...overrides };
}

export function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return RoomSnapshot.parse({
    room: { id: 'r1', title: 'Room', goal: 'Goal', mode: 'demo', createdAt: '2026-10-11T20:00:00.000Z' },
    run: { id: 'run1', roomId: 'r1', generation: 1, status: 'running', maxTurns: 8, turnCount: 1 },
    ...overrides,
  });
}
