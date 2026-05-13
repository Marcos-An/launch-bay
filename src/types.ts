export type RuntimeStatus = 'running' | 'stopped';

export type RuntimeSnapshot = {
  status: RuntimeStatus;
  log: string;
  branch?: string;
  dirty?: boolean;
  pid?: number;
  error?: string;
};

export type RuntimeUpdate = {
  projectId: string;
  snapshot: RuntimeSnapshot;
};

export type GitBranchInfo = {
  name: string;
  current?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  lastCommit?: string;
};

export type ProjectBranchState = {
  cwd: string;
  current?: string;
  dirty?: boolean;
  branches: GitBranchInfo[];
  error?: string;
  runtime?: RuntimeSnapshot;
};

export type LocalUserProfile = {
  id: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
  onboardingCompleted: boolean;
};

export type WorkspaceConfig = {
  id: string;
  name: string;
  cwd: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type ServerConfig = {
  id: string;
  workspaceId: string;
  name: string;
  cwd: string;
  command: string;
  url?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type LaunchBayConfig = {
  version: 1;
  localUser: LocalUserProfile;
  workspaces: WorkspaceConfig[];
  servers: ServerConfig[];
  error?: string;
};

export type WorkspaceDraft = Partial<WorkspaceConfig> & Pick<WorkspaceConfig, 'name' | 'cwd'>;
export type ServerDraft = Partial<ServerConfig> & Pick<ServerConfig, 'workspaceId' | 'name' | 'cwd'>;

export type ServerDefaults = {
  name?: string;
  command?: string;
  url?: string;
  description?: string;
};

export type DirectoryInspection = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepository: boolean;
  branch?: string;
  dirty?: boolean;
  error?: string;
  serverDefaults?: ServerDefaults;
};

export type HermesMessageRole = 'user' | 'assistant';

export type HermesToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type HermesToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type HermesToolCallLocation = { path: string; line?: number };

export type HermesToolCallDiff = {
  path: string;
  oldText?: string;
  newText: string;
};

export type HermesToolCall = {
  id: string;
  title: string;
  kind?: HermesToolKind;
  status: HermesToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: HermesToolCallLocation[];
  diffs?: HermesToolCallDiff[];
};

export type HermesImageAttachment = {
  id?: string;
  /** Base64-encoded image payload (no `data:` prefix). */
  data: string;
  mimeType: string;
  /** Display name shown in the composer; absent for pasted clipboard images. */
  name?: string;
  uri?: string;
};

export type HermesResourceAttachment = {
  id?: string;
  uri: string;
  mimeType?: string;
  name?: string;
  text?: string;
  blob?: string;
  sizeBytes?: number;
};

export type ChooseAttachmentFileResult = {
  canceled: boolean;
  image?: HermesImageAttachment;
  resource?: HermesResourceAttachment;
  error?: string;
};

export type ChooseImageFileResult = {
  canceled: boolean;
  image?: HermesImageAttachment;
  error?: string;
};

export type HermesMessage = {
  id: string;
  role: HermesMessageRole;
  text: string;
  toolCalls?: HermesToolCall[];
  images?: HermesImageAttachment[];
  resources?: HermesResourceAttachment[];
};

export type HermesContextUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextLength?: number;
  percent?: number;
};

export type HermesAvailableCommand = {
  name: string;
  description: string;
};

export type HermesSessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
};

export type HermesPermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

export type HermesPermissionRequest = {
  requestId: string;
  sessionId: string;
  toolCallId?: string;
  toolTitle?: string;
  toolKind?: HermesToolKind;
  toolRawInput?: unknown;
  toolLocations?: HermesToolCallLocation[];
  toolDiffs?: HermesToolCallDiff[];
  options: HermesPermissionOption[];
};

export type HermesPlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export type HermesPlanEntry = {
  content: string;
  status?: HermesPlanEntryStatus;
  priority?: 'low' | 'medium' | 'high';
};

export type HermesSnapshot = {
  messages: HermesMessage[];
  pending: boolean;
  error?: string;
  contextUsage?: HermesContextUsage;
  availableCommands?: HermesAvailableCommand[];
  plan?: HermesPlanEntry[];
};

export type HermesUpdate = {
  projectId: string;
  snapshot: HermesSnapshot;
};

export type TerminalSnapshot = {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
};

export type TerminalDataEvent = { id: string; data: string };
export type TerminalExitEvent = { id: string; exitCode?: number; signal?: string };

export type HermesInstanceSnapshot = {
  id: string;
  projectId: string;
  title: string;
  snapshot: HermesSnapshot;
};

export type HermesInstanceUpdate = {
  instanceId: string;
  projectId: string;
  snapshot: HermesSnapshot;
};

export type AgentCliTool = {
  id: string;
  label: string;
  command: string;
  path?: string;
  version?: string;
};

export type LaunchBayBridge = {
  openLocalUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
  getLaunchBayConfig: () => Promise<LaunchBayConfig>;
  saveWorkspace: (draft: WorkspaceDraft) => Promise<LaunchBayConfig>;
  deleteWorkspace: (workspaceId: string) => Promise<LaunchBayConfig>;
  saveServerConfig: (draft: ServerDraft) => Promise<LaunchBayConfig>;
  deleteServerConfig: (serverId: string) => Promise<LaunchBayConfig>;
  chooseServerDirectory: () => Promise<{ canceled: boolean; path?: string }>;
  inspectServerDirectory: (path: string) => Promise<DirectoryInspection>;
  getRuntimeStatus: (projectId: string) => Promise<RuntimeSnapshot>;
  startProject: (projectId: string) => Promise<RuntimeSnapshot>;
  stopProject: (projectId: string) => Promise<RuntimeSnapshot>;
  listProjectBranches: (projectId: string) => Promise<ProjectBranchState>;
  fetchProjectBranches: (projectId: string) => Promise<ProjectBranchState>;
  switchProjectBranch: (projectId: string, branch: string) => Promise<ProjectBranchState>;
  mergeProjectBranch: (projectId: string, branch: string) => Promise<ProjectBranchState>;
  onRuntimeUpdate: (callback: (event: RuntimeUpdate) => void) => () => void;
  sendHermesMessage: (
    projectId: string,
    text: string,
    attachments?: HermesImageAttachment[],
    resources?: HermesResourceAttachment[]
  ) => Promise<HermesSnapshot>;
  getHermesSession: (projectId: string) => Promise<HermesSnapshot>;
  resetHermesSession: (projectId: string) => Promise<HermesSnapshot>;
  cancelHermesPrompt?: (projectId: string) => Promise<{ ok: boolean }>;
  chooseImageFile?: () => Promise<ChooseImageFileResult>;
  chooseAttachmentFile?: () => Promise<ChooseAttachmentFileResult>;
  listHermesSessions?: (cwd?: string) => Promise<{
    sessions: HermesSessionInfo[];
    nextCursor?: string;
  }>;
  resumeHermesSession?: (projectId: string, sessionId: string) => Promise<HermesSnapshot>;
  listProjectFiles?: (cwd: string) => Promise<{ files: string[] }>;
  listHermesSkills?: () => Promise<{
    skills: { name: string; description: string }[];
    error?: string;
  }>;
  readProjectFile?: (
    cwd: string,
    relativePath: string
  ) => Promise<{ text?: string; sizeBytes?: number; uri?: string; error?: string }>;
  setHermesApprovalMode?: (mode: 'auto' | 'manual') => Promise<{ ok: boolean }>;
  respondToHermesPermission?: (requestId: string, optionId: string | null) => Promise<{ ok: boolean }>;
  onHermesPermissionRequired?: (callback: (payload: HermesPermissionRequest) => void) => () => void;
  onHermesUpdate: (callback: (event: HermesUpdate) => void) => () => void;
  createTerminal: (projectId: string, cwd: string) => Promise<TerminalSnapshot>;
  writeTerminal: (id: string, data: string) => Promise<{ ok: boolean }>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<{ ok: boolean }>;
  killTerminal: (id: string) => Promise<{ ok: boolean }>;
  listTerminals: (projectId: string) => Promise<TerminalSnapshot[]>;
  onTerminalData: (callback: (event: TerminalDataEvent) => void) => () => void;
  onTerminalExit: (callback: (event: TerminalExitEvent) => void) => () => void;
  createHermesInstance: (projectId: string) => Promise<HermesInstanceSnapshot>;
  listHermesInstances: (projectId: string) => Promise<HermesInstanceSnapshot[]>;
  sendHermesInstanceMessage: (
    instanceId: string,
    text: string,
    attachments?: HermesImageAttachment[],
    resources?: HermesResourceAttachment[]
  ) => Promise<HermesSnapshot>;
  resetHermesInstance: (instanceId: string) => Promise<HermesSnapshot>;
  closeHermesInstance: (instanceId: string) => Promise<{ ok: boolean }>;
  cancelHermesInstancePrompt?: (instanceId: string) => Promise<{ ok: boolean }>;
  onHermesInstanceUpdate: (callback: (event: HermesInstanceUpdate) => void) => () => void;
  detectAgentCliTools: () => Promise<AgentCliTool[]>;
};
