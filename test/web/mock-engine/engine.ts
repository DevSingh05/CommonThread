/**
 * In-memory stand-in for the conversation engine, used only by UI tests and
 * local UI development until `feature/conversation-engine` is merged.
 *
 * It follows the provisional protocol in docs/contracts.md closely enough to
 * exercise the browser flow, but it is not the engine: there is no SQLite, no
 * real dispatcher and no provider. Every agent output is a scripted fixture and
 * says so.
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentId,
  ArtifactRef,
  ArtifactVersion,
  Finding,
  Message,
  ParticipantId,
  Review,
  Room,
  RoomSnapshot,
  Run,
  Session,
  Task,
  Turn,
} from '../../../src/web/contract.ts';

export interface EngineOptions {
  /** Duration of each simulated agent turn. */
  turnMs: number;
  /** Delay before a queued turn starts, so pause-before-handoff is observable. */
  dispatchMs: number;
  /** Delay before a stop is confirmed for a running turn. */
  stopConfirmMs: number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Step = 'draft' | 'question' | 'review1' | 'revise' | 'review2' | 'reply';

interface RoomState {
  room: Room;
  run: Run | null;
  tasks: Task[];
  turns: Turn[];
  messages: Message[];
  artifacts: ArtifactVersion[];
  reviews: Review[];
  sessions: Session[];
  eventSeq: number;
  nextSeq: number;
  steps: Map<string, Step>;
  timers: Set<ReturnType<typeof setTimeout>>;
  checklistId: string | null;
  humanConstraint: string | null;
}

type Listener = (event: 'snapshot' | 'stream', data: unknown) => void;

const now = () => new Date().toISOString();

export class MockEngine {
  private readonly rooms = new Map<string, RoomState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  readonly options: EngineOptions;

  constructor(options: Partial<EngineOptions> = {}) {
    this.options = { turnMs: 1500, dispatchMs: 700, stopConfirmMs: 600, ...options };
  }

  // ---- Reads ------------------------------------------------------------

  listRooms() {
    return [...this.rooms.values()].map((state) => ({ ...state.room, runStatus: state.run?.status ?? null }));
  }

  snapshot(roomId: string): RoomSnapshot {
    const state = this.room(roomId);
    return {
      room: state.room,
      run: state.run,
      tasks: state.tasks,
      turns: state.turns,
      messages: state.messages,
      artifacts: state.artifacts.map((artifact) => withoutContent(artifact)),
      reviews: state.reviews,
      sessions: state.sessions,
      eventSeq: state.eventSeq,
    };
  }

  artifact(roomId: string, artifactId: string, version: number): ArtifactVersion {
    const found = this.room(roomId).artifacts.find((a) => a.artifactId === artifactId && a.version === version);
    if (found === undefined) throw new HttpError(404, 'artifact_not_found', 'No such artifact version in this room.');
    return found;
  }

  message(roomId: string, messageId: string): Message {
    const found = this.room(roomId).messages.find((m) => m.id === messageId);
    if (found === undefined) throw new HttpError(404, 'message_not_found', 'No such message in this room.');
    return found;
  }

  task(roomId: string, taskId: string): Task {
    const found = this.room(roomId).tasks.find((t) => t.id === taskId);
    if (found === undefined) throw new HttpError(404, 'task_not_found', 'No such task in this room.');
    return found;
  }

  subscribe(roomId: string, listener: Listener): () => void {
    this.room(roomId);
    const set = this.listeners.get(roomId) ?? new Set();
    set.add(listener);
    this.listeners.set(roomId, set);
    return () => set.delete(listener);
  }

  // ---- Mutations --------------------------------------------------------

  createRoom(input: { title: string; goal: string; mode: string; repositoryPath?: string }): Room {
    if (input.mode !== 'demo') {
      throw new HttpError(409, 'live_unavailable', 'Live mode is disabled: adapters and repository guards are not registered.');
    }
    if (input.repositoryPath !== undefined) {
      throw new HttpError(409, 'repository_unavailable', 'Repository association is not available in this engine.');
    }
    const room: Room = { id: randomUUID(), title: input.title, goal: input.goal, mode: 'demo', createdAt: now() };
    const state: RoomState = {
      room,
      run: null,
      tasks: [],
      turns: [],
      messages: [],
      artifacts: [],
      reviews: [],
      sessions: [],
      eventSeq: 0,
      nextSeq: 1,
      steps: new Map(),
      timers: new Set(),
      checklistId: null,
      humanConstraint: null,
    };
    this.rooms.set(room.id, state);
    this.append(state, { author: 'system', kind: 'system', body: 'Room created in simulated demo mode. Agent output comes from deterministic fixtures.' });
    return room;
  }

  postMessage(roomId: string, input: { body: string; recipient?: AgentId; replyTo?: string }): Message {
    const state = this.room(roomId);
    const mentions = [...input.body.matchAll(/(^|[^\w@])@(claude|codex)\b/gi)].map((m) => m[2]?.toLowerCase());
    const distinct = [...new Set(mentions)];
    let recipient: AgentId | undefined = input.recipient;
    if (recipient === undefined && distinct.length > 1) {
      throw new HttpError(409, 'ambiguous_recipient', 'The message mentions more than one agent.');
    }
    if (recipient === undefined && (distinct[0] === 'claude' || distinct[0] === 'codex')) recipient = distinct[0];

    let question: Message | undefined;
    if (input.replyTo !== undefined) {
      const target = state.messages.find((m) => m.id === input.replyTo);
      if (target === undefined) throw new HttpError(404, 'reply_target_not_found', 'replyTo is not a message in this room.');
      if (target.kind === 'question' && !this.answered(state, target)) question = target;
    }
    if (question !== undefined && recipient !== undefined && recipient !== question.author) {
      throw new HttpError(409, 'answer_recipient_mismatch', 'Answers go to the agent that asked.');
    }

    const message = this.append(state, {
      author: 'human',
      kind: 'chat',
      body: input.body,
      recipient: recipient ?? null,
      replyTo: input.replyTo ?? null,
    });

    if (question !== undefined && (question.author === 'claude' || question.author === 'codex')) {
      state.humanConstraint = input.body;
      const task = state.tasks.find((t) => t.id === question.taskId);
      if (task !== undefined) task.status = 'waiting_for_agent';
      this.ensureRun(state);
      this.enqueue(state, question.author, `Human answered: ${input.body}`, question.taskId ?? null, 'review1');
    } else if (recipient !== undefined) {
      this.ensureRun(state);
      const first = state.artifacts.length === 0 && recipient === 'claude';
      let taskId: string | null = null;
      if (first) {
        const task: Task = {
          id: randomUUID(),
          roomId,
          runId: state.run?.id ?? null,
          title: truncate(input.body.replace(/@(claude|codex)/gi, '').trim() || 'Requested work', 60),
          status: 'in_progress',
          owner: 'claude',
          correctionCount: 0,
          summary: null,
          unresolvedIssues: [],
        };
        state.tasks.push(task);
        taskId = task.id;
      }
      this.enqueue(state, recipient, input.body, taskId, first ? 'draft' : 'reply');
    }
    this.changed(state);
    return message;
  }

  updateGoal(roomId: string, goal: string) {
    const state = this.room(roomId);
    state.room = { ...state.room, goal };
    this.append(state, { author: 'system', kind: 'activity', body: `Goal updated by human: ${truncate(goal, 120)}` });
    this.changed(state);
  }

  control(roomId: string, input: { action: string; acknowledgeUncertain?: boolean; agent?: AgentId }) {
    const state = this.room(roomId);
    const run = state.run;
    switch (input.action) {
      case 'pause':
        if (run?.status !== 'running' && run?.status !== 'waiting_for_user') {
          throw new HttpError(409, 'not_running', 'There is no active run to pause.');
        }
        run.status = 'paused';
        this.append(state, { author: 'system', kind: 'activity', body: 'Run paused by human. No new turns will start.' });
        break;
      case 'resume':
        if (run?.status !== 'paused') throw new HttpError(409, 'not_paused', 'The run is not paused.');
        run.status = this.hasOpenQuestion(state) ? 'waiting_for_user' : 'running';
        this.append(state, { author: 'system', kind: 'activity', body: 'Run resumed by human.' });
        this.dispatchSoon(state);
        break;
      case 'stop': {
        if (run === null || !['running', 'waiting_for_user', 'paused'].includes(run.status)) {
          throw new HttpError(409, 'not_running', 'There is no active run to stop.');
        }
        run.generation += 1;
        run.status = 'cancelled';
        run.reason = 'Stopped by human';
        for (const turn of state.turns) if (turn.status === 'queued') turn.status = 'cancelled';
        const running = state.turns.find((t) => t.status === 'running');
        this.clearTimers(state);
        this.append(state, {
          author: 'system',
          kind: 'system',
          body: running === undefined ? 'Run stopped by human.' : 'Run stopped by human. Cancellation requested for the running turn.',
        });
        if (running !== undefined) {
          this.later(state, this.options.stopConfirmMs, () => {
            running.status = 'cancelled';
            running.endedAt = now();
            running.usage = { kind: 'unavailable' };
            this.append(state, { author: 'system', kind: 'activity', body: `${label(running.agent)} turn cancelled (simulated adapter confirmed).` });
            this.changed(state);
          });
        }
        break;
      }
      case 'recover':
        if (input.acknowledgeUncertain !== true) {
          throw new HttpError(400, 'acknowledgement_required', 'Recovery requires acknowledgeUncertain: true.');
        }
        if (run?.status !== 'interrupted') throw new HttpError(409, 'not_interrupted', 'Nothing to recover.');
        run.status = 'cancelled';
        run.reason = 'Recovered after interruption';
        this.append(state, {
          author: 'system',
          kind: 'system',
          body: 'Human acknowledged the interrupted turn. It was not replayed; its side effects are unknown.',
        });
        break;
      case 'fresh_session': {
        if (input.agent !== 'claude' && input.agent !== 'codex') throw new HttpError(400, 'agent_required', 'fresh_session requires agent.');
        const session = this.session(state, input.agent);
        session.state = 'fresh';
        session.updatedAt = now();
        this.append(state, { author: 'system', kind: 'activity', body: `Human started a fresh ${label(input.agent)} session. The previous session will not be resumed.` });
        break;
      }
      default:
        throw new HttpError(400, 'invalid_action', 'Unknown control action.');
    }
    this.changed(state);
  }

  /** Test hook: behave as if the engine crashed mid-turn and restarted. */
  interrupt(roomId: string) {
    const state = this.room(roomId);
    this.clearTimers(state);
    for (const turn of state.turns) if (turn.status === 'running') {
      turn.status = 'interrupted';
      this.session(state, turn.agent).state = 'interrupted';
    }
    if (state.run !== null) {
      state.run.status = 'interrupted';
      state.run.reason = 'Engine restarted during a turn';
    }
    this.append(state, { author: 'system', kind: 'system', body: 'Engine restarted. An in-flight turn was marked interrupted and not replayed.' });
    this.changed(state);
  }

  /** Test hook: silently append a message without notifying SSE listeners. */
  appendQuietly(roomId: string, body: string) {
    const state = this.room(roomId);
    this.append(state, { author: 'system', kind: 'system', body });
    state.eventSeq += 1;
  }

  // ---- Scheduling -------------------------------------------------------

  private ensureRun(state: RoomState) {
    const run = state.run;
    if (run !== null && ['running', 'waiting_for_user', 'paused'].includes(run.status)) {
      if (run.status === 'waiting_for_user') run.status = 'running';
      return;
    }
    state.run = {
      id: randomUUID(),
      roomId: state.room.id,
      generation: (run?.generation ?? 0) + 1,
      status: 'running',
      maxTurns: 8,
      turnCount: 0,
      reason: null,
      createdAt: now(),
      updatedAt: now(),
    };
  }

  private enqueue(state: RoomState, agent: AgentId, request: string, taskId: string | null, step: Step) {
    const run = state.run;
    if (run === null) return;
    const turn: Turn = {
      id: randomUUID(),
      roomId: state.room.id,
      runId: run.id,
      taskId,
      agent,
      generation: run.generation,
      status: 'queued',
      request,
      attempts: 0,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      usage: null,
      contextSeq: null,
    };
    state.turns.push(turn);
    state.steps.set(turn.id, step);
    this.dispatchSoon(state);
  }

  private dispatchSoon(state: RoomState) {
    this.later(state, this.options.dispatchMs, () => {
      this.dispatch(state);
    });
  }

  private dispatch(state: RoomState) {
    const run = state.run;
    if (run === null || run.status !== 'running') return;
    if (state.turns.some((t) => t.status === 'running')) return;
    const turn = state.turns.find((t) => t.status === 'queued' && t.generation === run.generation);
    if (turn === undefined) {
      if (!this.hasOpenQuestion(state)) run.status = 'completed';
      this.changed(state);
      return;
    }
    if (run.turnCount >= run.maxTurns) {
      run.status = 'failed';
      run.reason = 'Turn limit reached';
      this.changed(state);
      return;
    }
    run.turnCount += 1;
    turn.status = 'running';
    turn.attempts = 1;
    turn.startedAt = now();
    turn.contextSeq = state.nextSeq - 1;
    this.session(state, turn.agent).state = 'active';
    this.append(state, { author: 'system', kind: 'activity', body: `${label(turn.agent)} turn started (simulated).` });
    this.changed(state);

    const chunks = streamFor(state.steps.get(turn.id) ?? 'reply', turn.agent);
    const interval = this.options.turnMs / (chunks.length + 1);
    chunks.forEach((chunk, index) => {
      this.later(state, interval * (index + 1), () => {
        if (turn.status !== 'running') return;
        this.emit(state, 'stream', { turnId: turn.id, agent: turn.agent, kind: chunk.kind, text: chunk.text });
      });
    });
    this.later(state, this.options.turnMs, () => {
      this.complete(state, turn);
    });
  }

  private complete(state: RoomState, turn: Turn) {
    const run = state.run;
    if (turn.status !== 'running' || run === null || run.generation !== turn.generation) return;
    const step = state.steps.get(turn.id) ?? 'reply';
    const author: ParticipantId = turn.agent;
    const task = state.tasks.find((t) => t.id === turn.taskId) ?? null;
    const base = { author, taskId: turn.taskId ?? null, runId: run.id };

    switch (step) {
      case 'draft': {
        const ref = this.publish(state, turn, null, 'Release checklist', checklistV1);
        this.append(state, { ...base, kind: 'chat', body: 'Simulated: I drafted a release checklist for the goal. Codex, please review v1.' });
        this.append(state, { ...base, kind: 'artifact', body: 'Simulated: published **Release checklist v1**.', artifactRefs: [ref] });
        this.handoff(state, turn, 'codex', 'Review Release checklist v1 for gaps before we share it.', [ref], false, 'question');
        if (task !== null) {
          task.status = 'waiting_for_agent';
          task.owner = 'codex';
        }
        break;
      }
      case 'question': {
        this.append(state, {
          ...base,
          kind: 'question',
          body: 'Simulated question: before I review, should the checklist target Node 24 LTS only, or also Node 22?',
          data: { question: 'Should the checklist target Node 24 LTS only, or also Node 22?', options: ['Node 24 only', 'Both 22 and 24'] },
        });
        run.status = 'waiting_for_user';
        if (task !== null) task.status = 'waiting_for_user';
        break;
      }
      case 'review1': {
        const ref = this.latestRef(state);
        const findings: Finding[] = [
          {
            id: 'F1',
            severity: 'major',
            file: 'Release checklist',
            line: 3,
            explanation: `The runtime line does not reflect the human constraint (“${truncate(state.humanConstraint ?? 'n/a', 60)}”).`,
            evidence: 'Fixture review: no command was run.',
            suggestedNextAction: 'Update the runtime requirement and add a check for it.',
            resolved: false,
          },
        ];
        this.review(state, turn, ref, 'Simulated review of v1: one major finding.', findings);
        this.handoff(state, turn, 'claude', 'Revise the checklist to address F1 and the human constraint.', [ref], true, 'revise');
        if (task !== null) {
          task.correctionCount += 1;
          task.status = 'waiting_for_agent';
          task.owner = 'claude';
          task.unresolvedIssues = ['F1: runtime requirement does not match the human constraint'];
        }
        break;
      }
      case 'revise': {
        const v2 = checklistV1.replace('- Runtime: Node (any recent version)', `- Runtime: ${state.humanConstraint ?? 'Node 24 LTS'}\n- Verify the runtime version in CI before release`);
        const ref = this.publish(state, turn, this.latestRef(state).version, 'Release checklist', v2);
        this.append(state, { ...base, kind: 'artifact', body: 'Simulated: published **Release checklist v2** addressing F1.', artifactRefs: [ref] });
        this.handoff(state, turn, 'codex', 'Review v2: confirm F1 is resolved.', [ref], false, 'review2');
        if (task !== null) {
          task.status = 'waiting_for_agent';
          task.owner = 'codex';
        }
        break;
      }
      case 'review2': {
        const ref = this.latestRef(state);
        this.review(state, turn, ref, 'Simulated review of v2: F1 is resolved. No findings.', []);
        for (const review of state.reviews) for (const finding of review.findings) finding.resolved = true;
        this.append(state, {
          ...base,
          kind: 'task_completed',
          body: 'Simulated: checklist reviewed and revised. Final version is v2.',
          data: { summary: 'Simulated: checklist reviewed and revised. Final version is v2.', unresolvedIssues: [] },
          artifactRefs: [ref],
        });
        if (task !== null) {
          task.status = 'completed';
          task.summary = 'Final artifact: Release checklist v2 (simulated).';
          task.unresolvedIssues = [];
        }
        break;
      }
      case 'reply':
        this.append(state, { ...base, kind: 'chat', body: `Simulated reply from ${label(turn.agent)}: noted. No further handoff.` });
        break;
    }

    turn.status = 'completed';
    turn.endedAt = now();
    turn.usage = { kind: 'unavailable' };
    this.session(state, turn.agent).deliveredSeq = turn.contextSeq ?? 0;
    this.append(state, { author: 'system', kind: 'activity', body: `${label(turn.agent)} turn completed (simulated).` });
    this.changed(state);
    this.dispatchSoon(state);
  }

  private handoff(state: RoomState, turn: Turn, recipient: AgentId, request: string, refs: ArtifactRef[], revision: boolean, next: Step) {
    this.append(state, {
      author: turn.agent,
      kind: 'handoff',
      body: '',
      recipient,
      taskId: turn.taskId ?? null,
      runId: turn.runId ?? null,
      artifactRefs: refs,
      data: { request, revision, taskId: turn.taskId ?? null },
    });
    this.enqueue(state, recipient, request, turn.taskId ?? null, next);
  }

  private publish(state: RoomState, turn: Turn, baseVersion: number | null, title: string, content: string): ArtifactRef {
    state.checklistId ??= randomUUID();
    const latest = this.latestRefOrNull(state);
    if ((latest?.version ?? null) !== baseVersion) throw new Error('stale base version');
    const version = (latest?.version ?? 0) + 1;
    state.artifacts.push({
      artifactId: state.checklistId,
      version,
      roomId: state.room.id,
      title,
      content,
      createdAt: now(),
      author: turn.agent,
      taskId: turn.taskId ?? null,
    });
    return { artifactId: state.checklistId, version };
  }

  private review(state: RoomState, turn: Turn, ref: ArtifactRef, summary: string, findings: Finding[]) {
    state.reviews.push({ id: randomUUID(), roomId: state.room.id, author: turn.agent, artifactRef: ref, summary, findings, createdAt: now() });
    this.append(state, {
      author: turn.agent,
      kind: 'review',
      body: summary,
      taskId: turn.taskId ?? null,
      runId: turn.runId ?? null,
      artifactRefs: [ref],
      data: { summary, findings },
    });
  }

  // ---- Helpers ----------------------------------------------------------

  private room(roomId: string): RoomState {
    const state = this.rooms.get(roomId);
    if (state === undefined) throw new HttpError(404, 'room_not_found', 'No such room.');
    return state;
  }

  private session(state: RoomState, agent: AgentId): Session {
    let session = state.sessions.find((s) => s.agent === agent);
    if (session === undefined) {
      session = { id: randomUUID(), roomId: state.room.id, agent, state: 'new', deliveredSeq: 0, createdAt: now(), updatedAt: now() };
      state.sessions.push(session);
    }
    return session;
  }

  private latestRefOrNull(state: RoomState): ArtifactRef | null {
    const latest = state.artifacts.at(-1);
    return latest === undefined ? null : { artifactId: latest.artifactId, version: latest.version };
  }

  private latestRef(state: RoomState): ArtifactRef {
    const ref = this.latestRefOrNull(state);
    if (ref === null) throw new Error('no artifact');
    return ref;
  }

  private answered(state: RoomState, question: Message) {
    return state.messages.some((m) => m.author === 'human' && m.replyTo === question.id);
  }

  private hasOpenQuestion(state: RoomState) {
    return state.messages.some((m) => m.kind === 'question' && !this.answered(state, m));
  }

  private append(state: RoomState, input: Partial<Message> & Pick<Message, 'author' | 'kind' | 'body'>): Message {
    const message: Message = {
      id: randomUUID(),
      seq: state.nextSeq++,
      roomId: state.room.id,
      createdAt: now(),
      recipient: null,
      replyTo: null,
      taskId: null,
      runId: state.run?.id ?? null,
      artifactRefs: [],
      data: null,
      ...input,
    };
    state.messages.push(message);
    return message;
  }

  private changed(state: RoomState) {
    state.eventSeq += 1;
    if (state.run !== null) state.run.updatedAt = now();
    this.emit(state, 'snapshot', { roomId: state.room.id, eventSeq: state.eventSeq });
  }

  private emit(state: RoomState, event: 'snapshot' | 'stream', data: unknown) {
    for (const listener of this.listeners.get(state.room.id) ?? []) listener(event, data);
  }

  private later(state: RoomState, ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      fn();
    }, ms);
    state.timers.add(timer);
  }

  private clearTimers(state: RoomState) {
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
  }

  close() {
    for (const state of this.rooms.values()) this.clearTimers(state);
  }
}

const checklistV1 = `# Release checklist (simulated fixture)

- Runtime: Node (any recent version)
- Run typecheck, lint, tests and build
- Start the server on localhost and open the UI
- Confirm demo output is labelled simulated
`;

function streamFor(step: Step, agent: AgentId): { kind: 'text' | 'tool'; text: string }[] {
  const name = label(agent);
  switch (step) {
    case 'draft':
      return [
        { kind: 'tool', text: 'fixture: read room goal' },
        { kind: 'text', text: `${name} (simulated) is drafting ` },
        { kind: 'text', text: 'a release checklist…' },
      ];
    case 'revise':
      return [
        { kind: 'text', text: `${name} (simulated) is revising ` },
        { kind: 'text', text: 'the checklist for F1…' },
      ];
    default:
      return [
        { kind: 'text', text: `${name} (simulated) is ` },
        { kind: 'text', text: 'working…' },
      ];
  }
}

function withoutContent(artifact: ArtifactVersion): ArtifactVersion {
  const meta = { ...artifact };
  delete meta.content;
  return meta;
}

function label(agent: AgentId) {
  return agent === 'claude' ? 'Claude' : 'Codex';
}

function truncate(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
