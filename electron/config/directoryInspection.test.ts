// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectServerDirectory } from './directoryInspection.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'launch-bay-dir-'));
}

describe('inspectServerDirectory', () => {
  it('reports missing and non-directory paths without throwing', () => {
    const dir = tempDir();
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'hello', 'utf8');

    expect(inspectServerDirectory(join(dir, 'missing'))).toMatchObject({ exists: false, isDirectory: false, isGitRepository: false });
    expect(inspectServerDirectory(file)).toMatchObject({ exists: true, isDirectory: false, isGitRepository: false });
  });

  it('distinguishes non-Git directories from Git repositories with branch and dirty state', () => {
    const plain = tempDir();
    expect(inspectServerDirectory(plain)).toMatchObject({ exists: true, isDirectory: true, isGitRepository: false });

    const repo = tempDir();
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), 'hello', 'utf8');

    expect(inspectServerDirectory(repo)).toMatchObject({
      exists: true,
      isDirectory: true,
      isGitRepository: true,
      branch: 'main',
      dirty: true
    });
  });

  it('infers server defaults from local project metadata without reading environment secrets', () => {
    const project = tempDir();
    writeFileSync(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      name: 'sample-app',
      description: 'Client web app',
      scripts: {
        dev: 'vite --host 0.0.0.0 --port 5000',
        start: 'vite preview --port 4173'
      }
    }), 'utf8');
    writeFileSync(join(project, '.env'), 'API_KEY=super-secret\nPORT=9999\n', 'utf8');

    expect(inspectServerDirectory(project)).toMatchObject({
      serverDefaults: {
        name: 'sample-app',
        command: 'pnpm dev',
        url: 'http://localhost:5000',
        description: 'Client web app'
      }
    });
  });
});
