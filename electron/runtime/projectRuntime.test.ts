// @vitest-environment node
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager, createProjectRuntimeConfig, type RuntimeUpdate } from './projectRuntime.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

const noNodePin = () => undefined;

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

    expect(resolveNodeBin).toHaveBeenCalledWith(join(homedir(), 'Documents/sample-app'));
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
