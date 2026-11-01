import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { QueryClient } from '@tanstack/react-query';
import { runtimeTaskQueryKey, subscribeRuntimeTaskUpdates } from '@/features/tasks/components/TasksPane/hooks/useRuntimeTaskEvents.ts';
import { initializeWorkspaceRuntimeIdentity, RUNTIME_CLIENT_SCOPES } from '@/integrations/runtime/client.ts';
import { RUNTIME_SCHEMA_DIGEST, RUNTIME_TARGETED_EXECUTION_CAPABILITY } from '@/integrations/runtime/contract-metadata.ts';
import { RuntimeOperationHost, type RuntimeOperation } from '@/integrations/runtime/operationHost.ts';
import { createEditorImagePlacementHost } from '@/integrations/runtime/clientLocalAdapter.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CanonicalDocument, CommitAcceptedMutation, CommitRequest, Task } from '@/integrations/runtime/generated.ts';
import { createTask } from '@/shared/lib/taskCreation/createTask.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createCommitOutbox } from './commitOutbox.ts';
import { createTimelineCommandSession } from './commitSession.ts';
import { createShotCompositionAdapter } from '../data/shotCompositionAdapter.ts';
import { projectCanonicalComposition } from '../data/shotCompositionProjection.ts';

vi.mock('@/integrations/runtime/client.ts', async (original) => ({
  ...await original<typeof import('@/integrations/runtime/client.ts')>(),
  initializeWorkspaceRuntimeIdentity: vi.fn(),
}));
const launch = { actorId: 'astrid-app', realmId: 'placement-realm', runtimeInstanceId: 'placement-instance' };
const scope = { realmId: launch.realmId, actorId: launch.actorId, projectId: 'project-commit', timelineId: 'timeline-commit' };
const root = '/runtime-config/v1/operation';
const h0 = { revisionId: 'r0', publicationId: 'p0' };
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const pin = { asset: 'variant', generation_id: 'generation', variant_id: 'variant', object_id: digest('a'), catalog_digest: digest('b') };
const output = { group_key: 'pictures', variant_key: 'approved', output_port: 'image', ordinal: 0 };
const admission = {
  project: scope.projectId, capability_id: 'generation.generate_image', capability_digest: digest('c'), schema_version: '1' as const,
  input_object_ids: [], spec: { family: 'generation.generate_image', params: { count: 1 }, output_policy: {} },
  storage_estimate: { scratch_bytes: 1, output_bytes: 1 }, generation_intent: { prompt: 'saved prompt' },
  settlement_effect: { effect_type: 'generation.publish_v1' as const, target_id: scope.projectId, payload: {
    version: 1, modality: 'image' as const, generation_type: 'image', metadata: {}, partial_success_policy: 'reject' as const,
    groups: [{ group_key: output.group_key, selectors: [{ variant_key: output.variant_key, output_port: output.output_port, ordinal: output.ordinal, selector: 'requested' }] }],
  } },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function reply(value: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => value,
    arrayBuffer: async () => bytes.buffer } as Response;
}
const sessions: Array<Awaited<ReturnType<typeof createTimelineCommandSession>>> = [];
const operationHosts: RuntimeOperationHost[] = [];
beforeEach(() => vi.mocked(initializeWorkspaceRuntimeIdentity).mockResolvedValue({ ...launch }));
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  operationHosts.splice(0).forEach((host) => host.dispose());
  vi.restoreAllMocks();
});

// Real production binding/capture/pump; HTTP acceptance and IDB are unit fixtures.
function environment() {
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'old', publication_id: 'old' }, { children: true }).data.canonical_document;
  document.parent_revision.payload.occurrences = (document.parent_revision.payload.occurrences as unknown[]).slice(0, 1) as never;
  (document.parent_revision.payload.config as Record<string, unknown>).output = { fps: 30 };
  (document.parent_revision.payload.occurrences as Array<Record<string, unknown>>)[0].duration_ms = 10000;
  document.internal_timeline_revisions[0].payload.registry = { assets: {} };
  document.internal_timeline_revisions[0].content_digest = fixtureDigest(document.internal_timeline_revisions[0].payload);
  document.dependency_manifest.internal_timelines[0].content_digest = document.internal_timeline_revisions[0].content_digest;
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  const initial: TimelineCommandBasis = { head: h0, canonicalDocument: document };
  const task: Task = { task_id: 'task', run_id: 'run', project_id: scope.projectId, state: 'running', version: 1,
    capability_id: admission.capability_id, capability_digest: admission.capability_digest, idempotency_key: '',
    created_at: '', updated_at: '', runtime_epoch: 1, input_object_ids: [], spec: {}, attempt_id: 'attempt',
    result: { generation_publish_v1: { publications: [{ group_key: output.group_key, generation_id: pin.generation_id,
      variants: [{ ...output, ...pin }] }] } } };
  const held = new Set<string>();
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (key, work) => {
    if (held.has(key)) throw new Error('Claim is already held');
    held.add(key);
    try { return await work(); } finally { held.delete(key); }
  } });
  const calls: Array<{ path: string; method: string; body?: string; key: string | null }> = [];
  const receipts = new Map<string, CommitAcceptedMutation>();
  const taskQueries = new QueryClient();
  const events = new Set<() => void>();
  let lostAdmission = false, lostCommit = false, conflict = false, holdAdmission = false, handle = 0;
  let admissionGate: ReturnType<typeof deferred<void>> | undefined;
  let taskRead: ReturnType<typeof deferred<void>> | undefined;
  let verifiedRead: ReturnType<typeof deferred<void>> | undefined;
  let projection: ReturnType<typeof deferred<void>> | undefined;
  let eventReady: ReturnType<typeof deferred<void>> | undefined;
  const fetchImpl = async (url: RequestInfo | URL, options: RequestInit = {}) => {
    const path = String(url), headers = new Headers(options.headers);
    const body = ArrayBuffer.isView(options.body) ? new TextDecoder().decode(options.body) : typeof options.body === 'string' ? options.body : undefined;
    calls.push({ path, method: options.method ?? 'GET', body, key: headers.get('Idempotency-Key') });
    if (path === root) return options.method === 'POST'
      ? reply({ schemaVersion: 1, handle: (++handle).toString(16).padStart(64, '0'), identity: launch }, 201) : reply(null, 204);
    if (path.endsWith('/v1/health')) return reply({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_instance_id: launch.runtimeInstanceId });
    if (path.endsWith('/v1/handshake')) return reply({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, actor_id: launch.actorId,
      realm_id: launch.realmId, scopes: RUNTIME_CLIENT_SCOPES, capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] });
    if (path.endsWith('/v1/realm')) return reply({ realm_id: launch.realmId });
    if (path.endsWith('/v1/tasks') && options.method === 'POST') {
      task.idempotency_key = headers.get('Idempotency-Key')!;
      if (holdAdmission) { holdAdmission = false; await admissionGate?.promise; }
      if (lostAdmission) { lostAdmission = false; throw new Error('Lost admission ACK'); }
      return reply({ data: task, receipt: {} }, 201);
    }
    if (path.endsWith('/v1/tasks/task')) { await taskRead?.promise; return reply(structuredClone(task)); }
    if (path.includes('/managed-outputs')) return reply({ items: [{ ...output, association_id: 'association', task_id: task.task_id,
      run_id: task.run_id, attempt_id: task.attempt_id, project_id: scope.projectId, object_id: pin.object_id, digest: pin.object_id,
      selector: { group_key: output.group_key, variant_key: output.variant_key }, durability: 'durable', role: 'output', media_type: 'image/png',
      lifecycle: { state: 'available', version: 1 } }], next_cursor: null });
    if (path.includes('/media-selection/verified?')) { await verifiedRead?.promise; return reply({ selection: pin, media_type: 'image/png', size: 123 }); }
    if (path.includes('/media-selection?')) return reply(pin);
    if (path.endsWith('/commit')) {
      if (conflict) return reply({ code: 'conflict', message: 'Original lane changed', details: { status: 'conflict' } }, 409);
      const request = JSON.parse(body!) as CommitRequest, key = headers.get('Idempotency-Key')!;
      if (!receipts.has(key)) {
        const next = receipts.size + 1;
        const receipt = acceptedCommit({ revision_id: `r${next}`, publication_id: `p${next}` },
          { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, { commands: request.commands });
        receipt.receipt.idempotency_key = key;
        receipts.set(key, receipt);
      }
      if (lostCommit) { lostCommit = false; throw new Error('Lost commit ACK'); }
      return reply(receipts.get(key));
    }
    throw new Error(`Unexpected fixture request ${path}`);
  };
  const projected: TimelineCommandBasis[] = [];
  const directSend = vi.fn<(request: CommitRequest, key: string) => Promise<TimelineCommitResult>>(async () => { throw new Error('Placement must use the bound operation'); });
  const mount = async (basis = initial, project?: (basis: TimelineCommandBasis) => Promise<void>, existingOperation?: RuntimeOperation) => {
    const operationHost = new RuntimeOperationHost(fetchImpl as typeof fetch);
    operationHosts.push(operationHost);
    const operation = existingOperation ?? await operationHost.bind();
    const host = createEditorImagePlacementHost(operation, scope.projectId);
    const session = await createTimelineCommandSession({ scope, initial: basis, outboxes,
      imagePlacementHost: { ...host, taskEventsReady: async () => { await eventReady?.promise; }, subscribe: (notify) => {
        events.add(notify);
        const unsubscribe = subscribeRuntimeTaskUpdates(taskQueries, scope.projectId, notify);
        return () => { events.delete(notify); unsubscribe(); };
      } },
      send: directSend, preview: () => { throw new Error('Automatic placement has no optimistic preview'); }, changed: () => {},
      project: async (accepted) => { await projection?.promise; await project?.(accepted); projected.push(accepted); },
    });
    sessions.push(session);
    return { session, operationHost, operation };
  };
  async function admit(session: Awaited<ReturnType<typeof mount>>['session'],
    target = { ownerRef: 'occurrence:occ-0', lane: 'V1', anchor: null as string | null }) {
    const prepared = await session.imageGeneration.prepare(target);
    const client = {
      tasks: prepared.client.tasks,
      catalog: { bind: async (_capabilityId: string, expectedDigest?: string) => expectedDigest ?? admission.capability_digest },
      objects: { list: async () => ({ items: [], next_cursor: null }) },
    };
    await createTask(admission, { client, reservation: prepared.reservation });
  }
  return { initial, outboxes, task, calls, receipts, projected, directSend, events, mount, admit,
    notify: () => taskQueries.setQueryData(runtimeTaskQueryKey(scope.projectId), [structuredClone(task)]),
    commits: () => calls.filter((call) => call.path.endsWith('/commit')),
    admissions: () => calls.filter((call) => call.path.endsWith('/v1/tasks')),
    loseAdmission: () => { lostAdmission = true; }, loseCommit: () => { lostCommit = true; }, refuse: () => { conflict = true; },
    pauseAdmission: () => {
      holdAdmission = true;
      admissionGate = deferred<void>();
      return { release: () => { holdAdmission = false; admissionGate?.resolve(); } };
    },
    pauseTask: () => (taskRead = deferred<void>()), pauseVerified: () => (verifiedRead = deferred<void>()),
    pauseProjection: () => (projection = deferred<void>()),
    pauseEvents: () => (eventReady = deferred<void>()),
  };
}

describe('production command session automatic image continuation', () => {
  it('waits for the existing task cursor before admission and fences retirement during that wait', async () => {
    const env = environment(), { session } = await env.mount(), gate = env.pauseEvents();
    const preparing = session.imageGeneration.prepare({ ownerRef: 'occurrence:occ-0', lane: 'V1', anchor: null });
    const refused = expect(preparing).rejects.toThrow('Stale outbox claim');
    expect(env.admissions()).toEqual([]);
    expect((await env.outboxes.list(scope))[0].placementContinuations).toBeUndefined();
    await session.dispose();
    gate.resolve(); await refused;
    expect(env.admissions()).toEqual([]);
  });

  it.each([false, true])('does not re-admit while the original reserved task POST is pending, then recovers (lost ACK: %s)', async (lostAck) => {
    const env = environment(), first = await env.mount(), gate = env.pauseAdmission();
    const admitting = env.admit(first.session);
    await vi.waitFor(() => expect(env.admissions()).toHaveLength(1));
    const [reserved] = await env.outboxes.list(scope);
    const original = structuredClone(reserved.placementContinuations![0].input);
    expect(reserved.placementContinuations![0].taskLocator).toBeUndefined();
    expect(first.operation.isTaskSubmissionActive(original.request)).toBe(true);
    // Refresh the durable reservation, then drain each existing wake while
    // the original submit still has no acknowledgement or task locator.
    await first.session.retry();
    first.session.observe(env.initial);
    await first.session.resumePlacements();
    env.notify();
    await first.session.resumePlacements();
    expect(env.admissions()).toHaveLength(1);

    if (lostAck) env.loseAdmission();
    gate.release();
    if (lostAck) await expect(admitting).rejects.toThrow();
    else await admitting;
    expect(first.operation.isTaskSubmissionActive(original.request)).toBe(false);
    expect(env.admissions()).toHaveLength(1);
    await first.session.dispose();

    const [saved] = await env.outboxes.list(scope);
    env.task.state = 'succeeded';
    const second = await env.mount();
    await second.session.recover(saved.ownerId);
    expect(second.session.getState()).toMatchObject({ status: 'saved', canUndo: true });
    expect(env.admissions()).toHaveLength(lostAck ? 2 : 1);
    for (const { body, key } of env.admissions()) expect({ body, key }).toEqual({ body: original.request.body, key: original.request.key });
    const [accepted] = await env.outboxes.list(scope);
    expect(accepted.placementContinuations![0]).toMatchObject({ input: original, mediaPin: pin,
      placement: { accepted: { head: { revisionId: 'r1', publicationId: 'p1' } } } });
  });

  it.each(['session', 'operation'] as const)('retires a pending admission on %s disposal and recovers before the old response arrives', async (lifetime) => {
    const env = environment(), first = await env.mount(), gate = env.pauseAdmission();
    const admitting = env.admit(first.session);
    const refused = expect(admitting).rejects.toThrow();
    await vi.waitFor(() => expect(env.admissions()).toHaveLength(1));
    const [saved] = await env.outboxes.list(scope);
    const original = structuredClone(saved.placementContinuations![0].input);
    const stale = [...env.events][0];
    await first.session.dispose();
    if (lifetime === 'operation') first.operationHost.dispose();
    expect(first.operation.isTaskSubmissionActive(original.request)).toBe(false);
    first.session.observe(env.initial); stale();
    env.task.state = 'succeeded';
    const second = await env.mount(env.initial, undefined, lifetime === 'session' ? first.operation : undefined);
    await second.session.recover(saved.ownerId);
    expect(second.session.getState()).toMatchObject({ status: 'saved', canUndo: true });
    const [accepted] = await env.outboxes.list(scope);
    gate.release(); await refused;
    expect(env.admissions()).toHaveLength(2);
    for (const { body, key } of env.admissions()) expect({ body, key }).toEqual({ body: original.request.body, key: original.request.key });
    expect((await env.outboxes.list(scope))[0]).toEqual(accepted);
  });

  it('keeps the Provider-owned operation current when a command session is replaced', async () => {
    const env = environment(), mounted = await env.mount();
    await mounted.session.dispose();
    expect(mounted.operation.isCurrentIdentity(scope)).toBe(true);
  });

  it('discovers task completion on the installed subscription, projects exact acceptance, and registers normal Undo', async () => {
    const env = environment(), { session } = await env.mount();
    await env.admit(session);
    await vi.waitFor(() => expect(env.calls.some((call) => call.path.endsWith('/v1/tasks/task'))).toBe(true));
    const [reserved] = await env.outboxes.list(scope);
    expect(reserved.placementContinuations![0].input).toMatchObject({ head: h0, ownerRef: 'occurrence:occ-0', anchor: null, lane: 'V1' });
    session.observe({ ...env.initial, head: { revisionId: 'observed-newer', publicationId: 'observed-p' } });
    const gate = env.pauseProjection();
    env.task.state = 'succeeded'; env.notify();
    await vi.waitFor(() => expect(env.commits(), JSON.stringify(session.getState())).toHaveLength(1));
    expect(session.getState()).toMatchObject({ status: 'saving', canUndo: false });
    const request = JSON.parse(env.commits()[0].body!) as CommitRequest;
    const command = request.commands[0];
    expect(command).toMatchObject({ op: 'placement.create', select: 'occurrence:occ-0', intent: { ownership: 'occurrence' },
      args: { id: reserved.placementContinuations![0].input.createdIds[0], media: pin } });
    const [placing] = await env.outboxes.list(scope);
    expect(request).toEqual({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
      base_revision_id: h0.revisionId, base_publication_id: h0.publicationId, commands: [command],
      label: 'Place image', steps: [{ id: placing.accepted!.intentId, label: 'Place image',
        intent: 'Place image', tags: [], command_ordinals: [0], patch: [] }],
      merge: 'fields', reads: [], dry_run: false, source: { via: 'app' } });
    expect(command.reads?.length).toBeGreaterThan(0);
    expect(command.created).toContain(`occurrence:occ-0/clip:${reserved.placementContinuations![0].input.createdIds[0]}`);
    expect(placing.accepted!.value).toMatchObject({ receipt: { idempotency_key: env.commits()[0].key } });
    gate.resolve();
    await vi.waitFor(() => expect(session.getState()).toMatchObject({ status: 'saved', canUndo: true }));
    const receipt = env.receipts.get(env.commits()[0].key!)!;
    expect(env.projected.at(-1)).toMatchObject({ head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: receipt.data.canonical_document });
    // Ordinary Undo uses the Runtime publication; it does not mutate a local snapshot.
    env.directSend.mockImplementation(async (request: CommitRequest, key: string) => {
      const { decodeAcceptedTimelineCommit } = await import('@/integrations/runtime/dataProvider.ts');
      const response = acceptedCommit({ revision_id: 'r2', publication_id: 'p2' }, { revision_id: 'r1', publication_id: 'p1' }, { commands: request.commands });
      response.receipt.idempotency_key = key;
      return decodeAcceptedTimelineCommit(response, scope.projectId, scope.timelineId);
    });
    await session.undo(); await session.flush();
    expect(env.directSend).toHaveBeenCalledWith(expect.objectContaining({ commands: [expect.objectContaining({ op: 'timeline.inverse', args: { publications: ['p1'] } })] }), expect.any(String));
    const [inverse, inverseKey] = env.directSend.mock.calls[0];
    const [undone] = await env.outboxes.list(scope);
    expect(inverse).toEqual({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
      base_revision_id: 'r1', base_publication_id: 'p1', commands: [{ schema_version: 1, op: 'timeline.inverse',
        version: '1', select: null, args: { publications: ['p1'] } }],
      label: 'Undo timeline', steps: [{ id: undone.accepted!.intentId, label: 'Undo timeline', intent: 'Undo timeline',
        tags: [], command_ordinals: [0], patch: [] }], merge: 'fields', reads: [], dry_run: false, source: { via: 'app' } });
    expect(undone.accepted!.value).toMatchObject({ receipt: { idempotency_key: inverseKey } });
  });

  it('reopens the original admission and lost-ACK commit with identical bytes/key and without recapture', async () => {
    const env = environment(), first = await env.mount();
    env.loseAdmission();
    await expect(env.admit(first.session)).rejects.toThrow();
    await first.session.dispose();
    const [saved] = await env.outboxes.list(scope);
    const original = structuredClone(saved.placementContinuations![0].input);
    env.task.state = 'succeeded'; env.loseCommit();
    const newer = { ...env.initial, head: { revisionId: 'newer', publicationId: 'newer-p' },
      canonicalDocument: { ...env.initial.canonicalDocument, parent_revision: { ...env.initial.canonicalDocument.parent_revision, revision_id: 'newer' } } };
    const second = await env.mount(newer);
    await second.session.recover(saved.ownerId);
    expect(second.session.getState()).toMatchObject({ status: 'retry' });
    const [pending] = await env.outboxes.list(scope), exact = structuredClone(pending.pending!.request);
    expect(JSON.parse(exact.body)).toMatchObject({ label: 'Place image', dry_run: false,
      steps: [{ id: pending.intents[0].id, command_ordinals: [0], patch: [] }], merge: 'fields', reads: [] });
    expect(env.admissions().every((call) => call.body === original.request.body && call.key === original.request.key)).toBe(true);
    await second.session.dispose();
    const reads = env.calls.filter((call) => call.path.includes('/media-selection')).length;
    const third = await env.mount();
    await third.session.recover(saved.ownerId);
    expect(third.session.getState()).toMatchObject({ status: 'saved', canUndo: true });
    expect(env.projected.at(-1)!.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
    expect(JSON.parse(exact.body)).toMatchObject({ base_revision_id: 'r0', base_publication_id: 'p0' });
    expect(env.commits().map(({ body, key }) => ({ body, key }))).toEqual([{ body: exact.body, key: exact.key }, { body: exact.body, key: exact.key }]);
    expect(env.calls.filter((call) => call.path.includes('/media-selection'))).toHaveLength(reads);
    const [accepted] = await env.outboxes.list(scope);
    expect(accepted.placementContinuations![0].input).toEqual(original);
    expect(accepted.placementContinuations![0].mediaPin).toEqual(pin);
    expect(accepted.placementContinuations![0].placement?.accepted?.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
  });

  it('projects the original saved placement closure before retrying a lost ACK after reload', async () => {
    const env = environment();
    const internal = env.initial.canonicalDocument.internal_timeline_revisions[0];
    (internal.payload.tracks as Array<Record<string, unknown>>).push({ id: 'V2', kind: 'visual' });
    internal.content_digest = fixtureDigest(internal.payload);
    env.initial.canonicalDocument.dependency_manifest.internal_timelines[0].content_digest = internal.content_digest;
    const first = await env.mount();
    env.loseAdmission();
    await expect(env.admit(first.session, { ownerRef: 'occurrence:occ-0', lane: 'V2', anchor: 'child-title' })).rejects.toThrow();
    await first.session.dispose();
    const [reserved] = await env.outboxes.list(scope);
    env.task.state = 'succeeded'; env.loseCommit();
    const second = await env.mount();
    await second.session.recover(reserved.ownerId);
    expect(second.session.getState().status).toBe('retry');
    await second.session.dispose();
    const [saved] = await env.outboxes.list(scope);
    const exact = structuredClone(saved.pending!.request);
    const continuation = structuredClone(saved.placementContinuations![0]);
    expect(JSON.parse(exact.body).commands[0]).toMatchObject({ op: 'occurrence.add-media', select: 'occurrence:occ-0',
      args: { row: { track: 'V2', clipType: 'image' }, media: pin } });
    expect(continuation.input).toMatchObject({ autoApprove: true, lane: 'V2', anchor: 'child-title' });
    // Production automatic capture saves the original document without a graph.
    expect(saved.intents[0].payload).toMatchObject({ displayBasis: { head: h0 } });
    expect((saved.intents[0].payload as { displayBasis: unknown }).displayBasis).not.toHaveProperty('graph');
    const read = vi.fn(async () => { throw new Error('Recovery cannot refresh the original closure'); });
    const adapter = createShotCompositionAdapter({ load: read });
    const project = vi.fn(async (basis: TimelineCommandBasis) => {
      if (basis.canonicalDocument.parent_revision.payload.occurrences.length) {
        // The editor's projection boundary requires a complete pinned shot graph.
        if (!basis.graph) throw new Error('Accepted shot closure cannot be projected');
        projectCanonicalComposition(adapter.prepare(basis.graph));
      }
    });
    const reads = env.calls.filter((call) => /tasks|media-selection/.test(call.path)).length;
    const newer = { ...env.initial, head: { revisionId: 'newer', publicationId: 'newer-p' },
      canonicalDocument: { ...env.initial.canonicalDocument, parent_revision: { ...env.initial.canonicalDocument.parent_revision, revision_id: 'newer' } } };
    const recovered = await env.mount(newer, project);
    await recovered.session.recover(saved.ownerId);
    expect(project.mock.calls[0][0]).toMatchObject({ head: h0, canonicalDocument: env.initial.canonicalDocument });
    expect(recovered.session.getState()).toMatchObject({ status: 'saved', canUndo: true });
    expect(env.commits().map(({ body, key }) => ({ body, key }))).toEqual([
      { body: exact.body, key: exact.key }, { body: exact.body, key: exact.key },
    ]);
    const [accepted] = await env.outboxes.list(scope);
    expect(accepted.pending).toBeUndefined();
    expect(accepted.intents).toEqual([]);
    expect(accepted.placementContinuations![0]).toMatchObject({ input: continuation.input, mediaPin: continuation.mediaPin,
      placement: { intentId: continuation.placement!.intentId, accepted: { head: { revisionId: 'r1', publicationId: 'p1' },
        value: { response: env.receipts.get(exact.key) } } } });
    expect(env.calls.filter((call) => /tasks|media-selection/.test(call.path))).toHaveLength(reads);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['missing dependency manifest', (document: CanonicalDocument) => {
      delete (document as unknown as Record<string, unknown>).dependency_manifest;
    }, 'dependency_manifest'],
    ['changed project scope', (document: CanonicalDocument) => { document.project_id = 'other-project'; }, 'outside the requested project/timeline'],
  ] as const)('refuses a corrupt original closure (%s) and retains the saved draft', async (_name, corrupt, reason) => {
    const env = environment(), first = await env.mount();
    env.loseAdmission();
    await expect(env.admit(first.session)).rejects.toThrow();
    await first.session.dispose();
    const [saved] = await env.outboxes.list(scope);
    env.task.state = 'succeeded'; env.loseCommit();
    const second = await env.mount();
    await second.session.recover(saved.ownerId);
    expect(second.session.getState().status).toBe('retry');
    await second.session.dispose();
    const [pending] = await env.outboxes.list(scope);
    const beforeRefusal = { intents: structuredClone(pending.intents), pending: structuredClone(pending.pending) };
    const newer = { ...env.initial, head: { revisionId: 'newer', publicationId: 'newer-p' },
      canonicalDocument: { ...env.initial.canonicalDocument, parent_revision: { ...env.initial.canonicalDocument.parent_revision, revision_id: 'newer' } } };
    const recovered = await env.mount(newer);
    const recover = env.outboxes.recover;
    vi.spyOn(env.outboxes, 'recover').mockImplementation((outboxScope, owner, work) => recover(outboxScope, owner, async (box) => work({
      ...box,
      read: async () => {
        const record = await box.read();
        const payload = record.intents[0]?.payload as unknown as { displayBasis?: { canonicalDocument?: CanonicalDocument } } | undefined;
        if (payload?.displayBasis?.canonicalDocument) corrupt(payload.displayBasis.canonicalDocument);
        return record;
      },
    })));
    await expect(recovered.session.recover(pending.ownerId)).rejects.toThrow(reason);
    expect(recovered.session.getState()).toMatchObject({ status: 'error' });
    expect(env.projected).toEqual([]);
    expect(env.commits()).toHaveLength(1);
    const [retained] = await env.outboxes.list(scope);
    expect({ intents: retained.intents, pending: retained.pending }).toEqual(beforeRefusal);
  });

  it('honors explicit recovery while an observation is already resuming the saved placement', async () => {
    const env = environment(), first = await env.mount();
    env.loseAdmission();
    await expect(env.admit(first.session)).rejects.toThrow();
    await first.session.dispose();
    const [reserved] = await env.outboxes.list(scope);
    env.task.state = 'succeeded'; env.loseCommit();
    const second = await env.mount();
    await second.session.recover(reserved.ownerId);
    expect(second.session.getState().status).toBe('retry');
    await second.session.dispose();
    const [saved] = await env.outboxes.list(scope);
    const exact = structuredClone(saved.pending!.request);
    const continuation = structuredClone(saved.placementContinuations![0]);
    const recovered = await env.mount();
    const projection = env.pauseProjection();
    const reading = deferred<void>(), read = deferred<void>();
    const recover = env.outboxes.recover;
    vi.spyOn(env.outboxes, 'recover').mockImplementation((scope, owner, work) => recover(scope, owner, async (box) => {
      let reads = 0;
      return work({ ...box, read: async () => {
        const record = await box.read();
        if (++reads === 2) { reading.resolve(); await read.promise; }
        return record;
      } });
    }));
    const recovering = recovered.session.recover(saved.ownerId);
    await vi.waitFor(() => expect(recovered.session.getState().ownerId).toBe(saved.ownerId));
    // An in-flight canonical observation can wake the non-retrying pump while
    // the recovered session is still projecting its original display.
    recovered.session.observe(env.initial);
    await reading.promise;
    projection.resolve();
    await vi.waitFor(() => expect(recovered.session.getState().status).toBe('dirty'));
    read.resolve();
    await recovering;
    expect(recovered.session.getState()).toMatchObject({ status: 'saved', canUndo: true });
    expect(env.commits().map(({ body, key }) => ({ body, key }))).toEqual([
      { body: exact.body, key: exact.key }, { body: exact.body, key: exact.key },
    ]);
    const [accepted] = await env.outboxes.list(scope);
    expect(accepted.pending).toBeUndefined();
    expect(accepted.intents).toEqual([]);
    expect(accepted.placementContinuations![0]).toEqual({ ...continuation,
      placement: { ...continuation.placement, accepted: accepted.accepted } });
    expect(accepted.accepted!.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
    expect((accepted.accepted!.value as unknown as TimelineCommitResult).response).toEqual(env.receipts.get(exact.key));
    expect(env.receipts.size).toBe(1);
    expect(env.directSend).not.toHaveBeenCalled();
  });

  it.each(['cancel_requested', 'cancelled', 'failed'] as const)('retains the draft on task %s without native capture or commit', async (state) => {
    const env = environment(), { session } = await env.mount();
    await env.admit(session);
    const [saved] = await env.outboxes.list(scope);
    env.task.state = state; env.notify();
    await vi.waitFor(() => expect(session.getState().status).toBe('conflict'));
    expect(session.getState().error).toContain(state);
    const [retained] = await env.outboxes.list(scope);
    expect(retained.placementContinuations![0].input).toEqual(saved.placementContinuations![0].input);
    expect(env.commits()).toEqual([]);
    expect(env.calls.some((call) => call.path.includes('/media-selection'))).toBe(false);
  });

  it.each(['task', 'verified'] as const)('retires a late %s callback without committing or awaiting its network completion', async (stage) => {
    const env = environment(), { session } = await env.mount();
    env.task.state = 'succeeded';
    const gate = stage === 'task' ? env.pauseTask() : env.pauseVerified();
    await env.admit(session);
    await vi.waitFor(() => expect(env.calls.some((call) => stage === 'task' ? call.path.endsWith('/v1/tasks/task') : call.path.includes('/verified?'))).toBe(true));
    const stale = [...env.events][0];
    const resuming = session.resumePlacements();
    await session.dispose();
    expect(env.events.size).toBe(0);
    gate.resolve(); stale();
    await resuming;
    await vi.waitFor(async () => {
      expect(env.commits()).toHaveLength(0);
      expect((await env.outboxes.list(scope))[0].intents).toEqual([]);
    });
    expect(env.projected).toEqual([]);
  });

  it('preserves original guards and the continuation after a real clash, including retry/reopen', async () => {
    const env = environment(), { session } = await env.mount();
    await env.admit(session);
    env.task.state = 'succeeded'; env.refuse(); env.notify();
    await vi.waitFor(() => expect(session.getState().status).toBe('conflict'));
    const [saved] = await env.outboxes.list(scope), original = structuredClone(saved.pending!.request);
    await session.retry(); await session.dispose();
    const newer = { ...env.initial, head: { revisionId: 'newer', publicationId: 'newer-p' },
      canonicalDocument: { ...env.initial.canonicalDocument, parent_revision: { ...env.initial.canonicalDocument.parent_revision, revision_id: 'newer' } } };
    const recovered = await env.mount(newer);
    await recovered.session.recover(saved.ownerId);
    expect(recovered.session.getState().status).toBe('conflict');
    const [retained] = await env.outboxes.list(scope);
    expect(retained.pending!.request).toEqual(original);
    expect(retained.placementContinuations).toEqual(saved.placementContinuations);
    expect(env.commits(), JSON.stringify(session.getState())).toHaveLength(1);
    expect(JSON.parse(original.body).base_revision_id).toBe('r0');
  });
});
