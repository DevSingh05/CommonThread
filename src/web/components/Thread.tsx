import { useEffect, useRef, useState } from 'react';
import type { ArtifactRef, Message, RoomSnapshot } from '../contract';
import { formatTime, participantLabel } from '../lib/format';
import {
  isQuestionAnswered,
  isStaleRef,
  latestVersion,
  pendingGuidanceIds,
  threadItems,
} from '../lib/room-view';
import type { ProvisionalStream } from '../hooks/useRoom';
import { Avatar, Name, SimulatedTag } from './Participant';
import { SafeMarkdown } from './SafeMarkdown';

export interface ThreadActions {
  onReply: (message: Message) => void;
  onAnswer: (question: Message, option?: string) => void;
  onOpenArtifact: (ref: ArtifactRef) => void;
  onJumpTo: (messageId: string) => void;
}

export function Thread(props: {
  snapshot: RoomSnapshot;
  streams: Record<string, ProvisionalStream>;
  highlightId: string | null;
  actions: ThreadActions;
}) {
  const { snapshot, streams, highlightId } = props;
  const items = threadItems(snapshot.messages);
  const pending = pendingGuidanceIds(snapshot);
  const simulated = snapshot.room.mode === 'demo';
  const bySeq = new Map(snapshot.messages.map((m) => [m.id, m]));
  const scroller = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const lastSeq = snapshot.messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const streamLength = Object.values(streams).reduce((n, s) => n + s.text.length + s.tools.length, 0);

  useEffect(() => {
    const node = scroller.current;
    if (node !== null && stuckToBottom) node.scrollTop = node.scrollHeight;
  }, [lastSeq, streamLength, stuckToBottom]);

  useEffect(() => {
    if (highlightId === null) return;
    document.getElementById(`message-${highlightId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightId]);

  return (
    <div
      className="thread"
      ref={scroller}
      onScroll={(event) => {
        const node = event.currentTarget;
        setStuckToBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
      }}
    >
      <ol className="thread-list" aria-label="Shared conversation">
        {items.length === 0 && (
          <li className="thread-empty">
            <p>
              Nothing here yet. Address <strong>@claude</strong> or <strong>@codex</strong> to start work, or post
              context for both.
            </p>
          </li>
        )}
        {items.map((item) =>
          item.type === 'activity' ? (
            <li key={`activity-${item.messages[0]?.id ?? ''}`}>
              <ActivityGroup messages={item.messages} />
            </li>
          ) : (
            <li key={item.message.id}>
              <MessageCard
                message={item.message}
                snapshot={snapshot}
                replyTarget={item.message.replyTo ? bySeq.get(item.message.replyTo) ?? null : null}
                pending={pending.has(item.message.id)}
                simulated={simulated && item.message.author !== 'human' && item.message.author !== 'system'}
                highlighted={highlightId === item.message.id}
                actions={props.actions}
              />
            </li>
          ),
        )}
      </ol>
      {Object.values(streams).map((stream) => (
        <ProvisionalOutput key={stream.turnId} stream={stream} simulated={simulated} />
      ))}
    </div>
  );
}

function MessageCard(props: {
  message: Message;
  snapshot: RoomSnapshot;
  replyTarget: Message | null;
  pending: boolean;
  simulated: boolean;
  highlighted: boolean;
  actions: ThreadActions;
}) {
  const { message, snapshot, actions } = props;
  const classes = ['message', `message-${message.author}`, `kind-${message.kind}`];
  if (props.highlighted) classes.push('message-highlight');

  return (
    <article
      id={`message-${message.id}`}
      className={classes.join(' ')}
      aria-label={`${participantLabel[message.author]} message ${message.seq}`}
      data-kind={message.kind}
      data-author={message.author}
      tabIndex={-1}
    >
      <Avatar id={message.author} />
      <div className="message-main">
        <header className="message-meta">
          <Name id={message.author} />
          {message.recipient !== null && message.recipient !== undefined && (
            <span className="recipient">→ {participantLabel[message.recipient]}</span>
          )}
          <span className="muted" title={message.createdAt}>
            #{message.seq} · {formatTime(message.createdAt)}
          </span>
          {props.simulated && <SimulatedTag />}
          {props.pending && (
            <span
              className="tag tag-pending"
              title="Saved. The running turn started before this message, so an agent sees it on its next turn."
            >
              Saved · delivered next turn
            </span>
          )}
        </header>
        {message.replyTo !== null && message.replyTo !== undefined && (
          <button
            type="button"
            className="reply-link"
            onClick={() => {
              actions.onJumpTo(message.replyTo ?? '');
            }}
          >
            ↪ Replying to{' '}
            {props.replyTarget === null
              ? 'an earlier message'
              : `${participantLabel[props.replyTarget.author]} #${props.replyTarget.seq}`}
          </button>
        )}
        <MessageBody message={message} snapshot={snapshot} actions={actions} />
        {message.artifactRefs.length > 0 && (
          <ArtifactRefs refs={message.artifactRefs} snapshot={snapshot} onOpen={actions.onOpenArtifact} />
        )}
        {message.kind !== 'question' && message.author !== 'system' && (
          <div className="message-actions">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                actions.onReply(message);
              }}
            >
              Reply
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function MessageBody({
  message,
  snapshot,
  actions,
}: {
  message: Message;
  snapshot: RoomSnapshot;
  actions: ThreadActions;
}) {
  const data = message.data ?? {};
  const text = (key: string): string | null => (typeof data[key] === 'string' ? data[key] : null);

  const kind = message.kind === 'decision' && data.proposed === true ? 'proposal' : message.kind;
  switch (kind) {
    case 'handoff': {
      const recipient = message.recipient;
      const revision = data.revision === true;
      const request = text('request') ?? message.body;
      const task = snapshot.tasks.find((t) => t.id === message.taskId);
      return (
        <div className="card card-handoff" data-testid="handoff-card">
          <div className="card-title">
            Handoff {recipient !== null && recipient !== undefined ? `→ ${participantLabel[recipient]}` : ''}
            {revision && <span className="tag tag-revision">Correction round</span>}
          </div>
          {task !== undefined && <div className="card-sub">Task: {task.title}</div>}
          <SafeMarkdown text={request} />
          {message.body !== request && message.body.trim() !== '' && <SafeMarkdown text={message.body} />}
        </div>
      );
    }
    case 'question': {
      const answered = isQuestionAnswered(message, snapshot.messages);
      const options = Array.isArray(data.options) ? data.options.filter((o) => typeof o === 'string') : [];
      return (
        <div className={answered ? 'card card-question answered' : 'card card-question'} data-testid="question-card">
          <div className="card-title">
            Question for you {answered ? <span className="tag">Answered</span> : <span className="tag tag-open">Open</span>}
          </div>
          <SafeMarkdown text={text('question') ?? message.body} />
          {!answered && (
            <div className="question-actions">
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="button button-small"
                  onClick={() => {
                    actions.onAnswer(message, option);
                  }}
                >
                  {option}
                </button>
              ))}
              <button
                type="button"
                className="button button-small button-primary"
                onClick={() => {
                  actions.onAnswer(message);
                }}
              >
                Answer…
              </button>
            </div>
          )}
        </div>
      );
    }
    case 'proposal':
      return (
        <div className="card card-proposal" data-testid="proposal-card">
          <div className="card-title">
            Proposal <span className="hint-inline">— a suggestion from {participantLabel[message.author]}, not an instruction until you agree</span>
          </div>
          <SafeMarkdown text={text('statement') ?? message.body} />
          {text('rationale') !== null && (
            <div className="card-sub">
              Rationale: <SafeMarkdown text={text('rationale') ?? ''} />
            </div>
          )}
        </div>
      );
    case 'decision':
      return (
        <div className="card card-decision">
          <div className="card-title">Decision by {participantLabel[message.author]}</div>
          <SafeMarkdown text={message.body} />
        </div>
      );
    case 'review': {
      const findings = Array.isArray(data.findings) ? data.findings.length : null;
      return (
        <div className="card card-review" data-testid="review-card">
          <div className="card-title">
            Review{findings !== null && ` · ${findings === 0 ? 'no findings' : `${findings} finding${findings === 1 ? '' : 's'}`}`}
          </div>
          <SafeMarkdown text={text('summary') ?? message.body} />
        </div>
      );
    }
    case 'completion':
    case 'task_completed': {
      const issues = Array.isArray(data.unresolvedIssues) ? data.unresolvedIssues.filter((i) => typeof i === 'string') : [];
      return (
        <div className="card card-complete">
          <div className="card-title">Task marked complete by {participantLabel[message.author]}</div>
          <SafeMarkdown text={text('summary') ?? message.body} />
          {issues.length > 0 && (
            <>
              <div className="card-sub">Unresolved:</div>
              <ul>
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      );
    }
    case 'artifact':
      return (
        <div className="card card-artifact">
          <SafeMarkdown text={message.body} />
        </div>
      );
    case 'error':
    case 'status':
    case 'system':
      return <p className="system-body">{message.body}</p>;
    default:
      return <SafeMarkdown text={message.body} />;
  }
}

export function ArtifactRefs(props: {
  refs: ArtifactRef[];
  snapshot: RoomSnapshot;
  onOpen: (ref: ArtifactRef) => void;
}) {
  return (
    <ul className="artifact-refs">
      {props.refs.map((ref) => {
        const artifact = props.snapshot.artifacts.find(
          (a) => a.artifactId === ref.artifactId && a.version === ref.version,
        );
        const stale = isStaleRef(props.snapshot.artifacts, ref);
        const latest = latestVersion(props.snapshot.artifacts, ref.artifactId);
        return (
          <li key={`${ref.artifactId}@${ref.version}`}>
            <button
              type="button"
              className="artifact-link"
              onClick={() => {
                props.onOpen(ref);
              }}
            >
              📄 {artifact?.title ?? 'Artifact'} <strong>v{ref.version}</strong>
              {stale && latest !== null && <span className="tag tag-stale">superseded by v{latest}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ActivityGroup({ messages }: { messages: Message[] }) {
  return (
    <details className="activity">
      <summary>
        Activity · {messages.length} event{messages.length === 1 ? '' : 's'}
      </summary>
      <ul>
        {messages.map((message) => (
          <li key={message.id}>
            <span className="muted">
              #{message.seq} {formatTime(message.createdAt)} {participantLabel[message.author]}:
            </span>{' '}
            {message.body}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ProvisionalOutput({ stream, simulated }: { stream: ProvisionalStream; simulated: boolean }) {
  return (
    <section className="provisional" aria-live="polite" aria-label={`${participantLabel[stream.agent]} provisional output`} data-testid="provisional">
      <header className="message-meta">
        <Name id={stream.agent} />
        <span className="tag tag-provisional">Provisional · not committed to the thread</span>
        {simulated && <SimulatedTag />}
      </header>
      {stream.tools.length > 0 && (
        <ul className="provisional-tools">
          {stream.tools.map((tool, index) => (
            <li key={index}>{tool}</li>
          ))}
        </ul>
      )}
      {stream.text !== '' && <p className="provisional-text">{stream.text}</p>}
    </section>
  );
}
