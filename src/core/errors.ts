export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
}

// Provider adapters must supply a safe explanation, never a raw SDK exception containing secrets.
export class SessionResumeError extends AppError {
  constructor(message = 'Provider session could not resume. Explicitly start a fresh session from shared context.') { super('SESSION_RESUME_FAILED', message); }
}
export class BeforeInvocationError extends AppError {
  constructor(message = 'Provider was not invoked; a bounded retry is safe.') { super('BEFORE_INVOCATION', message); }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(code, message);
}
