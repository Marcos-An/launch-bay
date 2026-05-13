import { useEffect } from 'react';

type MergeConfirmationModalProps = {
  projectName: string;
  sourceBranch: string;
  targetBranch: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function MergeConfirmationModal({
  projectName,
  sourceBranch,
  targetBranch,
  onCancel,
  onConfirm
}: MergeConfirmationModalProps) {
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
      <section className="session-modal merge-modal" role="dialog" aria-modal="true" aria-label="Confirm merge">
        <div className="session-modal-head">
          <div>
            <div className="context">{projectName}</div>
            <h2>Confirm merge</h2>
          </div>
          <button className="terminal-action" type="button" onClick={onCancel} aria-label="Close merge confirmation">Close</button>
        </div>
        <p className="merge-copy">
          You are about to merge <strong>{sourceBranch}</strong> into <strong>{targetBranch}</strong>.
        </p>
        <div className="merge-direction" aria-label="Merge direction">
          <span>{sourceBranch}</span>
          <span aria-hidden="true">→</span>
          <span>{targetBranch}</span>
        </div>
        <p className="merge-warning">
          This runs <code>git merge --no-edit {sourceBranch}</code>. Make sure the target branch is the one you want.
        </p>
        <div className="session-modal-actions">
          <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="button" onClick={onConfirm}>Confirm merge</button>
        </div>
      </section>
    </div>
  );
}
