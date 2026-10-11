import { ApiErrorBody } from '../contract';

/** An HTTP or transport failure, carrying enough detail to explain it plainly. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly serverMessage: string;

  constructor(status: number, code: string, serverMessage: string) {
    super(`${status === 0 ? 'network' : String(status)} ${code}: ${serverMessage}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    let code = response.statusText || 'error';
    let message = '';
    try {
      const parsed = ApiErrorBody.safeParse(await response.json());
      if (parsed.success) {
        code = parsed.data.error.code;
        message = parsed.data.error.message;
      }
    } catch {
      // Non-JSON error body: keep the status text.
    }
    return new ApiError(response.status, code, message);
  }

  static network(cause: unknown): ApiError {
    const detail = cause instanceof Error ? cause.message : 'request failed';
    return new ApiError(0, 'network_error', detail);
  }

  static invalidResponse(path: string, issue: string): ApiError {
    return new ApiError(-1, 'invalid_response', `Unexpected response from ${path}: ${issue}`);
  }

  /** True when the same request may be retried with the same idempotency key. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }

  get tokenRejected(): boolean {
    return this.status === 401 || (this.status === 403 && /token/i.test(this.code + this.serverMessage));
  }
}

/** A sentence a person can act on, keeping the HTTP code visible for bug reports. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : 'Something went wrong.';
  }
  const detail = error.serverMessage ? ` ${error.serverMessage}` : '';
  switch (true) {
    case error.status === 0:
      return 'Cannot reach the local CommonThread engine. Check that the server is running, then retry.';
    case error.status === -1:
      return `The engine sent data this UI does not understand (${error.serverMessage}).`;
    case error.status === 400:
      return `HTTP 400 — the engine rejected the request (${error.code}).${detail}`;
    case error.tokenRejected:
      return `HTTP ${error.status} — the local security token was rejected. Reload the page to get a new one.`;
    case error.status === 403:
      return `HTTP 403 — the engine refused this request (${error.code}).${detail}`;
    case error.status === 404:
      return `HTTP 404 — not found (${error.code}).${detail}`;
    case error.status === 409:
      return `HTTP 409 — conflict (${error.code}).${detail}`;
    case error.status === 413:
      return `HTTP 413 — that input is larger than the engine accepts.${detail}`;
    case error.status === 422:
      return `HTTP 422 — the engine could not accept this input (${error.code}).${detail}`;
    case error.status === 429:
      return `HTTP 429 — too many requests. Wait a moment and retry.${detail}`;
    case error.status >= 500:
      return `HTTP ${error.status} — the engine failed (${error.code}). Retrying sends the same request again.${detail}`;
    default:
      return `HTTP ${error.status} (${error.code}).${detail}`;
  }
}
