import { useEffect, useMemo, useRef, useState } from 'react';
import { HermesChatView } from './components/HermesChatView';
import { AgentSessionView } from './components/AgentSessionView';
import { ServerView } from './components/ServerView';
import { Sidebar } from './components/Sidebar';
import { MergeConfirmationModal } from './components/MergeConfirmationModal';
import { NewSessionModal } from './components/NewSessionModal';
import { ServerFormModal, type ServerFormState } from './components/ServerFormModal';
import { ConfirmModal } from './components/ConfirmModal';
import { PastSessionsModal } from './components/PastSessionsModal';
import { HermesPermissionModal } from './components/HermesPermissionModal';
import type {
  AgentCliTool,
  HermesContextUsage,
  HermesImageAttachment,
  HermesMessage,
  HermesPermissionRequest,
  HermesResourceAttachment,
  HermesSnapshot,
  LaunchBayConfig,
  ProjectBranchState,
  RuntimeSnapshot,
  ServerConfig,
  WorkspaceConfig
} from './types';
import type {
  ActiveGitOperation,
  AgentSession,
  AgentSessionKind,
  EmbeddedTerminal,
  GitOperation,
  MergeConfirmation,
  Project,
  Surface
} from './appTypes';
import './App.css';

type SupportedAgentCliTool = Omit<AgentCliTool, 'id'> & { id: AgentSessionKind };

const EMPTY_HERMES: HermesSnapshot = { messages: [], pending: false };
const EMPTY_LAUNCH_BAY_CONFIG: LaunchBayConfig = {
  version: 1,
  localUser: {
    id: 'local-preview',
    createdAt: '',
    updatedAt: '',
    onboardingCompleted: false
  },
  workspaces: [],
  servers: []
};
const RUNTIME_STATUS_REFRESH_MS = 3000;
const WORKSPACE_PROJECT_STORAGE_KEY = 'launch-bay:workspace:project-id';
const WORKSPACE_SURFACE_STORAGE_KEY = 'launch-bay:workspace:surface';
const LOCAL_CONFIG_CACHE_STORAGE_KEY = 'launch-bay:config-cache';
const DEFAULT_SURFACE: Surface = 'hermes';
const SUPPORTED_AGENT_CLI_TOOLS: SupportedAgentCliTool[] = [
  { id: 'hermes', label: 'Hermes', command: 'hermes' },
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'gemini', label: 'Gemini', command: 'gemini' },
  { id: 'aider', label: 'Aider', command: 'aider' }
];
const DEFAULT_AGENT_TOOL = SUPPORTED_AGENT_CLI_TOOLS[0];

function getAgentSessionPreset(kind: AgentSessionKind, tools: SupportedAgentCliTool[] = SUPPORTED_AGENT_CLI_TOOLS) {
  return tools.find((tool) => tool.id === kind) ?? SUPPORTED_AGENT_CLI_TOOLS.find((tool) => tool.id === kind) ?? DEFAULT_AGENT_TOOL;
}

function isSupportedAgentSessionKind(value: string): value is AgentSessionKind {
  return SUPPORTED_AGENT_CLI_TOOLS.some((tool) => tool.id === value);
}

function createDefaultHermesSessionId(projectId: string) {
  return `default-hermes-${projectId}`;
}

function createLocalAgentSessionId(kind: AgentSessionKind) {
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeReadStorage(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWriteStorage(key: string, value: string) {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Storage may be unavailable (Safari private mode, disabled, etc.) — skip silently.
  }
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function formatTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  return tokens.toLocaleString();
}

function isOpenableLocalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function formatGitOperationLabel(operation: ActiveGitOperation | undefined) {
  if (!operation) return undefined;
  if (operation.action === 'fetch') return 'Fetching…';
  if (operation.action === 'switch') return 'Switching…';
  return 'Merging…';
}

function formatContextUsage(usage: HermesContextUsage | undefined) {
  if (!usage) return 'Context —';
  const used = formatTokenCount(usage.totalTokens);
  if (usage.contextLength && usage.percent !== undefined) {
    return `Context ${used} / ${formatTokenCount(usage.contextLength)} · ${usage.percent}%`;
  }
  return `Context ${used} tokens`;
}

function workspaceToProject(workspace: WorkspaceConfig, server?: ServerConfig): Project {
  return {
    id: workspace.id,
    name: workspace.name,
    status: 'stopped',
    command: server?.command || 'No server configured',
    cwd: server?.cwd ?? workspace.cwd,
    url: server?.url ?? '',
    serverSub: server?.description || 'Local project folder. Hermes sessions, git state, servers, and terminals stay scoped to this project.',
    prompt: `Ask Hermes about ${workspace.name}`,
    suggestions: ['Inspect this project context', 'Review current branch state', 'Plan the next local task'],
    log: server?.command
      ? `Click Start to run ${server.command} in ${server.cwd}. Logs will stream here.`
      : 'No server configured yet. Add a server command when this project needs a local runtime.'
  };
}

function createSetupProject(): Project {
  return {
    id: '__setup__',
    name: 'No project selected',
    status: 'stopped',
    command: '',
    cwd: '',
    url: '',
    serverSub: 'Open a local project folder to start using Launch Bay.',
    prompt: 'Open a project folder',
    suggestions: ['Open a local project', 'Choose a Git folder', 'Then add Hermes sessions and servers'],
    log: 'Open a local project folder before running servers.'
  };
}

function readStoredProjectName(): string {
  return safeReadStorage(WORKSPACE_PROJECT_STORAGE_KEY) ?? '';
}

function readCachedLaunchBayConfig(): LaunchBayConfig {
  const cached = safeReadStorage(LOCAL_CONFIG_CACHE_STORAGE_KEY);
  if (!cached) return EMPTY_LAUNCH_BAY_CONFIG;
  try {
    const parsed = JSON.parse(cached) as LaunchBayConfig;
    if (parsed?.version === 1 && Array.isArray(parsed.workspaces) && Array.isArray(parsed.servers)) {
      return parsed;
    }
  } catch {
    // Ignore stale or malformed local cache.
  }
  return EMPTY_LAUNCH_BAY_CONFIG;
}

function cacheLaunchBayConfig(config: LaunchBayConfig) {
  safeWriteStorage(LOCAL_CONFIG_CACHE_STORAGE_KEY, JSON.stringify(config));
}

function createEmptyServerForm(workspaces: WorkspaceConfig[], selectedWorkspaceId?: string): ServerFormState {
  const preferredWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0];
  return {
    mode: 'create',
    workspaceId: preferredWorkspace?.id ?? '__new__',
    workspaceName: preferredWorkspace ? '' : 'My workspace',
    name: preferredWorkspace?.name ?? '',
    cwd: preferredWorkspace?.cwd ?? '',
    command: '',
    url: '',
    description: ''
  };
}

function basenameFromPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || '';
}

function readStoredSurface(): Surface {
  const storedSurface = safeReadStorage(WORKSPACE_SURFACE_STORAGE_KEY);
  return storedSurface === 'hermes' || storedSurface === 'server' ? storedSurface : DEFAULT_SURFACE;
}

function App() {
  const [projectName, setProjectName] = useState<string>(readStoredProjectName);
  const [launchConfig, setLaunchConfig] = useState<LaunchBayConfig>(readCachedLaunchBayConfig);
  const [configSyncVersion, setConfigSyncVersion] = useState(0);
  const [configLoading, setConfigLoading] = useState(false);
  const [serverForm, setServerForm] = useState<ServerFormState | undefined>(undefined);
  const [savingServer, setSavingServer] = useState(false);
  const [surface, setSurface] = useState<Surface>(readStoredSurface);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, RuntimeSnapshot>>({});
  const [projectBranches, setProjectBranches] = useState<Record<string, ProjectBranchState>>({});
  const [branchFilters, setBranchFilters] = useState<Record<string, string>>({});
  const [selectedServerIds, setSelectedServerIds] = useState<Record<string, string>>({});
  const [activeGitOperation, setActiveGitOperation] = useState<ActiveGitOperation | undefined>(undefined);
  const [mergeConfirmation, setMergeConfirmation] = useState<MergeConfirmation | undefined>(undefined);
  const [hermesSnapshots, setHermesSnapshots] = useState<Record<string, HermesSnapshot>>({});
  const [pendingStartedAt, setPendingStartedAt] = useState<Record<string, number>>({});
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [draft, setDraft] = useState('');
  const [hermesAttachments, setHermesAttachments] = useState<Record<string, HermesImageAttachment[]>>({});
  const [hermesResources, setHermesResources] = useState<Record<string, HermesResourceAttachment[]>>({});
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [pastSessionsOpen, setPastSessionsOpen] = useState(false);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<WorkspaceConfig | undefined>(undefined);
  const [approvalMode, setApprovalMode] = useState<'auto' | 'manual'>('auto');
  const [pendingPermission, setPendingPermission] = useState<HermesPermissionRequest | undefined>(undefined);
  const [projectFiles, setProjectFiles] = useState<Record<string, string[]>>({});
  const [hermesSkills, setHermesSkills] = useState<{ name: string; description: string }[]>([]);
  const [clearedLogBaselines, setClearedLogBaselines] = useState<Record<string, string>>({});
  const [embeddedTerminals, setEmbeddedTerminals] = useState<Record<string, EmbeddedTerminal[]>>({});
  const [agentSessions, setAgentSessions] = useState<Record<string, AgentSession[]>>({});
  const [availableAgentTools, setAvailableAgentTools] = useState<SupportedAgentCliTool[]>([]);
  const [defaultHermesSessionNames, setDefaultHermesSessionNames] = useState<Record<string, string>>({});
  const [selectedAgentSessionId, setSelectedAgentSessionId] = useState<string | undefined>(undefined);
  const [newSessionModalOpen, setNewSessionModalOpen] = useState(false);
  const [newSessionKind, setNewSessionKind] = useState<AgentSessionKind>(DEFAULT_AGENT_TOOL.id);
  const [newSessionName, setNewSessionName] = useState(DEFAULT_AGENT_TOOL.label);
  const [newSessionCommand, setNewSessionCommand] = useState(DEFAULT_AGENT_TOOL.command);
  const [renamingSessionId, setRenamingSessionId] = useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = useState('');
  const [renamingServerId, setRenamingServerId] = useState<string | undefined>(undefined);
  const [renameServerDraft, setRenameServerDraft] = useState('');
  const [logCopied, setLogCopied] = useState(false);
  const logCopyTimeoutRef = useRef<number | undefined>(undefined);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.launchBay;
    if (!bridge?.getLaunchBayConfig) {
      setConfigLoading(false);
      return undefined;
    }

    bridge.getLaunchBayConfig()
      .then((config) => {
        if (cancelled) return;
        if (JSON.stringify(launchConfig) !== JSON.stringify(config)) {
          setLaunchConfig(config);
        }
        cacheLaunchBayConfig(config);
        setConfigSyncVersion((current) => current + 1);
        const nextProjectId = config.workspaces.some((workspace) => workspace.id === projectName || workspace.name === projectName) ? projectName : config.workspaces[0]?.id ?? '';
        setProjectName((current) => current === nextProjectId ? current : nextProjectId);
      })
      .catch((error) => {
        if (!cancelled) {
          setLaunchConfig({
            ...EMPTY_LAUNCH_BAY_CONFIG,
            error: error instanceof Error ? error.message : 'Could not load local config.'
          });
        }
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const configuredProjects = useMemo(() => launchConfig.workspaces.map((workspace) => workspaceToProject(
    workspace,
    launchConfig.servers.find((server) => server.workspaceId === workspace.id)
  )), [launchConfig.workspaces, launchConfig.servers]);
  const selectedProject = useMemo(
    () => configuredProjects.find((project) => project.id === projectName || project.name === projectName) ?? configuredProjects[0] ?? createSetupProject(),
    [configuredProjects, projectName]
  );
  const selectedWorkspace = launchConfig.workspaces.find((workspace) => workspace.id === selectedProject.id);
  const selectedWorkspaceServers = selectedWorkspace
    ? launchConfig.servers.filter((server) => server.workspaceId === selectedWorkspace.id)
    : [];
  const selectedServerId = selectedWorkspace ? selectedServerIds[selectedWorkspace.id] : undefined;
  const selectedServerConfig = selectedWorkspaceServers.find((server) => server.id === selectedServerId)
    ?? selectedWorkspaceServers[0];
  const selectedServerProject = selectedWorkspace ? workspaceToProject(selectedWorkspace, selectedServerConfig) : selectedProject;
  const selectedRuntimeId = selectedServerConfig?.id ?? selectedProject.id;
  const hasProjects = launchConfig.workspaces.length > 0;
  const hasConfiguredServer = Boolean(selectedServerConfig);
  const runtimeSnapshot = runtimeSnapshots[selectedRuntimeId];
  const projectBranchState = projectBranches[selectedRuntimeId];
  const currentStatus = runtimeSnapshot?.status ?? selectedServerProject.status;
  const currentLog = runtimeSnapshot?.log || selectedServerProject.log;
  const currentBranch = runtimeSnapshot?.branch ?? projectBranchState?.current;
  const currentDirty = runtimeSnapshot?.dirty ?? projectBranchState?.dirty;
  const branchSubtitle = currentBranch
    ? currentDirty
      ? `${currentBranch} · dirty`
      : currentBranch
    : undefined;
  const runtimeBridge = window.launchBay;
  const hasRuntimeBridge = Boolean(
    runtimeBridge &&
      typeof runtimeBridge.startProject === 'function' &&
      typeof runtimeBridge.stopProject === 'function' &&
      typeof runtimeBridge.getRuntimeStatus === 'function' &&
      typeof runtimeBridge.onRuntimeUpdate === 'function'
  );
  const hasHermesBridge = Boolean(
    runtimeBridge &&
      typeof runtimeBridge.sendHermesMessage === 'function' &&
      typeof runtimeBridge.getHermesSession === 'function' &&
      typeof runtimeBridge.onHermesUpdate === 'function'
  );
  const hasOpenLocalUrlBridge = Boolean(runtimeBridge && typeof runtimeBridge.openLocalUrl === 'function');
  const hasEmbeddedTerminalBridge = Boolean(
    runtimeBridge &&
      typeof runtimeBridge.createTerminal === 'function' &&
      typeof runtimeBridge.writeTerminal === 'function' &&
      typeof runtimeBridge.killTerminal === 'function'
  );
  const hasBranchBridge = Boolean(
    runtimeBridge &&
      typeof runtimeBridge.listProjectBranches === 'function' &&
      typeof runtimeBridge.fetchProjectBranches === 'function' &&
      typeof runtimeBridge.switchProjectBranch === 'function' &&
      typeof runtimeBridge.mergeProjectBranch === 'function'
  );
  const canOpenLocalUrl = hasOpenLocalUrlBridge && isOpenableLocalUrl(selectedServerProject.url);
  const hermesSnapshot = hermesSnapshots[selectedProject.id] ?? EMPTY_HERMES;
  const isHermesThinking = hermesSnapshot.pending;
  const hermesElapsed = formatElapsed(elapsedSeconds);
  const contextUsageLabel = formatContextUsage(hermesSnapshot.contextUsage);
  const displayedLog = hasRuntimeBridge
    ? currentLog
    : `${currentLog}\n\n[runtime] Local process controls require the Launch Bay Electron window. If you are seeing this in a browser preview, switch to the desktop app. If you are seeing it in Electron, restart Launch Bay with pnpm dev so the preload bridge is rebuilt.`;
  const clearedBaseline = clearedLogBaselines[selectedRuntimeId] ?? '';
  const visibleLog = clearedBaseline && displayedLog.startsWith(clearedBaseline)
    ? displayedLog.slice(clearedBaseline.length)
    : displayedLog;
  const projectTerminals = embeddedTerminals[selectedRuntimeId] ?? [];
  const projectAgentSessions = agentSessions[selectedProject.id] ?? [];
  const selectedAgentSession = projectAgentSessions.find((session) => session.id === selectedAgentSessionId);
  const branchOptions = projectBranchState?.branches ?? [];
  const branchFilter = branchFilters[selectedRuntimeId] ?? '';
  const normalizedBranchFilter = branchFilter.trim().toLowerCase();
  const visibleBranches = normalizedBranchFilter
    ? branchOptions.filter((branch) =>
        [branch.name, branch.upstream, branch.lastCommit]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(normalizedBranchFilter))
      )
    : branchOptions;
  const isGitBusy = activeGitOperation?.projectId === selectedRuntimeId;
  const branchControlStatus = !hasBranchBridge
    ? 'Unavailable'
    : !projectBranchState
      ? 'Loading'
      : projectBranchState.error
        ? 'Unavailable'
        : projectBranchState.dirty
          ? 'Dirty'
          : 'Clean';
  const branchControlUnavailableReason = !hasBranchBridge
    ? 'Restart Launch Bay to load the branch-control bridge for this window.'
    : !projectBranchState
      ? 'Loading local branches from git…'
      : projectBranchState.error
        ? projectBranchState.error
        : branchOptions.length === 0
          ? 'No local branches were returned for this repository.'
          : undefined;
  const branchFallbackOption = !hasBranchBridge
    ? 'Restart Launch Bay to enable branch control'
    : !projectBranchState
      ? 'Loading branches…'
      : 'No branches found';
  const canSwitchBranches = Boolean(
    hasBranchBridge &&
      projectBranchState &&
      !projectBranchState.error &&
      branchOptions.length > 0 &&
      !projectBranchState.dirty &&
      currentStatus !== 'running' &&
      !isGitBusy
  );
  const canFetchBranches = Boolean(hasBranchBridge && projectBranchState && !projectBranchState.error && !isGitBusy);
  const canMergeBranches = canSwitchBranches;
  const activeGitOperationLabel = isGitBusy ? formatGitOperationLabel(activeGitOperation) : undefined;
  const branchConfigWarning = branchControlUnavailableReason ?? (projectBranchState?.dirty
    ? 'Commit or stash before switching branches.'
    : currentStatus === 'running'
      ? 'Stop the server before switching branches.'
      : projectBranchState?.error);
  const defaultHermesSessionId = createDefaultHermesSessionId(selectedProject.id);
  const defaultHermesSessionName = defaultHermesSessionNames[selectedProject.id] ?? 'Hermes';
  const defaultHermesPrompt = selectedProject.prompt.replace('Hermes', defaultHermesSessionName);
  const agentToolOptions = availableAgentTools.length > 0 ? availableAgentTools : [DEFAULT_AGENT_TOOL];

  useEffect(() => {
    safeWriteStorage(WORKSPACE_PROJECT_STORAGE_KEY, selectedProject.id);
  }, [selectedProject.id]);

  useEffect(() => {
    safeWriteStorage(WORKSPACE_SURFACE_STORAGE_KEY, surface);
  }, [surface]);

  useEffect(() => {
    let cancelled = false;
    window.launchBay?.detectAgentCliTools?.()
      .then((tools) => {
        if (cancelled || tools.length === 0) return;
        const supportedTools = tools.filter((tool): tool is SupportedAgentCliTool => isSupportedAgentSessionKind(tool.id));
        if (supportedTools.length === 0) return;
        setAvailableAgentTools(supportedTools);
        setNewSessionKind((currentKind) => supportedTools.some((tool) => tool.id === currentKind) ? currentKind : supportedTools[0].id);
        setNewSessionName((currentName) => currentName.trim() ? currentName : supportedTools[0].label);
        setNewSessionCommand((currentCommand) => currentCommand.trim() ? currentCommand : supportedTools[0].command);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.launchBay?.onRuntimeUpdate((event) => {
      setRuntimeSnapshots((current) => ({ ...current, [event.projectId]: event.snapshot }));
    });
  }, []);

  useEffect(() => {
    return window.launchBay?.onHermesUpdate((event) => {
      setHermesSnapshots((current) => ({ ...current, [event.projectId]: event.snapshot }));
      setPendingStartedAt((current) => {
        if (event.snapshot.pending) {
          return current[event.projectId] ? current : { ...current, [event.projectId]: Date.now() };
        }

        const next = { ...current };
        delete next[event.projectId];
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return window.launchBay?.onTerminalData?.((event) => {
      setEmbeddedTerminals((current) => {
        const next = { ...current };
        for (const [projectId, terminals] of Object.entries(current)) {
          const index = terminals.findIndex((terminal) => terminal.id === event.id);
          if (index === -1) continue;
          next[projectId] = terminals.map((terminal, itemIndex) =>
            itemIndex === index ? { ...terminal, output: `${terminal.output}${event.data}` } : terminal
          );
          break;
        }
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return window.launchBay?.onTerminalExit?.((event) => {
      setEmbeddedTerminals((current) => {
        const next = { ...current };
        for (const [projectId, terminals] of Object.entries(current)) {
          if (!terminals.some((terminal) => terminal.id === event.id)) continue;
          next[projectId] = terminals.map((terminal) =>
            terminal.id === event.id
              ? { ...terminal, status: 'exited', output: `${terminal.output}\n[terminal exited${event.exitCode !== undefined ? ` ${event.exitCode}` : ''}]\n` }
              : terminal
          );
          break;
        }
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return window.launchBay?.onHermesInstanceUpdate?.((event) => {
      setAgentSessions((current) => {
        const sessions = current[event.projectId] ?? [];
        return {
          ...current,
          [event.projectId]: sessions.map((session) =>
            session.id === event.instanceId ? { ...session, snapshot: event.snapshot } : session
          )
        };
      });
    });
  }, []);

  useEffect(() => {
    const bridge = window.launchBay;
    if (!bridge?.getRuntimeStatus) return undefined;

    let cancelled = false;
    const projectId = selectedRuntimeId;

    const refreshRuntimeStatus = () => {
      bridge.getRuntimeStatus(projectId)
        .then((snapshot) => {
          if (!cancelled) {
            setRuntimeSnapshots((current) => ({ ...current, [projectId]: snapshot }));
          }
        })
        .catch(() => {
          // Non-configured projects are allowed at this stage; they keep their static placeholder state.
        });
    };

    refreshRuntimeStatus();
    const intervalId = window.setInterval(refreshRuntimeStatus, RUNTIME_STATUS_REFRESH_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshRuntimeStatus();
    };

    window.addEventListener('focus', refreshRuntimeStatus);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshRuntimeStatus);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [selectedRuntimeId, configSyncVersion]);

  useEffect(() => {
    const bridge = window.launchBay;
    if (!bridge?.listProjectBranches) return undefined;

    let cancelled = false;
    const projectId = selectedRuntimeId;

    bridge.listProjectBranches(projectId)
      .then((branchState) => {
        if (cancelled) return;
        setProjectBranches((current) => ({ ...current, [projectId]: branchState }));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [selectedRuntimeId, configSyncVersion]);

  useEffect(() => {
    if (!hasHermesBridge) return undefined;
    let cancelled = false;
    const projectId = selectedProject.id;

    window.launchBay!.getHermesSession(projectId)
      .then((snapshot) => {
        if (cancelled) return;
        setHermesSnapshots((current) => {
          if (current[projectId] !== undefined) return current;
          return { ...current, [projectId]: snapshot };
        });
        setPendingStartedAt((current) => {
          if (snapshot.pending && !current[projectId]) {
            return { ...current, [projectId]: Date.now() };
          }
          return current;
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [hasHermesBridge, selectedProject.id]);

  useEffect(() => {
    if (!isHermesThinking) {
      setElapsedSeconds(0);
      return undefined;
    }

    const startedAt = pendingStartedAt[selectedProject.id] ?? Date.now();
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);

    return () => window.clearInterval(intervalId);
  }, [isHermesThinking, pendingStartedAt, selectedProject.id]);

  useEffect(() => {
    const subscribe = window.launchBay?.onHermesPermissionRequired;
    if (!subscribe) return undefined;
    return subscribe((payload) => setPendingPermission(payload));
  }, []);

  useEffect(() => {
    const lister = window.launchBay?.listHermesSkills;
    if (!lister) return;
    let cancelled = false;
    lister()
      .then((result) => {
        if (!cancelled) setHermesSkills(result.skills);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cwd = selectedProject.cwd;
    if (!cwd) return;
    if (projectFiles[cwd]) return;
    const lister = window.launchBay?.listProjectFiles;
    if (!lister) return;
    let cancelled = false;
    lister(cwd)
      .then((result) => {
        if (!cancelled) setProjectFiles((current) => ({ ...current, [cwd]: result.files }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedProject.cwd, projectFiles]);

  useEffect(() => {
    function handleGlobalShortcut(event: globalThis.KeyboardEvent) {
      if (event.key !== 'k' && event.key !== 'K') return;
      if (event.shiftKey || event.altKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setSurface('hermes');
      window.setTimeout(() => composerInputRef.current?.focus(), 0);
    }

    window.addEventListener('keydown', handleGlobalShortcut);
    return () => window.removeEventListener('keydown', handleGlobalShortcut);
  }, []);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [hermesSnapshot.messages, isHermesThinking, selectedProject.id]);

  useEffect(() => {
    if (surface !== 'server') return;
    const log = logRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [surface, visibleLog, selectedRuntimeId]);

  useEffect(() => {
    return () => {
      if (logCopyTimeoutRef.current !== undefined) window.clearTimeout(logCopyTimeoutRef.current);
    };
  }, []);

  function selectProject(id: string) {
    setProjectName(id);
    setDraft('');
    if (surface === 'agent-session') {
      setSurface('hermes');
      setSelectedAgentSessionId(undefined);
    }
  }

  function selectServer(serverId: string) {
    if (!selectedWorkspace) return;
    setSelectedServerIds((current) => ({ ...current, [selectedWorkspace.id]: serverId }));
    setSurface('server');
  }

  function applyRuntimeSnapshot(snapshot: RuntimeSnapshot, runtimeId = selectedRuntimeId) {
    setRuntimeSnapshots((current) => ({ ...current, [runtimeId]: snapshot }));
  }

  function openNewServerModal() {
    const nextForm = createEmptyServerForm(launchConfig.workspaces, selectedWorkspace?.id);
    setServerForm(nextForm);
    if (nextForm.cwd) void inspectServerFormDirectory(nextForm.cwd);
  }

  async function openProjectFolder() {
    const bridge = window.launchBay;
    if (!bridge?.chooseServerDirectory || !bridge.saveWorkspace) return;
    const result = await bridge.chooseServerDirectory();
    const chosenPath = result.path;
    if (result.canceled || !chosenPath) return;
    const name = basenameFromPath(chosenPath) || 'Local project';
    try {
      const saved = await bridge.saveWorkspace({ name, cwd: chosenPath });
      setLaunchConfig(saved);
      cacheLaunchBayConfig(saved);
      setConfigSyncVersion((current) => current + 1);
      const newWorkspace = saved.workspaces.find((workspace) => workspace.cwd === chosenPath && workspace.name === name)
        ?? saved.workspaces[saved.workspaces.length - 1];
      if (newWorkspace) {
        setProjectName(newWorkspace.id);
        setSurface('hermes');
      }
    } catch (error) {
      setLaunchConfig((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Could not save project folder.'
      }));
    }
  }

  function editSelectedServer() {
    if (!selectedServerConfig) return;
    setServerForm({
      mode: 'edit',
      id: selectedServerConfig.id,
      workspaceId: selectedServerConfig.workspaceId,
      workspaceName: '',
      name: selectedServerConfig.name,
      cwd: selectedServerConfig.cwd,
      command: selectedServerConfig.command,
      url: selectedServerConfig.url ?? '',
      description: selectedServerConfig.description ?? ''
    });
  }

  async function inspectServerFormDirectory(path: string) {
    if (!path.trim()) return;
    if (!window.launchBay?.inspectServerDirectory) return;
    const inspection = await window.launchBay.inspectServerDirectory(path);
    setServerForm((current) => {
      if (!current) return current;
      const workspace = launchConfig.workspaces.find((item) => item.id === current.workspaceId);
      const defaults = current.mode === 'create' ? inspection.serverDefaults : undefined;
      const canReplaceDefaultName = current.mode === 'create' && (!current.name.trim() || current.name === workspace?.name);
      return {
        ...current,
        cwd: inspection.path,
        inspection,
        name: canReplaceDefaultName ? defaults?.name ?? current.name : current.name,
        command: current.mode === 'create' && !current.command.trim() ? defaults?.command ?? current.command : current.command,
        url: current.mode === 'create' && !current.url.trim() ? defaults?.url ?? current.url : current.url,
        description: current.mode === 'create' && !current.description.trim() ? defaults?.description ?? current.description : current.description
      };
    });
  }

  async function chooseServerDirectory() {
    if (!window.launchBay?.chooseServerDirectory) return;
    const result = await window.launchBay.chooseServerDirectory();
    const chosenPath = result.path;
    if (result.canceled || !chosenPath) return;
    setServerForm((current) => current ? { ...current, cwd: chosenPath } : current);
    await inspectServerFormDirectory(chosenPath);
  }

  async function saveServerForm() {
    const form = serverForm;
    if (!form || !window.launchBay?.saveServerConfig) return;
    const name = form.name.trim();
    const cwd = form.cwd.trim();
    if (!name || !cwd) {
      setServerForm({ ...form, error: 'Server name and working directory are required.' });
      return;
    }

    setSavingServer(true);
    try {
      let nextConfig = launchConfig;
      let workspaceId = form.workspaceId;
      if (workspaceId === '__new__') {
        if (!window.launchBay?.saveWorkspace) throw new Error('Workspace bridge is unavailable.');
        const workspaceName = form.workspaceName.trim() || 'My workspace';
        nextConfig = await window.launchBay.saveWorkspace({ name: workspaceName, cwd });
        workspaceId = nextConfig.workspaces[nextConfig.workspaces.length - 1]?.id ?? workspaceId;
      }
      const saved = await window.launchBay.saveServerConfig({
        id: form.id,
        workspaceId,
        name,
        cwd,
        command: form.command.trim(),
        url: form.url.trim() || undefined,
        description: form.description.trim() || undefined
      });
      setLaunchConfig(saved);
      cacheLaunchBayConfig(saved);
      setConfigSyncVersion((current) => current + 1);
      const server = saved.servers.find((item) => item.id === form.id) ?? saved.servers[saved.servers.length - 1];
      if (server) {
        setSelectedServerIds((current) => ({ ...current, [server.workspaceId]: server.id }));
        setProjectName(server.workspaceId);
        setSurface('server');
      }
      setServerForm(undefined);
    } catch (error) {
      setServerForm({ ...form, error: error instanceof Error ? error.message : 'Could not save server.' });
    } finally {
      setSavingServer(false);
    }
  }

  async function startServer() {
    if (window.launchBay?.startProject) {
      applyRuntimeSnapshot(await window.launchBay.startProject(selectedRuntimeId));
      return;
    }

    applyRuntimeSnapshot({
      status: 'stopped',
      log: `${selectedServerProject.log}\n\n[runtime] Local process controls require the Launch Bay Electron window. If you are seeing this in a browser preview, switch to the desktop app. If you are seeing it in Electron, restart Launch Bay with pnpm dev so the preload bridge is rebuilt.`
    });
  }

  async function stopServer() {
    if (window.launchBay?.stopProject) {
      applyRuntimeSnapshot(await window.launchBay.stopProject(selectedRuntimeId));
      return;
    }

    applyRuntimeSnapshot({
      status: 'stopped',
      log: `${currentLog}\n[process] stop requested\n`
    });
  }

  async function runGitOperation(action: GitOperation, branch?: string) {
    const projectId = selectedRuntimeId;
    const bridge = window.launchBay;
    if (action === 'fetch' && !bridge?.fetchProjectBranches) return;
    if (action === 'switch' && (!bridge?.switchProjectBranch || !branch)) return;
    if (action === 'merge' && (!bridge?.mergeProjectBranch || !branch)) return;

    setActiveGitOperation({ projectId, action, branch });
    try {
      const branchState = action === 'fetch'
        ? await bridge!.fetchProjectBranches!(projectId)
        : action === 'switch'
          ? await bridge!.switchProjectBranch!(projectId, branch!)
          : await bridge!.mergeProjectBranch!(projectId, branch!);
      setProjectBranches((current) => ({ ...current, [projectId]: branchState }));
      if (branchState.runtime) {
        setRuntimeSnapshots((current) => ({ ...current, [projectId]: branchState.runtime! }));
      }
    } finally {
      setActiveGitOperation((current) => current?.projectId === projectId && current.action === action && current.branch === branch ? undefined : current);
    }
  }

  function requestMergeBranch(sourceBranch: string) {
    const targetBranch = projectBranchState?.current;
    if (!targetBranch || sourceBranch === targetBranch || !canMergeBranches) return;
    setMergeConfirmation({ projectId: selectedRuntimeId, sourceBranch, targetBranch });
  }

  async function confirmMergeBranch() {
    const confirmation = mergeConfirmation;
    if (!confirmation) return;
    setMergeConfirmation(undefined);
    await runGitOperation('merge', confirmation.sourceBranch);
  }

  async function openEmbeddedTerminal() {
    if (!window.launchBay?.createTerminal) return;
    const terminal = await window.launchBay.createTerminal(selectedRuntimeId, selectedServerProject.cwd);
    setEmbeddedTerminals((current) => ({
      ...current,
      [selectedRuntimeId]: [
        ...(current[selectedRuntimeId] ?? []),
        { ...terminal, output: '', status: 'running' }
      ]
    }));
  }

  async function killEmbeddedTerminal(id: string) {
    await window.launchBay?.killTerminal?.(id);
    setEmbeddedTerminals((current) => ({
      ...current,
      [selectedRuntimeId]: (current[selectedRuntimeId] ?? []).map((terminal) =>
        terminal.id === id ? { ...terminal, status: 'exited' } : terminal
      )
    }));
  }

  async function closeEmbeddedTerminal(id: string) {
    await window.launchBay?.killTerminal?.(id);
    setEmbeddedTerminals((current) => ({
      ...current,
      [selectedRuntimeId]: (current[selectedRuntimeId] ?? []).filter((terminal) => terminal.id !== id)
    }));
  }

  function writeEmbeddedTerminal(id: string, data: string) {
    void window.launchBay?.writeTerminal?.(id, data);
  }

  function resizeEmbeddedTerminal(id: string, cols: number, rows: number) {
    void window.launchBay?.resizeTerminal?.(id, cols, rows);
  }

  function openNewSessionModal() {
    const preset = agentToolOptions[0];
    setNewSessionKind(preset.id);
    setNewSessionName(preset.label);
    setNewSessionCommand(preset.command);
    setNewSessionModalOpen(true);
  }

  function handleNewSessionKindChange(value: string) {
    if (!isSupportedAgentSessionKind(value)) return;
    const preset = getAgentSessionPreset(value, agentToolOptions);
    setNewSessionKind(value);
    setNewSessionName(preset.label);
    setNewSessionCommand(preset.command);
  }

  function selectDefaultHermesSession() {
    setSelectedAgentSessionId(undefined);
    setSurface('hermes');
  }

  function beginRenameDefaultHermesSession() {
    setRenamingSessionId(defaultHermesSessionId);
    setRenameDraft(defaultHermesSessionName);
  }

  async function createAgentSession() {
    const preset = getAgentSessionPreset(newSessionKind, agentToolOptions);
    const name = newSessionName.trim() || preset.label;
    const command = newSessionCommand.trim() || preset.command;
    const instance = newSessionKind === 'hermes' && window.launchBay?.createHermesInstance
      ? await window.launchBay.createHermesInstance(selectedProject.id)
      : {
          id: createLocalAgentSessionId(newSessionKind),
          projectId: selectedProject.id,
          title: name,
          snapshot: EMPTY_HERMES
        };
    const session: AgentSession = {
      ...instance,
      kind: newSessionKind,
      name,
      command,
      title: name,
      draft: ''
    };

    setAgentSessions((current) => ({
      ...current,
      [selectedProject.id]: [...(current[selectedProject.id] ?? []), session]
    }));
    setSelectedAgentSessionId(session.id);
    setSurface('agent-session');
    setNewSessionModalOpen(false);
  }

  function selectAgentSession(sessionId: string) {
    setSelectedAgentSessionId(sessionId);
    setSurface('agent-session');
  }

  function beginRenameAgentSession(session: AgentSession) {
    setRenamingSessionId(session.id);
    setRenameDraft(session.name);
  }

  function cancelRenameSession() {
    setRenamingSessionId(undefined);
    setRenameDraft('');
  }

  function commitRenameAgentSession() {
    if (!renamingSessionId) return;
    const nextName = renameDraft.trim();
    if (renamingSessionId === defaultHermesSessionId) {
      if (nextName) {
        setDefaultHermesSessionNames((current) => ({ ...current, [selectedProject.id]: nextName }));
      }
      setRenamingSessionId(undefined);
      setRenameDraft('');
      return;
    }
    setAgentSessions((current) => ({
      ...current,
      [selectedProject.id]: (current[selectedProject.id] ?? []).map((session) =>
        session.id === renamingSessionId && nextName ? { ...session, name: nextName, title: nextName } : session
      )
    }));
    setRenamingSessionId(undefined);
    setRenameDraft('');
  }

  function beginRenameServer(serverId: string, currentName: string) {
    setRenamingServerId(serverId);
    setRenameServerDraft(currentName);
  }

  function cancelRenameServer() {
    setRenamingServerId(undefined);
    setRenameServerDraft('');
  }

  async function commitRenameServer() {
    if (!renamingServerId) return;
    const nextName = renameServerDraft.trim();
    const server = launchConfig.servers.find((item) => item.id === renamingServerId);
    if (!server || !nextName || nextName === server.name || !window.launchBay?.saveServerConfig) {
      setRenamingServerId(undefined);
      setRenameServerDraft('');
      return;
    }
    try {
      const saved = await window.launchBay.saveServerConfig({ ...server, name: nextName });
      setLaunchConfig(saved);
      cacheLaunchBayConfig(saved);
    } catch {
      // Ignore — user can retry. Worst case, the rename input simply closes without effect.
    }
    setRenamingServerId(undefined);
    setRenameServerDraft('');
  }

  function setAgentSessionDraft(sessionId: string, value: string) {
    setAgentSessions((current) => ({
      ...current,
      [selectedProject.id]: (current[selectedProject.id] ?? []).map((session) =>
        session.id === sessionId ? { ...session, draft: value } : session
      )
    }));
  }

  async function sendAgentSessionMessage(sessionId: string) {
    const session = projectAgentSessions.find((item) => item.id === sessionId);
    const text = session?.draft.trim() ?? '';
    if (!text || session?.snapshot.pending || session?.kind !== 'hermes' || !window.launchBay?.sendHermesInstanceMessage) return;
    const userMessage: HermesMessage = { id: `agent-${Date.now()}`, role: 'user', text };
    setAgentSessions((current) => ({
      ...current,
      [selectedProject.id]: (current[selectedProject.id] ?? []).map((item) =>
        item.id === sessionId
          ? { ...item, draft: '', snapshot: { ...item.snapshot, messages: [...item.snapshot.messages, userMessage], pending: true, error: undefined } }
          : item
      )
    }));
    const snapshot = await window.launchBay.sendHermesInstanceMessage(sessionId, text);
    setAgentSessions((current) => ({
      ...current,
      [selectedProject.id]: (current[selectedProject.id] ?? []).map((item) =>
        item.id === sessionId ? { ...item, snapshot } : item
      )
    }));
  }

  async function resetAgentSession(sessionId: string) {
    const session = projectAgentSessions.find((item) => item.id === sessionId);
    if (!session) return;
    const snapshot = session.kind === 'hermes'
      ? await window.launchBay?.resetHermesInstance?.(sessionId)
      : EMPTY_HERMES;
    if (!snapshot) return;
    setAgentSessions((current) => ({
      ...current,
      [selectedProject.id]: (current[selectedProject.id] ?? []).map((item) =>
        item.id === sessionId ? { ...item, draft: '', snapshot } : item
      )
    }));
  }

  async function closeAgentSession(sessionId: string) {
    const session = projectAgentSessions.find((item) => item.id === sessionId);
    if (session?.kind === 'hermes') await window.launchBay?.closeHermesInstance?.(sessionId);
    setAgentSessions((current) => ({
      ...current,
      [selectedProject.id]: (current[selectedProject.id] ?? []).filter((item) => item.id !== sessionId)
    }));
    if (selectedAgentSessionId === sessionId) {
      setSelectedAgentSessionId(undefined);
      setSurface('hermes');
    }
  }

  async function openLocalUrl() {
    if (!canOpenLocalUrl) return;
    await window.launchBay?.openLocalUrl?.(selectedServerProject.url);
  }

  async function copyLog() {
    const clipboard = window.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return;
    try {
      await clipboard.writeText(visibleLog);
      setLogCopied(true);
      if (logCopyTimeoutRef.current !== undefined) window.clearTimeout(logCopyTimeoutRef.current);
      logCopyTimeoutRef.current = window.setTimeout(() => setLogCopied(false), 1600);
    } catch {
      // Stay silent per UX guidance — keep label as Copy log.
    }
  }

  function clearLog() {
    setClearedLogBaselines((current) => ({ ...current, [selectedRuntimeId]: displayedLog }));
  }

  async function sendHermes() {
    if (!hasHermesBridge || isHermesThinking) return;
    const projectId = selectedProject.id;
    const text = draft.trim();
    const attachments = hermesAttachments[projectId] ?? [];
    const resources = hermesResources[projectId] ?? [];
    if (!text && attachments.length === 0 && resources.length === 0) return;

    setDraft('');
    setHermesAttachments((current) => ({ ...current, [projectId]: [] }));
    setHermesResources((current) => ({ ...current, [projectId]: [] }));
    const startedAt = Date.now();
    const userMessage: HermesMessage = {
      id: `local-${startedAt}`,
      role: 'user',
      text,
      images: attachments.length > 0 ? attachments : undefined,
      resources: resources.length > 0 ? resources : undefined
    };

    setPendingStartedAt((current) => ({ ...current, [projectId]: startedAt }));
    setHermesSnapshots((current) => {
      const previous = current[projectId] ?? EMPTY_HERMES;
      return {
        ...current,
        [projectId]: {
          messages: [...previous.messages, userMessage],
          pending: true,
          contextUsage: previous.contextUsage
        }
      };
    });

    try {
      // Call with a minimal arity when no attachments are present so older
      // bridge consumers (and the existing test mocks) still see the
      // original `(projectId, text)` shape.
      const snapshot =
        attachments.length === 0 && resources.length === 0
          ? await window.launchBay!.sendHermesMessage(projectId, text)
          : await window.launchBay!.sendHermesMessage(
              projectId,
              text,
              attachments.length > 0 ? attachments : undefined,
              resources.length > 0 ? resources : undefined
            );
      setHermesSnapshots((current) => ({ ...current, [projectId]: snapshot }));
    } catch (error) {
      setHermesSnapshots((current) => {
        const previous = current[projectId] ?? EMPTY_HERMES;
        return {
          ...current,
          [projectId]: {
            messages: previous.messages,
            pending: false,
            error: error instanceof Error ? error.message : 'Hermes request failed',
            contextUsage: previous.contextUsage
          }
        };
      });
    } finally {
      setPendingStartedAt((current) => {
        const next = { ...current };
        delete next[projectId];
        return next;
      });
    }
  }

  async function resetHermesSession() {
    if (!hasHermesBridge) return;
    const projectId = selectedProject.id;
    setDraft('');
    setPendingStartedAt((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });

    try {
      const snapshot = await window.launchBay!.resetHermesSession(projectId);
      setHermesSnapshots((current) => ({ ...current, [projectId]: snapshot }));
    } catch (error) {
      setHermesSnapshots((current) => ({
        ...current,
        [projectId]: {
          messages: [],
          pending: false,
          error: error instanceof Error ? error.message : 'Hermes session reset failed'
        }
      }));
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        workspaces={launchConfig.workspaces}
        servers={launchConfig.servers}
        projectServers={selectedWorkspaceServers}
        selectedServerId={selectedServerConfig?.id}
        configuredProjects={configuredProjects}
        selectedProject={selectedProject}
        runtimeSnapshots={runtimeSnapshots}
        surface={surface}
        hasProjects={hasProjects}
        hasHermesBridge={hasHermesBridge}
        canOpenProjectFolder={Boolean(window.launchBay?.chooseServerDirectory && window.launchBay?.saveWorkspace)}
        defaultHermesSessionId={defaultHermesSessionId}
        defaultHermesSessionName={defaultHermesSessionName}
        projectAgentSessions={projectAgentSessions}
        selectedAgentSessionId={selectedAgentSessionId}
        renamingSessionId={renamingSessionId}
        renameDraft={renameDraft}
        renamingServerId={renamingServerId}
        renameServerDraft={renameServerDraft}
        agentToolOptions={agentToolOptions}
        onResetHermesSession={() => void resetHermesSession()}
        onOpenProjectFolder={() => void openProjectFolder()}
        onSelectProject={selectProject}
        onDeleteWorkspace={(id) => {
          const workspace = launchConfig.workspaces.find((item) => item.id === id);
          if (workspace) setWorkspaceToDelete(workspace);
        }}
        onOpenServerSurface={() => setSurface('server')}
        onOpenNewSessionModal={openNewSessionModal}
        onOpenNewServerModal={openNewServerModal}
        onSelectDefaultHermesSession={selectDefaultHermesSession}
        onBeginRenameDefaultHermesSession={beginRenameDefaultHermesSession}
        onSelectAgentSession={selectAgentSession}
        onBeginRenameAgentSession={beginRenameAgentSession}
        onCommitRenameSession={commitRenameAgentSession}
        onCancelRenameSession={cancelRenameSession}
        onRenameDraftChange={setRenameDraft}
        onSelectServer={selectServer}
        onBeginRenameServer={beginRenameServer}
        onCommitRenameServer={() => void commitRenameServer()}
        onCancelRenameServer={cancelRenameServer}
        onRenameServerDraftChange={setRenameServerDraft}
        getAgentSessionPresetLabel={(kind) => getAgentSessionPreset(kind as AgentSessionKind, agentToolOptions).label}
      />

      <main className="main" style={{ overflowX: 'hidden', overflowY: 'auto' }}>
        {!hasProjects ? (
          <section className="setup-view" aria-label="Launch Bay setup">
            <div className="setup-card">
              <div className="context">Local-first setup</div>
              <h1>Open your first project</h1>
              <p>Choose a local folder first. Sessions and servers are created from that project context.</p>
              {launchConfig.error ? <div className="config-warning" role="alert">{launchConfig.error}</div> : null}
              {!window.launchBay?.getLaunchBayConfig ? (
                <div className="config-warning" role="status">Local config requires the Electron window. Browser preview stays empty by design.</div>
              ) : null}
              <button className="primary" type="button" onClick={() => void openProjectFolder()} disabled={!window.launchBay?.chooseServerDirectory || !window.launchBay?.saveWorkspace || configLoading}>Open project folder</button>
            </div>
          </section>
        ) : surface === 'hermes' ? (
          <HermesChatView
            projectName={selectedProject.name}
            projectSuggestions={selectedProject.suggestions}
            sessionName={defaultHermesSessionName}
            sessionPrompt={defaultHermesPrompt}
            snapshot={hermesSnapshot}
            isThinking={isHermesThinking}
            elapsedLabel={hermesElapsed}
            contextUsageLabel={contextUsageLabel}
            hasHermesBridge={hasHermesBridge}
            draft={draft}
            onDraftChange={setDraft}
            onSend={() => void sendHermes()}
            onReset={() => {
              if (hermesSnapshot.messages.length === 0) {
                void resetHermesSession();
                return;
              }
              setResetConfirmOpen(true);
            }}
            composerInputRef={composerInputRef}
            transcriptRef={transcriptRef}
            attachments={hermesAttachments[selectedProject.id] ?? []}
            resources={hermesResources[selectedProject.id] ?? []}
            onAddAttachments={(items) =>
              setHermesAttachments((current) => ({
                ...current,
                [selectedProject.id]: [...(current[selectedProject.id] ?? []), ...items]
              }))
            }
            onAddResources={(items) =>
              setHermesResources((current) => ({
                ...current,
                [selectedProject.id]: [...(current[selectedProject.id] ?? []), ...items]
              }))
            }
            onRemoveAttachment={(id) =>
              setHermesAttachments((current) => ({
                ...current,
                [selectedProject.id]: (current[selectedProject.id] ?? []).filter((item) => item.id !== id)
              }))
            }
            onRemoveResource={(id) =>
              setHermesResources((current) => ({
                ...current,
                [selectedProject.id]: (current[selectedProject.id] ?? []).filter((item) => item.id !== id)
              }))
            }
            onPickAttachment={async () => {
              const picker = window.launchBay?.chooseAttachmentFile;
              if (!picker) return undefined;
              const result = await picker();
              if (result.canceled) return undefined;
              if (result.image) return { kind: 'image', image: result.image };
              if (result.resource) return { kind: 'resource', resource: result.resource };
              return undefined;
            }}
            onCancel={() => {
              const cancel = window.launchBay?.cancelHermesPrompt;
              if (cancel) void cancel(selectedProject.id);
            }}
            onOpenHistory={
              window.launchBay?.listHermesSessions && window.launchBay?.resumeHermesSession
                ? () => setPastSessionsOpen(true)
                : undefined
            }
            approvalMode={approvalMode}
            onApprovalModeChange={
              window.launchBay?.setHermesApprovalMode
                ? (mode) => {
                    setApprovalMode(mode);
                    void window.launchBay?.setHermesApprovalMode?.(mode);
                  }
                : undefined
            }
            projectFiles={projectFiles[selectedProject.cwd] ?? []}
            skills={hermesSkills}
            onMentionFile={
              window.launchBay?.readProjectFile && selectedProject.cwd
                ? async (relativePath) => {
                    const reader = window.launchBay?.readProjectFile;
                    if (!reader) return undefined;
                    const result = await reader(selectedProject.cwd, relativePath);
                    if (!result.text) return undefined;
                    return {
                      id: `mention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      // Prefer the absolute URI returned by the main process
                      // (cross-platform via url.pathToFileURL). Fall back to
                      // a synthesised URI if the bridge didn't supply one.
                      uri: result.uri ?? `attachment://${relativePath}`,
                      mimeType: 'text/plain',
                      name: relativePath,
                      text: result.text,
                      sizeBytes: result.sizeBytes
                    };
                  }
                : undefined
            }
          />
        ) : surface === 'agent-session' && selectedAgentSession ? (
          <AgentSessionView
            projectName={selectedProject.name}
            session={selectedAgentSession}
            toolLabel={getAgentSessionPreset(selectedAgentSession.kind, agentToolOptions).label}
            onDraftChange={(value) => setAgentSessionDraft(selectedAgentSession.id, value)}
            onSend={() => void sendAgentSessionMessage(selectedAgentSession.id)}
            onReset={() => void resetAgentSession(selectedAgentSession.id)}
            onClose={() => void closeAgentSession(selectedAgentSession.id)}
          />
        ) : (
          <ServerView
            projectName={selectedProject.name}
            projectCommand={selectedServerProject.command}
            projectCwd={selectedServerProject.cwd}
            projectUrl={selectedServerProject.url}
            projectSubtitle={selectedServerProject.serverSub}
            currentStatus={currentStatus}
            currentPid={runtimeSnapshot?.pid}
            branchSubtitle={branchSubtitle}
            visibleLog={visibleLog}
            logRef={logRef}
            logCopied={logCopied}
            hasConfiguredServer={hasConfiguredServer}
            hasRuntimeBridge={hasRuntimeBridge}
            hasEmbeddedTerminalBridge={hasEmbeddedTerminalBridge}
            canOpenLocalUrl={canOpenLocalUrl}
            projectBranchState={projectBranchState}
            visibleBranches={visibleBranches}
            branchOptions={branchOptions}
            branchControlStatus={branchControlStatus}
            branchControlRepoCwd={projectBranchState?.cwd ?? selectedServerProject.cwd}
            branchFilter={branchFilter}
            branchFallbackOption={branchFallbackOption}
            branchConfigWarning={branchConfigWarning}
            activeGitOperation={activeGitOperation?.projectId === selectedRuntimeId ? activeGitOperation : undefined}
            activeGitOperationLabel={activeGitOperationLabel}
            canSwitchBranches={canSwitchBranches}
            canFetchBranches={canFetchBranches}
            canMergeBranches={canMergeBranches}
            hasBranchBridge={hasBranchBridge}
            projectTerminals={projectTerminals}
            onEditServer={editSelectedServer}
            onNewServer={openNewServerModal}
            onStart={() => void startServer()}
            onStop={() => void stopServer()}
            onOpenLocalUrl={() => void openLocalUrl()}
            onRunGitOperation={(action, branch) => void runGitOperation(action, branch)}
            onRequestMergeBranch={requestMergeBranch}
            onBranchFilterChange={(value) => setBranchFilters((current) => ({ ...current, [selectedRuntimeId]: value }))}
            onCopyLog={() => void copyLog()}
            onClearLog={clearLog}
            onOpenEmbeddedTerminal={() => void openEmbeddedTerminal()}
            onWriteTerminal={writeEmbeddedTerminal}
            onResizeTerminal={resizeEmbeddedTerminal}
            onKillTerminal={(id) => void killEmbeddedTerminal(id)}
            onCloseTerminal={(id) => void closeEmbeddedTerminal(id)}
          />
        )}
      </main>
      {mergeConfirmation ? (
        <MergeConfirmationModal
          projectName={selectedProject.name}
          sourceBranch={mergeConfirmation.sourceBranch}
          targetBranch={mergeConfirmation.targetBranch}
          onCancel={() => setMergeConfirmation(undefined)}
          onConfirm={() => void confirmMergeBranch()}
        />
      ) : null}
      {resetConfirmOpen ? (
        <ConfirmModal
          title="Reset Hermes session?"
          description="This clears the current conversation. The underlying Hermes session is dropped and a new one starts on the next message."
          confirmLabel="Reset"
          destructive
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={() => {
            setResetConfirmOpen(false);
            void resetHermesSession();
          }}
        />
      ) : null}
      {workspaceToDelete ? (() => {
        const linkedServers = launchConfig.servers.filter((s) => s.workspaceId === workspaceToDelete.id);
        const description = linkedServers.length === 0
          ? 'The project is unlinked from Launch Bay. Files on disk are untouched.'
          : `${linkedServers.length} server${linkedServers.length === 1 ? '' : 's'} under this project will be removed first (${linkedServers.map((s) => s.name).join(', ')}). Files on disk are untouched.`;
        return (
          <ConfirmModal
            title={`Remove "${workspaceToDelete.name}" from Launch Bay?`}
            description={description}
            confirmLabel="Remove project"
            destructive
            onCancel={() => setWorkspaceToDelete(undefined)}
            onConfirm={async () => {
              const target = workspaceToDelete;
              const servers = linkedServers;
              setWorkspaceToDelete(undefined);
              const bridge = window.launchBay;
              if (!bridge?.deleteWorkspace || !bridge.deleteServerConfig) {
                console.warn('[launch-bay] delete bridges missing');
                return;
              }
              try {
                let next: LaunchBayConfig | undefined;
                for (const server of servers) {
                  next = await bridge.deleteServerConfig(server.id);
                }
                next = await bridge.deleteWorkspace(target.id);
                setLaunchConfig(next);
                if (selectedProject.id === target.id) {
                  const fallback = next.workspaces[0];
                  if (fallback) selectProject(fallback.id);
                }
              } catch (error) {
                console.error('[launch-bay] deleteWorkspace failed', error);
              }
            }}
          />
        );
      })() : null}
      {pendingPermission ? (
        <HermesPermissionModal
          request={pendingPermission}
          onRespond={(optionId) => {
            const responder = window.launchBay?.respondToHermesPermission;
            if (responder) void responder(pendingPermission.requestId, optionId);
            setPendingPermission(undefined);
          }}
        />
      ) : null}
      {pastSessionsOpen ? (
        <PastSessionsModal
          projectName={selectedProject.name}
          cwd={selectedProject.cwd}
          load={async () => {
            const lister = window.launchBay?.listHermesSessions;
            if (!lister) return [];
            const result = await lister(selectedProject.cwd || undefined);
            return result.sessions;
          }}
          onCancel={() => setPastSessionsOpen(false)}
          onSelect={async (sessionId) => {
            setPastSessionsOpen(false);
            const resume = window.launchBay?.resumeHermesSession;
            if (!resume) return;
            try {
              const snapshot = await resume(selectedProject.id, sessionId);
              setHermesSnapshots((current) => ({ ...current, [selectedProject.id]: snapshot }));
            } catch {
              // ignore — server-side load_session may have failed; the user can retry.
            }
          }}
        />
      ) : null}
      {serverForm ? (
        <ServerFormModal
          form={serverForm}
          workspaces={launchConfig.workspaces}
          saving={savingServer}
          hasChooseDirBridge={Boolean(window.launchBay?.chooseServerDirectory)}
          onChange={setServerForm}
          onClose={() => setServerForm(undefined)}
          onChooseDirectory={() => void chooseServerDirectory()}
          onInspectDirectory={(path) => void inspectServerFormDirectory(path)}
          onSave={() => void saveServerForm()}
        />
      ) : null}
      {newSessionModalOpen ? (
        <NewSessionModal
          projectName={selectedProject.name}
          toolOptions={agentToolOptions}
          kind={newSessionKind}
          name={newSessionName}
          command={newSessionCommand}
          onKindChange={handleNewSessionKindChange}
          onNameChange={setNewSessionName}
          onCommandChange={setNewSessionCommand}
          onCancel={() => setNewSessionModalOpen(false)}
          onCreate={() => void createAgentSession()}
        />
      ) : null}
    </div>
  );
}

export default App;
