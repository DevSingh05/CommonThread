import type { AgentId, Message, ParticipantId } from '../contract';

const mentionPattern = /(^|[^\w@])@(claude|codex)\b/gi;

/** Distinct agents @-mentioned in a message body, in first-mention order. */
export function parseMentions(body: string): AgentId[] {
  const found: AgentId[] = [];
  for (const match of body.matchAll(mentionPattern)) {
    const agent = match[2]?.toLowerCase();
    if ((agent === 'claude' || agent === 'codex') && !found.includes(agent)) found.push(agent);
  }
  return found;
}

export type SendIntent =
  | { kind: 'context' }
  | { kind: 'work'; agent: AgentId; via: 'selector' | 'mention' }
  | { kind: 'answer'; agent: ParticipantId; question: Message }
  | { kind: 'reply'; message: Message }
  | { kind: 'invalid'; reason: string };

/**
 * What a send will do, decided before it leaves the browser so the composer
 * can say so. The engine re-validates; this never authorises anything itself.
 */
export function resolveSendIntent(input: {
  body: string;
  selected: AgentId | null;
  replyTo: Message | null;
  questionAnswered: boolean;
}): SendIntent {
  const { body, selected, replyTo } = input;
  if (body.trim() === '') return { kind: 'invalid', reason: 'Write a message first.' };
  const mentions = parseMentions(body);

  if (replyTo?.kind === 'question' && !input.questionAnswered) {
    if (selected !== null) {
      return {
        kind: 'invalid',
        reason: `Answers go to whoever asked (${replyTo.author}). Clear the recipient to answer.`,
      };
    }
    return { kind: 'answer', agent: replyTo.author, question: replyTo };
  }

  if (selected !== null) {
    const other = mentions.find((agent) => agent !== selected);
    if (other !== undefined) {
      return {
        kind: 'invalid',
        reason: `Recipient is ${selected} but the message mentions @${other}. Pick one agent.`,
      };
    }
    return { kind: 'work', agent: selected, via: 'selector' };
  }
  if (mentions.length > 1) {
    return {
      kind: 'invalid',
      reason: 'The message mentions both @claude and @codex. Choose one recipient so work is not ambiguous.',
    };
  }
  const [mentioned] = mentions;
  if (mentioned !== undefined) return { kind: 'work', agent: mentioned, via: 'mention' };
  if (replyTo !== null) return { kind: 'reply', message: replyTo };
  return { kind: 'context' };
}
