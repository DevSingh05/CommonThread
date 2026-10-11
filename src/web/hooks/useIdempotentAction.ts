import { useCallback, useState } from 'react';
import { SubmissionKeys } from '../api/submission';

/**
 * Wraps one kind of logical submit. Retrying an unchanged payload after a
 * failure reuses its idempotency key; a changed payload gets a new one.
 */
export function useIdempotentAction<P>(send: (payload: P, idempotencyKey: string) => Promise<void>) {
  const [keys] = useState(() => new SubmissionKeys());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastPayload, setLastPayload] = useState<{ value: P } | null>(null);

  const run = useCallback(
    async (payload: P): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setLastPayload({ value: payload });
      try {
        await send(payload, keys.keyFor(payload));
        keys.settle();
        setLastPayload(null);
        return true;
      } catch (caught) {
        setError(caught);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [keys, send],
  );

  const retry = useCallback(async () => {
    if (lastPayload === null) return false;
    return run(lastPayload.value);
  }, [lastPayload, run]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { run, retry, busy, error, clearError };
}
