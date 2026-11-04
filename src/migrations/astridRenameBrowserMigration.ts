/**
 * One-time same-origin browser data migration for the Astrid rename.
 *
 * Keep the App on `astrid.haus` through this release: browser storage is
 * origin-scoped, so this copier cannot reach data from another origin.
 * Extension ids embedded in keys or values, extension state and proposal data,
 * the dev-disable list, transcript-lane preference, and Cache Storage are
 * intentionally outside this migration.
 * Removal: 30 days after deployment (F-WINDOW; manager to add the deploy date).
 * rename-skip.txt, allowlist.txt, allowlist-final.txt: remove with this module.
 */

const COMPLETION_KEY = 'astrid.rename-migration.v1';
const COMPLETION_VALUE = 'complete';

const LOCAL_STORAGE_KEYS = [
  { oldName: 'reigh:videoEditor:pendingAdds', newName: 'astrid:videoEditor:pendingAdds' },
  { oldName: 'reigh:skipDeleteGenerationConfirm', newName: 'astrid:skipDeleteGenerationConfirm' },
  { oldName: 'reigh-skip-delete-shot-confirmation', newName: 'astrid-skip-delete-shot-confirmation' },
  { oldName: 'reigh:perf-diagnostics', newName: 'astrid:perf-diagnostics' },
  { oldName: 'reigh:video-editor:sequence-creator', newName: 'astrid:video-editor:sequence-creator' },
] as const;

const LOCAL_STORAGE_PREFIXES = [
  { oldName: 'reigh-hidden-shots:', newName: 'astrid-hidden-shots:' },
  { oldName: 'reigh:transcript-draft:', newName: 'astrid:transcript-draft:' },
  { oldName: 'reigh.runtime.media-import.v1:', newName: 'astrid.runtime.media-import.v1:' },
] as const;

const LOCAL_MEDIA_STORE_OLD_NAME = 'reigh.local-media-handles';
const LOCAL_MEDIA_STORE_NEW_NAME = 'astrid.local-media-handles';

const DATABASES = [
  { oldName: 'reigh.timeline-drafts', newName: 'astrid.timeline-drafts' },
  { oldName: 'reigh.sync-ledger', newName: 'astrid.sync-ledger' },
  { oldName: 'reigh.local-media', newName: 'astrid.local-media' },
] as const;

interface IndexSchema {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface StoreSchema {
  oldName: string;
  newName: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexSchema[];
}

interface StoreRecord {
  key: IDBValidKey;
  value: unknown;
}

interface DatabaseSnapshot {
  oldName: string;
  newName: string;
  version: number;
  stores: Array<StoreSchema & { records: StoreRecord[] }>;
}

interface PreparedRecord extends StoreRecord {
  needsReimport: boolean;
}

interface PreparedStore extends StoreSchema {
  records: PreparedRecord[];
}

interface PreparedDatabase extends Omit<DatabaseSnapshot, 'stores'> {
  stores: PreparedStore[];
}

export type BrowserMigrationResult =
  | { success: true }
  | { success: false; store: string; error: unknown };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')), { once: true });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('IndexedDB transaction failed')), { once: true });
  });
}

function stringListValues(list: DOMStringList): string[] {
  return Array.from({ length: list.length }, (_, index) => list.item(index))
    .filter((value): value is string => value !== null);
}

function openDatabase(name: string, version?: number): Promise<{ database: IDBDatabase; created: boolean }> {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable');

  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(name) : factory.open(name, version);
    let created = false;
    request.addEventListener('upgradeneeded', (event) => {
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      created = oldVersion === 0 || typeof oldVersion !== 'number';
    });
    request.addEventListener('success', () => resolve({ database: request.result, created }), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error(`Failed to open IndexedDB ${name}`)), { once: true });
    request.addEventListener('blocked', () => reject(new Error(`Opening IndexedDB ${name} was blocked`)), { once: true });
  });
}

function deleteDatabase(name: string): Promise<void> {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable');

  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.addEventListener('success', () => resolve(), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error(`Failed to delete IndexedDB ${name}`)), { once: true });
    request.addEventListener('blocked', () => reject(new Error(`Deleting IndexedDB ${name} was blocked`)), { once: true });
  });
}

function mappedStoreName(oldName: string): string {
  return oldName === LOCAL_MEDIA_STORE_OLD_NAME ? LOCAL_MEDIA_STORE_NEW_NAME : oldName;
}

async function readDatabaseSnapshot(oldName: string, newName: string): Promise<DatabaseSnapshot | null> {
  const { database, created } = await openDatabase(oldName);
  if (created) {
    database.close();
    await deleteDatabase(oldName);
    return null;
  }

  try {
    const storeNames = stringListValues(database.objectStoreNames);
    // Another startup can open an absent-name probe before its deletion finishes.
    // An empty legacy schema has nothing to copy; let the destination owner create
    // its schema instead of publishing a storeless database at the same version.
    if (storeNames.length === 0) return null;
    const stores: Array<StoreSchema & { records: StoreRecord[] }> = [];
    for (const oldStoreName of storeNames) {
      const transaction = database.transaction(oldStoreName, 'readonly');
      const done = transactionComplete(transaction);
      const store = transaction.objectStore(oldStoreName);
      const schema: StoreSchema = {
        oldName: oldStoreName,
        newName: mappedStoreName(oldStoreName),
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement ?? false,
        indexes: stringListValues(store.indexNames).map((indexName) => {
          const index = store.index(indexName);
          return {
            name: index.name,
            keyPath: index.keyPath as string | string[],
            unique: index.unique ?? false,
            multiEntry: index.multiEntry ?? false,
          };
        }),
      };
      const [keys, values] = await Promise.all([
        requestResult(store.getAllKeys()),
        requestResult(store.getAll()),
      ]);
      await done;
      stores.push({
        ...schema,
        records: keys.map((key, recordIndex) => ({ key, value: values[recordIndex] })),
      });
    }

    return {
      oldName,
      newName,
      version: database.version,
      stores,
    };
  } finally {
    database.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function handleNeedsReimport(value: unknown): { kind: string; name: string; needsReimport: true } {
  const kind = isRecord(value) && typeof value.kind === 'string' ? value.kind : 'file';
  const name = isRecord(value) && typeof value.name === 'string' ? value.name : '';
  return { kind, name, needsReimport: true };
}

async function prepareDatabase(snapshot: DatabaseSnapshot): Promise<PreparedDatabase> {
  const stores: PreparedStore[] = [];

  for (const store of snapshot.stores) {
    const records: PreparedRecord[] = [];
    for (const record of store.records) {
      try {
        records.push({ ...record, value: structuredClone(record.value), needsReimport: false });
      } catch (error) {
        if (store.oldName !== LOCAL_MEDIA_STORE_OLD_NAME) throw error;
        records.push({ ...record, value: handleNeedsReimport(record.value), needsReimport: true });
      }
    }
    stores.push({ ...store, records });
  }

  return { ...snapshot, stores };
}

function schemasMatch(actual: IDBDatabase, expected: PreparedDatabase): boolean {
  if (actual.version !== expected.version) return false;
  const expectedNames = expected.stores.map((store) => store.newName).sort();
  const actualNames = stringListValues(actual.objectStoreNames).sort();
  if (!sameArray(actualNames, expectedNames)) return false;

  return expected.stores.every((expectedStore) => {
    const transaction = actual.transaction(expectedStore.newName, 'readonly');
    const store = transaction.objectStore(expectedStore.newName);
    const actualIndexes = stringListValues(store.indexNames).sort();
    const expectedIndexes = expectedStore.indexes.map((index) => index.name).sort();
    if (!sameArray(actualIndexes, expectedIndexes)) return false;
    return expectedStore.indexes.every((expectedIndex) => {
      const index = store.index(expectedIndex.name);
      return (index.unique ?? false) === expectedIndex.unique
        && (index.multiEntry ?? false) === expectedIndex.multiEntry
        && sameValue(index.keyPath, expectedIndex.keyPath);
    }) && (store.autoIncrement ?? false) === expectedStore.autoIncrement
      && sameValue(store.keyPath, expectedStore.keyPath);
  });
}

function sameArray<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return sameArray(left, right);
  return false;
}

async function valuesEqual(left: unknown, right: unknown): Promise<boolean> {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;

  const leftHandle = left as Record<string, unknown> & { isSameEntry?: (other: unknown) => Promise<boolean> };
  const rightHandle = right as Record<string, unknown> & { isSameEntry?: (other: unknown) => Promise<boolean> };
  if (typeof leftHandle.isSameEntry === 'function' && typeof rightHandle.isSameEntry === 'function') {
    return leftHandle.kind === rightHandle.kind
      && leftHandle.name === rightHandle.name
      && leftHandle.isSameEntry(rightHandle);
  }

  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (left instanceof ArrayBuffer || right instanceof ArrayBuffer) {
    return left instanceof ArrayBuffer && right instanceof ArrayBuffer
      && sameArray(Array.from(new Uint8Array(left)), Array.from(new Uint8Array(right)));
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    return left.constructor === right.constructor
      && sameArray(Array.from(new Uint8Array(left.buffer, left.byteOffset, left.byteLength)),
        Array.from(new Uint8Array(right.buffer, right.byteOffset, right.byteLength)));
  }
  if (left instanceof Blob || right instanceof Blob) {
    if (!(left instanceof Blob) || !(right instanceof Blob) || left.size !== right.size || left.type !== right.type) {
      return false;
    }
    const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
    return sameArray(Array.from(new Uint8Array(leftBytes)), Array.from(new Uint8Array(rightBytes)));
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!(await valuesEqual(left[index], right[index]))) return false;
    }
    return true;
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    const rightEntries = Array.from(right.entries());
    for (const [key, value] of left.entries()) {
      const match = rightEntries.find(([candidate]) => Object.is(candidate, key));
      if (!match || !(await valuesEqual(value, match[1]))) return false;
    }
    return true;
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
    const unmatched = Array.from(right.values());
    for (const value of left.values()) {
      const index = unmatched.findIndex((candidate) => Object.is(candidate, value));
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!sameArray(leftKeys, rightKeys)) return false;
  for (const key of leftKeys) {
    if (!(await valuesEqual(left[key], right[key]))) return false;
  }
  return true;
}

async function readDatabaseRecords(database: IDBDatabase): Promise<Array<{ name: string; records: StoreRecord[] }>> {
  const storeNames = stringListValues(database.objectStoreNames);
  if (storeNames.length === 0) return [];

  const reads = storeNames.map(async (name) => {
    const transaction = database.transaction(name, 'readonly');
    const done = transactionComplete(transaction);
    const store = transaction.objectStore(name);
    const [keys, values] = await Promise.all([
      requestResult(store.getAllKeys()),
      requestResult(store.getAll()),
    ]);
    await done;
    return { name, records: keys.map((key, index) => ({ key, value: values[index] })) };
  });
  return Promise.all(reads);
}

async function destinationDatabaseIsSafe(database: IDBDatabase, expected: PreparedDatabase): Promise<void> {
  if (!schemasMatch(database, expected)) {
    throw new Error(`Schema mismatch for IndexedDB ${expected.newName}`);
  }

  const destinationStores = await readDatabaseRecords(database);
  for (const destinationStore of destinationStores) {
    const expectedStore = expected.stores.find((store) => store.newName === destinationStore.name);
    if (!expectedStore) throw new Error(`Unexpected destination store ${destinationStore.name}`);

    for (const destinationRecord of destinationStore.records) {
      let sourceRecord: PreparedRecord | undefined;
      for (const candidate of expectedStore.records) {
        if (globalThis.indexedDB.cmp(candidate.key, destinationRecord.key) === 0) {
          sourceRecord = candidate;
          break;
        }
      }
      if (!sourceRecord || !(await valuesEqual(sourceRecord.value, destinationRecord.value))) {
        throw new Error(`Destination data diverges in IndexedDB store ${destinationStore.name}`);
      }
    }
  }
}

function createMappedSchema(database: IDBDatabase, expected: PreparedDatabase): void {
  for (const expectedStore of expected.stores) {
    const store = database.createObjectStore(expectedStore.newName, {
      ...(expectedStore.keyPath === null ? {} : { keyPath: expectedStore.keyPath }),
      autoIncrement: expectedStore.autoIncrement,
    });
    for (const index of expectedStore.indexes) {
      store.createIndex(index.name, index.keyPath, {
        unique: index.unique,
        multiEntry: index.multiEntry,
      });
    }
  }
}

async function openMappedDatabase(expected: PreparedDatabase): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable');

  return new Promise((resolve, reject) => {
    const request = factory.open(expected.newName, expected.version);
    request.addEventListener('upgradeneeded', (event) => {
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion === 0 || typeof oldVersion !== 'number') createMappedSchema(request.result, expected);
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error(`Failed to create IndexedDB ${expected.newName}`)), { once: true });
    request.addEventListener('blocked', () => reject(new Error(`Opening IndexedDB ${expected.newName} was blocked`)), { once: true });
  });
}

async function writeAndVerifyDatabase(expected: PreparedDatabase): Promise<void> {
  const database = await openMappedDatabase(expected);
  try {
    await destinationDatabaseIsSafe(database, expected);

    for (const expectedStore of expected.stores) {
      const transaction = database.transaction(expectedStore.newName, 'readwrite');
      const done = transactionComplete(transaction);
      void done.catch(() => undefined);
      try {
        const store = transaction.objectStore(expectedStore.newName);
        const existingKeys = await requestResult(store.getAllKeys());
        for (const record of expectedStore.records) {
          if (existingKeys.some((key) => globalThis.indexedDB.cmp(key, record.key) === 0)) continue;
          if (expectedStore.keyPath === null) store.put(record.value, record.key);
          else store.put(record.value);
        }
        await done;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be inactive after its error event.
        }
        throw error;
      }
    }
  } finally {
    database.close();
  }

  const { database: verifyDatabase } = await openDatabase(expected.newName);
  try {
    if (!schemasMatch(verifyDatabase, expected)) {
      throw new Error(`Read-back schema mismatch for IndexedDB ${expected.newName}`);
    }
    const readBackStores = await readDatabaseRecords(verifyDatabase);
    if (readBackStores.length !== expected.stores.length) {
      throw new Error(`Read-back store count mismatch for IndexedDB ${expected.newName}`);
    }

    for (const expectedStore of expected.stores) {
      const readBack = readBackStores.find((store) => store.name === expectedStore.newName);
      if (!readBack || readBack.records.length !== expectedStore.records.length) {
        throw new Error(`Read-back record count mismatch for IndexedDB store ${expectedStore.newName}`);
      }
      for (const expectedRecord of expectedStore.records) {
        let record: StoreRecord | undefined;
        for (const candidate of readBack.records) {
          if (await valuesEqual(candidate.key, expectedRecord.key)) {
            record = candidate;
            break;
          }
        }
        if (!record || !(await valuesEqual(record.value, expectedRecord.value))) {
          throw new Error(`Read-back value mismatch for IndexedDB store ${expectedStore.newName}`);
        }
      }
    }
  } finally {
    verifyDatabase.close();
  }
}

function localStoragePlan(storage: Storage): Array<{ oldName: string; newName: string; value: string }> {
  const entries: Array<{ oldName: string; newName: string; value: string }> = [];
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null);

  for (const oldName of keys) {
    const exact = LOCAL_STORAGE_KEYS.find((entry) => entry.oldName === oldName);
    const prefix = LOCAL_STORAGE_PREFIXES.find((entry) => oldName.startsWith(entry.oldName));
    const mapping = exact ?? (prefix
      ? { oldName: prefix.oldName, newName: prefix.newName }
      : null);
    if (!mapping) continue;

    const value = storage.getItem(oldName);
    if (value === null) continue;
    const newName = exact
      ? exact.newName
      : `${mapping.newName}${oldName.slice(mapping.oldName.length)}`;
    entries.push({ oldName, newName, value });
  }

  return entries;
}

function writeAndVerifyLocalStorage(storage: Storage, entries: Array<{ oldName: string; newName: string; value: string }>): void {
  for (const entry of entries) {
    const existing = storage.getItem(entry.newName);
    if (existing !== null && existing !== entry.value) {
      throw new Error(`Destination data diverges for localStorage key ${entry.newName}`);
    }
  }
  for (const entry of entries) {
    try {
      storage.setItem(entry.newName, entry.value);
      if (storage.getItem(entry.newName) !== entry.value) {
        throw new Error('Read-back value mismatch');
      }
    } catch (error) {
      const failure = new Error(`Copy failed for localStorage key ${entry.newName}`);
      (failure as Error & { cause?: unknown }).cause = error;
      throw failure;
    }
  }
}

function deleteOldLocalStorage(
  storage: Storage,
  entries: Array<{ oldName: string; newName: string; value: string }>,
): void {
  for (const entry of entries) {
    try {
      const latestValue = storage.getItem(entry.oldName);
      if (latestValue === null) continue;
      if (latestValue !== entry.value) {
        const destinationValue = storage.getItem(entry.newName);
        if (destinationValue !== null && destinationValue !== latestValue) {
          throw new Error(`Destination data diverges for localStorage key ${entry.newName}`);
        }
        storage.setItem(entry.newName, latestValue);
        if (storage.getItem(entry.newName) !== latestValue) {
          throw new Error('Read-back value mismatch after a concurrent update');
        }
      }
      storage.removeItem(entry.oldName);
      if (storage.getItem(entry.oldName) !== null) {
        throw new Error('Old key still exists after removal');
      }
    } catch (error) {
      const failure = new Error(`Cleanup failed for localStorage key ${entry.oldName}`);
      (failure as Error & { cause?: unknown }).cause = error;
      throw failure;
    }
  }
}

function warnStoreFailure(store: string, error: unknown): void {
  console.warn(`[astrid rename migration] ${store} failed; old data was retained and will retry on next start.`, error);
}

/** Copy, verify, then remove all listed browser storage names once per origin. */
export async function migrateAstridBrowserStorage(): Promise<BrowserMigrationResult> {
  if (typeof window === 'undefined') return { success: true };

  const fail = (store: string, error: unknown): BrowserMigrationResult => {
    warnStoreFailure(store, error);
    return { success: false, store, error };
  };

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch (error) {
    return fail('localStorage access', error);
  }

  try {
    if (storage.getItem(COMPLETION_KEY) === COMPLETION_VALUE) return { success: true };
  } catch (error) {
    return fail(`localStorage completion marker ${COMPLETION_KEY}`, error);
  }

  let localEntries: ReturnType<typeof localStoragePlan>;
  try {
    localEntries = localStoragePlan(storage);
  } catch (error) {
    return fail('localStorage source read', error);
  }

  const snapshots: DatabaseSnapshot[] = [];
  for (const { oldName, newName } of DATABASES) {
    try {
      const snapshot = await readDatabaseSnapshot(oldName, newName);
      if (snapshot) snapshots.push(snapshot);
    } catch (error) {
      return fail(`IndexedDB database ${oldName}`, error);
    }
  }

  try {
    writeAndVerifyLocalStorage(storage, localEntries);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'write/read-back error';
    const store = message.match(/localStorage key ([^ ]+)/)?.[1] ?? 'localStorage';
    return fail(`localStorage ${store}`, error);
  }

  const preparedDatabases: PreparedDatabase[] = [];
  for (const snapshot of snapshots) {
    try {
      const prepared = await prepareDatabase(snapshot);
      const existing = await openMappedDatabase(prepared);
      try {
        await destinationDatabaseIsSafe(existing, prepared);
      } finally {
        existing.close();
      }
      await writeAndVerifyDatabase(prepared);
      preparedDatabases.push(prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const store = message.match(/IndexedDB store ([^ ]+)/)?.[1];
      return fail(store ? `IndexedDB ${snapshot.newName} / ${store}` : `IndexedDB database ${snapshot.newName}`, error);
    }
  }

  let cleanupStore = 'localStorage cleanup';
  try {
    cleanupStore = 'localStorage source keys';
    deleteOldLocalStorage(storage, localEntries);
    for (const database of preparedDatabases) {
      cleanupStore = `IndexedDB database ${database.newName}`;
      await deleteDatabase(database.oldName);
    }
    cleanupStore = `localStorage completion marker ${COMPLETION_KEY}`;
    storage.setItem(COMPLETION_KEY, COMPLETION_VALUE);
    if (storage.getItem(COMPLETION_KEY) !== COMPLETION_VALUE) {
      throw new Error(`Read-back value mismatch for localStorage completion marker ${COMPLETION_KEY}`);
    }
    return { success: true };
  } catch (error) {
    try {
      storage.removeItem(COMPLETION_KEY);
    } catch {
      // Keep the original failure as the diagnostic; the next run checks the marker first.
    }
    return fail(cleanupStore, error);
  }
}
