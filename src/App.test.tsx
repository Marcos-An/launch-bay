import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

type TestWorkspaceConfig = { id: string; name: string; cwd: string; createdAt: string; updatedAt: string; description?: string };
type TestServerConfig = { id: string; workspaceId: string; name: string; cwd: string; command: string; nodeVersion?: string; url?: string; description?: string; createdAt: string; updatedAt: string };
type TestLaunchBayConfig = {
  version: 1;
  localUser: { id: string; createdAt: string; updatedAt: string; onboardingCompleted: boolean; displayName?: string };
  workspaces: TestWorkspaceConfig[];
  servers: TestServerConfig[];
  error?: string;
};
type TestWorkspaceDraft = Partial<TestWorkspaceConfig> & Pick<TestWorkspaceConfig, 'name'>;
type TestServerDraft = Partial<TestServerConfig> & Pick<TestServerConfig, 'workspaceId' | 'name' | 'cwd'>;

function setClipboardMock(clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: clipboard
  });
}

function installLaunchBayMock(
  overrides: Partial<NonNullable<Window['launchBay']>> = {},
  cacheConfig?: TestLaunchBayConfig | false
) {
  const defaultConfig: TestLaunchBayConfig = {
    version: 1,
    localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
    workspaces: [
      { id: 'sample', name: 'Sample', cwd: '~/repos/sample-app', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'sample-stack', name: 'Sample Stack', cwd: '~/repos/sample-api + ~/repos/sample-web', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    ],
    servers: [{
      id: 'sample',
      workspaceId: 'sample',
      name: 'Sample',
      cwd: '~/repos/sample-app',
      command: 'API_SERVER=https://api.staging.example.com yarn run development',
      url: 'http://localhost:5000',
      description: 'One project command. Logs stay visible here.',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }, {
      id: 'sample-stack',
      workspaceId: 'sample-stack',
      name: 'Sample Stack',
      cwd: '~/repos/sample-api + ~/repos/sample-web',
      command: './launch sample --api --web',
      url: 'api :3333 · web :5173',
      description: 'Sample API local server.',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }]
  };
  const cachedConfig = cacheConfig === false ? undefined : cacheConfig ?? defaultConfig;
  if (cachedConfig) {
    window.localStorage.setItem('launch-bay:config-cache', JSON.stringify(cachedConfig));
  }
  let terminalCount = 0;
  let hermesInstanceCount = 0;
  const api: NonNullable<Window['launchBay']> = {
    openLocalUrl: vi.fn().mockResolvedValue({ ok: true }),
    getLaunchBayConfig: vi.fn().mockResolvedValue(defaultConfig),
    saveWorkspace: vi.fn().mockImplementation(async (draft: TestWorkspaceDraft) => ({
      ...defaultConfig,
      workspaces: [...defaultConfig.workspaces, { id: 'workspace-sample-stack', name: draft.name, cwd: draft.cwd ?? '/repos/sample-api', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
    })),
    deleteWorkspace: vi.fn().mockResolvedValue(defaultConfig),
    saveServerConfig: vi.fn().mockImplementation(async (draft: TestServerDraft) => ({
      ...defaultConfig,
      workspaces: defaultConfig.workspaces.some((workspace) => workspace.id === draft.workspaceId)
        ? defaultConfig.workspaces
        : [...defaultConfig.workspaces, { id: draft.workspaceId, name: 'Sample Stack', cwd: draft.cwd, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      servers: [...defaultConfig.servers, {
        id: draft.id ?? 'sample-api',
        workspaceId: draft.workspaceId,
        name: draft.name,
        cwd: draft.cwd,
        command: draft.command ?? '',
        nodeVersion: draft.nodeVersion,
        url: draft.url,
        description: draft.description,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    })),
    deleteServerConfig: vi.fn().mockResolvedValue(defaultConfig),
    chooseServerDirectory: vi.fn().mockResolvedValue({ canceled: false, path: '/repos/sample-api' }),
    inspectServerDirectory: vi.fn().mockResolvedValue({ path: '/repos/sample-api', exists: true, isDirectory: true, isGitRepository: true, branch: 'main', dirty: false }),
    startProject: vi.fn().mockResolvedValue({
      status: 'running',
      log: '',
      terminal: { id: 'server-term-1', projectId: 'sample', title: 'Sample terminal', cwd: '/repos/sample-app' },
      terminalCommand: 'API_SERVER=https://api.staging.example.com yarn run development'
    }),
    stopProject: vi.fn().mockResolvedValue({ status: 'stopped', log: '' }),
    getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'main', dirty: false }),
    listProjectBranches: vi.fn().mockResolvedValue({
      cwd: '/repos/sample-app',
      current: 'main',
      dirty: false,
      branches: [
        { name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 0, lastCommit: 'Update shell' },
        { name: 'feature/session-cockpit', current: false, upstream: 'origin/feature/session-cockpit', ahead: 0, behind: 2, lastCommit: 'Branch UI' }
      ]
    }),
    fetchProjectBranches: vi.fn().mockResolvedValue({
      cwd: '/repos/sample-app',
      current: 'main',
      dirty: false,
      branches: [
        { name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 0, lastCommit: 'Update shell' },
        { name: 'feature/session-cockpit', current: false, upstream: 'origin/feature/session-cockpit', ahead: 0, behind: 2, lastCommit: 'Branch UI' }
      ],
      runtime: { status: 'stopped', log: '[git] fetched remotes\n', branch: 'main', dirty: false }
    }),
    switchProjectBranch: vi.fn().mockResolvedValue({
      cwd: '/repos/sample-app',
      current: 'feature/session-cockpit',
      dirty: false,
      branches: [
        { name: 'feature/session-cockpit', current: true, upstream: 'origin/feature/session-cockpit', ahead: 0, behind: 2, lastCommit: 'Branch UI' },
        { name: 'main', current: false, upstream: 'origin/main', ahead: 1, behind: 0, lastCommit: 'Update shell' }
      ],
      runtime: { status: 'stopped', log: '[git] switched to feature/session-cockpit\n', branch: 'feature/session-cockpit', dirty: false }
    }),
    mergeProjectBranch: vi.fn().mockResolvedValue({
      cwd: '/repos/sample-app',
      current: 'main',
      dirty: false,
      branches: [
        { name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 0, lastCommit: 'Update shell' },
        { name: 'feature/session-cockpit', current: false, upstream: 'origin/feature/session-cockpit', ahead: 0, behind: 2, lastCommit: 'Branch UI' }
      ],
      runtime: { status: 'stopped', log: '[git] merged feature/session-cockpit into main\n', branch: 'main', dirty: false }
    }),
    getProjectGitSnapshot: vi.fn().mockResolvedValue({
      cwd: '/repos/sample-app',
      branch: 'main',
      headSha: 'abc123',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      isDirty: true,
      isMerging: false,
      isRebasing: false,
      isCherryPicking: false,
      files: [
        { path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true },
        { path: 'src/NewPanel.tsx', status: 'untracked', staged: false, unstaged: true }
      ],
      conflicts: []
    }),
    getProjectFileDiff: vi.fn().mockResolvedValue({
      path: 'src/App.tsx',
      kind: 'worktree',
      diff: 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    }),
    listProjectTree: vi.fn().mockResolvedValue({
      entries: [
        { path: 'src', name: 'src', type: 'directory' },
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: '.env', name: '.env', type: 'file', hidden: true, sensitive: true },
        { path: 'package.json', name: 'package.json', type: 'file' }
      ]
    }),
    readProjectRuntimeFile: vi.fn().mockImplementation(async (_projectId: string, relativePath: string) => ({
      text: relativePath === '.env' ? 'API_KEY=local-only\n' : 'export const app = 1;\n',
      sizeBytes: relativePath === '.env' ? 19 : 22,
      sensitive: relativePath === '.env'
    })),
    writeProjectRuntimeFile: vi.fn().mockResolvedValue({ ok: true, sizeBytes: 23 }),
    onRuntimeUpdate: vi.fn(() => () => undefined),
    sendHermesMessage: vi.fn().mockImplementation(async (projectId: string, text: string) => ({
      messages: [
        { id: 'u1', role: 'user', text },
        { id: 'a1', role: 'assistant', text: `Hermes reply for ${projectId}: ${text}` }
      ],
      pending: false
    })),
    getHermesSession: vi.fn().mockResolvedValue({ messages: [], pending: false }),
    resetHermesSession: vi.fn().mockResolvedValue({ messages: [], pending: false }),
    onHermesUpdate: vi.fn(() => () => undefined),
    createTerminal: vi.fn().mockImplementation(async (projectId: string, cwd: string) => {
      terminalCount += 1;
      return { id: `term-${terminalCount}`, projectId, title: `Terminal ${terminalCount} · sample-app`, cwd };
    }),
    writeTerminal: vi.fn().mockResolvedValue({ ok: true }),
    resizeTerminal: vi.fn().mockResolvedValue({ ok: true }),
    killTerminal: vi.fn().mockResolvedValue({ ok: true }),
    listTerminals: vi.fn().mockResolvedValue([]),
    onTerminalData: vi.fn(() => () => undefined),
    onTerminalExit: vi.fn(() => () => undefined),
    createHermesInstance: vi.fn().mockImplementation(async (projectId: string) => {
      hermesInstanceCount += 1;
      return { id: `hermes-${hermesInstanceCount}`, projectId, title: `Hermes ${hermesInstanceCount} · Sample`, snapshot: { messages: [], pending: false } };
    }),
    listHermesInstances: vi.fn().mockResolvedValue([]),
    sendHermesInstanceMessage: vi.fn().mockImplementation(async (_instanceId: string, text: string) => ({
      messages: [
        { id: 'iu1', role: 'user', text },
        { id: 'ia1', role: 'assistant', text: `Embedded Hermes reply: ${text}` }
      ],
      pending: false
    })),
    resetHermesInstance: vi.fn().mockResolvedValue({ messages: [], pending: false }),
    closeHermesInstance: vi.fn().mockResolvedValue({ ok: true }),
    onHermesInstanceUpdate: vi.fn(() => () => undefined),
    detectAgentCliTools: vi.fn().mockResolvedValue([
      { id: 'hermes', label: 'Hermes', command: 'hermes', path: '/usr/local/bin/hermes' },
      { id: 'claude', label: 'Claude Code', command: 'claude', path: '/usr/local/bin/claude' }
    ]),
    listHermesSkills: vi.fn().mockResolvedValue({ skills: [] }),
    listNvmNodeVersions: vi.fn().mockResolvedValue({ versions: ['22.18.0', '18.20.8'] }),
    ...overrides
  };
  window.launchBay = api;
  return api;
}

describe('Launch Bay shell', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.launchBay = undefined;
    window.localStorage.clear();
  });

  it('starts empty by asking for a project folder before showing Hermes or Server', async () => {
    window.launchBay = undefined;
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Open your first project' })).toBeInTheDocument();
    expect(screen.getByText(/Choose a local folder first/i)).toBeInTheDocument();
    expect(screen.getByText(/Browser preview stays empty by design/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Hermes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Sessions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Server runtime' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sample' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sample Stack' })).not.toBeInTheDocument();
  });

  it('creates the first local project from a selected folder before showing Hermes and Server', async () => {
    const emptyConfig: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: false },
      workspaces: [],
      servers: []
    };
    const withWorkspace: TestLaunchBayConfig = {
      ...emptyConfig,
      workspaces: [{ id: 'workspace-sample-api', name: 'sample-api', cwd: '/repos/sample-api', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(emptyConfig),
      saveWorkspace: vi.fn().mockResolvedValue(withWorkspace),
      chooseServerDirectory: vi.fn().mockResolvedValue({ canceled: false, path: '/repos/sample-api' }),
      inspectServerDirectory: vi.fn().mockResolvedValue({ path: '/repos/sample-api', exists: true, isDirectory: true, isGitRepository: true, branch: 'main', dirty: false })
    }, emptyConfig);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { name: 'Open your first project' });
    await user.click(screen.getByRole('button', { name: 'Open project folder' }));

    await waitFor(() => expect(api.saveWorkspace).toHaveBeenCalledWith({
      name: 'sample-api',
      cwd: '/repos/sample-api'
    }));
    expect(api.saveServerConfig).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'What do you want to work on?' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Message Hermes about sample-api/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Server runtime' })).toBeInTheDocument();
  });

  it('shows the active branch under Servers instead of Sessions or the project row', async () => {
    installLaunchBayMock({
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'feature/session-cockpit', dirty: true })
    });
    render(<App />);

    const serverRuntime = await screen.findByRole('group', { name: 'Server runtime' });
    expect(within(serverRuntime).getByText('feature/session-cockpit · dirty')).toBeInTheDocument();

    const sessions = screen.getByRole('group', { name: 'Sessions' });
    expect(within(sessions).queryByText('feature/session-cockpit · dirty')).not.toBeInTheDocument();

    const projectButton = screen.getAllByRole('button', { name: 'Sample' })[0];
    expect(within(projectButton).queryByText('feature/session-cockpit · dirty')).not.toBeInTheDocument();
  });

  it('shows project cwd and configure action without git branch UI when the selected project has no server yet', async () => {
    const projectOnlyConfig: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
      workspaces: [{ id: 'sample-app', name: 'sample-app', cwd: '/repos/sample-app', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      servers: []
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(projectOnlyConfig),
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'feature/project-detect', dirty: false }),
      listProjectBranches: vi.fn().mockResolvedValue({
        cwd: '/repos/sample-app',
        current: 'feature/project-detect',
        dirty: false,
        branches: [
          { name: 'feature/project-detect', current: true, upstream: 'origin/feature/project-detect' },
          { name: 'main', current: false, upstream: 'origin/main' }
        ]
      })
    }, projectOnlyConfig);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Server' }));

    expect(screen.getByRole('heading', { name: 'sample-app server' })).toBeInTheDocument();
    expect(screen.getAllByText('/repos/sample-app').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Configure server' })).toBeInTheDocument();
    expect(screen.queryByText('feature/project-detect')).not.toBeInTheDocument();
    expect(screen.queryByText('origin/main')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Project config' })).not.toBeInTheDocument();
    expect(api.getRuntimeStatus).not.toHaveBeenCalled();
    expect(api.listProjectBranches).not.toHaveBeenCalled();
  });

  it('runs and edits a configured server by server id when it differs from the workspace id', async () => {
    const config: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
      workspaces: [{ id: 'workspace-sample', name: 'Sample', cwd: '/repos/sample-app', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      servers: [{
        id: 'server-sample-web',
        workspaceId: 'workspace-sample',
        name: 'Sample Web',
        cwd: '/repos/sample-app',
        command: 'pnpm dev',
        nodeVersion: '18.20.8',
        url: 'http://localhost:5000',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(config),
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'main', dirty: false }),
      listProjectBranches: vi.fn().mockResolvedValue({ cwd: '/repos/sample-app', current: 'main', dirty: false, branches: [{ name: 'main', current: true }] }),
      startProject: vi.fn().mockResolvedValue({
        status: 'running',
        log: '',
        branch: 'main',
        dirty: false,
        terminal: { id: 'server-term-web', projectId: 'server-sample-web', title: 'Sample Web terminal', cwd: '/repos/sample-app' },
        terminalCommand: 'pnpm dev'
      })
    }, config);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Server' }));
    await waitFor(() => expect(api.getRuntimeStatus).toHaveBeenCalledWith('server-sample-web'));
    expect(screen.getByRole('button', { name: 'Edit server' })).toBeInTheDocument();
    expect(screen.getByText('v18.20.8')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add server' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Server runtime' })).getByRole('button', { name: 'New server' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit server' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit server' });
    await waitFor(() => expect(api.listNvmNodeVersions).toHaveBeenCalled());
    expect(within(dialog).getByLabelText('Server name')).toHaveValue('Sample Web');
    const nodeVersionSelect = within(dialog).getByLabelText('Node version');
    expect(nodeVersionSelect.tagName).toBe('SELECT');
    expect(nodeVersionSelect).toHaveValue('18.20.8');
    expect(within(nodeVersionSelect).getByRole('option', { name: 'Auto (.nvmrc / PATH)' })).toHaveValue('');
    expect(within(nodeVersionSelect).getByRole('option', { name: 'v22.18.0' })).toHaveValue('22.18.0');
    expect(within(nodeVersionSelect).getByRole('option', { name: 'v18.20.8' })).toHaveValue('18.20.8');
    expect(within(dialog).getByLabelText('Local URL')).toHaveValue('http://localhost:5000');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(api.startProject).toHaveBeenCalledWith('server-sample-web');
    expect(api.writeTerminal).not.toHaveBeenCalledWith('server-term-web', 'pnpm dev\r');
    expect(await screen.findByRole('region', { name: 'Sample Web terminal' })).toBeInTheDocument();
  });

  it('adds another server under the selected project and switches the Server view to it', async () => {
    const config: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
      workspaces: [{ id: 'workspace-sample', name: 'Sample', cwd: '/repos/sample-app', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      servers: [{
        id: 'server-sample-web',
        workspaceId: 'workspace-sample',
        name: 'Sample Web',
        cwd: '/repos/sample-app',
        command: 'pnpm dev',
        nodeVersion: '18.20.8',
        url: 'http://localhost:5000',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    };
    const withSecondServer: TestLaunchBayConfig = {
      ...config,
      servers: [...config.servers, {
        id: 'server-sample-storybook',
        workspaceId: 'workspace-sample',
        name: 'Sample Storybook',
        cwd: '/repos/sample-app',
        command: 'pnpm storybook',
        url: 'http://localhost:6006',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(config),
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'main', dirty: false }),
      listProjectBranches: vi.fn().mockResolvedValue({ cwd: '/repos/sample-app', current: 'main', dirty: false, branches: [{ name: 'main', current: true }] }),
      inspectServerDirectory: vi.fn().mockResolvedValue({
        path: '/repos/sample-app',
        exists: true,
        isDirectory: true,
        isGitRepository: true,
        branch: 'main',
        dirty: false
      }),
      saveServerConfig: vi.fn().mockResolvedValue(withSecondServer)
    }, config);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Server' }));
    const serverRuntimeGroup = screen.getByRole('group', { name: 'Server runtime' });
    await user.click(within(serverRuntimeGroup).getByRole('button', { name: 'New server' }));
    const dialog = await screen.findByRole('dialog', { name: 'New server' });
    await user.clear(within(dialog).getByLabelText('Server name'));
    await user.type(within(dialog).getByLabelText('Server name'), 'Sample Storybook');
    await user.clear(within(dialog).getByLabelText('Start command'));
    await user.type(within(dialog).getByLabelText('Start command'), 'pnpm storybook');
    await user.clear(within(dialog).getByLabelText('Local URL'));
    await user.type(within(dialog).getByLabelText('Local URL'), 'http://localhost:6006');
    await user.click(within(dialog).getByRole('button', { name: 'Save server' }));

    expect(api.saveServerConfig).toHaveBeenCalledWith(expect.objectContaining({
      id: undefined,
      workspaceId: 'workspace-sample',
      name: 'Sample Storybook',
      cwd: '/repos/sample-app',
      command: 'pnpm storybook',
      url: 'http://localhost:6006'
    }));
    expect(await screen.findByText('pnpm storybook')).toBeInTheDocument();
    expect(screen.getByText('http://localhost:6006')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sample Storybook' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('prefills a new server from the selected project metadata when possible', async () => {
    const projectOnlyConfig: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
      workspaces: [{
        id: 'sample-app',
        name: 'sample-app',
        cwd: '/repos/sample-app',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }],
      servers: []
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(projectOnlyConfig),
      inspectServerDirectory: vi.fn().mockResolvedValue({
        path: '/repos/sample-app',
        exists: true,
        isDirectory: true,
        isGitRepository: true,
        branch: 'feature/project-detect',
        dirty: false,
        serverDefaults: {
          name: 'sample-app',
          command: 'pnpm dev',
          url: 'http://localhost:5000',
          description: 'Client web app'
        }
      })
    }, projectOnlyConfig);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: 'sample-app' });
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Configure server' }));
    const dialog = await screen.findByRole('dialog', { name: 'New server' });

    await waitFor(() => expect(api.inspectServerDirectory).toHaveBeenCalledWith('/repos/sample-app'));
    expect(within(dialog).getByLabelText('Server name')).toHaveValue('sample-app');
    expect(within(dialog).getByLabelText('Working directory')).toHaveValue('/repos/sample-app');
    expect(within(dialog).getByLabelText('Start command')).toHaveValue('pnpm dev');
    expect(within(dialog).getByLabelText('Local URL')).toHaveValue('http://localhost:5000');
    expect(within(dialog).getByLabelText('Description')).toHaveValue('Client web app');
  });

  it('creates a server under an existing project workspace from the New server dialog', async () => {
    const emptyConfig: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
      workspaces: [{ id: 'sample-stack', name: 'Sample Stack', cwd: '/repos/sample-stack', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      servers: []
    };
    const withServer: TestLaunchBayConfig = {
      ...emptyConfig,
      servers: [{
        id: 'sample-api',
        workspaceId: 'sample-stack',
        name: 'Sample API',
        cwd: '/repos/sample-api',
        command: 'pnpm dev',
        url: 'http://localhost:3333',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(emptyConfig),
      saveServerConfig: vi.fn().mockResolvedValue(withServer)
    }, emptyConfig);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: 'Sample Stack' });
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Configure server' }));
    const dialog = await screen.findByRole('dialog', { name: 'New server' });
    await user.clear(within(dialog).getByLabelText('Server name'));
    await user.type(within(dialog).getByLabelText('Server name'), 'Sample API');
    await user.clear(within(dialog).getByLabelText('Working directory'));
    await user.type(within(dialog).getByLabelText('Working directory'), '/repos/sample-api');
    await user.type(within(dialog).getByLabelText('Start command'), 'pnpm dev');
    await user.selectOptions(within(dialog).getByLabelText('Node version'), '18.20.8');
    await user.type(within(dialog).getByLabelText('Local URL'), 'http://localhost:3333');
    await user.click(within(dialog).getByRole('button', { name: 'Save server' }));

    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(api.saveServerConfig).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'sample-stack',
      name: 'Sample API',
      cwd: '/repos/sample-api',
      command: 'pnpm dev',
      nodeVersion: '18.20.8',
      url: 'http://localhost:3333'
    }));
    expect(await screen.findByRole('heading', { name: 'Sample Stack server' })).toBeInTheDocument();
  });

  it('switches between Hermes chat and project server logs', async () => {
    installLaunchBayMock();
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByText('What do you want to work on?')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Message Hermes about Sample/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(screen.getByRole('heading', { name: 'Sample server' })).toBeInTheDocument();
    expect(screen.getByText('API_SERVER=https://api.staging.example.com yarn run development')).toBeInTheDocument();
    expect(screen.getByText('~/repos/sample-app')).toBeInTheDocument();
    expect(screen.queryByText('Ask Hermes about Sample')).not.toBeInTheDocument();
  });

  it('centers the empty Hermes prompt content in the chat surface', () => {
    installLaunchBayMock();
    render(<App />);

    expect(screen.getByText('What do you want to work on?')).toBeInTheDocument();
    expect(screen.getByText('Inspect this project context')).toBeInTheDocument();
    expect(screen.getByText('Review current branch state')).toBeInTheDocument();
  });

  it('lets the Hermes composer grow with typed lines before switching to an internal scroll', async () => {
    installLaunchBayMock();
    render(<App />);

    const input = screen.getByRole('textbox', { name: /Message Hermes about Sample/i }) as HTMLTextAreaElement;

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 96 });
    fireEvent.change(input, { target: { value: 'one\ntwo\nthree\nfour' } });
    await act(async () => {
      await Promise.resolve();
    });

    expect(input.style.height).toBe('96px');
    expect(input.style.overflowY).toBe('hidden');

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 240 });
    fireEvent.change(input, { target: { value: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten' } });
    await act(async () => {
      await Promise.resolve();
    });

    expect(input.style.height).toBe('180px');
    expect(input.style.overflowY).toBe('auto');
  });

  it('sends Hermes messages with Enter while preserving Shift+Enter for new lines', async () => {
    const api = installLaunchBayMock();
    render(<App />);

    const input = screen.getByRole('textbox', { name: /Message Hermes about Sample/i });
    fireEvent.change(input, { target: { value: 'Status please' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(api.sendHermesMessage).toHaveBeenCalledWith('sample', 'Status please');
    expect(await screen.findByText(/Hermes reply for sample: Status please/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });

    expect(api.sendHermesMessage).toHaveBeenCalledTimes(1);
  });

  it('does not submit the Hermes composer on empty, pending, or composing Enter presses', async () => {
    const api = installLaunchBayMock({
      getHermesSession: vi.fn().mockResolvedValue({ messages: [], pending: true })
    });
    render(<App />);

    const input = screen.getByRole('textbox', { name: /Message Hermes about Sample/i });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.change(input, { target: { value: 'IME text' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
    await screen.findByRole('status');
    fireEvent.change(input, { target: { value: 'pending text' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(api.sendHermesMessage).not.toHaveBeenCalled();
  });

  it('keeps the Hermes transcript scrolled to the latest message', async () => {
    installLaunchBayMock({
      getHermesSession: vi.fn().mockResolvedValue({
        messages: [
          { id: 'u-old', role: 'user', text: 'old question' },
          { id: 'a-old', role: 'assistant', text: 'old answer' }
        ],
        pending: false
      })
    });
    render(<App />);

    expect(await screen.findByText('old answer')).toBeInTheDocument();
    const transcript = document.querySelector('.chat-messages') as HTMLDivElement;
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 444 });

    fireEvent.change(screen.getByRole('textbox', { name: /Message Hermes about Sample/i }), { target: { value: 'new question' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Message Hermes about Sample/i }), { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(transcript.scrollTop).toBe(444));
  });

  it('persists and restores the last selected project and surface without saving drafts', async () => {
    installLaunchBayMock();
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    // The sidebar lists the workspace AND its server under the same name —
    // pick the workspace row (rendered first).
    await user.click(screen.getAllByRole('button', { name: 'Sample Stack' })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: /Message Hermes about Sample Stack/i }), { target: { value: 'do not save me' } });
    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(window.localStorage.getItem('launch-bay:workspace:project-id')).toBe('sample-stack');
    expect(window.localStorage.getItem('launch-bay:workspace:surface')).toBe('server');

    unmount();
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Sample Stack server' })).toBeInTheDocument();
    // Navigate back to the Hermes surface via the sidebar session entry.
    await user.click(screen.getByRole('button', { name: 'Open Hermes' }));
    expect(screen.getByRole('textbox', { name: /Message Hermes about Sample Stack/i })).toHaveValue('');
  });

  it('falls back safely when stored workspace values are stale', () => {
    window.localStorage.setItem('launch-bay:workspace:project-id', 'retired-project');
    window.localStorage.setItem('launch-bay:workspace:surface', 'billing');
    installLaunchBayMock();

    render(<App />);

    expect(screen.getByText('What do you want to work on?')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Message Hermes about Sample/i })).toBeInTheDocument();
  });

  it('keeps server command and logs scoped to the selected project', async () => {
    installLaunchBayMock();
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Sample Stack' }));
    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(screen.getByRole('heading', { name: 'Sample Stack server' })).toBeInTheDocument();
    expect(screen.getByText('./launch sample --api --web')).toBeInTheDocument();
    expect(screen.getByText('~/repos/sample-api + ~/repos/sample-web')).toBeInTheDocument();
    expect(screen.getByText('api :3333 · web :5173')).toBeInTheDocument();
  });

  it('does not show branch changes beside Hermes when the selected project has no server', async () => {
    const projectOnlyConfig: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
      workspaces: [{ id: 'sample-app', name: 'sample-app', cwd: '/repos/sample-app', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      servers: []
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(projectOnlyConfig),
      getProjectGitSnapshot: vi.fn().mockResolvedValue({
        cwd: '/repos/sample-app',
        branch: 'feature/project-only',
        headSha: 'abc123',
        isDirty: true,
        isMerging: false,
        isRebasing: false,
        isCherryPicking: false,
        files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true }],
        conflicts: []
      })
    }, projectOnlyConfig);

    render(<App />);

    expect(await screen.findByRole('textbox', { name: /Message Hermes about sample-app/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Expand changes workbench/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Changes workbench' })).not.toBeInTheDocument();
    expect(screen.queryByText('main')).not.toBeInTheDocument();
    expect(api.getProjectGitSnapshot).not.toHaveBeenCalled();
    expect(api.getRuntimeStatus).not.toHaveBeenCalled();
    expect(api.listProjectBranches).not.toHaveBeenCalled();
  });

  it('keeps Git change cards in the sidebar and opens the right-side workbench on demand', async () => {
    const config: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
      workspaces: [{ id: 'workspace-sample', name: 'Sample', cwd: '/repos/sample', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      servers: [{
        id: 'server-api',
        workspaceId: 'workspace-sample',
        name: 'Sample API',
        cwd: '/repos/sample-api',
        command: 'pnpm api',
        url: 'http://localhost:3333',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }, {
        id: 'server-web',
        workspaceId: 'workspace-sample',
        name: 'Sample Web',
        cwd: '/repos/sample-web',
        command: 'pnpm web',
        url: 'http://localhost:5173',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(config),
      getRuntimeStatus: vi.fn().mockImplementation(async (runtimeId: string) => ({
        status: 'stopped',
        log: '',
        branch: runtimeId === 'server-web' ? 'feature/web-ui' : 'feature/api-contract',
        dirty: runtimeId === 'server-web'
      })),
      listProjectBranches: vi.fn().mockImplementation(async (runtimeId: string) => ({
        cwd: runtimeId === 'server-web' ? '/repos/sample-web' : '/repos/sample-api',
        current: runtimeId === 'server-web' ? 'feature/web-ui' : 'feature/api-contract',
        dirty: runtimeId === 'server-web',
        branches: [{ name: runtimeId === 'server-web' ? 'feature/web-ui' : 'feature/api-contract', current: true }]
      })),
      getProjectGitSnapshot: vi.fn().mockImplementation(async (runtimeId: string) => ({
        cwd: runtimeId === 'server-web' ? '/repos/sample-web' : '/repos/sample-api',
        branch: runtimeId === 'server-web' ? 'feature/web-ui' : 'feature/api-contract',
        headSha: runtimeId === 'server-web' ? 'web123' : 'api123',
        upstream: runtimeId === 'server-web' ? 'origin/feature/web-ui' : 'origin/feature/api-contract',
        ahead: runtimeId === 'server-web' ? 0 : 1,
        behind: runtimeId === 'server-web' ? 2 : 0,
        isDirty: true,
        isMerging: false,
        isRebasing: false,
        isCherryPicking: false,
        files: [{ path: runtimeId === 'server-web' ? 'src/Web.tsx' : 'src/Api.ts', status: 'modified', staged: false, unstaged: true }],
        conflicts: []
      })),
      getProjectFileDiff: vi.fn().mockImplementation(async (runtimeId: string, path: string, kind: string) => ({
        path,
        kind,
        diff: runtimeId === 'server-web'
          ? 'diff --git a/src/Web.tsx b/src/Web.tsx\n@@ -1 +1 @@\n-old web\n+new web\n'
          : 'diff --git a/src/Api.ts b/src/Api.ts\n@@ -1 +1 @@\n-old api\n+new api\n'
      }))
    }, config);
    render(<App />);

    await waitFor(() => {
      expect(api.getProjectGitSnapshot).toHaveBeenCalledWith('server-api');
      expect(api.getProjectGitSnapshot).toHaveBeenCalledWith('server-web');
    });
    expect(api.getProjectGitSnapshot).not.toHaveBeenCalledWith('workspace-sample');

    const changesNav = await screen.findByRole('group', { name: 'Changes' });
    const compactCards = within(changesNav).getAllByRole('button', { name: /Expand changes workbench/i });
    expect(compactCards).toHaveLength(2);
    expect(compactCards[0]).toHaveTextContent('Sample API');
    expect(compactCards[0]).toHaveTextContent('feature/api-contract');
    expect(compactCards[0]).toHaveTextContent('1 file');
    expect(compactCards[1]).toHaveTextContent('Sample Web');
    expect(compactCards[1]).toHaveTextContent('feature/web-ui');
    expect(compactCards[1]).toHaveTextContent('1 file');

    expect(screen.queryByRole('complementary', { name: /Changes workbench/i })).not.toBeInTheDocument();

    fireEvent.click(compactCards[0]);
    let workbench = await screen.findByRole('complementary', { name: 'Changes workbench for Sample API' });
    expect(within(changesNav).getAllByRole('button', { name: /Expand changes workbench/i })).toHaveLength(2);
    expect(within(workbench).getByRole('heading', { name: 'Changes' })).toBeInTheDocument();
    expect(within(workbench).getByText('Local changes')).toBeInTheDocument();
    expect(within(workbench).getByText('feature/api-contract')).toBeInTheDocument();
    expect(within(workbench).getAllByText('src/Api.ts').length).toBeGreaterThan(0);
    expect(await within(workbench).findByLabelText('Diff for src/Api.ts')).toHaveTextContent('+new api');
    expect(api.getProjectFileDiff).toHaveBeenCalledWith('server-api', 'src/Api.ts', 'worktree');

    fireEvent.click(compactCards[1]);
    workbench = await screen.findByRole('complementary', { name: 'Changes workbench for Sample Web' });
    expect(within(workbench).getByText('feature/web-ui')).toBeInTheDocument();
    expect(await within(workbench).findByLabelText('Diff for src/Web.tsx')).toHaveTextContent('+new web');
    expect(api.getProjectFileDiff).toHaveBeenCalledWith('server-web', 'src/Web.tsx', 'worktree');

    fireEvent.click(within(workbench).getByRole('button', { name: 'Minimize changes workbench' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: /Changes workbench/i })).not.toBeInTheDocument());
    expect(within(changesNav).getAllByRole('button', { name: /Expand changes workbench/i })).toHaveLength(2);
  });

  it('opens the right-side changes drawer without leaving the Server view', async () => {
    const api = installLaunchBayMock({
      getProjectFileDiff: vi.fn().mockResolvedValue({
        path: 'src/App.tsx',
        kind: 'worktree',
        diff: 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old server\n+new server\n'
      })
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Server' }));
    expect(await screen.findByRole('heading', { name: 'Sample server' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();

    const changesNav = await screen.findByRole('group', { name: 'Changes' });
    fireEvent.click(within(changesNav).getByRole('button', { name: /Expand changes workbench/i }));

    const workbench = await screen.findByRole('complementary', { name: 'Changes workbench' });
    expect(screen.getByRole('heading', { name: 'Sample server' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(await within(workbench).findByLabelText('Diff for src/App.tsx')).toHaveTextContent('+new server');
    expect(api.getProjectFileDiff).toHaveBeenCalledWith('sample', 'src/App.tsx', 'worktree');
  });

  it('opens a focused Files workspace with project folders and text editing only', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock({
      listProjectTree: vi.fn().mockResolvedValue({
        entries: [
          { path: 'src', name: 'src', type: 'directory' },
          { path: '.env', name: '.env', type: 'file', hidden: true, sensitive: true },
          { path: '.gitignore', name: '.gitignore', type: 'file', hidden: true },
          { path: 'package.json', name: 'package.json', type: 'file' },
          { path: 'src/components', name: 'components', type: 'directory' },
          { path: 'src/components/Editor.tsx', name: 'Editor.tsx', type: 'file' }
        ]
      }),
      readProjectRuntimeFile: vi.fn().mockImplementation(async (_projectId: string, relativePath: string) => ({
        text: relativePath === '.env' ? 'API_KEY=local-only\n' : 'export const editor = true;\n',
        sizeBytes: 26,
        sensitive: relativePath === '.env'
      })),
      writeProjectRuntimeFile: vi.fn().mockResolvedValue({ ok: true, sizeBytes: 35 })
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Open project files' }));

    const filesView = await screen.findByRole('region', { name: 'Project files' });
    expect(within(filesView).queryByRole('heading', { name: 'Project files' })).not.toBeInTheDocument();
    expect(within(filesView).getByText('Sample')).toBeInTheDocument();
    expect(within(filesView).getByRole('tree', { name: 'Project file tree' })).toHaveTextContent('src');
    expect(within(filesView).getByRole('button', { name: 'Open .env' })).toBeInTheDocument();
    expect(within(filesView).getByRole('button', { name: 'Open .gitignore' })).toBeInTheDocument();
    expect(within(filesView).getByRole('button', { name: 'Open package.json' })).toBeInTheDocument();
    expect(within(filesView).queryByRole('region', { name: 'Changed files' })).not.toBeInTheDocument();
    expect(within(filesView).queryByText('Changed files')).not.toBeInTheDocument();
    expect(within(filesView).queryByText('📁')).not.toBeInTheDocument();
    expect(within(filesView).queryByRole('button', { name: 'Open src/components/Editor.tsx' })).not.toBeInTheDocument();

    await user.click(within(filesView).getByRole('button', { name: 'Expand src' }));
    const srcRow = within(filesView).getByRole('button', { name: 'Collapse src' });
    const componentsRow = within(filesView).getByRole('button', { name: 'Expand src/components' });
    const envRow = within(filesView).getByRole('button', { name: 'Open .env' });
    expect(srcRow.compareDocumentPosition(componentsRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(componentsRow.compareDocumentPosition(envRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(componentsRow);

    const editorRow = within(filesView).getByRole('button', { name: 'Open src/components/Editor.tsx' });
    expect(editorRow).toBeInTheDocument();
    expect(componentsRow.compareDocumentPosition(editorRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editorRow.compareDocumentPosition(envRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(filesView).queryByText('📂')).not.toBeInTheDocument();
    expect(within(filesView).queryByRole('button', { name: /terminal/i })).not.toBeInTheDocument();
    expect(within(filesView).queryByRole('button', { name: /debug/i })).not.toBeInTheDocument();

    await user.click(within(filesView).getByRole('button', { name: 'Open .env' }));

    expect(await within(filesView).findByText('Sensitive local file')).toBeInTheDocument();
    expect(within(filesView).getByTestId('syntax-highlight')).toHaveTextContent('API_KEY');
    expect(within(filesView).getByTestId('syntax-highlight').querySelector('.syntax-key')).not.toBeNull();
    expect(within(filesView).getByTestId('line-numbers')).toHaveTextContent('1');
    expect(within(filesView).getByTestId('line-numbers')).toHaveTextContent('2');
    const editor = await within(filesView).findByRole('textbox', { name: 'Editor for .env' });
    expect(editor).toHaveValue('API_KEY=local-only\n');
    await user.clear(editor);
    await user.type(editor, 'API_KEY=updated-local-only{Enter}');
    expect(within(filesView).getByText('Unsaved')).toBeInTheDocument();

    expect(within(filesView).queryByRole('button', { name: 'Save file' })).not.toBeInTheDocument();
    fireEvent.keyDown(editor, { key: 's', metaKey: true });

    await waitFor(() => expect(api.writeProjectRuntimeFile).toHaveBeenCalledWith('sample', '.env', 'API_KEY=updated-local-only\n'));
    expect(api.listProjectTree).toHaveBeenCalledWith('sample', expect.objectContaining({ includeHidden: true }));
    expect(api.readProjectRuntimeFile).toHaveBeenCalledWith('sample', '.env');
  });

  it('keeps file clicks inline and opens the tabbed diff review from the summary action', async () => {
    const api = installLaunchBayMock({
      getProjectFileDiff: vi.fn().mockImplementation(async (_projectId: string, path: string, kind: string) => ({
        path,
        kind,
        diff: path === 'src/NewPanel.tsx'
          ? 'diff --git a/src/NewPanel.tsx b/src/NewPanel.tsx\n@@ -0,0 +1 @@\n+new panel modal\n'
          : 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old app\n+app modal\n'
      }))
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Expand changes workbench/i }));
    const workbench = await screen.findByRole('complementary', { name: 'Changes workbench' });
    expect(await within(workbench).findByLabelText('Diff for src/App.tsx')).toHaveTextContent('+app modal');

    fireEvent.click(within(workbench).getByRole('button', { name: 'New src/NewPanel.tsx' }));

    expect(screen.queryByRole('dialog', { name: 'Diff review' })).not.toBeInTheDocument();
    expect(await within(workbench).findByLabelText('Diff for src/NewPanel.tsx')).toHaveTextContent('+new panel modal');
    expect(api.getProjectFileDiff).toHaveBeenCalledWith('sample', 'src/NewPanel.tsx', 'untracked');

    fireEvent.click(within(workbench).getByRole('button', { name: 'Ver todos os arquivos' }));

    const dialog = await screen.findByRole('dialog', { name: 'Diff review' });
    expect(within(dialog).getByRole('tab', { name: 'src/NewPanel.tsx' })).toHaveAttribute('aria-selected', 'true');
    expect(await within(dialog).findByLabelText('Full diff for src/NewPanel.tsx')).toHaveTextContent('+new panel modal');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Modified src/App.tsx' }));

    expect(within(dialog).getByRole('tab', { name: 'src/NewPanel.tsx' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'src/App.tsx' })).toHaveAttribute('aria-selected', 'true');
    expect(await within(dialog).findByLabelText('Full diff for src/App.tsx')).toHaveTextContent('+app modal');
  });

  it('groups changed files by status and copies the selected diff', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const groupedDiff = 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old grouped\n+new grouped\n';
    installLaunchBayMock({
      getProjectGitSnapshot: vi.fn().mockResolvedValue({
        cwd: '/repos/sample-app',
        branch: 'feature/polish',
        headSha: 'abc123',
        upstream: 'origin/feature/polish',
        ahead: 1,
        behind: 0,
        isDirty: true,
        isMerging: true,
        isRebasing: false,
        isCherryPicking: false,
        files: [
          { path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true },
          { path: 'src/NewPanel.tsx', status: 'untracked', staged: false, unstaged: true },
          { path: 'src/OldPanel.tsx', status: 'deleted', staged: true, unstaged: false },
          { path: 'src/Conflict.tsx', status: 'conflicted', staged: false, unstaged: true }
        ],
        conflicts: [{ path: 'src/Conflict.tsx', status: 'UU', stages: { ours: true, theirs: true } }]
      }),
      getProjectFileDiff: vi.fn().mockResolvedValue({ path: 'src/App.tsx', kind: 'worktree', diff: groupedDiff })
    });
    const user = userEvent.setup();
    setClipboardMock({ writeText });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Expand changes workbench/i }));
    const workbench = await screen.findByRole('complementary', { name: 'Changes workbench' });

    expect(within(workbench).queryByRole('group', { name: 'Modified changes' })).not.toBeInTheDocument();
    expect(within(workbench).getByRole('button', { name: 'Modified src/App.tsx' })).toHaveTextContent('Modified');
    expect(within(workbench).getByRole('button', { name: 'New src/NewPanel.tsx' })).toHaveTextContent('New');
    expect(within(workbench).getByRole('button', { name: 'Deleted src/OldPanel.tsx' })).toHaveTextContent('Deleted');
    expect(within(workbench).getByRole('button', { name: 'Conflict src/Conflict.tsx' })).toHaveTextContent('Conflict');
    expect(within(workbench).getByRole('alert')).toHaveTextContent(/Run your normal conflict resolution commands/i);

    expect(await within(workbench).findByLabelText('Diff for src/App.tsx')).toHaveTextContent('+new grouped');
    await user.click(within(workbench).getByRole('button', { name: 'Copy selected diff' }));

    await waitFor(() => expect(within(workbench).getByRole('button', { name: 'Copy selected diff' })).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith(groupedDiff);
  });

  it('keeps the collapsed changes card fresh and refreshes the expanded workbench on focus', async () => {
    const api = installLaunchBayMock();
    render(<App />);

    const compactCard = await screen.findByRole('button', { name: /Expand changes workbench/i });
    expect(compactCard).toHaveTextContent('main');

    vi.mocked(api.getProjectGitSnapshot).mockClear();
    vi.mocked(api.getProjectGitSnapshot).mockResolvedValueOnce({
      cwd: '/repos/sample-app',
      branch: 'feature/active',
      headSha: 'def456',
      upstream: 'origin/feature/active',
      ahead: 0,
      behind: 0,
      isDirty: true,
      isMerging: false,
      isRebasing: false,
      isCherryPicking: false,
      files: [{ path: 'src/Changed.tsx', status: 'modified', staged: false, unstaged: true }],
      conflicts: []
    });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    await waitFor(() => expect(compactCard).toHaveTextContent('feature/active'));
    expect(compactCard).toHaveTextContent('1 file');
    expect(api.getProjectGitSnapshot).toHaveBeenCalledTimes(1);

    fireEvent.click(compactCard);
    const workbench = await screen.findByRole('complementary', { name: 'Changes workbench' });
    expect(within(workbench).getByText('Changes')).toBeInTheDocument();

    vi.mocked(api.getProjectGitSnapshot).mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(api.getProjectGitSnapshot).toHaveBeenCalledTimes(1);
  });

  it('auto-refreshes the changes workbench while the user is reading a diff', async () => {
    const api = installLaunchBayMock();
    render(<App />);

    const compactCard = await screen.findByRole('button', { name: /Expand changes workbench/i });
    fireEvent.click(compactCard);

    const workbench = await screen.findByRole('complementary', { name: 'Changes workbench' });
    expect(await within(workbench).findByLabelText('Diff for src/App.tsx')).toHaveTextContent('+new');
    expect(api.getProjectGitSnapshot).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    vi.mocked(api.getProjectGitSnapshot).mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(api.getProjectGitSnapshot).toHaveBeenCalled();

    vi.mocked(api.getProjectGitSnapshot).mockClear();
    await act(async () => {
      fireEvent.click(within(workbench).getByRole('button', { name: 'Refresh' }));
      await Promise.resolve();
    });
    expect(api.getProjectGitSnapshot).toHaveBeenCalledTimes(1);
  });

  it('lists Hermes skills as slash commands and applies the selected slash command', async () => {
    installLaunchBayMock({
      listHermesSkills: vi.fn().mockResolvedValue({
        skills: [
          { name: 'obsidian', description: 'Read, search, and create notes in the Obsidian vault' },
          { name: 'engineering-contract-coding', description: 'Disciplined implementation workflow' }
        ]
      })
    });
    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByLabelText('Message Hermes about Sample');
    await user.type(composer, '/obs');

    const picker = await screen.findByRole('listbox', { name: 'Slash commands and skills' });
    expect(picker.parentElement).toHaveClass('composer-wrap');
    expect(picker.closest('.composer')).toBeNull();
    expect(within(picker).getByText('/obsidian')).toBeInTheDocument();
    expect(within(picker).getByText(/skill/i)).toBeInTheDocument();
    expect(within(picker).getByText(/Obsidian vault/)).toBeInTheDocument();

    fireEvent.mouseDown(within(picker).getByText('/obsidian'));

    expect(composer).toHaveValue('/obsidian ');
  });

  it('shows the changes workbench as a floating branch summary card by default and expands it on click', async () => {
    installLaunchBayMock();
    render(<App />);

    const compactCard = await screen.findByRole('button', { name: /Expand changes workbench/i });
    expect(compactCard).toHaveTextContent('main');
    expect(compactCard).toHaveTextContent('2 files');
    expect(screen.queryByLabelText('Selected file diff')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Minimize changes workbench' })).not.toBeInTheDocument();

    fireEvent.click(compactCard);

    expect(await screen.findByLabelText('Diff for src/App.tsx')).toHaveTextContent('+new');
    expect(screen.getByRole('button', { name: 'Minimize changes workbench' })).toBeInTheDocument();
  });

  it('surfaces merge conflicts in the changes workbench instead of hiding them as generic errors', async () => {
    installLaunchBayMock({
      getProjectGitSnapshot: vi.fn().mockResolvedValue({
        cwd: '/repos/sample-app',
        branch: 'main',
        headSha: 'abc123',
        isDirty: true,
        isMerging: true,
        isRebasing: false,
        isCherryPicking: false,
        files: [{ path: 'src/conflict.ts', status: 'conflicted', staged: true, unstaged: true }],
        conflicts: [{ path: 'src/conflict.ts', status: 'UU', stages: { base: true, ours: true, theirs: true } }]
      }),
      getProjectFileDiff: vi.fn().mockResolvedValue({ path: 'src/conflict.ts', kind: 'worktree', diff: '' })
    });
    render(<App />);

    const compactCard = await screen.findByRole('button', { name: /Expand changes workbench/i });
    fireEvent.click(compactCard);

    const workbench = await screen.findByRole('complementary', { name: 'Changes workbench' });
    expect(within(workbench).getByText('Merge in progress')).toBeInTheDocument();
    expect(within(workbench).getByRole('alert')).toHaveTextContent('1 conflicted file');
    expect(within(workbench).getAllByText('src/conflict.ts').length).toBeGreaterThan(0);
    expect(within(workbench).getByText('conflicts')).toBeInTheDocument();
  });

  it('shows a guided branch merge flow with direction, repository, metadata, preview, and safe confirmation', async () => {
    const user = userEvent.setup();
    const mergePreview = {
      cwd: '/repos/sample-app',
      sourceBranch: 'feature/session-cockpit',
      targetBranch: 'main',
      canMerge: true,
      blockers: [],
      commits: [
        { sha: 'def4567', subject: 'Polish session cockpit' },
        { sha: 'abc1234', subject: 'Wire branch actions' }
      ],
      files: [
        { path: 'src/components/Sidebar.tsx', status: 'M' },
        { path: 'src/components/NewSessionModal.tsx', status: 'A' }
      ]
    };
    const api = installLaunchBayMock({
      getProjectBranchMergePreview: vi.fn().mockResolvedValue(mergePreview)
    } as Partial<NonNullable<Window['launchBay']>>);

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));

    const config = await screen.findByRole('region', { name: 'Project config' });
    expect(within(config).getByText('/repos/sample-app')).toBeInTheDocument();
    expect(within(config).getByText('Clean')).toBeInTheDocument();
    expect(within(config).getByRole('button', { name: 'Fetch' })).toBeInTheDocument();
    expect(within(config).getByPlaceholderText('Search branches')).toBeInTheDocument();
    expect(within(config).getByText('origin/feature/session-cockpit')).toBeInTheDocument();
    expect(within(config).getByText('behind 2')).toBeInTheDocument();
    expect(within(config).getByText('Branch UI')).toBeInTheDocument();

    expect(within(config).queryByRole('button', { name: 'Switch to main' })).not.toBeInTheDocument();
    expect(within(config).queryByRole('button', { name: 'Merge main into main' })).not.toBeInTheDocument();
    expect(within(config).getByText('Checked out')).toBeInTheDocument();

    await user.type(within(config).getByPlaceholderText('Search branches'), 'session');
    expect(within(config).queryByText('main')).not.toBeInTheDocument();
    expect(within(config).getByText('feature/session-cockpit')).toBeInTheDocument();

    await user.click(within(config).getByRole('button', { name: 'Fetch' }));
    expect(api.fetchProjectBranches).toHaveBeenCalledWith('sample');

    const mergeAction = within(config).getByRole('button', { name: 'Merge feature/session-cockpit into current branch main' });
    expect(mergeAction).toHaveTextContent('Merge into current');
    await user.click(mergeAction);
    expect(api.mergeProjectBranch).not.toHaveBeenCalled();

    const mergeDialog = await screen.findByRole('dialog', { name: 'Review branch merge' });
    expect(within(mergeDialog).getByText('Source branch')).toBeInTheDocument();
    expect(within(mergeDialog).getByText('Current target branch')).toBeInTheDocument();
    expect(within(mergeDialog).getAllByText('feature/session-cockpit').length).toBeGreaterThan(0);
    expect(within(mergeDialog).getAllByText('main').length).toBeGreaterThan(0);
    expect(within(mergeDialog).getByText('/repos/sample-app')).toBeInTheDocument();
    expect(within(mergeDialog).getByText('Branch UI')).toBeInTheDocument();
    expect(within(mergeDialog).getByText('behind 2')).toBeInTheDocument();
    expect(within(mergeDialog).getByText((_, element) =>
      element?.classList.contains('merge-copy') === true &&
        element.textContent?.replace(/\s+/g, ' ').includes('You will stay on main') === true
    )).toBeInTheDocument();
    expect(within(mergeDialog).getByText('git merge --no-edit feature/session-cockpit')).toBeInTheDocument();
    await waitFor(() => expect((api as any).getProjectBranchMergePreview).toHaveBeenCalledWith('sample', 'feature/session-cockpit'));
    expect(within(mergeDialog).getByRole('heading', { name: 'Preflight checks' })).toBeInTheDocument();
    expect(within(mergeDialog).getByText('Worktree clean')).toBeInTheDocument();
    expect(within(mergeDialog).getByText('Server stopped')).toBeInTheDocument();
    expect(within(mergeDialog).getByRole('heading', { name: 'Merge preview' })).toBeInTheDocument();
    expect(within(mergeDialog).getByText('2 commits')).toBeInTheDocument();
    expect(within(mergeDialog).getByText('2 files')).toBeInTheDocument();
    expect(within(mergeDialog).getByText('Polish session cockpit')).toBeInTheDocument();
    expect(within(mergeDialog).getByText('src/components/Sidebar.tsx')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(api.mergeProjectBranch).not.toHaveBeenCalled();

    await user.click(within(config).getByRole('button', { name: 'Merge feature/session-cockpit into current branch main' }));
    const cancelDialog = await screen.findByRole('dialog', { name: 'Review branch merge' });
    await user.click(within(cancelDialog).getByRole('button', { name: 'Cancel' }));
    expect(api.mergeProjectBranch).not.toHaveBeenCalled();

    await user.click(within(config).getByRole('button', { name: 'Merge feature/session-cockpit into current branch main' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Review branch merge' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'Merge feature/session-cockpit into main' }));
    expect(api.mergeProjectBranch).toHaveBeenCalledWith('sample', 'feature/session-cockpit');
    expect(await within(config).findByText(/Merged feature\/session-cockpit into main/i)).toBeInTheDocument();

    await user.click(within(config).getByRole('button', { name: 'Switch to feature/session-cockpit' }));
    expect(api.switchProjectBranch).toHaveBeenCalledWith('sample', 'feature/session-cockpit');
  });

  it('explains when branch control needs an app restart instead of showing fake clean branches', async () => {
    const user = userEvent.setup();
    installLaunchBayMock({
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'DEV-6474-create-templates-screen', dirty: true })
    });
    delete (window.launchBay as Partial<NonNullable<Window['launchBay']>>).listProjectBranches;
    delete (window.launchBay as Partial<NonNullable<Window['launchBay']>>).fetchProjectBranches;
    delete (window.launchBay as Partial<NonNullable<Window['launchBay']>>).switchProjectBranch;
    delete (window.launchBay as Partial<NonNullable<Window['launchBay']>>).mergeProjectBranch;

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));

    const config = await screen.findByRole('region', { name: 'Project config' });
    expect(within(config).getByText('Unavailable')).toBeInTheDocument();
    expect(within(config).getByText(/Restart Launch Bay to load the branch-control bridge/i)).toBeInTheDocument();
    expect(within(config).queryByText('Clean')).not.toBeInTheDocument();
    expect(within(config).getByText(/Restart Launch Bay to enable branch control/i)).toBeInTheDocument();
  });

  it('locks branch switching in the Server config when the worktree is dirty', async () => {
    const user = userEvent.setup();
    installLaunchBayMock({
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'main', dirty: true }),
      listProjectBranches: vi.fn().mockResolvedValue({
        cwd: '/repos/sample-app',
        current: 'main',
        dirty: true,
        branches: [
          { name: 'main', current: true },
          { name: 'feature/session-cockpit', current: false, upstream: 'origin/feature/session-cockpit' }
        ]
      })
    });

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));

    const config = await screen.findByRole('region', { name: 'Project config' });
    expect(within(config).getByRole('button', { name: 'Switch to feature/session-cockpit' })).toBeDisabled();
    expect(within(config).getByText(/Commit or stash before switching branches/i)).toBeInTheDocument();
  });

  it('shows the active runtime branch in the sidebar and server details', async () => {
    installLaunchBayMock({
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'feature/hermes-reset' })
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText('feature/hermes-reset')).toBeInTheDocument();
    expect(screen.getByText('feature/hermes-reset')).toHaveClass('row-subtitle');

    await user.click(screen.getByRole('button', { name: 'Server' }));
    expect(screen.getByText('Branch')).toBeInTheDocument();
    expect(screen.getAllByText('feature/hermes-reset').length).toBeGreaterThanOrEqual(2);
  });

  it('adds a subtle dirty marker to the runtime branch when git has local changes', async () => {
    installLaunchBayMock({
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'feature/hermes-reset', dirty: true })
    });
    render(<App />);

    expect(await screen.findByText('feature/hermes-reset · dirty')).toHaveClass('row-subtitle');
  });

  it('refreshes the selected project branch automatically after git checkout', async () => {
    vi.useFakeTimers();
    const getRuntimeStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'stopped', log: '', branch: 'main' })
      .mockResolvedValueOnce({ status: 'stopped', log: '', branch: 'main' })
      .mockResolvedValueOnce({ status: 'stopped', log: '', branch: 'feature/new-branch' });
    installLaunchBayMock({ getRuntimeStatus });

    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });
    const sidebarMainLabels = screen.getAllByText('main').filter((node) => node.classList.contains('row-subtitle'));
    expect(sidebarMainLabels[0]).toHaveClass('row-subtitle');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByText('feature/new-branch')).toHaveClass('row-subtitle');
    expect(screen.queryAllByText('main').some((node) => node.classList.contains('row-subtitle'))).toBe(false);
  });

  it('refreshes branch controls automatically when the app regains focus', async () => {
    const listProjectBranches = vi.fn()
      .mockResolvedValueOnce({
        cwd: '/repos/sample-app',
        current: 'main',
        dirty: false,
        branches: [{ name: 'main', current: true }]
      })
      .mockResolvedValueOnce({
        cwd: '/repos/sample-app',
        current: 'main',
        dirty: false,
        branches: [{ name: 'main', current: true }]
      })
      .mockResolvedValueOnce({
        cwd: '/repos/sample-app',
        current: 'feature/auto-refresh',
        dirty: true,
        branches: [
          { name: 'feature/auto-refresh', current: true },
          { name: 'main', current: false }
        ]
      });
    const user = userEvent.setup();
    installLaunchBayMock({ listProjectBranches });

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    const config = await screen.findByRole('region', { name: 'Project config' });
    expect(within(config).getByText('Clean')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    await waitFor(() => expect(within(config).getByText('Dirty')).toBeInTheDocument());
    expect(within(config).getByText('feature/auto-refresh')).toBeInTheDocument();
    expect(listProjectBranches).toHaveBeenCalledTimes(3);
  });

  it('refreshes the open changes workbench automatically when the app regains focus', async () => {
    const getProjectGitSnapshot = vi.fn()
      .mockResolvedValueOnce({
        cwd: '/repos/sample-app',
        branch: 'main',
        headSha: 'abc123',
        isDirty: true,
        isMerging: false,
        isRebasing: false,
        isCherryPicking: false,
        files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true }],
        conflicts: []
      })
      .mockResolvedValueOnce({
        cwd: '/repos/sample-app',
        branch: 'main',
        headSha: 'abc123',
        isDirty: true,
        isMerging: false,
        isRebasing: false,
        isCherryPicking: false,
        files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true }],
        conflicts: []
      })
      .mockResolvedValueOnce({
        cwd: '/repos/sample-app',
        branch: 'feature/auto-refresh',
        headSha: 'def456',
        isDirty: true,
        isMerging: false,
        isRebasing: false,
        isCherryPicking: false,
        files: [
          { path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true },
          { path: 'src/NewPanel.tsx', status: 'untracked', staged: false, unstaged: true }
        ],
        conflicts: []
      });
    installLaunchBayMock({
      getProjectGitSnapshot,
      getProjectFileDiff: vi.fn().mockResolvedValue({ path: 'src/App.tsx', kind: 'worktree', diff: 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n' })
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Expand changes workbench/i }));
    const workbench = await screen.findByRole('complementary', { name: 'Changes workbench' });
    expect(within(workbench).getByText('main')).toBeInTheDocument();
    expect(within(workbench).getByRole('button', { name: 'Modified src/App.tsx' })).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    await waitFor(() => expect(within(workbench).getByText('feature/auto-refresh')).toBeInTheDocument());
    expect(within(workbench).getByRole('button', { name: 'New src/NewPanel.tsx' })).toBeInTheDocument();
    expect(getProjectGitSnapshot).toHaveBeenCalledTimes(3);
  });

  it('refreshes the project file tree automatically when the app regains focus', async () => {
    const listProjectTree = vi.fn()
      .mockResolvedValueOnce({
        entries: [{ path: '.env', name: '.env', type: 'file', hidden: true, sensitive: true }]
      })
      .mockResolvedValueOnce({
        entries: [
          { path: '.env', name: '.env', type: 'file', hidden: true, sensitive: true },
          { path: 'package.json', name: 'package.json', type: 'file' }
        ]
      });
    const user = userEvent.setup();
    installLaunchBayMock({ listProjectTree });

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Open project files' }));
    const filesView = await screen.findByRole('region', { name: 'Project files' });
    expect(await within(filesView).findByRole('button', { name: 'Open .env' })).toBeInTheDocument();
    expect(within(filesView).queryByRole('button', { name: 'Open package.json' })).not.toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(await within(filesView).findByRole('button', { name: 'Open package.json' })).toBeInTheDocument();
    expect(listProjectTree).toHaveBeenCalledTimes(2);
  });

  it('starts the Sample runtime in the server terminal instead of a logger panel', async () => {
    const api = installLaunchBayMock({
      startProject: vi.fn().mockResolvedValue({
        status: 'running',
        log: '',
        terminal: { id: 'server-term-1', projectId: 'sample', title: 'Sample terminal', cwd: '/repos/sample-app' },
        terminalCommand: 'API_SERVER=https://api.staging.example.com yarn run development'
      })
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Server' }));
    expect(screen.queryByLabelText('Server logs')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(api.startProject).toHaveBeenCalledWith('sample');
    expect(await screen.findByRole('region', { name: 'Sample terminal' })).toBeInTheDocument();
    expect(api.writeTerminal).not.toHaveBeenCalledWith('server-term-1', 'API_SERVER=https://api.staging.example.com yarn run development\r');
    expect(screen.queryByText(/\[web\] ready/)).not.toBeInTheDocument();
  });

  it('stops the selected project runtime through Electron without writing logger output', async () => {
    const api = installLaunchBayMock({
      // Start the server already in the running state so Stop is enabled.
      getRuntimeStatus: vi.fn().mockResolvedValue({
        status: 'running',
        log: '',
        pid: 1234
      }),
      stopProject: vi.fn().mockResolvedValue({ status: 'stopped', log: '' })
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(api.stopProject).toHaveBeenCalledWith('sample');
    expect(screen.getAllByText('stopped').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\[process\] stopped/)).not.toBeInTheDocument();
  });

  it('applies runtime updates sent by Electron without restoring a logger panel', async () => {
    let listener: ((event: { projectId: string; snapshot: { status: string; log: string } }) => void) | undefined;
    installLaunchBayMock({
      onRuntimeUpdate: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      })
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Server' }));

    act(() => {
      listener?.({
        projectId: 'sample',
        snapshot: {
          status: 'running',
          log: '[vite] Local: http://localhost:5000'
        }
      });
    });

    expect(screen.getByRole('heading', { name: 'Sample server' })).toBeInTheDocument();
    expect(screen.queryByText('[vite] Local: http://localhost:5000')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Server terminal')).toBeInTheDocument();
  });

  it('opens the selected project local URL through the Electron bridge when it is a trusted local URL', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Open URL' }));

    expect(api.openLocalUrl).toHaveBeenCalledWith('http://localhost:5000');
  });

  it('does not expose Open URL for projects without a valid local browser URL', async () => {
    const user = userEvent.setup();
    installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Sample Stack' }));
    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(screen.queryByRole('button', { name: 'Open URL' })).not.toBeInTheDocument();
  });

  it('keeps the Server surface vertically scrollable without horizontal page overflow', async () => {
    const user = userEvent.setup();
    installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));

    const main = document.querySelector('.main') as HTMLElement;
    const terminalStack = await screen.findByLabelText('Sample terminal sessions');
    const serverView = screen.getByRole('region', { name: 'Sample server' });

    expect(within(serverView).queryByRole('button', { name: 'Open Hermes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Hermes' })).toBeInTheDocument();
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    expect(main).toHaveStyle({ overflowX: 'hidden', overflowY: 'auto' });
    expect(main).toContainElement(terminalStack);
    expect(await screen.findByRole('region', { name: 'Sample terminal' })).toBeInTheDocument();
  });

  it('opens the configured server command inside the server terminal', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(api.startProject).toHaveBeenCalledWith('sample');
    expect(api.writeTerminal).not.toHaveBeenCalledWith('server-term-1', 'API_SERVER=https://api.staging.example.com yarn run development\r');
    expect(await screen.findByRole('region', { name: 'Sample terminal' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Server logs')).not.toBeInTheDocument();
  });

  it('can add an extra interactive terminal from the Server terminal panel without stacking huge terminal cards', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByRole('region', { name: 'Sample terminal' });

    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(api.createTerminal).toHaveBeenCalledWith('sample', '~/repos/sample-app');
    expect(screen.getByRole('tab', { name: 'Sample terminal' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Terminal 1 · sample-app' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'Terminal 1 · sample-app' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Sample terminal' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Sample terminal' }));
    expect(await screen.findByRole('region', { name: 'Sample terminal' })).toBeInTheDocument();
  });

  it('routes terminal output, input, kill, and close through the server terminal bridge', async () => {
    let terminalDataListener: ((event: { id: string; projectId: string; data: string }) => void) | undefined;
    const user = userEvent.setup();
    const api = installLaunchBayMock({
      onTerminalData: vi.fn((callback) => {
        terminalDataListener = callback;
        return () => undefined;
      })
    });

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));

    act(() => terminalDataListener?.({ id: 'server-term-1', projectId: 'sample', data: 'hello from shell\n' }));
    expect(await screen.findByText(/hello from shell/)).toBeInTheDocument();

    const terminalCard = screen.getByRole('region', { name: 'Sample terminal' });
    const terminalBox = within(terminalCard).getByRole('textbox', { name: 'Interactive terminal for Sample terminal' });
    expect(within(terminalCard).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(within(terminalCard).queryByRole('textbox', { name: /Command for/ })).not.toBeInTheDocument();
    await user.type(terminalBox, 'pwd{Enter}');
    expect(api.writeTerminal).toHaveBeenCalledWith('server-term-1', 'p');
    expect(api.writeTerminal).toHaveBeenCalledWith('server-term-1', 'w');
    expect(api.writeTerminal).toHaveBeenCalledWith('server-term-1', 'd');
    expect(api.writeTerminal).toHaveBeenCalledWith('server-term-1', '\r');

    await user.click(within(terminalCard).getByRole('button', { name: 'Kill' }));
    expect(api.killTerminal).toHaveBeenCalledWith('server-term-1');
    await user.click(within(terminalCard).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Sample terminal' })).not.toBeInTheDocument();
  });

  it('shows only installed supported CLI tools when creating a new session', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock({
      detectAgentCliTools: vi.fn().mockResolvedValue([
        { id: 'hermes', label: 'Hermes', command: 'hermes', path: '/usr/local/bin/hermes', version: 'Hermes Agent v0.12.0' },
        { id: 'claude', label: 'Claude Code', command: 'claude', path: '/usr/local/bin/claude', version: '2.1.131 (Claude Code)' }
      ])
    } as Partial<NonNullable<Window['launchBay']>>);

    render(<App />);
    await waitFor(() => expect(api.detectAgentCliTools).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'New session' }));

    const dialog = screen.getByRole('dialog', { name: 'New session' });
    expect(within(dialog).getByRole('option', { name: 'Hermes' })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: 'Claude Code' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: 'Codex' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: 'OpenCode' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: 'Web Claude' })).not.toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText('Session type'), 'claude');
    expect(within(dialog).getByLabelText('Command')).toHaveValue('claude');
  });

  it('closes the New session modal when Escape is pressed', async () => {
    const user = userEvent.setup();
    installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'New session' }));
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeInTheDocument();
  });

  it('renders the default Hermes chat as a renamable session in the left navigation', async () => {
    const user = userEvent.setup();
    installLaunchBayMock();

    render(<App />);

    expect(screen.getByRole('button', { name: 'Open Hermes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Session actions for Hermes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hermes' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Session actions for Hermes' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit session' }));
    const renameInput = screen.getByRole('textbox', { name: 'Rename session' });
    await user.clear(renameInput);
    await user.type(renameInput, 'Planning Hermes{Enter}');

    expect(screen.getByRole('button', { name: 'Open Planning Hermes' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Message Planning Hermes about Sample/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Hermes' })).not.toBeInTheDocument();
  });

  it('groups selected project navigation with Sessions, Server runtime, then Changes and project file action', () => {
    installLaunchBayMock();

    render(<App />);

    const workspaceNav = screen.getByRole('navigation', { name: 'Sample workspace' });
    const sessionsGroup = within(workspaceNav).getByRole('group', { name: 'Sessions' });
    const serverGroup = within(workspaceNav).getByRole('group', { name: 'Server runtime' });
    const changesGroup = within(workspaceNav).getByRole('group', { name: 'Changes' });

    expect(sessionsGroup.compareDocumentPosition(serverGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(serverGroup.compareDocumentPosition(changesGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sessionsGroup).getByRole('button', { name: 'Open Hermes' })).toBeInTheDocument();
    expect(within(sessionsGroup).getByRole('button', { name: 'New session' })).toBeInTheDocument();
    expect(within(serverGroup).getByRole('button', { name: 'Server' })).toBeInTheDocument();
    expect(within(serverGroup).queryByRole('button', { name: 'Open Hermes' })).not.toBeInTheDocument();
    expect(within(workspaceNav).queryByRole('group', { name: 'Files' })).not.toBeInTheDocument();
    expect(within(changesGroup).getByRole('button', { name: 'Open project files' })).toHaveTextContent('Open files');
    expect(within(changesGroup).getByText('Browse/edit')).toBeInTheDocument();
  });

  it('creates configured agent sessions from the sidebar setup flow', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'New session' }));

    const dialog = screen.getByRole('dialog', { name: 'New session' });
    await user.selectOptions(within(dialog).getByLabelText('Session type'), 'claude');
    await user.clear(within(dialog).getByLabelText('Session name'));
    await user.type(within(dialog).getByLabelText('Session name'), 'UI Claude');
    await user.clear(within(dialog).getByLabelText('Command'));
    await user.type(within(dialog).getByLabelText('Command'), 'claude run ui-agent');
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));

    expect(api.createHermesInstance).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open UI Claude' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'UI Claude' })).toBeInTheDocument();
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude run ui-agent').length).toBeGreaterThan(0);
  });

  it('renames agent sessions from the left navigation', async () => {
    const user = userEvent.setup();
    installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'New session' }));
    await user.selectOptions(screen.getByLabelText('Session type'), 'claude');
    await user.clear(screen.getByLabelText('Session name'));
    await user.type(screen.getByLabelText('Session name'), 'UI Claude');
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    await user.click(screen.getByRole('button', { name: 'Session actions for UI Claude' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit session' }));
    const renameInput = screen.getByRole('textbox', { name: 'Rename session' });
    await user.clear(renameInput);
    await user.type(renameInput, 'Database Claude{Enter}');

    expect(screen.getByRole('button', { name: 'Open Database Claude' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Database Claude' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open UI Claude' })).not.toBeInTheDocument();
  });

  it('creates Hermes agent sessions as isolated full Hermes chat surfaces with the same composer controls', async () => {
    const user = userEvent.setup();
    const pickedResource = {
      id: 'resource-notes',
      uri: 'file:///repos/sample-app/notes.md',
      mimeType: 'text/markdown',
      name: 'notes.md',
      text: '# Notes',
      sizeBytes: 7
    };
    const api = installLaunchBayMock({
      chooseAttachmentFile: vi.fn().mockResolvedValue({ canceled: false, resource: pickedResource }),
      listHermesSessions: vi.fn().mockResolvedValue({ sessions: [] }),
      resumeHermesSession: vi.fn().mockResolvedValue({ messages: [], pending: false }),
      setHermesApprovalMode: vi.fn().mockResolvedValue({ ok: true }),
      sendHermesInstanceMessage: vi.fn().mockImplementation(async (_instanceId: string, text: string) => ({
        messages: [
          { id: 'iu1', role: 'user', text },
          { id: 'ia1', role: 'assistant', text: `## Agent answer\n\nEmbedded Hermes reply: ${text}` }
        ],
        pending: false,
        contextUsage: { promptTokens: 20, completionTokens: 2, totalTokens: 22, contextLength: 100, percent: 22 }
      }))
    });

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'New session' }));
    expect(screen.getByLabelText('Session name')).toHaveValue('Hermes 2');
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    expect(api.createHermesInstance).toHaveBeenCalledWith('sample');
    expect(screen.getByRole('button', { name: 'Open Hermes 2' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open Hermes' })).toHaveLength(1);

    const sessionView = await screen.findByRole('region', { name: 'Sample Hermes 2' });
    expect(sessionView).toHaveClass('chat-view');
    expect(within(sessionView).queryByText('Type')).not.toBeInTheDocument();
    expect(within(sessionView).queryByText('Command')).not.toBeInTheDocument();
    expect(within(sessionView).getByLabelText('Hermes context usage')).toHaveTextContent('Context —');
    expect(within(sessionView).getByRole('checkbox', { name: 'Manual approval' })).toBeInTheDocument();
    expect(within(sessionView).getByRole('button', { name: 'Past sessions' })).toHaveTextContent('History');
    expect(within(sessionView).getByRole('button', { name: 'Attach file' })).toHaveTextContent('Attach');

    await user.click(within(sessionView).getByRole('checkbox', { name: 'Manual approval' }));
    expect(api.setHermesApprovalMode).toHaveBeenCalledWith('manual');

    await user.click(within(sessionView).getByRole('button', { name: 'Attach file' }));
    expect(await within(sessionView).findByText('notes.md')).toBeInTheDocument();

    const messageInput = within(sessionView).getByRole('textbox', { name: 'Message Hermes 2 about Sample' });
    await user.type(messageInput, 'status now{Enter}');

    expect(api.sendHermesInstanceMessage).toHaveBeenCalledWith('hermes-1', 'status now', undefined, [pickedResource]);
    expect(await within(sessionView).findByRole('heading', { level: 2, name: 'Agent answer' })).toBeInTheDocument();
    expect(within(sessionView).getByText('Embedded Hermes reply: status now')).toBeInTheDocument();

    const composer = sessionView.querySelector('.composer-bottom') as HTMLElement;
    await user.click(within(composer).getByRole('button', { name: 'Reset session' }));
    expect(api.resetHermesInstance).toHaveBeenCalledWith('hermes-1');
    expect(within(composer).queryByRole('button', { name: 'Close session' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Session actions for Hermes 2' }));
    expect(screen.getByRole('menuitem', { name: 'Edit session' })).toBeInTheDocument();
    await user.click(within(sessionView).getByRole('heading', { name: 'What do you want to work on?' }));
    expect(screen.queryByRole('menuitem', { name: 'Edit session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Kill session' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Session actions for Hermes 2' }));
    await user.click(screen.getByRole('menuitem', { name: 'Kill session' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Kill Hermes 2 session?' });
    expect(within(confirmDialog).getByText(/This will close the Hermes 2 session and discard its current context/i)).toBeInTheDocument();
    await user.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }));
    expect(api.closeHermesInstance).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open Hermes 2' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Session actions for Hermes 2' }));
    await user.click(screen.getByRole('menuitem', { name: 'Kill session' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Kill Hermes 2 session?' })).getByRole('button', { name: 'Kill session' }));
    expect(api.closeHermesInstance).toHaveBeenCalledWith('hermes-1');
    expect(screen.queryByRole('button', { name: 'Open Hermes 2' })).not.toBeInTheDocument();
  });

  it('shows local-first setup when no native bridge is available', () => {
    window.launchBay = undefined;
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Open your first project' })).toBeInTheDocument();
    expect(screen.getByText(/Browser preview stays empty by design/i)).toBeInTheDocument();
  });

  it('sends a Hermes message through the Electron bridge for the selected project and renders the assistant reply', async () => {
    const api = installLaunchBayMock();
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByPlaceholderText(/Ask Hermes about Sample/i);
    await user.type(input, 'Status of OT?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(api.sendHermesMessage).toHaveBeenCalledWith('sample', 'Status of OT?');
    expect(await screen.findByText('Status of OT?')).toBeInTheDocument();
    expect(await screen.findByText(/Hermes reply for sample: Status of OT\?/)).toBeInTheDocument();
  });

  it('turns the Hermes send button into a stop control while the LLM is thinking', async () => {
    const api = installLaunchBayMock({
      sendHermesMessage: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancelHermesPrompt: vi.fn().mockResolvedValue({ ok: true })
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByPlaceholderText(/Ask Hermes about Sample/i), 'Long task');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const stopButton = await screen.findByRole('button', { name: 'Stop Hermes' });
    expect(stopButton).toHaveClass('primary');
    expect(stopButton).toHaveTextContent('■');
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();

    await user.click(stopButton);

    expect(api.cancelHermesPrompt).toHaveBeenCalledWith('sample');
  });

  it('renders Hermes assistant replies as integrated markdown content', async () => {
    installLaunchBayMock({
      sendHermesMessage: vi.fn().mockResolvedValue({
        messages: [
          { id: 'u1', role: 'user', text: 'Format this' },
          { id: 'a1', role: 'assistant', text: '## Plano\n\n- **Primeiro** passo\n- Use `pnpm test`' }
        ],
        pending: false
      })
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByPlaceholderText(/Ask Hermes about Sample/i), 'Format this');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Plano' })).toBeInTheDocument();
    expect(screen.getByText('Primeiro')).toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.queryByText('now')).not.toBeInTheDocument();
  });

  it('shows Hermes context usage from the latest snapshot', async () => {
    installLaunchBayMock({
      sendHermesMessage: vi.fn().mockResolvedValue({
        messages: [
          { id: 'u1', role: 'user', text: 'Count context' },
          { id: 'a1', role: 'assistant', text: 'counted' }
        ],
        pending: false,
        contextUsage: {
          promptTokens: 11800,
          completionTokens: 400,
          totalTokens: 12200,
          contextLength: 200000,
          percent: 6.1
        }
      })
    });
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByLabelText('Hermes context usage')).toHaveTextContent('Context —');
    await user.type(screen.getByPlaceholderText(/Ask Hermes about Sample/i), 'Count context');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('counted')).toBeInTheDocument();
    expect(screen.getByLabelText('Hermes context usage')).toHaveTextContent('Context 12k / 200k · 6.1%');
  });

  it('isolates Hermes histories per project', async () => {
    installLaunchBayMock();
    const user = userEvent.setup();
    render(<App />);

    const otInput = screen.getByPlaceholderText('Ask Hermes about Sample');
    await user.type(otInput, 'Question for OT');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/Hermes reply for sample: Question for OT/);

    await user.click(screen.getByRole('button', { name: 'Sample Stack' }));

    expect(screen.queryByText('Question for OT')).not.toBeInTheDocument();
    expect(screen.queryByText(/Hermes reply for sample: Question for OT/)).not.toBeInTheDocument();

    const stackInput = screen.getByPlaceholderText('Ask Hermes about Sample Stack');
    await user.type(stackInput, 'Sample ask');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Hermes reply for sample-stack: Sample ask/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sample' }));
    expect(await screen.findByText('Question for OT')).toBeInTheDocument();
    expect(screen.queryByText('Sample ask')).not.toBeInTheDocument();
  });

  it('surfaces polished Hermes empty and error states for the active session', async () => {
    installLaunchBayMock({
      sendHermesMessage: vi.fn().mockResolvedValue({
        messages: [{ id: 'u1', role: 'user', text: 'broken' }],
        pending: false,
        error: 'Hermes responded with HTTP 500'
      })
    });
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByText('Hermes is ready for Sample')).toBeInTheDocument();
    expect(screen.getByText(/Start a focused chat for this project/i)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/Ask Hermes about Sample/i), 'broken');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Hermes hit a problem');
    expect(alert).toHaveTextContent('Hermes responded with HTTP 500');
    expect(alert).toHaveTextContent('Your messages stay in this session');
  });

  it('resets the active Hermes session from the composer', async () => {
    const api = installLaunchBayMock();
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByPlaceholderText(/Ask Hermes about Sample/i), 'old context');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Hermes reply for sample: old context/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset session' }));
    // The composer prompts for confirmation before discarding an active
    // conversation. Confirm to actually trigger the reset.
    await user.click(screen.getByRole('dialog', { name: 'Reset Hermes session?' }).querySelector('.primary') as HTMLElement);

    expect(api.resetHermesSession).toHaveBeenCalledWith('sample');
    expect(screen.queryByText('old context')).not.toBeInTheDocument();
    expect(screen.queryByText(/Hermes reply for sample: old context/)).not.toBeInTheDocument();
    expect(screen.getByText('What do you want to work on?')).toBeInTheDocument();
  });

  // The sidebar "New chat" entry was removed; the only reset path is now the
  // composer button covered by "resets the active Hermes session from the
  // composer". This case is intentionally retired.
  it.skip('resets the active Hermes session from New chat', () => {});

  it('shows an accessible thinking indicator with elapsed time while a Hermes message is in flight', async () => {
    vi.useFakeTimers();
    let resolveSend: (snapshot: { messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>; pending: boolean; error?: string }) => void = () => undefined;
    installLaunchBayMock({
      sendHermesMessage: vi.fn().mockImplementation(
        () => new Promise((resolve) => {
          resolveSend = resolve;
        })
      )
    });
    render(<App />);

    fireEvent.change(screen.getByPlaceholderText(/Ask Hermes about Sample/i), { target: { value: 'How is OT?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/Thinking through the context/i);
    expect(status).toHaveTextContent('00:00');
    expect(status).not.toHaveTextContent('Hermes');
    expect(screen.getByRole('button', { name: 'Stop Hermes' })).toHaveClass('primary');
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('00:07');

    await act(async () => {
      resolveSend({
        messages: [
          { id: 'u1', role: 'user', text: 'How is OT?' },
          { id: 'a1', role: 'assistant', text: 'all clear' }
        ],
        pending: false
      });
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('all clear')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
    vi.useRealTimers();
  });

  it('clears the thinking indicator when Hermes returns an error', async () => {
    vi.useFakeTimers();
    let resolveSend: (snapshot: { messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>; pending: boolean; error?: string }) => void = () => undefined;
    installLaunchBayMock({
      sendHermesMessage: vi.fn().mockImplementation(
        () => new Promise((resolve) => {
          resolveSend = resolve;
        })
      )
    });
    render(<App />);

    fireEvent.change(screen.getByPlaceholderText(/Ask Hermes about Sample/i), { target: { value: 'crash?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('status')).toBeInTheDocument();

    await act(async () => {
      resolveSend({
        messages: [{ id: 'u1', role: 'user', text: 'crash?' }],
        pending: false,
        error: 'Hermes responded with HTTP 500'
      });
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Hermes responded with HTTP 500');
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
    vi.useRealTimers();
  });

  it('hydrates the current project Hermes session from the Electron bridge on mount', async () => {
    const api = installLaunchBayMock({
      getHermesSession: vi.fn().mockImplementation(async (projectId: string) => {
        if (projectId === 'sample') {
          return {
            messages: [
              { id: 'h-u', role: 'user', text: 'persisted-question' },
              { id: 'h-a', role: 'assistant', text: 'persisted-reply' }
            ],
            pending: false
          };
        }
        return { messages: [], pending: false };
      })
    });

    render(<App />);

    expect(await screen.findByText('persisted-question')).toBeInTheDocument();
    expect(screen.getByText('persisted-reply')).toBeInTheDocument();
    expect(api.getHermesSession).toHaveBeenCalledWith('sample');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('hydrates Hermes history for the newly selected project when switching projects', async () => {
    const api = installLaunchBayMock({
      getHermesSession: vi.fn().mockImplementation(async (projectId: string) => {
        if (projectId === 'sample-stack') {
          return {
            messages: [
              { id: 'l-u', role: 'user', text: 'sample-prior-question' },
              { id: 'l-a', role: 'assistant', text: 'sample-prior-reply' }
            ],
            pending: false
          };
        }
        return { messages: [], pending: false };
      })
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Sample Stack' }));

    expect(await screen.findByText('sample-prior-question')).toBeInTheDocument();
    expect(screen.getByText('sample-prior-reply')).toBeInTheDocument();
    expect(api.getHermesSession).toHaveBeenCalledWith('sample-stack');
  });

  it('shows the thinking indicator when the hydrated session is still pending', async () => {
    installLaunchBayMock({
      getHermesSession: vi.fn().mockResolvedValue({
        messages: [{ id: 'u-prior', role: 'user', text: 'pending-question' }],
        pending: true
      })
    });

    render(<App />);

    expect(await screen.findByText('pending-question')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Thinking through the context/i);
    expect(screen.getByRole('status')).not.toHaveTextContent('Hermes');
  });

  it('does not invoke getHermesSession when no Electron bridge is available', () => {
    window.launchBay = undefined;
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Open your first project' })).toBeInTheDocument();
    expect(screen.getByText(/Browser preview stays empty by design/i)).toBeInTheDocument();
  });

  it('focuses the Hermes composer when pressing Cmd+K from the chat surface', async () => {
    installLaunchBayMock();
    render(<App />);

    const input = screen.getByRole('textbox', { name: /Message Hermes about Sample/i });
    expect(input).not.toHaveFocus();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    await waitFor(() => expect(input).toHaveFocus());
  });

  it('focuses the Hermes composer with Ctrl+K and switches from the Server surface', async () => {
    installLaunchBayMock();
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Server' }));
    expect(screen.queryByRole('textbox', { name: /Message Hermes/i })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const input = await screen.findByRole('textbox', { name: /Message Hermes about Sample/i });
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('does not hijack a plain "k" keystroke as the focus shortcut', async () => {
    installLaunchBayMock();
    render(<App />);

    const input = screen.getByRole('textbox', { name: /Message Hermes about Sample/i });
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true, shiftKey: true });

    await act(async () => {
      await Promise.resolve();
    });
    expect(input).not.toHaveFocus();
  });

  it('clears the composer draft when Escape is pressed with non-empty content', () => {
    installLaunchBayMock();
    render(<App />);

    const input = screen.getByRole('textbox', { name: /Message Hermes about Sample/i }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'draft to discard' } });
    expect(input.value).toBe('draft to discard');

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('');
  });

  it('does not clear the composer draft on Escape during IME composition', () => {
    installLaunchBayMock();
    render(<App />);

    const input = screen.getByRole('textbox', { name: /Message Hermes about Sample/i }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'こんにちは' } });

    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });

    expect(input.value).toBe('こんにちは');
  });

  it('removes the global Cmd+K listener on unmount', async () => {
    installLaunchBayMock();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<App />);

    unmount();

    expect(removeSpy.mock.calls.some(([eventName]) => eventName === 'keydown')).toBe(true);
    removeSpy.mockRestore();
  });

  it('applies Hermes updates pushed by Electron without changing surface', async () => {
    let listener: ((event: { projectId: string; snapshot: { messages: Array<{ id: string; role: string; text: string }>; pending: boolean } }) => void) | undefined;
    installLaunchBayMock({
      onHermesUpdate: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      })
    });
    render(<App />);

    act(() => {
      listener?.({
        projectId: 'sample',
        snapshot: {
          messages: [
            { id: 'u-async', role: 'user', text: 'pushed-question' },
            { id: 'a-async', role: 'assistant', text: 'pushed-reply' }
          ],
          pending: false
        }
      });
    });

    expect(await screen.findByText('pushed-question')).toBeInTheDocument();
    expect(screen.getByText('pushed-reply')).toBeInTheDocument();
  });

  it('copies an assistant reply to the clipboard and shows a temporary Copied label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboardMock({ writeText });

    installLaunchBayMock({
      getHermesSession: vi.fn().mockResolvedValue({
        messages: [
          { id: 'u1', role: 'user', text: 'ping' },
          { id: 'a1', role: 'assistant', text: 'pong reply' }
        ],
        pending: false
      })
    });
    render(<App />);
    expect(window.navigator.clipboard?.writeText).toBe(writeText);

    await screen.findByText('pong reply');
    const copyButton = screen.getByRole('button', { name: 'Copy message' });
    expect(copyButton).toHaveTextContent('Copy');

    fireEvent.click(copyButton);

    await waitFor(() => expect(copyButton).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith('pong reply');
  });

  it('does not expose legacy server logger controls', async () => {
    const user = userEvent.setup();
    installLaunchBayMock();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(screen.getByLabelText('Server terminal')).toBeInTheDocument();
    expect(screen.queryByLabelText('Server logs')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy log' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open terminal' })).not.toBeInTheDocument();
  });

  it('keeps the copy label as Copy when clipboard is unavailable or write fails', async () => {
    setClipboardMock(undefined);

    installLaunchBayMock({
      getHermesSession: vi.fn().mockResolvedValue({
        messages: [
          { id: 'u1', role: 'user', text: 'ping' },
          { id: 'a1', role: 'assistant', text: 'no clipboard reply' }
        ],
        pending: false
      })
    });
    render(<App />);

    await screen.findByText('no clipboard reply');
    const copyButton = screen.getByRole('button', { name: 'Copy message' });
    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });
    expect(copyButton).toHaveTextContent('Copy');

    const failingWrite = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboardMock({ writeText: failingWrite });

    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });
    expect(failingWrite).toHaveBeenCalledWith('no clipboard reply');
    await act(async () => {
      await Promise.resolve();
    });
    expect(copyButton).toHaveTextContent('Copy');
  });
});
