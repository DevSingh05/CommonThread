import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../../src/web/api/client';
import { ApiError } from '../../../src/web/api/errors';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('ApiClient', () => {
  it('sends token, JSON content type and the caller idempotency key on mutations', async () => {
    const fetchImpl = vi.fn((input: string) => {
      if (input === '/api/bootstrap') return Promise.resolve(json(200, { token: 'tok-1' }));
      return Promise.resolve(json(200, { ok: true }));
    });
    const client = new ApiClient(fetchImpl);
    await client.postMessage('room 1', { body: 'hi', recipient: 'claude' }, 'key-1');

    const [path, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(path).toBe('/api/rooms/room%201/messages');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-CommonThread-Token': 'tok-1',
      'Idempotency-Key': 'key-1',
    });
    expect(JSON.parse(init.body as string)).toEqual({ body: 'hi', recipient: 'claude' });
  });

  it('refreshes a rejected token once and resends with the same idempotency key', async () => {
    let tokens = 0;
    const seen: { token: string; key: string }[] = [];
    const fetchImpl = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/bootstrap') return Promise.resolve(json(200, { token: `tok-${String(++tokens)}` }));
      const headers = init?.headers as Record<string, string>;
      seen.push({ token: headers['X-CommonThread-Token'] ?? '', key: headers['Idempotency-Key'] ?? '' });
      return Promise.resolve(
        seen.length === 1 ? json(403, { error: { code: 'invalid_token', message: 'stale' } }) : json(200, { ok: true }),
      );
    });
    await new ApiClient(fetchImpl).control('r1', { action: 'pause' }, 'key-9');
    expect(seen).toEqual([
      { token: 'tok-1', key: 'key-9' },
      { token: 'tok-2', key: 'key-9' },
    ]);
  });

  it('rejects snapshots that do not match the contract', async () => {
    const client = new ApiClient(() => Promise.resolve(json(200, { room: { id: 'r1' } })));
    await expect(client.snapshot('r1')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts either a room or a snapshot from room creation', async () => {
    const responses = [json(200, { token: 't' }), json(200, { room: { id: 'new-room' } })];
    const client = new ApiClient(() => Promise.resolve(responses.shift() ?? json(500, {})));
    await expect(client.createRoom({ title: 't', goal: 'g', mode: 'demo' }, 'k')).resolves.toBe('new-room');
  });

  it('wraps transport failures as network errors', async () => {
    const client = new ApiClient(() => Promise.reject(new TypeError('Failed to fetch')));
    const error: unknown = await client.listRooms().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });
});
