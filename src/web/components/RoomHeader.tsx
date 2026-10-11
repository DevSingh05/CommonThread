import { useCallback, useState } from 'react';
import { api } from '../api/client';
import type { ControlInput, RoomSnapshot } from '../contract';
import { formatTokens, participantLabel, runStatusLabel } from '../lib/format';
import { activeTurn, queuedTurns, summarizeUsage } from '../lib/room-view';
import { useIdempotentAction } from '../hooks/useIdempotentAction';
import type { Connection } from '../hooks/useRoom';
import { Dialog } from './Dialog';
import { ErrorNotice } from './ErrorNotice';

export function RoomHeader(props: {
  snapshot: RoomSnapshot;
  connection: Connection;
  onChanged: () => void;
  onToggleRooms: () => void;
  onToggleDetails: () => void;
}) {
  const { snapshot, onChanged } = props;
  const { room, run } = snapshot;
  const turn = activeTurn(snapshot);
  const queued = queuedTurns(snapshot).length;
  const [recovering, setRecovering] = useState(false);

  const send = useCallback(
    async (input: ControlInput, key: string) => {
      await api.control(room.id, input, key);
      onChanged();
    },
    [room.id, onChanged],
  );
  const control = useIdempotentAction(send);

  const status = run?.status ?? null;
  const canPause = status === 'running' || status === 'waiting_for_user';
  const canResume = status === 'paused';
  const canStop = status === 'running' || status === 'waiting_for_user' || status === 'paused';
  const interrupted = status === 'interrupted' || snapshot.turns.some((t) => t.status === 'interrupted');

  return (
    <header className="room-header">
      <div className="room-header-top">
        <button type="button" className="icon-button narrow-only" aria-label="Show rooms" onClick={props.onToggleRooms}>
          ☰
        </button>
        <h1 className="room-title">{room.title}</h1>
        <ModeBadge mode={room.mode} />
        <ConnectionDot connection={props.connection} />
        <button
          type="button"
          className="icon-button narrow-only"
          aria-label="Show room details"
          onClick={props.onToggleDetails}
        >
          ⓘ
        </button>
      </div>

      <div className="room-header-status">
        <span className={`run-status run-${status ?? 'none'}`} data-testid="run-status">
          {status === null ? 'No run yet' : runStatusLabel[status]}
        </span>
        {run !== null && run !== undefined && (
          <span className="muted" title="Turns used / maximum for this run">
            Turn {run.turnCount}/{run.maxTurns}
          </span>
        )}
        <span data-testid="active-turn">
          {turn === null ? (
            <span className="muted">No agent turn running</span>
          ) : (
            <span className={`active-turn active-${turn.agent}`}>
              <span className="pulse" aria-hidden="true" /> {participantLabel[turn.agent]} is working
            </span>
          )}
        </span>
        {queued > 0 && <span className="muted">{queued} queued</span>}
        <UsageSummaryView snapshot={snapshot} />
      </div>

      <div className="room-header-controls">
        <button
          type="button"
          className="button"
          disabled={!canPause || control.busy}
          title={canPause ? 'Prevent new turns from starting' : 'Nothing is scheduled to pause'}
          onClick={() => void control.run({ action: 'pause' })}
        >
          Pause
        </button>
        <button
          type="button"
          className="button"
          disabled={!canResume || control.busy}
          title={canResume ? 'Allow queued turns to start again' : 'The run is not paused'}
          onClick={() => void control.run({ action: 'resume' })}
        >
          Resume
        </button>
        <button
          type="button"
          className="button button-danger"
          disabled={!canStop || control.busy}
          title={canStop ? 'Cancel queued work and request cancellation of the running turn' : 'Nothing to stop'}
          onClick={() => void control.run({ action: 'stop' })}
        >
          Stop
        </button>
        {interrupted && (
          <button
            type="button"
            className="button button-warning"
            onClick={() => {
              setRecovering(true);
            }}
          >
            Recover…
          </button>
        )}
      </div>

      <RunExplanation snapshot={snapshot} />
      <ErrorNotice error={control.error} onRetry={() => void control.retry()} onDismiss={control.clearError} />

      {recovering && (
        <RecoveryDialog
          busy={control.busy}
          error={control.error}
          onClose={() => {
            setRecovering(false);
          }}
          onConfirm={async () => {
            if (await control.run({ action: 'recover', acknowledgeUncertain: true })) setRecovering(false);
          }}
        />
      )}
    </header>
  );
}

export function ModeBadge({ mode }: { mode: 'demo' | 'live' }) {
  return mode === 'demo' ? (
    <span className="mode-badge mode-badge-demo" data-testid="mode-badge">
      Simulated · demo adapters, no real provider work
    </span>
  ) : (
    <span className="mode-badge mode-badge-live" data-testid="mode-badge">
      Live · real Claude and Codex sessions
    </span>
  );
}

function ConnectionDot({ connection }: { connection: Connection }) {
  const label =
    connection === 'live'
      ? 'Live updates connected'
      : connection === 'connecting'
        ? 'Connecting to live updates'
        : 'Live updates lost — reconnecting; history is refetched';
  return (
    <span className={`connection connection-${connection}`} role="status" title={label} data-testid="connection">
      <span className="connection-dot" aria-hidden="true" />
      <span className="connection-label">{connection === 'live' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}</span>
    </span>
  );
}

function RunExplanation({ snapshot }: { snapshot: RoomSnapshot }) {
  const turn = activeTurn(snapshot);
  const status = snapshot.run?.status;
  const agent = turn === null ? null : participantLabel[turn.agent];
  let text: string | null = null;
  if (status === 'paused') {
    text =
      agent === null
        ? 'Paused. No new turns will start until you resume.'
        : `Paused. No new turns will start, but ${agent}'s current turn is still running and may finish.`;
  } else if (status === 'cancelled' && agent !== null) {
    text = `Stopped. Cancellation was requested, but ${agent}'s process has not confirmed it ended. Its late results will be rejected.`;
  } else if (status === 'cancelled') {
    text = 'Stopped. Queued work was cancelled. Send a directed message to start a new run.';
  } else if (status === 'interrupted') {
    text =
      'The engine restarted while a turn was in flight. That turn was not replayed and its side effects are unknown. Review before recovering.';
  } else if (status === 'waiting_for_user') {
    text = 'An agent asked a question. Answer it from the thread to continue.';
  } else if (status === 'completed') {
    text = 'The work queue is drained. That does not by itself mean the goal is met.';
  } else if (status === 'failed') {
    text = `The run failed${snapshot.run?.reason ? `: ${snapshot.run.reason}` : '.'}`;
  }
  if (text === null) return null;
  return (
    <p className={`run-explanation run-explanation-${status ?? 'none'}`} data-testid="run-explanation">
      {text}
    </p>
  );
}

function UsageSummaryView({ snapshot }: { snapshot: RoomSnapshot }) {
  const usage = summarizeUsage(snapshot.turns);
  const parts: string[] = [];
  if (usage.reportedTurns > 0) {
    parts.push(`${formatTokens(usage.reportedInput)} in / ${formatTokens(usage.reportedOutput)} out tokens reported`);
  }
  if (usage.estimatedTurns > 0) {
    parts.push(`≈${formatTokens(usage.estimatedInput + usage.estimatedOutput)} tokens estimated`);
  }
  if (usage.unavailableTurns > 0) {
    parts.push(`usage unavailable for ${usage.unavailableTurns} turn${usage.unavailableTurns === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return null;
  return (
    <span className="usage" data-testid="usage" title="Only provider-reported or estimated usage. No prices are shown.">
      {parts.join(' · ')}
    </span>
  );
}

export function RecoveryDialog(props: {
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <Dialog title="Recover interrupted work" onClose={props.onClose}>
      <p>
        The engine stopped while an agent turn was in flight. CommonThread did not replay that turn and cannot tell
        whether the provider finished, partially ran tools, or changed files.
      </p>
      <ul>
        <li>Inspect the repository and artifacts before continuing.</li>
        <li>Recovery marks the uncertain turn as interrupted and lets you schedule new work.</li>
        <li>Nothing is rolled back, reset or retried automatically.</li>
      </ul>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => {
            setAcknowledged(event.target.checked);
          }}
        />
        I understand the interrupted turn may have had side effects that are unknown.
      </label>
      <ErrorNotice error={props.error} />
      <div className="dialog-actions">
        <button type="button" className="button" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-warning"
          disabled={!acknowledged || props.busy}
          onClick={() => void props.onConfirm()}
        >
          Recover
        </button>
      </div>
    </Dialog>
  );
}
