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

const FILE_GROUPS: Array<{
  key: string;
  label: string;
  statuses: GitFileChange['status'][];
}> = [
  { key: 'conflicted', label: 'Conflicted', statuses: ['conflicted'] },
  { key: 'modified', label: 'Modified', statuses: ['modified', 'renamed', 'copied'] },
  { key: 'new', label: 'New', statuses: ['added', 'untracked'] },
  { key: 'deleted', label: 'Deleted', statuses: ['deleted'] }
];

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
  ariaLabel?: string;
  hideCollapsed?: boolean;
  initialCollapsed?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

export function ChangesWorkbench({
  projectId,
  projectName,
  ariaLabel = 'Changes workbench',
  hideCollapsed = false,
  initialCollapsed = true,
  onExpandedChange
}: ChangesWorkbenchProps) {
  const [snapshot, setSnapshot] = useState<GitSnapshot>(EMPTY_SNAPSHOT);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<FileDiff | undefined>(undefined);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTabs, setReviewTabs] = useState<string[]>([]);
  const [activeReviewPath, setActiveReviewPath] = useState<string | undefined>(undefined);
  const [reviewDiffs, setReviewDiffs] = useState<Record<string, FileDiff | undefined>>({});
  const [loadingReviewDiffs, setLoadingReviewDiffs] = useState<Record<string, boolean>>({});
  const [copyDiffState, setCopyDiffState] = useState<'idle' | 'copied'>('idle');

  const bridge = window.launchBay;
  const hasGitBridge = Boolean(bridge?.getProjectGitSnapshot && bridge?.getProjectFileDiff);
  const selectedFile = useMemo(
    () => snapshot.files.find((file) => file.path === selectedPath) ?? snapshot.files[0],
    [selectedPath, snapshot.files]
  );
  const activeReviewFile = useMemo(
    () => snapshot.files.find((file) => file.path === activeReviewPath),
    [activeReviewPath, snapshot.files]
  );
  const activeReviewDiff = activeReviewPath ? reviewDiffs[activeReviewPath] : undefined;
  const activeReviewLoading = activeReviewPath ? Boolean(loadingReviewDiffs[activeReviewPath]) : false;
  const summary = useMemo(() => summarize(snapshot.files), [snapshot.files]);
  const groupedFiles = useMemo(
    () => FILE_GROUPS.map((group) => ({
      ...group,
      files: snapshot.files.filter((file) => group.statuses.includes(file.status))
    })).filter((group) => group.files.length > 0),
    [snapshot.files]
  );
  const branchLabel = snapshot.branch ?? 'No branch';
  const fileCountLabel = `${snapshot.files.length} file${snapshot.files.length === 1 ? '' : 's'}`;

  useEffect(() => {
    setCollapsed(initialCollapsed);
  }, [initialCollapsed, projectId]);

  const applySnapshot = useCallback((nextSnapshot: GitSnapshot) => {
    setSnapshot(nextSnapshot);
    setSelectedPath((current) => {
      if (current && nextSnapshot.files.some((file) => file.path === current)) return current;
      return nextSnapshot.files[0]?.path;
    });
  }, []);

  const setWorkbenchCollapsed = useCallback((nextCollapsed: boolean) => {
    setCollapsed(nextCollapsed);
    onExpandedChange?.(!nextCollapsed);
  }, [onExpandedChange]);

  const selectInlineFile = useCallback((file: GitFileChange) => {
    setSelectedPath(file.path);
    setCopyDiffState('idle');
  }, []);

  const copySelectedDiff = useCallback(async () => {
    if (!diff?.diff || !window.navigator.clipboard?.writeText) return;
    try {
      await window.navigator.clipboard.writeText(diff.diff);
      setCopyDiffState('copied');
    } catch {
      setCopyDiffState('idle');
    }
  }, [diff]);

  const openReview = useCallback(() => {
    const path = selectedFile?.path ?? snapshot.files[0]?.path;
    if (!path) return;
    setReviewTabs((current) => current.includes(path) ? current : [...current, path]);
    setActiveReviewPath(path);
    setReviewOpen(true);
  }, [selectedFile, snapshot.files]);

  const openReviewFile = useCallback((file: GitFileChange) => {
    setReviewTabs((current) => current.includes(file.path) ? current : [...current, file.path]);
    setActiveReviewPath(file.path);
    setReviewOpen(true);
  }, []);

  const closeReviewTab = useCallback((path: string) => {
    setReviewTabs((current) => {
      const next = current.filter((tabPath) => tabPath !== path);
      setActiveReviewPath((activePath) => {
        if (activePath !== path) return activePath;
        const closedIndex = current.indexOf(path);
        return next[closedIndex] ?? next[closedIndex - 1] ?? next[0];
      });
      if (next.length === 0) setReviewOpen(false);
      return next;
    });
  }, []);

  const closeReview = useCallback(() => {
    setReviewOpen(false);
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
    if (copyDiffState !== 'copied') return undefined;
    const timeoutId = window.setTimeout(() => setCopyDiffState('idle'), 1500);
    return () => window.clearTimeout(timeoutId);
  }, [copyDiffState]);

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
        if (!cancelled) {
          setDiff(nextDiff);
          setCopyDiffState('idle');
        }
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

  useEffect(() => {
    if (!hasGitBridge || !reviewOpen || !activeReviewFile) return undefined;

    let cancelled = false;
    const path = activeReviewFile.path;
    const kind = diffKindFor(activeReviewFile);
    setLoadingReviewDiffs((current) => ({ ...current, [path]: true }));

    bridge!.getProjectFileDiff!(projectId, path, kind)
      .then((nextDiff) => {
        if (!cancelled) {
          setReviewDiffs((current) => ({ ...current, [path]: nextDiff }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setReviewDiffs((current) => ({
            ...current,
            [path]: {
              path,
              kind,
              diff: '',
              error: error instanceof Error ? error.message : String(error)
            }
          }));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingReviewDiffs((current) => ({ ...current, [path]: false }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeReviewFile, bridge, hasGitBridge, projectId, reviewOpen]);

  if (collapsed) {
    if (hideCollapsed) return null;

    return (
      <aside className="changes-workbench changes-workbench-collapsed" aria-label={ariaLabel}>
        <button
          className={`changes-compact-card ${snapshot.conflicts.length > 0 ? 'changes-compact-card-conflict' : ''}`}
          type="button"
          onClick={() => setWorkbenchCollapsed(false)}
          aria-label={`Expand changes workbench for ${branchLabel}`}
        >
          <span className="changes-compact-kicker">Changes · {projectName}</span>
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
    <>
      <aside className="changes-workbench" aria-label={ariaLabel}>
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
            onClick={() => setWorkbenchCollapsed(true)}
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
                {snapshot.conflicts.length} conflicted file{snapshot.conflicts.length === 1 ? '' : 's'} need manual review before merge can continue. Run your normal conflict resolution commands, then refresh this workbench.
              </div>
            ) : null}
          </section>

          <section className="changes-summary" aria-label="Change summary">
            <span><strong>{snapshot.files.length}</strong> files</span>
            <span><strong>{summary.modified}</strong> M</span>
            <span><strong>{summary.added}</strong> A</span>
            <span><strong>{summary.deleted}</strong> D</span>
            {summary.conflicts ? <span className="summary-conflict"><strong>{summary.conflicts}</strong> conflicts</span> : null}
            <button
              className="changes-summary-action"
              type="button"
              onClick={openReview}
              disabled={snapshot.files.length === 0}
            >
              Ver todos os arquivos
            </button>
          </section>

          <section className="changes-file-list" aria-label={`${projectName} changed files`}>
            {snapshot.files.length === 0 ? (
              <div className="changes-empty" role="status">
                No local changes in {projectName}. This worktree is clean.
              </div>
            ) : groupedFiles.map((group) => (
              <section
                className="changes-file-group"
                role="group"
                aria-label={`${group.label} changes`}
                key={group.key}
              >
                <div className="changes-file-group-head">
                  <span>{group.label}</span>
                  <span>{group.files.length}</span>
                </div>
                {group.files.map((file) => (
                  <button
                    className={`change-file ${selectedFile?.path === file.path ? 'active' : ''} change-file-${file.status}`}
                    type="button"
                    key={`${file.status}:${file.oldPath ?? ''}:${file.path}`}
                    onClick={() => selectInlineFile(file)}
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
            ))}
          </section>

          <section className="changes-diff" aria-label="Selected file diff">
            <div className="changes-diff-head">
              <div>
                <span className="changes-diff-eyebrow">Diff</span>
                <strong>{selectedFile?.path ?? 'Select a file'}</strong>
              </div>
              <div className="changes-diff-actions">
                {diff ? <span>{diff.kind}</span> : null}
                <button
                  className="changes-copy-diff"
                  type="button"
                  aria-label="Copy selected diff"
                  onClick={() => void copySelectedDiff()}
                  disabled={!diff?.diff || loadingDiff}
                >
                  {copyDiffState === 'copied' ? 'Copied' : 'Copy diff'}
                </button>
              </div>
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
      {reviewOpen ? (
        <div className="changes-review-backdrop" role="presentation">
          <section className="changes-review-modal" role="dialog" aria-modal="true" aria-label="Diff review">
            <header className="changes-review-head">
              <div>
                <div className="changes-eyebrow">{projectName}</div>
                <h2>Diff review</h2>
              </div>
              <button
                className="changes-icon-button"
                type="button"
                onClick={closeReview}
                aria-label="Close diff review"
                title="Close diff review"
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>

            <div className="changes-review-body">
              <aside className="changes-review-files" aria-label={`${projectName} review files`}>
                {snapshot.files.map((file) => (
                  <button
                    className={`change-file ${activeReviewPath === file.path ? 'active' : ''} change-file-${file.status}`}
                    type="button"
                    key={`review:${file.status}:${file.oldPath ?? ''}:${file.path}`}
                    onClick={() => openReviewFile(file)}
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
              </aside>

              <section className="changes-review-editor" aria-label="Tabbed diff editor">
                <div className="changes-review-tabs" role="tablist" aria-label="Open diff tabs">
                  {reviewTabs.map((path) => (
                    <div className={`changes-review-tab ${activeReviewPath === path ? 'active' : ''}`} key={`tab:${path}`}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeReviewPath === path}
                        onClick={() => setActiveReviewPath(path)}
                      >
                        {path}
                      </button>
                      <button
                        className="changes-review-tab-close"
                        type="button"
                        aria-label={`Close ${path} tab`}
                        onClick={() => closeReviewTab(path)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>

                <div className="changes-review-pane" role="tabpanel" aria-label={activeReviewPath ? `Full diff panel for ${activeReviewPath}` : 'Full diff panel'}>
                  {activeReviewLoading ? (
                    <div className="changes-empty">Loading diff…</div>
                  ) : activeReviewDiff?.error ? (
                    <div className="changes-warning" role="alert">{activeReviewDiff.error}</div>
                  ) : activeReviewDiff?.binary ? (
                    <div className="changes-empty">Binary diff preview is not available.</div>
                  ) : activeReviewDiff?.diff ? (
                    <pre className="diff-code changes-review-diff-code" aria-label={`Full diff for ${activeReviewDiff.path}`}>
                      {activeReviewDiff.diff.split('\n').map((line, index) => (
                        <span className={diffLineClass(line)} key={`review:${index}:${line.slice(0, 12)}`}>{line || ' '}</span>
                      ))}
                    </pre>
                  ) : (
                    <div className="changes-empty">Select a changed file to open its diff.</div>
                  )}
                </div>
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
