// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { HermesSessionManager, type HermesUpdate } from './hermesClient.js';
import type {
  AcpPromptCallbacks,
  AcpPromptOptions,
  AcpPromptResult,
  AcpSessionUpdateEvent,
  HermesAcpProcessLike
} from './hermesAcpProcess.js';

type PromptCall = {
  sessionId: string;
  text: string;
  callbacks?: AcpPromptCallbacks;
  options?: AcpPromptOptions;
};

type Reply = {
  chunks?: string[];
  usage?: { used: number; size: number };
  thinking?: string[];
  stopReason?: string;
  delay?: () => Promise<void>;
};

function createFakeAcp(replies: Reply[] | Reply = []) {
  const promptCalls: PromptCall[] = [];
  const newSessionCalls: { cwd: string }[] = [];
  const loadSessionCalls: { cwd: string; sessionId: string }[] = [];
  const cancelCalls: string[] = [];
  const subscribers = new Map<string, Set<(event: AcpSessionUpdateEvent) => void>>();
  let sessionCounter = 0;
  const replyQueue: Reply[] = Array.isArray(replies) ? [...replies] : [replies];

  const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const acp: HermesAcpProcessLike & {
    promptCalls: PromptCall[];
    newSessionCalls: { cwd: string }[];
    loadSessionCalls: { cwd: string; sessionId: string }[];
    cancelCalls: string[];
    queueReply: (reply: Reply) => void;
    emitAmbient: (sessionId: string, event: AcpSessionUpdateEvent) => void;
    emitLifecycle: (event: 'exit' | 'restarted', payload?: unknown) => void;
  } = {
    promptCalls,
    newSessionCalls,
    loadSessionCalls,
    cancelCalls,
    queueReply(reply) {
      replyQueue.push(reply);
    },
    emitAmbient(sessionId, event) {
      const set = subscribers.get(sessionId);
      if (!set) return;
      for (const listener of set) listener(event);
    },
    emitLifecycle(event, payload) {
      const set = eventListeners.get(event);
      if (!set) return;
      for (const listener of set) listener(payload);
    },
    async start() {
      // no-op
    },
    async newSession(params) {
      newSessionCalls.push({ cwd: params.cwd });
      sessionCounter += 1;
      return `acp-session-${sessionCounter}`;
    },
    async loadSession(params) {
      loadSessionCalls.push({ cwd: params.cwd, sessionId: params.sessionId });
    },
    async listSessions() {
      return { sessions: [] };
    },
    subscribeSession(sessionId, listener) {
      let set = subscribers.get(sessionId);
      if (!set) {
        set = new Set();
        subscribers.set(sessionId, set);
      }
      set.add(listener);
      return () => set?.delete(listener);
    },
    async prompt(sessionId, text, callbacks, options) {
      promptCalls.push({ sessionId, text, callbacks, options });
      const reply = replyQueue.shift() ?? {};
      if (reply.delay) await reply.delay();
      const emit = (event: AcpSessionUpdateEvent) => callbacks?.onUpdate?.(event);
      for (const thought of reply.thinking ?? []) {
        emit({ kind: 'agent_thought_chunk', text: thought });
      }
      for (const chunk of reply.chunks ?? []) {
        emit({ kind: 'agent_message_chunk', text: chunk });
      }
      if (reply.usage) {
        emit({ kind: 'usage_update', usage: reply.usage });
      }
      const result: AcpPromptResult = {
        stopReason: reply.stopReason ?? 'end_turn',
        usage: reply.usage
      };
      return result;
    },
    cancel(sessionId) {
      cancelCalls.push(sessionId);
    },
    setApprovalMode() {
      // no-op for the fake
    },
    respondToPermission() {
      // no-op for the fake
    },
    kill() {
      // no-op
    },
    isRunning() {
      return true;
    },
    on(event, listener) {
      let set = eventListeners.get(event);
      if (!set) {
        set = new Set();
        eventListeners.set(event, set);
      }
      set.add(listener as (...args: unknown[]) => void);
    }
  };
  return acp;
}

describe('HermesSessionManager (ACP)', () => {
  it('allocates an ACP session for the project cwd and forwards the user text as a prompt', async () => {
    const acp = createFakeAcp({ chunks: ['Hello from Hermes'] });
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    const snapshot = await manager.send('sample', 'Status?');

    expect(acp.newSessionCalls).toEqual([{ cwd: '/repos/sample' }]);
    expect(acp.promptCalls).toHaveLength(1);
    expect(acp.promptCalls[0]).toMatchObject({
      sessionId: 'acp-session-1',
      text: 'Status?'
    });
    expect(snapshot.pending).toBe(false);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'Status?' }),
      expect.objectContaining({ role: 'assistant', text: 'Hello from Hermes' })
    ]);
  });

  it('reuses the same ACP session for subsequent sends in the same project', async () => {
    const acp = createFakeAcp([{ chunks: ['first'] }, { chunks: ['second'] }]);
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    await manager.send('sample', 'a');
    await manager.send('sample', 'b');

    expect(acp.newSessionCalls).toHaveLength(1);
    expect(acp.promptCalls.map((c) => c.sessionId)).toEqual(['acp-session-1', 'acp-session-1']);
  });

  it('streams agent_message_chunk updates into the assistant message snapshot', async () => {
    const acp = createFakeAcp({ chunks: ['Olá', ', ', 'mundo'] });
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    const snapshots: HermesUpdate[] = [];
    manager.onUpdate((event) => snapshots.push(event));

    await manager.send('sample', 'oi');

    const assistantTexts = snapshots
      .map((s) => s.snapshot.messages.find((m) => m.role === 'assistant')?.text)
      .filter((t): t is string => typeof t === 'string');
    expect(assistantTexts).toContain('Olá');
    expect(assistantTexts).toContain('Olá, ');
    expect(assistantTexts.at(-1)).toBe('Olá, mundo');
    expect(snapshots.at(-1)?.snapshot.pending).toBe(false);
  });

  it('captures usage_update events as contextUsage and computes percent against contextLength', async () => {
    const acp = createFakeAcp({ chunks: ['ok'], usage: { used: 12200, size: 200000 } });
    const manager = new HermesSessionManager({
      acp,
      contextLength: 200000,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    const snapshot = await manager.send('sample', 'q');

    expect(snapshot.contextUsage).toMatchObject({
      totalTokens: 12200,
      contextLength: 200000,
      percent: 6.1
    });
  });

  it('reset cancels the active ACP session and drops the cached sessionId', async () => {
    const acp = createFakeAcp([{ chunks: ['first'] }, { chunks: ['fresh'] }]);
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    await manager.send('sample', 'first');
    const reset = manager.reset('sample');
    expect(reset.messages).toEqual([]);
    expect(acp.cancelCalls).toEqual(['acp-session-1']);

    await manager.send('sample', 'fresh');
    expect(acp.newSessionCalls).toHaveLength(2);
    expect(acp.newSessionCalls[1]).toEqual({ cwd: '/repos/sample' });
    expect(acp.promptCalls.at(-1)).toMatchObject({ sessionId: 'acp-session-2', text: 'fresh' });
  });

  it('surfaces ACP errors as snapshot.error without crashing', async () => {
    const failing: HermesAcpProcessLike = {
      ...createFakeAcp(),
      async newSession() {
        return 'acp-session-99';
      },
      async prompt() {
        throw new Error('connection refused');
      }
    };
    const manager = new HermesSessionManager({
      acp: failing,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    const snapshot = await manager.send('sample', 'hi');
    expect(snapshot.pending).toBe(false);
    expect(snapshot.error).toMatch(/connection refused/);
    expect(snapshot.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('keeps message histories isolated between projects', async () => {
    const acp = createFakeAcp([{ chunks: ['Sample reply'] }, { chunks: ['Stack reply'] }]);
    const manager = new HermesSessionManager({
      acp,
      projectContexts: {
        sample: { name: 'Sample', cwd: '/repos/sample' },
        'sample-stack': { name: 'Sample Stack', cwd: '/repos/sample-stack' }
      }
    });

    await manager.send('sample', 'OT q');
    await manager.send('sample-stack', 'Stack q');

    expect(acp.newSessionCalls).toEqual([{ cwd: '/repos/sample' }, { cwd: '/repos/sample-stack' }]);
    expect(manager.getSnapshot('sample').messages.map((m) => m.text)).toEqual(['OT q', 'Sample reply']);
    expect(manager.getSnapshot('sample-stack').messages.map((m) => m.text)).toEqual(['Stack q', 'Stack reply']);
  });

  it('returns an empty snapshot for projects with no messages yet', () => {
    const acp = createFakeAcp();
    const manager = new HermesSessionManager({ acp });
    const snapshot = manager.getSnapshot('sample');
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.pending).toBe(false);
    expect(snapshot.error).toBeUndefined();
  });

  it('ignores late replies from a prompt that was reset while pending', async () => {
    let releasePending: () => void = () => undefined;
    const acp = createFakeAcp({
      chunks: ['late reply'],
      delay: () =>
        new Promise<void>((resolve) => {
          releasePending = resolve;
        })
    });
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    const pending = manager.send('sample', 'slow');
    expect(manager.getSnapshot('sample')).toMatchObject({ pending: true });

    manager.reset('sample');
    releasePending();
    const snapshot = await pending;

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.pending).toBe(false);
    expect(manager.getSnapshot('sample').messages).toEqual([]);
  });

  it('emits update events for the user message (pending) and the assistant reply', async () => {
    const acp = createFakeAcp({ chunks: ['pong'] });
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    const events: HermesUpdate[] = [];
    manager.onUpdate((event) => events.push(event));

    await manager.send('sample', 'ping');

    expect(events[0]).toMatchObject({
      projectId: 'sample',
      snapshot: expect.objectContaining({ pending: true })
    });
    expect(events.at(-1)).toMatchObject({
      projectId: 'sample',
      snapshot: expect.objectContaining({ pending: false })
    });
    expect(events.at(-1)?.snapshot.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'pong' });
  });

  it('warmup() resumes via loadSession and captures history replay before the first send', async () => {
    const acp = createFakeAcp({ chunks: ['ok'] });
    const allocations: { projectId: string; acpSessionId: string }[] = [];
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } },
      resumeAcpSessionIds: { sample: 'sess-existing' },
      onSessionAllocated: (projectId, acpSessionId) =>
        allocations.push({ projectId, acpSessionId })
    });

    const warmupPromise = manager.warmup('sample');
    await new Promise((resolve) => setTimeout(resolve, 0));
    acp.emitAmbient('sess-existing', { kind: 'user_message_chunk', text: 'old question' });
    acp.emitAmbient('sess-existing', { kind: 'agent_message_chunk', text: 'old answer' });
    await warmupPromise;
    const snapshot = await manager.send('sample', 'hi after restart');

    expect(acp.loadSessionCalls).toEqual([{ cwd: '/repos/sample', sessionId: 'sess-existing' }]);
    expect(acp.newSessionCalls).toEqual([]);
    expect(allocations).toEqual([{ projectId: 'sample', acpSessionId: 'sess-existing' }]);
    expect(acp.promptCalls[0]).toMatchObject({ sessionId: 'sess-existing', text: 'hi after restart' });
    expect(snapshot.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:old question',
      'assistant:old answer',
      'user:hi after restart',
      'assistant:ok'
    ]);
  });

  it('emits onSessionAllocated on first send so callers can persist the new sessionId', async () => {
    const acp = createFakeAcp({ chunks: ['ok'] });
    const allocations: { projectId: string; acpSessionId: string }[] = [];
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } },
      onSessionAllocated: (projectId, acpSessionId) =>
        allocations.push({ projectId, acpSessionId })
    });

    await manager.send('sample', 'q');
    expect(allocations).toEqual([{ projectId: 'sample', acpSessionId: 'acp-session-1' }]);
  });

  it('decodes tool_call session updates into the assistant message toolCalls', async () => {
    const acp = createFakeAcp();
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    let releasePrompt: () => void = () => undefined;
    acp.queueReply({
      delay: () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
        }),
      chunks: ['done'],
      stopReason: 'end_turn'
    });

    const sendPromise = manager.send('sample', 'do thing');
    // Let send() set up the prompt callbacks before we deliver events.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callbacks = acp.promptCalls[acp.promptCalls.length - 1]?.callbacks;
    callbacks?.onUpdate?.({
      kind: 'tool_call_start',
      toolCall: {
        toolCallId: 'tc-1',
        title: 'Reading config.yaml',
        kind: 'read',
        status: 'pending'
      }
    });
    callbacks?.onUpdate?.({
      kind: 'tool_call_progress',
      toolCall: { toolCallId: 'tc-1', status: 'completed' }
    });
    releasePrompt();
    const snapshot = await sendPromise;

    const assistant = snapshot.messages.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls).toEqual([
      expect.objectContaining({ id: 'tc-1', title: 'Reading config.yaml', kind: 'read', status: 'completed' })
    ]);
  });

  it('forwards image attachments to acp.prompt and stores them on the user message snapshot', async () => {
    const acp = createFakeAcp({ chunks: ['noted'] });
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    const snapshot = await manager.send('sample', 'check this screenshot', {
      images: [
        { id: 'img-1', data: 'AAAA', mimeType: 'image/png', name: 'screen.png' }
      ]
    });

    expect(acp.promptCalls[0]?.options).toEqual({
      images: [{ data: 'AAAA', mimeType: 'image/png', uri: undefined }],
      resources: []
    });
    const userMessage = snapshot.messages.find((m) => m.role === 'user');
    expect(userMessage?.images).toEqual([
      expect.objectContaining({ id: 'img-1', data: 'AAAA', mimeType: 'image/png', name: 'screen.png' })
    ]);
  });

  it('drops attachments missing data or non-image mimeType before reaching the wire', async () => {
    const acp = createFakeAcp({ chunks: ['ok'] });
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    await manager.send('sample', 'q', {
      images: [
        { data: '', mimeType: 'image/png' },
        { data: 'abc', mimeType: '' as unknown as string },
        { data: 'valid', mimeType: 'image/jpeg' }
      ]
    });

    expect(acp.promptCalls[0]?.options).toEqual({
      images: [{ data: 'valid', mimeType: 'image/jpeg', uri: undefined }],
      resources: []
    });
  });

  it('serializes text resources as EmbeddedResourceContentBlock entries', async () => {
    const acp = createFakeAcp({ chunks: ['ok'] });
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    await manager.send('sample', 'check this', {
      resources: [
        {
          id: 'r-1',
          uri: 'file:///tmp/notes.md',
          mimeType: 'text/markdown',
          name: 'notes.md',
          text: '# Notes\n\nhello'
        }
      ]
    });

    expect(acp.promptCalls[0]?.options?.resources).toEqual([
      expect.objectContaining({
        uri: 'file:///tmp/notes.md',
        mimeType: 'text/markdown',
        text: '# Notes\n\nhello'
      })
    ]);
  });

  it('marks pending prompts as errored when the ACP process exits unexpectedly', async () => {
    const acp = createFakeAcp();
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });
    // Start a turn that never resolves so the snapshot stays pending.
    let releasePrompt: () => void = () => undefined;
    acp.queueReply({ delay: () => new Promise<void>((r) => { releasePrompt = r; }), chunks: ['ok'] });
    const sendPromise = manager.send('sample', 'hi');
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.getSnapshot('sample').pending).toBe(true);

    acp.emitLifecycle('exit', { code: 137, signal: null, expected: false });
    expect(manager.getSnapshot('sample')).toMatchObject({
      pending: false,
      error: expect.stringContaining('Hermes ACP process restarted')
    });

    releasePrompt();
    await sendPromise;
  });

  it('rehydrates known sessions via loadSession after the ACP process restarts', async () => {
    const acp = createFakeAcp({ chunks: ['ok'] });
    const manager = new HermesSessionManager({
      acp,
      projectContexts: { sample: { name: 'Sample', cwd: '/repos/sample' } }
    });

    await manager.send('sample', 'hi');
    expect(acp.newSessionCalls).toHaveLength(1);

    acp.emitLifecycle('exit', { code: 1, signal: null, expected: false });
    acp.emitLifecycle('restarted');
    await new Promise((r) => setTimeout(r, 0));

    expect(acp.loadSessionCalls).toEqual([
      { cwd: '/repos/sample', sessionId: 'acp-session-1' }
    ]);
  });

  it('falls back to process.cwd() when no project context is configured', async () => {
    const acp = createFakeAcp({ chunks: ['ok'] });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/fallback/cwd');
    const manager = new HermesSessionManager({ acp });

    await manager.send('unknown-project', 'q');

    expect(acp.newSessionCalls).toEqual([{ cwd: '/fallback/cwd' }]);
    cwdSpy.mockRestore();
  });
});
