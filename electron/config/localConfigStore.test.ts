// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalConfigStore } from './localConfigStore.js';

function configPath() {
  return join(mkdtempSync(join(tmpdir(), 'launch-bay-config-')), 'config.json');
}

describe('LocalConfigStore', () => {
  it('creates an empty local-first config on first load', () => {
    const store = new LocalConfigStore(configPath());

    const config = store.load();

    expect(config.version).toBe(1);
    expect(config.localUser.id).toMatch(/^local-/);
    expect(config.localUser.onboardingCompleted).toBe(false);
    expect(config.workspaces).toEqual([]);
    expect(config.servers).toEqual([]);
  });

  it('persists workspace and server create/edit operations', () => {
    const path = configPath();
    const store = new LocalConfigStore(path);

    const withWorkspace = store.saveWorkspace({ name: 'Sample', cwd: '/repos/sample-api' });
    const workspace = withWorkspace.workspaces[0];
    const withServer = store.saveServer({
      workspaceId: workspace.id,
      name: 'API',
      cwd: '/repos/sample-api',
      command: 'pnpm dev',
      url: 'http://localhost:3333',
      nodeVersion: 'v18.20.8'
    });
    const server = withServer.servers[0];
    store.saveServer({ ...server, name: 'Sample API', command: 'pnpm dev:api' });

    const reloaded = new LocalConfigStore(path).load();
    expect(reloaded.workspaces).toHaveLength(1);
    expect(reloaded.servers).toHaveLength(1);
    expect(reloaded.workspaces[0]).toMatchObject({
      id: workspace.id,
      name: 'Sample',
      cwd: '/repos/sample-api'
    });
    expect(reloaded.servers[0]).toMatchObject({
      id: server.id,
      workspaceId: workspace.id,
      name: 'Sample API',
      cwd: '/repos/sample-api',
      command: 'pnpm dev:api',
      url: 'http://localhost:3333',
      nodeVersion: '18.20.8'
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).servers[0].name).toBe('Sample API');
  });

  it('drops legacy partial Node version pins so .nvmrc or PATH can take over', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      localUser: {
        id: 'local-test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        onboardingCompleted: false
      },
      workspaces: [{
        id: 'workspace-sample',
        name: 'Sample',
        cwd: '/repos/sample-api',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }],
      servers: [{
        id: 'server-sample',
        workspaceId: 'workspace-sample',
        name: 'Sample server',
        cwd: '/repos/sample-api',
        command: 'pnpm dev',
        nodeVersion: '22.18',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    }), 'utf8');

    const config = new LocalConfigStore(path).load();

    expect(config.servers[0].nodeVersion).toBeUndefined();
  });

  it('backfills legacy workspace cwd from its server cwd when the saved workspace is empty', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      localUser: {
        id: 'local-test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        onboardingCompleted: false
      },
      workspaces: [{
        id: 'workspace-sample',
        name: 'Sample',
        cwd: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }],
      servers: [{
        id: 'server-sample',
        workspaceId: 'workspace-sample',
        name: 'Sample server',
        cwd: '/repos/sample-api',
        command: 'pnpm dev',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    }), 'utf8');

    const config = new LocalConfigStore(path).load();

    expect(config.workspaces[0].cwd).toBe('/repos/sample-api');
  });

  it('rejects invalid server drafts before writing', () => {
    const store = new LocalConfigStore(configPath());
    expect(() => store.saveWorkspace({ name: 'Sample', cwd: '' })).toThrow(/project folder/i);
    const workspace = store.saveWorkspace({ name: 'Sample', cwd: '/repos/sample-api' }).workspaces[0];

    expect(() => store.saveServer({ workspaceId: workspace.id, name: '', cwd: '/tmp' })).toThrow(/server name/i);
    expect(() => store.saveServer({ workspaceId: workspace.id, name: 'API', cwd: '' })).toThrow(/working directory/i);
    expect(() => store.saveServer({ workspaceId: 'missing', name: 'API', cwd: '/tmp' })).toThrow(/existing workspace/i);
  });

  it('does not overwrite invalid JSON silently', () => {
    const path = configPath();
    writeFileSync(path, '{ nope', 'utf8');

    const config = new LocalConfigStore(path).load();

    expect(config.error).toMatch(/config/i);
    expect(readFileSync(path, 'utf8')).toBe('{ nope');
  });
});
