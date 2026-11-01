import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { classifyRuntimeCommitFailure } from '@/integrations/runtime/client.ts';
import { supportsFullV2Commit } from '@/integrations/runtime/contract-metadata.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { documentPatchIntent } from './documentPatchIntent.ts';
import {
  createCommitOutbox,
  toOutboxJson,
  type ClaimedOutbox,
  type OutboxJson,
  type OutboxRecord,
  type OutboxScope,
} from './commitOutbox.ts';

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

type StoredSave = LocalSave & { kind: 'local-save'; displayBasis: TimelineCommandBasis; documentIntent?: OutboxJson };
export interface LocalSaveState {
  status: 'saved' | 'dirty' | 'saving' | 'retry' | 'conflict' | 'blocked' | 'recovery' | 'error';
  ownerId?: string;
  recoverableOwners: string[];
  error?: OutboxJson;
}

interface Options {
  scope: OutboxScope;
  initial: TimelineCommandBasis;
  document: OutboxJson;
  outboxes?: ReturnType<typeof createCommitOutbox>;
  send(request: CommitRequest, key: string): Promise<TimelineCommitResult>;
  loadLatest(): Promise<TimelineCommandBasis>;
  /** Build with the upstream editor, then return a synchronous adoption callback. */
  prepareDisplay(basis: TimelineCommandBasis, draft?: OutboxJson): Promise<{ document: OutboxJson; adopt(): void }>;
  changed(state: LocalSaveState): void;
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
const dtoGap = { code: 'commit_contract_unavailable',
  message: 'Local edit retained. Saving this edit requires the generated v2 doc.patch contract.' };

function saveOf(payload: OutboxJson): StoredSave {
  const save = payload as unknown as StoredSave;
  if (save?.kind !== 'local-save') throw new Error('This owner does not contain local editor saves');
  return save;
}

/** One existing durable owner; commands and guards are never recaptured after an ACK. */
export async function createLocalSaveSession(options: Options) {
  const storage = options.outboxes ?? createCommitOutbox();
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
  let recoveryError: unknown;
  let writeError: unknown;
  let state: LocalSaveState = { status: 'saved', recoverableOwners: [] };

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

  async function rollback() {
    const failure = record?.pending?.outcome;
    if (failure?.kind !== 'rejected') return false;
    const inverse = record?.intents.some((intent) => {
      const commands = saveOf(intent.payload).commands;
      return commands?.some((command) => command.op === 'timeline.inverse') ?? false;
    }) ?? false;
    const at = generation;
    // Retain the entire rejected chain in the outbox; only the visible preview rolls back.
    // A guarded inverse refusal is an authoritative-history conflict even
    // when Runtime reports the guard as a typed refusal/validation response;
    // the user must reload history before another undo can be offered.
    const conflict = inverse || (failure.error && typeof failure.error === 'object' && !Array.isArray(failure.error)
      && failure.error.kind === 'conflict');
    publish(conflict ? 'conflict' : 'error', failure.error);
    try {
      const latest = await options.loadLatest();
      checkBasis(latest);
      if (closed || at !== generation) return true;
      const prepared = await options.prepareDisplay(clone(latest));
      if (closed || at !== generation) return true;
      basis = clone(latest);
      displayBasis = clone(latest);
      document = toOutboxJson(prepared.document);
      prepared.adopt();
    } catch (error) {
      publish('error', { failure: failure.error, message: `Draft retained; reload failed: ${errorMessage(error)}` });
    }
    return true;
  }

  async function pump() {
    if (sending) return sending;
    sending = (async () => {
      while (!closed) {
        const at = generation;
        await writes;
        if (closed || !box || writeError) return;
        record = await box.read();
        if (at !== generation) continue;
        if (await rollback()) return;
        if (closed || writeError || at !== generation) return;
        if ((record.accepted && record.accepted.intentId !== adoptedAcceptance) || (!record.intents.length && !record.accepted)) {
          // Runtime owns suffix revalidation. Install its complete landed closure
          // before sending the next ORIGINAL intent, never execute/recapture it here.
          const prepared = await options.prepareDisplay(clone(basis));
          if (closed || writeError || at !== generation) return;
          displayBasis = clone(basis);
          document = toOutboxJson(prepared.document);
          replaying = record.intents.length > 0;
          prepared.adopt();
          adoptedAcceptance = record.accepted?.intentId;
        }
        if (closed || writeError || at !== generation) return;
        if (!record.intents.length) {
          replaying = false;
          publish('saved');
          return;
        }
        const save = saveOf(record.intents[0].payload);
        // Activate only with the normal official full-v2 generated contract.
        const fullV2 = supportsFullV2Commit();
        if ((!save.commands && !(fullV2 && save.documentIntent))
          || (!fullV2 && save.commands?.some((command) => command.op === 'doc.patch'))) { publish('blocked', dtoGap); return; }
        publish('saving');
        const acceptedId = record.accepted?.intentId;
        record = await box.dispatch((intent, head) => {
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
          return { method: 'POST',
            path: `/v1/projects/${encodeURIComponent(options.scope.projectId)}/timelines/${encodeURIComponent(options.scope.timelineId)}/commit`,
            body: toOutboxJson(request) };
        }, async (request) => {
          if (closed) return { kind: 'retry', error: { message: 'Editor closed; exact request retained' } };
          try {
            const result = await options.send(JSON.parse(request.body) as CommitRequest, request.key);
            checkBasis({ head: result.accepted, canonicalDocument: result.canonicalDocument });
            return { kind: 'accepted', head: result.accepted, value: toOutboxJson(result) };
          } catch (error) {
            const kind = error instanceof ApiError && error.status >= 500 ? 'unknown' : classifyRuntimeCommitFailure(error);
            return { kind: kind === 'unknown' || kind === 'storage' ? 'retry' : 'rejected',
              error: toOutboxJson({ kind, message: errorMessage(error),
                ...(error instanceof ApiError ? { code: error.code, details: error.details ?? null } : {}) }) };
          }
        });
        if (closed) return;
        if (record.accepted && record.accepted.intentId !== acceptedId) {
          const result = record.accepted.value as unknown as TimelineCommitResult;
          basis = { head: result.accepted, canonicalDocument: result.canonicalDocument, graph: result.graph };
        }
        if (await rollback()) return;
        if (record.pending) { publish('retry', record.pending.outcome?.kind === 'retry' ? record.pending.outcome.error : undefined); return; }
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
      state = { status: 'saved', recoverableOwners: [], ownerId: id };
      // A recovered accepted prefix must win over its old optimistic suffix,
      // including when the next request already has uncertain durable bytes.
      replaying = !!record.accepted && record.intents.length > 0;
      if (record.intents.length && !record.accepted) {
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

  const owners = (await storage.list(options.scope)).filter((owner) => owner.intents.length || owner.pending);
  state.recoverableOwners = owners.map((owner) => owner.ownerId);
  if (owners.length) publish('recovery');
  else await claim();

  function append(input: LocalSave, documentIntent?: OutboxJson): Promise<void> {
    assertOpen();
    if (writeError || ['conflict', 'error'].includes(state.status)) throw new Error('Resolve retained local saves before editing again');
    // The visible closure is now canonical, while the retained suffix still
    // describes its original local chain. Do not author a new edit between them.
    if (replaying) throw new Error('Wait for retained dependent saves to finish revalidation before editing again');
    const save = toOutboxJson({ ...input, kind: 'local-save', displayBasis,
      ...(documentIntent ? { documentIntent } : {}) }) as unknown as StoredSave;
    if (!save.label.trim() || (save.commands && !save.commands.length)) throw new Error('Local save requires a label and nonempty commands');
    if (!same(save.before, document)) throw new Error('Local save must follow the actual authored local document');
    document = clone(save.after);
    generation++;
    publish('dirty');
    const write = writes.then(async () => {
      if (writeError) throw writeError;
      record = await box!.read();
      const predecessor = record.intents[record.intents.length - 1]?.id ?? record.accepted?.intentId;
      const authoredBasis = predecessor ? { after: predecessor } : { head: basis.head };
      if (save.documentIntent) {
        save.documentIntent = toOutboxJson({ ...save.documentIntent as Record<string, OutboxJson>, basis: authoredBasis });
      }
      await box!.append(toOutboxJson(save), authoredBasis);
      record = await box!.read();
    });
    writes = write.catch((error) => {
      writeError = error;
      publish('error', { message: `Local edit could not be persisted: ${errorMessage(error)}` });
    });
    return write;
  }

  return {
    getState: () => clone(state),
    getDocument: () => clone(document),
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
    async flush() {
      assertOpen();
      await pump();
      if (writeError) throw writeError;
      if (state.status !== 'saved') throw new Error('Local saves remain unacknowledged; draft retained');
      return clone(basis);
    },
    async recover(ownerId: string) {
      if (!state.recoverableOwners.includes(ownerId)) throw new Error('Choose an explicitly listed local save owner');
      await claim(ownerId);
      await pump();
    },
    async dispose() {
      closed = true;
      try { await writes; if (writeError) throw writeError; }
      finally { release?.(); await lifetime; }
    },
  };
}

export type LocalSaveSession = Awaited<ReturnType<typeof createLocalSaveSession>>;
