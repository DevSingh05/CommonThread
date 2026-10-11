import { describeError } from '../api/errors';

export function ErrorNotice(props: { error: unknown; onRetry?: () => void; onDismiss?: () => void }) {
  if (props.error === null || props.error === undefined) return null;
  return (
    <div className="error-notice" role="alert">
      <span>{describeError(props.error)}</span>
      <span className="error-actions">
        {props.onRetry !== undefined && (
          <button type="button" className="link-button" onClick={props.onRetry}>
            Retry
          </button>
        )}
        {props.onDismiss !== undefined && (
          <button type="button" className="link-button" onClick={props.onDismiss}>
            Dismiss
          </button>
        )}
      </span>
    </div>
  );
}
