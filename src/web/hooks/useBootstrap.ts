import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Bootstrap } from '../contract';

export type BootstrapState =
  | { status: 'loading' }
  | { status: 'ready'; bootstrap: Bootstrap }
  | { status: 'error'; error: unknown };

export function useBootstrap() {
  const [state, setState] = useState<BootstrapState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.bootstrap().then(
      (bootstrap) => {
        if (!cancelled) setState({ status: 'ready', bootstrap });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return { state, retry };
}
