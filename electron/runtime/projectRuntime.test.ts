// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager, createProjectRuntimeConfig, listInstalledNvmNodeVersions, resolveGitMergePreview, type RuntimeUpdate } from './projectRuntime.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

const noNodePin = () => undefined;

function withTempNvmVersions(callback: (versionsDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'launch-bay-nvm-'));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function createGitRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'launch-bay-merge-preview-'));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'launch-bay@example.test']);
  git(cwd, ['config', 'user.name', 'Launch Bay']);
  writeFileSync(join(cwd, 'README.md'), 'hello\n');
  git(cwd, ['add', 'README.md']);
  git(cwd, ['commit', '-m', 'initial']);
  return cwd;
}

// Shared per-test sample config so individual cases stay focused.
function sampleConfigs() {
  return [
    {
      id: 'sample',
      cwd: '~/Documents/sample-app',
      displayCommand: 'API_SERVER=https://api.example.com pnpm run dev',
      command: 'pnpm',
      args: ['run', 'dev'],
      env: { API_SERVER: 'https://api.example.com' }
    }
  ];
}

describe('ProjectRuntimeManager', () => {
  it('previews a branch merge without mutating the current branch', () => {
    const cwd = createGitRepo();
    try {
      git(cwd, ['checkout', '-b', 'feature/preview']);
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'src/app.ts'), 'export const app = 1;\n');
      git(cwd, ['add', 'src/app.ts']);
      git(cwd, ['commit', '-m', 'Add app shell']);
      writeFileSync(join(cwd, 'README.md'), 'hello\nworld\n');
      git(cwd, ['add', 'README.md']);
      git(cwd, ['commit', '-m', 'Update readme']);
      git(cwd, ['checkout', 'main']);

      const preview = resolveGitMergePreview(cwd, 'feature/preview');

      expect(preview.targetBranch).toBe('main');
      expect(preview.sourceBranch).toBe('feature/preview');
      expect(preview.canMerge).toBe(true);
      expect(preview.blockers).toEqual([]);
      expect(preview.commits.map((commit) => commit.subject)).toEqual(['Update readme', 'Add app shell']);
      expect(preview.files.map((file) => `${file.status}:${file.path}`)).toEqual(['M:README.md', 'A:src/app.ts']);
      expect(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('lists only installed NVM Node versions for server selection', () => {
    withTempNvmVersions((versionsDir) => {
      mkdirSync(join(versionsDir, 'v18.20.8', 'bin'), { recursive: true });
      mkdirSync(join(versionsDir, 'v22.18.0', 'bin'), { recursive: true });
      mkdirSync(join(versionsDir, 'v22.22.2', 'bin'), { recursive: true });
      mkdirSync(join(versionsDir, 'v22.18'), { recursive: true });
      mkdirSync(join(versionsDir, 'not-node', 'bin'), { recursive: true });

      expect(listInstalledNvmNodeVersions(versionsDir)).toEqual(['22.22.2', '22.18.0', '18.20.8']);
    });
  });

  it('does not persist partial Node versions as an explicit runtime pin', () => {
    expect(createProjectRuntimeConfig({ id: 'sample', cwd: '/repos/sample-app', command: 'pnpm dev', nodeVersion: '22.18' }).nodeVersion).toBeUndefined();
    expect(createProjectRuntimeConfig({ id: 'sample', cwd: '/repos/sample-app', command: 'pnpm dev', nodeVersion: 'v22.18.0' }).nodeVersion).toBe('22.18.0');
  });

  it('starts dynamic local server configs independently through the login shell', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const manager = new ProjectRuntimeManager(
      [
        createProjectRuntimeConfig({ id: 'api', cwd: '/repos/api', command: 'pnpm dev' }),
        createProjectRuntimeConfig({ id: 'web', cwd: '/repos/web', command: 'pnpm dev -- --host' })
      ],
      spawnProcess,
      noNodePin,
      vi.fn((cwd: string) => (cwd.includes('/repos/api') ? 'api-branch' : 'web-branch')),
      vi.fn(() => false)
    );

    const snapshot = await manager.start('api');

    expect(snapshot.status).toBe('running');
    expect(snapshot.branch).toBe('api-branch');
    // The platform helper picks whichever login shell is available on the
    // host (zsh on macOS, bash on most Linux images, pwsh/cmd on Windows).
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.stringMatching(/zsh|bash|sh|pwsh|cmd/i),
      expect.arrayContaining(['pnpm dev']),
      expect.objectContaining({ cwd: '/repos/api', shell: false })
    );
    expect(manager.getSnapshot('web').status).toBe('stopped');
    expect(manager.getSnapshot('web').branch).toBe('web-branch');
  });

  it('can replace dynamic server configs and remove stale runtime state', () => {
    const manager = new ProjectRuntimeManager(
      [createProjectRuntimeConfig({ id: 'api', cwd: '/repos/api', command: 'pnpm dev' })],
      vi.fn() as never,
      noNodePin,
      vi.fn(() => 'main'),
      vi.fn(() => false)
    );

    manager.setConfigs([createProjectRuntimeConfig({ id: 'web', cwd: '/repos/web', command: 'pnpm dev' })]);

    expect(manager.getSnapshot('api').error).toBeUndefined();
    expect(manager.listBranches('api').error).toMatch(/not configured/i);
    expect(manager.listBranches('web').cwd).toBe('/repos/web');
  });

  it('starts a project with the configured env and command', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const events: RuntimeUpdate[] = [];
    const manager = new ProjectRuntimeManager(sampleConfigs(), spawnProcess, noNodePin);
    manager.onUpdate((event) => events.push(event));

    const snapshot = await manager.start('sample');

    expect(snapshot.status).toBe('running');
    expect(snapshot.log).toContain('$ API_SERVER=https://api.example.com pnpm run dev');
    expect(spawnProcess).toHaveBeenCalledWith(
      'pnpm',
      ['run', 'dev'],
      expect.objectContaining({
        cwd: join(homedir(), 'Documents/sample-app'),
        env: expect.objectContaining({ API_SERVER: 'https://api.example.com' }),
        shell: false
      })
    );

    child.stdout.emit('data', Buffer.from('[web] ready on http://localhost:5000\n'));
    expect(events.at(-1)?.snapshot.log).toContain('[web] ready on http://localhost:5000');
  });

  it('does not leak Launch Bay/Electron package-manager env into server processes', async () => {
    const previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      npm_lifecycle_event: process.env.npm_lifecycle_event,
      npm_package_json: process.env.npm_package_json,
      INIT_CWD: process.env.INIT_CWD,
      PATH: process.env.PATH
    };
    process.env.NODE_ENV = 'production';
    process.env.NODE_OPTIONS = '--max-old-space-size=8192 --expose-gc';
    process.env.npm_lifecycle_event = 'dev';
    process.env.npm_package_json = '/Users/marcos/Documents/launch-bay/package.json';
    process.env.INIT_CWD = '/Users/marcos/Documents/launch-bay';
    process.env.PATH = '/Users/marcos/Documents/launch-bay/node_modules/.bin:/snapshot/dist/node-gyp-bin:/usr/bin:/bin';

    try {
      const child = new FakeChild();
      const spawnProcess = vi.fn(() => child as never);
      const manager = new ProjectRuntimeManager(
        sampleConfigs(),
        spawnProcess,
        vi.fn(() => ({ version: '22.18.0', binPath: '/fake/nvm/v22.18.0/bin' }))
      );

      await manager.start('sample');
      const env = spawnProcess.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;

      expect(env.API_SERVER).toBe('https://api.example.com');
      expect(env.NODE_ENV).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.npm_lifecycle_event).toBeUndefined();
      expect(env.npm_package_json).toBeUndefined();
      expect(env.INIT_CWD).toBeUndefined();
      expect(env.PATH).toBe('/fake/nvm/v22.18.0/bin:/usr/bin:/bin');
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('prefers a configured Node version over the project .nvmrc when starting', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const resolveNodeBin = vi.fn((_cwd: string, preferredVersion?: string) => ({
      version: preferredVersion ?? '22.18.0',
      binPath: '/Users/marcos/.nvm/versions/node/v18.20.8/bin'
    }));
    const manager = new ProjectRuntimeManager(
      [createProjectRuntimeConfig({ id: 'sample', cwd: '/repos/sample-app', command: 'yarn run development', nodeVersion: '18.20.8' })],
      spawnProcess,
      resolveNodeBin,
      vi.fn(() => 'main'),
      vi.fn(() => false)
    );

    const snapshot = await manager.start('sample');

    expect(snapshot.status).toBe('running');
    expect(snapshot.log).toContain('[runtime] Node v18.20.8 (/Users/marcos/.nvm/versions/node/v18.20.8/bin)');
    expect(resolveNodeBin).toHaveBeenCalledWith('/repos/sample-app', '18.20.8');
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: expect.stringMatching(/^\/Users\/marcos\/\.nvm\/versions\/node\/v18\.20\.8\/bin:/)
        })
      })
    );
  });

  it('does not start when the configured Node version is not installed', async () => {
    const spawnProcess = vi.fn();
    const manager = new ProjectRuntimeManager(
      [createProjectRuntimeConfig({ id: 'sample', cwd: '/repos/sample-app', command: 'yarn run development', nodeVersion: '20.19.0' })],
      spawnProcess as never,
      vi.fn(() => ({ version: '20.19.0', error: 'Node v20.19.0 is not installed.' })),
      vi.fn(() => 'main'),
      vi.fn(() => false)
    );

    const snapshot = await manager.start('sample');

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(snapshot.status).toBe('stopped');
    expect(snapshot.error).toBe('Node v20.19.0 is not installed.');
    expect(snapshot.log).toContain('[runtime] Node v20.19.0 is not installed.');
  });

  it('includes the active git branch in runtime snapshots', () => {
    const manager = new ProjectRuntimeManager(
      sampleConfigs(),
      vi.fn() as never,
      noNodePin,
      vi.fn(() => 'feature/launch-bay'),
      vi.fn(() => false)
    );

    const snapshot = manager.getSnapshot('sample');

    expect(snapshot.branch).toBe('feature/launch-bay');
    expect(snapshot.dirty).toBe(false);
  });

  it('refreshes git dirty state in runtime snapshots', () => {
    const resolveDirty = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const manager = new ProjectRuntimeManager(
      sampleConfigs(),
      vi.fn() as never,
      noNodePin,
      vi.fn(() => 'feature/launch-bay'),
      resolveDirty
    );

    expect(manager.getSnapshot('sample').dirty).toBe(true);
    expect(resolveDirty).toHaveBeenCalledWith(join(homedir(), 'Documents/sample-app'));
  });

  it('lists configured project branches with GitLens-style metadata and current dirty state', () => {
    const manager = new ProjectRuntimeManager(
      sampleConfigs(),
      vi.fn() as never,
      noNodePin,
      vi.fn(() => 'main'),
      vi.fn(() => false),
      vi.fn(() => [
        { name: 'main', upstream: 'origin/main', ahead: 1, behind: 0, lastCommit: 'Update shell' },
        { name: 'feature/session-cockpit', upstream: 'origin/feature/session-cockpit', ahead: 0, behind: 2, lastCommit: 'Branch UI' }
      ])
    );

    expect(manager.listBranches('sample')).toEqual({
      cwd: join(homedir(), 'Documents/sample-app'),
      current: 'main',
      dirty: false,
      branches: [
        { name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 0, lastCommit: 'Update shell' },
        { name: 'feature/session-cockpit', current: false, upstream: 'origin/feature/session-cockpit', ahead: 0, behind: 2, lastCommit: 'Branch UI' }
      ]
    });
  });

  it('refuses to switch branches while the worktree is dirty', () => {
    const checkout = vi.fn();
    const manager = new ProjectRuntimeManager(
      sampleConfigs(),
      vi.fn() as never,
      noNodePin,
      vi.fn(() => 'main'),
      vi.fn(() => true),
      vi.fn(() => [{ name: 'main' }, { name: 'feature/session-cockpit' }]),
      checkout
    );

    const result = manager.switchBranch('sample', 'feature/session-cockpit');

    expect(checkout).not.toHaveBeenCalled();
    expect(result.error).toMatch(/commit or stash/i);
    expect(result.runtime.branch).toBe('main');
    expect(result.runtime.dirty).toBe(true);
  });

  it('switches branches only to a known clean branch and refreshes runtime state', () => {
    const checkout = vi.fn();
    const resolveBranch = vi.fn()
      .mockReturnValueOnce('main')
      .mockReturnValueOnce('feature/session-cockpit')
      .mockReturnValue('feature/session-cockpit');
    const manager = new ProjectRuntimeManager(
      sampleConfigs(),
      vi.fn() as never,
      noNodePin,
      resolveBranch,
      vi.fn(() => false),
      vi.fn(() => [{ name: 'main' }, { name: 'feature/session-cockpit' }]),
      checkout
    );

    const result = manager.switchBranch('sample', 'feature/session-cockpit');

    expect(checkout).toHaveBeenCalledWith(join(homedir(), 'Documents/sample-app'), 'feature/session-cockpit');
    expect(result.current).toBe('feature/session-cockpit');
    expect(result.runtime.branch).toBe('feature/session-cockpit');
    expect(result.runtime.log).toContain('[git] switched to feature/session-cockpit');
  });

  it('fetches remotes and records the git action in the runtime log', () => {
    const fetchGit = vi.fn();
    const manager = new ProjectRuntimeManager(
      sampleConfigs(),
      vi.fn() as never,
      noNodePin,
      vi.fn(() => 'main'),
      vi.fn(() => false),
      vi.fn(() => [{ name: 'main', behind: 0 }, { name: 'feature/session-cockpit', behind: 1 }]),
      vi.fn(),
      fetchGit
    );

    const result = manager.fetchBranches('sample');

    expect(fetchGit).toHaveBeenCalledWith(join(homedir(), 'Documents/sample-app'));
    expect(result.branches.map((branch) => branch.name)).toEqual(['main', 'feature/session-cockpit']);
    expect(result.runtime?.log).toContain('[git] fetched remotes');
  });

  it('merges a known branch into the current clean branch and records the action', () => {
    const mergeGit = vi.fn();
    const manager = new ProjectRuntimeManager(
      sampleConfigs(),
      vi.fn() as never,
      noNodePin,
      vi.fn(() => 'main'),
      vi.fn(() => false),
      vi.fn(() => [{ name: 'main' }, { name: 'feature/session-cockpit' }]),
      vi.fn(),
      vi.fn(),
      mergeGit
    );

    const result = manager.mergeBranch('sample', 'feature/session-cockpit');

    expect(mergeGit).toHaveBeenCalledWith(join(homedir(), 'Documents/sample-app'), 'feature/session-cockpit');
    expect(result.runtime?.log).toContain('[git] merged feature/session-cockpit into main');
  });

  it('refuses to merge while the worktree is dirty', () => {
    const mergeGit = vi.fn();
    const manager = new ProjectRuntimeManager(
      sampleConfigs(),
      vi.fn() as never,
      noNodePin,
      vi.fn(() => 'main'),
      vi.fn(() => true),
      vi.fn(() => [{ name: 'main' }, { name: 'feature/session-cockpit' }]),
      vi.fn(),
      vi.fn(),
      mergeGit
    );

    const result = manager.mergeBranch('sample', 'feature/session-cockpit');

    expect(mergeGit).not.toHaveBeenCalled();
    expect(result.error).toMatch(/commit or stash/i);
  });

  it('prepends the resolved Node bin to PATH and records the version in the log', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const resolveNodeBin = vi.fn(() => ({ version: '22.18.0', binPath: '/fake/nvm/v22.18.0/bin' }));
    const manager = new ProjectRuntimeManager(sampleConfigs(), spawnProcess, resolveNodeBin);

    const snapshot = await manager.start('sample');

    expect(resolveNodeBin).toHaveBeenCalledWith(join(homedir(), 'Documents/sample-app'), undefined);
    expect(spawnProcess).toHaveBeenCalledWith(
      'pnpm',
      ['run', 'dev'],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: expect.stringMatching(/^\/fake\/nvm\/v22\.18\.0\/bin:/)
        })
      })
    );
    expect(snapshot.log).toContain('[runtime] Node v22.18.0 (/fake/nvm/v22.18.0/bin)');
  });

  it('stops a running project process and records that stop was requested', async () => {
    const child = new FakeChild();
    const manager = new ProjectRuntimeManager(sampleConfigs(), vi.fn(() => child as never), noNodePin);

    await manager.start('sample');
    const snapshot = await manager.stop('sample');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(snapshot.status).toBe('stopped');
    expect(snapshot.log).toContain('[process] stop requested');
  });
});
