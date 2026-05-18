import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { expandHome } from '../paths.js';
import { loginShellInvocation } from '../platform.js';
import { getGitFileDiff, getGitSnapshot, type FileDiff, type FileDiffKind, type GitSnapshot } from './gitWorkbench.js';
import { buildUserTerminalEnv } from './runtimeEnv.js';

export { expandHome };

export type RuntimeStatus = 'running' | 'stopped';

export type RuntimeTerminalSnapshot = {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
};

export type RuntimeSnapshot = {
  status: RuntimeStatus;
  log: string;
  branch?: string;
  dirty?: boolean;
  pid?: number;
  error?: string;
  terminal?: RuntimeTerminalSnapshot;
  terminalCommand?: string;
};

export type RuntimeUpdate = {
  projectId: string;
  snapshot: RuntimeSnapshot;
};

export type NodeBinInfo = {
  version: string;
  binPath?: string;
  error?: string;
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

export type GitMergePreviewCommit = {
  sha: string;
  subject: string;
};

export type GitMergePreviewFile = {
  path: string;
  status: string;
};

export type GitMergePreview = {
  cwd: string;
  sourceBranch: string;
  targetBranch?: string;
  canMerge: boolean;
  blockers: string[];
  commits: GitMergePreviewCommit[];
  files: GitMergePreviewFile[];
  error?: string;
};

type RuntimeListener = (event: RuntimeUpdate) => void;

type SpawnProcess = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcess;
type NodeBinResolver = (cwd: string, preferredVersion?: string) => NodeBinInfo | undefined;
type BranchResolver = (cwd: string) => string | undefined;
type DirtyResolver = (cwd: string) => boolean | undefined;
type BranchListResolver = (cwd: string) => GitBranchInfo[] | undefined;
type BranchSwitcher = (cwd: string, branch: string) => void;
type BranchFetcher = (cwd: string) => void;
type BranchMerger = (cwd: string, branch: string) => void;

type RuntimeTerminalLaunchPlan = {
  snapshot: RuntimeSnapshot;
  cwd?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  nodeBin?: NodeBinInfo;
};

export type ProjectRuntimeConfig = {
  id: string;
  cwd: string;
  displayCommand: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  nodeVersion?: string;
};

export type RuntimeServerConfig = {
  id: string;
  cwd: string;
  command: string;
  nodeVersion?: string;
};

export type ProjectFileEntry = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
  hidden?: boolean;
  sensitive?: boolean;
};

export type ProjectTreeOptions = {
  includeHidden?: boolean;
  query?: string;
  limit?: number;
};

export type ProjectTreeResult = {
  cwd: string;
  entries: ProjectFileEntry[];
  error?: string;
};

export type ProjectFileReadResult = {
  text?: string;
  sizeBytes?: number;
  sensitive?: boolean;
  binary?: boolean;
  error?: string;
};

export type ProjectFileWriteResult = {
  ok: boolean;
  sizeBytes?: number;
  sensitive?: boolean;
  error?: string;
};

const PROJECT_TREE_EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);
const PROJECT_TREE_DEFAULT_LIMIT = 5000;
const PROJECT_TEXT_FILE_LIMIT_BYTES = 1024 * 1024;

function toPosixRelativePath(value: string) {
  return value.split(/[\\/]+/).filter(Boolean).join('/');
}

function hasTraversalSegment(value: string) {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

function isHiddenProjectPath(value: string) {
  return value.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

function isSensitiveProjectPath(value: string) {
  const lower = value.toLowerCase();
  const fileName = basename(lower);
  return fileName === '.env'
    || fileName.startsWith('.env.')
    || lower.endsWith('.pem')
    || lower.endsWith('.key')
    || lower.endsWith('.p12')
    || lower.endsWith('.pfx');
}

function isProbablyBinary(buffer: Buffer) {
  return buffer.includes(0);
}

function resolveProjectFilePath(cwd: string, relativePath: string) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return { error: 'unsafe path' };
  if (isAbsolute(relativePath) || hasTraversalSegment(relativePath)) return { error: 'unsafe path' };
  const root = resolve(cwd);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { error: 'unsafe path' };
  return { root, target, relativePath: toPosixRelativePath(rel) };
}

// Launch Bay is local-first: there are no built-in projects. Workspaces
// and servers are added by the user through the UI and persisted in
// userData/launch-bay.json. Tests may construct configs ad-hoc via
// createProjectRuntimeConfig.
export const PROJECT_RUNTIME_CONFIGS: ProjectRuntimeConfig[] = [];

function compareNodeVersionsDesc(left: string, right: string) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return right.localeCompare(left);
}

function normalizeNodeVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^v/, '');
  if (!normalized) return undefined;
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : undefined;
}

export function listInstalledNvmNodeVersions(versionsDir = join(homedir(), '.nvm', 'versions', 'node')): string[] {
  if (!existsSync(versionsDir)) return [];
  try {
    return readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.replace(/^v/, ''))
      .filter((version) => /^\d+\.\d+\.\d+$/.test(version) && existsSync(join(versionsDir, `v${version}`, 'bin')))
      .sort(compareNodeVersionsDesc);
  } catch {
    return [];
  }
}

export function resolveNvmNodeBin(cwd: string, preferredVersion?: string): NodeBinInfo | undefined {
  const explicitVersion = normalizeNodeVersion(preferredVersion);
  const nvmrcPath = join(cwd, '.nvmrc');
  if (!explicitVersion && !existsSync(nvmrcPath)) return undefined;
  const version = explicitVersion ?? readFileSync(nvmrcPath, 'utf8').trim().replace(/^v/, '');
  if (!version) return undefined;
  if (!/^\d+(?:\.\d+){0,2}$/.test(version)) {
    return { version, error: `Node version "${version}" is invalid. Use a version like 18.20.8.` };
  }
  const binPath = join(homedir(), '.nvm', 'versions', 'node', `v${version}`, 'bin');
  if (!existsSync(binPath)) {
    return explicitVersion ? { version, error: `Node v${version} is not installed.` } : undefined;
  }
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

function gitOutput(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function parseMergePreviewFiles(output: string): GitMergePreviewFile[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      return { status, path: paths[paths.length - 1] ?? '' };
    })
    .filter((file) => file.path.length > 0);
}

function parseMergePreviewCommits(output: string): GitMergePreviewCommit[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, subject = ''] = line.split('\t');
      return { sha, subject };
    });
}

export function resolveGitMergePreview(cwd: string, sourceBranch: string): GitMergePreview {
  const source = sourceBranch.trim();
  const targetBranch = resolveGitBranch(cwd);
  const blockers: string[] = [];
  if (!source) blockers.push('Choose a source branch before merging.');
  if (!targetBranch) blockers.push('Current branch could not be resolved.');
  if (source && targetBranch && source === targetBranch) blockers.push('Choose another branch to merge into the current branch.');
  if (resolveGitDirty(cwd)) blockers.push('Commit or stash before merging branches.');

  if (!source || !targetBranch) {
    return { cwd, sourceBranch: source, targetBranch, canMerge: false, blockers, commits: [], files: [] };
  }

  try {
    gitOutput(cwd, ['rev-parse', '--verify', source]);
    const commits = parseMergePreviewCommits(gitOutput(cwd, ['log', '--format=%h%x09%s', `${targetBranch}..${source}`]));
    const files = parseMergePreviewFiles(gitOutput(cwd, ['diff', '--name-status', `${targetBranch}...${source}`]));
    return {
      cwd,
      sourceBranch: source,
      targetBranch,
      canMerge: blockers.length === 0,
      blockers,
      commits,
      files
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      cwd,
      sourceBranch: source,
      targetBranch,
      canMerge: false,
      blockers: [...blockers, message],
      commits: [],
      files: [],
      error: message
    };
  }
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
    args: [...shell.args, config.command],
    nodeVersion: normalizeNodeVersion(config.nodeVersion)
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

  prepareTerminalLaunch(projectId: string): RuntimeTerminalLaunchPlan {
    const config = this.configs.get(projectId);
    if (!config) {
      return {
        snapshot: this.setSnapshot(projectId, {
          status: 'stopped',
          log: '',
          error: 'Server runtime is not configured.'
        })
      };
    }

    if (!config.displayCommand.trim()) {
      return {
        snapshot: this.setSnapshot(projectId, {
          status: 'stopped',
          log: '',
          branch: this.getBranch(config),
          dirty: this.getDirty(config),
          error: 'Server command is empty.'
        })
      };
    }

    const expandedCwd = expandHome(config.cwd);
    const nodeBin = this.resolveNodeBin(expandedCwd, config.nodeVersion);
    if (nodeBin?.error) {
      return {
        snapshot: this.setSnapshot(projectId, {
          status: 'stopped',
          log: '',
          branch: this.getBranch(config),
          dirty: this.getDirty(config),
          error: nodeBin.error
        }),
        nodeBin
      };
    }

    const env = buildUserTerminalEnv(config.env, { prependPath: nodeBin?.binPath });

    return {
      snapshot: this.setSnapshot(projectId, {
        status: 'running',
        log: '',
        branch: this.getBranch(config),
        dirty: this.getDirty(config),
        error: undefined,
        terminalCommand: config.displayCommand
      }),
      cwd: expandedCwd,
      command: config.displayCommand,
      env,
      nodeBin
    };
  }

  attachTerminal(projectId: string, terminal: RuntimeTerminalSnapshot, command: string): RuntimeSnapshot {
    const current = this.copySnapshot(projectId);
    return this.setSnapshot(projectId, {
      ...current,
      status: 'running',
      log: '',
      pid: undefined,
      error: undefined,
      terminal,
      terminalCommand: command
    });
  }

  markStopped(projectId: string): RuntimeSnapshot {
    const current = this.copySnapshot(projectId);
    return this.setSnapshot(projectId, {
      ...current,
      status: 'stopped',
      pid: undefined,
      log: ''
    });
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
    const nodeBin = this.resolveNodeBin(expandedCwd, config.nodeVersion);
    if (nodeBin?.error) {
      return this.setSnapshot(projectId, {
        status: 'stopped',
        log: `$ ${config.displayCommand}\n[runtime] ${nodeBin.error}\n`,
        branch: this.getBranch(config),
        dirty: this.getDirty(config),
        error: nodeBin.error
      });
    }
    const env = buildUserTerminalEnv(config.env, { prependPath: nodeBin?.binPath });

    const baseLog = nodeBin?.binPath
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

  listProjectTree(projectId: string, options: ProjectTreeOptions = {}): ProjectTreeResult {
    const config = this.configs.get(projectId);
    if (!config) return { cwd: '', entries: [], error: 'Project runtime is not configured.' };
    const cwd = expandHome(config.cwd);
    const root = resolve(cwd);
    const entries: ProjectFileEntry[] = [];
    const limit = Math.max(1, Math.min(options.limit ?? PROJECT_TREE_DEFAULT_LIMIT, PROJECT_TREE_DEFAULT_LIMIT));
    const query = options.query?.trim().toLowerCase();

    const walk = (absoluteDir: string, relativeDir = '') => {
      if (entries.length >= limit) return;
      let dirEntries: Dirent<string>[];
      try {
        dirEntries = readdirSync(absoluteDir, { withFileTypes: true });
      } catch {
        return;
      }

      const sortedEntries = dirEntries.sort((left, right) => {
        if (left.isDirectory() && !right.isDirectory()) return -1;
        if (!left.isDirectory() && right.isDirectory()) return 1;
        return left.name.localeCompare(right.name);
      });
      const directoriesToWalk: Array<{ absolutePath: string; relativePath: string }> = [];

      for (const entry of sortedEntries) {
        if (entries.length >= limit) return;
        if (PROJECT_TREE_EXCLUDED_NAMES.has(entry.name)) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;

        const relativePath = toPosixRelativePath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
        const hidden = isHiddenProjectPath(relativePath);
        if (hidden && !options.includeHidden) continue;

        const absolutePath = join(absoluteDir, entry.name);
        if (entry.isDirectory()) directoriesToWalk.push({ absolutePath, relativePath });

        if (query && !relativePath.toLowerCase().includes(query)) continue;

        try {
          const stats = statSync(absolutePath);
          entries.push({
            path: relativePath,
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            sizeBytes: entry.isFile() ? stats.size : undefined,
            modifiedAt: stats.mtime.toISOString(),
            hidden,
            sensitive: isSensitiveProjectPath(relativePath)
          });
        } catch {
          // Skip files that disappear or cannot be inspected while walking.
        }
      }

      for (const directory of directoriesToWalk) {
        if (entries.length >= limit) return;
        walk(directory.absolutePath, directory.relativePath);
      }
    };

    if (!existsSync(root)) return { cwd, entries: [], error: 'Project folder does not exist.' };
    walk(root);
    return { cwd, entries };
  }

  readProjectFile(projectId: string, relativePath: string): ProjectFileReadResult {
    const config = this.configs.get(projectId);
    if (!config) return { error: 'Project runtime is not configured.' };
    const resolved = resolveProjectFilePath(expandHome(config.cwd), relativePath);
    if (resolved.error || !resolved.target || !resolved.relativePath) return { error: resolved.error ?? 'unsafe path' };

    try {
      const stats = statSync(resolved.target);
      if (!stats.isFile()) return { error: 'not a file' };
      if (stats.size > PROJECT_TEXT_FILE_LIMIT_BYTES) return { error: 'file too large' };
      const raw = readFileSync(resolved.target);
      if (isProbablyBinary(raw)) return { error: 'binary file', binary: true };
      return {
        text: raw.toString('utf8'),
        sizeBytes: stats.size,
        sensitive: isSensitiveProjectPath(resolved.relativePath),
        binary: false
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  writeProjectFile(projectId: string, relativePath: string, text: string): ProjectFileWriteResult {
    const config = this.configs.get(projectId);
    if (!config) return { ok: false, error: 'Project runtime is not configured.' };
    const resolved = resolveProjectFilePath(expandHome(config.cwd), relativePath);
    if (resolved.error || !resolved.target || !resolved.relativePath) return { ok: false, error: resolved.error ?? 'unsafe path' };
    if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
    if (Buffer.byteLength(text, 'utf8') > PROJECT_TEXT_FILE_LIMIT_BYTES) return { ok: false, error: 'file too large' };

    try {
      if (existsSync(resolved.target)) {
        const stats = statSync(resolved.target);
        if (!stats.isFile()) return { ok: false, error: 'not a file' };
      }
      writeFileSync(resolved.target, text, 'utf8');
      return {
        ok: true,
        sizeBytes: Buffer.byteLength(text, 'utf8'),
        sensitive: isSensitiveProjectPath(resolved.relativePath)
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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

  getGitSnapshot(projectId: string): GitSnapshot {
    const config = this.configs.get(projectId);
    if (!config) {
      return {
        cwd: '',
        branch: null,
        headSha: null,
        isDirty: false,
        isMerging: false,
        isRebasing: false,
        isCherryPicking: false,
        files: [],
        conflicts: [],
        error: 'Project runtime is not configured.'
      };
    }
    return getGitSnapshot(expandHome(config.cwd));
  }

  getFileDiff(projectId: string, filePath: string, kind?: FileDiffKind): FileDiff {
    const config = this.configs.get(projectId);
    if (!config) {
      return { path: filePath, kind: kind ?? 'worktree', diff: '', error: 'Project runtime is not configured.' };
    }
    return getGitFileDiff(expandHome(config.cwd), filePath, kind);
  }

  getBranchMergePreview(projectId: string, branch: string): GitMergePreview {
    const config = this.configs.get(projectId);
    if (!config) {
      return {
        cwd: '',
        sourceBranch: branch,
        canMerge: false,
        blockers: ['Project runtime is not configured.'],
        commits: [],
        files: [],
        error: 'Project runtime is not configured.'
      };
    }
    const preview = resolveGitMergePreview(expandHome(config.cwd), branch);
    if (this.children.has(projectId)) {
      return {
        ...preview,
        canMerge: false,
        blockers: [...preview.blockers, 'Stop the server before merging branches.']
      };
    }
    return preview;
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
