import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ArtifactRef, ArtifactVersion, RoomSnapshot } from '../contract';
import { lineDiff } from '../lib/diff';
import { formatDateTime, participantLabel } from '../lib/format';
import { latestVersion, reviewsFor } from '../lib/room-view';
import { Dialog } from './Dialog';
import { ErrorNotice } from './ErrorNotice';
import { SimulatedTag } from './Participant';

type View = 'content' | 'changes' | 'reviews';

type Loaded = { status: 'loading' } | { status: 'ready'; artifact: ArtifactVersion } | { status: 'error'; error: unknown };

/** Fetches one exact artifact version; never resolves a floating "latest". */
function useArtifactVersion(roomId: string, ref: ArtifactRef | null, attempt: number) {
  const [state, setState] = useState<{ key: string; loaded: Loaded } | null>(null);
  const artifactId = ref?.artifactId ?? null;
  const version = ref?.version ?? null;
  const key = artifactId === null || version === null ? null : `${artifactId}@${String(version)}#${String(attempt)}`;

  useEffect(() => {
    if (artifactId === null || version === null || key === null) return;
    let cancelled = false;
    api.artifact(roomId, artifactId, version).then(
      (artifact) => {
        if (!cancelled) setState({ key, loaded: { status: 'ready', artifact } });
      },
      (error: unknown) => {
        if (!cancelled) setState({ key, loaded: { status: 'error', error } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [roomId, artifactId, version, key]);

  if (key === null) return null;
  return state?.key === key ? state.loaded : ({ status: 'loading' } as const);
}

export function ArtifactViewer(props: {
  snapshot: RoomSnapshot;
  artifactRef: ArtifactRef;
  onSelect: (ref: ArtifactRef) => void;
  onClose: () => void;
}) {
  const { snapshot, artifactRef, onSelect } = props;
  const roomId = snapshot.room.id;
  const [view, setView] = useState<View>('content');
  const [attempt, setAttempt] = useState(0);
  const versions = snapshot.artifacts
    .filter((a) => a.artifactId === artifactRef.artifactId)
    .sort((a, b) => a.version - b.version);
  const latest = latestVersion(snapshot.artifacts, artifactRef.artifactId);
  const previousRef = artifactRef.version > 1 ? { artifactId: artifactRef.artifactId, version: artifactRef.version - 1 } : null;

  const current = useArtifactVersion(roomId, artifactRef, attempt);
  const previous = useArtifactVersion(roomId, view === 'changes' ? previousRef : null, attempt);
  const reviews = reviewsFor(snapshot.reviews, artifactRef);
  const title = current?.status === 'ready' ? current.artifact.title : (versions[0]?.title ?? 'Artifact');

  return (
    <Dialog title={`${title} · v${artifactRef.version}`} onClose={props.onClose} wide>
      <div className="artifact-toolbar">
        <div role="group" aria-label="Versions" className="version-list">
          {versions.map((version) => (
            <button
              key={version.version}
              type="button"
              aria-pressed={version.version === artifactRef.version}
              className={version.version === artifactRef.version ? 'version version-selected' : 'version'}
              onClick={() => {
                onSelect({ artifactId: version.artifactId, version: version.version });
              }}
            >
              v{version.version}
            </button>
          ))}
        </div>
        <div role="tablist" aria-label="Artifact view" className="tabs">
          {(['content', 'changes', 'reviews'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              className={view === tab ? 'tab tab-active' : 'tab'}
              onClick={() => {
                setView(tab);
              }}
            >
              {tab === 'content' ? 'Content' : tab === 'changes' ? 'Changes' : `Reviews (${reviews.length})`}
            </button>
          ))}
        </div>
      </div>

      {latest !== null && latest > artifactRef.version && (
        <p className="stale-banner" role="note" data-testid="stale-banner">
          You are viewing v{artifactRef.version}, which has been superseded by v{latest}. Reviews below apply to v
          {artifactRef.version} only.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onSelect({ artifactId: artifactRef.artifactId, version: latest });
            }}
          >
            Open v{latest}
          </button>
        </p>
      )}

      {current?.status === 'loading' && <p className="muted">Loading v{artifactRef.version}…</p>}
      {current?.status === 'error' && (
        <ErrorNotice
          error={current.error}
          onRetry={() => {
            setAttempt((n) => n + 1);
          }}
        />
      )}
      {current?.status === 'ready' && (
        <>
          <p className="muted artifact-meta">
            {participantLabel[current.artifact.author]} · {formatDateTime(current.artifact.createdAt)}{' '}
            {snapshot.room.mode === 'demo' && current.artifact.author !== 'human' && <SimulatedTag />}
          </p>
          {view === 'content' && (
            <pre className="artifact-content" data-testid="artifact-content">
              {current.artifact.content ?? ''}
            </pre>
          )}
          {view === 'changes' &&
            (previousRef === null ? (
              <p className="muted">v1 is the first version; there is nothing to compare.</p>
            ) : previous?.status === 'ready' ? (
              <DiffView before={previous.artifact.content ?? ''} after={current.artifact.content ?? ''} from={previousRef.version} to={artifactRef.version} />
            ) : previous?.status === 'error' ? (
              <ErrorNotice error={previous.error} />
            ) : (
              <p className="muted">Loading v{previousRef.version}…</p>
            ))}
          {view === 'reviews' && <Reviews reviews={reviews} />}
        </>
      )}
    </Dialog>
  );
}

function DiffView(props: { before: string; after: string; from: number; to: number }) {
  const diff = lineDiff(props.before, props.after);
  if (diff === null) return <p className="muted">These versions are too large to diff in the browser.</p>;
  return (
    <div>
      <p className="muted">
        Changes from v{props.from} to v{props.to}
      </p>
      <pre className="diff" data-testid="artifact-diff">
        {diff.map((line, index) => (
          <span key={index} className={`diff-line diff-${line.op}`}>
            {line.op === 'add' ? '+ ' : line.op === 'remove' ? '- ' : '  '}
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

function Reviews({ reviews }: { reviews: ReturnType<typeof reviewsFor> }) {
  if (reviews.length === 0) return <p className="muted">No reviews pinned to this version.</p>;
  return (
    <ul className="reviews">
      {reviews.map((review) => (
        <li key={review.id} className="review">
          <p>
            <strong>{participantLabel[review.author]}</strong> reviewed v{review.artifactRef.version}: {review.summary}
          </p>
          {review.findings.length === 0 ? (
            <p className="muted">No findings.</p>
          ) : (
            <ul>
              {review.findings.map((finding) => (
                <li key={finding.id} className={`finding severity-${finding.severity}`}>
                  <span className="severity">{finding.severity}</span>
                  {finding.file !== null && finding.file !== undefined && (
                    <code>
                      {finding.file}
                      {finding.line !== null && finding.line !== undefined && `:${finding.line}`}
                    </code>
                  )}{' '}
                  {finding.explanation}
                  {finding.evidence !== null && finding.evidence !== undefined && (
                    <div className="muted">Evidence: {finding.evidence}</div>
                  )}
                  {finding.suggestedNextAction !== null && finding.suggestedNextAction !== undefined && (
                    <div className="muted">Next: {finding.suggestedNextAction}</div>
                  )}
                  {finding.resolved && <span className="tag">resolved</span>}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
