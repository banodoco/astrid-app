import type { Page } from '@playwright/test';

type ProbeInput = { timelineId: string; currentHeadRevisionId?: string };

// Runs in the browser. Project the allowed fields before returning anything to Playwright.
export async function readGate5RecoveryMetadata(root: HTMLElement | SVGElement, { timelineId, currentHeadRevisionId }: ProbeInput) {
  const revisionId = (value: unknown) => typeof value === 'string'
    && /^(?:authoring-parent-revision-[0-9a-f]{64}|(?:bootstrap-)?[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15})$/.test(value) ? value : null;
  const timestamp = (value: unknown) => typeof value === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : null;
  const matchingTerm = (name: string) => name.toLowerCase().match(/timeline-command-recovery|recovery|draft|outbox/)?.[0];
  const databaseStores = new Map([
    ['astrid.timeline-drafts', 'timeline-drafts'], ['reigh.timeline-drafts', 'timeline-drafts'],
    ['astrid.command-outbox', 'owners'],
  ]);
  const knownNames = [...databaseStores.keys(), ...databaseStores.values(), 'video-editor:draft-effects', 'timeline-command-recovery'];
  const safeName = (name: string, index: number) => knownNames.includes(name) ? name : `${matchingTerm(name) ?? 'entry'}:<${index}>`;
  const recordOf = (value: unknown) => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const metadata = (value: unknown, rawJson?: string) => {
    const row = recordOf(value);
    const intent = recordOf(Array.isArray(row.intents) ? row.intents[0] : undefined);
    const outboxBase = recordOf(intent.readyBase ?? recordOf(intent.basis).head).revisionId;
    return {
      baseHeadRevisionId: revisionId(row.baseHeadRevisionId ?? outboxBase),
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
      sizeBytes: new TextEncoder().encode(rawJson ?? JSON.stringify(value)).byteLength,
    };
  };

  function webStorage(read: () => Storage) {
    try {
      const storage = read();
      const names = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      return names.filter((name): name is string => name !== null && Boolean(matchingTerm(name))).sort().map((name, index) => {
        const label = safeName(name, index);
        const knownTranscriptSlot = /^(?:astrid|reigh):transcript-draft:[0-9a-f]{32}:[0-9a-f]{32}$/.test(name);
        if (name !== 'video-editor:draft-effects' && !knownTranscriptSlot) return { name: label, metadata: 'unknown key' };
        const raw = storage.getItem(name) ?? '';
        let row: unknown;
        try { row = JSON.parse(raw); } catch { /* The byte size is still available. */ }
        return { name: label, ...metadata(row, raw) };
      });
    } catch { return 'unavailable' as const; }
  }

  function readStore(database: IDBDatabase, store: string) {
    return new Promise<Array<ReturnType<typeof metadata> & { entry: string }>>((resolve, reject) => {
      const transaction = database.transaction(store, 'readonly');
      const request = transaction.objectStore(store).openCursor();
      const rows: Array<ReturnType<typeof metadata> & { entry: string }> = [];
      transaction.oncomplete = () => resolve(rows);
      transaction.onabort = () => reject(new Error('Could not read recovery store'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const value = recordOf(cursor.value);
          const belongsToSeed = value.timelineId === timelineId || recordOf(value.scope).timelineId === timelineId;
          const entry = cursor.primaryKey === timelineId ? 'seed-timeline-slot'
            : belongsToSeed ? `seed-timeline-entry-${rows.length}` : `entry-${rows.length}`;
          rows.push({ entry, ...metadata(cursor.value) });
          cursor.continue();
        } catch { transaction.abort(); }
      };
    });
  }

  async function readDatabases() {
    const names = (await indexedDB.databases()).flatMap(({ name }) => name && matchingTerm(name) ? [name] : []).sort();
    return Promise.all(names.map(async (name, index) => {
      const label = safeName(name, index);
      const allowedStore = databaseStores.get(name);
      if (!allowedStore) return { name: label, stores: 'unknown database' as const };
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        // A database removed after enumeration must remain absent.
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onerror = () => reject(new Error('Could not open recovery database'));
        request.onsuccess = () => resolve(request.result);
      }).catch(() => null);
      if (!database) return { name: label, stores: 'unavailable' as const };
      try {
        const stores = await Promise.all(Array.from(database.objectStoreNames).map(async (store, storeIndex) => ({
          name: safeName(store, storeIndex),
          entries: store === allowedStore ? await readStore(database, store).catch(() => 'unavailable' as const) : 'unknown store' as const,
        })));
        return { name: label, stores };
      } finally { database.close(); }
    }));
  }

  type Fiber = { return?: Fiber; memoizedProps?: { value?: { getState?: () => unknown } } };
  function editorRecoveryDraft() {
    const anchor = root.querySelector('[data-save-bar], .clip-action');
    const fiberKey = anchor && Object.keys(anchor).find((key) => key.startsWith('__reactFiber$'));
    let fiber = anchor && fiberKey ? (anchor as unknown as Record<string, Fiber>)[fiberKey] : undefined;
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
      const store = fiber.memoizedProps?.value;
      if (typeof store?.getState !== 'function') continue;
      const state = recordOf(store.getState());
      if (typeof state.syncChromeSlice !== 'function') continue;
      const draft = recordOf(state.chrome).recoveryDraft;
      if (draft === null) return null;
      const fields = recordOf(draft);
      return {
        updatedAt: timestamp(fields.updatedAt),
        baseGone: fields.baseGone === true,
        retryAllowed: typeof fields.retryAllowed === 'boolean' ? fields.retryAllowed : null,
        retainedConflict: fields.retainedConflict === true,
      };
    }
    return 'unavailable' as const;
  }

  const ui = {
    recoveryDraft: editorRecoveryDraft(),
    baseGoneBanner: Array.from(root.querySelectorAll('[data-save-bar]')).some((node) =>
      node.textContent?.includes('These changes were made on a version that no longer exists.')),
    nativeRecoveryNotice: Boolean(root.querySelector('[data-testid="timeline-command-recovery"]')),
  };
  const localStorage = webStorage(() => window.localStorage);
  const sessionStorage = webStorage(() => window.sessionStorage);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const indexedDB = await Promise.race([
      readDatabases().catch(() => 'unavailable' as const),
      new Promise<'timed out'>((resolve) => { timer = setTimeout(() => resolve('timed out'), 1500); }),
    ]);
    return { currentHeadRevisionId: revisionId(currentHeadRevisionId), ui, localStorage, sessionStorage, indexedDB };
  } finally { clearTimeout(timer); }
}

export async function captureGate5RecoveryMetadata(page: Page, input: ProbeInput) {
  try {
    return await page.locator('html').evaluate(readGate5RecoveryMetadata, input, { timeout: 2000 });
  } catch { return 'unavailable' as const; }
}
