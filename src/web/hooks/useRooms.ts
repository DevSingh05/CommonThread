import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { RoomSummary } from '../contract';

export function useRooms(enabled: boolean) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRooms(await api.listRooms());
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.listRooms().then(
      (list) => {
        if (cancelled) return;
        setRooms(list);
        setError(null);
        setLoaded(true);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setError(caught);
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { rooms, error, loaded, refresh };
}
