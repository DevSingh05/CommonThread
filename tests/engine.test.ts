import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action, AdapterInput, AdapterResult, AgentAdapter, RepositoryGuard } from '../src/contracts.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { BeforeInvocationError, SessionResumeError } from '../src/core/errors.js';
import { createDemoAdapters } from '../src/adapters/demo.js';

const key = () => randomUUID();
const instances: { engine: Engine; store: Store }[] = [];
const dirs: string[] = [];
function setup(adapter?: AgentAdapter, options: Partial<ConstructorParameters<typeof Engine>[1]> = {}, path?: string) {
  const store = new Store(path);
  const engine = new Engine(store, { demoAdapters: adapter ? { claude: adapter, codex: adapter } : createDemoAdapters(0), ...options });
  instances.push({ engine, store });
  const room = engine.createRoom({ title: 'Shared room', goal: 'Fix stale cache behavior' }, key());
  return { store, engine, room };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function controlled() {
  const inputs: AdapterInput[] = [];
  const replies: ReturnType<typeof deferred<AdapterResult>>[] = [];
  const adapter: AgentAdapter = { execute(input) { inputs.push(input); const reply = deferred<AdapterResult>(); replies.push(reply); return reply.promise; } };
  return { adapter, inputs, replies };
}
function complete(input: AdapterInput): AdapterResult { return { actions: [{ type: 'complete_task', taskId: input.turn.taskId, summary: 'Done', unresolvedIssues: [] }] }; }
async function started(control: ReturnType<typeof controlled>, count = 1) { await vi.waitFor(() => expect(control.inputs.length).toBe(count), { timeout: 1000, interval: 2 }); }

afterEach(async () => {
  for (const { engine, store } of instances.splice(0)) {
    const settled = await engine.shutdown(100);
    if (settled) store.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shared room workflow', () => {
  it('runs Claude → Codex → human → Codex → Claude → Codex with versioned fixture reviews', async () => {
    const { engine, room } = setup();
    engine.postHuman(room.id, { body: '@Claude propose a cache fix' }, key());
    await engine.waitForIdle();
    let snapshot = engine.snapshot(room.id);
    expect(snapshot.run?.status).toBe('waiting_for_user');
    const question = snapshot.messages.find(m => m.kind === 'question')!;
    expect(question.author).toBe('codex');
    engine.postHuman(room.id, { body: 'Keep the public API unchanged.', replyTo: question.id }, key());
    await engine.waitForIdle();
    snapshot = engine.snapshot(room.id);
    expect(snapshot.run?.status).toBe('completed');
    expect(snapshot.turns.map(t => t.agent)).toEqual(['claude', 'codex', 'codex', 'claude', 'codex']);
    expect(snapshot.messages.filter(m => m.kind === 'handoff').map(m => [m.author, m.recipient])).toEqual([['claude', 'codex'], ['codex', 'claude'], ['claude', 'codex']]);
    expect(snapshot.artifacts.map(a => a.version)).toEqual([1, 2]);
    expect(snapshot.reviews.map(r => r.artifactRef.version)).toEqual([1, 2]);
    expect(snapshot.tasks[0]?.unresolvedIssues.length).toBeGreaterThan(0);
    expect(snapshot.turns.every(t => t.usage?.kind === 'unavailable')).toBe(true);
    expect(snapshot.sessions.every(s => !('providerSessionId' in s))).toBe(true);
  });
  it('does not schedule unaddressed human or ordinary addressed agent messages', async () => {
    const execute = vi.fn(async () => ({ actions: [{ type: 'post_message', recipient: 'codex', body: 'For your information' }] }));
    const { engine, room } = setup({ execute });
    engine.postHuman(room.id, { body: 'Shared context only' }, key());
    await engine.waitForIdle(); expect(execute).not.toHaveBeenCalled();
    engine.postHuman(room.id, { body: 'Investigate', recipient: 'claude' }, key());
    await engine.waitForIdle(); expect(execute).toHaveBeenCalledTimes(1);
    expect(engine.snapshot(room.id).run?.status).toBe('waiting_for_user');
  });
  it('deduplicates human requests and rejects reuse with different content', async () => {
    const { engine, room } = setup({ execute: async input => complete(input) });
    const id = key(); const input = { body: 'Do it', recipient: 'claude' };
    const a = engine.postHuman(room.id, input, id); const b = engine.postHuman(room.id, input, id);
    expect(a.id).toBe(b.id);
    expect(() => engine.postHuman(room.id, { ...input, body: 'Something else' }, id)).toThrow(/different input/);
    await engine.waitForIdle(); expect(engine.snapshot(room.id).turns).toHaveLength(1);
  });
  it('rejects ambiguous mentions and cross-room reply references', () => {
    const { engine, room } = setup();
    const other = engine.createRoom({ title: 'Other', goal: 'Other' }, key());
    const message = engine.postHuman(other.id, { body: 'Private context' }, key());
    expect(() => engine.postHuman(room.id, { body: '@claude @codex do it' }, key())).toThrow(/Select one/);
    expect(() => engine.postHuman(room.id, { body: 'Reply', replyTo: message.id }, key())).toThrow(/not in this room/);
  });
});

describe('controls and reliable context', () => {
  it('saves human guidance during a turn and delivers it with original attribution to the next agent', async () => {
    const control = controlled(); const { engine, room } = setup(control.adapter);
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await started(control);
    const guidance = engine.postHuman(room.id, { body: 'Keep the API unchanged.' }, key());
    expect(engine.snapshot(room.id).pendingHumanMessageIds).toContain(guidance.id);
    control.replies[0]!.resolve({ actions: [{ type: 'post_message', body: 'Claude contribution' }, { type: 'handoff', recipient: 'codex', taskId: control.inputs[0]!.turn.taskId, request: 'Review' }] });
    await started(control, 2);
    expect(control.inputs[1]!.context.humanGuidance.find(m => m.id === guidance.id)?.author).toBe('human');
    expect(control.inputs[1]!.context.messages.find(m => m.body === 'Claude contribution')?.author).toBe('claude');
    control.replies[1]!.resolve(complete(control.inputs[1]!)); await engine.waitForIdle();
  });
  it('pauses in-flight work and queues its returned handoff without following it', async () => {
    const control = controlled(); const { engine, room } = setup(control.adapter);
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await started(control);
    engine.control(room.id, { action: 'pause' }, key());
    control.replies[0]!.resolve({ actions: [{ type: 'handoff', recipient: 'codex', taskId: control.inputs[0]!.turn.taskId, request: 'Review' }] });
    await engine.waitForIdle();
    expect(control.inputs).toHaveLength(1);
    expect(engine.snapshot(room.id).turns[1]?.status).toBe('queued');
    engine.control(room.id, { action: 'resume' }, key()); await started(control, 2);
    control.replies[1]!.resolve(complete(control.inputs[1]!)); await engine.waitForIdle();
  });
  it('fences late responses after stop, including a provider that ignores cancellation', async () => {
    const control = controlled(); const { engine, room } = setup(control.adapter);
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await started(control);
    engine.control(room.id, { action: 'stop' }, key());
    expect(control.inputs[0]!.signal.aborted).toBe(true);
    control.replies[0]!.resolve({ actions: [{ type: 'post_message', body: 'LATE OUTPUT' }, { type: 'handoff', recipient: 'codex', taskId: control.inputs[0]!.turn.taskId, request: 'Do more' }] });
    await engine.waitForIdle();
    const snapshot = engine.snapshot(room.id);
    expect(snapshot.run?.status).toBe('cancelled'); expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.messages.some(m => m.body.includes('LATE OUTPUT'))).toBe(false);
    expect(snapshot.turns[0]?.status).toBe('cancelled');
  });
  it('replaying an old stop receipt cannot cancel a new run', async () => {
    const control = controlled(); const { engine, room } = setup(control.adapter);
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await started(control);
    const stopKey = key(); engine.control(room.id, { action: 'stop' }, stopKey);
    control.replies[0]!.resolve(complete(control.inputs[0]!)); await engine.waitForIdle();
    engine.control(room.id, { action: 'fresh_session', agent: 'claude', acknowledgeUncertain: true }, key());
    engine.postHuman(room.id, { body: 'Try again', recipient: 'claude' }, key()); await started(control, 2);
    engine.control(room.id, { action: 'stop' }, stopKey);
    expect(control.inputs[1]!.signal.aborted).toBe(false);
    control.replies[1]!.resolve(complete(control.inputs[1]!)); await engine.waitForIdle();
    expect(engine.snapshot(room.id).run?.status).toBe('completed');
  });
  it('stores delivery cursor only after a valid result and resumes independent sessions', async () => {
    const inputs: AdapterInput[] = [];
    const { engine, room, store } = setup({ execute: async input => { inputs.push(input); return { ...complete(input), providerSessionId: 'provider-session' }; } });
    const first = engine.postHuman(room.id, { body: 'First', recipient: 'claude' }, key()); await engine.waitForIdle();
    engine.postHuman(room.id, { body: 'Second', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(inputs[1]?.session.providerSessionId).toBe('provider-session');
    expect(inputs[1]?.context.messages.some(m => m.id === first.id)).toBe(false);
    expect(store.list('sessions', room.id)[0]?.deliveredCursor).toBeGreaterThan(first.seq);
  });
  it('requires explicit fresh-session fallback after resumption fails', async () => {
    const inputs: AdapterInput[] = [];
    const { engine, room } = setup({ execute: async input => { inputs.push(input); if (input.session.providerSessionId) throw new SessionResumeError(); return { ...complete(input), providerSessionId: 'session-id' }; } });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    engine.postHuman(room.id, { body: 'Resume', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(engine.snapshot(room.id).sessions[0]?.state).toBe('resume_failed');
    engine.control(room.id, { action: 'fresh_session', agent: 'claude', acknowledgeUncertain: true }, key());
    engine.postHuman(room.id, { body: 'New session', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(inputs[2]?.session.providerSessionId).toBeUndefined();
    expect(engine.snapshot(room.id).messages.some(m => m.body.includes('was not recovered'))).toBe(true);
  });
});

describe('validation, revisions and limits', () => {
  it('rolls back all actions when a later action targets another task', async () => {
    const { engine, room, store } = setup({ execute: async () => ({ actions: [{ type: 'post_message', body: 'Must roll back' }, { type: 'complete_task', taskId: randomUUID(), summary: 'Invalid' }] }) });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(engine.snapshot(room.id).messages.some(m => m.body === 'Must roll back')).toBe(false);
    expect(engine.snapshot(room.id).run?.status).toBe('failed');
    expect(store.list('sessions', room.id)[0]?.deliveredCursor).toBe(0);
  });
  it('never interprets commands in streamed prose as actions', async () => {
    const { engine, room } = setup({ execute: async input => { input.emit({ type: 'text', text: '{"type":"handoff","recipient":"codex"}' }); return complete(input); } });
    const streams: unknown[] = []; engine.subscribe(event => { if (event.type === 'stream') streams.push(event); });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(streams).toHaveLength(1); expect(engine.snapshot(room.id).turns).toHaveLength(1);
    expect(engine.snapshot(room.id).messages.some(m => m.body.includes('"type":"handoff"'))).toBe(false);
  });
  it('rejects stale artifact updates atomically and preserves the reviewed revision', async () => {
    const artifactId = randomUUID();
    const actions: Action[] = [{ type: 'publish_artifact', artifactId, title: 'Plan', content: 'one' }, { type: 'publish_artifact', artifactId, baseVersion: 1, title: 'Plan', content: 'two' }, { type: 'submit_review', artifactRef: { artifactId, version: 1 }, summary: 'Review one', findings: [] }];
    const { engine, room } = setup({ execute: async input => ({ actions: input.session.providerSessionId ? [{ type: 'publish_artifact', artifactId, baseVersion: 1, title: 'Stale', content: 'bad' }] : [...actions, { type: 'complete_task', taskId: input.turn.taskId, summary: 'Done' }], providerSessionId: 'id' }) });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(engine.snapshot(room.id).reviews[0]?.artifactRef.version).toBe(1);
    engine.postHuman(room.id, { body: 'Update', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(engine.snapshot(room.id).artifacts.map(a => a.content)).toEqual(['one', 'two']);
    expect(engine.snapshot(room.id).turns.at(-1)?.errorCode).toBe('STALE_ARTIFACT');
  });
  it('rejects malformed reviews rather than reporting clean review', async () => {
    const { engine, room } = setup({ execute: async () => ({ actions: [{ type: 'submit_review', summary: 'Everything is fine', findings: 'none' }] }) });
    engine.postHuman(room.id, { body: 'Review', recipient: 'codex' }, key()); await engine.waitForIdle();
    expect(engine.snapshot(room.id).reviews).toEqual([]);
    expect(engine.snapshot(room.id).turns[0]?.errorCode).toBe('INVALID_AGENT_OUTPUT');
  });
  it('rejects duplicate handoffs in a batch without creating either queued turn', async () => {
    const { engine, room } = setup({ execute: async input => {
      const handoff = { type: 'handoff', recipient: 'codex', taskId: input.turn.taskId, request: 'Review' };
      return { actions: [handoff, handoff] };
    } });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(engine.snapshot(room.id).turns).toHaveLength(1);
    expect(engine.snapshot(room.id).messages.filter(m => m.kind === 'handoff')).toHaveLength(0);
    expect(engine.snapshot(room.id).turns[0]?.errorCode).toBe('CONFLICTING_ACTIONS');
  });
  it('allows only bounded retries before provider invocation', async () => {
    const execute = vi.fn(async (): Promise<AdapterResult> => { throw new BeforeInvocationError(); });
    const { engine, room } = setup({ execute }, { maxRetries: 1 });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('does not retry uncertain provider failures or leak raw errors', async () => {
    const execute = vi.fn(async (): Promise<AdapterResult> => { throw new Error('sk-secret-do-not-display'); });
    const { engine, room } = setup({ execute });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(engine.snapshot(room.id))).not.toContain('sk-secret');
  });
  it('stops at the configured turn limit and preserves the queued request', async () => {
    const { engine, room } = setup({ execute: async input => ({ actions: [{ type: 'handoff', recipient: input.turn.agent === 'claude' ? 'codex' : 'claude', taskId: input.turn.taskId, request: `Turn ${input.turn.id}` }] }) }, { maxTurns: 2 });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    const snapshot = engine.snapshot(room.id);
    expect(snapshot.run?.turnCount).toBe(2); expect(snapshot.run?.status).toBe('paused');
    expect(snapshot.turns.at(-1)?.status).toBe('queued');
    expect(() => engine.control(room.id, { action: 'resume' }, key())).toThrow(/limit/);
  });
  it('detects repeated equivalent handoffs and excessive correction rounds', async () => {
    const { engine, room } = setup({ execute: async input => ({ actions: [{ type: 'handoff', recipient: input.turn.agent === 'claude' ? 'codex' : 'claude', taskId: input.turn.taskId, request: 'Repeat' }] }) });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(engine.snapshot(room.id).run?.reason).toContain('repeated equivalent');
    const correction = setup({ execute: async input => ({ actions: [{ type: 'handoff', recipient: input.turn.agent === 'claude' ? 'codex' : 'claude', taskId: input.turn.taskId, request: `Revision ${input.turn.id}`, revision: true }] }) });
    correction.engine.postHuman(correction.room.id, { body: 'Start', recipient: 'claude' }, key()); await correction.engine.waitForIdle();
    expect(correction.engine.snapshot(correction.room.id).run?.reason).toContain('correction-round limit');
  });
});

describe('execution ownership and recovery', () => {
  it('serializes rooms using the same canonical repository path, including aliases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonthread-lock-')); dirs.push(dir);
    const alias = `${dir}-alias`; symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir'); dirs.push(alias);
    const control = controlled(); const { engine } = setup(control.adapter);
    const a = engine.createRoom({ title: 'A', goal: 'A', repositoryPath: dir }, key());
    const b = engine.createRoom({ title: 'B', goal: 'B', repositoryPath: alias }, key());
    engine.postHuman(a.id, { body: 'A', recipient: 'claude' }, key());
    engine.postHuman(b.id, { body: 'B', recipient: 'codex' }, key()); await started(control);
    expect(control.inputs).toHaveLength(1);
    engine.control(a.id, { action: 'stop' }, key());
    expect(control.inputs).toHaveLength(1); // An abort signal does not release execution ownership.
    control.replies[0]!.resolve(complete(control.inputs[0]!)); await started(control, 2);
    control.replies[1]!.resolve(complete(control.inputs[1]!)); await engine.waitForIdle();
  });
  it('keeps timed-out execution locked until settlement and requires recovery', async () => {
    const control = controlled(); const { engine, room } = setup(control.adapter, { turnTimeoutMs: 20 });
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await started(control);
    await vi.waitFor(() => expect(engine.snapshot(room.id).run?.status).toBe('interrupted'), { interval: 5 });
    expect(() => engine.control(room.id, { action: 'recover', acknowledgeUncertain: true }, key())).toThrow(/settled/);
    control.replies[0]!.resolve(complete(control.inputs[0]!)); await engine.waitForIdle();
    expect(engine.snapshot(room.id).turns[0]?.status).toBe('interrupted');
    engine.control(room.id, { action: 'recover', acknowledgeUncertain: true }, key()); await engine.waitForIdle();
    expect(control.inputs).toHaveLength(1);
  });
  it('marks persisted in-flight work interrupted on restart and never replays it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonthread-recovery-')); dirs.push(dir);
    const path = join(dir, 'state.sqlite'); const control = controlled();
    const { engine, room, store } = setup(control.adapter, {}, path);
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await started(control);
    // Open the same database to simulate a restarted owner inspecting the persisted crash state.
    const secondStore = new Store(path); const execute = vi.fn(async input => complete(input));
    const restored = new Engine(secondStore, { demoAdapters: { claude: { execute }, codex: { execute } } });
    instances.push({ engine: restored, store: secondStore });
    expect(restored.snapshot(room.id).run?.status).toBe('interrupted');
    expect(restored.snapshot(room.id).turns[0]?.status).toBe('interrupted');
    expect(restored.snapshot(room.id).messages.filter(m => m.author === 'human')).toHaveLength(1);
    restored.control(room.id, { action: 'recover', acknowledgeUncertain: true }, key()); await restored.waitForIdle();
    expect(execute).not.toHaveBeenCalled();
    control.replies[0]!.resolve(complete(control.inputs[0]!)); await engine.waitForIdle();
    expect(store.list('turns', room.id)[0]?.status).not.toBe('completed');
  });
  it('fails closed for live mode without safety integrations', () => {
    const { engine } = setup();
    expect(() => engine.createRoom({ title: 'Live', goal: 'Work', mode: 'live', repositoryPath: process.cwd() }, key())).toThrow(/unavailable/);
  });
  it('recovers a crash after stop without reviving the cancelled run', async () => {
    const control = controlled(); const { engine, room, store } = setup(control.adapter);
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await started(control);
    engine.control(room.id, { action: 'stop' }, key());
    const restored = new Engine(store, { demoAdapters: createDemoAdapters(0) });
    expect(restored.snapshot(room.id).run?.status).toBe('cancelled');
    expect(restored.snapshot(room.id).turns[0]?.status).toBe('interrupted');
    expect(restored.snapshot(room.id).messages.at(-1)?.body).toContain('may have continued');
    await restored.shutdown();
    control.replies[0]!.resolve(complete(control.inputs[0]!)); await engine.waitForIdle();
  });
  it('runs registered repository guards inside execution ownership for live turns', async () => {
    const order: string[] = [];
    const guard: RepositoryGuard = {
      beforeTurn: async () => { order.push('before'); return { baseline: true }; },
      afterTurn: async ({ baseline, outcome }) => { expect(baseline).toEqual({ baseline: true }); expect(outcome).toBe('completed'); order.push('after'); },
    };
    const adapter: AgentAdapter = { execute: async input => { order.push('execute'); return complete(input); } };
    const { engine } = setup(undefined, { liveAdapters: { claude: adapter, codex: adapter }, repositoryGuard: guard });
    const room = engine.createRoom({ title: 'Live', goal: 'Work', mode: 'live', repositoryPath: process.cwd() }, key());
    engine.postHuman(room.id, { body: 'Start', recipient: 'claude' }, key()); await engine.waitForIdle();
    expect(order).toEqual(['before', 'execute', 'after']);
  });
});
