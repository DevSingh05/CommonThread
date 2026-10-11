import { describe, expect, it } from 'vitest';
import { parseMentions, resolveSendIntent } from '../../../src/web/lib/mentions';
import { message } from './fixtures';

describe('mentions', () => {
  it('finds distinct agent mentions and ignores emails or partial words', () => {
    expect(parseMentions('@Claude please, then @codex. Ping @claude again')).toEqual(['claude', 'codex']);
    expect(parseMentions('mail me at me@claude.ai or @claudette')).toEqual([]);
  });
});

describe('resolveSendIntent', () => {
  const base = { selected: null, replyTo: null, questionAnswered: false };

  it('treats unaddressed messages as context only', () => {
    expect(resolveSendIntent({ ...base, body: 'fyi' })).toEqual({ kind: 'context' });
  });

  it('uses a single mention as the recipient', () => {
    expect(resolveSendIntent({ ...base, body: '@codex review' })).toEqual({ kind: 'work', agent: 'codex', via: 'mention' });
  });

  it('rejects ambiguous mentions and conflicting selector', () => {
    expect(resolveSendIntent({ ...base, body: '@claude and @codex' }).kind).toBe('invalid');
    expect(resolveSendIntent({ ...base, body: 'hey @codex', selected: 'claude' }).kind).toBe('invalid');
    expect(resolveSendIntent({ ...base, body: 'hey @claude', selected: 'claude' })).toMatchObject({ kind: 'work', agent: 'claude' });
  });

  it('routes answers to the agent that asked, never to a chosen recipient', () => {
    const question = message({ author: 'codex', kind: 'question' });
    expect(resolveSendIntent({ ...base, body: 'Node 24', replyTo: question })).toMatchObject({ kind: 'answer', agent: 'codex' });
    expect(resolveSendIntent({ ...base, body: 'Node 24', replyTo: question, selected: 'claude' }).kind).toBe('invalid');
  });

  it('treats a reply to an answered question or plain message as context', () => {
    const question = message({ author: 'codex', kind: 'question' });
    expect(resolveSendIntent({ ...base, body: 'more', replyTo: question, questionAnswered: true }).kind).toBe('reply');
  });

  it('refuses empty input', () => {
    expect(resolveSendIntent({ ...base, body: '   ' }).kind).toBe('invalid');
  });
});
