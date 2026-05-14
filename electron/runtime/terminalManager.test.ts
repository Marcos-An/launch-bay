// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager } from './terminalManager.js';

class FakePtyProcess {
  private readonly dataEmitter = new EventEmitter();
  private readonly exitEmitter = new EventEmitter();
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();

  onData(listener: (data: string) => void) {
    this.dataEmitter.on('data', listener);
  }

  onExit(listener: (event: { exitCode?: number; signal?: string }) => void) {
    this.exitEmitter.on('exit', listener);
  }

  emitData(data: string) {
    this.dataEmitter.emit('data', data);
  }

  emitExit(event: { exitCode?: number; signal?: string }) {
    this.exitEmitter.emit('exit', event);
  }
}

describe('TerminalManager', () => {
  // The manager falls back to `homedir()` when the requested cwd does not
  // exist. Tests must point at a real directory so the title derives from
  // the folder name rather than the developer's home directory.
  let projectDir: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'launch-bay-terminal-'));
    projectDir = join(base, 'sample-app');
    mkdirSync(projectDir);
  });

  afterEach(() => {
    // tmpdir contents are cleaned up by the OS; we leave the dir behind.
  });

  it('starts an interactive shell through the PTY adapter in the project cwd', () => {
    const ptyProcess = new FakePtyProcess();
    const spawnTerminal = vi.fn(() => ptyProcess);
    const manager = new TerminalManager(spawnTerminal as never);

    const snapshot = manager.create('sample', projectDir);

    expect(snapshot.title).toBe('Terminal 1 · sample-app');
    expect(snapshot.cwd).toBe(projectDir);
    expect(spawnTerminal).toHaveBeenCalledWith(
      expect.stringMatching(/\/zsh$|\/bash$|\/sh$/),
      ['-l'],
      expect.objectContaining({
        cwd: projectDir,
        cols: 120,
        rows: 30,
        env: expect.objectContaining({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })
      })
    );
  });

  it('does not leak Launch Bay dev process env into interactive terminals', () => {
    const previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      npm_lifecycle_event: process.env.npm_lifecycle_event,
      npm_package_json: process.env.npm_package_json,
      INIT_CWD: process.env.INIT_CWD,
      PATH: process.env.PATH
    };
    process.env.NODE_ENV = 'production';
    process.env.NODE_OPTIONS = '--max-old-space-size=8192 --expose-gc';
    process.env.npm_lifecycle_event = 'dev';
    process.env.npm_package_json = '/Users/marcos/Documents/launch-bay/package.json';
    process.env.INIT_CWD = '/Users/marcos/Documents/launch-bay';
    process.env.PATH = '/Users/marcos/Documents/launch-bay/node_modules/.bin:/snapshot/dist/node-gyp-bin:/usr/bin:/bin';

    try {
      const ptyProcess = new FakePtyProcess();
      const spawnTerminal = vi.fn(() => ptyProcess);
      const manager = new TerminalManager(spawnTerminal as never);

      manager.create('sample', projectDir);
      const env = spawnTerminal.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;

      expect(env.NODE_ENV).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.npm_lifecycle_event).toBeUndefined();
      expect(env.npm_package_json).toBeUndefined();
      expect(env.INIT_CWD).toBeUndefined();
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.TERM).toBe('xterm-256color');
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('forwards raw terminal bytes and resize requests to the PTY process', () => {
    const ptyProcess = new FakePtyProcess();
    const manager = new TerminalManager(vi.fn(() => ptyProcess) as never);
    const snapshot = manager.create('sample', projectDir);
    const dataEvents: Array<{ projectId: string; data: string }> = [];
    manager.onData((event) => dataEvents.push({ projectId: event.projectId, data: event.data }));

    expect(manager.write(snapshot.id, 'p')).toBe(true);
    expect(manager.write(snapshot.id, '\r')).toBe(true);
    expect(ptyProcess.write).toHaveBeenCalledWith('p');
    expect(ptyProcess.write).toHaveBeenCalledWith('\r');

    expect(manager.resize(snapshot.id, 101.8, 28.2)).toBe(true);
    expect(ptyProcess.resize).toHaveBeenCalledWith(101, 28);

    ptyProcess.emitData('\u001b[32mready\u001b[0m\r\n');
    expect(dataEvents).toEqual([{ projectId: 'sample', data: '\u001b[32mready\u001b[0m\r\n' }]);
  });
});
