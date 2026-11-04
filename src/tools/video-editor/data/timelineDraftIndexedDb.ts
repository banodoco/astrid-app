/**
 * One-slot timeline draft store (plan-v5 B9, minimal form).
 *
 * A single coalesced "latest document draft + base version" per timeline,
 * persisted to IndexedDB. Written on mutation/save-as-copy, cleared only by an
 * acknowledged save receipt. After a crash / offline edit / reload the editor
 * offers Retry or Save as copy from the draft. This is deliberately NOT an
 * outbox: no ULIDs, no ordering, no automatic replay.
 */

import type { TimelineHeadRevision } from '@/tools/video-editor/data/DataProvider.ts';

const DATABASE_NAME = 'astrid.timeline-drafts';
const DATABASE_VERSION = 1;
const DRAFT_STORE_NAME = 'timeline-drafts';

export interface TimelineDraftRecord {
  /** `${timelineId}` — one slot per timeline. */
  key: string;
  timelineId: string;
  draft: Record<string, unknown>;
  baseVersion: number;
  /**
   * Identifies the mutation that owns this one-slot draft. Save acknowledgements
   * use it as a compare-and-delete fence so an older request can never erase a
   * draft written by a newer edit (including undo/redo).
   */
  ownerId?: string;
  updatedAt: string;
  baseHeadRevisionId?: string | null;
  /** Scope evidence for immutable-head recovery; legacy unscoped heads are untrusted. */
  baseHeadProjectId?: string;
  baseHeadTimelineId?: string;
  baseCanonicalGraph?: Record<string, unknown>;
  draftIdentity?: string;
  acknowledgementIdentity?: string;
  /** Exact durable outbox owner that captured this slot, when proven. */
  outboxOwnerId?: string;
}

export interface TimelineDraftRecoveryMetadata {
  recoveryKey?: string;
  /** Compare-and-delete owner for editor save acknowledgements. */
  ownerId?: string;
  baseHeadRevisionId?: string | null;
  baseHeadProjectId?: string;
  baseHeadTimelineId?: string;
  baseCanonicalGraph?: Record<string, unknown>;
  draftIdentity?: string;
  acknowledgementIdentity?: string;
}

/**
 * Move a queued descendant draft onto the immutable head acknowledged by its
 * predecessor. The compare is deliberately scoped by owner and full head
 * identity: an older ACK must never rewrite a newer edit or a draft from
 * another project/timeline.
 */
export async function advanceTimelineDraftBaseAfterHeadAcknowledgement(
  recoveryKey: string,
  ownerId: string,
  expectedHead: TimelineHeadRevision,
  acknowledgedHead: TimelineHeadRevision,
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const database = await openDatabase();
  const advanced = await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = store.get(buildKey(recoveryKey));
    let updated = false;
    request.addEventListener('success', () => {
      const current = request.result as TimelineDraftRecord | undefined;
      if (!current
        || current.ownerId !== ownerId
        || current.baseHeadProjectId !== expectedHead.projectId
        || current.baseHeadTimelineId !== expectedHead.timelineId
        || current.baseHeadRevisionId !== expectedHead.headRevisionId) return;

      store.put({
        ...current,
        baseHeadProjectId: acknowledgedHead.projectId,
        baseHeadTimelineId: acknowledgedHead.timelineId,
        baseHeadRevisionId: acknowledgedHead.headRevisionId,
      });
      updated = true;
    });
    request.addEventListener('error', () => reject(request.error));
    transaction.addEventListener('complete', () => resolve(updated));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
  database.close();
  return advanced;
}

function getIndexedDb(): IDBFactory {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment');
  }
  return indexedDB;
}

function openDatabase(): Promise<IDBDatabase> {
  const indexedDb = getIndexedDb();
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);

    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        database.createObjectStore(DRAFT_STORE_NAME, { keyPath: 'key' });
      }
    });

    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
}

function buildKey(timelineId: string): string {
  return timelineId;
}

function createDraftRecord(
  timelineId: string,
  draft: Record<string, unknown>,
  baseVersion: number,
  recoveryMetadata: TimelineDraftRecoveryMetadata,
): TimelineDraftRecord {
  return {
    key: buildKey(recoveryMetadata.recoveryKey ?? timelineId),
    timelineId,
    draft,
    baseVersion,
    updatedAt: new Date().toISOString(),
    ...(recoveryMetadata.ownerId === undefined ? {} : { ownerId: recoveryMetadata.ownerId }),
    ...(recoveryMetadata.baseHeadRevisionId !== undefined
      ? { baseHeadRevisionId: recoveryMetadata.baseHeadRevisionId }
      : {}),
    ...(recoveryMetadata.baseHeadProjectId !== undefined ? { baseHeadProjectId: recoveryMetadata.baseHeadProjectId } : {}),
    ...(recoveryMetadata.baseHeadTimelineId !== undefined ? { baseHeadTimelineId: recoveryMetadata.baseHeadTimelineId } : {}),
    ...(recoveryMetadata.baseCanonicalGraph
      ? { baseCanonicalGraph: recoveryMetadata.baseCanonicalGraph }
      : {}),
    ...(recoveryMetadata.draftIdentity ? { draftIdentity: recoveryMetadata.draftIdentity } : {}),
    ...(recoveryMetadata.acknowledgementIdentity
      ? { acknowledgementIdentity: recoveryMetadata.acknowledgementIdentity }
      : {}),
  };
}

export type TimelineDraftOwnershipConflictMerge = (
  current: TimelineDraftRecord,
  candidate: TimelineDraftRecord,
) => TimelineDraftRecord;

/**
 * Atomically compare the durable owner and replace the record. A conflict
 * merge, when supplied, runs inside the same read-write transaction, so a
 * newer draft cannot arrive between the ownership read and the write.
 */
export async function saveTimelineDraftIfOwner(
  timelineId: string,
  draft: Record<string, unknown>,
  baseVersion: number,
  recoveryMetadata: TimelineDraftRecoveryMetadata,
  expectedDraftIdentity: string | null,
  mergeOnOwnershipConflict?: TimelineDraftOwnershipConflictMerge,
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') {
    return false;
  }
  const database = await openDatabase();
  const candidate = createDraftRecord(timelineId, draft, baseVersion, recoveryMetadata);
  const saved = await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = store.get(buildKey(candidate.key));
    let result = false;
    request.addEventListener('success', () => {
      const current = request.result as TimelineDraftRecord | undefined;
      const ownsRecord = expectedDraftIdentity === null
        ? current === undefined
        : current?.draftIdentity === expectedDraftIdentity;
      if (ownsRecord) {
        store.put(candidate);
        result = true;
      } else if (current && mergeOnOwnershipConflict) {
        store.put(mergeOnOwnershipConflict(current, candidate));
      }
    });
    request.addEventListener('error', () => reject(request.error));
    transaction.addEventListener('complete', () => resolve(result));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
  database.close();
  return saved;
}

export async function saveTimelineDraft(
  timelineId: string,
  draft: Record<string, unknown>,
  baseVersion: number,
  recoveryMetadata: TimelineDraftRecoveryMetadata = {},
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  const database = await openDatabase();
  const record = createDraftRecord(timelineId, draft, baseVersion, recoveryMetadata);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
    transaction.objectStore(DRAFT_STORE_NAME).put(record);
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () => reject(transaction.error));
  });
  database.close();
}

export async function loadTimelineDraft(
  timelineId: string,
): Promise<TimelineDraftRecord | null> {
  if (typeof indexedDB === 'undefined') {
    return null;
  }
  const database = await openDatabase();
  const record = await new Promise<TimelineDraftRecord | undefined>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE_NAME, 'readonly');
    const request = transaction.objectStore(DRAFT_STORE_NAME).get(buildKey(timelineId));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
  database.close();
  return record ?? null;
}

export async function clearTimelineDraft(timelineId: string, expectedOwnerId?: string): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    if (expectedOwnerId === undefined) {
      store.delete(buildKey(timelineId));
    } else {
      const request = store.get(buildKey(timelineId));
      request.addEventListener('success', () => {
        const current = request.result as TimelineDraftRecord | undefined;
        if (current?.ownerId === expectedOwnerId) {
          store.delete(buildKey(timelineId));
        }
      });
    }
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () => reject(transaction.error));
  });
  database.close();
}

/** Delete only the exact draft identity acknowledged by a completed save. */
export async function clearTimelineDraftIfMatches(
  recoveryKey: string,
  acknowledgementIdentity: string,
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const database = await openDatabase();
  const cleared = await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = store.get(buildKey(recoveryKey));
    let matched = false;
    request.addEventListener('success', () => {
      const current = request.result as TimelineDraftRecord | undefined;
      if (current?.acknowledgementIdentity === acknowledgementIdentity) {
        matched = true;
        store.delete(buildKey(recoveryKey));
      }
    });
    request.addEventListener('error', () => reject(request.error));
    transaction.addEventListener('complete', () => resolve(matched));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
  database.close();
  return cleared;
}

/**
 * Advance a newer recovery draft to a head acknowledged by its own pending
 * publication. The owner/config are preserved; only a draft still based on
 * the acknowledged request's expected head is eligible for this rebase.
 */
export async function advanceTimelineDraftBaseAfterAcknowledgement(
  recoveryKey: string,
  expectedHeadRevisionId: string,
  acknowledgedHeadRevisionId: string,
  acknowledgedGraph: Record<string, unknown>,
  acknowledgementIdentity: string,
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const database = await openDatabase();
  const advanced = await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = store.get(buildKey(recoveryKey));
    let updated = false;
    request.addEventListener('success', () => {
      const current = request.result as TimelineDraftRecord | undefined;
      if (!current
        || current.baseHeadRevisionId !== expectedHeadRevisionId
        || current.acknowledgementIdentity === acknowledgementIdentity) return;

      const draftConfig = current.draft.config;
      if (draftConfig && typeof draftConfig === 'object' && !Array.isArray(draftConfig)) {
        const config = draftConfig as Record<string, unknown>;
        const app = config.app && typeof config.app === 'object' && !Array.isArray(config.app)
          ? config.app as Record<string, unknown>
          : null;
        const canonical = app?.canonicalComposition
          && typeof app.canonicalComposition === 'object'
          && !Array.isArray(app.canonicalComposition)
          ? app.canonicalComposition as Record<string, unknown>
          : null;
        if (canonical?.headRevisionId === expectedHeadRevisionId) {
          store.put({
            ...current,
            draft: {
              ...current.draft,
              config: {
                ...config,
                app: {
                  ...app,
                  canonicalComposition: {
                    ...canonical,
                    headRevisionId: acknowledgedHeadRevisionId,
                  },
                },
              },
            },
            baseHeadRevisionId: acknowledgedHeadRevisionId,
            baseCanonicalGraph: acknowledgedGraph,
          });
          updated = true;
        }
      }
    });
    request.addEventListener('error', () => reject(request.error));
    transaction.addEventListener('complete', () => resolve(updated));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
  database.close();
  return advanced;
}

/**
 * Reconcile only the canonical-head marker of a recovery draft whose durable
 * graph has already been validated by its provider as the recorded CAS base.
 * Compare the recovery owner and base in the same transaction so a newer edit
 * or a genuinely stale draft cannot be rewritten by an older popup load.
 */
export async function reconcileTimelineDraftHeadMarker(
  recoveryKey: string,
  draftIdentity: string,
  baseHeadRevisionId: string,
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const database = await openDatabase();
  const reconciled = await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = store.get(buildKey(recoveryKey));
    let updated = false;
    request.addEventListener('success', () => {
      const current = request.result as TimelineDraftRecord | undefined;
      if (!current
        || current.draftIdentity !== draftIdentity
        || current.baseHeadRevisionId !== baseHeadRevisionId) return;

      const draftConfig = current.draft.config;
      if (!draftConfig || typeof draftConfig !== 'object' || Array.isArray(draftConfig)) return;
      const config = draftConfig as Record<string, unknown>;
      const app = config.app && typeof config.app === 'object' && !Array.isArray(config.app)
        ? config.app as Record<string, unknown>
        : null;
      const canonical = app?.canonicalComposition
        && typeof app.canonicalComposition === 'object'
        && !Array.isArray(app.canonicalComposition)
        ? app.canonicalComposition as Record<string, unknown>
        : null;
      if (!app || !canonical || canonical.headRevisionId === baseHeadRevisionId) return;

      store.put({
        ...current,
        draft: {
          ...current.draft,
          config: {
            ...config,
            app: {
              ...app,
              canonicalComposition: { ...canonical, headRevisionId: baseHeadRevisionId },
            },
          },
        },
      });
      updated = true;
    });
    request.addEventListener('error', () => reject(request.error));
    transaction.addEventListener('complete', () => resolve(updated));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
  database.close();
  return reconciled;
}

/** Associate a slot with its durable outbox only if that exact save still owns it. */
export async function bindTimelineDraftOutboxOwner(recoveryKey: string, draftOwnerId: string, outboxOwnerId: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') throw new Error('Durable timeline recovery is unavailable');
  const database = await openDatabase();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(DRAFT_STORE_NAME);
      const request = store.get(buildKey(recoveryKey));
      let bound = false;
      request.addEventListener('success', () => {
        const current = request.result as TimelineDraftRecord | undefined;
        if (!current || current.ownerId !== draftOwnerId) return;
        store.put({ ...current, outboxOwnerId });
        bound = true;
      });
      request.addEventListener('error', () => reject(request.error));
      transaction.addEventListener('complete', () => resolve(bound));
      transaction.addEventListener('error', () => reject(transaction.error));
      transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Draft owner binding aborted')));
    });
  } finally { database.close(); }
}

/** Clear only the recovery snapshot observed by an explicit reload/discard. */
export async function clearTimelineDraftIfSnapshotMatches(
  recoveryKey: string,
  snapshot: Pick<TimelineDraftRecord, 'updatedAt' | 'draftIdentity'> & Partial<Pick<TimelineDraftRecord, 'ownerId' | 'outboxOwnerId'>>,
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const database = await openDatabase();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(DRAFT_STORE_NAME);
      const request = store.get(buildKey(recoveryKey));
      let matched = false;
      request.addEventListener('success', () => {
        const current = request.result as TimelineDraftRecord | undefined;
        if (current?.updatedAt === snapshot.updatedAt
          && current.draftIdentity === snapshot.draftIdentity
          && (!('ownerId' in snapshot) || current.ownerId === snapshot.ownerId)
          && (!('outboxOwnerId' in snapshot) || current.outboxOwnerId === snapshot.outboxOwnerId)) {
          matched = true;
          store.delete(buildKey(recoveryKey));
        }
      });
      request.addEventListener('error', () => reject(request.error));
      transaction.addEventListener('complete', () => resolve(matched));
      transaction.addEventListener('error', () => reject(transaction.error));
      transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Draft deletion aborted')));
    });
  } finally { database.close(); }
}
