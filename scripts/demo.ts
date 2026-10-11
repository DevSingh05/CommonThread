import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Room, Snapshot } from '../src/contracts.js';

const base = process.env.COMMONTHREAD_URL ?? 'http://127.0.0.1:4317';
const url = new URL(base);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Demo connects only to a localhost HTTP server.');
const bootstrap = await fetch(`${base}/api/bootstrap`).then(response => response.json()) as { token: string };
async function post<T>(path: string, input: unknown): Promise<T> {
  const response = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CommonThread-Token': bootstrap.token, 'Idempotency-Key': randomUUID() }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
const room = await post<Room>('/rooms', { title: 'Simulated cache review', goal: 'Collaborate on a cache invalidation fix while preserving the public API.', mode: 'demo' });
await post(`/rooms/${room.id}/messages`, { body: 'Claude, propose the cache fix and ask Codex to challenge concurrency behavior.', recipient: 'claude' });
console.log('SIMULATED OFFLINE DEMO — no live models, repository edits, or executed tests.');
const seen = new Set<string>(); let answered = false; let completed = false;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/rooms/${room.id}`);
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
  const snapshot = await response.json() as Snapshot;
  for (const message of snapshot.messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    console.log(`[${message.author}${message.recipient ? ` → ${message.recipient}` : ''}] ${message.body}`);
  }
  const question = snapshot.messages.find(m => m.kind === 'question');
  if (question && !answered && snapshot.run?.status === 'waiting_for_user') {
    await post(`/rooms/${room.id}/messages`, { body: 'Keep the public API unchanged.', replyTo: question.id }); answered = true;
  }
  if (snapshot.run?.status === 'completed') {
    if (snapshot.artifacts.length !== 2 || snapshot.reviews.length !== 2 || snapshot.turns.length !== 5) throw new Error('Fixture workflow did not produce its expected revisions and reviews.');
    console.log(`\nPersisted room: ${room.id}\n${snapshot.turns.length} turns, ${snapshot.artifacts.length} artifact versions, ${snapshot.reviews.length} reviews.\nUnresolved: ${snapshot.tasks.flatMap(task => task.unresolvedIssues).join(' ')}\nInspect: ${base}/api/rooms/${room.id}`);
    completed = true; break;
  }
  if (['failed', 'interrupted', 'cancelled'].includes(snapshot.run?.status ?? '')) throw new Error(snapshot.run?.reason);
  await delay(100);
}
if (!completed) throw new Error('Demo timed out before completion.');
