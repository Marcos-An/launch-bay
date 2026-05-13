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

  it('forwards raw terminal bytes and resize requests to the PTY process', () => {
    const ptyProcess = new FakePtyProcess();
    const manager = new TerminalManager(vi.fn(() => ptyProcess) as never);
    const snapshot = manager.create('sample', projectDir);
    const dataEvents: string[] = [];
    manager.onData((event) => dataEvents.push(event.data));

    expect(manager.write(snapshot.id, 'p')).toBe(true);
    expect(manager.write(snapshot.id, '\r')).toBe(true);
    expect(ptyProcess.write).toHaveBeenCalledWith('p');
    expect(ptyProcess.write).toHaveBeenCalledWith('\r');

    expect(manager.resize(snapshot.id, 101.8, 28.2)).toBe(true);
    expect(ptyProcess.resize).toHaveBeenCalledWith(101, 28);

    ptyProcess.emitData('[32mready[0m\r\n');
    expect(dataEvents).toEqual(['[32mready[0m\r\n']);
  });
});
