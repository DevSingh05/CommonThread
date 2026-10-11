import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { createDemoAdapters } from '../src/adapters/demo.js';
import { startHttpServer } from '../src/server/http.js';
import type { Message, Room, Snapshot } from '../src/contracts.js';

let engine: Engine;
let store: Store;
let http: Awaited<ReturnType<typeof startHttpServer>>;
let token: string;
async function post(path: string, input: unknown, key = randomUUID(), headers: Record<string, string> = {}) {
  return fetch(`${http.url}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CommonThread-Token': token, 'Idempotency-Key': key, ...headers }, body: JSON.stringify(input) });
}
async function createRoom(): Promise<Room> {
  const response = await post('/rooms', { title: 'HTTP room', goal: 'Review a cache fix', mode: 'demo' });
  expect(response.status).toBe(201); return response.json() as Promise<Room>;
}
beforeEach(async () => {
  store = new Store(); engine = new Engine(store, { demoAdapters: createDemoAdapters(1) });
  http = await startHttpServer(engine, { port: 0 });
  const response = await fetch(`${http.url}/api/bootstrap`);
  token = (await response.json() as { token: string }).token;
});
afterEach(async () => {
  if (http) await http.close();
  if (engine) await engine.shutdown();
  store?.close();
});

describe('local HTTP boundary', () => {
  it('reports capabilities without provider configuration or secrets', async () => {
    const response = await fetch(`${http.url}/api/bootstrap`);
    const bootstrap = await response.json() as { capabilities: { demo: boolean; live: boolean } };
    expect(bootstrap.capabilities).toMatchObject({ demo: true, live: false });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects missing/invalid mutation tokens, including non-ASCII input', async () => {
    const body = { title: 'x', goal: 'x' };
    expect((await post('/rooms', body, randomUUID(), { 'X-CommonThread-Token': '' })).status).toBe(403);
    expect((await post('/rooms', body, randomUUID(), { 'X-CommonThread-Token': 'é'.repeat(64) })).status).toBe(403);
  });
  it('rejects hostile origins, cross-site fetches, and DNS rebinding hosts', async () => {
    expect((await fetch(`${http.url}/api/bootstrap`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${http.url}/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    const status = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(`${http.url}/api/bootstrap`, { headers: { Host: 'evil.example' } }, response => { response.resume(); done(response.statusCode); });
      request.on('error', reject); request.end();
    });
    expect(status).toBe(403);
  });
  it('requires exact JSON content type and a mutation idempotency key', async () => {
    expect((await post('/rooms', { title: 'x', goal: 'x' }, randomUUID(), { 'Content-Type': 'application/jsonx' })).status).toBe(415);
    const response = await fetch(`${http.url}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CommonThread-Token': token }, body: '{}' });
    expect(response.status).toBe(400);
  });
  it('rejects invalid JSON, unknown fields, oversize payloads and invalid IDs', async () => {
    const headers = { 'Content-Type': 'application/json', 'X-CommonThread-Token': token, 'Idempotency-Key': randomUUID() };
    expect((await fetch(`${http.url}/api/rooms`, { method: 'POST', headers, body: '{bad' })).status).toBe(400);
    expect((await post('/rooms', { title: 'x', goal: 'x', author: 'claude' })).status).toBe(400);
    expect((await post('/rooms', { title: 'x', goal: 'x'.repeat(300_000) })).status).toBe(413);
    expect((await fetch(`${http.url}/api/rooms/not-a-uuid`)).status).toBe(400);
  });
  it('keeps create-room and send retries idempotent', async () => {
    const key = randomUUID(); const input = { title: 'Repeat', goal: 'Goal' };
    const first = await post('/rooms', input, key).then(r => r.json()) as Room;
    const second = await post('/rooms', input, key).then(r => r.json()) as Room;
    expect(first.id).toBe(second.id);
    const msgKey = randomUUID(); const message = { body: 'Context' };
    const a = await post(`/rooms/${first.id}/messages`, message, msgKey).then(r => r.json()) as Message;
    const b = await post(`/rooms/${first.id}/messages`, message, msgKey).then(r => r.json()) as Message;
    expect(a.id).toBe(b.id);
    expect((await post('/rooms', { ...input, goal: 'Different' }, key)).status).toBe(409);
  });
  it('completes the simulated workflow over HTTP, restores history on refetch, and retrieves pinned artifacts', async () => {
    const room = await createRoom();
    expect((await post(`/rooms/${room.id}/messages`, { body: 'Investigate', recipient: 'claude' })).status).toBe(201);
    await engine.waitForIdle();
    const first = await fetch(`${http.url}/api/rooms/${room.id}`).then(r => r.json()) as Snapshot;
    const question = first.messages.find(m => m.kind === 'question')!;
    expect((await post(`/rooms/${room.id}/messages`, { body: 'Keep the public API unchanged.', replyTo: question.id })).status).toBe(201);
    await engine.waitForIdle();
    const finished = await fetch(`${http.url}/api/rooms/${room.id}`).then(r => r.json()) as Snapshot;
    const refreshed = await fetch(`${http.url}/api/rooms/${room.id}`).then(r => r.json()) as Snapshot;
    expect(finished).toEqual(refreshed);
    expect(finished.run?.status).toBe('completed');
    expect(finished.turns).toHaveLength(5);
    const ref = finished.reviews[0]!.artifactRef;
    const artifact = await fetch(`${http.url}/api/rooms/${room.id}/artifacts/${ref.artifactId}/${ref.version}`).then(r => r.json()) as { version: number; content: string };
    expect(artifact.version).toBe(1); expect(artifact.content).toContain('Fixture proposal v1');
    expect((await fetch(`${http.url}/api/rooms/${room.id}/tasks/${finished.tasks[0]!.id}`)).status).toBe(200);
  });
  it('supports explicit goal updates and paused queues via HTTP', async () => {
    const room = await createRoom();
    await post(`/rooms/${room.id}/messages`, { body: 'Start', recipient: 'claude' });
    await post(`/rooms/${room.id}/control`, { action: 'pause' });
    await post(`/rooms/${room.id}/goal`, { goal: 'New human goal' });
    await engine.waitForIdle();
    expect(engine.snapshot(room.id).run?.status).toBe('paused');
    expect(engine.snapshot(room.id).room.goal).toBe('New human goal');
    expect((await post(`/rooms/${room.id}/control`, { action: 'stop' })).status).toBe(200);
  });
  it('opens SSE with a refetch notification and closes it cleanly', async () => {
    const room = await createRoom();
    const controller = new AbortController();
    const response = await fetch(`${http.url}/api/rooms/${room.id}/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: snapshot');
    await post(`/rooms/${room.id}/messages`, { body: 'Human shared guidance' });
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain(room.id);
    await reader.cancel(); controller.abort();
  });
  it('does not substitute demo output in live mode', async () => {
    const response = await post('/rooms', { title: 'Live', goal: 'Real work', mode: 'live', repositoryPath: process.cwd() });
    expect(response.status).toBe(409);
    expect(engine.listRooms()).toHaveLength(0);
  });
});
