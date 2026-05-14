import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  nodeVersion?: string;
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

function normalizeNodeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^v/, '');
  if (!normalized) return undefined;
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : undefined;
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string, label?: string) {
  const slug = (label ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${slug || randomUUID().slice(0, 8)}-${randomUUID().slice(0, 8)}`;
}

export function createEmptyLaunchBayConfig(): LaunchBayConfig {
  const timestamp = nowIso();
  return {
    version: 1,
    localUser: {
      id: `local-${randomUUID()}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      onboardingCompleted: false
    },
    workspaces: [],
    servers: []
  };
}

function ensureConfigShape(value: unknown): LaunchBayConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid Launch Bay config file.');
  const config = value as LaunchBayConfig;
  if (config.version !== 1 || !config.localUser || !Array.isArray(config.workspaces) || !Array.isArray(config.servers)) {
    throw new Error('Invalid Launch Bay config file.');
  }
  return {
    version: 1,
    localUser: config.localUser,
    workspaces: config.workspaces.map((workspace) => {
      const savedCwd = typeof workspace.cwd === 'string' ? workspace.cwd.trim() : '';
      const serverCwd = config.servers.find((server) => server.workspaceId === workspace.id)?.cwd?.trim() ?? '';
      return {
        ...workspace,
        cwd: savedCwd || serverCwd
      };
    }),
    servers: config.servers.map((server) => ({
      ...server,
      nodeVersion: normalizeNodeVersion(server.nodeVersion)
    }))
  };
}

export class LocalConfigStore {
  constructor(private readonly configPath: string) {}

  load(): LaunchBayConfig {
    if (!existsSync(this.configPath)) {
      const config = createEmptyLaunchBayConfig();
      this.write(config);
      return config;
    }

    try {
      return ensureConfigShape(JSON.parse(readFileSync(this.configPath, 'utf8')));
    } catch (error) {
      const empty = createEmptyLaunchBayConfig();
      const details = error instanceof Error ? error.message : 'Unknown parse error';
      return {
        ...empty,
        error: `Could not read Launch Bay config: ${details}`
      };
    }
  }

  saveWorkspace(draft: WorkspaceDraft): LaunchBayConfig {
    const name = draft.name?.trim();
    const cwd = draft.cwd?.trim();
    if (!name) throw new Error('Workspace name is required.');
    if (!cwd) throw new Error('Project folder is required.');

    const config = this.loadWithoutTransientError();
    const timestamp = nowIso();
    const id = draft.id ?? createId('workspace', name);
    const existing = config.workspaces.find((workspace) => workspace.id === id);
    const workspace: WorkspaceConfig = {
      id,
      name,
      cwd,
      description: draft.description?.trim() || undefined,
      createdAt: existing?.createdAt ?? draft.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    const workspaces = existing
      ? config.workspaces.map((item) => (item.id === id ? workspace : item))
      : [...config.workspaces, workspace];

    return this.write({ ...config, workspaces });
  }

  deleteWorkspace(workspaceId: string): LaunchBayConfig {
    const config = this.loadWithoutTransientError();
    if (config.servers.some((server) => server.workspaceId === workspaceId)) {
      throw new Error('Delete or move this workspace servers before deleting the workspace.');
    }
    return this.write({ ...config, workspaces: config.workspaces.filter((workspace) => workspace.id !== workspaceId) });
  }

  saveServer(draft: ServerDraft): LaunchBayConfig {
    const workspaceId = draft.workspaceId?.trim();
    const name = draft.name?.trim();
    const cwd = draft.cwd?.trim();
    if (!workspaceId) throw new Error('Workspace is required.');
    if (!name) throw new Error('Server name is required.');
    if (!cwd) throw new Error('Working directory is required.');

    const config = this.loadWithoutTransientError();
    if (!config.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new Error('Choose an existing workspace before saving the server.');
    }

    const timestamp = nowIso();
    const id = draft.id ?? createId('server', name);
    const existing = config.servers.find((server) => server.id === id);
    const server: ServerConfig = {
      id,
      workspaceId,
      name,
      cwd,
      command: draft.command?.trim() ?? '',
      nodeVersion: normalizeNodeVersion(draft.nodeVersion),
      url: draft.url?.trim() || undefined,
      description: draft.description?.trim() || undefined,
      createdAt: existing?.createdAt ?? draft.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    const servers = existing
      ? config.servers.map((item) => (item.id === id ? server : item))
      : [...config.servers, server];

    return this.write({ ...config, servers });
  }

  deleteServer(serverId: string): LaunchBayConfig {
    const config = this.loadWithoutTransientError();
    return this.write({ ...config, servers: config.servers.filter((server) => server.id !== serverId) });
  }

  private loadWithoutTransientError() {
    const { error: _error, ...config } = this.load();
    return config;
  }

  private write(config: LaunchBayConfig): LaunchBayConfig {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const cleanConfig = { ...config };
    delete cleanConfig.error;
    const tempPath = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(cleanConfig, null, 2)}\n`, 'utf8');
    renameSync(tempPath, this.configPath);
    return cleanConfig;
  }
}

export function createLocalConfigStore(userDataPath: string) {
  return new LocalConfigStore(join(userDataPath, 'config.json'));
}
