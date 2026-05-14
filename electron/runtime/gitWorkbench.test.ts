// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { getGitFileDiff, getGitSnapshot } from './gitWorkbench.js';

const repos: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'launch-bay-git-'));
  repos.push(cwd);
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'launch-bay@example.test']);
  git(cwd, ['config', 'user.name', 'Launch Bay']);
  writeFileSync(join(cwd, 'README.md'), 'hello\n');
  git(cwd, ['add', 'README.md']);
  git(cwd, ['commit', '-m', 'initial']);
  return cwd;
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('git workbench snapshot', () => {
  it('summarizes modified, added, deleted, renamed, untracked and conflicted files', () => {
    const cwd = createRepo();
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/app.ts'), 'export const app = 1;\n');
    writeFileSync(join(cwd, 'delete-me.ts'), 'remove\n');
    writeFileSync(join(cwd, 'rename-me.ts'), 'rename\n');
    git(cwd, ['add', 'src/app.ts', 'delete-me.ts', 'rename-me.ts']);
    git(cwd, ['commit', '-m', 'seed files']);

    writeFileSync(join(cwd, 'src/app.ts'), 'export const app = 2;\n');
    writeFileSync(join(cwd, 'new-file.ts'), 'new\n');
    git(cwd, ['add', 'new-file.ts']);
    rmSync(join(cwd, 'delete-me.ts'));
    git(cwd, ['mv', 'rename-me.ts', 'renamed.ts']);
    writeFileSync(join(cwd, 'scratch.ts'), 'scratch\n');

    const snapshot = getGitSnapshot(cwd);

    expect(snapshot.branch).toBe('main');
    expect(snapshot.isDirty).toBe(true);
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/app.ts', status: 'modified', unstaged: true }),
      expect.objectContaining({ path: 'new-file.ts', status: 'added', staged: true }),
      expect.objectContaining({ path: 'delete-me.ts', status: 'deleted', unstaged: true }),
      expect.objectContaining({ path: 'renamed.ts', oldPath: 'rename-me.ts', status: 'renamed', staged: true }),
      expect.objectContaining({ path: 'scratch.ts', status: 'untracked', staged: false, unstaged: true })
    ]));
  });

  it('detects merge state and lists conflicted paths', () => {
    const cwd = createRepo();
    writeFileSync(join(cwd, 'conflict.txt'), 'base\n');
    git(cwd, ['add', 'conflict.txt']);
    git(cwd, ['commit', '-m', 'base conflict file']);
    git(cwd, ['checkout', '-b', 'feature']);
    writeFileSync(join(cwd, 'conflict.txt'), 'feature\n');
    git(cwd, ['commit', '-am', 'feature edit']);
    git(cwd, ['checkout', 'main']);
    writeFileSync(join(cwd, 'conflict.txt'), 'main\n');
    git(cwd, ['commit', '-am', 'main edit']);

    try {
      git(cwd, ['merge', 'feature']);
    } catch {
      // Expected: this leaves the temp repo in a merge conflict.
    }

    const snapshot = getGitSnapshot(cwd);

    expect(snapshot.isMerging).toBe(true);
    expect(snapshot.conflicts).toEqual([
      expect.objectContaining({ path: 'conflict.txt', status: 'UU' })
    ]);
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'conflict.txt', status: 'conflicted' })
    ]));
  });
});

describe('git workbench diff', () => {
  it('returns a focused unified diff for tracked changes and synthetic diff for untracked files', () => {
    const cwd = createRepo();
    writeFileSync(join(cwd, 'README.md'), 'hello\nworld\n');
    writeFileSync(join(cwd, 'notes.md'), 'first note\nsecond note\n');

    const tracked = getGitFileDiff(cwd, 'README.md');
    const untracked = getGitFileDiff(cwd, 'notes.md', 'untracked');

    expect(tracked.diff).toContain('diff --git a/README.md b/README.md');
    expect(tracked.diff).toContain('+world');
    expect(untracked.diff).toContain('new file mode 100644');
    expect(untracked.diff).toContain('+first note');
    expect(untracked.diff).toContain('+second note');
  });

  it('rejects unsafe file paths before invoking git', () => {
    const cwd = createRepo();

    const result = getGitFileDiff(cwd, '../outside.ts');

    expect(result.error).toMatch(/unsafe/i);
    expect(result.diff).toBe('');
  });
});
