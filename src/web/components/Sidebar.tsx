import { useCallback, useId, useState, type SyntheticEvent } from 'react';
import { api } from '../api/client';
import type { Capabilities, CreateRoomInput, RoomMode, RoomSummary } from '../contract';
import { runStatusLabel } from '../lib/format';
import { useIdempotentAction } from '../hooks/useIdempotentAction';
import { ErrorNotice } from './ErrorNotice';

export function Sidebar(props: {
  rooms: RoomSummary[];
  roomsError: unknown;
  roomsLoaded: boolean;
  selectedRoomId: string | null;
  capabilities: Capabilities;
  onSelect: (roomId: string) => void;
  onCreated: (roomId: string) => void;
  onRetryRooms: () => void;
}) {
  const [creating, setCreating] = useState(props.roomsLoaded && props.rooms.length === 0);

  return (
    <nav className="sidebar" aria-label="Rooms">
      <div className="brand">
        <img src="/favicon.svg" alt="" width={24} height={24} />
        <span>CommonThread</span>
      </div>
      <div className="sidebar-section">
        <div className="section-heading">
          <h2>Rooms</h2>
          <button
            type="button"
            className="button button-small"
            aria-expanded={creating}
            onClick={() => {
              setCreating((open) => !open);
            }}
          >
            {creating ? 'Cancel' : 'New room'}
          </button>
        </div>
        {creating && (
          <CreateRoomForm
            capabilities={props.capabilities}
            onCreated={(roomId) => {
              setCreating(false);
              props.onCreated(roomId);
            }}
          />
        )}
        <ErrorNotice error={props.roomsError} onRetry={props.onRetryRooms} />
        {props.roomsLoaded && props.rooms.length === 0 && !creating && (
          <p className="muted">No rooms yet. Create one to start a shared thread.</p>
        )}
        <ul className="room-list">
          {props.rooms.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                className={room.id === props.selectedRoomId ? 'room-item room-item-active' : 'room-item'}
                aria-current={room.id === props.selectedRoomId ? 'page' : undefined}
                onClick={() => {
                  props.onSelect(room.id);
                }}
              >
                <span className="room-item-title">{room.title}</span>
                <span className="room-item-meta">
                  <span className={`mode-pill mode-${room.mode}`}>{room.mode === 'demo' ? 'Simulated' : 'Live'}</span>
                  {room.runStatus !== null && room.runStatus !== undefined && (
                    <span className="muted">{runStatusLabel[room.runStatus]}</span>
                  )}
                </span>
                {room.repositoryPath !== null && room.repositoryPath !== undefined && (
                  <span className="room-item-repo" title={room.repositoryPath}>
                    {room.repositoryPath}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function CreateRoomForm(props: { capabilities: Capabilities; onCreated: (roomId: string) => void }) {
  const { live, demo, repository } = props.capabilities;
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<RoomMode>(demo.available ? 'demo' : 'live');
  const [repositoryPath, setRepositoryPath] = useState('');
  const ids = { title: useId(), goal: useId(), repo: useId(), live: useId(), repoHelp: useId() };
  const { onCreated } = props;

  const send = useCallback(
    async (input: CreateRoomInput, key: string) => {
      onCreated(await api.createRoom(input, key));
    },
    [onCreated],
  );
  const action = useIdempotentAction(send);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const input: CreateRoomInput = { title: title.trim(), goal: goal.trim(), mode };
    const repo = repositoryPath.trim();
    if (repo !== '' && repository.available) input.repositoryPath = repo;
    void action.run(input);
  };

  const modeAvailable = mode === 'live' ? live.available : demo.available;

  return (
    <form className="create-room" onSubmit={submit}>
      <label htmlFor={ids.title}>Title</label>
      <input
        id={ids.title}
        value={title}
        required
        maxLength={200}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <label htmlFor={ids.goal}>Goal</label>
      <textarea
        id={ids.goal}
        value={goal}
        required
        rows={3}
        maxLength={4000}
        onChange={(event) => {
          setGoal(event.target.value);
        }}
      />
      <fieldset className="mode-choice">
        <legend>Mode</legend>
        <label>
          <input
            type="radio"
            name="mode"
            value="demo"
            checked={mode === 'demo'}
            disabled={!demo.available}
            onChange={() => {
              setMode('demo');
            }}
          />
          Simulated demo
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            value="live"
            checked={mode === 'live'}
            disabled={!live.available}
            aria-describedby={live.available ? undefined : ids.live}
            onChange={() => {
              setMode('live');
            }}
          />
          Live providers
        </label>
        {!live.available && (
          <p id={ids.live} className="hint">
            Live is off: {live.reason ?? 'real adapters and repository safeguards are not registered.'}
          </p>
        )}
        {mode === 'demo' && (
          <p className="hint">Demo agents are deterministic fixtures. Their output is labelled simulated.</p>
        )}
      </fieldset>
      <label htmlFor={ids.repo}>Repository path (optional)</label>
      <input
        id={ids.repo}
        value={repositoryPath}
        placeholder={repository.available ? '/path/to/repo' : 'Not available yet'}
        disabled={!repository.available}
        aria-describedby={ids.repoHelp}
        onChange={(event) => {
          setRepositoryPath(event.target.value);
        }}
      />
      <p id={ids.repoHelp} className="hint">
        {repository.available
          ? 'Agents work in this repository one at a time. CommonThread never commits or pushes for you.'
          : `Repository association is off: ${repository.reason ?? 'repository safeguards are not registered.'}`}
      </p>
      <ErrorNotice error={action.error} onRetry={() => void action.retry()} />
      <button type="submit" className="button button-primary" disabled={action.busy || !modeAvailable}>
        {action.busy ? 'Creating…' : 'Create room'}
      </button>
    </form>
  );
}
