import {
  HermesSessionManager,
  type HermesProjectContext,
  type HermesSendOptions,
  type HermesSessionManagerOptions,
  type HermesSnapshot
} from './hermesClient.js';
import type { PersistedHermesInstance } from './hermesSessionStore.js';

export type HermesInstanceSnapshot = {
  id: string;
  projectId: string;
  title: string;
  snapshot: HermesSnapshot;
};

export type HermesInstanceUpdate = {
  instanceId: string;
  projectId: string;
  snapshot: HermesSnapshot;
};

export type HermesInstancePersistence = {
  load(): PersistedHermesInstance[];
  upsert(instance: PersistedHermesInstance): void;
  remove(instanceId: string): void;
};

export type HermesInstanceManagerOptions = HermesSessionManagerOptions & {
  /**
   * Optional persistence backend. When provided the manager restores
   * previously-saved instances at construction time and keeps the store
   * in sync as instances are created or closed.
   */
  persistence?: HermesInstancePersistence;
};

type InstanceListener = (event: HermesInstanceUpdate) => void;

type Entry = {
  meta: { id: string; projectId: string; title: string };
  manager: HermesSessionManager;
  unsubscribe: () => void;
};

let nextId = 0;
function makeInstanceId(projectId: string) {
  nextId += 1;
  const safe = projectId.replace(/[^a-zA-Z0-9._:-]/g, '-');
  return `hermes:${safe}:${Date.now()}:${nextId}`;
}

export class HermesInstanceManager {
  private readonly options: HermesSessionManagerOptions;
  private readonly persistence: HermesInstancePersistence | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<InstanceListener>();
  private readonly counters = new Map<string, number>();

  constructor(options: HermesInstanceManagerOptions) {
    const { persistence, ...sessionOptions } = options;
    this.options = sessionOptions;
    this.persistence = persistence;
    if (persistence) {
      for (const entry of persistence.load()) {
        this.restore(entry);
      }
    }
  }

  create(projectId: string): HermesInstanceSnapshot {
    const projectContext = this.options.projectContexts?.[projectId];
    const id = makeInstanceId(projectId);
    const counter = (this.counters.get(projectId) ?? 0) + 1;
    this.counters.set(projectId, counter);
    const baseLabel = projectContext?.name ?? projectId;
    const title = `Hermes ${counter} · ${baseLabel}`;
    const manager = this.buildSessionManager(projectId, projectContext, id, title);
    const entry = this.attach({ id, projectId, title }, manager);
    return {
      id,
      projectId,
      title,
      snapshot: entry.manager.getSnapshot(projectId)
    };
  }

  list(projectId?: string): HermesInstanceSnapshot[] {
    const out: HermesInstanceSnapshot[] = [];
    for (const entry of this.entries.values()) {
      if (projectId && entry.meta.projectId !== projectId) continue;
      out.push({
        id: entry.meta.id,
        projectId: entry.meta.projectId,
        title: entry.meta.title,
        snapshot: entry.manager.getSnapshot(entry.meta.projectId)
      });
    }
    return out;
  }

  async send(
    instanceId: string,
    text: string,
    options?: HermesSendOptions
  ): Promise<HermesSnapshot | undefined> {
    const entry = this.entries.get(instanceId);
    if (!entry) return undefined;
    return entry.manager.send(entry.meta.projectId, text, options);
  }

  cancel(instanceId: string): boolean {
    const entry = this.entries.get(instanceId);
    if (!entry) return false;
    entry.manager.cancel(entry.meta.projectId);
    return true;
  }

  reset(instanceId: string): HermesSnapshot | undefined {
    const entry = this.entries.get(instanceId);
    if (!entry) return undefined;
    // Resetting drops the bound ACP session for this instance; clean
    // persistence too so the next allocation isn't dragged back to a
    // session the user explicitly walked away from.
    this.persistence?.remove(entry.meta.id);
    return entry.manager.reset(entry.meta.projectId);
  }

  close(instanceId: string): boolean {
    const entry = this.entries.get(instanceId);
    if (!entry) return false;
    entry.manager.reset(entry.meta.projectId);
    entry.manager.dispose();
    entry.unsubscribe();
    this.entries.delete(instanceId);
    this.persistence?.remove(instanceId);
    return true;
  }

  closeAll() {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  onUpdate(listener: InstanceListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private restore(entry: PersistedHermesInstance) {
    const projectContext: HermesProjectContext = {
      name: this.options.projectContexts?.[entry.projectId]?.name ?? entry.projectId,
      cwd: this.options.projectContexts?.[entry.projectId]?.cwd ?? entry.cwd
    };
    const manager = this.buildSessionManager(
      entry.projectId,
      projectContext,
      entry.id,
      entry.title,
      entry.acpSessionId
    );
    this.attach({ id: entry.id, projectId: entry.projectId, title: entry.title }, manager);
    // Eagerly attach to the persisted ACP session so its history replay
    // populates the snapshot before the user types their first message.
    void manager.warmup(entry.projectId);
  }

  private buildSessionManager(
    projectId: string,
    projectContext: HermesProjectContext | undefined,
    instanceId: string,
    title: string,
    resumeAcpSessionId?: string
  ): HermesSessionManager {
    const projectContexts: Record<string, HermesProjectContext> = {};
    if (projectContext) projectContexts[projectId] = projectContext;

    const resumeAcpSessionIds: Record<string, string> = {};
    if (resumeAcpSessionId) resumeAcpSessionIds[projectId] = resumeAcpSessionId;

    return new HermesSessionManager({
      ...this.options,
      projectContexts,
      resumeAcpSessionIds,
      onSessionAllocated: (allocatedProjectId, acpSessionId) => {
        if (!this.persistence) return;
        const cwd = projectContext?.cwd;
        if (!cwd) return;
        this.persistence.upsert({
          id: instanceId,
          projectId: allocatedProjectId,
          title,
          acpSessionId,
          cwd,
          createdAt: new Date().toISOString()
        });
      }
    });
  }

  private attach(
    meta: { id: string; projectId: string; title: string },
    manager: HermesSessionManager
  ): Entry {
    const unsubscribe = manager.onUpdate((event) => {
      if (event.projectId !== meta.projectId) return;
      this.emit({ instanceId: meta.id, projectId: meta.projectId, snapshot: event.snapshot });
    });
    const entry: Entry = { meta, manager, unsubscribe };
    this.entries.set(meta.id, entry);
    return entry;
  }

  private emit(event: HermesInstanceUpdate) {
    for (const listener of this.listeners) listener(event);
  }
}
