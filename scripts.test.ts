// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import viteConfig from './vite.config';

describe('package scripts', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

  it('builds the Electron preload/main bridge before starting dev mode', () => {
    expect(packageJson.scripts['build:electron']).toContain('tsc -p electron/tsconfig.json');
    expect(packageJson.scripts['build:electron']).toContain('cp electron/preload.cjs dist-electron/preload.cjs');
    expect(packageJson.scripts.dev).toContain('pnpm build:electron &&');
    expect(packageJson.scripts.dev).toContain('electron .');
  });

  it('packages a double-clickable macOS app from the production build', () => {
    expect(packageJson.scripts['package:mac']).toBe('pnpm build && electron-builder --mac dir');
    expect(packageJson.build.productName).toBe('Launch Bay');
    expect(packageJson.build.mac.target).toContain('dir');
    expect(packageJson.build.mac.icon).toBe('build-resources/icon.icns');
    expect(packageJson.build.files).toEqual(expect.arrayContaining(['dist/**', 'dist-electron/**']));
    expect(packageJson.build.files).toContain('!dist-electron/**/*.test.js');
    expect(packageJson.dependencies.electron).toBeUndefined();
    expect(packageJson.devDependencies.electron).toBeDefined();
  });

  it('uses relative Vite asset paths so the packaged file:// app can load the renderer', () => {
    expect(viteConfig.base).toBe('./');
  });
});
