import { type RefObject } from 'react';
import { EmbeddedTerminalView } from '../EmbeddedTerminalView';
import type { ActiveGitOperation, EmbeddedTerminal, GitOperation } from '../appTypes';
import type { GitBranchInfo, ProjectBranchState } from '../types';

function formatBranchDivergence(branch: GitBranchInfo) {
  const parts: string[] = [];
  if (branch.ahead) parts.push(`ahead ${branch.ahead}`);
  if (branch.behind) parts.push(`behind ${branch.behind}`);
  return parts.length ? parts.join(' · ') : 'up to date';
}

type ServerViewProps = {
  projectName: string;
  projectCommand: string;
  projectCwd: string;
  projectUrl: string;
  projectSubtitle: string;
  currentStatus: 'running' | 'stopped' | 'draft';
  currentPid?: number;
  branchSubtitle?: string;
  visibleLog: string;
  logRef: RefObject<HTMLPreElement>;
  logCopied: boolean;
  hasConfiguredServer: boolean;
  hasRuntimeBridge: boolean;
  hasEmbeddedTerminalBridge: boolean;
  canOpenLocalUrl: boolean;
  projectBranchState: ProjectBranchState | undefined;
  visibleBranches: GitBranchInfo[];
  branchOptions: GitBranchInfo[];
  branchControlStatus: string;
  branchControlRepoCwd: string;
  branchFilter: string;
  branchFallbackOption: string;
  branchConfigWarning?: string;
  activeGitOperation?: ActiveGitOperation;
  activeGitOperationLabel?: string;
  canSwitchBranches: boolean;
  canFetchBranches: boolean;
  canMergeBranches: boolean;
  hasBranchBridge: boolean;
  projectTerminals: EmbeddedTerminal[];
  onEditServer: () => void;
  onNewServer: () => void;
  onStart: () => void;
  onStop: () => void;
  onOpenLocalUrl: () => void;
  onRunGitOperation: (action: GitOperation, branch?: string) => void;
  onRequestMergeBranch: (sourceBranch: string) => void;
  onBranchFilterChange: (value: string) => void;
  onCopyLog: () => void;
  onClearLog: () => void;
  onOpenEmbeddedTerminal: () => void;
  onWriteTerminal: (id: string, data: string) => void;
  onResizeTerminal: (id: string, cols: number, rows: number) => void;
  onKillTerminal: (id: string) => void;
  onCloseTerminal: (id: string) => void;
};

export function ServerView({
  projectName,
  projectCommand,
  projectCwd,
  projectUrl,
  projectSubtitle,
  currentStatus,
  currentPid,
  branchSubtitle,
  visibleLog,
  logRef,
  logCopied,
  hasConfiguredServer,
  hasRuntimeBridge,
  hasEmbeddedTerminalBridge,
  canOpenLocalUrl,
  projectBranchState,
  visibleBranches,
  branchOptions,
  branchControlStatus,
  branchControlRepoCwd,
  branchFilter,
  branchFallbackOption,
  branchConfigWarning,
  activeGitOperation,
  activeGitOperationLabel,
  canSwitchBranches,
  canFetchBranches,
  canMergeBranches,
  hasBranchBridge,
  projectTerminals,
  onEditServer,
  onNewServer,
  onStart,
  onStop,
  onOpenLocalUrl,
  onRunGitOperation,
  onRequestMergeBranch,
  onBranchFilterChange,
  onCopyLog,
  onClearLog,
  onOpenEmbeddedTerminal,
  onWriteTerminal,
  onResizeTerminal,
  onKillTerminal,
  onCloseTerminal
}: ServerViewProps) {
  return (
    <section className="server-view" aria-label={`${projectName} server`}>
      <div className="server-head">
        <div>
          <div className="server-head-titlebar">
            <h1>{projectName} server</h1>
            <span
              className={`status-chip ${currentStatus === 'running' ? 'status-chip-running' : ''}`}
              aria-label={`Server is ${currentStatus === 'running' ? 'running' : 'stopped'}`}
            >
              <span className="status-dot" aria-hidden="true" />
              {currentStatus === 'running' ? 'Running' : 'Stopped'}
            </span>
          </div>
          <p>{projectSubtitle}</p>
        </div>
        <div className="server-actions">
          {hasConfiguredServer ? (
            <button className="secondary" type="button" onClick={onEditServer} disabled={currentStatus === 'running'}>Edit server</button>
          ) : (
            <button className="primary" type="button" onClick={onNewServer}>Configure server</button>
          )}
          <button
            disabled={!hasRuntimeBridge || !hasConfiguredServer || currentStatus === 'running'}
            className={currentStatus === 'running' ? 'secondary' : 'primary'}
            onClick={onStart}
          >
            Start
          </button>
          <button
            disabled={!hasRuntimeBridge || !hasConfiguredServer || currentStatus !== 'running'}
            className={currentStatus === 'running' ? 'primary' : 'secondary'}
            onClick={onStop}
          >
            Stop
          </button>
        </div>
      </div>

      <div className="runtime-grid">
        <div className="runtime-cell">
          <div className="runtime-label">Status</div>
          <div className={`runtime-value ${currentStatus === 'running' ? 'ok' : ''}`}>
            {currentStatus === 'running' ? 'running' : 'stopped'}
            {currentStatus === 'running' && currentPid ? (
              <span className="runtime-value-meta">· pid {currentPid}</span>
            ) : null}
          </div>
        </div>
        <div className="runtime-cell">
          <div className="runtime-label">Branch</div>
          <div className={`runtime-value ${branchSubtitle ? '' : 'runtime-value-empty'}`}>{branchSubtitle ?? '—'}</div>
        </div>
        <div className="runtime-cell">
          <div className="runtime-label">Local URL</div>
          <div className="runtime-value runtime-value-with-action">
            {projectUrl ? <span>{projectUrl}</span> : <span className="runtime-value-empty">Not configured</span>}
            {canOpenLocalUrl ? (
              <button className="inline-action" type="button" onClick={onOpenLocalUrl}>Open URL</button>
            ) : null}
          </div>
        </div>
        <div className="runtime-cell">
          <div className="runtime-label">Command</div>
          <div className={`runtime-value ${projectCommand ? '' : 'runtime-value-empty'}`}>{projectCommand || 'Not configured'}</div>
        </div>
        <div className="runtime-cell">
          <div className="runtime-label">Working directory</div>
          <div className={`runtime-value ${projectCwd ? '' : 'runtime-value-empty'}`}>{projectCwd || '—'}</div>
        </div>
      </div>

      <section className="project-config-panel" aria-label="Project config">
        <div className="project-config-head">
          <div>
            <div className="runtime-label">Git</div>
            <h2>Branches</h2>
          </div>
          <span className={`config-pill ${projectBranchState?.dirty ? 'config-pill-danger' : branchControlStatus !== 'Clean' ? 'config-pill-muted' : ''}`}>
            {branchControlStatus === 'Loading' ? 'Loading…' : branchControlStatus}
          </span>
        </div>
        <div className="project-config-row branch-manager-summary">
          <div>
            <div className="runtime-label">Repository</div>
            <div className="runtime-value">{branchControlRepoCwd}</div>
          </div>
          <button className="secondary" type="button" onClick={() => onRunGitOperation('fetch')} disabled={!canFetchBranches}>
            {activeGitOperation?.action === 'fetch' ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
        <div className="branch-manager-toolbar">
          <label className="branch-search">
            <span>Search branches</span>
            <input
              placeholder="Search branches"
              value={branchFilter}
              onChange={(event) => onBranchFilterChange(event.target.value)}
              disabled={!hasBranchBridge || !projectBranchState}
            />
          </label>
          <div className="branch-manager-meta">
            {activeGitOperationLabel ?? `${visibleBranches.length} local branches`}
          </div>
        </div>
        {branchOptions.length ? (
          <div className="branch-list" role="list" aria-label="Local branches">
            {visibleBranches.map((branch) => {
              const isCurrentBranch = branch.name === projectBranchState?.current;
              const switchLabel = `Switch to ${branch.name}`;
              const mergeLabel = `Merge ${branch.name} into ${projectBranchState?.current ?? 'current branch'}`;
              return (
                <div className={`branch-card ${isCurrentBranch ? 'branch-card-current' : ''}`} role="listitem" key={branch.name}>
                  <div className="branch-card-main">
                    <div className="branch-name-row">
                      <strong>{branch.name}</strong>
                      {isCurrentBranch ? <span className="branch-current-pill">current</span> : null}
                    </div>
                    <div className="branch-meta-line">
                      <span>{branch.upstream ?? 'local only'}</span>
                      <span>{formatBranchDivergence(branch)}</span>
                    </div>
                    {branch.lastCommit ? <div className="branch-last-commit">{branch.lastCommit}</div> : null}
                  </div>
                  {isCurrentBranch ? (
                    <div className="branch-card-actions branch-current-state" aria-label={`${branch.name} is checked out`}>
                      Checked out
                    </div>
                  ) : (
                    <div className="branch-card-actions">
                      <button
                        className="terminal-action"
                        type="button"
                        aria-label={switchLabel}
                        onClick={() => onRunGitOperation('switch', branch.name)}
                        disabled={!canSwitchBranches}
                      >
                        Switch
                      </button>
                      <button
                        className="terminal-action"
                        type="button"
                        aria-label={mergeLabel}
                        onClick={() => onRequestMergeBranch(branch.name)}
                        disabled={!canMergeBranches}
                      >
                        Merge
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="branch-empty" role="status">{branchFallbackOption}</div>
        )}
        {branchConfigWarning ? <div className="config-warning" role="status">{branchConfigWarning}</div> : null}
      </section>

      <div className="terminal-panel" aria-label="Server logs">
        <div className="terminal-bar">
          <h2>Logs<span className="terminal-bar-meta">{projectName}</span></h2>
          <div className="terminal-actions">
            <button className="terminal-action" type="button" onClick={onCopyLog}>{logCopied ? 'Copied' : 'Copy log'}</button>
            <button className="terminal-action" type="button" onClick={onClearLog}>Clear</button>
            <button disabled={!hasEmbeddedTerminalBridge} className="terminal-action" type="button" aria-label="Open terminal" onClick={onOpenEmbeddedTerminal}>New terminal</button>
          </div>
        </div>
        <pre ref={logRef}>{visibleLog}</pre>
      </div>

      {projectTerminals.length > 0 ? (
        <div className="embedded-stack" aria-label={`${projectName} embedded sessions`}>
          {projectTerminals.map((terminal) => (
            <EmbeddedTerminalView
              key={terminal.id}
              id={terminal.id}
              title={terminal.title}
              cwd={terminal.cwd}
              status={terminal.status}
              output={terminal.output}
              onWrite={onWriteTerminal}
              onResize={onResizeTerminal}
              onKill={onKillTerminal}
              onClose={onCloseTerminal}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
