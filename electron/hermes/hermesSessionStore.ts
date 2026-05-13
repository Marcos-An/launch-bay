import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STORE_FILENAME = 'hermes-sessions.json';

export type PersistedHermesInstance = {
  id: string;
  projectId: string;
  title: string;
  acpSessionId: string;
  cwd: string;
  createdAt: string;
};

export type HermesSessionStoreFile = {
  version: 1;
  instances: PersistedHermesInstance[];
};

export type HermesSessionStore = {
  load(): PersistedHermesInstance[];
  upsert(instance: PersistedHermesInstance): void;
  remove(instanceId: string): void;
  removeAllForProject(projectId: string): void;
  replaceAll(instances: PersistedHermesInstance[]): void;
};

function emptyFile(): HermesSessionStoreFile {
  return { version: 1, instances: [] };
}

function parseFile(raw: string): HermesSessionStoreFile {
  try {
    const parsed = JSON.parse(raw) as Partial<HermesSessionStoreFile>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.instances)) {
      const instances = parsed.instances.filter(
        (entry): entry is PersistedHermesInstance =>
          Boolean(
            entry &&
              typeof entry.id === 'string' &&
              typeof entry.projectId === 'string' &&
              typeof entry.title === 'string' &&
              typeof entry.acpSessionId === 'string' &&
              typeof entry.cwd === 'string' &&
              typeof entry.createdAt === 'string'
          )
      );
      return { version: 1, instances };
    }
  } catch {
    // fall through — corrupt file is treated as empty.
  }
  return emptyFile();
}

export function createHermesSessionStore(userDataDir: string): HermesSessionStore {
  const filePath = join(userDataDir, STORE_FILENAME);
  let cache: HermesSessionStoreFile | undefined;

  function ensureLoaded(): HermesSessionStoreFile {
    if (cache) return cache;
    if (!existsSync(filePath)) {
      cache = emptyFile();
      return cache;
    }
    cache = parseFile(readFileSync(filePath, 'utf8'));
    return cache;
  }

  function persist(next: HermesSessionStoreFile) {
    cache = next;
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, filePath);
  }

  return {
    load() {
      return ensureLoaded().instances.map((entry) => ({ ...entry }));
    },
    upsert(instance) {
      const current = ensureLoaded();
      const filtered = current.instances.filter((entry) => entry.id !== instance.id);
      persist({ version: 1, instances: [...filtered, { ...instance }] });
    },
    remove(instanceId) {
      const current = ensureLoaded();
      const filtered = current.instances.filter((entry) => entry.id !== instanceId);
      if (filtered.length === current.instances.length) return;
      persist({ version: 1, instances: filtered });
    },
    removeAllForProject(projectId) {
      const current = ensureLoaded();
      const filtered = current.instances.filter((entry) => entry.projectId !== projectId);
      if (filtered.length === current.instances.length) return;
      persist({ version: 1, instances: filtered });
    },
    replaceAll(instances) {
      persist({ version: 1, instances: instances.map((entry) => ({ ...entry })) });
    }
  };
}
