import type {
  AcpAvailableCommand,
  AcpImageAttachment,
  AcpPlanEntry,
  AcpPromptResult,
  AcpResourceAttachment,
  AcpSessionUpdateEvent,
  AcpToolCallDiff,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
  AcpUsageUpdate,
  HermesAcpProcessLike
} from './hermesAcpProcess.js';

export type HermesMessageRole = 'user' | 'assistant';

export type HermesToolCallStatus = AcpToolCallStatus;
export type HermesToolKind = AcpToolKind;
export type HermesToolCallLocation = AcpToolCallLocation;

export type HermesToolCallDiff = AcpToolCallDiff;

export type HermesToolCall = {
  id: string;
  title: string;
  kind?: HermesToolKind;
  status: HermesToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: HermesToolCallLocation[];
  diffs?: HermesToolCallDiff[];
};

export type HermesImageAttachment = {
  id?: string;
  /** Base64-encoded image payload (no `data:` prefix). */
  data: string;
  mimeType: string;
  /** Local file name when picked from disk; absent for pasted clipboard images. */
  name?: string;
  /** Optional URI hint, propagated to ACP if set. */
  uri?: string;
};

export type HermesResourceAttachment = {
  id?: string;
  /** Stable identifier for the resource — e.g. file://<absolute path>. */
  uri: string;
  mimeType?: string;
  name?: string;
  /** Inline text content. Preferred for markdown, code, configs. */
  text?: string;
  /** Base64-encoded payload for binary files (PDFs, etc.). */
  blob?: string;
  /** Source file size in bytes for UI display, if known. */
  sizeBytes?: number;
};

export type HermesSendOptions = {
  images?: HermesImageAttachment[];
  resources?: HermesResourceAttachment[];
};

export type HermesMessage = {
  id: string;
  role: HermesMessageRole;
  text: string;
  toolCalls?: HermesToolCall[];
  images?: HermesImageAttachment[];
  resources?: HermesResourceAttachment[];
};

export type HermesContextUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextLength?: number;
  percent?: number;
};

export type HermesAvailableCommand = AcpAvailableCommand;
export type HermesPlanEntry = AcpPlanEntry;

export type HermesSnapshot = {
  messages: HermesMessage[];
  pending: boolean;
  error?: string;
  contextUsage?: HermesContextUsage;
  availableCommands?: HermesAvailableCommand[];
  plan?: HermesPlanEntry[];
};

export type HermesUpdate = {
  projectId: string;
  snapshot: HermesSnapshot;
};

type HermesListener = (event: HermesUpdate) => void;

export type HermesProjectContext = {
  name: string;
  cwd: string;
};

export type HermesSessionManagerOptions = {
  acp: HermesAcpProcessLike;
  contextLength?: number;
  projectContexts?: Record<string, HermesProjectContext>;
  /**
   * Pre-existing ACP session ids to resume on first send per project.
   * When set, the manager calls `loadSession` and captures the history
   * replay events into its snapshot instead of allocating a new session.
   */
  resumeAcpSessionIds?: Record<string, string>;
  /**
   * Notified whenever an ACP sessionId is allocated or restored for a
   * given projectId. Callers persist this mapping to be passed back as
   * `resumeAcpSessionIds` on the next process start.
   */
  onSessionAllocated?: (projectId: string, acpSessionId: string) => void;
};

const EMPTY_SNAPSHOT: HermesSnapshot = { messages: [], pending: false };

let nextId = 0;
function makeId(prefix: string) {
  nextId += 1;
  return `${prefix}-${Date.now()}-${nextId}`;
}

function usageFromAcp(usage: AcpUsageUpdate | undefined, contextLength: number | undefined): HermesContextUsage | undefined {
  if (!usage) return undefined;
  const totalTokens = Number.isFinite(usage.used) ? usage.used : 0;
  const size = Number.isFinite(usage.size) ? usage.size : 0;
  const resolvedContextLength = contextLength && contextLength > 0 ? contextLength : size > 0 ? size : undefined;
  const result: HermesContextUsage = {
    promptTokens: totalTokens,
    completionTokens: 0,
    totalTokens
  };
  if (resolvedContextLength && resolvedContextLength > 0) {
    result.contextLength = resolvedContextLength;
    result.percent = Math.min(100, Math.round((totalTokens / resolvedContextLength) * 1000) / 10);
  }
  return result;
}

export class HermesSessionManager {
  private readonly acp: HermesAcpProcessLike;
  private readonly contextLength: number | undefined;
  private readonly projectContexts: Record<string, HermesProjectContext>;
  private readonly resumeAcpSessionIds: Record<string, string>;
  private readonly onSessionAllocated: ((projectId: string, acpSessionId: string) => void) | undefined;
  private readonly snapshots = new Map<string, HermesSnapshot>();
  private readonly generations = new Map<string, number>();
  private readonly sessionIds = new Map<string, string>();
  private readonly sessionPromises = new Map<string, Promise<string>>();
  private readonly ambientUnsubscribers = new Map<string, () => void>();
  private readonly listeners = new Set<HermesListener>();

  constructor(options: HermesSessionManagerOptions) {
    this.acp = options.acp;
    this.contextLength = options.contextLength && options.contextLength > 0 ? options.contextLength : undefined;
    this.projectContexts = options.projectContexts ?? {};
    this.resumeAcpSessionIds = options.resumeAcpSessionIds ?? {};
    this.onSessionAllocated = options.onSessionAllocated;

    // Recover from crashes of the Hermes Python process: a hermes-acp exit
    // tears down all in-memory sessions on the agent side, so we surface an
    // error on any pending turn, then re-attach + load_session once the
    // process auto-restarts. Sessions persist server-side in ~/.hermes/state.db.
    this.acp.on('exit', (reason) => {
      if (!reason.expected) this.handleProcessLost();
    });
    this.acp.on('restarted', () => {
      void this.rehydrateSessions();
    });
  }

  private handleProcessLost() {
    // Ambient unsubscribe references point at a Set that no longer exists,
    // but we still want the local map cleared so rehydrate can re-attach.
    this.ambientUnsubscribers.clear();
    for (const projectId of this.sessionIds.keys()) {
      const snap = this.snapshots.get(projectId);
      if (snap?.pending) {
        this.set(projectId, {
          ...snap,
          pending: false,
          error: 'Hermes ACP process restarted — please retry'
        });
      }
    }
  }

  private async rehydrateSessions() {
    for (const [projectId, sessionId] of [...this.sessionIds.entries()]) {
      const context = this.projectContexts[projectId];
      const cwd = context?.cwd ?? process.cwd();
      try {
        this.attachAmbientListener(projectId, sessionId);
        await this.acp.loadSession({ cwd, sessionId });
      } catch {
        // Session no longer exists server-side — drop it so the next send
        // allocates a fresh one.
        this.releaseAmbient(projectId);
        this.sessionIds.delete(projectId);
        delete this.resumeAcpSessionIds[projectId];
      }
    }
  }

  onUpdate(listener: HermesListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(projectId: string): HermesSnapshot {
    return this.copy(this.snapshots.get(projectId) ?? EMPTY_SNAPSHOT);
  }

  /**
   * Drop the ACP session for this project so the next `send` starts a
   * fresh conversation. The Hermes side keeps the old session in its
   * SQLite store, but Launch Bay forgets it — calling code can call
   * `send` again to allocate a new one.
   */
  reset(projectId: string): HermesSnapshot {
    this.generations.set(projectId, (this.generations.get(projectId) ?? 0) + 1);
    const sessionId = this.sessionIds.get(projectId);
    if (sessionId) this.acp.cancel(sessionId);
    this.releaseAmbient(projectId);
    this.sessionIds.delete(projectId);
    this.sessionPromises.delete(projectId);
    delete this.resumeAcpSessionIds[projectId];
    this.snapshots.delete(projectId);
    return this.set(projectId, EMPTY_SNAPSHOT);
  }

  /**
   * Switch the project's active ACP session to a previously-existing one,
   * resetting local snapshot state and replaying its history via load_session.
   */
  async resume(projectId: string, acpSessionId: string): Promise<HermesSnapshot> {
    this.reset(projectId);
    this.resumeAcpSessionIds[projectId] = acpSessionId;
    await this.warmup(projectId);
    return this.getSnapshot(projectId);
  }

  /**
   * Cancel any in-flight prompt for this project. No-op when there is no
   * active session yet. Snapshot pending flag is left for the prompt's own
   * resolution path to flip.
   */
  cancel(projectId: string): void {
    const sessionId = this.sessionIds.get(projectId);
    if (sessionId) this.acp.cancel(sessionId);
  }

  /**
   * Eagerly allocate (or resume) the ACP session for a project. Useful at
   * startup so history replay lands before the user types their first
   * message, instead of being appended after the in-flight prompt.
   */
  async warmup(projectId: string): Promise<void> {
    try {
      await this.ensureSession(projectId);
    } catch {
      // Failures here are non-fatal — the next `send` will retry.
    }
  }

  /**
   * Stop receiving ambient updates for every project. Used by callers that
   * are tearing down the manager (e.g. closing a HermesInstance).
   */
  dispose() {
    for (const projectId of [...this.ambientUnsubscribers.keys()]) {
      this.releaseAmbient(projectId);
    }
  }

  private releaseAmbient(projectId: string) {
    const unsubscribe = this.ambientUnsubscribers.get(projectId);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // ignore — listener teardown should never crash the manager.
      }
      this.ambientUnsubscribers.delete(projectId);
    }
  }

  async send(projectId: string, text: string, options: HermesSendOptions = {}): Promise<HermesSnapshot> {
    const requestGeneration = this.generations.get(projectId) ?? 0;
    const images = (options.images ?? []).filter((image) => image.data && image.mimeType);
    const resources = (options.resources ?? []).filter(
      (resource) => resource.uri && (typeof resource.text === 'string' || typeof resource.blob === 'string')
    );
    const userMessage: HermesMessage = {
      id: makeId('u'),
      role: 'user',
      text,
      images: images.length > 0 ? images.map((image) => ({ ...image })) : undefined,
      resources: resources.length > 0 ? resources.map((resource) => ({ ...resource })) : undefined
    };
    const previous = this.snapshots.get(projectId) ?? EMPTY_SNAPSHOT;
    const assistantMessageId = makeId('a');
    this.set(projectId, {
      messages: [...previous.messages, userMessage, { id: assistantMessageId, role: 'assistant', text: '' }],
      pending: true,
      error: undefined,
      contextUsage: previous.contextUsage
    });

    let sessionId: string;
    try {
      sessionId = await this.ensureSession(projectId);
    } catch (error) {
      if (this.isStale(projectId, requestGeneration)) return this.getSnapshot(projectId);
      return this.failPrompt(projectId, assistantMessageId, error);
    }

    if (this.isStale(projectId, requestGeneration)) return this.getSnapshot(projectId);

    let assistantText = '';
    let latestUsage: AcpUsageUpdate | undefined;
    const toolCalls = new Map<string, HermesToolCall>();
    const toolCallOrder: string[] = [];
    const onUpdate = (event: AcpSessionUpdateEvent) => {
      if (this.isStale(projectId, requestGeneration)) return;
      if (event.kind === 'agent_message_chunk') {
        if (!event.text) return;
        assistantText += event.text;
        this.replaceAssistantMessage(projectId, assistantMessageId, assistantText, latestUsage, toolCalls, toolCallOrder);
        return;
      }
      if (event.kind === 'usage_update') {
        latestUsage = event.usage;
        this.replaceAssistantMessage(projectId, assistantMessageId, assistantText, latestUsage, toolCalls, toolCallOrder);
        return;
      }
      if (event.kind === 'tool_call_start') {
        const id = event.toolCall.toolCallId;
        if (!id) return;
        if (!toolCalls.has(id)) toolCallOrder.push(id);
        toolCalls.set(id, {
          id,
          title: event.toolCall.title,
          kind: event.toolCall.kind,
          status: event.toolCall.status ?? 'pending',
          rawInput: event.toolCall.rawInput,
          rawOutput: event.toolCall.rawOutput,
          locations: event.toolCall.locations,
          diffs: event.toolCall.diffs
        });
        this.replaceAssistantMessage(projectId, assistantMessageId, assistantText, latestUsage, toolCalls, toolCallOrder);
        return;
      }
      if (event.kind === 'available_commands_update') {
        const current = this.snapshots.get(projectId) ?? EMPTY_SNAPSHOT;
        this.set(projectId, { ...current, availableCommands: event.commands });
        return;
      }
      if (event.kind === 'plan') {
        const current = this.snapshots.get(projectId) ?? EMPTY_SNAPSHOT;
        this.set(projectId, { ...current, plan: event.entries });
        return;
      }
      if (event.kind === 'tool_call_progress') {
        const id = event.toolCall.toolCallId;
        if (!id) return;
        const existing = toolCalls.get(id);
        if (!existing) {
          toolCallOrder.push(id);
          toolCalls.set(id, {
            id,
            title: event.toolCall.title ?? 'tool',
            kind: event.toolCall.kind,
            status: event.toolCall.status ?? 'in_progress',
            rawInput: event.toolCall.rawInput,
            rawOutput: event.toolCall.rawOutput,
            locations: event.toolCall.locations
          });
        } else {
          toolCalls.set(id, {
            ...existing,
            title: event.toolCall.title ?? existing.title,
            kind: event.toolCall.kind ?? existing.kind,
            status: event.toolCall.status ?? existing.status,
            rawInput: event.toolCall.rawInput ?? existing.rawInput,
            rawOutput: event.toolCall.rawOutput ?? existing.rawOutput,
            locations: event.toolCall.locations ?? existing.locations,
            diffs: event.toolCall.diffs ?? existing.diffs
          });
        }
        this.replaceAssistantMessage(projectId, assistantMessageId, assistantText, latestUsage, toolCalls, toolCallOrder);
      }
    };

    let result: AcpPromptResult;
    try {
      const acpImages: AcpImageAttachment[] = images.map((image) => ({
        data: image.data,
        mimeType: image.mimeType,
        uri: image.uri
      }));
      const acpResources: AcpResourceAttachment[] = resources.map((resource) => ({
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.text,
        blob: resource.blob
      }));
      result = await this.acp.prompt(
        sessionId,
        text,
        { onUpdate },
        acpImages.length > 0 || acpResources.length > 0
          ? { images: acpImages, resources: acpResources }
          : undefined
      );
    } catch (error) {
      if (this.isStale(projectId, requestGeneration)) return this.getSnapshot(projectId);
      return this.failPrompt(projectId, assistantMessageId, error);
    }

    if (this.isStale(projectId, requestGeneration)) return this.getSnapshot(projectId);

    const finalUsage = result.usage ?? latestUsage;
    return this.replaceAssistantMessage(
      projectId,
      assistantMessageId,
      assistantText,
      finalUsage,
      toolCalls,
      toolCallOrder,
      false
    );
  }

  private async ensureSession(projectId: string): Promise<string> {
    const existing = this.sessionIds.get(projectId);
    if (existing) return existing;
    const inFlight = this.sessionPromises.get(projectId);
    if (inFlight) return inFlight;

    const context = this.projectContexts[projectId];
    const cwd = context?.cwd ?? process.cwd();
    const resumeId = this.resumeAcpSessionIds[projectId];

    const promise = (async () => {
      if (resumeId) {
        // Attach the ambient listener BEFORE load_session so the history
        // replay events emitted by Hermes after the response land in our
        // snapshot rather than being dropped.
        this.attachAmbientListener(projectId, resumeId);
        try {
          await this.acp.loadSession({ cwd, sessionId: resumeId });
        } catch (error) {
          // The persisted session no longer exists on the Hermes side —
          // fall back to a fresh session so the user can keep working.
          this.releaseAmbient(projectId);
          delete this.resumeAcpSessionIds[projectId];
          const fresh = await this.acp.newSession({ cwd });
          this.attachAmbientListener(projectId, fresh);
          this.finalizeSession(projectId, fresh);
          throw error;
        }
        this.finalizeSession(projectId, resumeId);
        return resumeId;
      }

      const sessionId = await this.acp.newSession({ cwd });
      this.attachAmbientListener(projectId, sessionId);
      this.finalizeSession(projectId, sessionId);
      return sessionId;
    })()
      .catch((error) => {
        this.sessionPromises.delete(projectId);
        throw error;
      });

    this.sessionPromises.set(projectId, promise);
    return promise;
  }

  private finalizeSession(projectId: string, sessionId: string) {
    this.sessionIds.set(projectId, sessionId);
    this.sessionPromises.delete(projectId);
    this.onSessionAllocated?.(projectId, sessionId);
  }

  private attachAmbientListener(projectId: string, sessionId: string) {
    this.releaseAmbient(projectId);
    const unsubscribe = this.acp.subscribeSession(sessionId, (event) =>
      this.applyAmbientEvent(projectId, event)
    );
    this.ambientUnsubscribers.set(projectId, unsubscribe);
  }

  /**
   * Apply a session/update notification that arrived OUTSIDE an in-flight
   * prompt — typically a history replay chunk after session/load, or an
   * out-of-band usage update. Each replay chunk represents a complete past
   * turn, so we append a fresh message rather than streaming into a tail.
   */
  private applyAmbientEvent(projectId: string, event: AcpSessionUpdateEvent) {
    const current = this.snapshots.get(projectId) ?? EMPTY_SNAPSHOT;
    if (event.kind === 'user_message_chunk') {
      if (!event.text) return;
      this.set(projectId, {
        ...current,
        messages: [...current.messages, { id: makeId('u'), role: 'user', text: event.text }]
      });
      return;
    }
    if (event.kind === 'agent_message_chunk') {
      if (!event.text) return;
      this.set(projectId, {
        ...current,
        messages: [...current.messages, { id: makeId('a'), role: 'assistant', text: event.text }]
      });
      return;
    }
    if (event.kind === 'usage_update') {
      const usage = usageFromAcp(event.usage, this.contextLength) ?? current.contextUsage;
      this.set(projectId, { ...current, contextUsage: usage });
      return;
    }
    if (event.kind === 'available_commands_update') {
      this.set(projectId, { ...current, availableCommands: event.commands });
      return;
    }
    if (event.kind === 'plan') {
      this.set(projectId, { ...current, plan: event.entries });
      return;
    }
    if (event.kind === 'tool_call_start' || event.kind === 'tool_call_progress') {
      // Replay tool calls attach to the most recent assistant message; if
      // there isn't one yet, create a placeholder so the call has a home.
      const lastMessage = current.messages[current.messages.length - 1];
      let messages = current.messages;
      let targetId: string;
      if (lastMessage?.role === 'assistant') {
        targetId = lastMessage.id;
      } else {
        targetId = makeId('a');
        messages = [...messages, { id: targetId, role: 'assistant', text: '', toolCalls: [] }];
      }
      const updated = messages.map((message) => {
        if (message.id !== targetId) return message;
        const existing = message.toolCalls ?? [];
        const id = event.toolCall.toolCallId;
        if (!id) return message;
        const found = existing.find((tc) => tc.id === id);
        const next: HermesToolCall = found
          ? {
              ...found,
              title: event.toolCall.title ?? found.title,
              kind: event.toolCall.kind ?? found.kind,
              status: event.toolCall.status ?? found.status,
              rawInput: event.toolCall.rawInput ?? found.rawInput,
              rawOutput: event.toolCall.rawOutput ?? found.rawOutput,
              locations: event.toolCall.locations ?? found.locations,
              diffs: event.toolCall.diffs ?? found.diffs
            }
          : {
              id,
              title: event.toolCall.title ?? 'tool',
              kind: event.toolCall.kind,
              status: event.toolCall.status ?? (event.kind === 'tool_call_start' ? 'pending' : 'in_progress'),
              rawInput: event.toolCall.rawInput,
              rawOutput: event.toolCall.rawOutput,
              locations: event.toolCall.locations,
              diffs: event.toolCall.diffs
            };
        const nextToolCalls = found
          ? existing.map((tc) => (tc.id === id ? next : tc))
          : [...existing, next];
        return { ...message, toolCalls: nextToolCalls };
      });
      this.set(projectId, { ...current, messages: updated });
    }
  }

  private failPrompt(projectId: string, assistantMessageId: string, error: unknown): HermesSnapshot {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.snapshots.get(projectId) ?? EMPTY_SNAPSHOT;
    const messages = current.messages.filter((m) => m.id !== assistantMessageId);
    return this.set(projectId, {
      ...current,
      messages,
      pending: false,
      error: message
    });
  }

  private replaceAssistantMessage(
    projectId: string,
    assistantMessageId: string,
    text: string,
    usage: AcpUsageUpdate | undefined,
    toolCalls: Map<string, HermesToolCall>,
    toolCallOrder: string[],
    pending = true
  ): HermesSnapshot {
    const current = this.snapshots.get(projectId) ?? EMPTY_SNAPSHOT;
    const orderedToolCalls = toolCallOrder
      .map((id) => toolCalls.get(id))
      .filter((tc): tc is HermesToolCall => Boolean(tc));
    const messages = current.messages.map((message) =>
      message.id === assistantMessageId
        ? { ...message, text, toolCalls: orderedToolCalls.length > 0 ? orderedToolCalls : undefined }
        : message
    );
    const nextUsage = usageFromAcp(usage, this.contextLength) ?? current.contextUsage;
    return this.set(projectId, {
      ...current,
      messages,
      pending,
      error: undefined,
      contextUsage: nextUsage
    });
  }

  private isStale(projectId: string, requestGeneration: number) {
    return (this.generations.get(projectId) ?? 0) !== requestGeneration;
  }

  private set(projectId: string, snapshot: HermesSnapshot): HermesSnapshot {
    this.snapshots.set(projectId, snapshot);
    const copied = this.copy(snapshot);
    for (const listener of this.listeners) listener({ projectId, snapshot: copied });
    return copied;
  }

  private copy(snapshot: HermesSnapshot): HermesSnapshot {
    return {
      messages: snapshot.messages.map((m) => ({
        ...m,
        toolCalls: m.toolCalls?.map((tc) => ({
          ...tc,
          locations: tc.locations?.map((l) => ({ ...l })),
          diffs: tc.diffs?.map((d) => ({ ...d }))
        })),
        images: m.images?.map((img) => ({ ...img })),
        resources: m.resources?.map((res) => ({ ...res }))
      })),
      pending: snapshot.pending,
      error: snapshot.error,
      contextUsage: snapshot.contextUsage ? { ...snapshot.contextUsage } : undefined,
      availableCommands: snapshot.availableCommands?.map((cmd) => ({ ...cmd })),
      plan: snapshot.plan?.map((entry) => ({ ...entry }))
    };
  }
}
