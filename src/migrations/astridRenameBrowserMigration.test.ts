// @vitest-environment jsdom
// Browser old-name fixture mirrored from $TOOLS/browser-old-prefixes.txt.
// Keep each listed literal seeded here so migration tests exercise the complete fixture.
// Removal: 30 days after deployment (F-WINDOW; manager to set the calendar date).
// rename-skip.txt, allowlist.txt, allowlist-final.txt entries expire with this test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, IDBKeyRange } from 'fake-indexeddb';
import { PREVIEW_ALLOWED_HOSTS } from '../../config/vite/policy.ts';
import { loadTimelineDraft } from '../tools/video-editor/data/timelineDraftIndexedDb.ts';
import { migrateAstridBrowserStorage } from './astridRenameBrowserMigration.ts';

const OLD_LOCAL_STORAGE_KEYS = [
  { oldName: 'reigh:videoEditor:pendingAdds', newName: 'astrid:videoEditor:pendingAdds', value: '["generation-1"]' },
  { oldName: 'reigh:skipDeleteGenerationConfirm', newName: 'astrid:skipDeleteGenerationConfirm', value: 'true' },
  { oldName: 'reigh-skip-delete-shot-confirmation', newName: 'astrid-skip-delete-shot-confirmation', value: 'true' },
  { oldName: 'reigh:perf-diagnostics', newName: 'astrid:perf-diagnostics', value: 'false' },
  { oldName: 'reigh:video-editor:sequence-creator', newName: 'astrid:video-editor:sequence-creator', value: '{"draft":"sequence"}' },
] as const;

const OLD_LOCAL_STORAGE_PREFIXES = [
  { oldName: 'reigh-hidden-shots:', newName: 'astrid-hidden-shots:', suffix: 'project-1', value: '["shot-1"]' },
  { oldName: 'reigh:transcript-draft:', newName: 'astrid:transcript-draft:', suffix: 'project-1:transcript-1', value: '{"text":"hello"}' },
  { oldName: 'reigh.runtime.media-import.v1:', newName: 'astrid.runtime.media-import.v1:', suffix: 'project-1:operation-1', value: '{"status":"pending"}' },
] as const;

const OLD_DATABASES = {
  timelineDrafts: { oldName: 'reigh.timeline-drafts', newName: 'astrid.timeline-drafts' },
  syncLedger: { oldName: 'reigh.sync-ledger', newName: 'astrid.sync-ledger' },
  localMedia: { oldName: 'reigh.local-media', newName: 'astrid.local-media' },
} as const;

const OLD_LOCAL_MEDIA_STORE = 'reigh.local-media-handles';
const NEW_LOCAL_MEDIA_STORE = 'astrid.local-media-handles';
const COMPLETION_KEY = 'astrid.rename-migration.v1';
let browserStorage: Storage;

interface StoreSeed {
  name: string;
  options?: IDBObjectStoreParameters;
  indexes?: Array<{ name: string; keyPath: string | string[]; options?: IDBIndexParameters }>;
  records: Array<{ value: unknown; key?: IDBValidKey }>;
}

function seedDatabase(name: string, stores: StoreSeed[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      for (const definition of stores) {
        const store = database.createObjectStore(definition.name, definition.options);
        for (const index of definition.indexes ?? []) {
          store.createIndex(index.name, index.keyPath, index.options);
        }
      }
    });
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const database = request.result;
      void (async () => {
        for (const definition of stores) {
          const transaction = database.transaction(definition.name, 'readwrite');
          const done = new Promise<void>((transactionResolve, transactionReject) => {
            transaction.addEventListener('complete', () => transactionResolve(), { once: true });
            transaction.addEventListener('abort', () => transactionReject(transaction.error), { once: true });
          });
          const store = transaction.objectStore(definition.name);
          for (const record of definition.records) {
            if (definition.options?.keyPath == null) store.put(record.value, record.key);
            else store.put(record.value);
          }
          await done;
        }
        database.close();
        resolve();
      })().catch(reject);
    }, { once: true });
  });
}

function readStore(databaseName: string, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const database = request.result;
      const transaction = database.transaction(storeName, 'readonly');
      const read = transaction.objectStore(storeName).getAll();
      read.addEventListener('success', () => resolve(read.result), { once: true });
      read.addEventListener('error', () => reject(read.error), { once: true });
      transaction.addEventListener('complete', () => database.close(), { once: true });
    }, { once: true });
  });
}

function addStoreRecord(databaseName: string, storeName: string, value: unknown, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const database = request.result;
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value, key);
      transaction.addEventListener('complete', () => {
        database.close();
        resolve();
      }, { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    }, { once: true });
  });
}

function readStoreSchema(databaseName: string, storeName: string): Promise<{ keyPath: string | string[] | null; indexes: string[] }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const database = request.result;
      const transaction = database.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const indexes = Array.from({ length: store.indexNames.length }, (_, index) => store.indexNames.item(index))
        .filter((name): name is string => name !== null)
        .sort();
      resolve({ keyPath: store.keyPath, indexes });
      transaction.addEventListener('complete', () => database.close(), { once: true });
    }, { once: true });
  });
}

async function databaseNames(): Promise<string[]> {
  return Array.from((indexedDB as unknown as { databases: Map<string, unknown> }).databases.keys());
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key: string) { return values.get(String(key)) ?? null; },
    key(index: number) { return Array.from(values.keys())[index] ?? null; },
    removeItem(key: string) { values.delete(String(key)); },
    setItem(key: string, value: string) { values.set(String(key), String(value)); },
  } as Storage;
}

async function seedEveryListedOldName(): Promise<void> {
  for (const key of OLD_LOCAL_STORAGE_KEYS) browserStorage.setItem(key.oldName, key.value);
  for (const prefix of OLD_LOCAL_STORAGE_PREFIXES) {
    browserStorage.setItem(`${prefix.oldName}${prefix.suffix}`, prefix.value);
  }

  await seedDatabase(OLD_DATABASES.timelineDrafts.oldName, [{
    name: 'timeline-drafts',
    options: { keyPath: 'key' },
    records: [{ value: { key: 'timeline-1', timelineId: 'timeline-1', draft: { title: 'Draft' }, baseVersion: 7 } }],
  }]);
  await seedDatabase(OLD_DATABASES.syncLedger.oldName, [
    {
      name: 'sync-bookmarks',
      options: { keyPath: 'key' },
      records: [{ value: { key: 'timeline-1:local', timeline_id: 'timeline-1', spoke: 'local', synced_at: '2026-10-17' } }],
    },
    {
      name: 'sync-keep-both-artifacts',
      options: { keyPath: 'key' },
      indexes: [{ name: 'timeline_id', keyPath: 'timeline_id' }],
      records: [{ value: { key: 'timeline-1:time-1:artifact-1', timeline_id: 'timeline-1', artifact: { name: 'local' } } }],
    },
  ]);
  await seedDatabase(OLD_DATABASES.localMedia.oldName, [{
    name: OLD_LOCAL_MEDIA_STORE,
    records: [{ key: 'handle-1', value: { kind: 'file', name: 'clip.mov' } }],
  }]);
}

describe('Astrid browser rename migration', () => {
  beforeEach(() => {
    browserStorage = createStorage();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: browserStorage });
    vi.stubGlobal('localStorage', browserStorage);
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('copies every listed browser name, verifies the new state, then removes the old state', async () => {
    await seedEveryListedOldName();

    expect(await migrateAstridBrowserStorage()).toEqual({ success: true });

    for (const key of OLD_LOCAL_STORAGE_KEYS) {
      expect(browserStorage.getItem(key.newName)).toBe(key.value);
      expect(browserStorage.getItem(key.oldName)).toBeNull();
    }
    for (const prefix of OLD_LOCAL_STORAGE_PREFIXES) {
      const oldKey = `${prefix.oldName}${prefix.suffix}`;
      const newKey = `${prefix.newName}${prefix.suffix}`;
      expect(browserStorage.getItem(newKey)).toBe(prefix.value);
      expect(browserStorage.getItem(oldKey)).toBeNull();
    }

    expect(await readStore(OLD_DATABASES.timelineDrafts.newName, 'timeline-drafts')).toEqual([
      { key: 'timeline-1', timelineId: 'timeline-1', draft: { title: 'Draft' }, baseVersion: 7 },
    ]);
    expect(await readStoreSchema(OLD_DATABASES.timelineDrafts.newName, 'timeline-drafts')).toEqual({
      keyPath: 'key',
      indexes: [],
    });
    expect(await readStore(OLD_DATABASES.syncLedger.newName, 'sync-bookmarks')).toEqual([
      { key: 'timeline-1:local', timeline_id: 'timeline-1', spoke: 'local', synced_at: '2026-10-17' },
    ]);
    expect(await readStore(OLD_DATABASES.syncLedger.newName, 'sync-keep-both-artifacts')).toEqual([
      { key: 'timeline-1:time-1:artifact-1', timeline_id: 'timeline-1', artifact: { name: 'local' } },
    ]);
    expect(await readStoreSchema(OLD_DATABASES.syncLedger.newName, 'sync-keep-both-artifacts')).toEqual({
      keyPath: 'key',
      indexes: ['timeline_id'],
    });
    expect(await readStore(OLD_DATABASES.localMedia.newName, NEW_LOCAL_MEDIA_STORE)).toEqual([
      { kind: 'file', name: 'clip.mov' },
    ]);
    expect(await readStoreSchema(OLD_DATABASES.localMedia.newName, NEW_LOCAL_MEDIA_STORE)).toEqual({
      keyPath: null,
      indexes: [],
    });
    const migratedDatabaseNames = await databaseNames();
    expect(migratedDatabaseNames).not.toContain(OLD_DATABASES.timelineDrafts.oldName);
    expect(migratedDatabaseNames).not.toContain(OLD_DATABASES.syncLedger.oldName);
    expect(migratedDatabaseNames).not.toContain(OLD_DATABASES.localMedia.oldName);
    expect(browserStorage.getItem(COMPLETION_KEY)).toBeTruthy();
  });

  it('uses the completion marker to make a second run a no-op', async () => {
    await seedEveryListedOldName();
    expect(await migrateAstridBrowserStorage()).toEqual({ success: true });
    browserStorage.setItem('astrid:videoEditor:pendingAdds', 'newer value');

    expect(await migrateAstridBrowserStorage()).toEqual({ success: true });

    expect(browserStorage.getItem('astrid:videoEditor:pendingAdds')).toBe('newer value');
    expect(browserStorage.getItem(COMPLETION_KEY)).toBeTruthy();
  });

  it('migrates when the completion marker is nonempty but invalid', async () => {
    await seedEveryListedOldName();
    browserStorage.setItem(COMPLETION_KEY, 'invalid');

    expect(await migrateAstridBrowserStorage()).toEqual({ success: true });

    expect(browserStorage.getItem('astrid:videoEditor:pendingAdds')).toBe('["generation-1"]');
    expect(browserStorage.getItem(OLD_LOCAL_STORAGE_KEYS[0].oldName)).toBeNull();
    expect(browserStorage.getItem(COMPLETION_KEY)).toBe('complete');
  });

  it('empty legacy v1 migration leaves actual draft load usable', async () => {
    await seedDatabase(OLD_DATABASES.timelineDrafts.oldName, []);

    expect(await migrateAstridBrowserStorage()).toEqual({ success: true });
    await expect(loadTimelineDraft('missing-timeline')).resolves.toBeNull();
    expect(await readStoreSchema(OLD_DATABASES.timelineDrafts.newName, 'timeline-drafts')).toEqual({
      keyPath: 'key',
      indexes: [],
    });
    expect(browserStorage.getItem(COMPLETION_KEY)).toBeTruthy();
  });

  it('concurrent legacy migration opens leave actual draft load usable', async () => {
    const factory = indexedDB;
    const realOpen = factory.open.bind(factory);
    const realDeleteDatabase = factory.deleteDatabase.bind(factory);
    const events: string[] = [];
    const legacyName = OLD_DATABASES.timelineDrafts.oldName;
    vi.spyOn(factory, 'open').mockImplementation((name, version) => {
      if (name === legacyName) events.push('open-queued');
      return version === undefined ? realOpen(name) : realOpen(name, version);
    });
    vi.spyOn(factory, 'deleteDatabase').mockImplementation((name) => {
      const request = realDeleteDatabase(name);
      if (name === legacyName) {
        request.addEventListener('success', () => events.push('legacy-delete-complete'), { once: true });
      }
      return request;
    });

    const firstMigration = migrateAstridBrowserStorage();
    const secondMigration = migrateAstridBrowserStorage();
    const outcomes = await Promise.all([firstMigration, secondMigration]);

    expect(outcomes).toEqual([{ success: true }, { success: true }]);
    const firstDeleteCompletion = events.indexOf('legacy-delete-complete');
    expect(firstDeleteCompletion).toBeGreaterThanOrEqual(2);
    expect(events.slice(0, firstDeleteCompletion).filter((event) => event === 'open-queued')).toHaveLength(2);
    await expect(loadTimelineDraft('missing-timeline')).resolves.toBeNull();
    expect(await readStoreSchema(OLD_DATABASES.timelineDrafts.newName, 'timeline-drafts')).toEqual({
      keyPath: 'key',
      indexes: [],
    });
    expect(browserStorage.getItem(COMPLETION_KEY)).toBeTruthy();
  });

  it('leaves all old data and sets no marker when a copy fails part-way through', async () => {
    await seedEveryListedOldName();
    const storage = browserStorage;
    const realSetItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'astrid:skipDeleteGenerationConfirm') throw new Error('simulated quota failure');
      realSetItem(key, value);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await migrateAstridBrowserStorage()).toMatchObject({ success: false, store: expect.stringContaining('localStorage') });

    for (const key of OLD_LOCAL_STORAGE_KEYS) expect(storage.getItem(key.oldName)).toBe(key.value);
    for (const prefix of OLD_LOCAL_STORAGE_PREFIXES) {
      expect(storage.getItem(`${prefix.oldName}${prefix.suffix}`)).toBe(prefix.value);
    }
    const retainedDatabaseNames = await databaseNames();
    expect(retainedDatabaseNames).toEqual(expect.arrayContaining(Object.values(OLD_DATABASES).map(({ oldName }) => oldName)));
    expect(storage.getItem(COMPLETION_KEY)).toBeNull();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0][0]).toContain('localStorage astrid:skipDeleteGenerationConfirm');
  });

  it('preserves divergent destination data after failure and refuses destructive retry', async () => {
    await seedDatabase(OLD_DATABASES.timelineDrafts.oldName, [{
      name: 'timeline-drafts',
      options: { keyPath: 'key' },
      records: [{ value: { key: 'timeline-1', draft: { title: 'Original' } } }],
    }]);
    const realDeleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    let failSourceCleanup = true;
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation((name) => {
      if (name === OLD_DATABASES.timelineDrafts.oldName && failSourceCleanup) {
        failSourceCleanup = false;
        throw new Error('simulated source cleanup failure');
      }
      return realDeleteDatabase(name);
    });

    const firstAttempt = await migrateAstridBrowserStorage();
    expect(firstAttempt).toMatchObject({ success: false, store: expect.stringContaining(OLD_DATABASES.timelineDrafts.newName) });
    expect(await readStore(OLD_DATABASES.timelineDrafts.newName, 'timeline-drafts')).toEqual([
      { key: 'timeline-1', draft: { title: 'Original' } },
    ]);
    expect(browserStorage.getItem(COMPLETION_KEY)).toBeNull();

    vi.mocked(indexedDB.deleteDatabase).mockRestore();
    await addStoreRecord(OLD_DATABASES.timelineDrafts.newName, 'timeline-drafts', {
      key: 'timeline-2', draft: { title: 'Written after failed attempt' },
    }, 'timeline-2');

    const retry = await migrateAstridBrowserStorage();

    expect(retry).toMatchObject({ success: false, store: expect.stringContaining('timeline-drafts') });
    expect(await readStore(OLD_DATABASES.timelineDrafts.oldName, 'timeline-drafts')).toEqual([
      { key: 'timeline-1', draft: { title: 'Original' } },
    ]);
    expect(await readStore(OLD_DATABASES.timelineDrafts.newName, 'timeline-drafts')).toEqual([
      { key: 'timeline-1', draft: { title: 'Original' } },
      { key: 'timeline-2', draft: { title: 'Written after failed attempt' } },
    ]);
    expect(browserStorage.getItem(COMPLETION_KEY)).toBeNull();
  });

  it('safely retries when the destination contains only the verified copied snapshot', async () => {
    await seedDatabase(OLD_DATABASES.timelineDrafts.oldName, [{
      name: 'timeline-drafts',
      options: { keyPath: 'key' },
      records: [{ value: { key: 'timeline-1', draft: { title: 'Original' } } }],
    }]);
    const realDeleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    let failSourceCleanup = true;
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation((name) => {
      if (name === OLD_DATABASES.timelineDrafts.oldName && failSourceCleanup) {
        failSourceCleanup = false;
        throw new Error('simulated source cleanup failure');
      }
      return realDeleteDatabase(name);
    });

    expect(await migrateAstridBrowserStorage()).toMatchObject({ success: false });
    vi.mocked(indexedDB.deleteDatabase).mockRestore();

    expect(await migrateAstridBrowserStorage()).toEqual({ success: true });
    expect(await readStore(OLD_DATABASES.timelineDrafts.newName, 'timeline-drafts')).toEqual([
      { key: 'timeline-1', draft: { title: 'Original' } },
    ]);
    expect(browserStorage.getItem(COMPLETION_KEY)).toBeTruthy();
  });

  it('marks an uncloneable local media handle for re-import without dropping its entry', async () => {
    await seedDatabase(OLD_DATABASES.localMedia.oldName, [{
      name: OLD_LOCAL_MEDIA_STORE,
      records: [{ key: 'handle-1', value: { kind: 'file', name: 'clip.mov' } }],
    }]);
    const realStructuredClone = globalThis.structuredClone;
    vi.stubGlobal('structuredClone', (value: unknown) => {
      if (typeof value === 'object' && value !== null && 'name' in value) {
        throw new DOMException('not cloneable', 'DataCloneError');
      }
      return realStructuredClone(value);
    });

    expect(await migrateAstridBrowserStorage()).toEqual({ success: true });

    expect(await readStore(OLD_DATABASES.localMedia.newName, NEW_LOCAL_MEDIA_STORE)).toEqual([
      { kind: 'file', name: 'clip.mov', needsReimport: true },
    ]);
    expect(browserStorage.getItem(COMPLETION_KEY)).toBeTruthy();
    expect(await databaseNames()).not.toContain(OLD_DATABASES.localMedia.oldName);
  });

  it('keeps the production preview origin on astrid.haus', () => {
    expect(PREVIEW_ALLOWED_HOSTS).toContain('astrid.haus');
  });
});
