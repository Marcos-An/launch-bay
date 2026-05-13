import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

type TestWorkspaceConfig = { id: string; name: string; cwd: string; createdAt: string; updatedAt: string; description?: string };
type TestServerConfig = { id: string; workspaceId: string; name: string; cwd: string; command: string; url?: string; description?: string; createdAt: string; updatedAt: string };
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
        url: draft.url,
        description: draft.description,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    })),
    deleteServerConfig: vi.fn().mockResolvedValue(defaultConfig),
    chooseServerDirectory: vi.fn().mockResolvedValue({ canceled: false, path: '/repos/sample-api' }),
    inspectServerDirectory: vi.fn().mockResolvedValue({ path: '/repos/sample-api', exists: true, isDirectory: true, isGitRepository: true, branch: 'main', dirty: false }),
    startProject: vi.fn().mockResolvedValue({ status: 'running', log: '$ API_SERVER=https://api.staging.example.com yarn run development\n[web] ready' }),
    stopProject: vi.fn().mockResolvedValue({ status: 'stopped', log: '$ API_SERVER=https://api.staging.example.com yarn run development\n[process] stopped' }),
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

  it('shows project cwd, git state, and a configure action when the selected project has no server yet', async () => {
    const projectOnlyConfig: TestLaunchBayConfig = {
      version: 1,
      localUser: { id: 'local-test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', onboardingCompleted: true },
      workspaces: [{ id: 'sample-app', name: 'sample-app', cwd: '/repos/sample-app', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      servers: []
    };
    installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(projectOnlyConfig),
      getRuntimeStatus: vi.fn()
        .mockResolvedValueOnce({ status: 'stopped', log: '' })
        .mockResolvedValue({ status: 'stopped', log: '', branch: 'feature/project-detect', dirty: false }),
      listProjectBranches: vi.fn()
        .mockResolvedValueOnce({ cwd: '', branches: [], error: 'Project runtime is not configured.' })
        .mockResolvedValue({
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
    expect(await screen.findAllByText('feature/project-detect')).toHaveLength(3);
    expect(screen.getByText('origin/main')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure server' })).toBeInTheDocument();
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
        url: 'http://localhost:5000',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    };
    const api = installLaunchBayMock({
      getLaunchBayConfig: vi.fn().mockResolvedValue(config),
      getRuntimeStatus: vi.fn().mockResolvedValue({ status: 'stopped', log: '', branch: 'main', dirty: false }),
      listProjectBranches: vi.fn().mockResolvedValue({ cwd: '/repos/sample-app', current: 'main', dirty: false, branches: [{ name: 'main', current: true }] }),
      startProject: vi.fn().mockResolvedValue({ status: 'running', log: '$ pnpm dev\nready', branch: 'main', dirty: false })
    }, config);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Server' }));
    await waitFor(() => expect(api.getRuntimeStatus).toHaveBeenCalledWith('server-sample-web'));
    expect(screen.getByRole('button', { name: 'Edit server' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add server' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Server runtime' })).getByRole('button', { name: 'New server' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit server' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit server' });
    expect(within(dialog).getByLabelText('Server name')).toHaveValue('Sample Web');
    expect(within(dialog).getByLabelText('Local URL')).toHaveValue('http://localhost:5000');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(api.startProject).toHaveBeenCalledWith('server-sample-web');
    expect(await screen.findByText(/\$ pnpm dev/)).toBeInTheDocument();
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
    await user.type(within(dialog).getByLabelText('Local URL'), 'http://localhost:3333');
    await user.click(within(dialog).getByRole('button', { name: 'Save server' }));

    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(api.saveServerConfig).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'sample-stack',
      name: 'Sample API',
      cwd: '/repos/sample-api',
      command: 'pnpm dev',
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
    const appCss = readFileSync('src/App.css', 'utf8');
    expect(appCss).toMatch(/\.chat-inner\s*\{[^}]*text-align:\s*center/s);
    expect(appCss).toMatch(/\.suggestions\s*\{[^}]*margin:\s*34px auto 0/s);
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

  it('shows a GitLens-style branch manager with search, fetch, quick switch, and merge actions', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock();

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

    await user.click(within(config).getByRole('button', { name: 'Merge feature/session-cockpit into main' }));
    expect(api.mergeProjectBranch).not.toHaveBeenCalled();
    const mergeDialog = await screen.findByRole('dialog', { name: 'Confirm merge' });
    expect(within(mergeDialog).getAllByText('feature/session-cockpit').length).toBeGreaterThan(0);
    expect(within(mergeDialog).getAllByText('main').length).toBeGreaterThan(0);
    await user.click(within(mergeDialog).getByRole('button', { name: 'Cancel' }));
    expect(api.mergeProjectBranch).not.toHaveBeenCalled();

    await user.click(within(config).getByRole('button', { name: 'Merge feature/session-cockpit into main' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm merge' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'Confirm merge' }));
    expect(api.mergeProjectBranch).toHaveBeenCalledWith('sample', 'feature/session-cockpit');

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
    const appCss = readFileSync('src/App.css', 'utf8');
    expect(appCss).toMatch(/button:disabled\s*\{[^}]*opacity:\s*0\.42[^}]*cursor:\s*not-allowed[^}]*pointer-events:\s*none/s);
    expect(appCss).toContain('.terminal-action:hover:not(:disabled)');
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
    expect(screen.getByText('main')).toHaveClass('row-subtitle');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByText('feature/new-branch')).toHaveClass('row-subtitle');
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });

  it('starts the Sample runtime through Electron and shows streamed logs', async () => {
    const api = installLaunchBayMock();
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(api.startProject).toHaveBeenCalledWith('sample');
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
    expect(screen.getByText(/\$ API_SERVER=https:\/\/api\.staging\.example\.com yarn run development/)).toBeInTheDocument();
    expect(screen.getByText(/\[web\] ready/)).toBeInTheDocument();
  });

  it('stops the selected project runtime through Electron', async () => {
    const api = installLaunchBayMock({
      // Start the server already in the running state so Stop is enabled.
      getRuntimeStatus: vi.fn().mockResolvedValue({
        status: 'running',
        log: '$ API_SERVER=https://api.staging.example.com yarn run development\n[web] ready',
        pid: 1234
      }),
      stopProject: vi.fn().mockResolvedValue({ status: 'stopped', log: '[process] stopped' })
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(api.stopProject).toHaveBeenCalledWith('sample');
    expect(screen.getAllByText('stopped').length).toBeGreaterThan(0);
    expect(screen.getByText(/\[process\] stopped/)).toBeInTheDocument();
  });

  it('applies runtime updates sent by Electron without changing surface', async () => {
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
    expect(screen.getByText('[vite] Local: http://localhost:5000')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Open terminal' }));

    const main = document.querySelector('.main') as HTMLElement;
    const embeddedStack = screen.getByLabelText('Sample embedded sessions');
    const serverView = screen.getByRole('region', { name: 'Sample server' });

    expect(within(serverView).queryByRole('button', { name: 'Open Hermes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Hermes' })).toBeInTheDocument();
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    expect(main).toHaveStyle({ overflowX: 'hidden', overflowY: 'auto' });
    const appCss = readFileSync('src/App.css', 'utf8');
    expect(appCss).toContain('scrollbar-color: rgba(255, 255, 255, 0.24) transparent');
    expect(appCss).toContain('.main::-webkit-scrollbar-track { background: transparent; }');
    expect(main).toContainElement(embeddedStack);
    expect(await screen.findByRole('region', { name: 'Terminal 1 · sample-app' })).toBeInTheDocument();
  });

  it('opens embedded terminal cards under the server log for the selected project', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    await user.click(screen.getByRole('button', { name: 'Open terminal' }));

    expect(api.createTerminal).toHaveBeenNthCalledWith(1, 'sample', '~/repos/sample-app');
    expect(api.createTerminal).toHaveBeenNthCalledWith(2, 'sample', '~/repos/sample-app');
    expect(await screen.findByRole('region', { name: 'Terminal 1 · sample-app' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Terminal 2 · sample-app' })).toBeInTheDocument();
  });

  it('routes terminal output, input, kill, and close through the embedded terminal bridge', async () => {
    let terminalDataListener: ((event: { id: string; data: string }) => void) | undefined;
    const user = userEvent.setup();
    const api = installLaunchBayMock({
      onTerminalData: vi.fn((callback) => {
        terminalDataListener = callback;
        return () => undefined;
      })
    });

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await user.click(screen.getByRole('button', { name: 'Open terminal' }));

    act(() => terminalDataListener?.({ id: 'term-1', data: 'hello from shell\n' }));
    expect(await screen.findByText(/hello from shell/)).toBeInTheDocument();

    const terminalCard = screen.getByRole('region', { name: 'Terminal 1 · sample-app' });
    const terminalBox = within(terminalCard).getByRole('textbox', { name: 'Interactive terminal for Terminal 1 · sample-app' });
    expect(within(terminalCard).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(within(terminalCard).queryByRole('textbox', { name: /Command for/ })).not.toBeInTheDocument();
    await user.type(terminalBox, 'pwd{Enter}');
    expect(api.writeTerminal).toHaveBeenCalledWith('term-1', 'p');
    expect(api.writeTerminal).toHaveBeenCalledWith('term-1', 'w');
    expect(api.writeTerminal).toHaveBeenCalledWith('term-1', 'd');
    expect(api.writeTerminal).toHaveBeenCalledWith('term-1', '\r');

    await user.click(within(terminalCard).getByRole('button', { name: 'Kill' }));
    expect(api.killTerminal).toHaveBeenCalledWith('term-1');
    await user.click(within(terminalCard).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Terminal 1 · sample-app' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Rename Hermes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hermes' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename Hermes' }));
    const renameInput = screen.getByRole('textbox', { name: 'Rename session' });
    await user.clear(renameInput);
    await user.type(renameInput, 'Planning Hermes{Enter}');

    expect(screen.getByRole('button', { name: 'Open Planning Hermes' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Message Planning Hermes about Sample/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Hermes' })).not.toBeInTheDocument();
  });

  it('groups selected project navigation with Sessions before Server runtime', () => {
    installLaunchBayMock();

    render(<App />);

    const workspaceNav = screen.getByRole('navigation', { name: 'Sample workspace' });
    const sessionsGroup = within(workspaceNav).getByRole('group', { name: 'Sessions' });
    const serverGroup = within(workspaceNav).getByRole('group', { name: 'Server runtime' });

    expect(sessionsGroup.compareDocumentPosition(serverGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sessionsGroup).getByRole('button', { name: 'Open Hermes' })).toBeInTheDocument();
    expect(within(sessionsGroup).getByRole('button', { name: 'New session' })).toBeInTheDocument();
    expect(within(serverGroup).getByRole('button', { name: 'Server' })).toBeInTheDocument();
    expect(within(serverGroup).queryByRole('button', { name: 'Open Hermes' })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: 'Rename UI Claude' }));
    const renameInput = screen.getByRole('textbox', { name: 'Rename session' });
    await user.clear(renameInput);
    await user.type(renameInput, 'Database Claude{Enter}');

    expect(screen.getByRole('button', { name: 'Open Database Claude' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Database Claude' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open UI Claude' })).not.toBeInTheDocument();
  });

  it('creates Hermes agent sessions from the sidebar and routes messages through the Electron bridge', async () => {
    const user = userEvent.setup();
    const api = installLaunchBayMock();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'New session' }));
    await user.clear(screen.getByLabelText('Session name'));
    await user.type(screen.getByLabelText('Session name'), 'Extra Hermes');
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    expect(api.createHermesInstance).toHaveBeenCalledWith('sample');
    expect(screen.getByRole('button', { name: 'Open Extra Hermes' })).toBeInTheDocument();

    const sessionView = await screen.findByRole('region', { name: 'Extra Hermes' });
    const messageInput = within(sessionView).getByRole('textbox', { name: 'Message Extra Hermes' });
    await user.type(messageInput, 'status now{Enter}');

    expect(api.sendHermesInstanceMessage).toHaveBeenCalledWith('hermes-1', 'status now');
    expect(await within(sessionView).findByText('Embedded Hermes reply: status now')).toBeInTheDocument();

    await user.click(within(sessionView).getByRole('button', { name: 'Reset' }));
    expect(api.resetHermesInstance).toHaveBeenCalledWith('hermes-1');
    await user.click(within(sessionView).getByRole('button', { name: 'Close' }));
    expect(api.closeHermesInstance).toHaveBeenCalledWith('hermes-1');
    expect(screen.queryByRole('button', { name: 'Open Extra Hermes' })).not.toBeInTheDocument();
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

  it('surfaces Hermes errors returned by the Electron bridge', async () => {
    installLaunchBayMock({
      sendHermesMessage: vi.fn().mockResolvedValue({
        messages: [{ id: 'u1', role: 'user', text: 'broken' }],
        pending: false,
        error: 'Hermes responded with HTTP 500'
      })
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByPlaceholderText(/Ask Hermes about Sample/i), 'broken');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/Hermes responded with HTTP 500/)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

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

  it('copies the visible server log and shows a temporary Copied label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    setClipboardMock({ writeText });
    installLaunchBayMock();
    render(<App />);

    expect(window.navigator.clipboard?.writeText).toBe(writeText);
    await user.click(screen.getByRole('button', { name: 'Server' }));
    expect(window.navigator.clipboard?.writeText).toBe(writeText);
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/\[web\] ready/);
    expect(window.navigator.clipboard?.writeText).toBe(writeText);

    const copyButton = screen.getByRole('button', { name: 'Copy log' });
    fireEvent.click(copyButton);

    await waitFor(() => expect(copyButton).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('[web] ready'));
  });

  it('keeps the Copy log label stable when clipboard is unavailable or write fails', async () => {
    installLaunchBayMock();
    const user = userEvent.setup();
    setClipboardMock(undefined);
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Server' }));
    const copyButton = screen.getByRole('button', { name: 'Copy log' });
    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });
    expect(copyButton).toHaveTextContent('Copy log');

    const failingWrite = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboardMock({ writeText: failingWrite });

    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });
    expect(failingWrite).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(copyButton).toHaveTextContent('Copy log');
  });

  it('clears the visible server log for the selected project and surfaces new runtime updates again', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/\[web\] ready/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/\[web\] ready/)).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Open terminal' })).not.toBeDisabled();
    const serverView = screen.getByRole('region', { name: 'Sample server' });
    expect(within(serverView).queryByRole('button', { name: 'Open Hermes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Hermes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument();

    act(() => {
      listener?.({
        projectId: 'sample',
        snapshot: {
          status: 'running',
          log: '$ API_SERVER=https://api.staging.example.com yarn run development\n[web] ready\n[web] hot update applied'
        }
      });
    });

    expect(await screen.findByText(/\[web\] hot update applied/)).toBeInTheDocument();
    expect(screen.queryByText(/\[web\] ready$/)).not.toBeInTheDocument();
  });

  it('autoscrolls the server log to the latest content when the displayed log changes', async () => {
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

    const logElement = document.querySelector('.terminal-panel pre') as HTMLPreElement;
    Object.defineProperty(logElement, 'scrollHeight', { configurable: true, value: 980 });
    Object.defineProperty(logElement, 'clientHeight', { configurable: true, value: 200 });
    logElement.scrollTop = 0;

    act(() => {
      listener?.({
        projectId: 'sample',
        snapshot: {
          status: 'running',
          log: 'line 1\nline 2\nline 3\nline 4\nline 5'
        }
      });
    });

    await waitFor(() => expect(logElement.scrollTop).toBe(980));
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
