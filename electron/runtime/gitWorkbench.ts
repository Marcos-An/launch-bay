import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';

export type GitFileChange = {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  binary?: boolean;
  additions?: number;
  deletions?: number;
};

export type GitConflict = {
  path: string;
  status: string;
  stages: {
    base?: boolean;
    ours?: boolean;
    theirs?: boolean;
  };
};

export type GitSnapshot = {
  cwd: string;
  branch: string | null;
  headSha: string | null;
  upstream?: string;
  ahead?: number;
  behind?: number;
  isDirty: boolean;
  isMerging: boolean;
  isRebasing: boolean;
  isCherryPicking: boolean;
  files: GitFileChange[];
  conflicts: GitConflict[];
  error?: string;
};

export type FileDiffKind = 'worktree' | 'staged' | 'untracked';

export type FileDiff = {
  path: string;
  kind: FileDiffKind;
  diff: string;
  binary?: boolean;
  error?: string;
};

type GitExecResult = { ok: true; stdout: string } | { ok: false; stdout: string; error: string };

function git(cwd: string, args: string[]): GitExecResult {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 20,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    };
  } catch (error) {
    const maybe = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: maybe.stdout?.toString() ?? '',
      error: maybe.stderr?.toString().trim() || maybe.message || 'Git command failed'
    };
  }
}

function emptySnapshot(cwd: string, error?: string): GitSnapshot {
  return {
    cwd,
    branch: null,
    headSha: null,
    isDirty: false,
    isMerging: false,
    isRebasing: false,
    isCherryPicking: false,
    files: [],
    conflicts: [],
    error
  };
}

function parseAheadBehind(value: string) {
  const match = value.match(/\+(\d+)\s+-(\d+)/);
  if (!match) return {};
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

function xyToStatus(xy: string, recordType?: string): GitFileStatus {
  if (recordType === 'u' || xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflicted';
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

function isChanged(value: string | undefined) {
  return Boolean(value && value !== '.');
}

function parsePorcelainV2(output: string) {
  const snapshotMeta: Pick<GitSnapshot, 'branch' | 'headSha' | 'upstream' | 'ahead' | 'behind'> = {
    branch: null,
    headSha: null
  };
  const files: GitFileChange[] = [];
  const conflicts: GitConflict[] = [];
  const parts = output.split('\0').filter((part) => part.length > 0);

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid' && value !== '(initial)') snapshotMeta.headSha = value;
      if (key === 'branch.head' && value !== '(detached)') snapshotMeta.branch = value;
      if (key === 'branch.upstream' && value) snapshotMeta.upstream = value;
      if (key === 'branch.ab') Object.assign(snapshotMeta, parseAheadBehind(value));
      continue;
    }

    const recordType = record[0];
    if (recordType === '?') {
      const path = record.slice(2);
      files.push({ path, status: 'untracked', staged: false, unstaged: true });
      continue;
    }

    if (recordType === '1') {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(8).join(' ');
      files.push({
        path,
        status: xyToStatus(xy),
        staged: isChanged(xy[0]),
        unstaged: isChanged(xy[1])
      });
      continue;
    }

    if (recordType === '2') {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(9).join(' ');
      const oldPath = parts[index + 1];
      index += 1;
      files.push({
        path,
        oldPath,
        status: xyToStatus(xy, '2'),
        staged: isChanged(xy[0]),
        unstaged: isChanged(xy[1])
      });
      continue;
    }

    if (recordType === 'u') {
      const fields = record.split(' ');
      const xy = fields[1] ?? 'UU';
      const path = fields.slice(10).join(' ');
      files.push({ path, status: 'conflicted', staged: true, unstaged: true });
      conflicts.push({ path, status: xy, stages: { base: true, ours: true, theirs: true } });
    }
  }

  files.sort((left, right) => {
    if (left.status === 'conflicted' && right.status !== 'conflicted') return -1;
    if (right.status === 'conflicted' && left.status !== 'conflicted') return 1;
    return left.path.localeCompare(right.path);
  });

  return { snapshotMeta, files, conflicts };
}

function resolveGitDir(cwd: string) {
  const result = git(cwd, ['rev-parse', '--git-dir']);
  if (!result.ok) return undefined;
  const gitDir = result.stdout.trim();
  if (!gitDir) return undefined;
  return isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
}

function operationState(cwd: string) {
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return { isMerging: false, isRebasing: false, isCherryPicking: false };
  return {
    isMerging: existsSync(join(gitDir, 'MERGE_HEAD')),
    isRebasing: existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply')),
    isCherryPicking: existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))
  };
}

export function getGitSnapshot(cwd: string): GitSnapshot {
  if (!existsSync(cwd)) return emptySnapshot(cwd, 'Project folder does not exist.');
  const status = git(cwd, ['status', '--porcelain=v2', '--branch', '-z']);
  if (!status.ok) return emptySnapshot(cwd, status.error);
  const { snapshotMeta, files, conflicts } = parsePorcelainV2(status.stdout);
  return {
    cwd,
    ...snapshotMeta,
    ...operationState(cwd),
    isDirty: files.length > 0,
    files,
    conflicts
  };
}

function isSafeRelativePath(path: string) {
  if (!path || isAbsolute(path)) return false;
  const normalized = normalize(path);
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.startsWith('..\\') && !normalized.split(/[\\/]/).includes('..');
}

function isBinaryDiff(diff: string) {
  return /Binary files .* differ|GIT binary patch/.test(diff);
}

function syntheticUntrackedDiff(cwd: string, filePath: string): FileDiff {
  const absolutePath = join(cwd, filePath);
  try {
    const normalizedRelative = relative(cwd, absolutePath);
    if (!isSafeRelativePath(normalizedRelative) || normalizedRelative !== filePath) {
      return { path: filePath, kind: 'untracked', diff: '', error: 'Unsafe file path.' };
    }
    const stats = statSync(absolutePath);
    if (!stats.isFile()) return { path: filePath, kind: 'untracked', diff: '', error: 'Only regular files can be diffed.' };
    if (stats.size > 512 * 1024) return { path: filePath, kind: 'untracked', diff: '', binary: true, error: 'File is too large to preview.' };
    const text = readFileSync(absolutePath, 'utf8');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const diff = [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
      ...lines.map((line) => `+${line}`)
    ].join('\n');
    return { path: filePath, kind: 'untracked', diff };
  } catch (error) {
    return {
      path: filePath,
      kind: 'untracked',
      diff: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function getGitFileDiff(cwd: string, filePath: string, kind: FileDiffKind = 'worktree'): FileDiff {
  if (!isSafeRelativePath(filePath)) return { path: filePath, kind, diff: '', error: 'Unsafe file path.' };
  if (!existsSync(cwd)) return { path: filePath, kind, diff: '', error: 'Project folder does not exist.' };
  if (kind === 'untracked') return syntheticUntrackedDiff(cwd, filePath);

  const args = ['diff', '--no-ext-diff', '--find-renames', '--', filePath];
  if (kind === 'staged') args.splice(1, 0, '--cached');
  const result = git(cwd, args);
  const diff = result.stdout;
  return {
    path: filePath,
    kind,
    diff,
    binary: isBinaryDiff(diff),
    error: result.ok ? undefined : result.error
  };
}
