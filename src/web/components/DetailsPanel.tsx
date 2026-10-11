import { useCallback, useId, useState, type SyntheticEvent } from 'react';
import { api } from '../api/client';
import { agentIds, type AgentId, type ArtifactRef, type Capabilities, type GoalInput, type Message, type RoomSnapshot } from '../contract';
import { formatTime, participantLabel, taskStatusLabel, turnStatusLabel } from '../lib/format';
import {
  activeTurn,
  artifactHistories,
  latestHumanGuidance,
  openFindings,
  openQuestions,
  pendingGuidanceIds,
  sessionFor,
} from '../lib/room-view';
import { useIdempotentAction } from '../hooks/useIdempotentAction';
import { Dialog } from './Dialog';
import { ErrorNotice } from './ErrorNotice';
import { Avatar, Name } from './Participant';

export function DetailsPanel(props: {
  snapshot: RoomSnapshot;
  capabilities: Capabilities;
  onChanged: () => void;
  onOpenArtifact: (ref: ArtifactRef) => void;
  onJumpTo: (messageId: string) => void;
  onAnswer: (question: Message) => void;
}) {
  const { snapshot } = props;
  return (
    <aside className="details" aria-label="Room details">
      <GoalEditor snapshot={snapshot} onChanged={props.onChanged} />
      <LatestGuidance snapshot={snapshot} onJumpTo={props.onJumpTo} />
      <Participants snapshot={snapshot} capabilities={props.capabilities} onChanged={props.onChanged} />
      <Tasks snapshot={snapshot} />
      <Artifacts snapshot={snapshot} onOpen={props.onOpenArtifact} />
      <OpenItems snapshot={snapshot} onAnswer={props.onAnswer} onOpenArtifact={props.onOpenArtifact} />
      {snapshot.room.repositoryPath !== null && snapshot.room.repositoryPath !== undefined && (
        <section className="panel-section">
          <h2>Repository</h2>
          <code className="repo-path">{snapshot.room.repositoryPath}</code>
          <p className="hint">Agents write here one at a time. CommonThread never commits, pushes or resets it.</p>
        </section>
      )}
    </aside>
  );
}

function GoalEditor({ snapshot, onChanged }: { snapshot: RoomSnapshot; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(snapshot.room.goal);
  const id = useId();
  const roomId = snapshot.room.id;
  const send = useCallback(
    async (input: GoalInput, key: string) => {
      await api.updateGoal(roomId, input, key);
      onChanged();
    },
    [roomId, onChanged],
  );
  const action = useIdempotentAction(send);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (await action.run({ goal: goal.trim() })) setEditing(false);
  };

  return (
    <section className="panel-section">
      <div className="section-heading">
        <h2>Goal</h2>
        {!editing && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setGoal(snapshot.room.goal);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <form onSubmit={(event) => void submit(event)} className="goal-form">
          <label htmlFor={id} className="visually-hidden">
            Goal
          </label>
          <textarea
            id={id}
            value={goal}
            rows={4}
            required
            maxLength={4000}
            onChange={(event) => {
              setGoal(event.target.value);
            }}
          />
          <p className="hint">Agents receive the new goal with their next turn.</p>
          <ErrorNotice error={action.error} />
          <div className="form-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setEditing(false);
                action.clearError();
              }}
            >
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={action.busy || goal.trim() === ''}>
              Save goal
            </button>
          </div>
        </form>
      ) : (
        <p className="goal-text" data-testid="goal">
          {snapshot.room.goal}
        </p>
      )}
    </section>
  );
}

function LatestGuidance({ snapshot, onJumpTo }: { snapshot: RoomSnapshot; onJumpTo: (id: string) => void }) {
  const latest = latestHumanGuidance(snapshot);
  const pending = pendingGuidanceIds(snapshot);
  return (
    <section className="panel-section">
      <h2>Latest guidance</h2>
      {latest === null ? (
        <p className="muted">You have not posted anything yet.</p>
      ) : (
        <button
          type="button"
          className="guidance"
          onClick={() => {
            onJumpTo(latest.id);
          }}
        >
          <span className="guidance-body">{latest.body}</span>
          <span className="muted">
            #{latest.seq} · {formatTime(latest.createdAt)}
            {pending.has(latest.id) && ' · saved, delivered next turn'}
          </span>
        </button>
      )}
      {pending.size > 1 && <p className="hint">{pending.size} of your messages are waiting for the next turn.</p>}
    </section>
  );
}

function Participants(props: { snapshot: RoomSnapshot; capabilities: Capabilities; onChanged: () => void }) {
  const { snapshot, capabilities, onChanged } = props;
  const turn = activeTurn(snapshot);
  const [freshFor, setFreshFor] = useState<AgentId | null>(null);
  const roomId = snapshot.room.id;
  const send = useCallback(
    async (agent: AgentId, key: string) => {
      await api.control(roomId, { action: 'fresh_session', agent }, key);
      onChanged();
    },
    [roomId, onChanged],
  );
  const action = useIdempotentAction(send);

  return (
    <section className="panel-section">
      <h2>Participants</h2>
      <ul className="participants">
        <li>
          <Avatar id="human" /> <Name id="human" /> <span className="muted">human · in control</span>
        </li>
        {agentIds.map((agent) => {
          const session = sessionFor(snapshot, agent);
          const working = turn?.agent === agent;
          return (
            <li key={agent} data-testid={`participant-${agent}`}>
              <Avatar id={agent} /> <Name id={agent} />{' '}
              <span className="muted">
                {working ? 'working' : 'idle'} · session {session === null ? 'not started' : session.state.replace(/_/g, ' ')}
              </span>
              {session !== null && (
                <button
                  type="button"
                  className="link-button"
                  disabled={!capabilities.freshSession.available || working}
                  title={
                    working
                      ? 'Wait for the running turn to finish'
                      : capabilities.freshSession.available
                        ? 'Start a new provider session; the old one is not resumed'
                        : (capabilities.freshSession.reason ?? 'Not available')
                  }
                  onClick={() => {
                    setFreshFor(agent);
                  }}
                >
                  Start fresh session…
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {freshFor !== null && (
        <Dialog
          title={`Start a fresh ${participantLabel[freshFor]} session`}
          onClose={() => {
            setFreshFor(null);
            action.clearError();
          }}
        >
          <p>
            {participantLabel[freshFor]} will start a <strong>new provider session</strong> on its next turn. The previous
            session is not resumed, so anything only that session remembered is lost. The shared thread, tasks and
            artifacts are kept and sent as context.
          </p>
          <ErrorNotice error={action.error} />
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setFreshFor(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-warning"
              disabled={action.busy}
              onClick={() =>
                void action.run(freshFor).then((ok) => {
                  if (ok) setFreshFor(null);
                })
              }
            >
              Start fresh session
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function Tasks({ snapshot }: { snapshot: RoomSnapshot }) {
  return (
    <section className="panel-section">
      <h2>Tasks</h2>
      {snapshot.tasks.length === 0 ? (
        <p className="muted">No tasks yet. Directed messages and handoffs create them.</p>
      ) : (
        <ul className="tasks">
          {snapshot.tasks.map((task) => (
            <li key={task.id} className={`task task-${task.status}`} data-testid="task">
              <div className="task-title">{task.title}</div>
              <div className="muted">
                {taskStatusLabel[task.status]}
                {task.owner !== null && task.owner !== undefined && ` · ${participantLabel[task.owner]}`}
                {` · corrections ${task.correctionCount}/2`}
              </div>
              {task.summary !== null && task.summary !== undefined && <p className="task-summary">{task.summary}</p>}
              {task.unresolvedIssues.length > 0 && (
                <ul className="task-issues">
                  {task.unresolvedIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <TurnLog snapshot={snapshot} />
    </section>
  );
}

function TurnLog({ snapshot }: { snapshot: RoomSnapshot }) {
  if (snapshot.turns.length === 0) return null;
  return (
    <details className="turn-log">
      <summary>Turn history ({snapshot.turns.length})</summary>
      <ol>
        {snapshot.turns.map((turn) => (
          <li key={turn.id}>
            {participantLabel[turn.agent]} · {turnStatusLabel[turn.status]}
            {turn.attempts > 1 && ` · ${turn.attempts} attempts`}
            {turn.usage?.kind === 'unavailable' && ' · usage unavailable'}
          </li>
        ))}
      </ol>
    </details>
  );
}

function Artifacts({ snapshot, onOpen }: { snapshot: RoomSnapshot; onOpen: (ref: ArtifactRef) => void }) {
  const histories = artifactHistories(snapshot.artifacts);
  return (
    <section className="panel-section">
      <h2>Artifacts</h2>
      {histories.length === 0 ? (
        <p className="muted">No artifacts published yet.</p>
      ) : (
        <ul className="artifacts">
          {histories.map((history) => (
            <li key={history.artifactId} data-testid="artifact-history">
              <div className="task-title">{history.title}</div>
              <div className="version-list">
                {history.versions.map((version) => (
                  <button
                    key={version.version}
                    type="button"
                    className={version.version === history.latest.version ? 'version version-latest' : 'version'}
                    title={`${participantLabel[version.author]} · ${formatTime(version.createdAt)}`}
                    onClick={() => {
                      onOpen({ artifactId: version.artifactId, version: version.version });
                    }}
                  >
                    v{version.version}
                    {version.version === history.latest.version && ' (latest)'}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OpenItems(props: {
  snapshot: RoomSnapshot;
  onAnswer: (question: Message) => void;
  onOpenArtifact: (ref: ArtifactRef) => void;
}) {
  const questions = openQuestions(props.snapshot);
  const findings = openFindings(props.snapshot);
  return (
    <section className="panel-section">
      <h2>Unresolved</h2>
      {questions.length === 0 && findings.length === 0 && <p className="muted">No open questions or findings.</p>}
      {questions.length > 0 && (
        <ul className="open-questions">
          {questions.map((question) => (
            <li key={question.id}>
              <span>
                <Name id={question.author} /> asks: {question.body}
              </span>{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  props.onAnswer(question);
                }}
              >
                Answer
              </button>
            </li>
          ))}
        </ul>
      )}
      {findings.length > 0 && (
        <ul className="open-findings">
          {findings.map(({ finding, review }) => (
            <li key={`${review.id}-${finding.id}`} className={`finding severity-${finding.severity}`}>
              <span className="severity">{finding.severity}</span> {finding.explanation}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  props.onOpenArtifact(review.artifactRef);
                }}
              >
                on v{review.artifactRef.version}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
