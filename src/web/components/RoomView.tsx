import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ArtifactRef, Capabilities, Message } from '../contract';
import { participantLabel } from '../lib/format';
import { useRoom } from '../hooks/useRoom';
import { ArtifactViewer } from './ArtifactViewer';
import { Composer, type ComposerDraft } from './Composer';
import { DetailsPanel } from './DetailsPanel';
import { Dialog } from './Dialog';
import { ErrorNotice } from './ErrorNotice';
import { RoomHeader } from './RoomHeader';
import { SafeMarkdown } from './SafeMarkdown';
import { Thread, type ThreadActions } from './Thread';

export function RoomView(props: {
  roomId: string;
  capabilities: Capabilities;
  onToggleRooms: () => void;
  onRunStatusChange: () => void;
}) {
  const { snapshot, error, connection, streams, refetch } = useRoom(props.roomId);
  const runStatus = snapshot?.run?.status ?? null;
  const { onRunStatusChange } = props;
  useEffect(() => {
    if (runStatus !== null) onRunStatusChange();
  }, [runStatus, onRunStatusChange]);
  const [draft, setDraft] = useState<ComposerDraft>({ body: '', recipient: null, replyTo: null });
  const [focusToken, setFocusToken] = useState(0);
  const [viewing, setViewing] = useState<ArtifactRef | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [outside, setOutside] = useState<{ message: Message } | { error: unknown } | null>(null);

  const changed = useCallback(() => void refetch(), [refetch]);

  const jumpTo = useCallback(
    (messageId: string) => {
      if (snapshot?.messages.some((m) => m.id === messageId) === true) {
        setHighlightId(messageId);
        setDetailsOpen(false);
        return;
      }
      api.message(props.roomId, messageId).then(
        (message) => {
          setOutside({ message });
        },
        (caught: unknown) => {
          setOutside({ error: caught });
        },
      );
    },
    [snapshot, props.roomId],
  );

  const actions: ThreadActions = {
    onReply: (message) => {
      setDraft((current) => ({ ...current, replyTo: message }));
      setFocusToken((n) => n + 1);
    },
    onAnswer: (question, option) => {
      setDraft((current) => ({ body: option ?? current.body, recipient: null, replyTo: question }));
      setFocusToken((n) => n + 1);
      setDetailsOpen(false);
    },
    onOpenArtifact: setViewing,
    onJumpTo: jumpTo,
  };

  if (snapshot === null) {
    return (
      <main className="room room-loading">
        {error === null ? <p className="muted">Loading room…</p> : <ErrorNotice error={error} onRetry={changed} />}
      </main>
    );
  }

  return (
    <div className={detailsOpen ? 'room-layout details-open' : 'room-layout'}>
      <main className="room" aria-label={`Room ${snapshot.room.title}`}>
        <RoomHeader
          snapshot={snapshot}
          connection={connection}
          onChanged={changed}
          onToggleRooms={props.onToggleRooms}
          onToggleDetails={() => {
            setDetailsOpen((open) => !open);
          }}
        />
        {error !== null && <ErrorNotice error={error} onRetry={changed} />}
        <Thread snapshot={snapshot} streams={streams} highlightId={highlightId} actions={actions} />
        <Composer
          snapshot={snapshot}
          draft={draft}
          onDraftChange={setDraft}
          onSent={changed}
          focusToken={focusToken}
        />
      </main>
      <DetailsPanel
        snapshot={snapshot}
        capabilities={props.capabilities}
        onChanged={changed}
        onOpenArtifact={setViewing}
        onJumpTo={jumpTo}
        onAnswer={(question) => {
          actions.onAnswer(question);
        }}
      />
      {viewing !== null && (
        <ArtifactViewer
          snapshot={snapshot}
          artifactRef={viewing}
          onSelect={setViewing}
          onClose={() => {
            setViewing(null);
          }}
        />
      )}
      {outside !== null && (
        <Dialog
          title="Referenced message"
          onClose={() => {
            setOutside(null);
          }}
        >
          {'error' in outside ? (
            <ErrorNotice error={outside.error} />
          ) : (
            <>
              <p className="muted">
                {participantLabel[outside.message.author]} #{outside.message.seq}
              </p>
              <SafeMarkdown text={outside.message.body} />
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}
