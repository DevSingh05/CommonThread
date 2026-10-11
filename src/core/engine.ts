import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  actionBatchSchema, controlSchema, createRoomSchema, goalSchema, humanMessageSchema, usageSchema,
  type Action, type Adapters, type AgentId, type ArtifactRef, type ArtifactVersion, type ControlInput,
  type EngineEvent, type Message, type RepositoryGuard, type Room, type Run, type Session, type Snapshot, type Task, type Turn,
} from '../contracts.js';
import { AppError, BeforeInvocationError, invariant, SessionResumeError } from './errors.js';
import { buildContext } from './context.js';
import { Store } from './store.js';

const now = () => new Date().toISOString();
const terminal = new Set<Run['status']>(['completed', 'failed', 'cancelled', 'interrupted']);
interface Active { turn: Turn; controller: AbortController; cursor: number }
export interface EngineOptions {
  demoAdapters: Adapters; liveAdapters?: Adapters; repositoryGuard?: RepositoryGuard;
  maxTurns?: number; maxCorrections?: number; turnTimeoutMs?: number; maxRetries?: number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class Engine {
  private readonly events = new EventEmitter();
  private readonly active = new Map<string, Active>();
  private readonly repositoryOwners = new Map<string, string>();
  private readonly pumps = new Set<Promise<void>>();
  private scheduled = false;
  private closing = false;
  readonly options: Required<Pick<EngineOptions, 'maxTurns' | 'maxCorrections' | 'turnTimeoutMs' | 'maxRetries'>> & EngineOptions;

  constructor(readonly store: Store, options: EngineOptions) {
    this.options = { maxTurns: 8, maxCorrections: 2, turnTimeoutMs: 120_000, maxRetries: 1, ...options };
    invariant(Number.isInteger(this.options.maxTurns) && this.options.maxTurns >= 1 && this.options.maxTurns <= 100, 'INVALID_CONFIG', 'maxTurns must be 1–100.');
    invariant(Number.isInteger(this.options.maxRetries) && this.options.maxRetries >= 0 && this.options.maxRetries <= 3, 'INVALID_CONFIG', 'maxRetries must be 0–3.');
    invariant(Number.isInteger(this.options.maxCorrections) && this.options.maxCorrections >= 0 && this.options.maxCorrections <= 10, 'INVALID_CONFIG', 'maxCorrections must be 0–10.');
    invariant(Number.isFinite(this.options.turnTimeoutMs) && this.options.turnTimeoutMs > 0, 'INVALID_CONFIG', 'Turn timeout must be positive.');
    this.events.setMaxListeners(100);
    this.recoverOnStart();
  }
  capabilities() { return { demo: true, live: Boolean(this.options.liveAdapters && this.options.repositoryGuard), liveReason: 'Live mode requires registered provider adapters and repository safety guards.', ui: false }; }
  subscribe(listener: (event: EngineEvent) => void): () => void { this.events.on('change', listener); return () => this.events.off('change', listener); }
  private notify(roomId: string): void { this.events.emit('change', { type: 'snapshot', roomId } satisfies EngineEvent); }
  private append(roomId: string, author: Message['author'], kind: Message['kind'], body: string, extra: Partial<Omit<Message, 'id' | 'seq' | 'roomId' | 'author' | 'kind' | 'body' | 'createdAt'>> = {}): Message {
    return this.store.append({ id: randomUUID(), roomId, author, kind, body, createdAt: now(), ...extra });
  }
  private once<T>(scope: string, key: string, input: unknown, fn: () => T): T {
    invariant(!this.closing, 'SHUTTING_DOWN', 'Server is shutting down.');
    invariant(/^[\w.-]{1,128}$/.test(key), 'IDEMPOTENCY_KEY', 'Supply an idempotency key of 1–128 letters, numbers, dots, hyphens or underscores.');
    const id = `${scope}:${key}`;
    const fingerprint = createHash('sha256').update(canonical(input)).digest('hex');
    return this.store.transaction(() => {
      const prior = this.store.get('receipts', id);
      if (prior) {
        invariant(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for different input.');
        return prior.result as T;
      }
      const result = fn();
      this.store.put('receipts', { id, roomId: scope, fingerprint, result });
      return result;
    });
  }
  createRoom(input: unknown, key: string): Room {
    const parsed = createRoomSchema.parse(input);
    if (parsed.mode === 'live') invariant(this.capabilities().live, 'LIVE_UNAVAILABLE', 'Live execution is unavailable. Register real provider adapters and repository safeguards; demo is explicitly simulated.');
    let repositoryPath: string | undefined;
    if (parsed.repositoryPath) {
      try { repositoryPath = realpathSync(parsed.repositoryPath); invariant(statSync(repositoryPath).isDirectory(), 'INVALID_REPOSITORY', 'Repository path must be a directory.'); }
      catch { throw new AppError('INVALID_REPOSITORY', 'Repository path must be an existing local directory.', 400); }
    }
    if (parsed.mode === 'live') invariant(repositoryPath, 'REPOSITORY_REQUIRED', 'A live coding room requires a repository.');
    return this.once('rooms', key, parsed, () => {
      const room: Room = { ...parsed, repositoryPath, id: randomUUID(), createdAt: now() };
      this.store.put('rooms', room);
      this.append(room.id, 'system', 'status', room.mode === 'demo' ? 'Simulated demo. Agent contributions and evidence are fixtures; no provider calls or repository edits occur.' : 'Live room. Provider sessions are newly managed by CommonThread.');
      return room;
    });
  }
  listRooms(): Room[] { return this.store.list('rooms'); }
  private latestRun(roomId: string): Run | undefined { return this.store.list('runs', roomId).at(-1); }
  getMessage(roomId: string, id: string): Message {
    const message = this.store.message(id);
    invariant(message?.roomId === roomId, 'INVALID_REFERENCE', 'Message is not in this room.');
    return message;
  }
  getTask(roomId: string, id: string): Task {
    const task = this.store.require('tasks', id);
    invariant(task.roomId === roomId, 'INVALID_REFERENCE', 'Task is not in this room.');
    return task;
  }
  getArtifact(roomId: string, ref: ArtifactRef): ArtifactVersion {
    const artifact = this.store.require('artifacts', `${ref.artifactId}:${ref.version}`);
    invariant(artifact.roomId === roomId, 'INVALID_REFERENCE', 'Artifact is not in this room.');
    return artifact;
  }
  snapshot(roomId: string): Snapshot {
    const room = this.store.require('rooms', roomId);
    const messages = this.store.messages(roomId);
    const active = this.active.get(roomId);
    return {
      room, run: this.latestRun(roomId) ?? null, messages,
      tasks: this.store.list('tasks', roomId), turns: this.store.list('turns', roomId),
      sessions: this.store.list('sessions', roomId).map(({ providerSessionId: _provider, ...session }) => session),
      artifacts: this.store.list('artifacts', roomId), reviews: this.store.list('reviews', roomId),
      pendingHumanMessageIds: active ? messages.filter(m => m.author === 'human' && m.seq > active.cursor).map(m => m.id) : [],
      activeTurnId: active?.turn.id ?? null,
    };
  }
  private newRun(roomId: string): Run {
    const run: Run = { id: randomUUID(), roomId, generation: 1, status: 'running', maxTurns: this.options.maxTurns, turnCount: 0, createdAt: now(), updatedAt: now() };
    this.store.put('runs', run); return run;
  }
  private queue(run: Run, task: Task, agent: AgentId, request: string, relevantMessageIds: string[] = [], artifactRefs: ArtifactRef[] = []): Turn {
    const turn: Turn = { id: randomUUID(), roomId: run.roomId, runId: run.id, taskId: task.id, agent, generation: run.generation, status: 'queued', request, relevantMessageIds, artifactRefs, attempts: 0, createdAt: now() };
    this.store.put('turns', turn); return turn;
  }
  postHuman(roomId: string, input: unknown, key: string): Message {
    const parsed = humanMessageSchema.parse(input);
    const result = this.once(`message:${roomId}`, key, parsed, () => {
      this.store.require('rooms', roomId);
      const mentions = [...new Set([...parsed.body.matchAll(/(?:^|\s)@(claude|codex)\b/gi)].map(match => match[1]!.toLowerCase() as AgentId))];
      const reply = parsed.replyTo ? this.getMessage(roomId, parsed.replyTo) : undefined;
      const question = reply?.kind === 'question' ? reply : undefined;
      const alreadyAnswered = question && this.store.messages(roomId).some(m => m.author === 'human' && m.replyTo === question.id);
      invariant(!alreadyAnswered, 'QUESTION_ANSWERED', 'This question already has a human answer.');
      if (!parsed.recipient && !question) invariant(mentions.length <= 1, 'AMBIGUOUS_RECIPIENT', 'Select one agent when mentioning both.');
      const recipient = question ? question.author as AgentId : parsed.recipient ?? mentions[0];
      if (question) invariant(!parsed.recipient || parsed.recipient === recipient, 'QUESTION_RECIPIENT', 'A question answer goes to the asking agent.');
      let run = this.latestRun(roomId);
      if (question) invariant(run && run.id === question.runId && !terminal.has(run.status), 'INACTIVE_QUESTION', 'This question belongs to an inactive run. Send a new directed message to continue.');
      if (recipient && (!run || terminal.has(run.status))) {
        invariant(run?.status !== 'interrupted', 'RECOVERY_REQUIRED', 'A previous turn has an uncertain outcome. Acknowledge recovery before scheduling more work.');
        run = this.newRun(roomId);
      }
      const message = this.append(roomId, 'human', 'message', parsed.body, { recipient, replyTo: parsed.replyTo, runId: run?.id });
      if (!recipient) return message;
      invariant(run, 'NO_RUN', 'A directed message requires a run.');
      let task: Task;
      if (question?.taskId) {
        task = this.getTask(roomId, question.taskId);
        invariant(task.status === 'waiting_for_user', 'QUESTION_INACTIVE', 'The task is no longer waiting for this answer.');
        task.status = 'in_progress'; task.owner = recipient;
      } else {
        task = { id: randomUUID(), roomId, runId: run.id, title: parsed.body.slice(0, 500), status: 'open', owner: recipient, correctionCount: 0, unresolvedIssues: [], createdAt: now() };
      }
      this.store.put('tasks', task);
      this.queue(run, task, recipient, parsed.body, [message.id, ...(question ? [question.id] : [])]);
      if (run.status === 'waiting_for_user') { run.status = 'running'; run.reason = undefined; }
      run.updatedAt = now(); this.store.put('runs', run);
      return message;
    });
    this.notify(roomId); this.schedule(); return result;
  }
  updateGoal(roomId: string, input: unknown, key: string): Room {
    const parsed = goalSchema.parse(input);
    const result = this.once(`goal:${roomId}`, key, parsed, () => {
      const room = this.store.require('rooms', roomId); room.goal = parsed.goal; this.store.put('rooms', room);
      this.append(roomId, 'human', 'goal', parsed.goal); return room;
    });
    this.notify(roomId); return result;
  }
  control(roomId: string, input: unknown, key: string): { action: ControlInput['action']; runId: string } {
    const parsed = controlSchema.parse(input);
    const result = this.once(`control:${roomId}`, key, parsed, () => {
      const run = this.latestRun(roomId);
      invariant(run, 'NO_RUN', 'Send a directed message to start a run.');
      const active = this.active.get(roomId);
      if (parsed.action === 'pause') {
        invariant(!terminal.has(run.status), 'INACTIVE_RUN', 'This run is inactive.');
        run.status = 'paused'; run.reason = 'Paused by human. In-flight work may still finish.';
      } else if (parsed.action === 'resume') {
        invariant(run.status === 'paused', 'NOT_PAUSED', 'Only a paused run can resume.');
        invariant(!run.reason?.startsWith('Limit:'), 'LIMIT_REACHED', 'This run reached a limit. Stop it and send a new directed request to continue.');
        run.status = 'running'; run.reason = undefined;
      } else if (parsed.action === 'stop') {
        invariant(run.status !== 'cancelled', 'ALREADY_STOPPED', 'This run is already stopped.');
        run.generation++; run.status = 'cancelled';
        run.reason = active ? 'Stopped scheduling; cancellation requested. Underlying execution has not yet confirmed settlement.' : 'Stopped by human.';
        for (const turn of this.store.list('turns', roomId).filter(t => t.runId === run.id && t.status === 'queued')) { turn.status = 'cancelled'; this.store.put('turns', turn); }
        for (const task of this.store.list('tasks', roomId).filter(t => t.runId === run.id && t.status !== 'completed')) { task.status = 'cancelled'; this.store.put('tasks', task); }
      } else if (parsed.action === 'recover') {
        invariant(run.status === 'interrupted' && !active, 'RECOVERY_UNAVAILABLE', 'Recover only after uncertain in-flight execution has settled or the server has restarted.');
        run.generation++; run.status = 'running'; run.reason = 'Human acknowledged uncertain side effects. Interrupted turns are not replayed; send an explicit request to reconcile them.';
        for (const turn of this.store.list('turns', roomId).filter(t => t.runId === run.id && t.status === 'queued')) { turn.generation = run.generation; this.store.put('turns', turn); }
      } else {
        invariant(!active, 'SESSION_BUSY', 'Wait until the in-flight provider call settles before replacing its session.');
        const session = this.session(roomId, parsed.agent);
        invariant(session.state === 'resume_failed' || session.state === 'interrupted', 'SESSION_NOT_FAILED', 'Only a failed or interrupted session can be explicitly replaced.');
        const fresh = this.freshSession(this.store.require('rooms', roomId), parsed.agent);
        this.store.put('sessions', fresh);
        this.append(roomId, 'system', 'status', `A new ${parsed.agent} session will start from explicit shared context. The old provider session was not recovered.`, { runId: run.id });
      }
      run.updatedAt = now(); this.store.put('runs', run);
      this.append(roomId, 'system', 'status', `${parsed.action}: ${run.reason ?? 'Human execution control applied.'}`, { runId: run.id });
      return { action: parsed.action, runId: run.id };
    });
    const active = this.active.get(roomId);
    if (parsed.action === 'stop' && active?.turn.runId === result.runId) active.controller.abort();
    this.notify(roomId); this.schedule(); return result;
  }
  private freshSession(room: Room, agent: AgentId): Session {
    return { id: `${room.id}:${agent}`, roomId: room.id, agent, repositoryPath: room.repositoryPath, state: 'fresh', deliveredCursor: 0, createdAt: now(), updatedAt: now() };
  }
  private session(roomId: string, agent: AgentId): Session {
    return this.store.get('sessions', `${roomId}:${agent}`) ?? this.freshSession(this.store.require('rooms', roomId), agent);
  }
  private recoverOnStart(): void {
    this.store.transaction(() => {
      for (const run of this.store.list('runs')) {
        if (terminal.has(run.status)) continue;
        const turns = this.store.list('turns', run.roomId).filter(t => t.runId === run.id);
        const interrupted = turns.filter(t => t.status === 'running');
        for (const turn of interrupted) { turn.status = 'interrupted'; turn.errorCode = 'PROCESS_RESTART'; this.store.put('turns', turn); }
        if (interrupted.length || turns.some(t => t.status === 'queued')) {
          run.status = 'interrupted'; run.generation++; run.reason = 'Server restarted. In-flight side effects may have occurred. Review work and explicitly acknowledge recovery; no turn was replayed.'; run.updatedAt = now();
          this.store.put('runs', run);
          this.append(run.roomId, 'system', 'error', run.reason, { runId: run.id });
        }
      }
      for (const session of this.store.list('sessions')) if (session.state === 'running') { session.state = 'interrupted'; session.updatedAt = now(); this.store.put('sessions', session); }
    });
  }
  private schedule(): void {
    if (this.scheduled || this.closing) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.dispatch(); });
  }
  private dispatch(): void {
    if (this.closing) return;
    for (const room of this.store.list('rooms')) {
      if (this.active.has(room.id)) continue;
      const run = this.latestRun(room.id);
      if (!run || run.status !== 'running') continue;
      const next = this.store.list('turns', room.id).find(t => t.runId === run.id && t.generation === run.generation && t.status === 'queued');
      if (!next) { this.settleRun(run); continue; }
      if (run.turnCount >= run.maxTurns) { this.pauseLimit(run, 'agent turn limit reached'); continue; }
      if (room.repositoryPath && this.repositoryOwners.has(room.repositoryPath)) continue;
      const controller = new AbortController();
      this.active.set(room.id, { turn: next, controller, cursor: 0 });
      if (room.repositoryPath) this.repositoryOwners.set(room.repositoryPath, next.id);
      const pump = this.execute(room, run, next, controller).catch(() => {
        // Unexpected engine failures are surfaced without raw exception details or provider secrets.
        const current = this.store.require('runs', run.id); current.status = 'interrupted'; current.reason = 'Unexpected engine failure. Inspect local work before explicit recovery.'; this.store.put('runs', current);
        this.append(room.id, 'system', 'error', current.reason, { runId: run.id });
      }).finally(() => {
        this.active.delete(room.id);
        if (room.repositoryPath && this.repositoryOwners.get(room.repositoryPath) === next.id) this.repositoryOwners.delete(room.repositoryPath);
        this.pumps.delete(pump); this.notify(room.id); this.schedule();
      });
      this.pumps.add(pump);
    }
  }
  private pauseLimit(run: Run, reason: string): void {
    run.status = 'paused'; run.reason = `Limit: ${reason}. Work is preserved. Stop this run and send a new directed request to continue.`; run.updatedAt = now();
    this.store.put('runs', run); this.append(run.roomId, 'system', 'status', run.reason, { runId: run.id }); this.notify(run.roomId);
  }
  private settleRun(run: Run): void {
    const tasks = this.store.list('tasks', run.roomId).filter(t => t.runId === run.id);
    if (tasks.some(t => t.status !== 'completed' && t.status !== 'cancelled')) { run.status = 'waiting_for_user'; run.reason = 'No runnable handoffs remain. Open tasks require human direction; the goal is not proven complete.'; }
    else { run.status = 'completed'; run.reason = tasks.some(t => t.unresolvedIssues.length) ? 'Tasks returned results with unresolved issues. Human review is required.' : 'Queue drained and tasks returned results. Ready for human review; this is not proof of correctness.'; }
    run.updatedAt = now(); this.store.put('runs', run); this.notify(run.roomId);
  }
  private current(turn: Turn): boolean {
    const run = this.store.require('runs', turn.runId);
    return run.generation === turn.generation && !terminal.has(run.status);
  }
  private async execute(room: Room, run: Run, turn: Turn, controller: AbortController): Promise<void> {
    let session = this.session(room.id, turn.agent);
    const context = buildContext(this.store, room, turn, session, this.getTask(room.id, turn.taskId));
    this.active.get(room.id)!.cursor = context.deliveryCursor;
    this.store.transaction(() => {
      turn.status = 'running'; turn.startedAt = now(); this.store.put('turns', turn);
      run.turnCount++; run.updatedAt = now(); this.store.put('runs', run);
      const task = this.getTask(room.id, turn.taskId); task.status = 'in_progress'; task.owner = turn.agent; this.store.put('tasks', task);
      if (session.state !== 'resume_failed' && session.state !== 'interrupted') session.state = 'running';
      session.updatedAt = now(); this.store.put('sessions', session);
    });
    this.notify(room.id);
    let baseline: unknown;
    let guarded = false;
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    let timedOut = false;
    let publicChars = 0;
    const timeout = setTimeout(() => {
      timedOut = true; controller.abort();
      if (this.current(turn)) {
        const currentRun = this.store.require('runs', run.id); currentRun.generation++; currentRun.status = 'interrupted'; currentRun.reason = 'Turn timed out. Cancellation requested; execution and repository ownership remain held until the provider call settles.';
        this.store.put('runs', currentRun); turn.status = 'interrupted'; turn.errorCode = 'TIMEOUT'; this.store.put('turns', turn);
        this.append(room.id, 'system', 'error', currentRun.reason, { runId: run.id }); this.notify(room.id);
      }
    }, this.options.turnTimeoutMs);
    try {
      if (session.state === 'resume_failed' || session.state === 'interrupted') throw new SessionResumeError();
      if (room.mode === 'live') {
        invariant(this.options.repositoryGuard && this.options.liveAdapters, 'LIVE_UNAVAILABLE', 'Live adapters or repository guard unavailable.');
        baseline = await this.options.repositoryGuard.beforeTurn({ room, turn, signal: controller.signal }); guarded = true;
      }
      const adapter = (room.mode === 'demo' ? this.options.demoAdapters : this.options.liveAdapters)![turn.agent];
      let result;
      for (;;) {
        controller.signal.throwIfAborted();
        turn.attempts++; this.store.put('turns', turn);
        try {
          result = await adapter.execute({
            room, turn: { ...turn }, session: { ...session }, context, signal: controller.signal,
            emit: event => {
              if (!this.current(turn) || controller.signal.aborted || publicChars >= 32_000) return;
              const parsed = z.strictObject({ type: z.enum(['text', 'activity']), text: z.string().max(8000) }).safeParse(event);
              if (!parsed.success) return;
              publicChars += parsed.data.text.length;
              this.events.emit('change', { type: 'stream', roomId: room.id, turnId: turn.id, event: parsed.data } satisfies EngineEvent);
            },
            retrieve: { message: id => this.getMessage(room.id, id), task: id => this.getTask(room.id, id), artifact: ref => this.getArtifact(room.id, ref) },
          }); break;
        } catch (error) {
          if (!(error instanceof BeforeInvocationError) || turn.attempts > this.options.maxRetries) throw error;
          await delay(25 * turn.attempts, undefined, { signal: controller.signal });
        }
      }
      if (!this.current(turn) || controller.signal.aborted) { outcome = 'cancelled'; return; }
      // Capture repository results while still holding ownership, before committing the communication batch.
      if (guarded) {
        guarded = false;
        await this.options.repositoryGuard!.afterTurn({ room, turn, baseline, signal: controller.signal, outcome: 'completed' });
      }
      if (!this.current(turn) || controller.signal.aborted) { outcome = 'cancelled'; return; }
      const actions = actionBatchSchema.parse(result.actions);
      const usage = usageSchema.parse(result.usage ?? { kind: 'unavailable' });
      const providerSessionId = result.providerSessionId === undefined ? undefined : z.string().min(1).max(500).parse(result.providerSessionId);
      this.store.transaction(() => {
        this.applyActions(turn, actions);
        turn.status = 'completed'; turn.completedAt = now(); turn.deliveredCursor = context.deliveryCursor; turn.usage = usage;
        this.store.put('turns', turn);
        session = this.session(room.id, turn.agent); session.state = 'ready'; session.deliveredCursor = context.deliveryCursor;
        session.providerSessionId = providerSessionId ?? session.providerSessionId; session.updatedAt = now(); this.store.put('sessions', session);
      });
      outcome = 'completed';
    } catch (error) {
      if (!this.current(turn) || controller.signal.aborted) { outcome = 'cancelled'; return; }
      const code = error instanceof z.ZodError ? 'INVALID_AGENT_OUTPUT' : error instanceof AppError ? error.code : 'PROVIDER_FAILURE';
      const explanation = error instanceof z.ZodError ? 'Agent returned malformed structured output; no actions were committed.' : error instanceof AppError ? error.message : 'Provider execution failed. Side effects may have occurred; work was not automatically retried. Inspect the repository before continuing.';
      this.store.transaction(() => {
        turn.status = 'failed'; turn.errorCode = code; turn.completedAt = now(); this.store.put('turns', turn);
        const currentRun = this.store.require('runs', run.id); currentRun.status = 'failed'; currentRun.reason = explanation; currentRun.updatedAt = now(); this.store.put('runs', currentRun);
        session.state = error instanceof SessionResumeError ? 'resume_failed' : 'interrupted'; session.updatedAt = now(); this.store.put('sessions', session);
        this.append(room.id, 'system', 'error', explanation, { taskId: turn.taskId, runId: run.id, data: { code } });
      });
    } finally {
      clearTimeout(timeout);
      if (guarded) {
        try { await this.options.repositoryGuard!.afterTurn({ room, turn, baseline, signal: controller.signal, outcome }); }
        catch { this.append(room.id, 'system', 'error', 'Repository capture failed after execution. Review the working directory before continuing.', { runId: run.id }); }
      }
      if (!this.current(turn) && outcome !== 'completed') {
        if (turn.status === 'running') { turn.status = timedOut ? 'interrupted' : 'cancelled'; turn.completedAt = now(); this.store.put('turns', turn); }
        const storedSession = this.session(room.id, turn.agent);
        if (storedSession.state === 'running') { storedSession.state = 'interrupted'; storedSession.updatedAt = now(); this.store.put('sessions', storedSession); }
        const currentRun = this.store.require('runs', run.id);
        if (currentRun.status === 'cancelled') { currentRun.reason = 'Stopped. The provider call has settled; underlying child-process cancellation is provider-dependent.'; this.store.put('runs', currentRun); }
      }
    }
  }
  private applyActions(turn: Turn, actions: Action[]): void {
    const receiptId = `turn:${turn.id}`;
    if (this.store.get('receipts', receiptId)) return;
    invariant(this.current(turn), 'STALE_TURN', 'Stopped or superseded turns cannot commit actions.');
    const run = this.store.require('runs', turn.runId);
    const task = this.getTask(turn.roomId, turn.taskId);
    const transitions = actions.filter(a => ['handoff', 'request_user_input', 'complete_task'].includes(a.type));
    invariant(transitions.length <= 1, 'CONFLICTING_ACTIONS', 'A turn can hand off, ask a question, or complete its task, not multiple scheduling actions.');
    const extra = { taskId: turn.taskId, runId: turn.runId };
    for (const action of actions) {
      if ('taskId' in action && action.taskId) invariant(action.taskId === turn.taskId, 'INVALID_TASK', 'An agent can act only on its assigned task.');
      if ('artifactRefs' in action) for (const ref of action.artifactRefs ?? []) this.getArtifact(turn.roomId, ref);
      if ('replyTo' in action && action.replyTo) this.getMessage(turn.roomId, action.replyTo);
      switch (action.type) {
        case 'post_message': this.append(turn.roomId, turn.agent, 'message', action.body, { ...extra, recipient: action.recipient, replyTo: action.replyTo, artifactRefs: action.artifactRefs }); break;
        case 'propose_decision': this.append(turn.roomId, turn.agent, 'decision', action.statement, { ...extra, data: { rationale: action.rationale, proposed: true } }); break;
        case 'publish_artifact': {
          const artifactId = action.artifactId ?? randomUUID();
          const versions = this.store.list('artifacts').filter(a => a.artifactId === artifactId);
          const latest = versions.at(-1);
          invariant(!latest || latest.roomId === turn.roomId, 'INVALID_REFERENCE', 'Artifact belongs to another room.');
          invariant(latest ? action.baseVersion === latest.version : action.baseVersion === undefined, 'STALE_ARTIFACT', 'Artifact update requires its current baseVersion; new artifacts must omit baseVersion.');
          const version = (latest?.version ?? 0) + 1;
          const artifact: ArtifactVersion = { id: `${artifactId}:${version}`, artifactId, version, roomId: turn.roomId, title: action.title, content: action.content, author: turn.agent, taskId: turn.taskId, createdAt: now() };
          this.store.put('artifacts', artifact);
          this.append(turn.roomId, turn.agent, 'artifact', `${action.title} · version ${version}`, { ...extra, artifactRefs: [{ artifactId, version }] }); break;
        }
        case 'handoff': {
          invariant(action.recipient !== turn.agent, 'SELF_HANDOFF', 'A handoff must name the other agent.');
          for (const id of action.relevantMessageIds ?? []) this.getMessage(turn.roomId, id);
          if (action.revision) task.correctionCount++;
          const handoff = this.append(turn.roomId, turn.agent, 'handoff', action.request, { ...extra, recipient: action.recipient, artifactRefs: action.artifactRefs, data: { revision: action.revision ?? false } });
          task.status = 'waiting_for_agent'; task.owner = action.recipient;
          const equivalent = this.store.messages(turn.roomId).filter(m => m.kind === 'handoff' && m.taskId === task.id && m.recipient === action.recipient && m.body.trim().toLowerCase() === action.request.trim().toLowerCase() && canonical(m.artifactRefs ?? []) === canonical(action.artifactRefs ?? []));
          this.queue(run, task, action.recipient, action.request, [handoff.id, ...(action.relevantMessageIds ?? [])].slice(0, 20), action.artifactRefs);
          if (task.correctionCount > this.options.maxCorrections) this.pauseLimit(run, 'correction-round limit reached');
          else if (equivalent.length >= 2) this.pauseLimit(run, 'repeated equivalent handoff without a new artifact version');
          break;
        }
        case 'request_user_input': {
          task.status = 'waiting_for_user';
          this.append(turn.roomId, turn.agent, 'question', action.question, { ...extra, data: { options: action.options ?? [] } }); break;
        }
        case 'submit_review': {
          this.getArtifact(turn.roomId, action.artifactRef);
          invariant(new Set(action.findings.map(f => f.id)).size === action.findings.length, 'DUPLICATE_FINDING', 'Review finding IDs must be unique.');
          const review = { id: randomUUID(), roomId: turn.roomId, taskId: task.id, author: turn.agent, artifactRef: action.artifactRef, summary: action.summary, findings: action.findings, createdAt: now() };
          this.store.put('reviews', review);
          this.append(turn.roomId, turn.agent, 'review', action.summary, { ...extra, artifactRefs: [action.artifactRef], data: { reviewId: review.id, findings: action.findings } }); break;
        }
        case 'complete_task': {
          for (const ref of action.evidenceRefs ?? []) this.getArtifact(turn.roomId, ref);
          task.status = 'completed'; task.summary = action.summary; task.unresolvedIssues = action.unresolvedIssues ?? [];
          this.append(turn.roomId, turn.agent, 'completion', action.summary, { ...extra, artifactRefs: action.evidenceRefs, data: { unresolvedIssues: task.unresolvedIssues } }); break;
        }
      }
    }
    this.store.put('tasks', task);
    this.store.put('receipts', { id: receiptId, roomId: turn.roomId, fingerprint: canonical(actions), result: { committed: true } });
  }
  async waitForIdle(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      await delay(2);
      if (!this.pumps.size && !this.scheduled) return;
    } while (Date.now() < deadline);
    throw new AppError('IDLE_TIMEOUT', 'Execution has not settled within the wait timeout.');
  }
  async shutdown(timeoutMs = 3000): Promise<boolean> {
    this.closing = true;
    this.store.transaction(() => {
      for (const { turn, controller } of this.active.values()) {
        controller.abort();
        if (!this.current(turn)) continue;
        const run = this.store.require('runs', turn.runId); run.generation++; run.status = 'interrupted'; run.reason = 'Server shut down during a turn; review side effects before recovery.'; this.store.put('runs', run);
        turn.status = 'interrupted'; this.store.put('turns', turn);
      }
    });
    try { await this.waitForIdle(timeoutMs); return true; } catch { return false; }
  }
}
