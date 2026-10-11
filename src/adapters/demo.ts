import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Action, AdapterInput, AdapterResult, Adapters, AgentAdapter, ArtifactRef } from '../contracts.js';

/** Deterministic fixture; never edits repositories, invokes providers, or runs tests. */
class DemoAdapter implements AgentAdapter {
  constructor(private readonly delayMs: number) {}
  async execute(input: AdapterInput): Promise<AdapterResult> {
    const { turn, context, session, signal } = input;
    input.emit({ type: 'activity', text: 'Simulated fixture turn. No provider call or repository command is running.' });
    await delay(this.delayMs, undefined, { signal });
    const taskId = turn.taskId;
    const actions: Action[] = [];
    const related = context.referencedMessages;
    const ref = turn.artifactRefs[0] ?? related.flatMap(m => m.artifactRefs ?? [])[0];
    if (turn.agent === 'claude' && !ref) {
      const artifactId = randomUUID();
      const artifactRef = { artifactId, version: 1 };
      actions.push(
        { type: 'post_message', body: '[Simulated Claude] I propose invalidating cached entries when the underlying value changes. @Codex, please challenge concurrent-request behavior.' },
        { type: 'publish_artifact', artifactId, title: 'Cache invalidation proposal (fixture)', content: '# Fixture proposal v1\n\nDelete the cached value on invalidation.\n\nThis is simulated design evidence. No code was changed and no tests were run.\n\nKnown review target: requests that began before invalidation.' },
        { type: 'handoff', recipient: 'codex', taskId, request: 'Review version 1 for requests already in flight when invalidation occurs.', artifactRefs: [artifactRef] },
      );
    } else if (turn.agent === 'codex' && ref?.version === 1) {
      actions.push(
        { type: 'submit_review', artifactRef: ref, summary: '[Simulated Codex] Version 1 misses an in-flight request that repopulates the cache after invalidation.', findings: [{ id: randomUUID(), severity: 'high', file: 'fixture/cache.ts', line: 12, explanation: 'An older request can write stale data after invalidation.', evidence: 'Fixture scenario: request A starts, invalidation occurs, then A completes. This was not executed.', nextAction: 'Use a generation counter and reject stale writes.' }] },
        { type: 'request_user_input', taskId, question: '[Simulated Codex] Before we revise, which constraint should we preserve?', options: ['Keep the public API unchanged.', 'Explain the design before revising.'] },
      );
    } else if (turn.agent === 'codex' && related.some(m => m.kind === 'question')) {
      const reviewMessage = [...context.messages, ...context.decisions].find(m => m.kind === 'review' && m.taskId === taskId);
      // The question's preceding review is retrieved by shared room context, not adapter-private memory.
      const artifactRef = reviewMessage?.artifactRefs?.[0];
      if (!artifactRef) throw new Error('Demo review reference is unavailable.');
      actions.push(
        { type: 'post_message', body: '[Simulated Codex] I recorded the human constraint. Claude should revise the captured proposal around the stale completion case.', recipient: 'claude' },
        { type: 'handoff', recipient: 'claude', taskId, request: 'Revise the fixture with a generation counter. Follow the latest human constraint and preserve the requested public API.', artifactRefs: [artifactRef], revision: true },
      );
    } else if (turn.agent === 'claude' && ref) {
      const previous = input.retrieve.artifact(ref);
      const revision: ArtifactRef = { artifactId: ref.artifactId, version: ref.version + 1 };
      actions.push(
        { type: 'post_message', body: '[Simulated Claude] I revised the proposal to discard completions from older generations while preserving the public API.', artifactRefs: [ref] },
        { type: 'publish_artifact', artifactId: ref.artifactId, baseVersion: ref.version, title: previous.title, content: '# Fixture proposal v2\n\nKeep the public API unchanged.\n\n1. Capture the cache generation when each request starts.\n2. Increment the generation on invalidation.\n3. Only cache a result when its captured generation still matches.\n\nFixture verification scenario: a completion from an older generation is discarded.\nNo code was changed or tests executed.\n\nUnresolved: behavior across multiple processes needs real verification.' },
        { type: 'handoff', recipient: 'codex', taskId, request: 'Review the revised generation-check proposal against the human constraint.', artifactRefs: [revision] },
      );
    } else if (turn.agent === 'codex' && ref && ref.version >= 2) {
      actions.push(
        { type: 'submit_review', artifactRef: ref, summary: '[Simulated Codex] The revised fixture addresses stale completions and preserves the API. This is a design review, not an executed test result.', findings: [{ id: randomUUID(), severity: 'low', file: 'fixture/cache.ts', explanation: 'Cross-process invalidation remains unverified.', evidence: 'Fixture-only review; no multi-process test was executed.', nextAction: 'Run a real multi-process integration test after implementing the change.' }] },
        { type: 'complete_task', taskId, summary: '[Simulated Codex] The shared proposal has been revised and reviewed. Human review is ready; real implementation and tests are still required.', evidenceRefs: [ref], unresolvedIssues: ['Cross-process behavior is unverified.', 'This demonstration did not modify code or execute tests.'] },
      );
    } else {
      actions.push({ type: 'request_user_input', question: '[Simulated agent] Start this fixture by addressing Claude, or supply an explicit artifact reference through a handoff.', taskId });
    }
    input.emit({ type: 'text', text: `[Simulated ${turn.agent}] Preparing a structured contribution…` });
    await delay(this.delayMs, undefined, { signal });
    return { actions, providerSessionId: session.providerSessionId ?? `demo-${turn.agent}-${randomUUID()}`, usage: { kind: 'unavailable' } };
  }
}
export function createDemoAdapters(delayMs = 100): Adapters { return { claude: new DemoAdapter(delayMs), codex: new DemoAdapter(delayMs) }; }
