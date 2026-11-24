import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { classifyRuntimeCommitFailure, type RuntimeCommitFailureKind } from '@/integrations/runtime/client.ts';
import { supportsFullV2Commit } from '@/integrations/runtime/contract-metadata.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { hasOutboxRecoveryDraft } from '../data/timelineDraftIndexedDb.ts';
import { documentPatchIntent } from './documentPatchIntent.ts';
import { recordTimelineSaveMark } from '../lib/timeline-save-marks.ts';
import {
  createCommitOutbox,
  toOutboxJson,
  type ClaimedOutbox,
  type OutboxJson,
  type OutboxIntent,
  type OutboxRecord,
  type OutboxScope,
} from './commitOutbox.ts';

/**
 * A new edit was declined because earlier retained saves are still unresolved or replaying. It never entered
 * the queue, so the caller undoes it on screen and says why. Plan 18 CC-5 deletes the declines: a new edit then
 * queues behind the retained ones. (Awaiting the replay here is not enough: the edit was authored on the
 * handoff's chain, which only a flush re-bases, so it would fail the same-document check once the replay ends.)
 */
export class LocalSaveDeclined extends Error {}

/** Authored bytes supplied by the local editor, never produced by an executor here. */
export interface LocalSave {
  before: OutboxJson;
  after: OutboxJson;
  label: string;
  commands?: CommitRequest['commands'];
  reads?: CommitRequest['reads'];
  steps?: CommitRequest['steps'];
  rationale?: CommitRequest['rationale'];
  group_id?: CommitRequest['group_id'];
}

type StoredSave = LocalSave & {
  kind: 'local-save';
  displayBasis: TimelineCommandBasis;
  documentIntent?: OutboxJson;
  sourceKey?: string;
};
export interface LocalSaveState {
  status: 'saved' | 'dirty' | 'saving' | 'retry' | 'conflict' | 'blocked' | 'recovery' | 'error';
  ownerId?: string;
  recoverableOwners: string[];
  error?: OutboxJson;
  /** User-facing reason for a change that was removed from the queue; cleared by the next acknowledged save. */
  notice?: string;
}

interface Options {
  scope: OutboxScope;
  sourceKey?: string;
  initial: TimelineCommandBasis;
  document: OutboxJson;
  outboxes?: ReturnType<typeof createCommitOutbox>;
  /** Let a tab continue independently when it cannot claim the retained owner it found. */
  skipRetainedOwners?: boolean;
  send(request: CommitRequest, key: string): Promise<TimelineCommitResult>;
  loadLatest(): Promise<TimelineCommandBasis>;
  /** Build with the upstream editor, then return a synchronous adoption callback. */
  prepareDisplay(basis: TimelineCommandBasis, draft?: OutboxJson): Promise<{ document: OutboxJson; adopt(): void }>;
  changed(state: LocalSaveState): void;
  /** Called each time an intent is accepted: the save is making progress. */
  progress?(): void;
}

const same = (a: OutboxJson, b: OutboxJson): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]));
};
const clone = <T>(value: T): T => structuredClone(value);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const rejectionKind = (error: OutboxJson | undefined): string | undefined => error && typeof error === 'object' && !Array.isArray(error) && typeof error.kind === 'string'
  ? error.kind : undefined;
const rejectionMessage = (error: OutboxJson | undefined): string => error && typeof error === 'object' && !Array.isArray(error) && typeof error.message === 'string'
  ? error.message : 'This change could not be saved.';
const PERMANENT_REJECTION_KINDS = new Set([
  'too_large', 'validation', 'authorization', 'unsupported_route', 'rejected_request', 'refused',
]);
function permanentRejection(record: OutboxRecord | undefined) {
  const pending = record?.pending;
  return pending?.outcome?.kind === 'rejected'
    && PERMANENT_REJECTION_KINDS.has(rejectionKind(pending.outcome.error) ?? '')
    ? { request: pending.request, error: pending.outcome.error } : undefined;
}

/** Identifies the exact outbox prefix and suffix in a downloaded file. */
export interface RejectedSaveReceipt {
  requestKey: string;
  intentIds: string[];
}

/** Only the owner of a permanently refused save may offer copy or explicit discard. */
export function isPermanentLocalSaveRejection(state: LocalSaveState | null | undefined): boolean {
  return (state?.status === 'error' || state?.status === 'conflict')
    && PERMANENT_REJECTION_KINDS.has(rejectionKind(state.error) ?? '');
}

/** User-facing reason for a permanent rejection; undefined keeps the raw error message. */
function permanentRejectionMessage(kind: RuntimeCommitFailureKind, error: unknown): string | undefined {
  if (kind === 'too_large') {
    const details = error instanceof ApiError ? error.details : undefined;
    const limit = typeof details?.max_bytes === 'number' ? ` The limit is ${details.max_bytes} bytes.`
      : typeof details?.limit === 'number' ? ` The limit is ${details.limit}.` : '';
    return `This change is too large to save.${limit} Your changes are kept here but have not been saved.`;
  }
  if (kind === 'unsupported_route') return 'This version of Astrid does not support this save. Your changes are kept but not saved until Astrid is updated.';
  if (kind === 'rejected_request' || kind === 'refused') return `${errorMessage(error)}. Your changes are kept but not saved.`;
  if (kind === 'validation') return `The Runtime rejected this change as invalid: ${errorMessage(error)}. Your changes are kept here but have not been saved.`;
  if (kind === 'authorization') return 'The Runtime did not authorize this save. Your changes are kept here but have not been saved.';
  return undefined;
}
const dtoGap = { code: 'commit_contract_unavailable',
  message: 'Local edit retained. Saving this edit requires the generated v2 doc.patch contract.' };

function saveOf(payload: OutboxJson): StoredSave {
  const save = payload as unknown as StoredSave;
  if (save?.kind !== 'local-save') throw new Error('This owner does not contain local editor saves');
  return save;
}

// A lone track-name draft can remain on its original displayed basis while the
// conflict is resolved. Other edit shapes still require canonical rollback.
function isSingleTrackLabelDraft(record: OutboxRecord): boolean {
  if (record.intents.length !== 1) return false;
  const intent = saveOf(record.intents[0].payload).documentIntent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return false;
  const changes = intent.changes;
  if (!Array.isArray(changes) || changes.length !== 1) return false;
  const change = changes[0];
  if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
  const path = change.path;
  return change.op === 'set' && change.ref === 'parent' && Array.isArray(path)
    && path.length === 4 && path[0] === 'config' && path[1] === 'tracks'
    && typeof path[2] === 'string' && path[2].startsWith('id:') && path[3] === 'label'
    && typeof change.value === 'string';
}

/** One existing durable owner; commands and guards are never recaptured after an ACK. */
export async function createLocalSaveSession(options: Options) {
  const storage = options.outboxes ?? createCommitOutbox({
    isRecoveryOwner: hasOutboxRecoveryDraft,
  });
  let basis = clone(options.initial);
  let displayBasis = clone(options.initial);
  let document = toOutboxJson(options.document);
  let box: ClaimedOutbox | undefined;
  let record: OutboxRecord | undefined;
  let closed = false;
  let release: (() => void) | undefined;
  let lifetime: Promise<unknown> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  let sending: Promise<void> | undefined;
  let generation = 0;
  let adoptedAcceptance: string | undefined;
  let replaying = false;
  let rejectedDisplayReady = false;
  let recoveryError: unknown;
  let writeError: unknown;
  let state: LocalSaveState = { status: 'saved', recoverableOwners: [] };
  // An unavailable Runtime is retried on its own, doubling the wait up to 30 s; Try again retries at once.
  const RETRY_FIRST_MS = 1000;
  const RETRY_MAX_MS = 30_000;
  let retryDelay = RETRY_FIRST_MS;
  // Bumped first thing by Discard: a send loop that started before it must not dispatch another request.
  let discardEpoch = 0;
  let discarding = false;
  let changingOwner = false;
  const recoveryWrites = new Set<Promise<void>>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  function scheduleRetry() {
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!closed && box && state.status === 'retry') void pump().catch(() => {});
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  function publish(status: LocalSaveState['status'], error?: OutboxJson) {
    if (closed) return;
    state = { ...state, status, ...(error === undefined ? {} : { error }) };
    if (error === undefined) delete state.error;
    options.changed(clone(state));
  }
  function assertOpen() {
    if (!closed && recoveryError) throw recoveryError;
    if (closed || !box) throw new Error('Local save session is closed or awaiting recovery');
  }
  function checkBasis(value: TimelineCommandBasis) {
    if (!value.head.revisionId || !value.head.publicationId
      || value.canonicalDocument.project_id !== options.scope.projectId
      || value.canonicalDocument.timeline_id !== options.scope.timelineId
      || value.canonicalDocument.parent_revision.revision_id !== value.head.revisionId) {
      throw new Error('Canonical reply does not match the local save scope and landed head');
    }
  }
  checkBasis(basis);

  // Reload the canonical head into the display and basis. Shared by every rejected path.
  async function resetToCanonical(at: number) {
    const latest = await options.loadLatest();
    checkBasis(latest);
    if (closed || at !== generation) return;
    const prepared = await options.prepareDisplay(clone(latest));
    if (closed || at !== generation) return;
    basis = clone(latest);
    displayBasis = clone(latest);
    document = toOutboxJson(prepared.document);
    prepared.adopt();
  }

  // A permanently rejected request is never retried or removed automatically.
  // Show the exact authored suffix on its original verified head, including edits
  // made on top of the rejected change. The durable outbox remains untouched.
  async function restoreRejectedDraft(at: number) {
    if (!record?.intents.length) return;
    const first = saveOf(record.intents[0].payload);
    const last = saveOf(record.intents[record.intents.length - 1].payload);
    const prepared = await options.prepareDisplay(clone(first.displayBasis), clone(last.after));
    if (closed || at !== generation) return;
    displayBasis = clone(first.displayBasis);
    document = clone(last.after);
    prepared.adopt();
    rejectedDisplayReady = true;
  }

  // Resend the rejected chain unchanged, on the head the Runtime has now. The Runtime revalidates the
  // original commands there; a real clash comes back as a new refusal the user can discharge.
  async function rebaseOntoLatest() {
    const latest = await options.loadLatest();
    checkBasis(latest);
    if (closed) throw new Error('Local save session is closed');
    record = await box!.rebaseRejected(record!.intents.map((intent) => intent.id), latest.head, () => !closed);
  }

  async function rollback() {
    const failure = record?.pending?.outcome;
    if (failure?.kind !== 'rejected') return false;
    const inverse = record?.intents.some((intent) => {
      const commands = saveOf(intent.payload).commands;
      return commands?.some((command) => command.op === 'timeline.inverse') ?? false;
    }) ?? false;
    const at = generation;
    const permanent = permanentRejection(record);
    // Retain the entire rejected chain in the outbox.
    // A guarded inverse refusal is an authoritative-history conflict even
    // when Runtime reports the guard as a typed refusal/validation response;
    // the user must reload history before another undo can be offered.
    const conflict = inverse || (failure.error && typeof failure.error === 'object' && !Array.isArray(failure.error)
      && failure.error.kind === 'conflict');
    publish(conflict ? 'conflict' : 'error', failure.error);
    // Permanent 4xx: preserve both the original rejected change and all edits
    // on top, visually and in the outbox, across a reload. Never send it again.
    if (!conflict && permanent) {
      try { await restoreRejectedDraft(at); }
      catch (error) {
        const original = permanent.error;
        if (closed || at !== generation) return true;
        publish('error', { ...(original && typeof original === 'object' && !Array.isArray(original) ? original : {}),
          message: `${rejectionMessage(original)} Local change retained; preview could not be restored: ${errorMessage(error)}` });
      }
      return true;
    }
    // Conflict: keep the original intent and head together while showing the
    // authoritative latest version. A track-label draft can stay visible.
    if (conflict && record && isSingleTrackLabelDraft(record)) return true;
    try {
      await resetToCanonical(at);
    } catch (error) {
      if (closed || at !== generation) return true;
      if (permanent) {
        publish('conflict', toOutboxJson({ ...permanent.error as object,
          message: `${rejectionMessage(permanent.error)} Saved history could not be reloaded: ${errorMessage(error)}` }));
      } else {
        publish('error', { failure: failure.error, message: `Draft retained; reload failed: ${errorMessage(error)}` });
      }
    }
    return true;
  }

  // The optional trace belongs to this flush, never to durable intent bytes.
  async function pump(traceId?: string) {
    if (sending) return sending;
    if (discarding || changingOwner) return;
    sending = (async () => {
      const epoch = discardEpoch;
      while (!closed && epoch === discardEpoch) {
        const at = generation;
        await writes;
        if (closed || !box || writeError) return;
        recordTimelineSaveMark(traceId, 'outbox-read-start');
        record = await box.read();
        recordTimelineSaveMark(traceId, 'outbox-read-end');
        if (at !== generation) continue;
        if (await rollback()) return;
        if (closed || writeError || at !== generation) return;
        // While edits are still queued, the screen keeps showing the person's own latest document: an accept only
        // advances the base the next record is sent on (`basis`, above). The server's document is taken when the
        // queue is empty. Runtime owns suffix revalidation, so the next ORIGINAL intent is sent as stored and never
        // recaptured here; nothing about the send reads the screen. (Plan 63 CC-5b / Plan 18 TL-5 make this exact.)
        if (!record.intents.length && (!record.accepted || record.accepted.intentId !== adoptedAcceptance)) {
          recordTimelineSaveMark(traceId, 'prepare-display-start');
          const prepared = await options.prepareDisplay(clone(basis));
          recordTimelineSaveMark(traceId, 'prepare-display-end');
          if (closed || writeError || at !== generation) return;
          displayBasis = clone(basis);
          document = toOutboxJson(prepared.document);
          replaying = false;
          recordTimelineSaveMark(traceId, 'adopt-start');
          prepared.adopt();
          recordTimelineSaveMark(traceId, 'adopt-end');
          adoptedAcceptance = record.accepted?.intentId;
        }
        if (closed || writeError || at !== generation) return;
        if (!record.intents.length) {
          replaying = false;
          recordTimelineSaveMark(traceId, 'local-status-saved');
          publish('saved');
          return;
        }
        const save = saveOf(record.intents[0].payload);
        // Activate only with the normal official full-v2 generated contract.
        const fullV2 = supportsFullV2Commit();
        if ((!save.commands && !(fullV2 && save.documentIntent))
          || (!fullV2 && save.commands?.some((command) => command.op === 'doc.patch'))) { publish('blocked', dtoGap); return; }
        if (epoch !== discardEpoch) return;
        publish('saving');
        const acceptedId = record.accepted?.intentId;
        record = await box.dispatch((intent, head) => {
          recordTimelineSaveMark(traceId, 'request-build-start');
          const original = saveOf(intent.payload);
          const patch = original.documentIntent as Record<string, OutboxJson> | undefined;
          const commands: CommitRequest['commands'] = original.commands ?? [{ schema_version: 1,
            op: 'doc.patch', version: '1', select: null, created: patch!.created as string[], args: { changes: patch!.changes } }];
          // Only the base pair advances. Original operands, reads, step IDs and
          // allocated entity IDs come directly from the persisted intent.
          const metadata = patch ? { steps: [{ ...patch.step as Record<string, OutboxJson>,
            command_ordinals: [0], patch: patch.changes }],
            merge: patch.merge ?? (patch.reads === undefined ? 'atomic' : 'fields'),
            ...(patch.reads === undefined ? {} : { reads: patch.reads }) }
            : { steps: original.steps ?? [{ id: intent.id, label: original.label, intent: original.label, tags: [],
              command_ordinals: commands.map((_, index) => index), patch: [] }], merge: 'fields',
              ...(original.reads === undefined ? {} : { reads: original.reads }) };
          const request: CommitRequest = { api_version: 1, project_id: options.scope.projectId, timeline_id: options.scope.timelineId,
            base_revision_id: head.revisionId, base_publication_id: head.publicationId,
            commands, source: { via: 'app' } };
          Object.assign(request, { label: original.label, dry_run: false });
          if (original.rationale !== undefined) request.rationale = original.rationale;
          if (original.group_id !== undefined) request.group_id = original.group_id;
          if (fullV2) Object.assign(request, metadata);
          const built = { method: 'POST' as const,
            path: `/v1/projects/${encodeURIComponent(options.scope.projectId)}/timelines/${encodeURIComponent(options.scope.timelineId)}/commit`,
            body: toOutboxJson(request) };
          recordTimelineSaveMark(traceId, 'request-build-end');
          return built;
        }, async (request) => {
          // dispatch invokes transmit only after its reservation transaction.
          recordTimelineSaveMark(traceId, 'request-reserved');
          if (closed) return { kind: 'retry', error: { message: 'Editor closed; exact request retained' } };
          try {
            recordTimelineSaveMark(traceId, 'request-parse-start');
            const parsed = JSON.parse(request.body) as CommitRequest;
            recordTimelineSaveMark(traceId, 'request-parse-end');
            const result = await options.send(parsed, request.key);
            recordTimelineSaveMark(traceId, 'accepted-value-start');
            checkBasis({ head: result.accepted, canonicalDocument: result.canonicalDocument });
            const value = toOutboxJson(result);
            recordTimelineSaveMark(traceId, 'accepted-value-end');
            return { kind: 'accepted', head: result.accepted, value };
          } catch (error) {
            const kind = error instanceof ApiError && error.status >= 500 ? 'unknown' : classifyRuntimeCommitFailure(error);
            return { kind: kind === 'unknown' || kind === 'storage' ? 'retry' : 'rejected',
              error: toOutboxJson({ kind, message: permanentRejectionMessage(kind, error) ?? errorMessage(error),
                ...(error instanceof ApiError ? { code: error.code, details: error.details ?? null } : {}) }) };
          }
        });
        if (closed) return;
        if (record.accepted && record.accepted.intentId !== acceptedId) {
          recordTimelineSaveMark(traceId, 'accepted-durable');
          const result = record.accepted.value as unknown as TimelineCommitResult;
          basis = { head: result.accepted, canonicalDocument: result.canonicalDocument, graph: result.graph };
          delete state.notice;
          options.progress?.();
        }
        if (await rollback()) return;
        if (record.pending) {
          publish('retry', record.pending.outcome?.kind === 'retry' ? record.pending.outcome.error : undefined);
          scheduleRetry();
          return;
        }
        retryDelay = RETRY_FIRST_MS;
      }
    })().catch((error) => {
      publish('error', { message: errorMessage(error) });
      throw error;
    }).finally(() => { sending = undefined; });
    return sending;
  }

  async function claim(ownerId?: string) {
    if (closed || lifetime) throw new Error('Local save owner is closed or already claimed');
    let ready!: () => void;
    let fail!: (error: unknown) => void;
    const mounted = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    const hold = async (claimed: ClaimedOutbox, id: string) => {
      record = await claimed.read();
      // A valid accepted prefix cannot authenticate the original dependent drafts.
      for (const intent of record.intents) {
        try { checkBasis(saveOf(intent.payload).displayBasis); }
        catch { throw new Error('Local saves require a verified original display basis for recovery'); }
      }
      if (record.accepted) {
        const result = record.accepted.value as unknown as TimelineCommitResult;
        basis = { head: result.accepted, canonicalDocument: result.canonicalDocument, graph: result.graph };
        checkBasis(basis);
      }
      box = claimed;
      state = { status: 'saved', recoverableOwners: state.recoverableOwners.filter((owner) => owner !== id), ownerId: id };
      // A recovered accepted prefix must win over its old optimistic suffix,
      // including when the next request already has uncertain durable bytes.
      replaying = !!record.accepted && record.intents.length > 0;
      if (record.intents.length && !record.accepted && !permanentRejection(record)) {
        displayBasis = clone(saveOf(record.intents[0].payload).displayBasis);
        checkBasis(displayBasis);
        document = clone(saveOf(record.intents[record.intents.length - 1].payload).after);
        const prepared = await options.prepareDisplay(clone(displayBasis), clone(document));
        if (!closed) prepared.adopt();
      }
      recoveryError = undefined;
      publish(record.intents.length ? 'dirty' : 'saved');
      ready();
      await new Promise<void>((resolve) => { release = resolve; if (closed) resolve(); });
    };
    lifetime = (ownerId ? storage.recover(options.scope, ownerId, (claimed) => hold(claimed, ownerId))
      : storage.create(options.scope, hold)).catch((error) => { fail(error); });
    try { await mounted; }
    catch (error) {
      await lifetime;
      box = undefined;
      lifetime = undefined;
      recoveryError = error;
      publish('error', { message: errorMessage(error) });
      throw error;
    }
  }

  // A retained row from a previous realm may still be the creator's only copy.
  if (!options.skipRetainedOwners) await storage.prune(options.scope).catch(() => {});
  const owners = (await storage.list(options.scope)).filter((owner) => owner.intents.length || owner.pending);
  state.recoverableOwners = owners.map((owner) => owner.ownerId);
  if (owners.length && !options.skipRetainedOwners) publish('recovery');
  else await claim();

  function append(input: LocalSave, documentIntent?: OutboxJson): Promise<void> {
    assertOpen();
    if (discarding || changingOwner) throw new LocalSaveDeclined('Wait for the saved timeline to reload before editing again');
    // A displayed permanently refused chain can accept dependent edits without retrying it.
    const retaining = state.status === 'error' && isPermanentLocalSaveRejection(state) && rejectedDisplayReady
      && (documentIntent !== undefined || Boolean(input.commands?.length));
    if (writeError || state.status === 'conflict' || (state.status === 'error' && !retaining)) throw new LocalSaveDeclined('Resolve retained local saves before editing again');
    if (replaying && !retaining) throw new LocalSaveDeclined('Wait for retained dependent saves to finish revalidation before editing again');
    const save = toOutboxJson({ ...input, kind: 'local-save', displayBasis,
      ...(options.sourceKey ? { sourceKey: options.sourceKey } : {}),
      ...(documentIntent ? { documentIntent } : {}) }) as unknown as StoredSave;
    if (!save.label.trim() || (save.commands && !save.commands.length)) throw new Error('Local save requires a label and nonempty commands');
    if (!same(save.before, document)) throw new Error('Local save must follow the actual authored local document');
    document = clone(save.after);
    generation++;
    if (!retaining) publish('dirty');
    const write = writes.then(async () => {
      if (writeError) throw writeError;
      record = await box!.read();
      const predecessor = record.intents[record.intents.length - 1]?.id ?? record.accepted?.intentId;
      const authoredBasis = predecessor ? { after: predecessor } : { head: basis.head };
      if (save.documentIntent) {
        save.documentIntent = toOutboxJson({ ...save.documentIntent as Record<string, OutboxJson>, basis: authoredBasis });
      }
      // No read-back here: it re-transfers the whole record (every queued document) once per edit, and pump reads
      // the record itself before anything is sent.
      await box!.append(toOutboxJson(save), authoredBasis);
    });
    writes = write.catch((error) => {
      writeError = error;
      publish('error', { message: `Local edit could not be persisted: ${errorMessage(error)}` });
    });
    return write;
  }

  return {
    /** The actor whose edits this session's Undo/Redo may target. */
    actorId: options.scope.actorId,
    getState: () => clone(state),
    getBasis: () => clone(basis),
    /** The original verified read basis used to restore an unsaved rejected change. */
    getDisplayBasis: () => clone(displayBasis),
    getDocument: () => clone(document),
    // A guarded track rename can keep its authored display after recovery.
    // Tell the handoff when that display belongs to the retained draft.
    hasRejectedDisplay: () => rejectedDisplayReady || Boolean(
      state.status === 'conflict' && record && isSingleTrackLabelDraft(record)
      && same(document, saveOf(record.intents[0].payload).after),
    ),
    /** Hold the owner's claim through any draft write that records its ID. */
    async writeRecoveryDraft(write: (ownerId?: string) => Promise<void>) {
      const ownerId = !closed && !discarding && !changingOwner && box ? state.ownerId : undefined;
      if (!ownerId) return write();
      const task = write(ownerId);
      recoveryWrites.add(task);
      try { await task; }
      finally { recoveryWrites.delete(task); }
    },
    /** Verified physical images with locally authored payloads; still an unsent intent. */
    appendDocument(input: Omit<Parameters<typeof documentPatchIntent>[0], 'basis'>): Promise<void> {
      assertOpen();
      // Validate before changing the local chain. The durable predecessor is
      // filled by append's serialized write, never by a refreshed head read.
      const intent = documentPatchIntent({ ...input, basis: { head: displayBasis.head } });
      if (!same(toOutboxJson(input.before), document)) throw new Error('Local save must follow the actual authored local document');
      if (!intent) return Promise.resolve();
      return append({ before: toOutboxJson(input.before), after: toOutboxJson(input.after), label: input.label }, intent);
    },
    /** Capture synchronously before another local edit; persist every intent before submitting. */
    append: (input: LocalSave) => append(input),
    async flush(traceId?: string) {
      assertOpen();
      recordTimelineSaveMark(traceId, 'local-flush-start');
      await pump(traceId);
      if (writeError) throw writeError;
      if (state.status !== 'saved') throw new Error('Local saves remain unacknowledged; draft retained');
      recordTimelineSaveMark(traceId, 'flush-basis-start');
      const snapshot = clone(basis);
      recordTimelineSaveMark(traceId, 'flush-basis-end');
      return snapshot;
    },
    /** Only an explicit 'latest' choice can remove the offered owner and its edits. */
    async discharge(mode: 'latest' | 'keep', exported?: RejectedSaveReceipt, stillCurrent = () => true) {
      assertOpen();
      if (discarding) throw new LocalSaveDeclined('The saved timeline is already reloading');
      if (mode === 'keep') {
        clearRetry();
        await sending?.catch(() => {});
        await writes;
        assertOpen();
        record = await box!.read();
        if (permanentRejection(record)) {
          throw new Error('This save was permanently rejected. Copy my change out, or explicitly discard and reload.');
        }
        if (record.pending?.outcome?.kind === 'rejected') {
          const error = record.pending.outcome.error;
          const details = error && typeof error === 'object' && !Array.isArray(error) ? error.details : undefined;
          // A value conflict already identifies an incompatible original operand. Keep its rejected request and
          // canonical display intact; rebasing that same operand would turn it into a permanent validation refusal.
          if (error && typeof error === 'object' && !Array.isArray(error) && error.kind === 'conflict'
            && details && typeof details === 'object' && !Array.isArray(details)
            && details.status === 'conflict' && details.reason === 'value_conflict') return;
          await rebaseOntoLatest();
          publish('dirty');
        }
        // A transport retry keeps the exact pending request and idempotency key.
        await pump();
        return;
      }

      // An in-flight request may finish. Do not dispatch its suffix or let
      // another capture change the owner's contents while Discard is running.
      discarding = true;
      discardEpoch++;
      clearRetry();
      try {
        await sending?.catch(() => {});
        clearRetry();
        await writes;
        await Promise.allSettled(recoveryWrites);
        if (closed) return;
        const owner = box!;
        const offered = await owner.read();
        if (exported && (offered.pending?.request.key !== exported.requestKey
          || !same(offered.intents.map((intent) => intent.id), exported.intentIds))) {
          throw new Error('Your unsaved edits changed. Copy them again before reloading.');
        }
        if (!offered.intents.length && !offered.pending && !writeError) return;

        // Build the replacement before touching durable work. The owner claim
        // and exact record are rechecked in the same transaction as deletion.
        const latest = await options.loadLatest();
        checkBasis(latest);
        const prepared = await options.prepareDisplay(clone(latest));
        const canonicalDocument = toOutboxJson(prepared.document);
        const siblings = (await storage.list(options.scope))
          .filter((row) => row.ownerId !== offered.ownerId && (row.intents.length || row.pending))
          .map((row) => row.ownerId);
        const canResolve = () => !closed && box === owner && stillCurrent();
        if (!canResolve()) throw new Error('Your unsaved edits changed during reload.');
        await owner.discard(offered, canResolve);

        release?.();
        await lifetime;
        box = undefined;
        lifetime = undefined;
        release = undefined;
        if (closed) return;
        basis = clone(latest);
        displayBasis = clone(latest);
        document = canonicalDocument;
        if (stillCurrent()) prepared.adopt();
        writeError = undefined;
        recoveryError = undefined;
        rejectedDisplayReady = false;
        replaying = false;
        adoptedAcceptance = undefined;
        retryDelay = RETRY_FIRST_MS;
        state.recoverableOwners = siblings;
        // Future edits belong to a fresh owner. The discarded claim never
        // recreates the old row, even if its former snapshot is retried.
        await claim();
      } finally {
        discarding = false;
        if (state.status === 'retry' && !closed) scheduleRetry();
      }
    },
    /** Downloadable, self-contained original intent chain; nothing is consumed. */
    async exportRejectedChange() {
      assertOpen();
      if (sending) await sending.catch(() => {});
      await writes;
      const current = await box!.read();
      const pending = permanentRejection(current);
      if (!pending || current.intents.length === 0) throw new Error('There is no permanently rejected change to copy');
      const last = saveOf(current.intents[current.intents.length - 1].payload);
      return {
        format: 'astrid.rejected-local-save/v1',
        scope: { project_id: options.scope.projectId, timeline_id: options.scope.timelineId },
        rejection: pending.error ?? null,
        rejected_request: { method: pending.request.method, path: pending.request.path,
          key: pending.request.key, body: pending.request.body },
        edits: current.intents.map(({ id, basis: originalBasis, payload }) => ({ id, basis: originalBasis, payload })),
        final_document: last.after,
      };
    },
    async recoverRejected(matchesLegacy: (intent: OutboxIntent) => boolean) {
      if (state.status !== 'recovery') return;
      const candidate = (await storage.list(options.scope)).find((owner) =>
        state.recoverableOwners.includes(owner.ownerId) && permanentRejection(owner)
        && owner.intents.length > 0 && owner.intents.every((intent) => {
          const payload = intent.payload as Partial<StoredSave> | null;
          return payload?.kind === 'local-save' && (payload.sourceKey === undefined
            ? matchesLegacy(intent) : payload.sourceKey === options.sourceKey);
        }));
      if (candidate && state.status === 'recovery') {
        await claim(candidate.ownerId);
        await pump();
      }
    },
    async recover(ownerId: string) {
      if (discarding || changingOwner) throw new Error('The timeline owner is already changing');
      if (!state.recoverableOwners.includes(ownerId)) throw new Error('Choose an explicitly listed local save owner');
      if (box) {
        // Several editor sessions can each leave work behind. Recover them one at a time, each only
        // after the previous owner has fully settled, so a later one is rebased onto what landed.
        if (state.status !== 'saved') throw new Error('Finish the current owner before recovering another');
        const remaining = state.recoverableOwners;
        changingOwner = true;
        await Promise.allSettled(recoveryWrites);
        release?.();
        await lifetime;
        box = undefined; lifetime = undefined; release = undefined;
        state = { ...state, status: 'recovery', recoverableOwners: remaining };
      }
      try { await claim(ownerId); }
      finally { changingOwner = false; }
      await pump();
    },
    /** Stops a waiting automatic retry now (Discard must not race it). */
    cancelRetry: clearRetry,
    async dispose() {
      closed = true;
      clearRetry();
      try { await writes; if (writeError) throw writeError; }
      finally {
        await Promise.allSettled(recoveryWrites);
        release?.();
        await lifetime;
      }
    },
  };
}

export type LocalSaveSession = Awaited<ReturnType<typeof createLocalSaveSession>>;
