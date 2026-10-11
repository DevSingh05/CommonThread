import { useCallback, useEffect, useId, useRef, type SyntheticEvent, type KeyboardEvent } from 'react';
import { api } from '../api/client';
import type { AgentId, Message, MessageInput, RoomSnapshot } from '../contract';
import { participantLabel } from '../lib/format';
import { resolveSendIntent, type SendIntent } from '../lib/mentions';
import { activeTurn, isQuestionAnswered } from '../lib/room-view';
import { useIdempotentAction } from '../hooks/useIdempotentAction';
import { ErrorNotice } from './ErrorNotice';

export interface ComposerDraft {
  body: string;
  recipient: AgentId | null;
  replyTo: Message | null;
}

export function Composer(props: {
  snapshot: RoomSnapshot;
  draft: ComposerDraft;
  onDraftChange: (draft: ComposerDraft) => void;
  onSent: () => void;
  focusToken: number;
}) {
  const { snapshot, draft, onDraftChange, onSent } = props;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const ids = { body: useId(), recipient: useId(), hint: useId() };
  const roomId = snapshot.room.id;

  const send = useCallback(
    async (input: MessageInput, key: string) => {
      await api.postMessage(roomId, input, key);
    },
    [roomId],
  );
  const action = useIdempotentAction(send);

  useEffect(() => {
    if (props.focusToken > 0) textarea.current?.focus();
  }, [props.focusToken]);

  const intent = resolveSendIntent({
    body: draft.body,
    selected: draft.recipient,
    replyTo: draft.replyTo,
    questionAnswered: draft.replyTo !== null && isQuestionAnswered(draft.replyTo, snapshot.messages),
  });

  const submit = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (intent.kind === 'invalid' || action.busy) return;
    const input: MessageInput = { body: draft.body.trim() };
    if (intent.kind === 'work') input.recipient = intent.agent;
    if (draft.replyTo !== null) input.replyTo = draft.replyTo.id;
    if (await action.run(input)) {
      onDraftChange({ body: '', recipient: null, replyTo: null });
      onSent();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape' && draft.replyTo !== null) {
      onDraftChange({ ...draft, replyTo: null });
    }
  };

  const answering = draft.replyTo?.kind === 'question' && intent.kind !== 'reply';

  return (
    <form className="composer" onSubmit={(event) => void submit(event)} aria-label="Message composer">
      {draft.replyTo !== null && (
        <div className="composer-context">
          <span>
            {answering ? 'Answering' : 'Replying to'} {participantLabel[draft.replyTo.author]} #{draft.replyTo.seq}:{' '}
            <span className="muted">{truncate(draft.replyTo.body, 90)}</span>
          </span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onDraftChange({ ...draft, replyTo: null });
            }}
          >
            Cancel reply
          </button>
        </div>
      )}
      <div className="composer-row">
        <label htmlFor={ids.recipient} className="visually-hidden">
          Recipient
        </label>
        <select
          id={ids.recipient}
          value={draft.recipient ?? ''}
          disabled={answering}
          title={answering ? 'Answers go to the agent who asked' : 'Who should act on this message'}
          onChange={(event) => {
            const value = event.target.value;
            onDraftChange({ ...draft, recipient: value === 'claude' || value === 'codex' ? value : null });
          }}
        >
          <option value="">Everyone (context only)</option>
          <option value="claude">Claude — start work</option>
          <option value="codex">Codex — start work</option>
        </select>
        <label htmlFor={ids.body} className="visually-hidden">
          Message
        </label>
        <textarea
          id={ids.body}
          ref={textarea}
          value={draft.body}
          rows={3}
          maxLength={20_000}
          placeholder="Write to the room. Use @claude or @codex to ask one agent to act."
          aria-describedby={ids.hint}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            onDraftChange({ ...draft, body: event.target.value });
          }}
        />
        <button
          type="submit"
          className="button button-primary"
          disabled={action.busy || intent.kind === 'invalid'}
        >
          {action.busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      <p
        id={ids.hint}
        className={`composer-hint hint-${draft.body.trim() === '' ? 'context' : intent.kind}`}
        data-testid="composer-hint"
      >
        {describeIntent(intent, snapshot, draft.body.trim() === '')}
        <span className="muted"> · Ctrl/⌘+Enter to send</span>
      </p>
      <ErrorNotice error={action.error} onRetry={() => void submit()} onDismiss={action.clearError} />
    </form>
  );
}

function describeIntent(intent: SendIntent, snapshot: RoomSnapshot, empty: boolean): string {
  const running = activeTurn(snapshot);
  const paused = snapshot.run?.status === 'paused';
  const later =
    running !== null
      ? ` ${participantLabel[running.agent]} is mid-turn; this is saved now and delivered on a later turn, not injected into the current one.`
      : '';
  const pausedNote = paused ? ' The run is paused, so the work stays queued until you resume.' : '';
  switch (intent.kind) {
    case 'invalid':
      return empty ? 'Adds shared context unless you pick a recipient or @mention an agent.' : intent.reason;
    case 'context':
      return `Adds shared context only — no agent starts work.${later}`;
    case 'reply':
      return `Adds a reply as shared context — no agent starts work.${later}`;
    case 'work':
      return `Starts work: queues a turn for ${participantLabel[intent.agent]}${intent.via === 'mention' ? ' (from @mention)' : ''}.${pausedNote}${later}`;
    case 'answer':
      return `Answers ${participantLabel[intent.agent]}'s question; ${participantLabel[intent.agent]} continues next.${pausedNote}${later}`;
  }
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
