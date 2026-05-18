import { useEffect } from 'react';
import type { GitBranchInfo, GitMergePreview } from '../types';

function formatDivergence(branch?: GitBranchInfo) {
  if (!branch) return undefined;
  const parts: string[] = [];
  if (branch.ahead) parts.push(`ahead ${branch.ahead}`);
  if (branch.behind) parts.push(`behind ${branch.behind}`);
  return parts.length ? parts.join(' · ') : 'up to date';
}

type MergeConfirmationModalProps = {
  projectName: string;
  sourceBranch: string;
  targetBranch: string;
  repoCwd: string;
  sourceBranchInfo?: GitBranchInfo;
  targetBranchInfo?: GitBranchInfo;
  preview?: GitMergePreview;
  previewStatus: 'idle' | 'loading' | 'ready' | 'error';
  previewError?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function MergeConfirmationModal({
  projectName,
  sourceBranch,
  targetBranch,
  repoCwd,
  sourceBranchInfo,
  targetBranchInfo,
  preview,
  previewStatus,
  previewError,
  onCancel,
  onConfirm
}: MergeConfirmationModalProps) {
  const sourceDivergence = formatDivergence(sourceBranchInfo);
  const targetDivergence = formatDivergence(targetBranchInfo);
  const blockers = preview?.blockers ?? (previewError ? [previewError] : []);
  const hasWorktreeBlocker = blockers.some((blocker) => /commit or stash|worktree/i.test(blocker));
  const hasServerBlocker = blockers.some((blocker) => /stop the server/i.test(blocker));
  const canConfirm = previewStatus !== 'loading' && preview?.canMerge !== false;
  const commitCount = preview?.commits.length ?? 0;
  const fileCount = preview?.files.length ?? 0;

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
      <section className="session-modal merge-modal" role="dialog" aria-modal="true" aria-label="Review branch merge">
        <div className="session-modal-head">
          <div>
            <div className="context">{projectName}</div>
            <h2>Review branch merge</h2>
          </div>
          <button className="terminal-action" type="button" onClick={onCancel} aria-label="Close merge confirmation">Close</button>
        </div>
        <p className="merge-copy">
          You will stay on <strong>{targetBranch}</strong>. Launch Bay will merge <strong>{sourceBranch}</strong> into it.
        </p>
        <div className="merge-repo">
          <span>Repository</span>
          <strong>{repoCwd}</strong>
        </div>
        <div className="merge-direction" aria-label="Merge direction">
          <div className="merge-branch-card">
            <span>Source branch</span>
            <strong>{sourceBranch}</strong>
            {sourceBranchInfo?.upstream ? <small>{sourceBranchInfo.upstream}</small> : null}
            {sourceDivergence ? <small>{sourceDivergence}</small> : null}
            {sourceBranchInfo?.lastCommit ? <small>{sourceBranchInfo.lastCommit}</small> : null}
          </div>
          <span aria-hidden="true">→</span>
          <div className="merge-branch-card merge-branch-card-target">
            <span>Current target branch</span>
            <strong>{targetBranch}</strong>
            {targetBranchInfo?.upstream ? <small>{targetBranchInfo.upstream}</small> : null}
            {targetDivergence ? <small>{targetDivergence}</small> : null}
            {targetBranchInfo?.lastCommit ? <small>{targetBranchInfo.lastCommit}</small> : null}
          </div>
        </div>
        <div className="merge-preflight" aria-label="Merge preflight checks">
          <h3>Preflight checks</h3>
          <ul>
            <li className={hasWorktreeBlocker ? 'is-blocked' : 'is-ok'}>
              {hasWorktreeBlocker ? 'Worktree has uncommitted changes' : 'Worktree clean'}
            </li>
            <li className={hasServerBlocker ? 'is-blocked' : 'is-ok'}>
              {hasServerBlocker ? 'Server running' : 'Server stopped'}
            </li>
            <li className={previewStatus === 'error' ? 'is-blocked' : 'is-ok'}>
              {previewStatus === 'loading' ? 'Loading merge preview…' : previewStatus === 'error' ? 'Preview unavailable' : 'Preview ready'}
            </li>
          </ul>
          {blockers.length > 0 ? (
            <div className="merge-blockers" role="status">
              {blockers.map((blocker) => <p key={blocker}>{blocker}</p>)}
            </div>
          ) : null}
        </div>
        <div className="merge-preview" aria-label="Merge preview">
          <div className="merge-preview-head">
            <h3>Merge preview</h3>
            <span>{commitCount} {commitCount === 1 ? 'commit' : 'commits'}</span>
            <span>{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
          </div>
          {previewStatus === 'loading' ? <p className="merge-preview-empty">Calculating commits and files…</p> : null}
          {previewStatus !== 'loading' && preview?.commits.length ? (
            <ul className="merge-preview-list">
              {preview.commits.slice(0, 5).map((commit) => (
                <li key={`${commit.sha}-${commit.subject}`}>
                  <code>{commit.sha}</code>
                  <span>{commit.subject}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {previewStatus !== 'loading' && preview?.files.length ? (
            <ul className="merge-preview-list merge-preview-files">
              {preview.files.slice(0, 8).map((file) => (
                <li key={`${file.status}-${file.path}`}>
                  <code>{file.status}</code>
                  <span>{file.path}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {previewStatus !== 'loading' && preview && preview.commits.length === 0 && preview.files.length === 0 ? (
            <p className="merge-preview-empty">No unique commits or file changes were found for this source branch.</p>
          ) : null}
        </div>
        <p className="merge-warning">
          This runs <code>{`git merge --no-edit ${sourceBranch}`}</code>. If Git reports conflicts, resolve them in the Changes Workbench or terminal before continuing.
        </p>
        <div className="session-modal-actions">
          <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="button" onClick={onConfirm} disabled={!canConfirm}>Merge {sourceBranch} into {targetBranch}</button>
        </div>
      </section>
    </div>
  );
}
