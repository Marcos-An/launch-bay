import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('builds the Electron preload/main bridge before starting dev mode', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

    expect(packageJson.scripts['build:electron']).toContain('tsc -p electron/tsconfig.json');
    expect(packageJson.scripts['build:electron']).toContain('cp electron/preload.cjs dist-electron/preload.cjs');
    expect(packageJson.scripts.dev).toContain('pnpm build:electron &&');
    expect(packageJson.scripts.dev).toContain('electron .');
  });
});
