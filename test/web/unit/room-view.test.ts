import { describe, expect, it } from 'vitest';
import {
  artifactHistories,
  isStaleRef,
  openFindings,
  openQuestions,
  pendingGuidanceIds,
  summarizeUsage,
  threadItems,
} from '../../../src/web/lib/room-view';
import { message, snapshot, turn } from './fixtures';

describe('pending guidance', () => {
  it('marks human messages after the running turn context as pending', () => {
    const before = message({ author: 'human', body: 'before' });
    const after = message({ author: 'human', body: 'after' });
    const view = snapshot({
      messages: [before, after],
      turns: [turn({ agent: 'claude', status: 'running', contextSeq: before.seq })],
    });
    expect([...pendingGuidanceIds(view)]).toEqual([after.id]);
  });

  it('falls back to the session delivery cursor', () => {
    const first = message({ author: 'human' });
    const second = message({ author: 'human' });
    const view = snapshot({
      messages: [first, second],
      turns: [turn({ agent: 'codex', status: 'running' })],
      sessions: [{ id: 's', roomId: 'r1', agent: 'codex', state: 'active', deliveredSeq: first.seq }],
    });
    expect([...pendingGuidanceIds(view)]).toEqual([second.id]);
  });

  it('marks nothing when no turn is running', () => {
    expect(pendingGuidanceIds(snapshot({ messages: [message({ author: 'human' })] })).size).toBe(0);
  });
});

describe('questions, artifacts and findings', () => {
  it('closes questions once the human replies to them', () => {
    const question = message({ author: 'codex', kind: 'question' });
    expect(openQuestions(snapshot({ messages: [question] }))).toHaveLength(1);
    const answer = message({ author: 'human', replyTo: question.id });
    expect(openQuestions(snapshot({ messages: [question, answer] }))).toHaveLength(0);
  });

  it('groups artifact versions and detects stale references', () => {
    const artifacts = [2, 1].map((version) => ({
      artifactId: 'a',
      version,
      roomId: 'r1',
      title: `Doc v${String(version)}`,
      createdAt: 'x',
      author: 'claude' as const,
    }));
    const [history] = artifactHistories(artifacts);
    expect(history?.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(history?.title).toBe('Doc v2');
    expect(isStaleRef(artifacts, { artifactId: 'a', version: 1 })).toBe(true);
    expect(isStaleRef(artifacts, { artifactId: 'a', version: 2 })).toBe(false);
  });

  it('reports unresolved findings from the newest review only', () => {
    const finding = (id: string, resolved = false) => ({ id, severity: 'major' as const, explanation: id, resolved });
    const review = (version: number, findings: ReturnType<typeof finding>[]) => ({
      id: `rv${String(version)}`,
      roomId: 'r1',
      author: 'codex' as const,
      artifactRef: { artifactId: 'a', version },
      summary: '',
      findings,
      createdAt: 'x',
    });
    const view = snapshot({ reviews: [review(1, [finding('old')]), review(2, [finding('new'), finding('done', true)])] });
    expect(openFindings(view).map((f) => f.finding.id)).toEqual(['new']);
  });
});

describe('usage', () => {
  it('never invents usage for unavailable turns', () => {
    const usage = summarizeUsage([
      turn({ agent: 'claude', status: 'completed', usage: { kind: 'reported', inputTokens: 10, outputTokens: 5 } }),
      turn({ agent: 'codex', status: 'completed', usage: { kind: 'unavailable' } }),
      turn({ agent: 'codex', status: 'failed' }),
      turn({ agent: 'claude', status: 'running' }),
      turn({ agent: 'claude', status: 'queued' }),
    ]);
    expect(usage).toMatchObject({ reportedInput: 10, reportedOutput: 5, reportedTurns: 1, unavailableTurns: 2 });
  });
});

describe('threadItems', () => {
  it('orders by seq and collapses consecutive activity', () => {
    const a = message({ author: 'human' });
    const b = message({ author: 'system', kind: 'activity' });
    const c = message({ author: 'system', kind: 'activity' });
    const d = message({ author: 'claude' });
    const items = threadItems([d, c, b, a]);
    expect(items.map((item) => item.type)).toEqual(['message', 'activity', 'message']);
    expect(items[1]?.type === 'activity' ? items[1].messages.length : 0).toBe(2);
  });
});
