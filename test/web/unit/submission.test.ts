import { describe, expect, it } from 'vitest';
import { SubmissionKeys, stableStringify } from '../../../src/web/api/submission';

function counter() {
  let n = 0;
  return () => `key-${String(++n)}`;
}

describe('SubmissionKeys', () => {
  it('reuses the key when the same payload is retried after a failure', () => {
    const keys = new SubmissionKeys(counter());
    const first = keys.keyFor({ body: 'hi', recipient: 'claude' });
    expect(keys.keyFor({ recipient: 'claude', body: 'hi' })).toBe(first);
  });

  it('issues a new key when the payload changes', () => {
    const keys = new SubmissionKeys(counter());
    const first = keys.keyFor({ body: 'hi' });
    expect(keys.keyFor({ body: 'hi!' })).not.toBe(first);
  });

  it('issues a new key for an identical message after a successful send', () => {
    const keys = new SubmissionKeys(counter());
    const first = keys.keyFor({ body: 'hi' });
    keys.settle();
    expect(keys.keyFor({ body: 'hi' })).not.toBe(first);
  });

  it('fingerprints independent of key order and undefined fields', () => {
    expect(stableStringify({ a: 1, b: undefined, c: { y: 2, x: 1 } })).toBe(stableStringify({ c: { x: 1, y: 2 }, a: 1 }));
  });
});
