import { ApiError, type WorkspaceClient, type Task, type ManagedOutput } from '@/integrations/runtime/generated.ts';
import type { MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  createCommitOutbox,
  type ClaimedOutbox,
  type OutboxPlacementInput,
  type OutboxPlacementContinuation,
  type OutboxPlacementCapture,
  type OutboxRequest,
  type OutboxRequestBuilder,
  type OutboxIntent,
  type OutboxHead,
  type OutboxOutcome,
  type OutboxScope,
} from './commitOutbox.ts';

type Admission = Parameters<WorkspaceClient['admitTask']>[0];
type Identity = Pick<OutboxScope, 'realmId' | 'actorId'>;
type Client = Pick<WorkspaceClient, 'admitTask' | 'getTask' | 'listManagedOutputs' | 'getProjectMediaSelection'> & {
  getProjectVerifiedMedia?: WorkspaceClient['getProjectVerifiedMedia'];
  // A host using the existing App route preserves its already-normalized bytes on lost-ACK replay.
  admitPreparedTask?(request: OutboxRequest): Promise<Task>;
  isTaskSubmissionActive?(request: OutboxRequest): boolean;
  // The authenticated host adapter checks its live lifecycle, including invalidation, synchronously.
  // A generated client or a cached handshake alone cannot supply this binding.
  isCurrentIdentity?(expected: Identity): boolean;
};
type Output = { group_key: string; variant_key: string; output_port: string; ordinal: number };
export type PlacementRequest = Omit<OutboxPlacementInput, 'output'> & { output: Output };
export type PlacementCaptureContext = {
  client: Pick<Client, 'getProjectVerifiedMedia'>;
  check(): Promise<void>;
  assertCurrent(): void;
};
// Opt in explicitly; existing callbacks keep their exact two-argument contract.
export type PlacementRequesterCapture = ((original: OutboxPlacementContinuation, scope: OutboxScope,
  context?: PlacementCaptureContext) => ReturnType<OutboxPlacementCapture>) & { requesterContext?: true };
export type PlacementProgress = {
  ownerId: string;
  scope: OutboxScope;
  id?: string;
  status: 'manual' | 'waiting' | 'retry' | 'conflict' | 'queued' | 'accepted' | 'cancelled';
  message?: string;
  continuation?: OutboxPlacementContinuation;
};

/** Matches generated admitTask serialization. */
export function preparePlacementTask(input: Admission, key: string): OutboxRequest {
  return { method: 'POST', path: '/v1/tasks', body: JSON.stringify({ schema_version: '1', ...input }), key };
}

class PlacementRefusal extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlacementRefusal('Missing exact task/output binding');
  return value as Record<string, unknown>;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new PlacementRefusal('Missing exact publication list');
  return value.map(object);
}
function one<T>(values: T[]): T {
  if (values.length !== 1) throw new PlacementRefusal('Approved output is absent or ambiguous');
  return values[0];
}
function output(value: unknown): Output {
  const v = object(value);
  if (['group_key', 'variant_key', 'output_port'].some((key) => typeof v[key] !== 'string' || !v[key])
    || !Number.isSafeInteger(v.ordinal) || (v.ordinal as number) < 0) throw new PlacementRefusal('Incomplete approved output selector');
  return { group_key: v.group_key as string, variant_key: v.variant_key as string,
    output_port: v.output_port as string, ordinal: v.ordinal as number };
}
function matches(v: Record<string, unknown>, selected: Output): boolean {
  return Object.entries(selected).every(([key, value]) => v[key] === value);
}
function admission(input: OutboxPlacementInput, scope: OutboxScope): Admission {
  const request = input.request;
  let decoded: unknown;
  try { decoded = JSON.parse(request.body); }
  catch { throw new PlacementRefusal('Malformed saved task admission'); }
  const value = object(decoded) as Admission;
  if (request.method !== 'POST' || request.path !== '/v1/tasks' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/.test(request.key)
    || JSON.stringify(value) !== request.body || value.schema_version !== '1'
    || value.project !== scope.projectId || !value.capability_id || !value.capability_digest
    || !Array.isArray(value.input_object_ids)) throw new PlacementRefusal('Not an exact prepared normal task admission');
  const selected = output(input.output);
  const effect = object(value.settlement_effect);
  const payload = object(effect.payload);
  if (effect.effect_type === 'generation.publish_v1') {
    if (effect.target_id !== scope.projectId) throw new PlacementRefusal('Wrong publication project');
    const group = one(rows(payload.groups).filter((group) => group.group_key === selected.group_key));
    one(rows(group.selectors).filter((v) => matches({ ...v, group_key: group.group_key }, selected)));
  } else if (effect.effect_type === 'generation.create_with_variant' || effect.effect_type === 'generation.variant.append') {
    if (payload.output_name !== selected.output_port || payload.output_ordinal !== selected.ordinal) {
      throw new PlacementRefusal('Output does not match admitted publication');
    }
  } else throw new PlacementRefusal('Task does not declare a supported generation publication');
  return value;
}
function validateTask(task: Task, original: OutboxPlacementContinuation, scope: OutboxScope): void {
  const prepared = admission(original.input, scope);
  if (!task.task_id || !task.run_id || task.project_id !== scope.projectId
    || task.idempotency_key !== original.input.request.key || task.capability_id !== prepared.capability_id
    || task.capability_digest !== prepared.capability_digest
    || (original.taskLocator && (task.task_id !== original.taskLocator.taskId || task.run_id !== original.taskLocator.runId))) {
    throw new PlacementRefusal('Task does not match original requester admission/locator');
  }
}
function publishedVariant(task: Task, selected: Output): Record<string, unknown> {
  const result = object(task.result);
  if (result.generation_publish_v1 !== undefined) {
    const group = one(rows(object(result.generation_publish_v1).publications).filter((v) => v.group_key === selected.group_key));
    return one(rows(group.variants).filter((v) => v.output_port === selected.output_port
      && v.ordinal === selected.ordinal && v.variant_key === selected.variant_key && v.generation_id === group.generation_id));
  }
  const variant = object(result.generation_variant);
  const metadata = object(variant.metadata);
  if (metadata.output_name !== selected.output_port || metadata.output_ordinal !== selected.ordinal
    || metadata.source_task_id !== task.task_id) throw new PlacementRefusal('Wrong published variant');
  return variant;
}
function selectionPin(value: MediaSelection, variant: Record<string, unknown>): MediaSelection {
  if (Object.keys(object(value)).length !== 5 || ['asset', 'generation_id', 'variant_id', 'object_id', 'catalog_digest']
    .some((key) => typeof value[key as keyof MediaSelection] !== 'string' || !value[key as keyof MediaSelection])
    || value.asset !== variant.variant_id || value.generation_id !== variant.generation_id || value.variant_id !== variant.variant_id
    || !/^sha256:[0-9a-f]{64}$/.test(value.object_id) || !/^sha256:[0-9a-f]{64}$/.test(value.catalog_digest)
    || value.object_id !== variant.object_id) throw new PlacementRefusal('Media selection differs from exact task publication');
  return { asset: value.asset, generation_id: value.generation_id, variant_id: value.variant_id,
    object_id: value.object_id, catalog_digest: value.catalog_digest };
}

/** Explicit, finite requester passes; no editor, event cache, timer or new authority. */
export function createPlacementRequester(options: {
  client: Client;
  getRecoverableIdentity(): Promise<Identity>;
  outboxes?: ReturnType<typeof createCommitOutbox>;
  // Existing storage semantic port plus its saved owner scope, never the active editor.
  capture?: PlacementRequesterCapture;
  // The claimed editor session drains captured intents through its normal pump.
  deferCommit?: boolean;
  build(intent: OutboxIntent, head: OutboxHead, scope: OutboxScope): ReturnType<OutboxRequestBuilder>;
  transmit(request: OutboxRequest, scope: OutboxScope): Promise<OutboxOutcome>;
}) {
  const storage = options.outboxes ?? createCommitOutbox();
  function assertCurrent(scope: OutboxScope, box?: ClaimedOutbox) {
    box?.assertActive();
    if (!options.client.isCurrentIdentity) throw new Error('Authenticated requester identity lifecycle binding is unavailable');
    try {
      if (options.client.isCurrentIdentity(scope) !== true) throw new Error('Identity lifecycle is not current');
    } catch { throw new Error('Authenticated requester identity changed or is unavailable'); }
  }
  async function authorize(scope: OutboxScope, box?: ClaimedOutbox) {
    let identity: Identity;
    try { identity = await options.getRecoverableIdentity(); }
    catch { throw new Error('Authenticated requester identity is unavailable'); }
    if (!identity.realmId || !identity.actorId || identity.realmId !== scope.realmId || identity.actorId !== scope.actorId) {
      throw new Error('Authenticated requester identity changed');
    }
    // Read through the live claim after identity work; a saved generation is not authority.
    if (box) await box.read();
    assertCurrent(scope, box);
  }
  async function selectedMedia(task: Task, original: OutboxPlacementContinuation, scope: OutboxScope, box: ClaimedOutbox): Promise<MediaSelection> {
    if (!task.attempt_id) throw new PlacementRefusal('Completed task has no settled attempt');
    const selected = output(original.input.output);
    const variant = publishedVariant(task, selected);
    const candidates: ManagedOutput[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let count = 0; count < 100; count += 1) {
      await authorize(scope, box);
      assertCurrent(scope, box);
      const page = await options.client.listManagedOutputs(task.task_id, cursor);
      candidates.push(...page.items.filter((v) => matches(v, selected)));
      if (page.next_cursor === null) {
        const managed = one(candidates);
        const lifecycle = object(managed.lifecycle);
        if (typeof managed.association_id !== 'string' || !managed.association_id
          || managed.project_id !== scope.projectId || managed.task_id !== task.task_id || managed.run_id !== task.run_id
          || managed.attempt_id !== task.attempt_id || managed.object_id !== variant.object_id
          || managed.durability !== 'durable' || ['thumbnail', 'manifest', 'recoverable_snapshot'].includes(managed.role)
          || !['available', 'promoted'].includes(lifecycle.state as string)
          || !Number.isSafeInteger(lifecycle.version) || (lifecycle.version as number) < 1) {
          throw new PlacementRefusal('Managed output differs from the completed task/publication');
        }
        await authorize(scope, box);
        assertCurrent(scope, box);
        return selectionPin(await options.client.getProjectMediaSelection(scope.projectId, {
          association_id: managed.association_id, object_id: managed.object_id, version: lifecycle.version as number,
        }), variant);
      }
      if (!page.next_cursor || seen.has(page.next_cursor)) throw new PlacementRefusal('Managed output cursor did not advance');
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
    throw new PlacementRefusal('Managed output discovery exceeded the finite page limit');
  }
  async function advance(box: ClaimedOutbox, id: string): Promise<PlacementProgress> {
    let record = await box.read();
    const { ownerId } = record;
    const scope = Object.freeze({ ...record.scope });
    await authorize(scope);
    let original = record.placementContinuations?.find((v) => v.id === id);
    if (!original) throw new Error('Unknown placement continuation');
    const progress = (status: PlacementProgress['status'], message?: string): PlacementProgress => ({
      scope, ownerId, id, status, continuation: original, ...(message ? { message } : {}),
    });
    try {
      await box.read();
      if (original.placement?.accepted) return progress('accepted');
      if (original.placement?.cancelled) return progress('cancelled');
      if (original.conflict !== undefined) return progress('conflict');
      if (!original.placement) {
        const prepared = admission(original.input, scope);
        if (!original.taskLocator) {
          await authorize(scope, box);
          assertCurrent(scope, box);
          const request = original.input.request;
          if (options.client.isTaskSubmissionActive?.(request)) return progress('waiting');
          if (!options.client.admitPreparedTask && preparePlacementTask(prepared, request.key).body !== request.body) {
            throw new Error('Exact prepared task replay binding is unavailable');
          }
          const task = options.client.admitPreparedTask
            ? await options.client.admitPreparedTask(request)
            : await options.client.admitTask(prepared, request.key);
          validateTask(task, original, scope);
          await authorize(scope, box);
          original = await box.recordPlacementTask(id, original.input.request, {
            projectId: scope.projectId, taskId: task.task_id, runId: task.run_id,
          }, () => assertCurrent(scope, box));
        }
        await authorize(scope, box);
        assertCurrent(scope, box);
        const task = await options.client.getTask(original.taskLocator!.taskId);
        await authorize(scope, box);
        validateTask(task, original, scope);
        if (task.state === 'failed' || task.state === 'cancelled' || task.state === 'cancel_requested') {
          throw new PlacementRefusal(`Task ${task.state}; placement requires manual review`);
        }
        if (task.state !== 'succeeded') return progress('waiting');
        if (!options.capture) return progress('manual', 'Authoritative Agent automatic placement capture is unavailable');
        const pin = await selectedMedia(task, original, scope, box);
        if (original.mediaPin !== undefined && JSON.stringify(original.mediaPin) !== JSON.stringify(pin)) {
          throw new PlacementRefusal('Saved immutable media selection changed');
        }
        await authorize(scope, box);
        original = await box.capturePlacement(id, pin, (saved) => options.capture!.requesterContext ? options.capture!(saved, scope, {
          client: options.client, check: () => authorize(scope, box), assertCurrent: () => assertCurrent(scope, box),
        }) : options.capture!(saved, scope),
          () => authorize(scope, box), () => assertCurrent(scope, box));
        if (original.conflict !== undefined) return progress('conflict');
      }
      if (original.placement?.accepted) return progress('accepted');
      if (original.placement?.cancelled) return progress('cancelled');
      record = await box.read();
      const intent = record.intents.find((v) => v.id === original!.placement?.intentId);
      if (intent?.conflict !== undefined) return progress('conflict');
      if (record.intents[0]?.id !== intent?.id || !intent) return progress('queued');
      if (options.deferCommit) return progress('queued');
      await authorize(scope, box);
      record = await box.dispatch((intent, head) => options.build(intent, head, scope), async (request) => {
        await authorize(scope, box);
        assertCurrent(scope, box);
        try { return await options.transmit(request, scope); }
        finally { await authorize(scope, box); }
      }, () => assertCurrent(scope, box));
      original = record.placementContinuations!.find((v) => v.id === id)!;
      return progress(original.placement?.accepted ? 'accepted'
        : record.pending?.outcome?.kind === 'rejected' ? 'conflict' : 'retry');
    } catch (error) {
      try {
        await authorize(scope, box);
        if (error instanceof PlacementRefusal || (error instanceof ApiError && error.status < 500 && ![408, 429].includes(error.status))) {
          original = await box.recordPlacementConflict(id, { reason: 'placement_refused', message: error.message }, () => assertCurrent(scope, box));
          return progress('conflict', error.message);
        }
      } catch (interrupted) {
        return progress('retry', interrupted instanceof Error ? interrupted.message : String(interrupted));
      }
      return progress('retry', error instanceof Error ? error.message : String(error));
    }
  }
  return {
    async request(box: ClaimedOutbox, id: string, input: PlacementRequest) {
      const { scope } = await box.read();
      await authorize(scope, box);
      admission(input, scope);
      // No task POST may run until this strict-durability transaction completes.
      await box.reservePlacementAdmission(id, input, () => assertCurrent(scope, box));
      return advance(box, id);
    },
    async resume(box: ClaimedOutbox) {
      const record = await box.read();
      await authorize(record.scope, box);
      const results: PlacementProgress[] = [];
      for (const continuation of record.placementContinuations ?? []) results.push(await advance(box, continuation.id));
      return results;
    },
    async recover() {
      const identity = await options.getRecoverableIdentity();
      const owners = await storage.list(identity);
      const results: PlacementProgress[] = [];
      for (const owner of owners) {
        if (!owner.placementContinuations?.length) {
          results.push({ scope: owner.scope, ownerId: owner.ownerId, status: 'manual', message: 'No saved requester approval; manual placement only' });
          continue;
        }
        try {
          await authorize(owner.scope);
          await storage.recover(owner.scope, owner.ownerId, async (box) => {
            const saved = await box.read();
            for (const continuation of saved.placementContinuations ?? []) results.push(await advance(box, continuation.id));
          });
        } catch (error) {
          results.push({ scope: owner.scope, ownerId: owner.ownerId, status: 'retry', message: error instanceof Error ? error.message : String(error) });
        }
      }
      return results;
    },
  };
}
