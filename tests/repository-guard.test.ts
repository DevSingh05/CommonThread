import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Room, Task, Turn } from '../src/contracts.js';
import { Store } from '../src/core/store.js';
import { createRepositoryGuard, canonicalizeRepository, captureStableSnapshot, type GuardOptions } from '../src/repository/index.js';

const dirs: string[] = []; const stores: Store[] = [];
const key = () => randomUUID();
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'commonthread-guard-')); dirs.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  writeFileSync(join(root, 'code.txt'), 'original\n');
  execFileSync('git', ['add', 'code.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Repository Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}
function setup(options: GuardOptions = {}, database = ':memory:') {
  const root = repository(); const store = new Store(database); stores.push(store);
  const createdAt = new Date().toISOString();
  const room: Room = { id: key(), title: 'Repository', goal: 'Test guard', mode: 'live', repositoryPath: root, createdAt };
  const task: Task = { id: key(), roomId: room.id, runId: key(), title: 'Test', status: 'in_progress', owner: 'claude', correctionCount: 0, unresolvedIssues: [], createdAt };
  const turn: Turn = { id: key(), roomId: room.id, runId: task.runId, taskId: task.id, agent: 'claude', generation: 0, status: 'running', request: 'Test', relevantMessageIds: [], artifactRefs: [], attempts: 1, createdAt };
  store.put('rooms', room); store.put('tasks', task); store.put('turns', turn);
  const controller = new AbortController();
  const input = { room, turn, signal: controller.signal };
  return { root, store, room, task, turn, controller, input, guard: createRepositoryGuard(store, options) };
}
function journal(store: Store, room: Room) {
  return store.list('artifacts', room.id).filter(artifact => artifact.title === 'Repository evidence: journal').map(artifact => ({ artifact, data: JSON.parse(artifact.content) }));
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('engine-owned repository guard', { timeout: 60_000 }, () => {
  it('preserves dirty work and persists immutable before/after artifacts across reopening SQLite', async () => {
    const data = mkdtempSync(join(tmpdir(), 'commonthread-evidence-db-')); dirs.push(data);
    const path = join(data, 'evidence.sqlite');
    const { root, store, input, guard, room } = setup({ accessForTurn: () => 'workspace-write' }, path);
    writeFileSync(join(root, 'code.txt'), 'human\n'); writeFileSync(join(root, 'human.txt'), 'keep');
    const baseline = await guard.beforeTurn(input);
    expect(guard.getTurnContext(room.id, input.turn.id)).toMatchObject({ cwd: root, access: 'workspace-write', baselineRef: { version: 1 } });
    const first = journal(store, room)[0]!.artifact;
    writeFileSync(join(root, 'code.txt'), 'human\nprovider or external edit\n');
    await guard.afterTurn({ ...input, baseline, outcome: 'completed' });
    const captured = journal(store, room).at(-1)!;
    expect(captured.data.changes[0]).toMatchObject({ path: 'code.txt', preExisting: true, attribution: 'observed_during_turn_uncertain' });
    expect(readFileSync(join(root, 'human.txt'), 'utf8')).toBe('keep');
    expect(guard.artifacts.read(room.id, { artifactId: first.artifactId, version: first.version }).content).toBe(first.content);
    const reopened = new Store(path); stores.push(reopened);
    expect(reopened.require('artifacts', first.id).content).toBe(first.content);
    expect(reopened.require('artifacts', captured.artifact.id).content).toBe(captured.artifact.content);
  });
  it('detects external edits at checkpoints and between turns; acknowledgement pins the inspected digest', async () => {
    const { root, guard, input, store, room, task } = setup({ accessForTurn: () => 'workspace-write' });
    const baseline = await guard.beforeTurn(input);
    writeFileSync(join(root, 'code.txt'), 'external');
    await expect(guard.assertUnchanged(room.id, input.turn.id)).rejects.toThrow(/changed/);
    await expect(guard.afterTurn({ ...input, baseline, outcome: 'completed' })).rejects.toThrow(/inspection/);
    await expect(guard.beforeTurn(input)).rejects.toThrow(/acknowledgement/);
    const snapshot = await captureStableSnapshot(await canonicalizeRepository(root));
    await expect(guard.acknowledgeExternalChanges(room.id, task.id, '0'.repeat(64))).rejects.toThrow(/changed again/);
    await guard.acknowledgeExternalChanges(room.id, task.id, snapshot.digest);
    const next = await guard.beforeTurn(input);
    await guard.afterTurn({ ...input, baseline: next, outcome: 'completed' });
    writeFileSync(join(root, 'code.txt'), 'between turns');
    await expect(guard.beforeTurn(input)).rejects.toThrow(/acknowledgement/);
    expect(journal(store, room).at(-1)!.data.previousState).toBe('external_change');
  });
  it('detects writes in read-only review and Git index mutation without reverting files', async () => {
    const first = setup();
    const baseline = await first.guard.beforeTurn(first.input);
    writeFileSync(join(first.root, 'code.txt'), 'reviewer wrote');
    await expect(first.guard.afterTurn({ ...first.input, baseline, outcome: 'completed' })).rejects.toThrow(/Read-only/);
    expect(readFileSync(join(first.root, 'code.txt'), 'utf8')).toBe('reviewer wrote');
    const second = setup({ accessForTurn: () => 'workspace-write' });
    const next = await second.guard.beforeTurn(second.input);
    writeFileSync(join(second.root, 'code.txt'), 'staged unexpectedly');
    execFileSync('git', ['add', 'code.txt'], { cwd: second.root });
    await expect(second.guard.afterTurn({ ...second.input, baseline: next, outcome: 'completed' })).rejects.toThrow(/index/);
  });
  it('rejects non-root paths, forged baselines and non-running turns', async () => {
    const { root, guard, input, store } = setup(); mkdirSync(join(root, 'nested'));
    await expect(guard.beforeTurn({ ...input, room: { ...input.room, repositoryPath: join(root, 'nested') } })).rejects.toThrow(/canonicalizeRepository/);
    const baseline = await guard.beforeTurn(input);
    await expect(guard.afterTurn({ ...input, baseline: {}, outcome: 'completed' })).rejects.toThrow(/original/);
    await guard.afterTurn({ ...input, baseline, outcome: 'failed' });
    store.put('turns', { ...input.turn, status: 'completed' });
    await expect(guard.beforeTurn(input)).rejects.toThrow(/running turn/);
  });
  it('captures cancelled turns and releases access after final capture failure', async () => {
    const { guard, input, controller, root, room, task } = setup();
    const baseline = await guard.beforeTurn(input); controller.abort();
    await guard.afterTurn({ ...input, baseline, outcome: 'cancelled' });
    const fresh = { ...input, signal: new AbortController().signal };
    const next = await guard.beforeTurn(fresh);
    writeFileSync(join(root, 'too-large.txt'), Buffer.alloc(262_145));
    await expect(guard.afterTurn({ ...fresh, baseline: next, outcome: 'failed' })).rejects.toThrow(/limit/);
    rmSync(join(root, 'too-large.txt'));
    const snapshot = await captureStableSnapshot(await canonicalizeRepository(root));
    await guard.acknowledgeExternalChanges(room.id, task.id, snapshot.digest);
    const recovered = await guard.beforeTurn(fresh);
    await guard.afterTurn({ ...fresh, baseline: recovered, outcome: 'completed' });
  });
  it('releases preparation ownership when an oversized baseline prevents invocation', async () => {
    const { guard, input, root } = setup();
    writeFileSync(join(root, 'too-large.txt'), Buffer.alloc(262_145));
    await expect(guard.beforeTurn(input)).rejects.toThrow(/limit/);
    rmSync(join(root, 'too-large.txt'));
    const baseline = await guard.beforeTurn(input);
    await guard.afterTurn({ ...input, baseline, outcome: 'completed' });
  });
});

