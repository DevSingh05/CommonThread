import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { RoomSnapshot, SnapshotEvent, StreamEvent, type AgentId } from '../contract';

export type Connection = 'connecting' | 'live' | 'reconnecting';

export interface ProvisionalStream {
  turnId: string;
  agent: AgentId;
  text: string;
  tools: string[];
}

const maxStreamChars = 20_000;
const maxToolLines = 20;
/** Durable correctness never depends on SSE: poll while disconnected... */
const fallbackPollMs = 10_000;
/** ...and occasionally while "connected", since a proxy can hold a dead stream open. */
const livePollMs = 30_000;
const reconnectDelayMs = 2_000;

/**
 * Live view of one room. The server snapshot is the only state; SSE `snapshot`
 * events only trigger a refetch, and `stream` events feed a separate,
 * provisional buffer that is never merged into messages.
 */
export function useRoom(roomId: string | null) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [streams, setStreams] = useState<Record<string, ProvisionalStream>>({});

  const inFlight = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const currentRoom = useRef(roomId);

  const refetch = useCallback(async (): Promise<void> => {
    const id = currentRoom.current;
    if (id === null) return;
    if (inFlight.current !== null) {
      dirty.current = true;
      return inFlight.current;
    }
    const again = () => dirty.current && currentRoom.current === id;
    const load = (async () => {
      do {
        dirty.current = false;
        try {
          const next = await api.snapshot(id);
          if (currentRoom.current !== id) return;
          setSnapshot(next);
          setError(null);
          const stopped = next.run?.status === 'cancelled' || next.run?.status === 'interrupted';
          const running = new Set(stopped ? [] : next.turns.filter((t) => t.status === 'running').map((t) => t.id));
          setStreams((previous) => {
            const kept = Object.entries(previous).filter(([turnId]) => running.has(turnId));
            return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept);
          });
        } catch (caught) {
          if (currentRoom.current === id) setError(caught);
        }
      } while (again());
    })();
    inFlight.current = load;
    try {
      await load;
    } finally {
      inFlight.current = null;
    }
  }, []);

  // Callers key the owning component by room, so state starts fresh per room.
  useEffect(() => {
    currentRoom.current = roomId;
    if (roomId === null) return;

    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const onSnapshot = (event: MessageEvent<string>) => {
      const parsed = SnapshotEvent.safeParse(safeJson(event.data));
      if (!parsed.success || parsed.data.roomId === roomId) void refetch();
    };
    const onStream = (event: MessageEvent<string>) => {
      const parsed = StreamEvent.safeParse(safeJson(event.data));
      if (!parsed.success) return;
      const chunk = parsed.data;
      setStreams((previous) => {
        const current = previous[chunk.turnId] ?? { turnId: chunk.turnId, agent: chunk.agent, text: '', tools: [] };
        const next =
          chunk.kind === 'tool'
            ? { ...current, tools: [...current.tools, chunk.text].slice(-maxToolLines) }
            : { ...current, text: (current.text + chunk.text).slice(-maxStreamChars) };
        return { ...previous, [chunk.turnId]: next };
      });
    };

    const open = () => {
      if (closed) return;
      source = new EventSource(api.eventsUrl(roomId));
      source.addEventListener('open', () => {
        setConnection('live');
        // Anything committed while disconnected is recovered from the snapshot.
        void refetch();
      });
      source.addEventListener('snapshot', onSnapshot);
      source.addEventListener('stream', onStream);
      source.addEventListener('error', () => {
        setConnection('reconnecting');
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          reconnectTimer = setTimeout(open, reconnectDelayMs);
        }
      });
    };

    void refetch();
    open();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    const onOnline = () => {
      void refetch();
      if (source?.readyState === EventSource.CLOSED) {
        clearTimeout(reconnectTimer);
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      source?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [roomId, refetch]);

  useEffect(() => {
    if (roomId === null) return;
    const timer = setInterval(() => void refetch(), connection === 'live' ? livePollMs : fallbackPollMs);
    return () => {
      clearInterval(timer);
    };
  }, [roomId, connection, refetch]);

  return { snapshot, error, connection, streams, refetch };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
