import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileDiff, FileDiffKind, GitFileChange, GitSnapshot } from '../types';

const STATUS_LABELS: Record<GitFileChange['status'], string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  untracked: 'New',
  conflicted: 'Conflict'
};

const STATUS_SHORT: Record<GitFileChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!'
};

const COLLAPSED_SNAPSHOT_REFRESH_MS = 5_000;

const EMPTY_SNAPSHOT: GitSnapshot = {
  cwd: '',
  branch: null,
  headSha: null,
  isDirty: false,
  isMerging: false,
  isRebasing: false,
  isCherryPicking: false,
  files: [],
  conflicts: []
};

function operationLabel(snapshot: GitSnapshot) {
  if (snapshot.isMerging) return 'Merge in progress';
  if (snapshot.isRebasing) return 'Rebase in progress';
  if (snapshot.isCherryPicking) return 'Cherry-pick in progress';
  return snapshot.isDirty ? 'Local changes' : 'Clean worktree';
}

function diffKindFor(file: GitFileChange): FileDiffKind {
  if (file.status === 'untracked') return 'untracked';
  if (file.staged && !file.unstaged) return 'staged';
  return 'worktree';
}

function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line diff-line-meta';
  if (line.startsWith('+')) return 'diff-line diff-line-add';
  if (line.startsWith('-')) return 'diff-line diff-line-remove';
  if (line.startsWith('@@')) return 'diff-line diff-line-hunk';
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
    return 'diff-line diff-line-meta';
  }
  return 'diff-line';
}

function summarize(files: GitFileChange[]) {
  const added = files.filter((file) => file.status === 'added' || file.status === 'untracked').length;
  const modified = files.filter((file) => file.status === 'modified').length;
  const deleted = files.filter((file) => file.status === 'deleted').length;
  const conflicts = files.filter((file) => file.status === 'conflicted').length;
  return { added, modified, deleted, conflicts };
}

type ChangesWorkbenchProps = {
  projectId: string;
  projectName: string;
};

export function ChangesWorkbench({ projectId, projectName }: ChangesWorkbenchProps) {
  const [snapshot, setSnapshot] = useState<GitSnapshot>(EMPTY_SNAPSHOT);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<FileDiff | undefined>(undefined);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  const bridge = window.launchBay;
  const hasGitBridge = Boolean(bridge?.getProjectGitSnapshot && bridge?.getProjectFileDiff);
  const selectedFile = useMemo(
    () => snapshot.files.find((file) => file.path === selectedPath) ?? snapshot.files[0],
    [selectedPath, snapshot.files]
  );
  const summary = useMemo(() => summarize(snapshot.files), [snapshot.files]);
  const branchLabel = snapshot.branch ?? 'No branch';
  const fileCountLabel = `${snapshot.files.length} file${snapshot.files.length === 1 ? '' : 's'}`;

  const applySnapshot = useCallback((nextSnapshot: GitSnapshot) => {
    setSnapshot(nextSnapshot);
    setSelectedPath((current) => {
      if (current && nextSnapshot.files.some((file) => file.path === current)) return current;
      return nextSnapshot.files[0]?.path;
    });
  }, []);

  const refreshSnapshot = useCallback(() => {
    if (!hasGitBridge || !bridge?.getProjectGitSnapshot) return Promise.resolve();
    setLoadingSnapshot(true);
    return bridge.getProjectGitSnapshot(projectId)
      .then(applySnapshot)
      .catch((error) => {
        setSnapshot({ ...EMPTY_SNAPSHOT, error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => setLoadingSnapshot(false));
  }, [applySnapshot, bridge, hasGitBridge, projectId]);

  useEffect(() => {
    if (!hasGitBridge) return undefined;
    let cancelled = false;

    setLoadingSnapshot(true);
    bridge!.getProjectGitSnapshot!(projectId)
      .then((nextSnapshot) => {
        if (!cancelled) applySnapshot(nextSnapshot);
      })
      .catch((error) => {
        if (!cancelled) {
          setSnapshot({ ...EMPTY_SNAPSHOT, error: error instanceof Error ? error.message : String(error) });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSnapshot(false);
      });

    return () => {
      cancelled = true;
    };
  }, [applySnapshot, bridge, hasGitBridge, projectId]);

  useEffect(() => {
    if (!hasGitBridge || !collapsed) return undefined;

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshSnapshot();
      }
    };

    const intervalId = window.setInterval(refreshWhenVisible, COLLAPSED_SNAPSHOT_REFRESH_MS);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [collapsed, hasGitBridge, refreshSnapshot]);

  useEffect(() => {
    if (!hasGitBridge || !selectedFile || collapsed) {
      setDiff(undefined);
      return undefined;
    }
    let cancelled = false;
    setLoadingDiff(true);
    bridge!.getProjectFileDiff!(projectId, selectedFile.path, diffKindFor(selectedFile))
      .then((nextDiff) => {
        if (!cancelled) setDiff(nextDiff);
      })
      .catch((error) => {
        if (!cancelled) {
          setDiff({
            path: selectedFile.path,
            kind: diffKindFor(selectedFile),
            diff: '',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDiff(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, collapsed, hasGitBridge, projectId, selectedFile]);

  if (collapsed) {
    return (
      <aside className="changes-workbench changes-workbench-collapsed" aria-label="Changes workbench">
        <button
          className={`changes-compact-card ${snapshot.conflicts.length > 0 ? 'changes-compact-card-conflict' : ''}`}
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label={`Expand changes workbench for ${branchLabel}`}
        >
          <span className="changes-compact-kicker">Changes</span>
          <span className="changes-compact-main">
            <strong>{branchLabel}</strong>
            <span>{fileCountLabel}</span>
          </span>
          <span className="changes-compact-meta">
            <span>{operationLabel(snapshot)}</span>
            {snapshot.conflicts.length > 0 ? <span>{snapshot.conflicts.length} conflicts</span> : null}
            {typeof snapshot.ahead === 'number' || typeof snapshot.behind === 'number' ? (
              <span>↑{snapshot.ahead ?? 0} ↓{snapshot.behind ?? 0}</span>
            ) : null}
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="changes-workbench" aria-label="Changes workbench">
      <header className="changes-head">
        <div>
          <div className="changes-eyebrow">Workbench</div>
          <h2>Changes</h2>
        </div>
        <div className="changes-head-actions">
          <button
            className="changes-refresh"
            type="button"
            onClick={() => void refreshSnapshot()}
            disabled={!hasGitBridge || loadingSnapshot}
          >
            {loadingSnapshot ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="changes-icon-button"
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Minimize changes workbench"
            title="Minimize changes workbench"
          >
            <span aria-hidden="true">–</span>
          </button>
        </div>
      </header>

      {!hasGitBridge ? (
        <div className="changes-empty" role="status">
          Restart Launch Bay to load the Git workbench bridge.
        </div>
      ) : snapshot.error ? (
        <div className="changes-warning" role="alert">{snapshot.error}</div>
      ) : (
        <>
          <section className={`changes-status ${snapshot.conflicts.length > 0 ? 'changes-status-conflict' : ''}`}>
            <div className="changes-status-main">
              <span>{operationLabel(snapshot)}</span>
              <strong>{branchLabel}</strong>
            </div>
            <div className="changes-status-meta">
              {snapshot.upstream ? <span>{snapshot.upstream}</span> : null}
              {typeof snapshot.ahead === 'number' || typeof snapshot.behind === 'number' ? (
                <span>↑{snapshot.ahead ?? 0} ↓{snapshot.behind ?? 0}</span>
              ) : null}
            </div>
            {snapshot.conflicts.length > 0 ? (
              <div className="changes-conflict-banner" role="alert">
                {snapshot.conflicts.length} conflicted file{snapshot.conflicts.length === 1 ? '' : 's'} need manual review before merge can continue.
              </div>
            ) : null}
          </section>

          <section className="changes-summary" aria-label="Change summary">
            <span><strong>{snapshot.files.length}</strong> files</span>
            <span><strong>{summary.modified}</strong> M</span>
            <span><strong>{summary.added}</strong> A</span>
            <span><strong>{summary.deleted}</strong> D</span>
            {summary.conflicts ? <span className="summary-conflict"><strong>{summary.conflicts}</strong> conflicts</span> : null}
          </section>

          <section className="changes-file-list" aria-label={`${projectName} changed files`}>
            {snapshot.files.length === 0 ? (
              <div className="changes-empty">No local changes yet.</div>
            ) : snapshot.files.map((file) => (
              <button
                className={`change-file ${selectedFile?.path === file.path ? 'active' : ''} change-file-${file.status}`}
                type="button"
                key={`${file.status}:${file.oldPath ?? ''}:${file.path}`}
                onClick={() => setSelectedPath(file.path)}
                aria-label={`${STATUS_LABELS[file.status]} ${file.path}`}
              >
                <span className="change-file-badge">{STATUS_SHORT[file.status]}</span>
                <span className="change-file-copy">
                  <span className="change-file-path">{file.path}</span>
                  {file.oldPath ? <span className="change-file-old">from {file.oldPath}</span> : null}
                </span>
                <span className="change-file-state">{file.staged ? 'staged' : file.unstaged ? 'worktree' : ''}</span>
              </button>
            ))}
          </section>

          <section className="changes-diff" aria-label="Selected file diff">
            <div className="changes-diff-head">
              <div>
                <span className="changes-diff-eyebrow">Diff</span>
                <strong>{selectedFile?.path ?? 'Select a file'}</strong>
              </div>
              {diff ? <span>{diff.kind}</span> : null}
            </div>
            {loadingDiff ? (
              <div className="changes-empty">Loading diff…</div>
            ) : diff?.error ? (
              <div className="changes-warning" role="alert">{diff.error}</div>
            ) : diff?.binary ? (
              <div className="changes-empty">Binary diff preview is not available.</div>
            ) : diff?.diff ? (
              <pre className="diff-code" aria-label={`Diff for ${diff.path}`}>
                {diff.diff.split('\n').map((line, index) => (
                  <span className={diffLineClass(line)} key={`${index}:${line.slice(0, 12)}`}>{line || ' '}</span>
                ))}
              </pre>
            ) : (
              <div className="changes-empty">No diff for this file state.</div>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
