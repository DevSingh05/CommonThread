import { useCallback, useSyncExternalStore } from 'react';

const prefix = '#/rooms/';

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
}

function read(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith(prefix)) return null;
  const id = decodeURIComponent(hash.slice(prefix.length));
  return id === '' ? null : id;
}

/** The selected room lives in the URL so a refresh reopens the same room. */
export function useHashRoute() {
  const roomId = useSyncExternalStore(subscribe, read, () => null);
  const select = useCallback((id: string | null) => {
    window.location.hash = id === null ? '' : `${prefix}${encodeURIComponent(id)}`;
  }, []);
  return [roomId, select] as const;
}
