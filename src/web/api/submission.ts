/**
 * One idempotency key per logical submit.
 *
 * Retrying the same payload after a failure reuses the key, so the engine can
 * de-duplicate a request whose response was lost. Any change to the payload,
 * or a successful send, starts a new logical submit with a fresh key.
 */
export class SubmissionKeys {
  private pending: { fingerprint: string; key: string } | null = null;
  private readonly newKey: () => string;

  constructor(newKey: () => string = () => crypto.randomUUID()) {
    this.newKey = newKey;
  }

  keyFor(payload: unknown): string {
    const fingerprint = stableStringify(payload);
    if (this.pending?.fingerprint !== fingerprint) {
      this.pending = { fingerprint, key: this.newKey() };
    }
    return this.pending.key;
  }

  /** Call once the engine acknowledged the submit. */
  settle(): void {
    this.pending = null;
  }
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .filter((key) => record[key] !== undefined)
          .map((key) => [key, record[key]]),
      );
    }
    return item;
  });
}
