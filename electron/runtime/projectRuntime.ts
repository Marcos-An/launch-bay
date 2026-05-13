import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from '../paths.js';
import { loginShellInvocation } from '../platform.js';

export { expandHome };

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

export type NodeBinInfo = {
  version: string;
  binPath: string;
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

type RuntimeListener = (event: RuntimeUpdate) => void;

type SpawnProcess = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcess;
type NodeBinResolver = (cwd: string) => NodeBinInfo | undefined;
type BranchResolver = (cwd: string) => string | undefined;
type DirtyResolver = (cwd: string) => boolean | undefined;
type BranchListResolver = (cwd: string) => GitBranchInfo[] | undefined;
type BranchSwitcher = (cwd: string, branch: string) => void;
type BranchFetcher = (cwd: string) => void;
type BranchMerger = (cwd: string, branch: string) => void;

export type ProjectRuntimeConfig = {
  id: string;
  cwd: string;
  displayCommand: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type RuntimeServerConfig = {
  id: string;
  cwd: string;
  command: string;
};

// Launch Bay is local-first: there are no built-in projects. Workspaces
// and servers are added by the user through the UI and persisted in
// userData/launch-bay.json. Tests may construct configs ad-hoc via
// createProjectRuntimeConfig.
export const PROJECT_RUNTIME_CONFIGS: ProjectRuntimeConfig[] = [];

export function resolveNvmNodeBin(cwd: string): NodeBinInfo | undefined {
  const nvmrcPath = join(cwd, '.nvmrc');
  if (!existsSync(nvmrcPath)) return undefined;
  const version = readFileSync(nvmrcPath, 'utf8').trim().replace(/^v/, '');
  if (!version) return undefined;
  const binPath = join(homedir(), '.nvm', 'versions', 'node', `v${version}`, 'bin');
  if (!existsSync(binPath)) return undefined;
  return { version, binPath };
}

export function resolveGitBranch(cwd: string): string | undefined {
  if (!existsSync(cwd)) return undefined;

  try {
    const branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (branch && branch !== 'HEAD') return branch;

    const sha = execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return sha ? `detached:${sha}` : undefined;
  } catch {
    return undefined;
  }
}

export function resolveGitDirty(cwd: string): boolean | undefined {
  if (!existsSync(cwd)) return undefined;

  try {
    const output = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output.trim().length > 0;
  } catch {
    return undefined;
  }
}

function parseTrackingValue(value: string) {
  const aheadMatch = value.match(/ahead (\d+)/);
  const behindMatch = value.match(/behind (\d+)/);
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0
  };
}

export function resolveGitBranches(cwd: string): GitBranchInfo[] | undefined {
  if (!existsSync(cwd)) return undefined;

  try {
    const output = execFileSync('git', [
      '-C',
      cwd,
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(contents:subject)',
      'refs/heads'
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, upstream, track, lastCommit] = line.split('\t');
        const tracking = parseTrackingValue(track ?? '');
        return {
          name,
          upstream: upstream || undefined,
          ahead: tracking.ahead,
          behind: tracking.behind,
          lastCommit: lastCommit || undefined
        } satisfies GitBranchInfo;
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return undefined;
  }
}

export function checkoutGitBranch(cwd: string, branch: string) {
  execFileSync('git', ['-C', cwd, 'checkout', branch], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function fetchGitBranches(cwd: string) {
  execFileSync('git', ['-C', cwd, 'fetch', '--prune'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function mergeGitBranch(cwd: string, branch: string) {
  execFileSync('git', ['-C', cwd, 'merge', '--no-edit', branch], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function createProjectRuntimeConfig(config: RuntimeServerConfig): ProjectRuntimeConfig {
  // Run the user-provided command string through the OS's login shell so it
  // can use aliases, env, and PATH the same way a regular terminal would.
  const shell = loginShellInvocation();
  return {
    id: config.id,
    cwd: config.cwd,
    displayCommand: config.command,
    command: shell.command,
    args: [...shell.args, config.command]
  };
}

export class ProjectRuntimeManager {
  private readonly configs = new Map<string, ProjectRuntimeConfig>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly listeners = new Set<RuntimeListener>();
  private readonly snapshots = new Map<string, RuntimeSnapshot>();

  constructor(
    configs: ProjectRuntimeConfig[],
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly resolveNodeBin: NodeBinResolver = resolveNvmNodeBin,
    private readonly resolveBranch: BranchResolver = resolveGitBranch,
    private readonly resolveDirty: DirtyResolver = resolveGitDirty,
    private readonly resolveBranches: BranchListResolver = resolveGitBranches,
    private readonly checkoutBranch: BranchSwitcher = checkoutGitBranch,
    private readonly fetchGit: BranchFetcher = fetchGitBranches,
    private readonly mergeGit: BranchMerger = mergeGitBranch
  ) {
    this.setConfigs(configs);
  }

  setConfigs(configs: ProjectRuntimeConfig[]) {
    const nextIds = new Set(configs.map((config) => config.id));
    for (const projectId of this.configs.keys()) {
      if (nextIds.has(projectId)) continue;
      void this.stop(projectId);
      this.configs.delete(projectId);
      this.snapshots.delete(projectId);
    }

    for (const config of configs) {
      this.configs.set(config.id, config);
      const current = this.snapshots.get(config.id) ?? { status: 'stopped' as const, log: '' };
      this.snapshots.set(config.id, {
        ...current,
        branch: this.getBranch(config),
        dirty: this.getDirty(config)
      });
    }
  }

  onUpdate(listener: RuntimeListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(projectId: string): RuntimeSnapshot {
    this.refreshBranch(projectId);
    return this.copySnapshot(projectId);
  }

  async start(projectId: string): Promise<RuntimeSnapshot> {
    const config = this.configs.get(projectId);
    if (!config) {
      return this.setSnapshot(projectId, {
        status: 'stopped',
        log: '[runtime] No start command configured for this server yet.\n',
        error: 'Server runtime is not configured.'
      });
    }

    if (!config.displayCommand.trim()) {
      return this.setSnapshot(projectId, {
        status: 'stopped',
        log: '[runtime] Add a start command before running this server.\n',
        branch: this.getBranch(config),
        dirty: this.getDirty(config),
        error: 'Server command is empty.'
      });
    }

    if (this.children.has(projectId)) return this.copySnapshot(projectId);

    const expandedCwd = expandHome(config.cwd);
    const nodeBin = this.resolveNodeBin(expandedCwd);
    const baseEnv: Record<string, string | undefined> = { ...process.env, ...config.env };
    const env = nodeBin
      ? { ...baseEnv, PATH: `${nodeBin.binPath}:${baseEnv.PATH ?? ''}` }
      : baseEnv;

    const baseLog = nodeBin
      ? `$ ${config.displayCommand}\n[runtime] Node v${nodeBin.version} (${nodeBin.binPath})\n`
      : `$ ${config.displayCommand}\n`;
    this.setSnapshot(projectId, {
      status: 'running',
      log: baseLog,
      branch: this.getBranch(config),
      dirty: this.getDirty(config)
    });

    try {
      const child = this.spawnProcess(config.command, config.args, {
        cwd: expandedCwd,
        env,
        shell: false
      });

      this.children.set(projectId, child);
      this.patchSnapshot(projectId, { pid: child.pid });

      child.stdout?.on('data', (data) => this.appendLog(projectId, data.toString()));
      child.stderr?.on('data', (data) => this.appendLog(projectId, data.toString()));
      child.on('error', (error) => {
        this.children.delete(projectId);
        this.appendLog(projectId, `\n[process] ${error.message}\n`);
        this.patchSnapshot(projectId, { status: 'stopped', error: error.message });
      });
      child.on('exit', (code, signal) => {
        this.children.delete(projectId);
        const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
        this.appendLog(projectId, `\n[process] exited with ${reason}\n`);
        this.patchSnapshot(projectId, { status: 'stopped', pid: undefined });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patchSnapshot(projectId, {
        status: 'stopped',
        log: `${baseLog}\n[process] ${message}\n`,
        error: message
      });
    }

    return this.copySnapshot(projectId);
  }

  async stop(projectId: string): Promise<RuntimeSnapshot> {
    const child = this.children.get(projectId);
    if (child) {
      child.kill('SIGTERM');
      this.children.delete(projectId);
    }

    const current = this.copySnapshot(projectId);
    return this.setSnapshot(projectId, {
      ...current,
      status: 'stopped',
      pid: undefined,
      log: `${current.log}${current.log.endsWith('\n') || current.log.length === 0 ? '' : '\n'}[process] stop requested\n`
    });
  }

  listBranches(projectId: string): ProjectBranchState {
    const config = this.configs.get(projectId);
    if (!config) {
      return { cwd: '', branches: [], error: 'Project runtime is not configured.' };
    }

    const cwd = expandHome(config.cwd);
    const current = this.resolveBranch(cwd);
    const dirty = this.resolveDirty(cwd);
    const branches = this.resolveBranches(cwd) ?? [];
    const branchByName = new Map(branches.map((branch) => [branch.name, branch]));
    if (current && !current.startsWith('detached:') && !branchByName.has(current)) {
      branchByName.set(current, { name: current });
    }
    const sortedBranches = Array.from(branchByName.values())
      .map((branch) => ({ ...branch, current: branch.name === current }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const orderedBranches = current && sortedBranches.some((branch) => branch.name === current)
      ? [
          ...sortedBranches.filter((branch) => branch.name === current),
          ...sortedBranches.filter((branch) => branch.name !== current)
        ]
      : sortedBranches;

    return {
      cwd,
      current,
      dirty,
      branches: orderedBranches
    };
  }

  switchBranch(projectId: string, branch: string): ProjectBranchState {
    const config = this.configs.get(projectId);
    if (!config) {
      return { cwd: '', branches: [], error: 'Project runtime is not configured.' };
    }

    const state = this.listBranches(projectId);
    const trimmedBranch = branch.trim();
    const knownBranchNames = state.branches.map((knownBranch) => knownBranch.name);
    if (!trimmedBranch || !knownBranchNames.includes(trimmedBranch)) {
      return { ...state, error: 'Choose a known local branch before switching.', runtime: this.copySnapshot(projectId) };
    }

    if (this.children.has(projectId)) {
      return { ...state, error: 'Stop the server before switching branches.', runtime: this.copySnapshot(projectId) };
    }

    if (state.dirty) {
      const runtime = this.patchSnapshot(projectId, {
        branch: state.current,
        dirty: state.dirty,
        error: 'Commit or stash before switching branches.'
      });
      return { ...state, error: 'Commit or stash before switching branches.', runtime };
    }

    try {
      this.checkoutBranch(state.cwd, trimmedBranch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const runtime = this.patchSnapshot(projectId, { error: message });
      return { ...state, error: message, runtime };
    }

    const nextState = this.listBranches(projectId);
    const current = this.copySnapshot(projectId);
    const logPrefix = current.log.endsWith('\n') || current.log.length === 0 ? '' : '\n';
    const runtime = this.setSnapshot(projectId, {
      ...current,
      branch: nextState.current,
      dirty: nextState.dirty,
      error: undefined,
      log: `${current.log}${logPrefix}[git] switched to ${trimmedBranch}\n`
    });

    return { ...nextState, runtime };
  }

  fetchBranches(projectId: string): ProjectBranchState {
    const config = this.configs.get(projectId);
    if (!config) {
      return { cwd: '', branches: [], error: 'Project runtime is not configured.' };
    }

    const cwd = expandHome(config.cwd);
    try {
      this.fetchGit(cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const runtime = this.patchSnapshot(projectId, { error: message });
      return { ...this.listBranches(projectId), error: message, runtime };
    }

    const nextState = this.listBranches(projectId);
    const runtime = this.appendGitLog(projectId, '[git] fetched remotes');
    return { ...nextState, runtime };
  }

  mergeBranch(projectId: string, branch: string): ProjectBranchState {
    const config = this.configs.get(projectId);
    if (!config) {
      return { cwd: '', branches: [], error: 'Project runtime is not configured.' };
    }

    const state = this.listBranches(projectId);
    const trimmedBranch = branch.trim();
    const knownBranchNames = state.branches.map((knownBranch) => knownBranch.name);
    if (!trimmedBranch || !knownBranchNames.includes(trimmedBranch)) {
      return { ...state, error: 'Choose a known local branch before merging.', runtime: this.copySnapshot(projectId) };
    }

    if (trimmedBranch === state.current) {
      return { ...state, error: 'Choose another branch to merge into the current branch.', runtime: this.copySnapshot(projectId) };
    }

    if (this.children.has(projectId)) {
      return { ...state, error: 'Stop the server before merging branches.', runtime: this.copySnapshot(projectId) };
    }

    if (state.dirty) {
      const runtime = this.patchSnapshot(projectId, {
        branch: state.current,
        dirty: state.dirty,
        error: 'Commit or stash before merging branches.'
      });
      return { ...state, error: 'Commit or stash before merging branches.', runtime };
    }

    try {
      this.mergeGit(state.cwd, trimmedBranch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const runtime = this.patchSnapshot(projectId, { error: message });
      return { ...state, error: message, runtime };
    }

    const nextState = this.listBranches(projectId);
    const runtime = this.appendGitLog(projectId, `[git] merged ${trimmedBranch} into ${state.current ?? 'current branch'}`);
    return { ...nextState, runtime };
  }

  stopAll() {
    for (const projectId of this.children.keys()) {
      void this.stop(projectId);
    }
  }

  private refreshBranch(projectId: string) {
    const config = this.configs.get(projectId);
    if (!config) return;
    const current = this.snapshots.get(projectId) ?? { status: 'stopped' as const, log: '' };
    this.snapshots.set(projectId, {
      ...current,
      branch: this.getBranch(config),
      dirty: this.getDirty(config)
    });
  }

  private getBranch(config: ProjectRuntimeConfig) {
    return this.resolveBranch(expandHome(config.cwd));
  }

  private getDirty(config: ProjectRuntimeConfig) {
    return this.resolveDirty(expandHome(config.cwd));
  }

  private appendLog(projectId: string, chunk: string) {
    const current = this.copySnapshot(projectId);
    this.setSnapshot(projectId, { ...current, log: `${current.log}${chunk}` });
  }

  private appendGitLog(projectId: string, message: string) {
    const current = this.copySnapshot(projectId);
    const logPrefix = current.log.endsWith('\n') || current.log.length === 0 ? '' : '\n';
    return this.setSnapshot(projectId, {
      ...current,
      branch: this.configs.get(projectId) ? this.getBranch(this.configs.get(projectId)!) : current.branch,
      dirty: this.configs.get(projectId) ? this.getDirty(this.configs.get(projectId)!) : current.dirty,
      error: undefined,
      log: `${current.log}${logPrefix}${message}\n`
    });
  }

  private patchSnapshot(projectId: string, patch: Partial<RuntimeSnapshot>) {
    return this.setSnapshot(projectId, { ...this.copySnapshot(projectId), ...patch });
  }

  private setSnapshot(projectId: string, snapshot: RuntimeSnapshot) {
    this.snapshots.set(projectId, snapshot);
    const copied = this.copySnapshot(projectId);
    this.emit({ projectId, snapshot: copied });
    return copied;
  }

  private copySnapshot(projectId: string): RuntimeSnapshot {
    const snapshot = this.snapshots.get(projectId) ?? { status: 'stopped', log: '' };
    return { ...snapshot };
  }

  private emit(event: RuntimeUpdate) {
    for (const listener of this.listeners) listener(event);
  }
}
