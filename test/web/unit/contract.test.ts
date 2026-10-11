import { describe, expect, it } from 'vitest';
import { Bootstrap, Message, RoomSnapshot } from '../../../src/web/contract';

describe('contract parsing at the UI boundary', () => {
  it('defaults capabilities to unavailable when the engine omits them', () => {
    const parsed = Bootstrap.parse({ token: 'tok' });
    expect(parsed.capabilities.demo.available).toBe(true);
    expect(parsed.capabilities.live.available).toBe(false);
    expect(parsed.capabilities.repository.available).toBe(false);
  });

  it('drops unknown properties instead of trusting them', () => {
    const parsed = Message.parse({
      id: 'm1',
      seq: 1,
      roomId: 'r1',
      author: 'claude',
      kind: 'chat',
      body: 'hi',
      createdAt: '2026-10-11T20:00:00Z',
      authorOverride: 'human',
    });
    expect(parsed).not.toHaveProperty('authorOverride');
    expect(parsed.artifactRefs).toEqual([]);
  });

  it('rejects unknown participants and non-integer versions', () => {
    expect(() =>
      Message.parse({ id: 'm', seq: 1, roomId: 'r', author: 'gpt', kind: 'chat', body: '', createdAt: 'x' }),
    ).toThrow();
    expect(() =>
      RoomSnapshot.parse({
        room: { id: 'r', title: 't', goal: 'g', mode: 'demo', createdAt: 'x' },
        artifacts: [{ artifactId: 'a', version: 1.5, roomId: 'r', title: 't', createdAt: 'x', author: 'claude' }],
      }),
    ).toThrow();
  });

  it('fills empty collections so partial snapshots still render', () => {
    const parsed = RoomSnapshot.parse({ room: { id: 'r', title: 't', goal: 'g', mode: 'live', createdAt: 'x' } });
    expect(parsed.messages).toEqual([]);
    expect(parsed.run).toBeUndefined();
    expect(parsed.eventSeq).toBe(0);
  });
});
