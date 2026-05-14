import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loginShellInvocation, whichCommand } from './platform.js';
import { HermesAcpProcess } from './hermes/hermesAcpProcess.js';
import {
  HermesSessionManager,
  type HermesImageAttachment,
  type HermesResourceAttachment
} from './hermes/hermesClient.js';
import { HermesInstanceManager } from './hermes/hermesInstanceManager.js';
import { createHermesSessionStore } from './hermes/hermesSessionStore.js';
import { parseHermesSkillsList } from './hermes/hermesSkills.js';
import { createLocalConfigStore, type LaunchBayConfig, type ServerDraft, type WorkspaceDraft } from './config/localConfigStore.js';
import { inspectServerDirectory } from './config/directoryInspection.js';
import { PROJECT_RUNTIME_CONFIGS, ProjectRuntimeManager, createProjectRuntimeConfig, expandHome, listInstalledNvmNodeVersions } from './runtime/projectRuntime.js';
import { TerminalManager } from './runtime/terminalManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);
const isDev = process.env.VITE_DEV_SERVER_URL || !app.isPackaged;
const runtimeManager = new ProjectRuntimeManager([]);
// Hermes project context is populated from the user's local workspaces
// loaded via getLocalConfigStore() at startup (see loadLaunchBayConfig).
const projectHermesContexts: Record<string, { name: string; cwd: string }> = Object.fromEntries(
  PROJECT_RUNTIME_CONFIGS.map((config) => [
    config.id,
    { name: config.id, cwd: expandHome(config.cwd.split(' + ')[0].trim()) }
  ])
);
function readHermesEnv() {
  const envPath = join(homedir(), '.hermes', '.env');
  if (!existsSync(envPath)) return {} as Record<string, string>;

  const values: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [rawKey, ...rawValueParts] = trimmed.split('=');
    const key = rawKey.trim();
    const rawValue = rawValueParts.join('=').trim();
    values[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
  return values;
}

const hermesEnv = readHermesEnv();
function hermesEnvValue(key: string) {
  return process.env[key] ?? hermesEnv[key];
}

function parseContextLength(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isAbsolutePath(value: string): boolean {
  // Accept POSIX absolute (`/`), Windows drive letter (`C:\`) and UNC (`\\server`)
  return /^([a-zA-Z]:[\\\/]|\\\\|\/)/.test(value);
}

async function resolveHermesBinary(): Promise<string | undefined> {
  const explicit = hermesEnvValue('HERMES_BIN');
  if (explicit && isAbsolutePath(explicit)) return explicit;
  try {
    const { stdout } = await runLoginShell(whichCommand(explicit ?? 'hermes'));
    const first = stdout.trim().split(/\r?\n/)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}

const hermesAcp = new HermesAcpProcess({
  command: hermesEnvValue('HERMES_BIN') ?? 'hermes',
  resolveBin: resolveHermesBinary
});

const hermesSharedOptions = {
  acp: hermesAcp,
  contextLength: parseContextLength(hermesEnvValue('HERMES_CONTEXT_LENGTH')),
  projectContexts: projectHermesContexts
};

const hermesManager = new HermesSessionManager(hermesSharedOptions);
const terminalManager = new TerminalManager();
const serverTerminalIds = new Map<string, string>();
let localConfigStore: ReturnType<typeof createLocalConfigStore> | undefined;
let hermesInstanceManager: HermesInstanceManager | undefined;

function getHermesInstanceManager(): HermesInstanceManager {
  if (!hermesInstanceManager) {
    hermesInstanceManager = new HermesInstanceManager({
      ...hermesSharedOptions,
      persistence: createHermesSessionStore(app.getPath('userData'))
    });
    hermesInstanceManager.onUpdate((event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('launch-bay:hermes-instance-update', event);
      }
    });
  }
  return hermesInstanceManager;
}

function getLocalConfigStore() {
  localConfigStore ??= createLocalConfigStore(app.getPath('userData'));
  return localConfigStore;
}

function syncRuntimeConfigs(config: LaunchBayConfig) {
  const workspaceConfigs = config.workspaces.map((workspace) => createProjectRuntimeConfig({
    id: workspace.id,
    cwd: workspace.cwd,
    command: ''
  }));
  const serverConfigs = config.servers.map((server) => createProjectRuntimeConfig(server));
  runtimeManager.setConfigs([...workspaceConfigs, ...serverConfigs]);
}

function loadLaunchBayConfig() {
  const config = getLocalConfigStore().load();
  syncRuntimeConfigs(config);
  return config;
}

type SupportedAgentCli = {
  id: string;
  label: string;
  command: string;
};

type DetectedAgentCliTool = SupportedAgentCli & {
  path: string;
  version?: string;
};

const SUPPORTED_AGENT_CLIS: SupportedAgentCli[] = [
  { id: 'hermes', label: 'Hermes', command: 'hermes' },
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'gemini', label: 'Gemini', command: 'gemini' },
  { id: 'aider', label: 'Aider', command: 'aider' }
];

async function runLoginShell(command: string) {
  const { command: shell, args } = loginShellInvocation();
  return execFile(shell, [...args, command], { timeout: 2500 });
}

async function detectAgentCliTool(tool: SupportedAgentCli): Promise<DetectedAgentCliTool | undefined> {
  try {
    const { stdout } = await runLoginShell(whichCommand(tool.command));
    const path = stdout.trim().split(/\r?\n/)[0];
    if (!path) return undefined;
    let version: string | undefined;
    try {
      // `head -n 1` is POSIX-only; on Windows we let the shell return the
      // whole stdout and slice the first line ourselves.
      const result = await runLoginShell(
        process.platform === 'win32' ? `${tool.command} --version` : `${tool.command} --version 2>&1 | head -n 1`
      );
      version = result.stdout.trim().split(/\r?\n/)[0] || undefined;
    } catch {
      version = undefined;
    }
    return { ...tool, path, version };
  } catch {
    return undefined;
  }
}

async function detectAgentCliTools() {
  const tools = await Promise.all(SUPPORTED_AGENT_CLIS.map((tool) => detectAgentCliTool(tool)));
  return tools.filter((tool): tool is DetectedAgentCliTool => Boolean(tool));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1430,
    height: 900,
    backgroundColor: '#171717',
    title: 'Launch Bay',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173');
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'));
  }
}

runtimeManager.onUpdate((event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('launch-bay:runtime-update', event);
  }
});

hermesManager.onUpdate((event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('launch-bay:hermes-update', event);
  }
});

terminalManager.onData((event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('launch-bay:terminal-data', event);
  }
});

terminalManager.onExit((event) => {
  if (serverTerminalIds.get(event.projectId) === event.id) {
    serverTerminalIds.delete(event.projectId);
    runtimeManager.markStopped(event.projectId);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('launch-bay:terminal-exit', event);
  }
});

ipcMain.handle('launch-bay:runtime-status', async (_event, projectId: string) => runtimeManager.getSnapshot(projectId));
ipcMain.handle('launch-bay:start-project', async (_event, projectId: string) => {
  const existingTerminalId = serverTerminalIds.get(projectId);
  const existingTerminal = existingTerminalId
    ? terminalManager.list(projectId).find((terminal) => terminal.id === existingTerminalId)
    : undefined;
  const launch = runtimeManager.prepareTerminalLaunch(projectId);
  if (!launch.cwd || !launch.command || !launch.env || launch.snapshot.status !== 'running') return launch.snapshot;

  const terminal = existingTerminal ?? terminalManager.create(projectId, launch.cwd, {
    env: launch.env,
    title: `${basename(launch.cwd)} terminal`
  });
  serverTerminalIds.set(projectId, terminal.id);
  const snapshot = runtimeManager.attachTerminal(projectId, terminal, launch.command);
  terminalManager.write(terminal.id, `${launch.command}\r`);
  return snapshot;
});
ipcMain.handle('launch-bay:stop-project', async (_event, projectId: string) => {
  const terminalId = serverTerminalIds.get(projectId);
  if (terminalId) terminalManager.write(terminalId, '\x03');
  return runtimeManager.markStopped(projectId);
});
ipcMain.handle('launch-bay:nvm-node-versions', async () => ({ versions: listInstalledNvmNodeVersions() }));

ipcMain.handle(
  'launch-bay:hermes-send',
  async (
    _event,
    projectId: string,
    text: string,
    attachments?: HermesImageAttachment[],
    resources?: HermesResourceAttachment[]
  ) =>
    hermesManager.send(projectId, text, {
      images: sanitizeAttachments(attachments),
      resources: sanitizeResources(resources)
    })
);
ipcMain.handle('launch-bay:hermes-session', async (_event, projectId: string) => hermesManager.getSnapshot(projectId));
ipcMain.handle('launch-bay:hermes-reset', async (_event, projectId: string) => hermesManager.reset(projectId));
ipcMain.handle('launch-bay:hermes-cancel', async (_event, projectId: string) => {
  hermesManager.cancel(projectId);
  return { ok: true };
});
ipcMain.handle('launch-bay:hermes-sessions-list', async (_event, cwd?: string) =>
  hermesAcp.listSessions(cwd ? { cwd } : undefined)
);

// Listing files under a project cwd. Used by the composer's @-mention.
// Prefer `git ls-files` (fast and respects .gitignore) and fall back to a
// shallow walk when the cwd is not a git repository.
// Best-effort parser for `hermes skills list --enabled-only`. Force a wide
// table so long skill names remain valid slash commands instead of being
// truncated with `…` by the CLI renderer.
ipcMain.handle('launch-bay:list-hermes-skills', async () => {
  try {
    const hermesBin = await resolveHermesBinary();
    if (!hermesBin) return { skills: [], error: 'Hermes CLI not found' };
    const { stdout } = await execFile(hermesBin, ['skills', 'list', '--enabled-only'], {
      env: { ...process.env, COLUMNS: '240' },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 4_000
    });
    return { skills: parseHermesSkillsList(stdout) };
  } catch (error) {
    return { skills: [], error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('launch-bay:list-project-files', async (_event, cwd: string) => {
  if (typeof cwd !== 'string' || !cwd) return { files: [] };
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'ls-files'], { maxBuffer: 8 * 1024 * 1024 });
    const files = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 5000);
    return { files };
  } catch {
    return { files: [] };
  }
});

ipcMain.handle('launch-bay:read-project-file', async (_event, cwd: string, relativePath: string) => {
  if (typeof cwd !== 'string' || typeof relativePath !== 'string' || !cwd || !relativePath) {
    return { error: 'invalid-arguments' };
  }
  // Reject traversal — only allow relative paths that resolve inside cwd.
  const resolved = join(cwd, relativePath);
  if (!resolved.startsWith(cwd)) return { error: 'invalid-path' };
  try {
    const stats = statSync(resolved);
    if (!stats.isFile()) return { error: 'not-a-file' };
    if (stats.size > IMAGE_ATTACHMENT_LIMIT_BYTES) return { error: 'too-large' };
    const text = readFileSync(resolved, 'utf8');
    return { text, sizeBytes: stats.size, uri: pathToFileURL(resolved).toString() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle(
  'launch-bay:hermes-resume-session',
  async (_event, projectId: string, sessionId: string) =>
    hermesManager.resume(projectId, sessionId)
);
ipcMain.handle('launch-bay:hermes-approval-mode', async (_event, mode: 'auto' | 'manual') => {
  hermesAcp.setApprovalMode(mode);
  return { ok: true };
});
ipcMain.handle(
  'launch-bay:hermes-approval-respond',
  async (_event, requestId: string, optionId: string | null) => {
    hermesAcp.respondToPermission(requestId, optionId);
    return { ok: true };
  }
);

hermesAcp.on('permission-required', (payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('launch-bay:hermes-permission-required', payload);
  }
});

ipcMain.handle('launch-bay:hermes-instance-create', async (_event, projectId: string) =>
  getHermesInstanceManager().create(projectId)
);
ipcMain.handle('launch-bay:hermes-instance-list', async (_event, projectId: string) =>
  getHermesInstanceManager().list(projectId)
);
ipcMain.handle(
  'launch-bay:hermes-instance-send',
  async (
    _event,
    instanceId: string,
    text: string,
    attachments?: HermesImageAttachment[],
    resources?: HermesResourceAttachment[]
  ) =>
    getHermesInstanceManager().send(instanceId, text, {
      images: sanitizeAttachments(attachments),
      resources: sanitizeResources(resources)
    })
);
ipcMain.handle('launch-bay:hermes-instance-reset', async (_event, instanceId: string) =>
  getHermesInstanceManager().reset(instanceId)
);
ipcMain.handle('launch-bay:hermes-instance-close', async (_event, instanceId: string) => ({
  ok: getHermesInstanceManager().close(instanceId)
}));
ipcMain.handle('launch-bay:hermes-instance-cancel', async (_event, instanceId: string) => ({
  ok: getHermesInstanceManager().cancel(instanceId)
}));

ipcMain.handle('launch-bay:terminal-create', async (_event, projectId: string, cwd: string) =>
  terminalManager.create(projectId, cwd)
);
ipcMain.handle('launch-bay:terminal-write', async (_event, id: string, data: string) => ({
  ok: terminalManager.write(id, data)
}));
ipcMain.handle('launch-bay:terminal-resize', async (_event, id: string, cols: number, rows: number) => ({
  ok: terminalManager.resize(id, cols, rows)
}));
ipcMain.handle('launch-bay:terminal-kill', async (_event, id: string) => ({
  ok: terminalManager.kill(id)
}));
ipcMain.handle('launch-bay:terminal-list', async (_event, projectId: string) =>
  terminalManager.list(projectId)
);
ipcMain.handle('launch-bay:config-get', async () => loadLaunchBayConfig());
ipcMain.handle('launch-bay:workspace-save', async (_event, draft: WorkspaceDraft) => {
  const config = getLocalConfigStore().saveWorkspace(draft);
  syncRuntimeConfigs(config);
  return config;
});
ipcMain.handle('launch-bay:workspace-delete', async (_event, workspaceId: string) => {
  const config = getLocalConfigStore().deleteWorkspace(workspaceId);
  syncRuntimeConfigs(config);
  return config;
});
ipcMain.handle('launch-bay:server-config-save', async (_event, draft: ServerDraft) => {
  const config = getLocalConfigStore().saveServer(draft);
  syncRuntimeConfigs(config);
  return config;
});
ipcMain.handle('launch-bay:server-config-delete', async (_event, serverId: string) => {
  const config = getLocalConfigStore().deleteServer(serverId);
  syncRuntimeConfigs(config);
  return config;
});
ipcMain.handle('launch-bay:server-directory-choose', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return { canceled: result.canceled, path: result.filePaths[0] };
});
ipcMain.handle('launch-bay:server-directory-inspect', async (_event, path: string) => inspectServerDirectory(path));
ipcMain.handle('launch-bay:agent-cli-tools', async () => detectAgentCliTools());
ipcMain.handle('launch-bay:project-branches', async (_event, projectId: string) => runtimeManager.listBranches(projectId));
ipcMain.handle('launch-bay:project-branches-fetch', async (_event, projectId: string) => runtimeManager.fetchBranches(projectId));
ipcMain.handle('launch-bay:project-branch-switch', async (_event, projectId: string, branch: string) =>
  runtimeManager.switchBranch(projectId, branch)
);
ipcMain.handle('launch-bay:project-branch-merge', async (_event, projectId: string, branch: string) =>
  runtimeManager.mergeBranch(projectId, branch)
);
ipcMain.handle('launch-bay:project-git-snapshot', async (_event, projectId: string) => runtimeManager.getGitSnapshot(projectId));
ipcMain.handle('launch-bay:project-file-diff', async (_event, projectId: string, filePath: string, kind?: 'worktree' | 'staged' | 'untracked') =>
  runtimeManager.getFileDiff(projectId, filePath, kind)
);

function isLocalBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

ipcMain.handle('launch-bay:open-local-url', async (_event, url: string) => {
  if (!isLocalBrowserUrl(url)) return { ok: false, error: 'invalid-local-url' };
  await shell.openExternal(url);
  return { ok: true };
});

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'svg'];
const TEXT_EXTENSIONS = [
  'md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'toml', 'ini', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
  'fish', 'sql', 'gql', 'graphql', 'proto', 'lock', 'gitignore', 'gitattributes',
  'dockerfile', 'rst', 'tex'
];
const BLOB_EXTENSIONS = ['pdf'];
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql'
};
// 10 MiB is the upper bound a single image attachment may take. Past that the
// JSON-RPC payload grows large enough to slow Hermes' stdio handling and risks
// blowing the renderer/main IPC buffer.
const IMAGE_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;

function sanitizeAttachments(attachments: HermesImageAttachment[] | undefined): HermesImageAttachment[] {
  if (!Array.isArray(attachments)) return [];
  const out: HermesImageAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') continue;
    const data = typeof attachment.data === 'string' ? attachment.data : '';
    const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType : '';
    if (!data || !mimeType.startsWith('image/')) continue;
    if (data.length > IMAGE_ATTACHMENT_LIMIT_BYTES * 1.4) continue; // base64 overhead ~ 4/3
    out.push({
      id: typeof attachment.id === 'string' ? attachment.id : undefined,
      data,
      mimeType,
      name: typeof attachment.name === 'string' ? attachment.name : undefined,
      uri: typeof attachment.uri === 'string' ? attachment.uri : undefined
    });
  }
  return out;
}

function sanitizeResources(resources: HermesResourceAttachment[] | undefined): HermesResourceAttachment[] {
  if (!Array.isArray(resources)) return [];
  const out: HermesResourceAttachment[] = [];
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') continue;
    const uri = typeof resource.uri === 'string' ? resource.uri : '';
    if (!uri) continue;
    const text = typeof resource.text === 'string' ? resource.text : undefined;
    const blob = typeof resource.blob === 'string' ? resource.blob : undefined;
    if (text === undefined && blob === undefined) continue;
    if (text !== undefined && text.length > IMAGE_ATTACHMENT_LIMIT_BYTES) continue;
    if (blob !== undefined && blob.length > IMAGE_ATTACHMENT_LIMIT_BYTES * 1.4) continue;
    out.push({
      id: typeof resource.id === 'string' ? resource.id : undefined,
      uri,
      mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
      name: typeof resource.name === 'string' ? resource.name : undefined,
      text,
      blob,
      sizeBytes: typeof resource.sizeBytes === 'number' ? resource.sizeBytes : undefined
    });
  }
  return out;
}

function readFileAsAttachment(filePath: string) {
  const stats = statSync(filePath);
  if (!stats.isFile()) return { canceled: false, error: 'not-a-file' };
  if (stats.size > IMAGE_ATTACHMENT_LIMIT_BYTES) return { canceled: false, error: 'too-large' };
  const ext = extname(filePath).toLowerCase();
  const extNoDot = ext.replace(/^\./, '');
  const mimeType = MIME_BY_EXT[ext];
  const name = basename(filePath);
  // pathToFileURL handles Windows drive letters and backslashes correctly
  // (`C:\\repo\\x` → `file:///C:/repo/x`).
  const uri = pathToFileURL(filePath).toString();

  if (IMAGE_EXTENSIONS.includes(extNoDot)) {
    if (!mimeType) return { canceled: false, error: 'unsupported-format' };
    const buffer = readFileSync(filePath);
    return {
      canceled: false,
      image: { data: buffer.toString('base64'), mimeType, name, uri }
    };
  }
  if (TEXT_EXTENSIONS.includes(extNoDot)) {
    const text = readFileSync(filePath, 'utf8');
    return {
      canceled: false,
      resource: { uri, mimeType: mimeType ?? 'text/plain', name, text, sizeBytes: stats.size }
    };
  }
  if (BLOB_EXTENSIONS.includes(extNoDot)) {
    const buffer = readFileSync(filePath);
    return {
      canceled: false,
      resource: {
        uri,
        mimeType: mimeType ?? 'application/octet-stream',
        name,
        blob: buffer.toString('base64'),
        sizeBytes: stats.size
      }
    };
  }
  return { canceled: false, error: 'unsupported-format' };
}

ipcMain.handle('launch-bay:choose-attachment-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Attach file',
    properties: ['openFile'],
    filters: [
      { name: 'All supported', extensions: [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, ...BLOB_EXTENSIONS] },
      { name: 'Images', extensions: IMAGE_EXTENSIONS },
      { name: 'Text & code', extensions: TEXT_EXTENSIONS },
      { name: 'Documents', extensions: BLOB_EXTENSIONS }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  try {
    return readFileAsAttachment(result.filePaths[0]);
  } catch (error) {
    return { canceled: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Kept for backwards compatibility with the older preload entry that only
// surfaced image selection. New UI code should call choose-attachment-file.
ipcMain.handle('launch-bay:choose-image-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Attach image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  try {
    return readFileAsAttachment(result.filePaths[0]);
  } catch (error) {
    return { canceled: false, error: error instanceof Error ? error.message : String(error) };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  runtimeManager.stopAll();
  terminalManager.killAll();
  hermesInstanceManager?.closeAll();
  hermesAcp.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
