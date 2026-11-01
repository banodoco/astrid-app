// Local persistence only. The Runtime adapter owns wire DTOs and response decoding.
export type OutboxJson = null | boolean | number | string | OutboxJson[] | { [key: string]: OutboxJson };

export interface OutboxScope {
  realmId: string;
  actorId: string;
  projectId: string;
  timelineId: string;
}

export interface OutboxHead {
  revisionId: string;
  publicationId: string;
}

export type OutboxBasis = { head: OutboxHead } | { after: string } | { create: true };

export interface OutboxIntent {
  id: string;
  basis: OutboxBasis;
  // Complete original commands, guards, bindings and allocated IDs, never rebased here.
  payload: OutboxJson;
  readyBase?: OutboxHead;
  conflict?: OutboxJson;
}

export interface OutboxRequest {
  method: string;
  path: string;
  body: string;
  key: string;
}

export type OutboxOutcome =
  | { kind: 'accepted'; head: OutboxHead; value: OutboxJson }
  | { kind: 'rejected'; error: OutboxJson }
  | { kind: 'retry'; error: OutboxJson };

export interface OutboxAcceptance {
  intentId: string;
  head: OutboxHead;
  value: OutboxJson;
}

export interface OutboxPlacementInput {
  request: OutboxRequest;
  head: OutboxHead;
  // Adapter-validated existing immutable pins/read closure, never a refreshed preview.
  readClosure: OutboxJson;
  ownerRef: string;
  anchor: OutboxJson;
  lane: OutboxJson;
  fallback: OutboxJson;
  policy: OutboxJson;
  output: OutboxJson;
  autoApprove: true;
  createdIds: string[];
}

export interface OutboxPlacementContinuation {
  id: string;
  input: OutboxPlacementInput;
  taskLocator?: { projectId: string; runId: string; taskId: string };
  mediaPin?: OutboxJson;
  placement?: { intentId: string; accepted?: OutboxAcceptance; cancelled?: true };
  conflict?: OutboxJson;
}

// The Agent adapter consumes the saved closure, pin and IDs; JSON storage is not authority.
export type OutboxPlacementCapture = (
  original: OutboxPlacementContinuation,
) => Promise<OutboxJson>;

export interface OutboxRecord {
  scope: OutboxScope;
  ownerId: string;
  generation: number;
  intents: OutboxIntent[];
  pending?: { intentId: string; request: OutboxRequest; outcome?: OutboxOutcome };
  // Only the last acknowledged prefix, also usable by a late dependent append.
  accepted?: OutboxAcceptance & { creation?: { payload: OutboxJson; request: OutboxRequest };
  };
  placementContinuations?: OutboxPlacementContinuation[];
  // Keep the original init link when later acknowledgements replace accepted.
  initialization?: { intent: OutboxIntent; request: OutboxRequest; head: OutboxHead; value: OutboxJson };
}

export type OutboxExclusiveLock = <T>(name: string, work: () => Promise<T>) => Promise<T>;
// Wrap original payload in the generated request at base; never refresh its guards.
export type OutboxRequestBuilder = (
  intent: OutboxIntent,
  base: OutboxHead,
) => { method: string; path: string; body: OutboxJson };

export interface ClaimedOutbox {
  read(): Promise<OutboxRecord>;
  assertActive(): void;
  reserveCreate(payload: OutboxJson, request: OutboxRequest): Promise<string>;
  append(payload: OutboxJson, basis: OutboxBasis): Promise<string>;
  cancel(intentId: string): Promise<void>;
  resolveRejected(intentIds: string[], replacement?: { payload: OutboxJson; head: OutboxHead }, isCurrent?: () => boolean): Promise<OutboxRecord>;
  reservePlacementAdmission(id: string, input: OutboxPlacementInput, assertCurrent?: () => void): Promise<OutboxPlacementContinuation>;
  recordPlacementTask(id: string, request: OutboxRequest, taskLocator: NonNullable<OutboxPlacementContinuation['taskLocator']>, assertCurrent?: () => void): Promise<OutboxPlacementContinuation>;
  recordPlacementConflict(id: string, error: OutboxJson, assertCurrent?: () => void): Promise<OutboxPlacementContinuation>;
  capturePlacement(id: string, mediaPin: OutboxJson, capture: OutboxPlacementCapture, check?: () => Promise<void>, assertCurrent?: () => void): Promise<OutboxPlacementContinuation>;
  dispatch(
    build: OutboxRequestBuilder,
    transmit: (request: OutboxRequest) => Promise<OutboxOutcome>,
    assertCurrent?: () => void,
  ): Promise<OutboxRecord>;
}

const DATABASE = 'astrid.command-outbox';
const STORE = 'owners';

const browserLock: OutboxExclusiveLock = async (name, work) => {
  if (!globalThis.navigator?.locks) throw new Error('Exclusive browser locks are unavailable');
  return await navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw new Error('Outbox is already claimed');
    return work();
  });
};

function detached<T>(value: T): T {
  const check = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const value of item) check(value); return; }
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      Object.values(item).forEach(check);
      return;
    }
    throw new Error('Outbox values must be finite JSON');
  };
  check(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Cross the durable outbox boundary without widening its finite-JSON contract. */
export function toOutboxJson(value: unknown): OutboxJson {
  // `detached` has already validated and cloned the value; this boundary
  // narrows its generic implementation result to the persisted JSON union.
  return detached(value) as OutboxJson;
}

function newIntent(payload: OutboxJson, basis: OutboxBasis): OutboxIntent {
  return detached({ id: crypto.randomUUID(), payload, basis,
    ...('head' in basis ? { readyBase: basis.head } : {}) });
}

function scopeKey(scope: OutboxScope, ownerId: string): string {
  const parts = [scope.realmId, scope.actorId, scope.projectId, scope.timelineId, ownerId];
  if (parts.some((part) => typeof part !== 'string' || !part)) throw new Error('Incomplete outbox scope');
  return JSON.stringify(parts);
}

function placementRequest(input: OutboxRequest): OutboxRequest {
  const { method, path, body, key } = input;
  if (!method || !path || !key || [method, path, body, key].some((item) => typeof item !== 'string')) {
    throw new Error('Incomplete placement admission request');
  }
  return detached({ method, path, body, key });
}

function sameRequest(a: OutboxRequest, b: OutboxRequest): boolean {
  return a.method === b.method && a.path === b.path && a.body === b.body && a.key === b.key;
}

function placementFor(record: OutboxRecord, id: string): OutboxPlacementContinuation {
  const continuation = record.placementContinuations?.find((item) => item.id === id);
  if (!continuation) throw new Error('Unknown placement continuation');
  return continuation;
}

function cancelPlacements(record: OutboxRecord, intentIds: string[]) {
  for (const continuation of record.placementContinuations ?? []) {
    if (continuation.placement && intentIds.includes(continuation.placement.intentId) && !continuation.placement.accepted) {
      continuation.placement.cancelled = true;
    }
  }
}

function placementInput(input: OutboxPlacementInput): OutboxPlacementInput {
  const { head, readClosure, ownerRef, anchor, lane, fallback, policy, output, autoApprove, createdIds } = input;
  const request = placementRequest(input.request);
  if (request.method !== 'POST' || request.path !== '/v1/tasks') throw new Error('Noncanonical task admission route');
  if (autoApprove !== true || !head || [head.revisionId, head.publicationId, ownerRef]
    .some((value) => typeof value !== 'string' || !value)
    || readClosure == null || policy == null || output == null
    || !Array.isArray(createdIds) || !createdIds.length
    || createdIds.some((value) => typeof value !== 'string' || !value)
    || new Set(createdIds).size !== createdIds.length) throw new Error('Incomplete approved placement bindings');
  return detached({ request, head: { revisionId: head.revisionId, publicationId: head.publicationId },
    readClosure, ownerRef, anchor, lane, fallback, policy, output, autoApprove, createdIds });
}

/** No cached/sessionStorage owner: every new editor starts a fresh durable owner. */
export function createCommitOutbox(options: {
  indexedDB?: IDBFactory;
  exclusiveLock?: OutboxExclusiveLock;
} = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const lock = options.exclusiveLock ?? browserLock;

  function open(): Promise<IDBDatabase> {
    if (!factory) return Promise.reject(new Error('Durable outbox storage is unavailable'));
    return new Promise((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      request.addEventListener('upgradeneeded', () => request.result.createObjectStore(STORE));
      request.addEventListener('error', () => reject(request.error));
      request.addEventListener('blocked', () => reject(new Error('Outbox database is blocked')));
      request.addEventListener('success', () => resolve(request.result));
    });
  }

  async function transaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, finish: (value: T) => void) => void,
  ): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode, { durability: 'strict' });
        let result: T;
        tx.addEventListener('complete', () => resolve(result));
        tx.addEventListener('abort', () => reject(tx.error ?? new Error('Outbox transaction aborted')));
        tx.addEventListener('error', () => reject(tx.error));
        try {
          run(tx.objectStore(STORE), (value) => { result = value; });
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  }

  async function list(scope: Pick<OutboxScope, 'realmId' | 'actorId'> & Partial<OutboxScope>): Promise<OutboxRecord[]> {
    const { realmId, actorId, projectId, timelineId } = scope;
    scopeKey({ realmId, actorId, projectId: projectId ?? '_', timelineId: timelineId ?? '_' }, '_');
    return transaction('readonly', (store, finish) => {
      const request = store.getAll();
      request.addEventListener('success', () => finish((request.result as OutboxRecord[])
        .filter((record) => record.scope.realmId === realmId && record.scope.actorId === actorId
          && (projectId === undefined || record.scope.projectId === projectId)
          && (timelineId === undefined || record.scope.timelineId === timelineId)).map(detached)));
    });
  }

  async function own<T>(
    scopeInput: OutboxScope,
    ownerId: string,
    create: boolean,
    work: (outbox: ClaimedOutbox, ownerId: string) => Promise<T>,
  ): Promise<T> {
    const { realmId, actorId, projectId, timelineId } = scopeInput;
    const scope = detached({ realmId, actorId, projectId, timelineId });
    const key = scopeKey(scope, ownerId);
    return lock(`${DATABASE}:${key}`, async () => {
      const generation = await transaction<number>('readwrite', (store, finish) => {
        const request = store.get(key);
        request.addEventListener('success', () => {
          const current = request.result as OutboxRecord | undefined;
          if (create ? !!current : !current) {
            finish(0);
            return;
          }
          const record = detached(current ?? { scope, ownerId, generation: 0, intents: [] });
          record.generation += 1;
          store.put(record, key);
          finish(record.generation);
        });
      });
      if (!generation) throw new Error('Outbox owner does not match explicit claim');
      let active = true;
      let dispatching = false;
      const capturing = new Set<string>();

      function assertActive(): void {
        if (!active) throw new Error('Stale outbox claim');
      }

      function access<T>(mode: IDBTransactionMode, change: (record: OutboxRecord) => T): Promise<T> {
        let failure: unknown;
        return transaction<T>(mode, (store, finish) => {
          const request = store.get(key);
          request.addEventListener('success', () => {
            try {
              const current = request.result as OutboxRecord | undefined;
              if (!active || current?.generation !== generation) throw new Error('Stale outbox claim');
              const record = detached(current);
              const result = change(record);
              if (mode === 'readwrite') store.put(record, key);
              finish(result);
            } catch (error) {
              // Throwing from an IDB event handler alone does not reject the caller's promise.
              failure = error;
              store.transaction.abort();
            }
          });
        }).catch((error) => { throw failure ?? error; });
      }

      const outbox: ClaimedOutbox = {
        read: () => access('readonly', detached),
        assertActive,
        async reserveCreate(payload, request) {
          const intent = newIntent(payload, { create: true });
          const exact = detached(request);
          return access('readwrite', (record) => {
            const body = JSON.parse(exact.body) as Record<string, unknown>;
            if (exact.method !== 'POST' || exact.path !== `/v1/projects/${encodeURIComponent(scope.projectId)}/timelines`
              || typeof exact.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/.test(exact.key)
              || body?.timeline_id !== scope.timelineId || Object.keys(body).some((key) => !['timeline_id', 'name'].includes(key))
              || ('name' in body && typeof body.name !== 'string')) throw new Error('Noncanonical timeline create request');
            if (record.intents.length || record.pending || record.accepted) throw new Error('Creation requires an unused outbox owner');
            record.intents.push(intent);
            record.pending = { intentId: intent.id, request: exact };
            return intent.id;
          });
        },
        async append(payload, basis) {
          if ('create' in basis) throw new Error('Creation requires an exact reserved request');
          const intent = newIntent(payload, basis);
          return access('readwrite', (record) => {
            const predecessor = record.intents[record.intents.length - 1];
            let readyBase = 'head' in intent.basis ? intent.basis.head : undefined;
            if ('after' in intent.basis && predecessor?.id !== intent.basis.after) {
              if (predecessor || record.accepted?.intentId !== intent.basis.after) {
                throw new Error('Dependent intent must follow its queued or last accepted predecessor');
              }
              readyBase = record.accepted.head;
            }
            record.intents.push({
              ...intent,
              ...(readyBase ? { readyBase } : {}),
              ...('after' in intent.basis && predecessor?.conflict !== undefined ? { conflict: predecessor.conflict } : {}),
            });
            return intent.id;
          });
        },
        cancel(intentId) {
          return access('readwrite', (record) => {
            if (record.pending?.intentId === intentId) throw new Error('Cannot cancel an uncertain request');
            if (record.intents.some((intent) => 'after' in intent.basis && intent.basis.after === intentId)) {
              throw new Error('Cannot cancel a predecessor of retained work');
            }
            record.intents = record.intents.filter((intent) => intent.id !== intentId);
            cancelPlacements(record, [intentId]);
          });
        },
        resolveRejected(intentIds, replacement, isCurrent = () => true) {
          const ids = detached(intentIds);
          const intent = replacement ? newIntent(replacement.payload, { head: replacement.head }) : undefined;
          return access('readwrite', (record) => {
            if (!isCurrent()) throw new Error('Timeline command session is closed');
            if (dispatching || record.pending?.outcome?.kind !== 'rejected'
              || record.pending.intentId !== record.intents[0]?.id) {
              throw new Error('Only a definitively rejected prefix can be resolved');
            }
            if (!ids.length || JSON.stringify(ids) !== JSON.stringify(record.intents.map((item) => item.id))) {
              throw new Error('Retained work changed before explicit resolution');
            }
            if (intent && ids.length !== 1) throw new Error('Cannot replace a predecessor of retained work');
            cancelPlacements(record, ids);
            record.intents = intent ? [intent] : [];
            delete record.pending;
            return detached(record);
          });
        },
        async reservePlacementAdmission(id, input, assertCurrent) {
          if (typeof id !== 'string' || !id) throw new Error('Missing placement continuation identity');
          const frozen = placementInput(input);
          return access('readwrite', (record) => {
            assertCurrent?.();
            const existing = record.placementContinuations?.find((item) => item.id === id);
            if (existing) {
              if (JSON.stringify(existing.input) !== JSON.stringify(frozen)) throw new Error('Placement reservation cannot change');
              return detached(existing);
            }
            if (record.intents.length || record.pending) throw new Error('Acknowledge queued work before placement admission');
            if (record.placementContinuations?.some((item) => item.input.request.key === frozen.request.key)) {
              throw new Error('Placement admission identity is already reserved');
            }
            const continuation = { id, input: frozen };
            (record.placementContinuations ??= []).push(continuation);
            return detached(continuation);
          });
        },
        async recordPlacementTask(id, requestInput, locatorInput, assertCurrent) {
          const request = placementRequest(requestInput);
          const { projectId, runId, taskId } = locatorInput;
          const locator = detached({ projectId, runId, taskId });
          if (projectId !== scope.projectId || [runId, taskId].some((value) => typeof value !== 'string' || !value)) {
            throw new Error('Incomplete or wrong-scope placement task locator');
          }
          return access('readwrite', (record) => {
            assertCurrent?.();
            const continuation = placementFor(record, id);
            if (!sameRequest(continuation.input.request, request)) throw new Error('Placement task requires the exact reserved request');
            if (continuation.taskLocator && JSON.stringify(continuation.taskLocator) !== JSON.stringify(locator)) {
              throw new Error('Placement task locator cannot change');
            }
            continuation.taskLocator = locator;
            return detached(continuation);
          });
        },
        async recordPlacementConflict(id, error, assertCurrent) {
          const conflict = detached(error);
          return access('readwrite', (record) => {
            assertCurrent?.();
            const continuation = placementFor(record, id);
            if (!continuation.placement && continuation.conflict === undefined) continuation.conflict = conflict;
            return detached(continuation);
          });
        },
        async capturePlacement(id, mediaPinInput, capture, check, assertCurrent) {
          const mediaPin = detached(mediaPinInput);
          if (mediaPin === null) throw new Error('Placement capture requires an immutable media pin');
          if (capturing.has(id)) throw new Error('Placement capture is already running');
          capturing.add(id);
          try {
            const original = await access('readwrite', (record) => {
              assertCurrent?.();
              const continuation = placementFor(record, id);
              if (!continuation.taskLocator) throw new Error('Placement capture requires the saved task locator');
              if (continuation.mediaPin !== undefined && JSON.stringify(continuation.mediaPin) !== JSON.stringify(mediaPin)) {
                throw new Error('Placement media pin cannot change');
              }
              continuation.mediaPin = mediaPin;
              return detached(continuation);
            });
            if (original.placement || original.conflict !== undefined) return original;
            await check?.();
            assertActive();
            assertCurrent?.();
            let payload: OutboxJson | undefined;
            let conflict: OutboxJson | undefined;
            try {
              payload = detached(await capture(detached(original)));
            } catch (error) {
              conflict = { reason: 'placement_capture_failed', message: error instanceof Error ? error.message : String(error) };
            }
            await check?.();
            return await access('readwrite', (record) => {
              assertCurrent?.();
              const continuation = placementFor(record, id);
              if (continuation.placement || continuation.conflict !== undefined) return detached(continuation);
              if (conflict !== undefined) continuation.conflict = conflict;
              else {
                const intentId = crypto.randomUUID();
                record.intents.push({ id: intentId, basis: { head: continuation.input.head },
                  readyBase: continuation.input.head, payload: payload! });
                continuation.placement = { intentId };
              }
              return detached(continuation);
            });
          } finally {
            capturing.delete(id);
          }
        },
        async dispatch(build, transmit, assertCurrent) {
          if (dispatching) throw new Error('Outbox request is already being transmitted');
          dispatching = true;
          try {
            const pending = await access('readwrite', (record) => {
              assertCurrent?.();
              if (record.pending) {
                if (record.pending.outcome?.kind === 'rejected') throw new Error('Outbox has a rejected prefix');
                return detached(record.pending);
              }
              const intent = record.intents[0];
              if (!intent) throw new Error('Outbox is empty');
              if (intent.conflict !== undefined || !intent.readyBase) throw new Error('Outbox intent is blocked');
              const built = detached(build(detached(intent), detached(intent.readyBase)));
              const expectedPath = `/v1/projects/${encodeURIComponent(scope.projectId)}/timelines/${encodeURIComponent(scope.timelineId)}/commit`;
              if (built.method !== 'POST' || built.path !== expectedPath) throw new Error('Noncanonical commit route');
              record.pending = {
                intentId: intent.id,
                request: { method: built.method, path: built.path, body: JSON.stringify(built.body), key: crypto.randomUUID() },
              };
              return detached(record.pending);
            });
            // The reservation's transaction has completed before any network callback.
            assertActive();
            assertCurrent?.();
            let outcome: OutboxOutcome;
            try {
              outcome = detached(await transmit(detached(pending.request)));
            } catch {
              outcome = { kind: 'retry', error: { reason: 'transport_error' } };
            }
            return await access('readwrite', (record) => {
              // Retry bookkeeping keeps the exact uncertain request; only a live identity may consume it.
              if (outcome.kind !== 'retry') assertCurrent?.();
              if (record.pending?.request.key !== pending.request.key
                || record.intents[0]?.id !== pending.intentId) throw new Error('Stale outbox completion');
              if (outcome.kind === 'accepted') {
                const intent = record.intents[0];
                record.accepted = { intentId: pending.intentId, head: outcome.head, value: outcome.value,
                  ...('create' in intent.basis ? { creation: { payload: intent.payload, request: pending.request } } : {}) };
                for (const continuation of record.placementContinuations ?? []) {
                  if (continuation.placement?.intentId === pending.intentId) continuation.placement.accepted = record.accepted;
                }
                if (intent.payload !== null && typeof intent.payload === 'object' && !Array.isArray(intent.payload)
                  && intent.payload.kind === 'timeline-init' && !record.initialization) {
                  record.initialization = { intent, request: pending.request, head: outcome.head, value: outcome.value };
                }
                record.intents.shift();
                delete record.pending;
                const next = record.intents[0];
                if (next && 'after' in next.basis && next.basis.after === pending.intentId) {
                  next.readyBase = outcome.head;
                }
              } else {
                record.pending.outcome = outcome;
                if (outcome.kind === 'rejected') {
                  const rejected = new Set([pending.intentId]);
                  for (const intent of record.intents) {
                    if (rejected.has(intent.id) || ('after' in intent.basis && rejected.has(intent.basis.after))) {
                      intent.conflict = outcome.error;
                      rejected.add(intent.id);
                    }
                  }
                }
              }
              return detached(record);
            });
          } finally {
            dispatching = false;
          }
        },
      };
      try {
        return await work(outbox, ownerId);
      } finally {
        active = false;
      }
    });
  }

  return {
    list,
    create: <T>(scope: OutboxScope, work: (outbox: ClaimedOutbox, ownerId: string) => Promise<T>) =>
      own(scope, crypto.randomUUID(), true, work),
    recover: <T>(scope: OutboxScope, ownerId: string, work: (outbox: ClaimedOutbox) => Promise<T>) =>
      own(scope, ownerId, false, work),
  };
}
