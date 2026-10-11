import { useCallback, useState } from 'react';
import { ErrorNotice } from './components/ErrorNotice';
import { RoomView } from './components/RoomView';
import { Sidebar } from './components/Sidebar';
import { useBootstrap } from './hooks/useBootstrap';
import { useHashRoute } from './hooks/useHashRoute';
import { useRooms } from './hooks/useRooms';

export function App() {
  const { state, retry } = useBootstrap();
  const ready = state.status === 'ready';
  const rooms = useRooms(ready);
  const [roomId, selectRoom] = useHashRoute();
  const [roomsOpen, setRoomsOpen] = useState(false);
  const { refresh: refreshRooms } = rooms;
  const onRunStatusChange = useCallback(() => void refreshRooms(), [refreshRooms]);

  if (state.status === 'loading') {
    return (
      <div className="splash" role="status">
        Connecting to the local CommonThread engine…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="splash">
        <h1>CommonThread</h1>
        <ErrorNotice error={state.error} onRetry={retry} />
        <p className="muted">
          The UI talks only to the engine on this machine. Start it with <code>npm start</code>, or run{' '}
          <code>npm run dev:web</code> next to a running engine.
        </p>
      </div>
    );
  }

  const { capabilities } = state.bootstrap;
  const select = (id: string) => {
    selectRoom(id);
    setRoomsOpen(false);
  };

  return (
    <div className={roomsOpen ? 'app rooms-open' : 'app'}>
      <Sidebar
        rooms={rooms.rooms}
        roomsError={rooms.error}
        roomsLoaded={rooms.loaded}
        selectedRoomId={roomId}
        capabilities={capabilities}
        onSelect={select}
        onCreated={(id) => {
          void rooms.refresh();
          select(id);
        }}
        onRetryRooms={() => void rooms.refresh()}
      />
      {roomId === null ? (
        <main className="room room-empty">
          <button
            type="button"
            className="icon-button narrow-only"
            aria-label="Show rooms"
            onClick={() => {
              setRoomsOpen(true);
            }}
          >
            ☰
          </button>
          <h1>Shared room</h1>
          <p>
            One thread for you, Claude and Codex. Plain messages add context; addressing an agent queues work; you can
            pause or stop at any time.
          </p>
          <p className="muted">Select or create a room to begin.</p>
        </main>
      ) : (
        <RoomView
          key={roomId}
          roomId={roomId}
          capabilities={capabilities}
          onRunStatusChange={onRunStatusChange}
          onToggleRooms={() => {
            setRoomsOpen((open) => !open);
          }}
        />
      )}
      {roomsOpen && (
        <button
          type="button"
          className="scrim"
          aria-label="Close rooms"
          onClick={() => {
            setRoomsOpen(false);
          }}
        />
      )}
    </div>
  );
}
