import { describe, expect, it } from 'vitest';
import { ApiError, describeError } from '../../../src/web/api/errors';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('API errors', () => {
  it('keeps the HTTP status and engine code in the message', async () => {
    const error = await ApiError.fromResponse(json(409, { error: { code: 'stale_version', message: 'Base is v1, current is v2.' } }));
    expect(describeError(error)).toBe('HTTP 409 — conflict (stale_version). Base is v1, current is v2.');
    expect(error.retryable).toBe(false);
  });

  it('explains token rejection and network failure plainly', async () => {
    const token = await ApiError.fromResponse(json(403, { error: { code: 'invalid_token', message: 'bad' } }));
    expect(token.tokenRejected).toBe(true);
    expect(describeError(token)).toContain('Reload the page');
    const network = ApiError.network(new TypeError('Failed to fetch'));
    expect(network.retryable).toBe(true);
    expect(describeError(network)).toContain('Cannot reach the local CommonThread engine');
  });

  it('tolerates non-JSON error bodies', async () => {
    const error = await ApiError.fromResponse(new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' }));
    expect(error.code).toBe('Bad Gateway');
    expect(error.retryable).toBe(true);
  });
});
