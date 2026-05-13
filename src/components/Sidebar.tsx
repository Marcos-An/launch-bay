import type { AgentCliTool, RuntimeSnapshot, ServerConfig, WorkspaceConfig } from '../types';
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
  /** Kept for backwards compatibility with App.tsx; the "New chat" pill was removed from the sidebar. */
  onResetHermesSession?: () => void;
  onOpenProjectFolder: () => void;
  onSelectProject: (id: string) => void;
  onDeleteWorkspace?: (id: string) => void;
  onOpenServerSurface?: () => void;
  onOpenNewSessionModal: () => void;
  onOpenNewServerModal: () => void;
  onSelectDefaultHermesSession: () => void;
  onBeginRenameDefaultHermesSession: () => void;
  onSelectAgentSession: (id: string) => void;
  onBeginRenameAgentSession: (session: AgentSession) => void;
  onCommitRenameSession: () => void;
  onCancelRenameSession: () => void;
  onRenameDraftChange: (value: string) => void;
  onSelectServer: (serverId: string) => void;
  onBeginRenameServer: (serverId: string, currentName: string) => void;
  onCommitRenameServer: () => void;
  onCancelRenameServer: () => void;
  onRenameServerDraftChange: (value: string) => void;
  getAgentSessionPresetLabel: (kind: AgentSessionKind) => string;
};

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
  onOpenProjectFolder,
  onSelectProject,
  onDeleteWorkspace,
  onOpenServerSurface,
  onOpenNewSessionModal,
  onOpenNewServerModal,
  onSelectDefaultHermesSession,
  onBeginRenameDefaultHermesSession,
  onSelectAgentSession,
  onBeginRenameAgentSession,
  onCommitRenameSession,
  onCancelRenameSession,
  onRenameDraftChange,
  onSelectServer,
  onBeginRenameServer,
  onCommitRenameServer,
  onCancelRenameServer,
  onRenameServerDraftChange,
  getAgentSessionPresetLabel
}: SidebarProps) {
  const selectedWorkspaceServer = selectedServerId
    ? servers.find((server) => server.id === selectedServerId)
    : servers.find((server) => server.workspaceId === selectedProject.id);
  const selectedRuntime = selectedWorkspaceServer ? runtimeSnapshots[selectedWorkspaceServer.id] : runtimeSnapshots[selectedProject.id];
  const branchLabel = selectedRuntime?.branch ? `${selectedRuntime.branch}${selectedRuntime.dirty ? ' · dirty' : ''}` : undefined;

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
            <div className={`session-nav-item ${surface === 'hermes' ? 'active' : ''}`}>
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
              <button className="session-rename" aria-label={`Rename ${defaultHermesSessionName}`} onClick={onBeginRenameDefaultHermesSession}>✎</button>
            </div>
            {projectAgentSessions.map((session) => {
              const isSelected = surface === 'agent-session' && selectedAgentSessionId === session.id;
              return (
                <div className={`session-nav-item ${isSelected ? 'active' : ''}`} key={session.id}>
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
                        <span className="row-subtitle">{getAgentSessionPresetLabel(session.kind)}</span>
                      </span>
                    </button>
                  )}
                  <button className="session-rename" aria-label={`Rename ${session.name}`} onClick={() => onBeginRenameAgentSession(session)}>✎</button>
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
      </nav>
      ) : null}

      <div className="spacer" />
      <div className="account">Marcos</div>
    </aside>
  );
}
