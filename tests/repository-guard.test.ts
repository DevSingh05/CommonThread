import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterInput, ArtifactRef, Room, Task, Turn } from '../src/contracts.js';
import { actionSchema } from '../src/contracts.js';
import { createDemoAdapters } from '../src/adapters/demo.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { createRepositoryGuard, canonicalizeRepository, captureStableSnapshot, type GuardOptions } from '../src/repository/index.js';

const dirs: string[] = []; const stores: Store[] = []; const engines: Engine[] = [];
const key = () => randomUUID();
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'commonthread-guard-'))); dirs.push(root);
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
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown(3000);
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

describe('command evidence provenance and execution policy', { timeout: 60_000 }, () => {
  const commands = { test: { executable: process.execPath, args: ['-e', 'console.log("observed output"); process.exit(7)'] } };
  it('denies commands by default and in read-only turns, including inherited property names', async () => {
    const { guard, input, room, turn } = setup({ commands });
    const baseline = await guard.beforeTurn(input);
    expect(() => guard.runCommand(room.id, turn.id, 'test')).toThrow(/authorization/);
    expect(() => guard.runCommand(room.id, turn.id, 'toString')).toThrow(/authorization/);
    await guard.afterTurn({ ...input, baseline, outcome: 'completed' });
    const readOnly = setup({ commands, authorizeCommand: () => true });
    const other = await readOnly.guard.beforeTurn(readOnly.input);
    expect(() => readOnly.guard.runCommand(readOnly.room.id, readOnly.turn.id, 'test')).toThrow(/Read-only/);
    await readOnly.guard.afterTurn({ ...readOnly.input, baseline: other, outcome: 'completed' });
  });
  it('records actual process outcomes and output refs; claims and fixtures cannot become observed results', async () => {
    const { guard, input, room, turn, root } = setup({ commands, authorizeCommand: () => true, accessForTurn: () => 'workspace-write' });
    const baseline = await guard.beforeTurn(input);
    const ref = await guard.runCommand(room.id, turn.id, 'test');
    const evidence = JSON.parse(guard.artifacts.read(room.id, ref).content);
    expect(evidence).toMatchObject({ provenance: 'observed', exitCode: 7, status: 'exited', cwd: root });
    expect(evidence.command.args).toEqual(commands.test.args);
    expect(JSON.parse(guard.artifacts.read(room.id, evidence.outputRef as ArtifactRef).content).stdout).toContain('observed output');
    expect(evidence.completedAt >= evidence.startedAt).toBe(true);
    const fixture = guard.recordAssertion(room.id, turn.id, { provenance: 'fixture', statement: 'Tests pass' });
    expect(JSON.parse(guard.artifacts.read(room.id, fixture).content)).toMatchObject({ status: 'simulated_not_run', exitCode: null, command: null });
    const claim = guard.recordAssertion(room.id, turn.id, { provenance: 'agent_claim', statement: 'Tests pass' });
    expect(JSON.parse(guard.artifacts.read(room.id, claim).content).status).toBe('unverified');
    expect(() => guard.recordAssertion(room.id, turn.id, { provenance: 'observed', statement: 'Tests pass', exitCode: 0 })).toThrow();
    await guard.afterTurn({ ...input, baseline, outcome: 'completed' });
    expect(() => guard.runCommand(room.id, turn.id, 'test')).toThrow(/lease/);
  });
  it('waits for an in-flight evidence process before finalizing a cancelled turn', async () => {
    const { guard, input, controller, room, turn, root } = setup({
      commands: { wait: { executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("ready.txt", "ready"); setInterval(() => {}, 1000)'], timeoutMs: 5000 } },
      authorizeCommand: () => true, accessForTurn: () => 'workspace-write',
    });
    const baseline = await guard.beforeTurn(input);
    const pending = guard.runCommand(room.id, turn.id, 'wait');
    await vi.waitFor(() => expect(existsSync(join(root, 'ready.txt'))).toBe(true), { timeout: 5000 });
    controller.abort();
    const completion = guard.afterTurn({ ...input, baseline, outcome: 'cancelled' });
    const result = await pending;
    await completion;
    expect(JSON.parse(guard.artifacts.read(room.id, result).content).status).toBe('cancelled');
  });
});

describe('engine integration with repository-owned hooks', { timeout: 60_000 }, () => {
  it('serializes two rooms through a directory alias and releases ownership after provider failure', async () => {
    const root = repository(); const aliasParent = mkdtempSync(join(tmpdir(), 'commonthread-guard-alias-')); dirs.push(aliasParent);
    const alias = join(aliasParent, 'alias'); symlinkSync(root, alias, 'junction');
    const store = new Store(); stores.push(store); const guard = createRepositoryGuard(store);
    const inputs: AdapterInput[] = []; let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const adapter = { async execute(input: AdapterInput) {
      inputs.push(input); if (inputs.length === 1) { await wait; throw new Error('provider failure'); }
      return { actions: [{ type: 'complete_task', taskId: input.turn.taskId, summary: 'Offline integration check completed' }] };
    } };
    const engine = new Engine(store, { demoAdapters: createDemoAdapters(0), liveAdapters: { claude: adapter, codex: adapter }, repositoryGuard: guard }); engines.push(engine);
    const a = engine.createRoom({ title: 'A', goal: 'Inspect', mode: 'live', repositoryPath: root }, key());
    const b = engine.createRoom({ title: 'B', goal: 'Inspect', mode: 'live', repositoryPath: alias }, key());
    engine.postHuman(a.id, { body: 'Inspect', recipient: 'claude' }, key());
    engine.postHuman(b.id, { body: 'Inspect', recipient: 'codex' }, key());
    await vi.waitFor(() => expect(inputs).toHaveLength(1), { timeout: 5000 });
    expect(engine.snapshot(b.id).turns[0]?.status).toBe('queued');
    release(); await engine.waitForIdle(10_000);
    expect(inputs).toHaveLength(2);
    expect(engine.snapshot(a.id).turns[0]?.status).toBe('failed');
    expect(engine.snapshot(b.id).turns[0]?.status).toBe('completed');
    expect(journal(store, a).at(-1)!.data.outcome).toBe('failed');
  });
  it('keeps a review pinned to captured v1 after v2 publication and rejects malformed findings', async () => {
    const root = repository(); const store = new Store(); stores.push(store); const guard = createRepositoryGuard(store);
    let oldRef: ArtifactRef | undefined;
    const adapter = { async execute(input: AdapterInput) {
      const snapshots = store.list('artifacts', input.room.id).filter(artifact => artifact.title === 'Repository evidence: journal');
      oldRef ??= { artifactId: snapshots[0]!.artifactId, version: 1 };
      return { actions: [{ type: 'submit_review', artifactRef: oldRef, summary: 'Review of captured v1', findings: [{ id: key(), severity: 'info', file: 'code.txt', line: 1, explanation: 'Offline inspection', evidence: 'Captured bytes', nextAction: 'Human inspection' }] },
        { type: 'complete_task', taskId: input.turn.taskId, summary: 'Review recorded' }] };
    } };
    const engine = new Engine(store, { demoAdapters: createDemoAdapters(0), liveAdapters: { claude: adapter, codex: adapter }, repositoryGuard: guard }); engines.push(engine);
    const room = engine.createRoom({ title: 'Review', goal: 'Inspect', mode: 'live', repositoryPath: root }, key());
    engine.postHuman(room.id, { body: 'Inspect', recipient: 'codex' }, key()); await engine.waitForIdle(10_000);
    expect(engine.snapshot(room.id).reviews[0]?.artifactRef).toEqual(oldRef);
    expect(guard.artifacts.history(room.id, oldRef!.artifactId)).toHaveLength(2);
    const diff = guard.artifacts.textDiff(room.id, oldRef!, { ...oldRef!, version: 2 });
    expect(diff).toContain('--- version 1'); expect(diff).toContain('+++ version 2');
    const bad = { type: 'submit_review', artifactRef: oldRef, summary: 'Claim', findings: [{ severity: 'critical', file: '../escape', line: 0 }] };
    expect(() => actionSchema.parse(bad)).toThrow();
    expect(() => guard.artifacts.read(key(), oldRef!)).toThrow(/another room/);
  });
});
