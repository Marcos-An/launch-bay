// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHermesSessionStore, type PersistedHermesInstance } from './hermesSessionStore.js';

const sample: PersistedHermesInstance = {
  id: 'hermes:sample:1:1',
  projectId: 'sample',
  title: 'Hermes 1 · Sample',
  acpSessionId: 'sess-1',
  cwd: '/repos/sample',
  createdAt: '2026-01-01T00:00:00.000Z'
};

describe('hermesSessionStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'launch-bay-hermes-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no instances when the file does not exist yet', () => {
    const store = createHermesSessionStore(dir);
    expect(store.load()).toEqual([]);
  });

  it('upsert writes the instance and load reads it back', () => {
    const store = createHermesSessionStore(dir);
    store.upsert(sample);
    expect(store.load()).toEqual([sample]);

    // Fresh store reading the same dir sees the persisted entry.
    const reopened = createHermesSessionStore(dir);
    expect(reopened.load()).toEqual([sample]);
  });

  it('upsert replaces an entry with the same id rather than duplicating it', () => {
    const store = createHermesSessionStore(dir);
    store.upsert(sample);
    store.upsert({ ...sample, acpSessionId: 'sess-2' });
    expect(store.load()).toEqual([{ ...sample, acpSessionId: 'sess-2' }]);
  });

  it('remove drops the instance by id', () => {
    const store = createHermesSessionStore(dir);
    store.upsert(sample);
    store.upsert({ ...sample, id: 'other' });
    store.remove(sample.id);
    expect(store.load().map((entry) => entry.id)).toEqual(['other']);
  });

  it('treats a corrupt file as empty rather than crashing', () => {
    writeFileSync(join(dir, 'hermes-sessions.json'), '{ this is not json');
    const store = createHermesSessionStore(dir);
    expect(store.load()).toEqual([]);
  });

  it('persists atomically via a rename so a crash mid-write leaves the previous content intact', () => {
    const store = createHermesSessionStore(dir);
    store.upsert(sample);
    const raw = readFileSync(join(dir, 'hermes-sessions.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.instances).toEqual([sample]);
  });
});
