import { useEffect } from 'react';

type ConfirmModalProps = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmModal({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onCancel,
  onConfirm
}: ConfirmModalProps) {
  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      onCancel();
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="session-modal confirm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="session-modal-head">
          <div>
            <h2>{title}</h2>
          </div>
          <button className="terminal-action" type="button" onClick={onCancel} aria-label="Close confirmation">Close</button>
        </div>
        {description ? <p className="confirm-copy">{description}</p> : null}
        <div className="session-modal-actions">
          <button className="secondary" type="button" onClick={onCancel}>{cancelLabel}</button>
          <button
            className={destructive ? 'primary destructive' : 'primary'}
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
