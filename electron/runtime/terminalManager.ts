import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expandHome } from '../paths.js';
import { interactiveShellInvocation } from '../platform.js';

export type TerminalSnapshot = {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
};

export type TerminalDataEvent = { id: string; data: string };
export type TerminalExitEvent = { id: string; exitCode?: number; signal?: string };

type DataListener = (event: TerminalDataEvent) => void;
type ExitListener = (event: TerminalExitEvent) => void;

type TerminalProcess = {
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: { exitCode?: number; signal?: number | string }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: NodeJS.Signals) => void;
};

type SpawnTerminal = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }
) => TerminalProcess;

type Entry = {
  snapshot: TerminalSnapshot;
  process: TerminalProcess;
};

type NodePtyModule = {
  spawn: (
    command: string,
    args: string[],
    options: { name: string; cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }
  ) => TerminalProcess;
};

const require = createRequire(import.meta.url);

function resolveFirstCwd(rawCwd: string) {
  const first = rawCwd.split(' + ')[0]?.trim() ?? rawCwd;
  return expandHome(first);
}

function pickShell(): { command: string; args: string[] } {
  return interactiveShellInvocation();
}

let nextId = 0;
function makeTerminalId() {
  nextId += 1;
  return `term-${Date.now()}-${nextId}`;
}

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return;

  try {
    const moduleEntry = require.resolve('node-pty');
    const moduleRoot = dirname(dirname(moduleEntry));
    const helper = join(moduleRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // If this fails, node-pty will surface the real spawn error and the manager can fall back next run.
  }
}

function loadNodePty(): NodePtyModule | undefined {
  try {
    ensureNodePtySpawnHelperExecutable();
    return require('node-pty') as NodePtyModule;
  } catch {
    return undefined;
  }
}

function childProcessFallback(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): TerminalProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
    shell: false
  }) as ChildProcessWithoutNullStreams;

  return {
    onData(listener) {
      child.stdout?.on('data', (chunk: Buffer | string) => listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer | string) => listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
      child.on('error', (error) => listener(`\r\n[terminal] ${error.message}\r\n`));
    },
    onExit(listener) {
      child.on('exit', (code, signal) => listener({ exitCode: code ?? undefined, signal: signal ?? undefined }));
    },
    write(data) {
      child.stdin?.write(data);
    },
    resize() {
      // Pipe-mode fallback cannot resize. node-pty is the real path.
    },
    kill(signal = 'SIGTERM') {
      child.kill(signal);
    }
  };
}

const defaultSpawnTerminal: SpawnTerminal = (command, args, options) => {
  const nodePty = loadNodePty();
  if (nodePty) {
    try {
      return nodePty.spawn(command, args, {
        name: 'xterm-256color',
        cwd: options.cwd,
        env: options.env,
        cols: options.cols,
        rows: options.rows
      });
    } catch {
      return childProcessFallback(command, args, options);
    }
  }

  return childProcessFallback(command, args, options);
};

export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly spawnTerminal: SpawnTerminal = defaultSpawnTerminal) {}

  create(projectId: string, rawCwd: string): TerminalSnapshot {
    const id = makeTerminalId();
    const cwd = resolveFirstCwd(rawCwd);
    const safeCwd = existsSync(cwd) ? cwd : homedir();
    const counter = (this.counters.get(projectId) ?? 0) + 1;
    this.counters.set(projectId, counter);
    const title = `Terminal ${counter} · ${basename(safeCwd) || safeCwd}`;
    const snapshot: TerminalSnapshot = { id, projectId, title, cwd: safeCwd };

    const { command, args } = pickShell();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: process.env.COLORTERM ?? 'truecolor'
    };

    const terminalProcess = this.spawnTerminal(command, args, { cwd: safeCwd, env, cols: 120, rows: 30 });
    this.entries.set(id, { snapshot, process: terminalProcess });

    terminalProcess.onData((data) => this.emitData({ id, data }));
    terminalProcess.onExit((event) => {
      this.entries.delete(id);
      this.emitExit({
        id,
        exitCode: event.exitCode,
        signal: event.signal !== undefined ? String(event.signal) : undefined
      });
    });

    return { ...snapshot };
  }

  write(id: string, data: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    try {
      entry.process.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const safeCols = Math.max(2, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    try {
      entry.process.resize(safeCols, safeRows);
      return true;
    } catch {
      return false;
    }
  }

  kill(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    try {
      entry.process.kill('SIGTERM');
    } catch {
      return false;
    }
    return true;
  }

  killAll() {
    for (const id of [...this.entries.keys()]) this.kill(id);
  }

  list(projectId?: string): TerminalSnapshot[] {
    const snapshots: TerminalSnapshot[] = [];
    for (const entry of this.entries.values()) {
      if (projectId && entry.snapshot.projectId !== projectId) continue;
      snapshots.push({ ...entry.snapshot });
    }
    return snapshots;
  }

  onData(listener: DataListener) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private emitData(event: TerminalDataEvent) {
    for (const listener of this.dataListeners) listener(event);
  }

  private emitExit(event: TerminalExitEvent) {
    for (const listener of this.exitListeners) listener(event);
  }
}
