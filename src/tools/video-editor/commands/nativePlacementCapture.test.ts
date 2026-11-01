import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { WorkspaceClient, type Task, type ManagedOutput, type Transport } from '@/integrations/runtime/generated.ts';
import type { CanonicalDocument, CommitRequest, JSON, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import { createCommitOutbox, type OutboxIntent, type OutboxHead, type OutboxOutcome, type OutboxPlacementContinuation, type OutboxRequest, type OutboxScope } from './commitOutbox.ts';
import { createPlacementRequester, preparePlacementTask, type PlacementCaptureContext } from './placementRequester.ts';
import { createNativePlacementCapture, readNativePlacementCapture, type OriginalPlacementRead } from './nativePlacementCapture.ts';

// One unchanged Agent 80f51496 native input + complete command/record hashes,
// from the corrected port's vectors.json (ad0a0d42). Trusted read fixtures only;
// neither their labels nor these hashes claim Runtime acceptance.
const golden = {"approval":{"autoApprove":true,"owner":"occurrence:occ-a","ownership":"occurrence","clipId":"placed","mode":"completion","anchor":"clip-a","preferredTrack":null,"fallbackAt":null,"fallbackTrack":null},"media":{"asset":"reserved-new","generation_id":"generation-new","variant_id":"variant-new","object_id":"sha256:2222222222222222222222222222222222222222222222222222222222222222","catalog_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"verified":{"selection":{"asset":"reserved-new","generation_id":"generation-new","variant_id":"variant-new","object_id":"sha256:2222222222222222222222222222222222222222222222222222222222222222","catalog_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"media_type":"image/fixture","size":123},"document":{"schema_version":1,"project_id":"project-1","timeline_id":"film","parent_revision":{"revision_id":"parent-1","payload":{"config":{"tracks":[{"id":"picture","kind":"visual"}],"clips":[{"id":"clip-a","track":"picture","asset":"picture","clipType":"media","at":1,"hold":2,"app":{"org.example":{"literal":"clip-a","clear":null}}},{"id":"clip-b","track":"picture","asset":"picture","clipType":"media","at":5,"hold":2,"app":{"org.example":{"literal":"clip-a","clear":null}}}],"output":{"fps":{"numerator":30000,"denominator":1001}},"opaque":{"timestamp":"authored timestamp","v":[null,false,0]}},"clips":[{"id":"clip-a","track":"picture","asset":"picture","clipType":"media","at":1,"hold":2,"app":{"org.example":{"literal":"clip-a","clear":null}}},{"id":"clip-b","track":"picture","asset":"picture","clipType":"media","at":5,"hold":2,"app":{"org.example":{"literal":"clip-a","clear":null}}}],"registry":{"assets":{"picture":{"media_id":"sha256:1111111111111111111111111111111111111111111111111111111111111111","type":"image"}}},"occurrences":[{"occurrence_id":"occ-a","shot_id":"chapter-shot","shot_revision_id":"shot-1","placement":{"start_ms":8000,"track":"picture"},"duration_ms":10000,"source_offset":0,"speed":1,"track":"picture","unknown":{"literal":"chapter-shot"}},{"occurrence_id":"occ-b","shot_id":"chapter-shot","shot_revision_id":"shot-1","placement":{"start_ms":10000,"track":"picture"},"duration_ms":10000,"source_offset":0,"speed":1,"track":"picture","unknown":{"literal":"chapter-shot"}}],"name":"Renamed Film","unknown":{"opaque":["parent-1",null]}},"content_digest":"sha256:02bb61acb800f5abc184c4daf315217cbc01b02c2fd88780a2e4e7c6b7504f89"},"shot_revisions":[{"shot_id":"chapter-shot","revision_id":"shot-1","internal_timeline_revision_id":"internal-1","payload":{"name":"Chapter One","internal_timeline_revision_id":"internal-1","items":[{"item_id":"item-1","media_id":"sha256:1111111111111111111111111111111111111111111111111111111111111111","metadata":{"opaque_literal":"item-1"}}],"text_bindings":[{"slot":"narration","text":"A chapter"}],"metadata":{"chapter":true},"unknown":{"keep":null}},"content_digest":"sha256:f700f1f65d6111e008f10de355a74ab6b41b766f4ff4070bd62f97206a3f0775"}],"internal_timeline_revisions":[{"revision_id":"internal-1","timeline_id":"chapter-1","payload":{"tracks":[{"id":"picture","kind":"visual"}],"clips":[{"id":"clip-a","track":"picture","asset":"picture","clipType":"media","at":1,"hold":2,"app":{"org.example":{"literal":"clip-a","clear":null}}},{"id":"clip-b","track":"picture","asset":"picture","clipType":"media","at":5,"hold":2,"app":{"org.example":{"literal":"clip-a","clear":null}}}],"output":{"fps":{"numerator":30000,"denominator":1001}},"opaque":{"timestamp":"authored timestamp","v":[null,false,0]},"registry":{"assets":{"picture":{"media_id":"sha256:1111111111111111111111111111111111111111111111111111111111111111","type":"image"}}},"unknown":[1,2]},"content_digest":"sha256:f579c1ef3548804d91bdaedcd7acdca9af674baf2f458b74bc6606ffd7cce502"}],"dependency_manifest":{"shots":[{"shot_id":"chapter-shot","revision_id":"shot-1","internal_timeline_revision_id":"internal-1","content_digest":"sha256:f700f1f65d6111e008f10de355a74ab6b41b766f4ff4070bd62f97206a3f0775"}],"internal_timelines":[{"timeline_id":"chapter-1","revision_id":"internal-1","content_digest":"sha256:f579c1ef3548804d91bdaedcd7acdca9af674baf2f458b74bc6606ffd7cce502"}],"media":[{"media_id":"sha256:1111111111111111111111111111111111111111111111111111111111111111","content_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}],"documents":[]}},"commands":"7ba73dea152be732c2fb18e076b641e26f09e656880145361a416792bddf86ea","records":"f03fe1cf3fc0bed49b404ac21d97073c5336eb0b2996d425c3d69117473e7514"};
const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-1', timelineId: 'film' };
const head = { revisionId: 'parent-1', publicationId: 'publication-1' };
const selector = { group_key: 'pictures', variant_key: 'approved', output_port: 'image', ordinal: 0 };
const request = preparePlacementTask({ project: scope.projectId, capability_id: 'image.generate',
  capability_digest: `sha256:${'c'.repeat(64)}`, input_object_ids: [],
  settlement_effect: { effect_type: 'generation.publish_v1', target_id: scope.projectId, payload: {
    groups: [{ group_key: selector.group_key, selectors: [selector] }],
  } },
}, 'original-task-key');
function original(): OutboxPlacementContinuation {
  return { id: 'approved', input: { request, head, readClosure: { fixture: 'original pinned read parameters' },
    ownerRef: golden.approval.owner, anchor: golden.approval.anchor, lane: golden.approval.preferredTrack,
    fallback: { at: golden.approval.fallbackAt, track: golden.approval.fallbackTrack },
    policy: structuredClone(golden.approval), autoApprove: true, createdIds: [golden.approval.clipId], output: selector },
    taskLocator: { projectId: scope.projectId, taskId: 'task', runId: 'run' }, mediaPin: structuredClone(golden.media) };
}
function fixture() {
  const state = { current: true, claimed: true, verified: structuredClone(golden.verified) as VerifiedMedia };
  const context: PlacementCaptureContext = {
    client: { getProjectVerifiedMedia: vi.fn(async () => structuredClone(state.verified)) },
    check: vi.fn(async () => {
      if (!state.current || !state.claimed) throw new Error('requester identity/claim interrupted');
    }),
    assertCurrent: vi.fn(() => {
      if (!state.current || !state.claimed) throw new Error('requester identity/claim interrupted');
    }),
  };
  const read = vi.fn<OriginalPlacementRead>(async () => ({ head, savedCanonicalDocument: structuredClone(golden.document) as CanonicalDocument }));
  return { state, context, read };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return '{' + Object.keys(row).sort().map((key) => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

describe('native requester read/capture stage (trusted fixtures, no Runtime acceptance)', () => {
  it('matches the native golden using original closure and the same bound verified-media method', async () => {
    const env = fixture(), saved = original(), before = structuredClone(saved);
    const result = await readNativePlacementCapture(saved, scope, env.context, env.read);
    expect(hash(result.commands)).toBe(golden.commands);
    expect(hash(result.records)).toBe(golden.records);
    expect(env.read).toHaveBeenCalledWith(before, scope);
    expect(env.context.client.getProjectVerifiedMedia).toHaveBeenCalledExactlyOnceWith(scope.projectId, golden.media);
    expect(saved).toEqual(before);
    expect(result.commands[0].created).toContain('occurrence:occ-a/clip:placed');
    expect(await readNativePlacementCapture(JSON.parse(JSON.stringify(saved)), scope, env.context, env.read)).toEqual(result);
  });

  const mutations: Array<[string, (saved: OutboxPlacementContinuation) => void]> = [
    ['approval boolean', (s) => { (s.input as unknown as { autoApprove: boolean }).autoApprove = false; }],
    ['policy approval', (s) => { (s.input.policy as Record<string, JSON>).autoApprove = false; }],
    ['owner', (s) => { s.input.ownerRef = 'occurrence:another'; }],
    ['anchor', (s) => { s.input.anchor = null; }],
    ['preferred lane', (s) => { s.input.lane = 'overlay'; }],
    ['saved fallback', (s) => { s.input.fallback = { at: 1, track: 'picture' }; }],
    ['reserved ID', (s) => { s.input.createdIds = ['another']; }],
    ['extra reserved ID', (s) => { s.input.createdIds.push('unused'); }],
    ['opaque older policy', (s) => { s.input.policy = { image: 'completion-five-second' }; }],
    ['missing locator', (s) => { delete s.taskLocator; }],
    ['wrong locator project', (s) => { s.taskLocator!.projectId = 'other'; }],
    ['missing pin', (s) => { delete s.mediaPin; }],
    ['extra pin field', (s) => { (s.mediaPin as Record<string, JSON>).duration = 5; }],
  ];
  for (const [name, mutate] of mutations) it('retains unsupported/mismatched original ' + name, async () => {
    const env = fixture(), saved = original();
    mutate(saved);
    const before = structuredClone(saved);
    await expect(readNativePlacementCapture(saved, scope, env.context, env.read)).rejects.toThrow();
    expect(saved).toEqual(before);
    expect(env.read).not.toHaveBeenCalled();
    expect(env.context.client.getProjectVerifiedMedia).not.toHaveBeenCalled();
  });

  for (const field of ['revisionId', 'publicationId'] as const) it('refuses a refreshed ' + field, async () => {
    const env = fixture();
    env.read.mockResolvedValue({ head: { ...head, [field]: 'new-head' }, savedCanonicalDocument: golden.document as CanonicalDocument });
    await expect(readNativePlacementCapture(original(), scope, env.context, env.read)).rejects.toThrow('scope/base');
    expect(env.context.client.getProjectVerifiedMedia).not.toHaveBeenCalled();
  });
  for (const field of ['project_id', 'timeline_id'] as const) it('refuses original document ' + field + ' mismatch', async () => {
    const env = fixture();
    env.read.mockResolvedValue({ head, savedCanonicalDocument: { ...golden.document, [field]: 'other' } as CanonicalDocument });
    await expect(readNativePlacementCapture(original(), scope, env.context, env.read)).rejects.toThrow('scope/base');
  });
  it('refuses a different raw parent revision', async () => {
    const env = fixture(), document = structuredClone(golden.document);
    document.parent_revision.revision_id = 'new-parent';
    env.read.mockResolvedValue({ head, savedCanonicalDocument: document as CanonicalDocument });
    await expect(readNativePlacementCapture(original(), scope, env.context, env.read)).rejects.toThrow('scope/base');
  });
  it('requires the host verified-media port without creating another client', async () => {
    const env = fixture();
    delete env.context.client.getProjectVerifiedMedia;
    await expect(readNativePlacementCapture(original(), scope, env.context, env.read)).rejects.toThrow('Same-host');
    expect(env.read).not.toHaveBeenCalled();
  });
  it('uses the literal saved fallback when the original anchor is absent', async () => {
    const env = fixture(), saved = original();
    saved.input.anchor = 'absent';
    saved.input.fallback = { at: 12, track: 'picture' };
    Object.assign(saved.input.policy as object, { anchor: 'absent', fallbackAt: 12, fallbackTrack: 'picture' });
    const result = await readNativePlacementCapture(saved, scope, env.context, env.read);
    expect(result.capture).toMatchObject({ resolution: 'fallback-at', start_frame: 360, on: 12.012, lane: 'picture' });
  });
  it('preserves explicitly approved shared placement instead of applying completion defaults', async () => {
    const env = fixture(), saved = original();
    // Match the shared native vectors' wider original occurrence extent.
    const document = structuredClone(golden.document);
    document.parent_revision.payload.occurrences[0].duration_ms = 20000;
    env.read.mockResolvedValue({ head, savedCanonicalDocument: document as CanonicalDocument });
    saved.input.policy = { autoApprove: true, owner: saved.input.ownerRef, ownership: 'occurrence',
      clipId: 'placed', mode: 'shared', anchor: null, frame: null };
    saved.input.anchor = null;
    saved.input.fallback = null;
    const result = await readNativePlacementCapture(saved, scope, env.context, env.read);
    expect(result.capture).toMatchObject({ resolution: 'append', seconds: 4 });
  });
  it('retries a failed verified read with the same original pin and reserved command identity', async () => {
    const env = fixture(), saved = original(), before = structuredClone(saved);
    env.context.client.getProjectVerifiedMedia = vi.fn()
      .mockRejectedValueOnce(new Error('read disconnected')).mockResolvedValue(env.state.verified);
    await expect(readNativePlacementCapture(saved, scope, env.context, env.read)).rejects.toThrow('disconnected');
    const result = await readNativePlacementCapture(saved, scope, env.context, env.read);
    expect(hash(result.commands)).toBe(golden.commands);
    expect(saved).toEqual(before);
    expect(env.context.client.getProjectVerifiedMedia).toHaveBeenNthCalledWith(1, scope.projectId, golden.media);
    expect(env.context.client.getProjectVerifiedMedia).toHaveBeenNthCalledWith(2, scope.projectId, golden.media);
  });
  it('refuses a callback invocation without its requester effect context', async () => {
    const env = fixture();
    await expect(createNativePlacementCapture(env.read)(original(), scope)).rejects.toThrow('effect context');
    expect(env.read).not.toHaveBeenCalled();
  });
  for (const field of ['asset', 'generation_id', 'variant_id', 'object_id', 'catalog_digest'] as const) {
    it('refuses verified pin mismatch: ' + field, async () => {
      const env = fixture();
      env.state.verified.selection[field] = 'different';
      await expect(readNativePlacementCapture(original(), scope, env.context, env.read)).rejects.toThrow('five-field');
    });
  }
  it('refuses invalid intrinsic facts rather than guessing a duration', async () => {
    const env = fixture();
    env.state.verified.size = 0;
    await expect(readNativePlacementCapture(original(), scope, env.context, env.read)).rejects.toThrow('metadata');
  });
  for (const boundary of ['before original read', 'after original read', 'after verified read']) {
    for (const fence of ['current', 'claimed'] as const) it(fence + ' fence: ' + boundary, async () => {
      const env = fixture();
      if (boundary === 'before original read') env.state[fence] = false;
      if (boundary === 'after original read') env.read.mockImplementation(async () => {
        env.state[fence] = false;
        return { head, savedCanonicalDocument: golden.document as CanonicalDocument };
      });
      if (boundary === 'after verified read') env.context.client.getProjectVerifiedMedia = vi.fn(async () => {
        env.state[fence] = false;
        return env.state.verified;
      });
      await expect(readNativePlacementCapture(original(), scope, env.context, env.read)).rejects.toThrow('interrupted');
      if (boundary.includes('original')) expect(env.context.client.getProjectVerifiedMedia).not.toHaveBeenCalled();
    });
  }
  it('checks lifecycle even when a host read rejects', async () => {
    const env = fixture();
    env.read.mockImplementation(async () => { env.state.current = false; throw new Error('transport failed'); });
    await expect(readNativePlacementCapture(original(), scope, env.context, env.read)).rejects.toThrow('interrupted');
  });
  it('returns the original native commands and all claims as the requester payload', async () => {
    const env = fixture(), saved = original(), before = structuredClone(saved);
    const payload = await createNativePlacementCapture(env.read)(saved, scope, env.context);
    expect(Object.keys(payload)).toEqual(['commands']);
    expect(hash(payload.commands)).toBe(golden.commands);
    expect(saved).toEqual(before);
    expect(env.context.client.getProjectVerifiedMedia).toHaveBeenCalledTimes(1);
  });
});

function requesterFixture() {
  const env = fixture(), saved = original();
  // The normal managed-selection API uses the registered variant as asset.
  const pin = { ...golden.media, asset: golden.media.variant_id };
  env.state.verified.selection = structuredClone(pin);
  const task: Task = { task_id: 'task', run_id: 'run', project_id: scope.projectId, state: 'succeeded', version: 9,
    capability_id: 'image.generate', capability_digest: `sha256:${'c'.repeat(64)}`, idempotency_key: request.key,
    created_at: '', updated_at: '', attempt_id: 'settled-attempt', runtime_epoch: 1, input_object_ids: [], spec: {},
    result: { generation_publish_v1: { publications: [{ group_key: selector.group_key, generation_id: pin.generation_id,
      variants: [{ ...selector, ...pin }] }] } },
  };
  const managed: ManagedOutput = { ...selector, association_id: 'association', project_id: scope.projectId,
    task_id: task.task_id, run_id: task.run_id, attempt_id: task.attempt_id!, selector, object_id: pin.object_id,
    digest: pin.object_id, manifest_ref: null, size: golden.verified.size, filename: 'image.png', media_type: 'image/png',
    role: 'output', producer: {}, provenance: {}, durability: 'durable', state: 'available', version: 99,
    lifecycle: { version: 3, state: 'available' } };
  const calls: string[] = [];
  const afterVerified = vi.fn();
  const transport: Transport = async (method, path) => {
    calls.push(`${method} ${path}`);
    let body: unknown;
    if (path.includes('media-selection/verified')) { afterVerified(); body = env.state.verified; }
    else if (path.includes('media-selection')) body = pin;
    else if (path.includes('managed-outputs')) body = { items: [managed], next_cursor: null };
    else if (path === '/v1/tasks/task') body = task;
    else throw new Error('Unexpected fixture route');
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  };
  const client = Object.assign(new WorkspaceClient('', undefined, transport), {
    isCurrentIdentity: () => env.state.current,
  });
  const nativeCapture = createNativePlacementCapture(env.read);
  const capture = Object.assign(vi.fn(nativeCapture), { requesterContext: nativeCapture.requesterContext });
  // Source-only request/ACK fixtures, never a production binding or Runtime acceptance.
  const build = vi.fn((intent: OutboxIntent, base: OutboxHead, savedScope: OutboxScope) => ({ method: 'POST',
    path: `/v1/projects/${savedScope.projectId}/timelines/${savedScope.timelineId}/commit`,
    body: { api_version: 1, project_id: savedScope.projectId, timeline_id: savedScope.timelineId,
      base_revision_id: base.revisionId, base_publication_id: base.publicationId,
      commands: (intent.payload as { commands: CommitRequest['commands'] }).commands, source: { via: 'app' },
    } satisfies CommitRequest,
  }));
  const transmit = vi.fn<(request: OutboxRequest) => Promise<OutboxOutcome>>(async () => {
    throw new Error('Fixture lost ACK');
  });
  const indexedDB = createFakeIndexedDB() as unknown as IDBFactory;
  const storage = () => createCommitOutbox({ indexedDB,
    exclusiveLock: async (_name, work) => work() });
  const requester = () => createPlacementRequester({ client, outboxes: storage(), capture, build, transmit,
    getRecoverableIdentity: async () => ({ realmId: scope.realmId, actorId: scope.actorId }),
  });
  return { ...env, saved, pin, calls, client, afterVerified, capture, build, transmit, storage, requester };
}

describe('same requester/outbox callback without commit activation', () => {
  it.each(['image', 'video'])('durably captures original %s commands/pin/IDs and retries exact saved bytes after reopen', async (kind) => {
    const env = requesterFixture();
    env.state.verified.media_type = kind + '/fixture';
    if (kind === 'video') env.state.verified.duration_seconds = 12;
    const expected = await readNativePlacementCapture({ ...env.saved, mediaPin: env.pin }, scope, env.context, env.read);
    env.read.mockClear();
    let owner = '';
    let sent!: OutboxRequest;
    env.transmit.mockImplementationOnce(async (request) => {
      const [record] = await env.storage().list(scope);
      expect(record.pending?.request).toEqual(request);
      expect(record.intents[0].payload).toEqual({ commands: expected.commands });
      sent = structuredClone(request);
      throw new Error('Fixture lost ACK');
    });
    await env.storage().create(scope, async (box) => {
      owner = (await box.read()).ownerId;
      await box.reservePlacementAdmission(env.saved.id, env.saved.input);
      await box.recordPlacementTask(env.saved.id, request, env.saved.taskLocator!);
      const [progress] = await env.requester().resume(box);
      expect(progress.status).toBe('retry');
      const record = await box.read();
      expect(record.intents).toEqual([{ id: expect.any(String), basis: { head }, readyBase: head,
        payload: { commands: expected.commands } }]);
      expect(record.pending?.request).toEqual(sent);
      expect(record.placementContinuations).toEqual([{ ...env.saved, mediaPin: env.pin,
        placement: { intentId: record.intents[0].id } }]);
      expect(env.capture.mock.calls[0][2]!.client).toBe(env.client);
      expect(env.read).toHaveBeenCalledExactlyOnceWith({ ...env.saved, mediaPin: env.pin }, scope);
    });
    expect(JSON.parse(sent.body)).toEqual({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
      base_revision_id: head.revisionId, base_publication_id: head.publicationId, commands: expected.commands, source: { via: 'app' } });
    expect(expected.commands[0].created).toContain('occurrence:occ-a/clip:placed');
    expect(expected.commands[0].args.media).toEqual(env.pin);
    for (const claim of ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const) {
      expect(expected.commands[0][claim]).toBeDefined();
    }
    const calls = [...env.calls];
    env.read.mockRejectedValue(new Error('Original read must not run again'));
    env.state.verified.selection.catalog_digest = `sha256:${'f'.repeat(64)}`;
    env.transmit.mockResolvedValue({ kind: 'accepted', head: { revisionId: 'fixture-accepted', publicationId: 'fixture-publication' }, value: {} });
    await env.storage().recover(scope, owner, async (box) => {
      const reopened = await box.read();
      expect(reopened.pending?.request).toEqual(sent);
      expect(reopened.intents[0].payload).toEqual({ commands: expected.commands });
      expect(reopened.placementContinuations![0]).toMatchObject({ input: env.saved.input, mediaPin: env.pin });
      expect((await env.requester().resume(box))[0].status).toBe('accepted');
      const record = await box.read();
      expect(record.placementContinuations![0]).toMatchObject({ input: env.saved.input, mediaPin: env.pin,
        placement: { accepted: { head: { revisionId: 'fixture-accepted', publicationId: 'fixture-publication' } } } });
      expect(record.intents).toEqual([]);
      expect(record.pending).toBeUndefined();
    });
    expect((await env.requester().recover())[0].status).toBe('accepted');
    expect(env.calls).toEqual(calls);
    expect(env.capture).toHaveBeenCalledTimes(1);
    expect(env.read).toHaveBeenCalledTimes(1);
    expect(env.build).toHaveBeenCalledTimes(1);
    expect(env.transmit.mock.calls.map(([request]) => request)).toEqual([sent, sent]);
    expect(env.calls.some((call) => call.startsWith('POST'))).toBe(false);
    expect(env.calls.filter((call) => call.includes('media-selection/verified'))).toHaveLength(1);
  });

  it.each(['capture', 'commit'])('retains a genuine %s refusal without recapture or refreshing pin/guards on reopen', async (stage) => {
    const env = requesterFixture();
    if (stage === 'capture') env.state.verified.size = 0;
    else env.transmit.mockResolvedValue({ kind: 'rejected', error: { kind: 'conflict', message: 'original anchor changed' } });
    let owner = '';
    await env.storage().create(scope, async (box) => {
      owner = (await box.read()).ownerId;
      await box.reservePlacementAdmission(env.saved.id, env.saved.input);
      await box.recordPlacementTask(env.saved.id, request, env.saved.taskLocator!);
      expect((await env.requester().resume(box))[0].status).toBe('conflict');
    });
    const [before] = await env.storage().list(scope);
    expect(before.placementContinuations![0]).toMatchObject({ input: env.saved.input, mediaPin: env.pin });
    if (stage === 'capture') {
      expect(before.placementContinuations![0].conflict).toMatchObject({ reason: 'placement_capture_failed' });
      expect(before.intents).toEqual([]);
      expect(before.pending).toBeUndefined();
      expect(env.build).not.toHaveBeenCalled();
      expect(env.transmit).not.toHaveBeenCalled();
    } else {
      expect(before.intents[0].conflict).toBeDefined();
      expect(before.pending?.outcome?.kind).toBe('rejected');
      expect(env.transmit).toHaveBeenCalledTimes(1);
    }
    const calls = [...env.calls];
    env.state.verified.size = golden.verified.size;
    env.state.verified.selection.catalog_digest = `sha256:${'f'.repeat(64)}`;
    for (let pass = 0; pass < 2; pass++) expect((await env.requester().recover())[0].status).toBe('conflict');
    const [after] = await env.storage().list(scope);
    expect({ ...after, generation: before.generation }).toEqual(before);
    expect(env.calls).toEqual(calls);
    expect(env.capture).toHaveBeenCalledTimes(1);
    expect(env.read).toHaveBeenCalledTimes(1);
    expect(env.transmit).toHaveBeenCalledTimes(stage === 'capture' ? 0 : 1);
  });

  it('retains a retryable continuation when identity changes inside the verified-media effect', async () => {
    const env = requesterFixture();
    env.afterVerified.mockImplementation(() => { env.state.current = false; });
    await env.storage().create(scope, async (box) => {
      await box.reservePlacementAdmission(env.saved.id, env.saved.input);
      await box.recordPlacementTask(env.saved.id, request, env.saved.taskLocator!);
      expect((await env.requester().resume(box))[0].status).toBe('retry');
      const record = await box.read();
      expect(record.intents).toEqual([]);
      expect(record.placementContinuations).toEqual([{ ...env.saved, mediaPin: env.pin }]);
      expect(env.build).not.toHaveBeenCalled();
      expect(env.transmit).not.toHaveBeenCalled();
    });
  });
});
