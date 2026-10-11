import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react';

/**
 * Native modal dialog: the browser traps focus; Escape and the close button
 * ask the parent to unmount it. The `close` event is deliberately not used,
 * because closing during effect cleanup would report a close the user never made.
 */
export function Dialog(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { onClose } = props;
  const requestClose = useEffectEvent(() => {
    onClose();
  });

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const handleCancel = (event: Event) => {
      event.preventDefault();
      requestClose();
    };
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      if (dialog.open) dialog.close();
      previous?.focus();
    };
  }, []);

  return (
    <dialog ref={ref} className={props.wide === true ? 'dialog dialog-wide' : 'dialog'} aria-label={props.title}>
      <header className="dialog-header">
        <h2>{props.title}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="dialog-body">{props.children}</div>
    </dialog>
  );
}
