/**
 * Opt-in credentialed smoke test: real Claude → Codex → Claude handoffs through the live adapters.
 * It makes real, billable provider requests. Run only with:
 *   COMMONTHREAD_LIVE_SMOKE=1 npm run smoke:providers
 * Requires `claude` login (or ANTHROPIC_API_KEY) and `codex login` (or CODEX_API_KEY / OPENAI_API_KEY).
 * This drives the adapters directly with an in-memory context; it is not the engine dispatcher.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveAdapters, liveConfigFromEnv } from '../src/adapters/live.js';
import type { Action, AdapterInput, AgentId, Message, Session, Task } from '../src/contracts.js';

if (process.env.COMMONTHREAD_LIVE_SMOKE !== '1') {
  console.error('Refusing to run: set COMMONTHREAD_LIVE_SMOKE=1 to make real provider requests.');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'commonthread-smoke-'));
const adapters = createLiveAdapters({ ...liveConfigFromEnv(), enabled: true, scratchRoot: scratch });
const now = () => new Date().toISOString();
const roomId = randomUUID();
const room = { id: roomId, title: 'Provider smoke', goal: 'Agree on a one-sentence project motto through explicit handoffs.', mode: 'live' as const, createdAt: now() };
const task: Task = { id: randomUUID(), roomId, runId: randomUUID(), title: 'Motto', status: 'in_progress', owner: 'claude', correctionCount: 0, unresolvedIssues: [], createdAt: now() };
const messages: Message[] = [];
const sessions: Record<AgentId, Session> = {
  claude: { id: randomUUID(), roomId, agent: 'claude', state: 'fresh', deliveredCursor: 0, createdAt: now(), updatedAt: now() },
  codex: { id: randomUUID(), roomId, agent: 'codex', state: 'fresh', deliveredCursor: 0, createdAt: now(), updatedAt: now() },
};
const post = (author: Message['author'], body: string, extra: Partial<Message> = {}) => {
  const message: Message = { id: randomUUID(), seq: messages.length + 1, roomId, author, kind: 'message', body, createdAt: now(), ...extra };
  messages.push(message); return message;
};

const steps: { agent: AgentId; request: string; expect: AgentId | 'complete' }[] = [
  { agent: 'claude', request: 'Propose a motto in a post_message, then hand off to codex asking for one concrete improvement. Do not use any repository tools.', expect: 'codex' },
  { agent: 'codex', request: 'Suggest one improvement to Claude\'s motto in a post_message, then hand off back to claude. Do not run commands.', expect: 'claude' },
  { agent: 'claude', request: 'Adopt or reject Codex\'s suggestion in a post_message, then complete_task with the final motto.', expect: 'complete' },
];

post('human', 'Please keep it under 12 words. Claude starts.', { recipient: 'claude' });
let failures = 0;
try {
  for (const step of steps) {
    const session = sessions[step.agent];
    const pending = messages.filter(message => message.seq > session.deliveredCursor);
    const input: AdapterInput = {
      room, session,
      turn: { id: randomUUID(), roomId, runId: task.runId, taskId: task.id, agent: step.agent, generation: 1, status: 'running', request: step.request, relevantMessageIds: [], artifactRefs: [], attempts: 1, createdAt: now() },
      context: {
        goal: room.goal, agent: step.agent, task, request: step.request, humanGuidance: messages.filter(m => m.author === 'human'),
        messages: pending, referencedMessages: [], decisions: [], questions: [], artifactRefs: [],
        deliveryCursor: pending.at(-1)?.seq ?? session.deliveredCursor, hasMoreMessages: false, truncatedMessageIds: [],
        instructions: 'You are the named agent in a shared room. Preserve every author identity. Make explicit public contributions through structured actions only.',
      },
      signal: AbortSignal.timeout(Number(process.env.COMMONTHREAD_TURN_TIMEOUT_MS ?? 180_000)),
      emit: event => process.stdout.write(event.type === 'activity' ? `\n  [${step.agent} activity] ${event.text}\n` : ''),
      retrieve: {
        message: id => { const m = messages.find(x => x.id === id); if (!m) throw new Error('missing'); return m; },
        task: id => { if (id !== task.id) throw new Error('missing'); return task; },
        artifact: () => { throw new Error('no artifacts in smoke test'); },
      },
    };
    console.log(`\n== ${step.agent} turn (${session.providerSessionId ? `resuming ${session.providerSessionId}` : 'new session'})`);
    const output = await adapters[step.agent].execute(input);
    const actions = output.actions as Action[];
    sessions[step.agent] = { ...session, state: 'ready', providerSessionId: output.providerSessionId, deliveredCursor: input.context.deliveryCursor, updatedAt: now() };
    console.log(`  session=${output.providerSessionId ?? '(none)'} usage=${JSON.stringify(output.usage)}`);
    for (const action of actions) {
      console.log(`  ${step.agent} → ${action.type}: ${'body' in action ? action.body : 'request' in action ? action.request : 'summary' in action ? action.summary : ''}`);
      if (action.type === 'post_message') post(step.agent, action.body);
      if (action.type === 'handoff') post(step.agent, action.request, { kind: 'handoff', recipient: action.recipient });
      if (action.type === 'complete_task') post(step.agent, action.summary, { kind: 'completion' });
    }
    const ok = step.expect === 'complete'
      ? actions.some(a => a.type === 'complete_task')
      : actions.some(a => a.type === 'handoff' && a.recipient === step.expect);
    if (!ok) { failures++; console.log(`  ✗ expected ${step.expect === 'complete' ? 'complete_task' : `handoff to ${step.expect}`}`); }
    else console.log('  ✓ expected structured action present');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `\nSMOKE FAILED (${failures} step(s) without the expected action)` : '\nSMOKE PASSED: Claude → Codex → Claude via real provider sessions');
process.exit(failures ? 1 : 0);
