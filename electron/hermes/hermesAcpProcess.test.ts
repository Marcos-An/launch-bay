// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HermesAcpProcess } from './hermesAcpProcess.js';

class FakeStream extends EventEmitter {
  setEncoding(_encoding: string) {
    // no-op — HermesAcpProcess calls this on stdout/stderr at spawn time.
  }
  push(chunk: string) {
    this.emit('data', chunk);
  }
}

class FakeStdin extends EventEmitter {
  written: string[] = [];
  write(chunk: string) {
    this.written.push(chunk);
    return true;
  }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode: number | null = null;
  killCalls: string[] = [];
  kill(signal: string) {
    this.killCalls.push(signal);
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
  }
}

function lastRequest(child: FakeChild) {
  const last = child.stdin.written.at(-1);
  if (!last) throw new Error('no message sent');
  return JSON.parse(last.trim()) as Record<string, unknown>;
}

function allRequests(child: FakeChild) {
  return child.stdin.written.map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function respondTo(child: FakeChild, id: number, result: unknown) {
  child.stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

describe('HermesAcpProcess', () => {
  function setup() {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const proc = new HermesAcpProcess({
      command: 'hermes',
      spawnFn,
      initializeTimeoutMs: 200,
      logger: () => undefined
    });
    return { child, spawnFn, proc };
  }

  it('spawns `hermes acp --accept-hooks` and sends an initialize request first', async () => {
    const { child, spawnFn, proc } = setup();
    const startPromise = proc.start();
    await flush();

    expect(spawnFn).toHaveBeenCalledWith(
      'hermes',
      ['acp', '--accept-hooks'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
    const initRequest = lastRequest(child);
    expect(initRequest).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: expect.objectContaining({
        protocolVersion: 1,
        clientCapabilities: expect.objectContaining({
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        })
      })
    });

    respondTo(child, 1, { protocolVersion: 1, agentInfo: { name: 'hermes-agent' } });
    await startPromise;
    expect(proc.isRunning()).toBe(true);
  });

  it('sends session/new with absolute cwd and empty mcpServers', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    respondTo(child, 1, {});
    await startPromise;

    const sessionPromise = proc.newSession({ cwd: '/repos/foo' });
    await flush();

    const newSessionRequest = lastRequest(child);
    expect(newSessionRequest).toMatchObject({
      method: 'session/new',
      params: { cwd: '/repos/foo', mcpServers: [] }
    });

    respondTo(child, 2, { sessionId: 'sess-42' });
    const sessionId = await sessionPromise;
    expect(sessionId).toBe('sess-42');
  });

  it('delivers session/update notifications as decoded events to the per-session callback', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    respondTo(child, 1, {});
    await startPromise;

    const sessionPromise = proc.newSession({ cwd: '/repos/foo' });
    await flush();
    respondTo(child, 2, { sessionId: 'sess-1' });
    await sessionPromise;

    const events: unknown[] = [];
    const promptPromise = proc.prompt('sess-1', 'hello', {
      onUpdate: (event) => events.push(event)
    });
    await flush();

    const promptRequest = lastRequest(child);
    expect(promptRequest).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'hello' }]
      }
    });

    child.stdout.push(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
        }
      })}\n`
    );
    child.stdout.push(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'usage_update', used: 100, size: 200000 }
        }
      })}\n`
    );

    respondTo(child, 3, { stopReason: 'end_turn' });
    const result = await promptPromise;

    expect(events).toEqual([
      { kind: 'agent_message_chunk', text: 'hi' },
      { kind: 'usage_update', usage: { used: 100, size: 200000, cost: undefined } }
    ]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ used: 100, size: 200000, cost: undefined });
  });

  it('serializes image attachments as ImageContentBlock entries in the prompt array', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    respondTo(child, 1, {});
    await startPromise;

    const sessionPromise = proc.newSession({ cwd: '/repos/foo' });
    await flush();
    respondTo(child, 2, { sessionId: 'sess-img' });
    await sessionPromise;

    const promptPromise = proc.prompt(
      'sess-img',
      'look',
      {},
      { images: [{ data: 'AAAA', mimeType: 'image/png' }] }
    );
    await flush();

    const promptRequest = lastRequest(child);
    expect(promptRequest).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'sess-img',
        prompt: [
          { type: 'text', text: 'look' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' }
        ]
      }
    });

    respondTo(child, 3, { stopReason: 'end_turn' });
    await promptPromise;
  });

  it('falls back to an empty text block when only images are sent', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    respondTo(child, 1, {});
    await startPromise;

    const sessionPromise = proc.newSession({ cwd: '/repos/foo' });
    await flush();
    respondTo(child, 2, { sessionId: 'sess-img2' });
    await sessionPromise;

    const promptPromise = proc.prompt(
      'sess-img2',
      '',
      {},
      { images: [{ data: 'BBBB', mimeType: 'image/jpeg' }] }
    );
    await flush();

    const promptRequest = lastRequest(child);
    expect(promptRequest).toMatchObject({
      params: {
        prompt: [{ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }]
      }
    });

    respondTo(child, 3, { stopReason: 'end_turn' });
    await promptPromise;
  });

  it('emits session/cancel as a JSON-RPC notification (no id)', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    respondTo(child, 1, {});
    await startPromise;

    proc.cancel('sess-1');
    const sent = lastRequest(child);
    expect(sent.id).toBeUndefined();
    expect(sent.method).toBe('session/cancel');
    expect(sent.params).toEqual({ sessionId: 'sess-1' });
  });

  it('auto-allows session/request_permission by picking an allow_once option', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    respondTo(child, 1, {});
    await startPromise;

    child.stdout.push(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 999,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          options: [
            { kind: 'reject_once', optionId: 'no' },
            { kind: 'allow_once', optionId: 'yes' }
          ]
        }
      })}\n`
    );
    await flush();

    const responses = allRequests(child).filter((m) => m.id === 999);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'yes' } }
    });
  });

  it('replies with JSON-RPC method-not-found for fs/terminal client requests we did not advertise', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    respondTo(child, 1, {});
    await startPromise;

    child.stdout.push(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: {} })}\n`
    );
    await flush();

    const reply = allRequests(child).find((m) => m.id === 7);
    expect(reply).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601 }
    });
  });

  it('calls resolveBin once before spawning to support packaged builds without shell PATH', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const resolveBin = vi.fn(async () => '/opt/homebrew/bin/hermes');
    const proc = new HermesAcpProcess({
      command: 'hermes',
      spawnFn,
      resolveBin,
      initializeTimeoutMs: 200,
      logger: () => undefined
    });
    const startPromise = proc.start();
    await flush();
    expect(resolveBin).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith(
      '/opt/homebrew/bin/hermes',
      ['acp', '--accept-hooks'],
      expect.any(Object)
    );
    respondTo(child, 1, {});
    await startPromise;
  });

  it('skips resolveBin when the configured command is already an absolute path', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const resolveBin = vi.fn(async () => '/should/not/be/called');
    const proc = new HermesAcpProcess({
      command: '/opt/hermes/bin/hermes',
      spawnFn,
      resolveBin,
      initializeTimeoutMs: 200,
      logger: () => undefined
    });
    const startPromise = proc.start();
    await flush();
    expect(resolveBin).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledWith(
      '/opt/hermes/bin/hermes',
      expect.any(Array),
      expect.any(Object)
    );
    respondTo(child, 1, {});
    await startPromise;
  });

  it('rejects in-flight requests when the process exits unexpectedly', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    respondTo(child, 1, {});
    await startPromise;

    const sessionPromise = proc.newSession({ cwd: '/repos/foo' });
    await flush();
    child.exitCode = 1;
    child.emit('exit', 1, null);

    await expect(sessionPromise).rejects.toThrow(/exited/);
    expect(proc.isRunning()).toBe(false);
  });

  it('buffers partial JSON-RPC lines until a full newline arrives', async () => {
    const { child, proc } = setup();
    const startPromise = proc.start();
    await flush();
    // initialize response is delivered in two stdout chunks split mid-line.
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const split = Math.floor(payload.length / 2);
    child.stdout.push(payload.slice(0, split));
    await flush();
    child.stdout.push(`${payload.slice(split)}\n`);

    await expect(startPromise).resolves.toBeUndefined();
  });
});
