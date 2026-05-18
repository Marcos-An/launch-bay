import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import type { AgentCliTool, GitSnapshot, RuntimeSnapshot, ServerConfig, WorkspaceConfig } from '../types';
import type { AgentSession, AgentSessionKind, Project, Surface } from '../appTypes';

type SidebarProps = {
  workspaces: WorkspaceConfig[];
  servers: ServerConfig[];
  projectServers: ServerConfig[];
  selectedServerId?: string;
  configuredProjects: Project[];
  selectedProject: Project;
  runtimeSnapshots: Record<string, RuntimeSnapshot>;
  surface: Surface;
  hasProjects: boolean;
  /** Kept for backwards compatibility with App.tsx; no longer rendered here. */
  hasHermesBridge?: boolean;
  canOpenProjectFolder: boolean;
  defaultHermesSessionId: string;
  defaultHermesSessionName: string;
  projectAgentSessions: AgentSession[];
  selectedAgentSessionId?: string;
  renamingSessionId?: string;
  renameDraft: string;
  renamingServerId?: string;
  renameServerDraft: string;
  agentToolOptions: AgentCliTool[];
  activeChangesServerId?: string;
  /** Kept for backwards compatibility with App.tsx; the "New chat" pill was removed from the sidebar. */
  onResetHermesSession?: () => void;
  onOpenProjectFolder: () => void;
  onSelectProject: (id: string) => void;
  onDeleteWorkspace?: (id: string) => void;
  onOpenServerSurface?: () => void;
  onOpenFilesSurface?: () => void;
  onOpenNewSessionModal: () => void;
  onOpenNewServerModal: () => void;
  onSelectDefaultHermesSession: () => void;
  onBeginRenameDefaultHermesSession: () => void;
  onSelectAgentSession: (id: string) => void;
  onBeginRenameAgentSession: (session: AgentSession) => void;
  onRequestKillAgentSession: (session: AgentSession) => void;
  onCommitRenameSession: () => void;
  onCancelRenameSession: () => void;
  onRenameDraftChange: (value: string) => void;
  onSelectServer: (serverId: string) => void;
  onOpenChangesWorkbench: (serverId: string) => void;
  onBeginRenameServer: (serverId: string, currentName: string) => void;
  onCommitRenameServer: () => void;
  onCancelRenameServer: () => void;
  onRenameServerDraftChange: (value: string) => void;
  getAgentSessionPresetLabel: (kind: AgentSessionKind) => string;
};

const EMPTY_CHANGES_SNAPSHOT: GitSnapshot = {
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

function sidebarOperationLabel(snapshot: GitSnapshot): string {
  if (snapshot.isMerging) return 'Merge in progress';
  if (snapshot.isRebasing) return 'Rebase in progress';
  if (snapshot.isCherryPicking) return 'Cherry-pick in progress';
  return snapshot.isDirty || snapshot.files.length > 0 ? 'Local changes' : 'Clean';
}

function ChangesSidebarCard({
  server,
  active,
  onOpen
}: {
  server: ServerConfig;
  active: boolean;
  onOpen: (serverId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<GitSnapshot>(EMPTY_CHANGES_SNAPSHOT);
  const [loading, setLoading] = useState(false);

  const refreshSnapshot = useCallback(() => {
    const bridge = window.launchBay;
    if (!bridge?.getProjectGitSnapshot) return Promise.resolve();

    setLoading(true);
    return bridge.getProjectGitSnapshot(server.id)
      .then(setSnapshot)
      .catch((error) => {
        setSnapshot({
          ...EMPTY_CHANGES_SNAPSHOT,
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => setLoading(false));
  }, [server.id]);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.launchBay;
    if (!bridge?.getProjectGitSnapshot) return undefined;

    setLoading(true);
    bridge.getProjectGitSnapshot(server.id)
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot);
      })
      .catch((error) => {
        if (!cancelled) {
          setSnapshot({
            ...EMPTY_CHANGES_SNAPSHOT,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [server.id]);

  useEffect(() => {
    if (active || !window.launchBay?.getProjectGitSnapshot) return undefined;

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshSnapshot();
      }
    };

    const intervalId = window.setInterval(refreshWhenVisible, 10_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [active, refreshSnapshot]);

  const branchLabel = snapshot.branch ?? (loading ? 'Loading…' : 'No branch');
  const fileCountLabel = `${snapshot.files.length} file${snapshot.files.length === 1 ? '' : 's'}`;

  return (
    <button
      aria-label={`Expand changes workbench for ${branchLabel}`}
      aria-pressed={active}
      className={`changes-sidebar-card ${active ? 'active' : ''} ${snapshot.conflicts.length > 0 ? 'changes-sidebar-card-conflict' : ''}`}
      type="button"
      onClick={() => onOpen(server.id)}
    >
      <span className="changes-sidebar-kicker">Changes · {server.name}</span>
      <span className="changes-sidebar-main">
        <strong>{branchLabel}</strong>
        <span>{fileCountLabel}</span>
      </span>
      <span className="changes-sidebar-meta">
        <span>{snapshot.error ? 'Unavailable' : sidebarOperationLabel(snapshot)}</span>
        {snapshot.conflicts.length > 0 ? <span>{snapshot.conflicts.length} conflicts</span> : null}
        {typeof snapshot.ahead === 'number' || typeof snapshot.behind === 'number' ? (
          <span>↑{snapshot.ahead ?? 0} ↓{snapshot.behind ?? 0}</span>
        ) : null}
      </span>
    </button>
  );
}

export function Sidebar({
  workspaces,
  servers,
  projectServers,
  selectedServerId,
  configuredProjects,
  selectedProject,
  runtimeSnapshots,
  surface,
  hasProjects,
  canOpenProjectFolder,
  defaultHermesSessionId,
  defaultHermesSessionName,
  projectAgentSessions,
  selectedAgentSessionId,
  renamingSessionId,
  renameDraft,
  renamingServerId,
  renameServerDraft,
  activeChangesServerId,
  onOpenProjectFolder,
  onSelectProject,
  onDeleteWorkspace,
  onOpenServerSurface,
  onOpenFilesSurface,
  onOpenNewSessionModal,
  onOpenNewServerModal,
  onSelectDefaultHermesSession,
  onBeginRenameDefaultHermesSession,
  onSelectAgentSession,
  onBeginRenameAgentSession,
  onRequestKillAgentSession,
  onCommitRenameSession,
  onCancelRenameSession,
  onRenameDraftChange,
  onSelectServer,
  onOpenChangesWorkbench,
  onBeginRenameServer,
  onCommitRenameServer,
  onCancelRenameServer,
  onRenameServerDraftChange,
  getAgentSessionPresetLabel
}: SidebarProps) {
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | undefined>(undefined);
  const selectedWorkspaceServer = selectedServerId
    ? servers.find((server) => server.id === selectedServerId)
    : servers.find((server) => server.workspaceId === selectedProject.id);
  const selectedRuntime = selectedWorkspaceServer ? runtimeSnapshots[selectedWorkspaceServer.id] : runtimeSnapshots[selectedProject.id];
  const branchLabel = selectedRuntime?.branch ? `${selectedRuntime.branch}${selectedRuntime.dirty ? ' · dirty' : ''}` : undefined;

  function toggleSessionMenu(sessionId: string) {
    setOpenSessionMenuId((current) => (current === sessionId ? undefined : sessionId));
  }

  function openSessionMenu(sessionId: string) {
    setOpenSessionMenuId(sessionId);
  }

  function closeSessionMenu() {
    setOpenSessionMenuId(undefined);
  }

  function handleSessionMenuKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') closeSessionMenu();
  }

  useEffect(() => {
    if (!openSessionMenuId) return undefined;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest('.session-actions-trigger, .session-actions-menu')) return;
      closeSessionMenu();
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [openSessionMenuId]);

  return (
    <aside className="sidebar">
      <div className="brand">Launch Bay</div>

      <div className="section section-with-action">
        <span>Projects</span>
        <button className="section-action section-action-primary" type="button" onClick={onOpenProjectFolder} disabled={!canOpenProjectFolder}>+ Open folder</button>
      </div>
      <div className="group workspace-server-list">
        {workspaces.length === 0 ? (
          <div className="empty-sidebar-note">No local projects yet</div>
        ) : workspaces.map((workspace) => {
          const project = configuredProjects.find((item) => item.id === workspace.id);
          const workspaceServer = servers.find((server) => server.workspaceId === workspace.id);
          const runtime = workspaceServer ? runtimeSnapshots[workspaceServer.id] : runtimeSnapshots[workspace.id];
          const status = runtime?.status ?? project?.status ?? 'stopped';
          return (
            <div
              key={workspace.id}
              className={`row workspace-row ${workspace.id === selectedProject.id ? 'active' : ''}`}
            >
              <button
                aria-label={workspace.name}
                className="workspace-row-main"
                type="button"
                onClick={() => onSelectProject(workspace.id)}
              >
                <span className="workspace-row-stack">
                  <span className="workspace-row-name">{workspace.name}</span>
                </span>
                <span className={`state ${status === 'running' ? 'running' : ''}`}>{status}</span>
              </button>
              {onDeleteWorkspace ? (
                <button
                  aria-label={`Remove ${workspace.name}`}
                  className="workspace-row-remove"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    console.info('[launch-bay] × click on workspace', workspace.id);
                    onDeleteWorkspace(workspace.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {hasProjects ? (
      <nav className="workspace-nav" aria-label={`${selectedProject.name} workspace`}>
        <div className="workspace-section workspace-section-primary" role="group" aria-label="Sessions">
          <div className="workspace-section-head">
            <div className="workspace-section-copy">
              <span className="workspace-section-title">Sessions</span>
              <span className="workspace-section-meta">Agents for this project</span>
            </div>
            <button className="new-session-pill" aria-label="New session" onClick={onOpenNewSessionModal}>New</button>
          </div>
          <div className="session-list">
            <div
              className={`session-nav-item ${surface === 'hermes' ? 'active' : ''}`}
              onContextMenu={(event) => {
                event.preventDefault();
                openSessionMenu(defaultHermesSessionId);
              }}
              onKeyDown={handleSessionMenuKeyDown}
            >
              {renamingSessionId === defaultHermesSessionId ? (
                <input
                  aria-label="Rename session"
                  className="session-rename-input"
                  value={renameDraft}
                  autoFocus
                  onChange={(event) => onRenameDraftChange(event.target.value)}
                  onBlur={onCommitRenameSession}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onCommitRenameSession();
                    if (event.key === 'Escape') onCancelRenameSession();
                  }}
                />
              ) : (
                <button className="session-open" aria-label={`Open ${defaultHermesSessionName}`} onClick={onSelectDefaultHermesSession}>
                  <span className="row-title-stack">
                    <span className="row-title">{defaultHermesSessionName}</span>
                    {defaultHermesSessionName !== 'Hermes' ? <span className="row-subtitle">Hermes</span> : null}
                  </span>
                </button>
              )}
              <button
                className="session-actions-trigger"
                aria-label={`Session actions for ${defaultHermesSessionName}`}
                aria-haspopup="menu"
                aria-expanded={openSessionMenuId === defaultHermesSessionId}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSessionMenu(defaultHermesSessionId);
                }}
              >
                ⋯
              </button>
              {openSessionMenuId === defaultHermesSessionId ? (
                <div className="session-actions-menu" role="menu" aria-label={`${defaultHermesSessionName} actions`}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeSessionMenu();
                      onBeginRenameDefaultHermesSession();
                    }}
                  >
                    Edit session
                  </button>
                </div>
              ) : null}
            </div>
            {projectAgentSessions.map((session) => {
              const isSelected = surface === 'agent-session' && selectedAgentSessionId === session.id;
              return (
                <div
                  className={`session-nav-item ${isSelected ? 'active' : ''}`}
                  key={session.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openSessionMenu(session.id);
                  }}
                  onKeyDown={handleSessionMenuKeyDown}
                >
                  {renamingSessionId === session.id ? (
                    <input
                      aria-label="Rename session"
                      className="session-rename-input"
                      value={renameDraft}
                      autoFocus
                      onChange={(event) => onRenameDraftChange(event.target.value)}
                      onBlur={onCommitRenameSession}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onCommitRenameSession();
                        if (event.key === 'Escape') onCancelRenameSession();
                      }}
                    />
                  ) : (
                    <button className="session-open" aria-label={`Open ${session.name}`} onClick={() => onSelectAgentSession(session.id)}>
                      <span className="row-title-stack">
                        <span className="row-title">{session.name}</span>
                        {getAgentSessionPresetLabel(session.kind) !== session.name ? (
                          <span className="row-subtitle">{getAgentSessionPresetLabel(session.kind)}</span>
                        ) : null}
                      </span>
                    </button>
                  )}
                  <button
                    className="session-actions-trigger"
                    aria-label={`Session actions for ${session.name}`}
                    aria-haspopup="menu"
                    aria-expanded={openSessionMenuId === session.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleSessionMenu(session.id);
                    }}
                  >
                    ⋯
                  </button>
                  {openSessionMenuId === session.id ? (
                    <div className="session-actions-menu" role="menu" aria-label={`${session.name} actions`}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          closeSessionMenu();
                          onBeginRenameAgentSession(session);
                        }}
                      >
                        Edit session
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          closeSessionMenu();
                          onRequestKillAgentSession(session);
                        }}
                      >
                        Kill session
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="workspace-section workspace-section-secondary" role="group" aria-label="Server runtime">
          <div className="workspace-section-head">
            <div className="workspace-section-copy">
              {onOpenServerSurface ? (
                <button
                  type="button"
                  className="workspace-section-title workspace-section-title-button"
                  aria-label="Server"
                  onClick={onOpenServerSurface}
                >
                  Servers
                </button>
              ) : (
                <span className="workspace-section-title">Servers</span>
              )}
              {branchLabel ? <span className="row-subtitle server-branch">{branchLabel}</span> : null}
            </div>
            <button className="new-session-pill" aria-label="New server" onClick={onOpenNewServerModal}>New</button>
          </div>
          <div className="session-list">
            {projectServers.length === 0 ? (
              <div className="empty-sidebar-note">No servers yet</div>
            ) : projectServers.map((server) => {
              const isSelected = surface === 'server' && server.id === selectedServerId;
              const status = runtimeSnapshots[server.id]?.status ?? 'stopped';
              return (
                <div className={`session-nav-item ${isSelected ? 'active' : ''}`} key={server.id}>
                  {renamingServerId === server.id ? (
                    <input
                      aria-label="Rename server"
                      className="session-rename-input"
                      value={renameServerDraft}
                      autoFocus
                      onChange={(event) => onRenameServerDraftChange(event.target.value)}
                      onBlur={onCommitRenameServer}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onCommitRenameServer();
                        if (event.key === 'Escape') onCancelRenameServer();
                      }}
                    />
                  ) : (
                    <button
                      className="session-open"
                      aria-label={server.name}
                      aria-pressed={isSelected}
                      onClick={() => onSelectServer(server.id)}
                    >
                      <span className={`server-status-dot ${status === 'running' ? 'running' : ''}`} aria-hidden="true" />
                      <span className="row-title-stack">
                        <span className="row-title">{server.name}</span>
                      </span>
                    </button>
                  )}
                  <button className="session-rename" aria-label={`Rename ${server.name}`} onClick={() => onBeginRenameServer(server.id, server.name)}>✎</button>
                </div>
              );
            })}
          </div>
        </div>

        {projectServers.length > 0 ? (
          <div className="workspace-section workspace-section-secondary" role="group" aria-label="Changes">
            <div className="workspace-section-head">
              <div className="workspace-section-copy">
                <span className="workspace-section-title">Changes</span>
                <span className="workspace-section-meta">Open diff workbench</span>
              </div>
            </div>
            <div className="changes-sidebar-list">
              {projectServers.map((server) => (
                <ChangesSidebarCard
                  key={server.id}
                  server={server}
                  active={activeChangesServerId === server.id}
                  onOpen={onOpenChangesWorkbench}
                />
              ))}
            </div>
            {onOpenFilesSurface ? (
              <button
                type="button"
                className={`files-sidebar-action ${surface === 'files' ? 'active' : ''}`}
                aria-label="Open project files"
                aria-pressed={surface === 'files'}
                onClick={onOpenFilesSurface}
              >
                <span className="files-sidebar-action-main">Open files</span>
                <span className="files-sidebar-action-meta">Browse/edit</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </nav>
      ) : null}

      <div className="spacer" />
      <div className="account">Marcos</div>
    </aside>
  );
}
