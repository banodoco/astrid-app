// This suite remains large because placement behavior spans these cohorts: admission/recovery, task/output selection,
// claim/microtask handoff, lifecycle fences, interruption/retry, durable conflicts, and residual counterexamples.
import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { WorkspaceClient, type Task, type ManagedOutput, type Transport } from '@/integrations/runtime/generated.ts';
import { createCommitOutbox, type ClaimedOutbox, type OutboxExclusiveLock, type OutboxOutcome,
  type OutboxPlacementCapture, type OutboxRequest, type OutboxIntent, type OutboxHead, type OutboxScope } from './commitOutbox.ts';
import { createPlacementRequester, preparePlacementTask, type PlacementRequest } from './placementRequester.ts';

const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project', timelineId: 'original-timeline' };
const head = { revisionId: 'R0', publicationId: 'P0' };
const selected = { group_key: 'pictures', variant_key: 'approved', output_port: 'image', ordinal: 1 };
const objectId = `sha256:${'a'.repeat(64)}`;
const pin = { asset: 'variant', generation_id: 'generation', variant_id: 'variant', object_id: objectId,
  catalog_digest: `sha256:${'b'.repeat(64)}` };
const prepared = preparePlacementTask({
  capability_id: 'image.generate', capability_digest: `sha256:${'c'.repeat(64)}`, project: scope.projectId,
  input_object_ids: [], spec: { prompt: 'original prompt' },
  settlement_effect: { effect_type: 'generation.publish_v1', target_id: scope.projectId, payload: {
    version: 1, modality: 'image', generation_type: 'image', metadata: {}, partial_success_policy: 'reject',
    groups: [{ group_key: selected.group_key, selectors: [{ variant_key: selected.variant_key, output_port: selected.output_port,
      ordinal: selected.ordinal, selector: 'requested' }] }],
  } },
}, 'original-task-key');
const input: PlacementRequest = { request: prepared, head, readClosure: { immutable: ['original-read-pin'] },
  ownerRef: 'parent', anchor: { ref: 'parent/clip:anchor' }, lane: { ref: 'parent/track:lane' }, fallback: null,
  policy: { placement: 'anchor-after', fallback: 'append', image: 'completion-five-second' },
  output: selected, autoApprove: true, createdIds: ['allocated-birth'] };
const completed: Task = {
  task_id: 'task', run_id: 'run', project_id: scope.projectId, state: 'succeeded', version: 9,
  capability_id: 'image.generate', capability_digest: `sha256:${'c'.repeat(64)}`, idempotency_key: prepared.key,
  created_at: '', updated_at: '', attempt_id: 'settled-attempt', runtime_epoch: 1, input_object_ids: [], spec: {},
  result: { generation_publish_v1: { publications: [{ group_key: selected.group_key, generation_id: 'generation',
    variants: [{ ...selected, variant_id: 'variant', generation_id: 'generation', object_id: objectId }] }] } },
};
const managed: ManagedOutput = { ...selected, association_id: 'association', project_id: scope.projectId,
  task_id: 'task', run_id: 'run', attempt_id: 'settled-attempt', selector: { group_key: selected.group_key, variant_key: selected.variant_key }, object_id: objectId,
  digest: objectId, manifest_ref: null, size: 4, filename: 'image.png', media_type: 'image/png', role: 'output',
  producer: {}, provenance: {}, durability: 'durable', state: 'available', version: 99,
  lifecycle: { version: 3, state: 'available' } };
const acceptance = (name: string): OutboxOutcome => ({ kind: 'accepted', head: { revisionId: `R${name}`, publicationId: `P${name}` }, value: { accepted: name } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function environment() {
  const factory = createFakeIndexedDB();
  const fault: { abortNextWrite: boolean; beforeWrite?: () => void } = { abortNextWrite: false };
  const open = factory.open.bind(factory);
  // Match the rollback fixture in commitOutbox.test.ts; this fake needs explicit rollback.
  factory.open = (...args: unknown[]) => {
    const request = open(...args);
    request.addEventListener('success', () => {
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (store: string, mode: string) => {
        const tx = transaction(store, mode);
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name: string) => {
          const value = objectStore(name);
          const get = value.get.bind(value);
          value.get = (key: string) => {
            const request = get(key);
            if (mode === 'readwrite') request.addEventListener('success', () => {
              const beforeWrite = fault.beforeWrite;
              delete fault.beforeWrite;
              beforeWrite?.();
            });
            return request;
          };
          return value;
        };
        const records = db.recordsByStore.get(store);
        const before = new Map(records);
        const dispatch = tx.dispatch.bind(tx);
        let aborted = false;
        tx.dispatch = (type: string, event: unknown) => {
          if (type === 'complete' && !aborted && mode === 'readwrite' && fault.abortNextWrite) {
            fault.abortNextWrite = false;
            tx.abort();
            return;
          }
          if (type === 'abort') {
            aborted = true;
            records.clear();
            for (const [key, value] of before) records.set(key, value);
          }
          if (type === 'complete' && aborted) return;
          dispatch(type, event);
        };
        return tx;
      };
    });
    return request;
  };
  const held = new Set<string>();
  const exclusiveLock: OutboxExclusiveLock = async (name, work) => {
    if (held.has(name)) throw new Error('Outbox is already claimed');
    held.add(name);
    try { return await work(); } finally { held.delete(name); }
  };
  const storage = () => createCommitOutbox({ indexedDB: factory, exclusiveLock });
  const state = { task: structuredClone(completed), pages: [[structuredClone(managed)]], pin: { ...pin },
    identity: { realmId: scope.realmId, actorId: scope.actorId }, admissionFailure: 0, readFailure: 0, lostAdmission: false };
  const calls: { method: string; path: string; body?: string; key?: string }[] = [];
  const transport: Transport = vi.fn(async (method, path, headers, bytes) => {
    calls.push({ method, path, body: bytes ? new TextDecoder().decode(bytes as Uint8Array) : undefined, key: headers['Idempotency-Key'] });
    let body: unknown;
    let status = 200;
    if (method === 'POST') {
      if (state.lostAdmission) { state.lostAdmission = false; throw new Error('Lost task ACK'); }
      status = state.admissionFailure || 201;
      body = status === 201 ? { data: state.task, receipt: { receipt_id: 'task-receipt' } }
        : { code: 'admission_refused', message: 'original admission rejected' };
    } else if (path.includes('managed-outputs')) {
      const pageIndex = Number(new URL(path, 'http://fixture').searchParams.get('cursor') ?? '0');
      body = { items: state.pages[pageIndex], next_cursor: pageIndex + 1 < state.pages.length ? String(pageIndex + 1) : null };
    } else if (path.includes('media-selection')) body = state.pin;
    else {
      status = state.readFailure || 200;
      body = status === 200 ? state.task : { code: 'task_read_failed', message: 'task read failed' };
    }
    return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  });
  const client = Object.assign(new WorkspaceClient('', undefined, transport), {
    isCurrentIdentity(expected: Pick<OutboxScope, 'realmId' | 'actorId'>) {
      return state.identity.actorId === expected.actorId && state.identity.realmId === expected.realmId;
    },
  });
  // Opaque semantic fixture only: these tests do not implement or qualify automatic placement commands.
  const capture = vi.fn<OutboxPlacementCapture>(async (original) => ({ fixture: 'Agent-owned guarded payload', media: original.mediaPin!, ids: original.input.createdIds }));
  const build = vi.fn((intent: OutboxIntent, base: OutboxHead, originalScope: OutboxScope = scope) => ({ method: 'POST',
    path: `/v1/projects/${originalScope.projectId}/timelines/${originalScope.timelineId}/commit`,
    body: { fixture: intent.payload, base: { revisionId: base.revisionId, publicationId: base.publicationId } } }));
  const transmit = vi.fn<(request: OutboxRequest) => Promise<OutboxOutcome>>(async () => acceptance('A'));
  const requester = (withCapture = true) => createPlacementRequester({ client, outboxes: storage(),
    getRecoverableIdentity: async () => state.identity, ...(withCapture ? { capture } : {}), build, transmit });
  async function reserve(box: ClaimedOutbox) { await box.reservePlacementAdmission('request', input); }
  return { factory, fault, storage, state, client, calls, capture, build, transmit, requester, reserve };
}

describe('bounded automatic placement requester', () => {
  it('retains App-normalized task bytes across a lost ACK through the explicit host replay port', async () => {
    const env = environment();
    const { schema_version, ...rest } = JSON.parse(prepared.body);
    const savedInput = { ...input, request: { ...prepared, body: JSON.stringify({ ...rest, schema_version }) } };
    const admitPreparedTask = vi.fn(async (request: OutboxRequest) => {
      expect(request).toEqual(savedInput.request);
      if (admitPreparedTask.mock.calls.length === 1) throw new Error('lost task ACK');
      return structuredClone(env.state.task);
    });
    Object.assign(env.client, { admitPreparedTask });
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', savedInput)).status).toBe('retry');
      expect((await box.read()).placementContinuations![0].input).toEqual(savedInput);
    });
    expect((await env.requester().recover())[0].status).toBe('accepted');
    expect(admitPreparedTask).toHaveBeenCalledTimes(2);
    expect(env.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('retains an App-normalized reservation when the exact replay host port is unavailable', async () => {
    const env = environment();
    const { schema_version, ...rest } = JSON.parse(prepared.body);
    const savedInput = { ...input, request: { ...prepared, body: JSON.stringify({ ...rest, schema_version }) } };
    await env.storage().create(scope, async (box) => {
      const progress = await env.requester().request(box, 'request', savedInput);
      expect(progress.status).toBe('retry');
      expect(progress.message).toBe('Exact prepared task replay binding is unavailable');
      expect((await box.read()).placementContinuations![0]).toEqual({ id: 'request', input: savedInput });
      expect(env.calls).toEqual([]);
    });
  });

  it('awaits durable reservation before the generated normal task POST and preserves original capture inputs', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      const durable = deferred();
      const started = deferred();
      const reserve = box.reservePlacementAdmission.bind(box);
      vi.spyOn(box, 'reservePlacementAdmission').mockImplementation(async (id, value) => {
        const saved = await reserve(id, value);
        started.resolve();
        await durable.promise;
        return saved;
      });
      const request = env.requester().request(box, 'request', structuredClone(input));
      await started.promise;
      expect(env.calls).toEqual([]);
      durable.resolve();
      expect((await request).status).toBe('accepted');
      expect(env.calls[0]).toEqual({ method: 'POST', path: '/v1/tasks', body: prepared.body, key: prepared.key });
      expect(env.capture).toHaveBeenCalledTimes(1);
      expect(env.capture.mock.calls[0][0]).toMatchObject({ input, mediaPin: pin,
        taskLocator: { projectId: scope.projectId, taskId: 'task', runId: 'run' } });
      const selection = env.calls.find((v) => v.path.includes('media-selection'))!;
      expect(selection.path).toBe('/v1/projects/project/media-selection?association_id=association&object_id=sha256%3A' + 'a'.repeat(64) + '&version=3');
      const saved = (await box.read()).placementContinuations![0];
      expect(saved.placement?.accepted?.head).toEqual({ revisionId: 'RA', publicationId: 'PA' });
      expect(saved.input).toEqual(input);
    });
  });

  it('never POSTs if reservation fails and never calls capture when no task succeeded', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      env.fault.abortNextWrite = true;
      await expect(env.requester().request(box, 'request', input)).rejects.toThrow('aborted');
      expect(env.calls).toEqual([]);
      expect((await box.read()).placementContinuations).toBeUndefined();
    });
  });

  it('retains exact task bytes/key across lost admission ACK and a fresh requester/storage instance', async () => {
    const env = environment();
    env.state.lostAdmission = true;
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('retry');
      expect((await box.read()).placementContinuations![0].taskLocator).toBeUndefined();
    });
    expect((await env.requester().recover())[0].status).toBe('accepted');
    expect(env.calls.filter((v) => v.method === 'POST')).toEqual([
      { method: 'POST', path: '/v1/tasks', body: prepared.body, key: prepared.key },
      { method: 'POST', path: '/v1/tasks', body: prepared.body, key: prepared.key },
    ]);
    expect(env.capture).toHaveBeenCalledTimes(1);
  });

  it('reconnects from saved task IDs with no event cache or editor, preserving a different original timeline', async () => {
    const env = environment();
    env.state.task.state = 'running';
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('waiting');
      expect((await box.read()).intents).toEqual([]);
    });
    env.state.task.state = 'succeeded';
    env.calls.length = 0;
    const [result] = await env.requester().recover();
    expect(result.scope.timelineId).toBe(scope.timelineId);
    expect(result.status).toBe('accepted');
    expect(env.calls[0]).toMatchObject({ method: 'GET', path: '/v1/tasks/task' });
    expect(env.calls.some((v) => v.method === 'POST')).toBe(false);
  });

  it('reads all output pages and matches the explicit output rather than array-first/latest', async () => {
    const env = environment();
    env.state.pages = [[{ ...managed, variant_key: 'unapproved', ordinal: 0 }], [managed]];
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('accepted');
    });
    expect(env.calls.filter((v) => v.path.includes('managed-outputs'))).toHaveLength(2);
    expect(env.capture.mock.calls[0][0].mediaPin).toEqual(pin);
  });

  it('binds recovery capture and commit to each saved timeline scope before any editor is open', async () => {
    const env = environment();
    const otherScope = { ...scope, timelineId: 'another-saved-timeline' };
    for (const originalScope of [scope, otherScope]) {
      await env.storage().create(originalScope, async (box) => {
        await env.reserve(box);
      });
    }
    const results = await env.requester().recover();
    expect(results.map((v) => v.status)).toEqual(['accepted', 'accepted']);
    expect(env.capture).toHaveBeenNthCalledWith(1, expect.objectContaining({ input }), scope);
    expect(env.capture).toHaveBeenNthCalledWith(2, expect.objectContaining({ input }), otherScope);
    expect(env.build.mock.calls.map((args) => args[2])).toEqual([scope, otherScope]);
    expect(env.transmit.mock.calls.map((args) => args[0].path)).toEqual([
      '/v1/projects/project/timelines/original-timeline/commit',
      '/v1/projects/project/timelines/another-saved-timeline/commit',
    ]);
  });

  it.each(['queued', 'ready', 'running', 'retrying'] as const)('task %s persists its locator without enqueuing an edit', async (state) => {
    const env = environment();
    env.state.task.state = state;
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('waiting');
      expect((await box.read()).intents).toEqual([]);
      expect((await box.read()).placementContinuations![0].taskLocator?.taskId).toBe('task');
    });
    expect(env.capture).not.toHaveBeenCalled();
    expect(env.transmit).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled', 'cancel_requested'] as const)('retains task %s as a visible conflict after restart', async (state) => {
    const env = environment();
    env.state.task.state = state;
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('conflict');
      expect((await box.read()).placementContinuations![0].conflict).toMatchObject({ message: expect.stringContaining(state) });
    });
    const count = env.calls.length;
    expect((await env.requester().recover())[0].status).toBe('conflict');
    expect(env.calls).toHaveLength(count);
    expect(env.capture).not.toHaveBeenCalled();
  });

  it('retains a normal admission rejection and never silently creates a fresh task', async () => {
    const env = environment();
    env.state.admissionFailure = 409;
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('conflict');
    });
    expect((await env.requester().recover())[0].status).toBe('conflict');
    expect(env.calls).toHaveLength(1);
  });

  it('retains capture refusal, original pin and IDs without enqueue or recapture', async () => {
    const env = environment();
    env.capture.mockRejectedValue(new Error('original anchor selection changed'));
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('conflict');
      const record = await box.read();
      expect(record.intents).toEqual([]);
      expect(record.placementContinuations![0]).toMatchObject({ mediaPin: pin, input: { createdIds: input.createdIds },
        conflict: { message: 'original anchor selection changed' } });
    });
    expect((await env.requester().recover())[0].status).toBe('conflict');
    expect(env.capture).toHaveBeenCalledTimes(1);
  });

  it.each(['project_id', 'run_id', 'task_id', 'idempotency_key', 'capability_digest'] as const)('refuses a changed saved task %s', async (field) => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      await env.reserve(box);
      await box.recordPlacementTask('request', prepared, { projectId: scope.projectId, taskId: 'task', runId: 'run' });
    });
    env.state.task[field] = 'other';
    expect((await env.requester().recover())[0].status).toBe('conflict');
    expect(env.capture).not.toHaveBeenCalled();
  });

  it.each(['attempt_id', 'object_id', 'project_id', 'task_id', 'run_id'] as const)('retains a changed managed %s binding as a conflict', async (field) => {
    const env = environment();
    env.state.pages[0][0][field] = 'other';
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('conflict');
      expect((await box.read()).intents).toEqual([]);
    });
    expect(env.capture).not.toHaveBeenCalled();
  });

  it.each(['missing', 'ambiguous', 'wrong-asset', 'wrong-variant', 'wrong-generation', 'wrong-object', 'extra-field'] as const)('refuses %s output selection', async (failure) => {
    const env = environment();
    if (failure === 'missing') env.state.pages = [[]];
    if (failure === 'ambiguous') env.state.pages = [[managed, managed]];
    if (failure === 'wrong-asset') env.state.pin.asset = 'other';
    if (failure === 'wrong-variant') env.state.pin.variant_id = 'other';
    if (failure === 'wrong-generation') env.state.pin.generation_id = 'other';
    if (failure === 'wrong-object') env.state.pin.object_id = 'other';
    if (failure === 'extra-field') Object.assign(env.state.pin, { unexpected_field: 'refused' });
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('conflict');
    });
    expect(env.capture).not.toHaveBeenCalled();
    expect((await env.requester().recover())[0].status).toBe('conflict');
  });

  it('persists linkage before commit POST and replays exact commit bytes/key after lost ACK', async () => {
    const env = environment();
    let firstRequest: unknown;
    env.transmit.mockImplementationOnce(async (request) => {
      firstRequest = request;
      const [record] = await env.storage().list(scope);
      expect(record.pending?.request).toEqual(request);
      expect(record.placementContinuations![0].placement?.intentId).toBe(record.intents[0].id);
      throw new Error('Lost commit ACK');
    });
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('retry');
    });
    expect((await env.requester().recover())[0].status).toBe('accepted');
    expect(env.transmit.mock.calls[1][0]).toEqual(firstRequest);
    expect(env.capture).toHaveBeenCalledTimes(1);
    expect(env.build).toHaveBeenCalledTimes(1);
  });

  it('never rearms duplicate completion after acceptance, undo and later B/C acceptance', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('accepted');
      const linked = structuredClone((await box.read()).placementContinuations![0]);
      for (const label of ['undo', 'B', 'C']) {
        await box.append({ fixture: label }, { head });
        await box.dispatch(env.build, async () => acceptance(label));
        expect((await env.requester().resume(box))[0].status).toBe('accepted');
        expect((await box.read()).placementContinuations![0]).toEqual(linked);
      }
    });
    for (let duplicate = 0; duplicate < 2; duplicate += 1) expect((await env.requester().recover())[0].status).toBe('accepted');
    expect(env.capture).toHaveBeenCalledTimes(1);
    expect(env.transmit).toHaveBeenCalledTimes(1);
    expect(env.calls.filter((v) => v.method === 'POST')).toHaveLength(1);
  });

  it('keeps commit rejection visible and preserves captured intent instead of recapturing', async () => {
    const env = environment();
    env.transmit.mockResolvedValue({ kind: 'rejected', error: { kind: 'conflict', message: 'anchor changed' } });
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('conflict');
    });
    expect((await env.requester().recover())[0].status).toBe('conflict');
    expect(env.capture).toHaveBeenCalledTimes(1);
    expect(env.transmit).toHaveBeenCalledTimes(1);
  });

  it('retains a reservation after locator persistence fails and retries the same normal admission', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      vi.spyOn(box, 'recordPlacementTask').mockRejectedValueOnce(new Error('Outbox transaction aborted'));
      expect((await env.requester().request(box, 'request', input)).status).toBe('retry');
      expect((await box.read()).placementContinuations![0].taskLocator).toBeUndefined();
      expect(env.calls).toHaveLength(1);
    });
    expect((await env.requester().recover())[0].status).toBe('accepted');
    expect(env.calls.filter((v) => v.method === 'POST').map((v) => [v.body, v.key])).toEqual([
      [prepared.body, prepared.key], [prepared.body, prepared.key],
    ]);
  });

  it('retains the original pin after interrupted capture and saves a changed selection conflict on reconnect', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      await env.reserve(box);
      await box.recordPlacementTask('request', prepared, { projectId: scope.projectId, taskId: 'task', runId: 'run' });
      await expect(box.capturePlacement('request', pin, async () => {
        env.fault.abortNextWrite = true;
        return { fixture: 'capture completed before interrupted append' };
      })).rejects.toThrow('aborted');
      expect((await box.read()).placementContinuations![0]).toMatchObject({ mediaPin: pin });
      expect((await box.read()).intents).toEqual([]);
    });
    env.state.pin.catalog_digest = `sha256:${'d'.repeat(64)}`;
    const [result] = await env.requester().recover();
    expect(result.status).toBe('conflict');
    expect(result.continuation).toMatchObject({ mediaPin: pin, conflict: { message: 'Saved immutable media selection changed' } });
    expect(env.capture).not.toHaveBeenCalled();
  });

  it('retries an unavailable normal task read without losing the locator or allocating a new admission', async () => {
    const env = environment();
    env.state.readFailure = 503;
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('retry');
      expect((await box.read()).placementContinuations![0]).toMatchObject({ taskLocator: { taskId: 'task' } });
      expect((await box.read()).placementContinuations![0].conflict).toBeUndefined();
    });
    env.state.readFailure = 0;
    expect((await env.requester().recover())[0].status).toBe('accepted');
    expect(env.calls.filter((v) => v.method === 'POST')).toHaveLength(1);
  });

  it('does not rearm a cancelled unsent placement', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      await env.reserve(box);
      await box.recordPlacementTask('request', prepared, { projectId: scope.projectId, taskId: 'task', runId: 'run' });
      const linked = await box.capturePlacement('request', pin, env.capture);
      await box.cancel(linked.placement!.intentId);
    });
    expect((await env.requester().recover())[0].status).toBe('cancelled');
    expect(env.capture).toHaveBeenCalledTimes(1);
    expect(env.calls).toEqual([]);
  });

  it('rechecks identity after durable reservation and refuses task POST when it changes', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      const reserve = box.reservePlacementAdmission.bind(box);
      vi.spyOn(box, 'reservePlacementAdmission').mockImplementation(async (id, value) => {
        const saved = await reserve(id, value);
        env.state.identity.actorId = 'other-actor';
        return saved;
      });
      await expect(env.requester().request(box, 'request', input)).rejects.toThrow('identity changed');
      expect((await box.read()).placementContinuations![0].input).toEqual(input);
    });
    expect(env.calls).toEqual([]);
  });

  it.each(['generation.create_with_variant', 'generation.variant.append'])('reads the ordinary %s result without using primary variants', async (effect_type) => {
    const env = environment();
    const legacyOutput = { ...selected, group_key: 'default', variant_key: '0', ordinal: 0 };
    const request = preparePlacementTask({ ...JSON.parse(prepared.body), settlement_effect: {
      effect_type, target_id: effect_type === 'generation.variant.append' ? 'generation' : scope.projectId,
      ...(effect_type === 'generation.variant.append' ? { expected_version: 1 } : {}),
      payload: { output_name: selected.output_port, output_ordinal: 0, variant_type: 'image', primary_policy: 'preserve',
        ...(effect_type === 'generation.variant.append' ? { source_variant_id: 'source', source_object_id: objectId }
          : { generation_type: 'image', metadata: {} }) },
    } }, prepared.key);
    env.state.pages = [[{ ...managed, ...legacyOutput, selector: { group_key: 'default', variant_key: '0' } }]];
    env.state.task.result = { generation_variant: { generation_id: pin.generation_id, variant_id: pin.variant_id,
      object_id: pin.object_id, metadata: { source_task_id: 'task', output_name: selected.output_port, output_ordinal: 0 } } };
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', { ...input, request, output: legacyOutput })).status).toBe('accepted');
    });
    expect(env.capture.mock.calls[0][0].mediaPin).toEqual(pin);
  });

  it('requires the original identity and browser owner lock', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      await env.reserve(box);
      const [locked] = await env.requester().recover();
      expect(locked).toMatchObject({ status: 'retry', message: 'Outbox is already claimed' });
      env.state.identity.actorId = 'another-actor';
      await expect(env.requester().resume(box)).rejects.toThrow('identity changed');
      expect(await env.requester().recover()).toEqual([]);
      env.state.identity = { realmId: 'other-realm', actorId: scope.actorId };
      expect(await env.requester().recover()).toEqual([]);
    });
    expect(env.calls).toEqual([]);
  });

  it('keeps missing capture and unbound owners visible for manual placement without auto activation', async () => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      expect((await env.requester(false).request(box, 'request', input)).status).toBe('manual');
      expect((await box.read()).intents).toEqual([]);
    });
    await env.storage().create(scope, async () => {});
    const results = await env.requester(false).recover();
    expect(results).toHaveLength(2);
    expect(results.map((v) => v.status)).toEqual(['manual', 'manual']);
    expect(env.capture).not.toHaveBeenCalled();
    expect(env.transmit).not.toHaveBeenCalled();
  });

  it.each(['approval', 'project', 'bytes', 'selector', 'unsaved'] as const)('refuses %s before task submission', async (failure) => {
    const env = environment();
    await env.storage().create(scope, async (box) => {
      const changed = structuredClone(input);
      if (failure === 'approval') Object.assign(changed, { autoApprove: false });
      if (failure === 'project') changed.request = preparePlacementTask({ ...JSON.parse(prepared.body), project: 'wrong-project' }, prepared.key);
      if (failure === 'bytes') changed.request.body += '\n';
      if (failure === 'selector') changed.output.variant_key = 'unapproved';
      if (failure === 'unsaved') await box.append({ fixture: 'unsaved' }, { head });
      await expect(env.requester().request(box, 'request', changed)).rejects.toThrow();
      expect(env.calls).toEqual([]);
    });
  });
});


describe('requester independent review counterexamples', () => {
  it('review fences task admission after the original owner claim is released and reclaimed', async () => {
    const env = environment();
    const started = deferred();
    const resumeIdentity = deferred();
    let checks = 0;
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        checks += 1;
        // resume checks identity, then advance reads the owner and checks identity again.
        if (checks === 2) { started.resolve(); await resumeIdentity.promise; }
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    let late!: Promise<unknown>;
    let ownerId!: string;
    await env.storage().create(scope, async (box, id) => {
      ownerId = id;
      await env.reserve(box);
      late = requester.resume(box);
      await started.promise;
    });
    // A new legitimate claim now owns the same continuation; the old claim is inactive.
    await env.storage().recover(scope, ownerId, async (box) => {
      expect((await box.read()).generation).toBe(2);
      resumeIdentity.resolve();
      await late;
      const posted = env.calls.filter((call) => call.method === 'POST');
      const record = await box.read();
      console.info('REVIEW_STALE_CLAIM', JSON.stringify({ posted, generation: record.generation,
        locator: record.placementContinuations![0].taskLocator ?? null }));
      expect(posted).toEqual([]);
    });
  });

  it('review fences a commit acknowledgement when actor identity changes during transmission', async () => {
    const env = environment();
    const sent = deferred();
    const acknowledge = deferred();
    env.transmit.mockImplementationOnce(async () => {
      sent.resolve();
      await acknowledge.promise;
      return acceptance('A');
    });
    await env.storage().create(scope, async (box) => {
      const advancing = env.requester().request(box, 'request', input);
      await sent.promise;
      env.state.identity.actorId = 'different-actor';
      acknowledge.resolve();
      const result = await advancing;
      const record = await box.read();
      console.info('REVIEW_CHANGED_ACTOR_ACK', JSON.stringify({ status: result.status,
        actor: env.state.identity.actorId, intents: record.intents.length, pending: !!record.pending,
        accepted: record.placementContinuations![0].placement?.accepted ?? null }));
      expect(record.placementContinuations![0].placement?.accepted).toBeUndefined();
      expect(record.pending?.request).toBeDefined();
      expect(record.intents).toHaveLength(1);
    });
  });
});

describe('requester async lifecycle recovery', () => {
  it.each(['actorId', 'realmId'] as const)('retains capture success/refusal across %s changes and recovers the original approval', async (field) => {
    for (const refused of [false, true]) {
      const env = environment();
      const started = deferred();
      const complete = deferred();
      env.capture.mockImplementationOnce(async () => {
        started.resolve();
        await complete.promise;
        if (refused) throw new Error('late capture refusal');
        return { captured: 'before identity changed' };
      });
      let ownerId!: string;
      await env.storage().create(scope, async (box, id) => {
        ownerId = id;
        const advancing = env.requester().request(box, 'request', input);
        await started.promise;
        const original = await box.read();
        env.state.identity[field] = 'different';
        complete.resolve();
        expect((await advancing).status).toBe('retry');
        expect(await box.read()).toEqual(original);
        expect(original.placementContinuations![0]).toMatchObject({ input, mediaPin: pin });
        expect(original.intents).toEqual([]);
        expect(env.transmit).not.toHaveBeenCalled();
      });
      env.state.identity[field] = scope[field];
      expect(await env.requester().recover()).toMatchObject([{ ownerId, status: 'accepted' }]);
      expect(env.capture).toHaveBeenCalledTimes(2);
      expect(env.capture.mock.calls[1][0]).toMatchObject({ input, mediaPin: pin });
      expect(env.calls.filter((call) => call.method === 'POST')).toEqual([prepared]);
    }
  });

  it.each(['actorId', 'realmId'] as const)('keeps exact uncertain commit bytes/key for %s changes across every transmit outcome', async (field) => {
    for (const outcome of ['accepted', 'rejected', 'error'] as const) {
      const env = environment();
      const started = deferred();
      const complete = deferred();
      env.transmit.mockImplementationOnce(async () => {
        started.resolve();
        await complete.promise;
        if (outcome === 'error') throw new Error('late transport refusal');
        return outcome === 'accepted' ? acceptance('A') : { kind: 'rejected', error: { reason: 'late conflict' } };
      });
      await env.storage().create(scope, async (box) => {
        const advancing = env.requester().request(box, 'request', input);
        await started.promise;
        const original = await box.read();
        env.state.identity[field] = 'different';
        complete.resolve();
        expect((await advancing).status).toBe('retry');
        const retained = await box.read();
        expect(retained.pending?.request).toEqual(original.pending!.request);
        expect(retained.pending?.outcome?.kind).toBe('retry');
        expect(retained.intents).toEqual(original.intents);
        expect(retained.placementContinuations).toEqual(original.placementContinuations);
        expect(retained.placementContinuations![0].input).toEqual(input);
        expect(retained.placementContinuations![0].placement?.accepted).toBeUndefined();
        env.state.identity[field] = scope[field];
        expect(await env.requester().resume(box)).toMatchObject([{ status: 'accepted' }]);
        expect(env.transmit.mock.calls.map(([request]) => request)).toEqual([original.pending!.request, original.pending!.request]);
        expect(env.build).toHaveBeenCalledTimes(1);
        expect(env.capture).toHaveBeenCalledTimes(1);
        const accepted = await box.read();
        expect(await env.requester().resume(box)).toMatchObject([{ status: 'accepted' }]);
        expect(await box.read()).toEqual(accepted);
        expect(env.transmit).toHaveBeenCalledTimes(2);
      });
    }
  });

  it.each(['capture', 'transmit'] as const)('fences late %s after release or loss of the persisted generation', async (stage) => {
    for (const loss of ['release', 'supersede'] as const) {
      const env = environment();
      const started = deferred();
      const complete = deferred();
      let late!: Promise<{ status: string }>;
      let ownerId!: string;
      let original!: Awaited<ReturnType<ClaimedOutbox['read']>>;
      if (stage === 'capture') env.capture.mockImplementationOnce(async () => {
        started.resolve(); await complete.promise;
        return { obsolete: 'capture' };
      });
      else env.transmit.mockImplementationOnce(async () => {
        started.resolve(); await complete.promise;
        return acceptance('obsolete');
      });
      const reconcile = async (box: ClaimedOutbox) => {
        expect((await box.read()).generation).toBe(2);
        if (stage === 'transmit') {
          // A current generation accepts first; the old ACK must not overwrite it.
          expect(await env.requester().resume(box)).toMatchObject([{ status: 'accepted' }]);
          const accepted = await box.read();
          expect(accepted.placementContinuations![0].placement?.accepted?.head).toEqual({ revisionId: 'RA', publicationId: 'PA' });
          complete.resolve();
          expect((await late).status).toBe('retry');
          expect(await box.read()).toEqual(accepted);
          expect(env.transmit.mock.calls.map(([request]) => request)).toEqual([original.pending!.request, original.pending!.request]);
        } else {
          complete.resolve();
          expect((await late).status).toBe('retry');
          const retained = await box.read();
          expect(retained).toEqual({ ...original, generation: 2 });
          expect(retained.placementContinuations![0].conflict).toBeUndefined();
          expect(await env.requester().resume(box)).toMatchObject([{ status: 'accepted' }]);
          expect(env.capture.mock.calls[1][0]).toMatchObject({ input, mediaPin: pin });
        }
        expect(env.calls.filter((call) => call.method === 'POST')).toEqual([prepared]);
        const accepted = await box.read();
        expect(await env.requester().resume(box)).toMatchObject([{ status: 'accepted' }]);
        expect(await box.read()).toEqual(accepted);
      };
      await env.storage().create(scope, async (box, id) => {
        ownerId = id;
        late = env.requester().request(box, 'request', input);
        await started.promise;
        original = await box.read();
        if (loss === 'supersede') {
          // Simulate loss of browser exclusion: persisted generation still fences the active old callback.
          const competing = createCommitOutbox({ indexedDB: env.factory, exclusiveLock: async (_name, work) => work() });
          await competing.recover(scope, ownerId, reconcile);
        }
      });
      if (loss === 'release') await env.storage().recover(scope, ownerId, reconcile);
    }
  });

  it.each(['capture', 'transmit', 'refusal'] as const)('rechecks a released generation after awaited %s identity', async (stage) => {
    const env = environment();
    const checking = deferred();
    const complete = deferred();
    let pause = false;
    let ownerId!: string;
    let late!: Promise<unknown>;
    let original!: Awaited<ReturnType<ClaimedOutbox['read']>>;
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        if (pause) { pause = false; checking.resolve(); await complete.promise; }
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    if (stage === 'capture') {
      const capture = env.capture.getMockImplementation()!;
      env.capture.mockImplementationOnce(async (saved) => { pause = true; return capture(saved); });
    } else if (stage === 'transmit') env.build.mockImplementationOnce((intent) => {
      pause = true;
      return { method: 'POST', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, body: intent.payload };
    });
    else {
      env.state.admissionFailure = 403;
      const admit = env.client.admitTask.bind(env.client);
      vi.spyOn(env.client, 'admitTask').mockImplementationOnce(async (...args) => {
        try { return await admit(...args); } finally { pause = true; }
      });
    }
    await env.storage().create(scope, async (box, id) => {
      ownerId = id;
      late = requester.request(box, 'request', input);
      await checking.promise;
      original = await box.read();
    });
    await env.storage().recover(scope, ownerId, async (box) => {
      complete.resolve();
      await late;
      expect(await box.read()).toEqual({ ...original, generation: 2 });
      expect(env.transmit).not.toHaveBeenCalled();
      expect((await box.read()).placementContinuations![0].conflict).toBeUndefined();
      env.state.admissionFailure = 0;
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
    });
  });

  it('keeps the first genuine refusal through duplicate recovery without rearming admission', async () => {
    const env = environment();
    env.state.readFailure = 403;
    await env.storage().create(scope, async (box) => {
      expect((await env.requester().request(box, 'request', input)).status).toBe('conflict');
      const original = await box.read();
      const conflict = original.placementContinuations![0].conflict;
      expect(conflict).toEqual({ reason: 'placement_refused', message: 'task_read_failed: task read failed' });
      expect(await box.recordPlacementConflict('request', { reason: 'later refusal' })).toEqual(original.placementContinuations![0]);
      const calls = env.calls.length;
      env.state.readFailure = 404;
      expect(await env.requester().resume(box)).toMatchObject([{ status: 'conflict' }]);
      expect(await box.read()).toEqual(original);
      expect(env.calls).toHaveLength(calls);
      expect(env.capture).not.toHaveBeenCalled();
      expect(env.transmit).not.toHaveBeenCalled();
    });
  });
});

describe('requester awaited identity refusals', () => {
  it.each(['actorId', 'realmId'] as const)('does not retain a capture/API refusal under a changed %s while identity is pending', async (field) => {
    for (const stage of ['capture', 'admission'] as const) {
      const env = environment();
      const checking = deferred();
      const complete = deferred();
      let pause = false;
      const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
        getRecoverableIdentity: async () => {
          if (pause) { pause = false; checking.resolve(); await complete.promise; }
          return { ...env.state.identity };
        }, capture: env.capture, build: env.build, transmit: env.transmit });
      if (stage === 'capture') env.capture.mockImplementationOnce(async () => {
        pause = true;
        throw new Error('capture refused under original identity');
      });
      else {
        env.state.admissionFailure = 403;
        const admit = env.client.admitTask.bind(env.client);
        vi.spyOn(env.client, 'admitTask').mockImplementationOnce(async (...args) => {
          try { return await admit(...args); } finally { pause = true; }
        });
      }
      await env.storage().create(scope, async (box) => {
        const advancing = requester.request(box, 'request', input);
        await checking.promise;
        const original = await box.read();
        env.state.identity[field] = 'different';
        complete.resolve();
        expect((await advancing).status).toBe('retry');
        expect(await box.read()).toEqual(original);
        env.state.identity[field] = scope[field];
        env.state.admissionFailure = 0;
        expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
        expect(env.calls.filter((call) => call.method === 'POST')).toEqual(stage === 'admission' ? [prepared, prepared] : [prepared]);
      });
    }
  });

  it('keeps an asynchronous identity-service refusal retryable even when authentication recovers immediately', async () => {
    const env = environment();
    const checking = deferred();
    const complete = deferred();
    let checks = 0;
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        checks += 1;
        if (checks === 3) {
          checking.resolve();
          await complete.promise;
          // Use the actual generated API error: identity-service failure is not task rejection.
          const { ApiError } = await import('@/integrations/runtime/generated.ts');
          throw new ApiError(403, 'identity_unavailable', 'temporary authentication interruption');
        }
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    await env.storage().create(scope, async (box) => {
      const advancing = requester.request(box, 'request', input);
      await checking.promise;
      const original = await box.read();
      complete.resolve();
      expect((await advancing).status).toBe('retry');
      expect(await box.read()).toEqual(original);
      expect(env.calls).toEqual([]);
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
      expect(env.calls.filter((call) => call.method === 'POST')).toEqual([prepared]);
    });
  });
});

describe('requester admission generation recovery', () => {
  it('admits the exact original approval only from the reclaimed generation', async () => {
    const env = environment();
    const checking = deferred();
    const complete = deferred();
    let checks = 0;
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        checks += 1;
        if (checks === 2) { checking.resolve(); await complete.promise; }
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    let ownerId!: string;
    let late!: Promise<unknown>;
    await env.storage().create(scope, async (box, id) => {
      ownerId = id;
      await env.reserve(box);
      late = requester.resume(box);
      await checking.promise;
    });
    await env.storage().recover(scope, ownerId, async (box) => {
      const original = await box.read();
      complete.resolve();
      await late;
      expect(env.calls).toEqual([]);
      expect(await box.read()).toEqual(original);
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
      expect(env.calls.filter((call) => call.method === 'POST')).toEqual([prepared]);
      expect(env.capture.mock.calls[0][0]).toMatchObject({ input, mediaPin: pin });
      expect((await box.read()).generation).toBe(2);
    });
  });
});

describe('composed requester fences with dependent recovery', () => {
  const payloads = ['B', 'C', 'timeline.inverse'].map((op) => ({ op,
    guards: { original: op }, bindings: ['original-anchor'], createdIds: [`allocated-${op}`] }));

  async function queueDependents(box: ClaimedOutbox) {
    const original = await box.read();
    let previous = original.pending!.intentId;
    for (const payload of payloads) previous = await box.append(payload, { after: previous });
    return box.read();
  }

  async function recoverChain(env: ReturnType<typeof environment>, ownerId: string,
    saved: Awaited<ReturnType<ClaimedOutbox['read']>>) {
    env.state.identity = { realmId: scope.realmId, actorId: scope.actorId };
    env.build.mockClear();
    let linked!: NonNullable<typeof saved.placementContinuations>[number];
    await env.storage().recover(scope, ownerId, async (box) => {
      const before = await box.read();
      expect(before.pending!.request).toEqual(saved.pending!.request);
      expect(before.intents).toEqual(saved.intents);
      expect(await env.requester().resume(box)).toMatchObject([{ status: 'accepted' }]);
      expect(env.transmit.mock.lastCall![0]).toEqual(saved.pending!.request);
      expect(env.build).not.toHaveBeenCalled();
      const after = await box.read();
      linked = after.placementContinuations![0];
      expect(linked.input).toEqual(input);
      expect(linked.placement?.accepted).toMatchObject({ intentId: saved.pending!.intentId,
        head: { revisionId: 'RA', publicationId: 'PA' } });
      expect(after.intents).toEqual(saved.intents.slice(1).map((intent, index) => index === 0
        ? { ...intent, readyBase: { revisionId: 'RA', publicationId: 'PA' } } : intent));
      expect(after.pending).toBeUndefined();
    });
    let base = { revisionId: 'RA', publicationId: 'PA' };
    const keys = new Set([saved.pending!.request.key]);
    for (const [index, payload] of payloads.entries()) {
      let pending!: OutboxRequest;
      let retained!: Awaited<ReturnType<ClaimedOutbox['read']>>;
      await env.storage().recover(scope, ownerId, async (box) => {
        await box.dispatch(env.build, async (request) => {
          pending = request;
          expect(JSON.parse(request.body)).toEqual({ fixture: payload, base });
          expect(keys.has(request.key)).toBe(false);
          keys.add(request.key);
          throw new Error('dependent ACK lost');
        });
        retained = await box.read();
        expect(retained.intents[0]).toEqual({ ...saved.intents[index + 1], readyBase: base });
        expect(retained.pending!.request).toEqual(pending);
      });
      const outcome = acceptance(payload.op);
      if (outcome.kind !== 'accepted') throw new Error('Expected acceptance fixture');
      await env.storage().recover(scope, ownerId, async (box) => {
        const mustNotBuild = vi.fn(() => { throw new Error('Exact pending retry cannot rebuild'); });
        const after = await box.dispatch(mustNotBuild, async (request) => {
          expect(request).toEqual(pending);
          return outcome;
        });
        expect(mustNotBuild).not.toHaveBeenCalled();
        expect(after.intents).toEqual(retained.intents.slice(1).map((intent, next) => next === 0
          ? { ...intent, readyBase: outcome.head } : intent));
        expect(after.placementContinuations).toEqual([linked]);
        expect(after.pending).toBeUndefined();
        const stable = await box.read();
        expect(await env.requester().resume(box)).toMatchObject([{ status: 'accepted' }]);
        expect(await box.read()).toEqual(stable);
      });
      base = outcome.head;
    }
    expect(env.calls.filter((call) => call.method === 'POST')).toEqual([prepared]);
    expect(await env.requester().recover()).toMatchObject([{ status: 'accepted' }]);
    expect(env.transmit).toHaveBeenCalledTimes(2);
  }

  it.each(['success', 'refusal'] as const)('recovers A/B/C/inverse after late capture %s, actor change and owner release', async (settlement) => {
    const env = environment();
    const started = deferred();
    const complete = deferred();
    env.capture.mockImplementationOnce(async () => {
      started.resolve();
      await complete.promise;
      if (settlement === 'refusal') throw new Error('obsolete semantic refusal');
      return { obsolete: 'capture payload' };
    });
    env.transmit.mockRejectedValueOnce(new Error('A ACK lost'));
    let ownerId!: string;
    let late!: ReturnType<ReturnType<typeof env.requester>['request']>;
    let original!: Awaited<ReturnType<ClaimedOutbox['read']>>;
    await env.storage().create(scope, async (box, id) => {
      ownerId = id;
      late = env.requester().request(box, 'request', input);
      await started.promise;
      original = await box.read();
      env.state.identity.actorId = 'another-actor';
    });
    let saved!: typeof original;
    await env.storage().recover(scope, ownerId, async (box) => {
      complete.resolve();
      expect((await late).status).toBe('retry');
      expect(await box.read()).toEqual({ ...original, generation: 2 });
      expect(original.placementContinuations![0]).toMatchObject({ input, mediaPin: pin });
      expect(original.placementContinuations![0].placement).toBeUndefined();
      expect(original.placementContinuations![0].conflict).toBeUndefined();
      expect(env.transmit).not.toHaveBeenCalled();
      env.state.identity.actorId = scope.actorId;
      expect(await env.requester().resume(box)).toMatchObject([{ status: 'retry' }]);
      saved = await queueDependents(box);
    });
    await recoverChain(env, ownerId, saved);
    expect(env.capture).toHaveBeenCalledTimes(2);
    expect(env.capture.mock.calls[1][0]).toMatchObject({ input, mediaPin: pin });
  });

  it.each(['accepted', 'rejected', 'error'] as const)('retains A/B/C/inverse across late %s ACK, actor change and owner release', async (settlement) => {
    const env = environment();
    const started = deferred();
    const complete = deferred();
    env.transmit.mockImplementationOnce(async () => {
      started.resolve();
      await complete.promise;
      if (settlement === 'error') throw new Error('obsolete transport refusal');
      return settlement === 'accepted' ? acceptance('obsolete')
        : { kind: 'rejected', error: { reason: 'obsolete permanent conflict' } };
    });
    let ownerId!: string;
    let late!: ReturnType<ReturnType<typeof env.requester>['request']>;
    let saved!: Awaited<ReturnType<ClaimedOutbox['read']>>;
    await env.storage().create(scope, async (box, id) => {
      ownerId = id;
      late = env.requester().request(box, 'request', input);
      await started.promise;
      saved = await queueDependents(box);
      env.state.identity.actorId = 'another-actor';
    });
    await env.storage().recover(scope, ownerId, async (box) => {
      complete.resolve();
      expect((await late).status).toBe('retry');
      expect(await box.read()).toEqual({ ...saved, generation: 2 });
      expect(saved.intents.map((intent) => intent.conflict)).toEqual([undefined, undefined, undefined, undefined]);
      expect(saved.intents.slice(1).map((intent) => intent.readyBase)).toEqual([undefined, undefined, undefined]);
      expect(saved.placementContinuations![0].placement?.accepted).toBeUndefined();
    });
    await recoverChain(env, ownerId, saved);
    expect(env.capture).toHaveBeenCalledTimes(1);
  });
});

// The read wrapper only delays delivery of a real successful, generation-checked IDB read.
describe('independent residual fence counterexamples', () => {
  it.each(['actorId', 'realmId'] as const)('does not POST after %s changes during the final authorization read', async (field) => {
    const env = environment();
    const reading = deferred(), complete = deferred();
    let checks = 0;
    let pauseRead = false;
    const dispatchIdentities: unknown[] = [];
    const admit = env.client.admitTask.bind(env.client);
    vi.spyOn(env.client, 'admitTask').mockImplementation(async (...args) => {
      dispatchIdentities.push({ ...env.state.identity });
      return admit(...args);
    });
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        checks += 1;
        if (checks === 3) pauseRead = true; // resume, advance, then POST authorization
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    await env.storage().create(scope, async (box) => {
      await env.reserve(box);
      const read = box.read.bind(box);
      vi.spyOn(box, 'read').mockImplementation(async () => {
        const record = await read();
        if (pauseRead) { pauseRead = false; reading.resolve(); await complete.promise; }
        return record;
      });
      const advancing = requester.resume(box);
      await reading.promise;
      env.state.identity = { ...env.state.identity, [field]: 'different' };
      complete.resolve();
      const result = await advancing;
      const retained = await read();
      console.info('RESIDUAL_POST', JSON.stringify({ field, result: result[0].status, dispatchIdentities,
        posted: env.calls.filter((c) => c.method === 'POST'), retained: retained.placementContinuations }));
      // Recovery is possible under the original identity, with exactly the original body/key/IDs.
      env.state.identity = { realmId: scope.realmId, actorId: scope.actorId };
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
      expect(env.calls.filter((c) => c.method === 'POST')).toEqual([prepared]);
      expect(env.capture.mock.calls[0][0]).toMatchObject({ input, mediaPin: pin });
      expect(dispatchIdentities).toEqual([{ realmId: scope.realmId, actorId: scope.actorId }]);
      // Safety expectation: the late old-identity authorization should have prevented this POST.
      expect(env.calls.filter((c) => c.method === 'POST').slice(0, -1)).toEqual([]);
    });
  });

  it.each([{field:'actorId', refusal:false}, {field:'realmId', refusal:false}, {field:'actorId', refusal:true}, {field:'realmId', refusal:true}] as const)('does not change capture storage at $field refusal=$refusal during the post-capture read', async ({field, refusal}) => {
      const env = environment();
      const reading = deferred(), complete = deferred();
      let pauseRead = false, arm = false;
      const capture = env.capture.getMockImplementation()!;
      env.capture.mockImplementationOnce(async (saved) => {
        arm = true;
        if (refusal) throw new Error('original semantic capture refused');
        return capture(saved);
      });
      const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
        getRecoverableIdentity: async () => {
          if (arm) { arm = false; pauseRead = true; }
          return { ...env.state.identity };
        }, capture: env.capture, build: env.build, transmit: env.transmit });
      await env.storage().create(scope, async (box) => {
        const read = box.read.bind(box);
        vi.spyOn(box, 'read').mockImplementation(async () => {
          const record = await read();
          if (pauseRead) { pauseRead = false; reading.resolve(); await complete.promise; }
          return record;
        });
        const advancing = requester.request(box, 'request', input);
        await reading.promise;
        const before = await read();
        env.state.identity = { ...env.state.identity, [field]: 'different' };
        complete.resolve();
        const result = await advancing;
        const after = await read();
        console.info('RESIDUAL_CAPTURE', JSON.stringify({ field, refusal, status: result.status,
          before: before.placementContinuations, after: after.placementContinuations, intents: after.intents }));
        expect(env.transmit).not.toHaveBeenCalled();
        expect(after.placementContinuations![0].input).toEqual(input);
        env.state.identity = { realmId: scope.realmId, actorId: scope.actorId };
        if (!refusal) {
          expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
          expect(env.capture).toHaveBeenCalledTimes(2);
        } else {
          expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
          expect(env.capture).toHaveBeenCalledTimes(2);
        }
        expect(after.placementContinuations).toEqual(before.placementContinuations);
      });
  });

  it.each([{field:'actorId', kind:'accepted'}, {field:'realmId', kind:'accepted'}, {field:'actorId', kind:'rejected'}, {field:'realmId', kind:'rejected'}] as const)('does not consume $kind at $field change during the final transmit read', async ({field, kind}) => {
      const env = environment();
      const reading = deferred(), complete = deferred();
      let pauseRead = false, arm = false;
      env.transmit.mockImplementationOnce(async () => {
        arm = true;
        return kind === 'accepted' ? acceptance('A') : { kind: 'rejected', error: { reason: 'original conflict' } };
      });
      const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
        getRecoverableIdentity: async () => {
          if (arm) { arm = false; pauseRead = true; }
          return { ...env.state.identity };
        }, capture: env.capture, build: env.build, transmit: env.transmit });
      await env.storage().create(scope, async (box) => {
        const read = box.read.bind(box);
        vi.spyOn(box, 'read').mockImplementation(async () => {
          const record = await read();
          if (pauseRead) { pauseRead = false; reading.resolve(); await complete.promise; }
          return record;
        });
        const advancing = requester.request(box, 'request', input);
        await reading.promise;
        const before = await read();
        env.state.identity = { ...env.state.identity, [field]: 'different' };
        complete.resolve();
        const result = await advancing;
        const after = await read();
        console.info('RESIDUAL_ACK', JSON.stringify({ field, kind, status: result.status, before, after }));
        expect(before.pending!.request).toEqual(env.transmit.mock.calls[0][0]);
        env.state.identity = { realmId: scope.realmId, actorId: scope.actorId };
        expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
        expect(env.transmit.mock.calls.map(([request]) => request)).toEqual([before.pending!.request, before.pending!.request]);
        expect(env.capture).toHaveBeenCalledTimes(1);
        expect(env.build).toHaveBeenCalledTimes(1);
        expect(after.pending?.request).toEqual(before.pending!.request);
        expect(after.intents).toEqual(before.intents);
      });
  });

  it.each(['actorId', 'realmId'] as const)('does not persist API refusal after %s changes during the refusal authorization read', async (field) => {
    const env = environment();
    const reading = deferred(), complete = deferred();
    let pauseRead = false, arm = false;
    env.state.admissionFailure = 403;
    const admit = env.client.admitTask.bind(env.client);
    vi.spyOn(env.client, 'admitTask').mockImplementationOnce(async (...args) => {
      try { return await admit(...args); } finally { arm = true; }
    });
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        if (arm) { arm = false; pauseRead = true; }
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    await env.storage().create(scope, async (box) => {
      const read = box.read.bind(box);
      vi.spyOn(box, 'read').mockImplementation(async () => {
        const record = await read();
        if (pauseRead) { pauseRead = false; reading.resolve(); await complete.promise; }
        return record;
      });
      const advancing = requester.request(box, 'request', input);
      await reading.promise;
      const before = await read();
      env.state.identity = { ...env.state.identity, [field]: 'different' };
      complete.resolve();
      const result = await advancing;
      const after = await read();
      console.info('RESIDUAL_REFUSAL', JSON.stringify({ field, status: result.status,
        before: before.placementContinuations, after: after.placementContinuations }));
      env.state.identity = { realmId: scope.realmId, actorId: scope.actorId };
      env.state.admissionFailure = 0;
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
      expect(env.calls.filter((c) => c.method === 'POST')).toEqual([prepared, prepared]);
      expect(env.capture).toHaveBeenCalledTimes(1);
      expect(after.placementContinuations).toEqual(before.placementContinuations);
    });
  });
});

describe('independent claim and microtask handoffs', () => {
  it('never POSTs from a claim released by a promise reaction to the final read', async () => {
    const env = environment();
    const release = deferred();
    const held = new Set<string>();
    let ownerReleased = false;
    const storage = createCommitOutbox({ indexedDB: env.factory, exclusiveLock: async (name, work) => {
      if (held.has(name)) throw new Error('Outbox is already claimed');
      held.add(name);
      try { return await work(); } finally { held.delete(name); ownerReleased = true; }
    } });
    let checks = 0, handoff = false, claimReturned = false;
    let late!: ReturnType<ReturnType<typeof createPlacementRequester>['resume']>;
    let ownerId!: string;
    const posts: unknown[] = [];
    const admit = env.client.admitTask.bind(env.client);
    vi.spyOn(env.client, 'admitTask').mockImplementation(async (...args) => {
      posts.push({ claimReturned, ownerReleased, identity: { ...env.state.identity } });
      return admit(...args);
    });
    const requester = createPlacementRequester({ client: env.client, outboxes: storage,
      getRecoverableIdentity: async () => {
        checks += 1;
        if (checks === 3) handoff = true;
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    await storage.create(scope, async (box, id) => {
      ownerId = id;
      await env.reserve(box);
      const read = box.read.bind(box);
      vi.spyOn(box, 'read').mockImplementation(() => {
        const pending = read();
        if (!handoff) return pending;
        handoff = false;
        return pending.then((record) => {
          release.resolve(); // ordinary promise reaction releases the claim callback
          return Promise.resolve(record);
        });
      });
      late = requester.resume(box);
      await release.promise;
      claimReturned = true;
    });
    const result = await late;
    await storage.recover(scope, ownerId, async (box) => {
      console.info('MICROTASK_POST', JSON.stringify({ posts, result, saved: await box.read() }));
      expect((await box.read()).placementContinuations![0].taskLocator).toBeUndefined();
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
    });
    expect(posts.slice(0, -1)).toEqual([]);
  });

  it.each(['capture', 'transmit', 'refusal'] as const)('does not mutate %s after a promise reaction releases the claim following its final read', async (stage) => {
    const env = environment();
    const release = deferred();
    let arm = false, handoff = false;
    let late!: Promise<unknown>;
    let ownerId!: string;
    let before!: Awaited<ReturnType<ClaimedOutbox['read']>>;
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        if (arm) { arm = false; handoff = true; }
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    if (stage === 'capture') {
      const capture = env.capture.getMockImplementation()!;
      env.capture.mockImplementationOnce(async (saved) => { arm = true; return capture(saved); });
    } else if (stage === 'transmit') env.transmit.mockImplementationOnce(async () => { arm = true; return acceptance('A'); });
    else {
      env.state.admissionFailure = 403;
      const admit = env.client.admitTask.bind(env.client);
      vi.spyOn(env.client, 'admitTask').mockImplementationOnce(async (...args) => {
        try { return await admit(...args); } finally { arm = true; }
      });
    }
    await env.storage().create(scope, async (box, id) => {
      ownerId = id;
      const read = box.read.bind(box);
      vi.spyOn(box, 'read').mockImplementation(() => {
        const pending = read();
        if (!handoff) return pending;
        handoff = false;
        return pending.then((record) => {
          before = record;
          release.resolve();
          return record;
        });
      });
      late = requester.request(box, 'request', input);
      await release.promise;
    });
    await late;
    await env.storage().recover(scope, ownerId, async (box) => {
      const after = await box.read();
      console.info('MICROTASK_MUTATION', JSON.stringify({ stage, before, after }));
      expect(after).toEqual({ ...before, generation: 2 });
      env.state.admissionFailure = 0;
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
      if (stage === 'transmit') {
        expect(env.transmit.mock.calls.map(([request]) => request)).toEqual([before.pending!.request, before.pending!.request]);
        expect(env.build).toHaveBeenCalledTimes(1);
        expect(env.capture).toHaveBeenCalledTimes(1);
      }
    });
  });
});

describe('requester checks at the mutation and callback boundaries', () => {
  it.each(['actorId', 'realmId'] as const)('revalidates %s in the actual storage callback', async (field) => {
    for (const stage of ['locator', 'capture', 'capture-refusal', 'accepted', 'rejected', 'api-refusal'] as const) {
      const env = environment();
      let arm = false, delayWrite = false;
      const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
        getRecoverableIdentity: async () => {
          if (arm) { arm = false; delayWrite = true; }
          return { ...env.state.identity };
        }, capture: env.capture, build: env.build, transmit: env.transmit });
      if (stage === 'locator' || stage === 'api-refusal') {
        if (stage === 'api-refusal') env.state.admissionFailure = 403;
        const admit = env.client.admitTask.bind(env.client);
        vi.spyOn(env.client, 'admitTask').mockImplementationOnce(async (...args) => {
          try { return await admit(...args); } finally { arm = true; }
        });
      } else if (stage === 'capture' || stage === 'capture-refusal') {
        const capture = env.capture.getMockImplementation()!;
        env.capture.mockImplementationOnce(async (saved) => {
          arm = true;
          if (stage === 'capture-refusal') throw new Error('Original semantic refusal');
          return capture(saved);
        });
      } else env.transmit.mockImplementationOnce(async () => {
        arm = true;
        return stage === 'accepted' ? acceptance('A') : { kind: 'rejected', error: { reason: 'original conflict' } };
      });
      await env.storage().create(scope, async (box) => {
        let before!: Awaited<ReturnType<ClaimedOutbox['read']>>;
        const read = box.read.bind(box);
        vi.spyOn(box, 'read').mockImplementation(async () => {
          const record = await read();
          if (delayWrite) {
            delayWrite = false;
            before = record;
            // Run before the real mutation's get-success handler, after every authorization read.
            env.fault.beforeWrite = () => { env.state.identity = { ...env.state.identity, [field]: 'different' }; };
          }
          return record;
        });
        expect((await requester.request(box, 'request', input)).status).toBe('retry');
        expect(await read()).toEqual(before);
        expect(before.placementContinuations![0].input).toEqual(input);
        if (stage === 'accepted' || stage === 'rejected') expect(before.pending!.request).toEqual(env.transmit.mock.calls[0][0]);
        env.state.identity = { realmId: scope.realmId, actorId: scope.actorId };
        env.state.admissionFailure = 0;
        expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
        if (stage === 'accepted' || stage === 'rejected') {
          expect(env.transmit.mock.calls.map(([request]) => request)).toEqual([before.pending!.request, before.pending!.request]);
          expect(env.build).toHaveBeenCalledTimes(1);
        }
        expect(env.capture.mock.lastCall![0]).toMatchObject({ input, mediaPin: pin });
        expect(env.calls.filter((call) => call.method === 'POST')).toEqual(
          stage === 'locator' || stage === 'api-refusal' ? [prepared, prepared] : [prepared]);
      });
    }
  });

  it.each(['capture', 'transmit'] as const)('never invokes %s after its final read releases the claim in a promise reaction', async (stage) => {
    const env = environment();
    const release = deferred();
    let arm = false, handoff = false, ownerId = '';
    let late!: Promise<unknown>;
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        if (arm) { arm = false; handoff = true; }
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    await env.storage().create(scope, async (box, id) => {
      ownerId = id;
      if (stage === 'capture') {
        const capture = box.capturePlacement.bind(box);
        vi.spyOn(box, 'capturePlacement').mockImplementation((...args) => { arm = true; return capture(...args); });
      } else {
        const build = env.build.getMockImplementation()!;
        env.build.mockImplementationOnce((...args) => { arm = true; return build(...args); });
      }
      const read = box.read.bind(box);
      vi.spyOn(box, 'read').mockImplementation(() => {
        const pending = read();
        if (!handoff) return pending;
        handoff = false;
        return pending.then((record) => {
          release.resolve();
          return Promise.resolve(record);
        });
      });
      late = requester.request(box, 'request', input);
      await release.promise;
    });
    await late;
    expect(env.transmit).not.toHaveBeenCalled();
    if (stage === 'capture') expect(env.capture).not.toHaveBeenCalled();
    await env.storage().recover(scope, ownerId, async (box) => {
      const before = await box.read();
      expect(before.generation).toBe(2);
      expect(before.placementContinuations![0].conflict).toBeUndefined();
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
      if (stage === 'transmit') {
        expect(env.transmit.mock.lastCall![0]).toEqual(before.pending!.request);
        expect(env.build).toHaveBeenCalledTimes(1);
      }
      expect(env.capture).toHaveBeenCalledTimes(1);
      expect(env.calls.filter((call) => call.method === 'POST')).toEqual([prepared]);
    });
  });

  it('leaves the helper inactive when the authenticated host lifecycle binding is missing', async () => {
    const env = environment();
    const { admitTask, getTask, listManagedOutputs, getProjectMediaSelection } = env.client;
    const requester = createPlacementRequester({ client: {
      admitTask: admitTask.bind(env.client), getTask: getTask.bind(env.client),
      listManagedOutputs: listManagedOutputs.bind(env.client), getProjectMediaSelection: getProjectMediaSelection.bind(env.client),
    }, outboxes: env.storage(), getRecoverableIdentity: async () => ({ ...env.state.identity }), capture: env.capture,
    build: env.build, transmit: env.transmit });
    await env.storage().create(scope, async (box) => {
      const before = await box.read();
      await expect(requester.request(box, 'request', input)).rejects.toThrow('identity lifecycle binding is unavailable');
      expect(await box.read()).toEqual(before);
      await env.reserve(box);
    });
    expect(await requester.recover()).toMatchObject([{ status: 'retry', message: 'Authenticated requester identity lifecycle binding is unavailable' }]);
    expect(env.calls).toEqual([]);
    expect(env.capture).not.toHaveBeenCalled();
    expect(env.transmit).not.toHaveBeenCalled();
  });

  it('rejects an asynchronous host check instead of treating its promise as live identity', async () => {
    const env = environment();
    Object.assign(env.client, { isCurrentIdentity: async () => true });
    await env.storage().create(scope, async (box) => {
      const before = await box.read();
      await expect(env.requester().request(box, 'request', input)).rejects.toThrow('identity changed or is unavailable');
      expect(await box.read()).toEqual(before);
      expect(env.calls).toEqual([]);
    });
  });

  it('honors host invalidation even when the actor and realm strings are unchanged', async () => {
    const env = environment();
    const checking = deferred(), complete = deferred();
    let invalidated = false, arm = false;
    const isCurrent = env.client.isCurrentIdentity.bind(env.client);
    env.client.isCurrentIdentity = (identity) => !invalidated && isCurrent(identity);
    env.transmit.mockImplementationOnce(async () => { arm = true; return acceptance('A'); });
    const requester = createPlacementRequester({ client: env.client, outboxes: env.storage(),
      getRecoverableIdentity: async () => {
        if (arm) { arm = false; checking.resolve(); await complete.promise; }
        return { ...env.state.identity };
      }, capture: env.capture, build: env.build, transmit: env.transmit });
    await env.storage().create(scope, async (box) => {
      const advancing = requester.request(box, 'request', input);
      await checking.promise;
      const before = await box.read();
      invalidated = true;
      complete.resolve();
      expect((await advancing).status).toBe('retry');
      const retained = await box.read();
      expect(retained.pending!.request).toEqual(before.pending!.request);
      expect(retained.intents).toEqual(before.intents);
      expect(retained.placementContinuations).toEqual(before.placementContinuations);
      invalidated = false; // explicit authenticated host recovery, with the original identity
      expect(await requester.resume(box)).toMatchObject([{ status: 'accepted' }]);
      expect(env.transmit.mock.calls.map(([request]) => request)).toEqual([before.pending!.request, before.pending!.request]);
    });
  });
});
