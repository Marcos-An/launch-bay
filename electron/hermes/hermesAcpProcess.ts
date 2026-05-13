import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const ACP_PROTOCOL_VERSION = 1;

export type AcpTextContentBlock = { type: 'text'; text: string };

export type AcpImageContentBlock = {
  type: 'image';
  /** Base64-encoded image payload (no `data:` prefix). */
  data: string;
  mimeType: string;
  uri?: string;
};

export type AcpImageAttachment = {
  data: string;
  mimeType: string;
  uri?: string;
};

export type AcpResourceAttachment = {
  uri: string;
  mimeType?: string;
  /** Inline UTF-8 text payload — preferred for source code, markdown, JSON. */
  text?: string;
  /** Base64-encoded payload for binary files (PDF, etc.). */
  blob?: string;
};

export type AcpEmbeddedResourceContentBlock = {
  type: 'resource';
  resource:
    | { uri: string; mimeType?: string; text: string }
    | { uri: string; mimeType?: string; blob: string };
};

export type AcpPromptOptions = {
  images?: AcpImageAttachment[];
  resources?: AcpResourceAttachment[];
};

export type AcpUsageUpdate = {
  used: number;
  size: number;
  cost?: { input?: number; output?: number; total?: number; currency?: string };
};

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallLocation = { path: string; line?: number };

export type AcpToolCallDiff = {
  path: string;
  oldText?: string;
  newText: string;
};

export type AcpToolCallStart = {
  toolCallId: string;
  title: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: AcpToolCallLocation[];
  diffs?: AcpToolCallDiff[];
};

export type AcpToolCallProgress = {
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: AcpToolCallLocation[];
  diffs?: AcpToolCallDiff[];
};

export type AcpAvailableCommand = {
  name: string;
  description: string;
};

export type AcpPlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export type AcpPlanEntry = {
  content: string;
  status?: AcpPlanEntryStatus;
  priority?: 'low' | 'medium' | 'high';
};

export type AcpSessionUpdateEvent =
  | { kind: 'agent_message_chunk'; text: string }
  | { kind: 'agent_thought_chunk'; text: string }
  | { kind: 'user_message_chunk'; text: string }
  | { kind: 'usage_update'; usage: AcpUsageUpdate }
  | { kind: 'tool_call_start'; toolCall: AcpToolCallStart }
  | { kind: 'tool_call_progress'; toolCall: AcpToolCallProgress }
  | { kind: 'available_commands_update'; commands: AcpAvailableCommand[] }
  | { kind: 'plan'; entries: AcpPlanEntry[] }
  | { kind: 'other'; sessionUpdate: string; raw: unknown };

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickStatus(value: unknown): AcpToolCallStatus | undefined {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed') {
    return value;
  }
  return undefined;
}

function pickKind(value: unknown): AcpToolKind | undefined {
  const allowed: AcpToolKind[] = [
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other'
  ];
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as AcpToolKind) : undefined;
}

function pickDiffs(value: unknown): AcpToolCallDiff[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AcpToolCallDiff[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'diff') continue;
    const path = pickString(record.path);
    const newText = typeof record.newText === 'string' ? record.newText : undefined;
    if (!path || newText === undefined) continue;
    const oldText = typeof record.oldText === 'string' ? record.oldText : undefined;
    out.push(oldText === undefined ? { path, newText } : { path, oldText, newText });
  }
  return out.length > 0 ? out : undefined;
}

function pickLocations(value: unknown): AcpToolCallLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AcpToolCallLocation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const path = pickString(record.path);
    if (!path) continue;
    const line = typeof record.line === 'number' && Number.isFinite(record.line) ? record.line : undefined;
    out.push(line === undefined ? { path } : { path, line });
  }
  return out.length > 0 ? out : undefined;
}

export type AcpPromptResult = {
  stopReason: string;
  usage?: AcpUsageUpdate;
};

export type AcpPromptCallbacks = {
  onUpdate?: (event: AcpSessionUpdateEvent) => void;
};

export type HermesAcpProcessOptions = {
  command?: string;
  args?: string[];
  spawnFn?: typeof spawn;
  acceptHooks?: boolean;
  /** Capabilities to advertise. Defaults to fs=false, terminal=false. */
  clientCapabilities?: Record<string, unknown>;
  /** Time in ms to wait for `initialize` to respond before failing. */
  initializeTimeoutMs?: number;
  /** Logger for stderr / unexpected events. Defaults to console.error. */
  logger?: (message: string, meta?: unknown) => void;
  /**
   * Optional resolver that returns the absolute path to the `hermes` binary.
   * Called once before the first spawn. Necessary in packaged `.app` builds
   * where the GUI process does not inherit the user's shell PATH.
   * If it throws or returns undefined, the configured `command` is used as-is.
   */
  resolveBin?: () => Promise<string | undefined>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
};

type AmbientSessionListener = (event: AcpSessionUpdateEvent) => void;

type SessionState = {
  callbacks: AcpPromptCallbacks | undefined;
  subscribers: Set<AmbientSessionListener>;
  lastUsage: AcpUsageUpdate | undefined;
};

const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
const RESTART_WINDOW_MS = 60_000;
const RESTART_MAX_ATTEMPTS = 3;

function defaultClientCapabilities(): Record<string, unknown> {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false
  };
}

function pickAllowOption(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    if (!option || typeof option !== 'object') continue;
    const kind = (option as Record<string, unknown>).kind;
    if (kind === 'allow_once' || kind === 'allow_always') {
      const id = (option as Record<string, unknown>).optionId;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return undefined;
}

function decodeSessionUpdate(update: unknown): AcpSessionUpdateEvent {
  const obj = (update ?? {}) as Record<string, unknown>;
  const sessionUpdate = String(obj.sessionUpdate ?? '');
  const content = obj.content as Record<string, unknown> | undefined;
  const text = typeof content?.text === 'string' ? content.text : '';

  switch (sessionUpdate) {
    case 'agent_message_chunk':
      return { kind: 'agent_message_chunk', text };
    case 'agent_thought_chunk':
      return { kind: 'agent_thought_chunk', text };
    case 'user_message_chunk':
      return { kind: 'user_message_chunk', text };
    case 'usage_update': {
      const used = Number(obj.used);
      const size = Number(obj.size);
      const cost = obj.cost as AcpUsageUpdate['cost'] | undefined;
      return {
        kind: 'usage_update',
        usage: {
          used: Number.isFinite(used) ? used : 0,
          size: Number.isFinite(size) ? size : 0,
          cost
        }
      };
    }
    case 'tool_call': {
      const toolCallId = pickString(obj.toolCallId) ?? '';
      const title = pickString(obj.title) ?? pickString(obj.kind) ?? 'tool';
      return {
        kind: 'tool_call_start',
        toolCall: {
          toolCallId,
          title,
          kind: pickKind(obj.kind),
          status: pickStatus(obj.status) ?? 'pending',
          rawInput: obj.rawInput,
          rawOutput: obj.rawOutput,
          locations: pickLocations(obj.locations),
          diffs: pickDiffs(obj.content)
        }
      };
    }
    case 'tool_call_update': {
      const toolCallId = pickString(obj.toolCallId) ?? '';
      return {
        kind: 'tool_call_progress',
        toolCall: {
          toolCallId,
          title: pickString(obj.title),
          kind: pickKind(obj.kind),
          status: pickStatus(obj.status),
          rawInput: obj.rawInput,
          rawOutput: obj.rawOutput,
          locations: pickLocations(obj.locations),
          diffs: pickDiffs(obj.content)
        }
      };
    }
    case 'available_commands_update': {
      const raw = obj.availableCommands;
      const commands: AcpAvailableCommand[] = [];
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!entry || typeof entry !== 'object') continue;
          const name = pickString((entry as Record<string, unknown>).name);
          const description = pickString((entry as Record<string, unknown>).description) ?? '';
          if (name) commands.push({ name, description });
        }
      }
      return { kind: 'available_commands_update', commands };
    }
    case 'plan': {
      const raw = obj.entries;
      const entries: AcpPlanEntry[] = [];
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!entry || typeof entry !== 'object') continue;
          const record = entry as Record<string, unknown>;
          const content = pickString(record.content);
          if (!content) continue;
          const status =
            record.status === 'pending' || record.status === 'in_progress' || record.status === 'completed'
              ? (record.status as AcpPlanEntryStatus)
              : undefined;
          const priority =
            record.priority === 'low' || record.priority === 'medium' || record.priority === 'high'
              ? (record.priority as 'low' | 'medium' | 'high')
              : undefined;
          entries.push({ content, status, priority });
        }
      }
      return { kind: 'plan', entries };
    }
    default:
      return { kind: 'other', sessionUpdate, raw: update };
  }
}

export type AcpSessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
};

export type AcpApprovalMode = 'auto' | 'manual';

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

export type AcpPermissionRequiredEvent = {
  requestId: string;
  sessionId: string;
  toolCallId?: string;
  toolTitle?: string;
  toolKind?: AcpToolKind;
  toolRawInput?: unknown;
  toolLocations?: AcpToolCallLocation[];
  toolDiffs?: AcpToolCallDiff[];
  options: AcpPermissionOption[];
};

export interface HermesAcpProcessLike {
  start(): Promise<void>;
  newSession(params: { cwd: string }): Promise<string>;
  loadSession(params: { cwd: string; sessionId: string }): Promise<void>;
  listSessions(params?: { cwd?: string; cursor?: string }): Promise<{
    sessions: AcpSessionInfo[];
    nextCursor?: string;
  }>;
  prompt(
    sessionId: string,
    text: string,
    callbacks?: AcpPromptCallbacks,
    options?: AcpPromptOptions
  ): Promise<AcpPromptResult>;
  subscribeSession(sessionId: string, listener: AmbientSessionListener): () => void;
  cancel(sessionId: string): void;
  kill(): void;
  isRunning(): boolean;
  setApprovalMode(mode: AcpApprovalMode): void;
  respondToPermission(requestId: string, optionId: string | null): void;
  on(event: 'exit', listener: (reason: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void): void;
  on(event: 'restarted', listener: () => void): void;
  on(event: 'restart-failed', listener: (reason: { attempts: number }) => void): void;
  on(event: 'permission-required', listener: (payload: AcpPermissionRequiredEvent) => void): void;
}

/**
 * Wraps a `hermes acp` subprocess and exposes a typed Promise-based API
 * over its JSON-RPC stdio channel. One process can host many sessions —
 * each `newSession({cwd})` returns an isolated sessionId.
 */
export class HermesAcpProcess extends EventEmitter implements HermesAcpProcessLike {
  private command: string;
  private readonly args: string[];
  private readonly spawnFn: typeof spawn;
  private readonly clientCapabilities: Record<string, unknown>;
  private readonly initializeTimeoutMs: number;
  private readonly logger: (message: string, meta?: unknown) => void;
  private readonly resolveBin: (() => Promise<string | undefined>) | undefined;
  private binResolved = false;

  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, SessionState>();
  private startPromise: Promise<void> | undefined;
  private started = false;
  private killed = false;
  private restartAttempts: number[] = [];
  private approvalMode: AcpApprovalMode = 'auto';
  private readonly pendingPermissions = new Map<string, { id: unknown }>();
  private nextPermissionRequestId = 1;

  constructor(options: HermesAcpProcessOptions = {}) {
    super();
    this.command = options.command ?? 'hermes';
    const baseArgs = options.args ?? ['acp'];
    const extraArgs = options.acceptHooks === false ? [] : ['--accept-hooks'];
    this.args = [...baseArgs, ...extraArgs.filter((flag) => !baseArgs.includes(flag))];
    this.spawnFn = options.spawnFn ?? spawn;
    this.clientCapabilities = options.clientCapabilities ?? defaultClientCapabilities();
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.logger = options.logger ?? ((message, meta) => console.error('[hermes-acp]', message, meta ?? ''));
    this.resolveBin = options.resolveBin;
    // Skip resolveBin when the caller already passed an absolute path.
    if (this.command.startsWith('/')) this.binResolved = true;
  }

  isRunning() {
    return this.started && this.child !== undefined && this.child.exitCode === null;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnAndInitialize().catch((error) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  async newSession({ cwd }: { cwd: string }): Promise<string> {
    if (!cwd) throw new Error('HermesAcpProcess.newSession requires an absolute cwd');
    await this.start();
    const result = (await this.request('session/new', { cwd, mcpServers: [] })) as { sessionId?: string };
    const sessionId = result?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Hermes did not return a sessionId on session/new');
    }
    this.ensureSessionState(sessionId);
    return sessionId;
  }

  async loadSession({ cwd, sessionId }: { cwd: string; sessionId: string }): Promise<void> {
    if (!cwd) throw new Error('HermesAcpProcess.loadSession requires an absolute cwd');
    if (!sessionId) throw new Error('HermesAcpProcess.loadSession requires a sessionId');
    await this.start();
    // Create the local state BEFORE the request so any session/update events
    // emitted during history replay reach already-registered subscribers.
    this.ensureSessionState(sessionId);
    await this.request('session/load', { cwd, sessionId, mcpServers: [] });
  }

  async listSessions(params: { cwd?: string; cursor?: string } = {}): Promise<{
    sessions: AcpSessionInfo[];
    nextCursor?: string;
  }> {
    await this.start();
    const payload: Record<string, unknown> = {};
    if (params.cwd) payload.cwd = params.cwd;
    if (params.cursor) payload.cursor = params.cursor;
    const result = (await this.request('session/list', payload)) as {
      sessions?: unknown;
      nextCursor?: string;
    };
    const sessions: AcpSessionInfo[] = [];
    if (Array.isArray(result?.sessions)) {
      for (const entry of result.sessions) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const sessionId = pickString(record.sessionId);
        const cwd = pickString(record.cwd);
        if (!sessionId || !cwd) continue;
        sessions.push({
          sessionId,
          cwd,
          title: pickString(record.title),
          updatedAt: pickString(record.updatedAt)
        });
      }
    }
    const nextCursor = pickString(result?.nextCursor);
    return nextCursor ? { sessions, nextCursor } : { sessions };
  }

  subscribeSession(sessionId: string, listener: AmbientSessionListener): () => void {
    const state = this.ensureSessionState(sessionId);
    state.subscribers.add(listener);
    return () => {
      state.subscribers.delete(listener);
    };
  }

  private ensureSessionState(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { callbacks: undefined, subscribers: new Set(), lastUsage: undefined };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  async prompt(
    sessionId: string,
    text: string,
    callbacks: AcpPromptCallbacks = {},
    options: AcpPromptOptions = {}
  ): Promise<AcpPromptResult> {
    await this.start();
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown ACP session: ${sessionId}`);
    state.callbacks = callbacks;
    try {
      const promptBlocks: (AcpTextContentBlock | AcpImageContentBlock | AcpEmbeddedResourceContentBlock)[] = [];
      if (text.length > 0) promptBlocks.push({ type: 'text', text });
      for (const image of options.images ?? []) {
        if (!image.data || !image.mimeType) continue;
        const block: AcpImageContentBlock = {
          type: 'image',
          data: image.data,
          mimeType: image.mimeType
        };
        if (image.uri) block.uri = image.uri;
        promptBlocks.push(block);
      }
      for (const resource of options.resources ?? []) {
        if (!resource.uri) continue;
        if (typeof resource.text === 'string') {
          promptBlocks.push({
            type: 'resource',
            resource: {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text: resource.text
            }
          });
        } else if (typeof resource.blob === 'string' && resource.blob.length > 0) {
          promptBlocks.push({
            type: 'resource',
            resource: {
              uri: resource.uri,
              mimeType: resource.mimeType,
              blob: resource.blob
            }
          });
        }
      }
      // ACP requires at least one block — fall back to an empty text block
      // when the caller sends only attachments with no caption, so the
      // request doesn't violate the schema.
      if (promptBlocks.length === 0) {
        promptBlocks.push({ type: 'text', text: '' });
      }
      const result = (await this.request('session/prompt', {
        sessionId,
        prompt: promptBlocks
      })) as { stopReason?: string };
      return {
        stopReason: typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn',
        usage: state.lastUsage
      };
    } finally {
      state.callbacks = undefined;
    }
  }

  cancel(sessionId: string): void {
    if (!this.isRunning()) return;
    this.sendNotification('session/cancel', { sessionId });
  }

  setApprovalMode(mode: AcpApprovalMode): void {
    this.approvalMode = mode;
    if (mode === 'auto') {
      // Cancel any still-open manual requests so the agent doesn't stall once
      // the user disables manual mode mid-flight. Subsequent permission
      // requests are auto-allowed.
      for (const [requestId] of [...this.pendingPermissions]) {
        this.respondToPermission(requestId, null);
      }
    }
  }

  respondToPermission(requestId: string, optionId: string | null): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    if (optionId === null) {
      this.sendResponse(pending.id, { outcome: { outcome: 'cancelled' } });
    } else {
      this.sendResponse(pending.id, { outcome: { outcome: 'selected', optionId } });
    }
  }

  kill(): void {
    this.killed = true;
    this.startPromise = undefined;
    this.started = false;
    const child = this.child;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Hermes ACP process killed'));
    }
    this.pending.clear();
    this.sessions.clear();
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    if (!this.binResolved && this.resolveBin) {
      try {
        const resolved = await this.resolveBin();
        if (resolved && resolved.length > 0) this.command = resolved;
      } catch (error) {
        this.logger('resolveBin failed', error);
      } finally {
        this.binResolved = true;
      }
    }
    const child = this.spawnFn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdoutChunk(chunk));
    child.stderr.on('data', (chunk: string) => this.handleStderrChunk(chunk));
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.on('error', (error) => this.logger('process error', error));

    const initializeResult = await this.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: this.clientCapabilities,
        clientInfo: { name: 'launch-bay', version: '0.1.0' }
      },
      this.initializeTimeoutMs
    );
    this.started = true;
    this.emit('initialized', initializeResult);
  }

  private handleStdoutChunk(chunk: string) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (rawLine.length > 0) this.handleLine(rawLine);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleStderrChunk(chunk: string) {
    this.stderrBuffer += chunk;
    if (this.stderrBuffer.length > 64_000) {
      this.stderrBuffer = this.stderrBuffer.slice(-32_000);
    }
  }

  private handleLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.logger('Failed to parse ACP line', { line, error });
      return;
    }

    if (typeof message.id !== 'undefined' && (message.result !== undefined || message.error !== undefined)) {
      this.handleResponse(message);
      return;
    }
    if (typeof message.method === 'string') {
      this.handleIncomingRequest(message);
      return;
    }
    this.logger('Ignored ACP message', message);
  }

  private handleResponse(message: Record<string, unknown>) {
    const id = message.id;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) {
      const error = message.error as Record<string, unknown>;
      const code = error.code;
      const text = typeof error.message === 'string' ? error.message : 'ACP error';
      pending.reject(new Error(`${text}${typeof code === 'number' ? ` (code ${code})` : ''}`));
      return;
    }
    pending.resolve(message.result);
  }

  private handleIncomingRequest(message: Record<string, unknown>) {
    const method = message.method as string;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const id = message.id;

    if (method === 'session/update') {
      const sessionId = String(params.sessionId ?? '');
      const update = params.update;
      const state = this.sessions.get(sessionId);
      if (!state) return;
      const decoded = decodeSessionUpdate(update);
      if (decoded.kind === 'usage_update') state.lastUsage = decoded.usage;
      // Prompt callbacks take precedence — when a turn is in flight, only the
      // prompt's owner observes the stream, so ambient subscribers don't see
      // double-counted chunks during streaming. Ambient subscribers exist to
      // observe history replay (after session/load) and any out-of-band
      // notifications between turns.
      if (state.callbacks?.onUpdate) {
        state.callbacks.onUpdate(decoded);
      } else {
        for (const subscriber of state.subscribers) subscriber(decoded);
      }
      return;
    }

    if (method === 'session/request_permission' && typeof id !== 'undefined') {
      const optionsArray = Array.isArray(params.options) ? params.options : [];
      if (this.approvalMode === 'auto') {
        const optionId = pickAllowOption(optionsArray);
        if (optionId) {
          this.sendResponse(id, { outcome: { outcome: 'selected', optionId } });
        } else {
          this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
        }
        return;
      }
      const requestId = `perm-${this.nextPermissionRequestId++}`;
      this.pendingPermissions.set(requestId, { id });
      const options: AcpPermissionOption[] = [];
      for (const entry of optionsArray) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const optionId = pickString(record.optionId);
        const name = pickString(record.name);
        const kind = record.kind;
        if (!optionId || !name) continue;
        if (kind !== 'allow_once' && kind !== 'allow_always' && kind !== 'reject_once' && kind !== 'reject_always') {
          continue;
        }
        options.push({ optionId, name, kind });
      }
      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
      this.emit('permission-required', {
        requestId,
        sessionId: String(params.sessionId ?? ''),
        toolCallId: pickString(toolCall.toolCallId),
        toolTitle: pickString(toolCall.title),
        toolKind: pickKind(toolCall.kind),
        toolRawInput: toolCall.rawInput,
        toolLocations: pickLocations(toolCall.locations),
        toolDiffs: pickDiffs(toolCall.content),
        options
      });
      return;
    }

    if (typeof id !== 'undefined') {
      // We declared fs/terminal capabilities false; any other client-direction
      // request is one we don't support. Reply with JSON-RPC method-not-found.
      this.sendError(id, -32601, `Launch Bay does not implement ${method}`);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null) {
    const wasStarted = this.started;
    const expected = this.killed;
    this.started = false;
    this.startPromise = undefined;
    this.child = undefined;
    const error = new Error(
      `Hermes ACP process exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.sessions.clear();
    if (wasStarted || this.stderrBuffer.trim().length > 0) {
      this.logger('Hermes ACP exited', { code, signal, stderr: this.stderrBuffer.trim() });
    }
    this.emit('exit', { code, signal, expected });

    if (!expected && wasStarted) {
      this.scheduleRestart();
    }
  }

  private scheduleRestart() {
    const now = Date.now();
    this.restartAttempts = this.restartAttempts.filter((stamp) => now - stamp < RESTART_WINDOW_MS);
    if (this.restartAttempts.length >= RESTART_MAX_ATTEMPTS) {
      this.logger('Hermes ACP exceeded restart budget', { attempts: this.restartAttempts });
      this.emit('restart-failed', { attempts: this.restartAttempts.length });
      return;
    }
    this.restartAttempts.push(now);
    // Small backoff so a fast crash loop doesn't pin the CPU.
    const delay = Math.min(200 * this.restartAttempts.length, 2_000);
    setTimeout(() => {
      if (this.killed) return;
      this.start()
        .then(() => this.emit('restarted'))
        .catch((restartError) => {
          this.logger('Hermes ACP restart failed', restartError);
          this.scheduleRestart();
        });
    }, delay);
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) {
        reject(new Error(`Hermes ACP process is not running (request: ${method})`));
        return;
      }
      const id = this.nextRequestId++;
      let timer: NodeJS.Timeout | undefined;
      const wrappedResolve = (value: unknown) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      };
      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, method });
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`ACP request ${method} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.write(payload);
    });
  }

  private sendNotification(method: string, params: unknown) {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.write(payload);
  }

  private sendResponse(id: unknown, result: unknown) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    this.write(payload);
  }

  private sendError(id: unknown, code: number, message: string) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    this.write(payload);
  }

  private write(payload: string) {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.write(`${payload}\n`);
  }
}
