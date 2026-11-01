import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import type { MutationReceipt, MutationResult } from './generated.ts';
import type { CanonicalDocument, CommandRecord, CommitRequest, HistoryPage, JSON } from './timeline-commit-types.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '@/tools/video-editor/data/DataProvider.ts';
import { createCommitOutbox, type ClaimedOutbox } from '@/tools/video-editor/commands/commitOutbox.ts';
import fixture from '@/tools/video-editor/commands/fixtures/recipe_m2_app_bootstrap.json';
import { reserveBootstrapInitialization, resumeBootstrapInitialization } from './bootstrapInitialization.ts';
import { acceptedCommit, fixtureDigest } from './__tests__/timelineCommitFixture.ts';
import { ApiError } from './generated.ts';

const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-1', timelineId: 'main' };
const h0 = { revisionId: 'parent-0', publicationId: 'bootstrap-p0' };
const key = 'astrid-first-timeline-project-1';
const document = (parent = fixture.bundle.parent, revision = h0.revisionId): CanonicalDocument => ({
  schema_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
  parent_revision: { revision_id: revision, content_digest: fixtureDigest({ ...parent, occurrences: [] }), payload: { ...parent, occurrences: [] } },
  shot_revisions: [], internal_timeline_revisions: [], dependency_manifest: { shots: [], internal_timelines: [], media: [], documents: [] },
});
function receipt(kind: string, id: string, idempotencyKey: string, result: unknown): MutationReceipt {
  return { receipt_id: id, command_kind: kind, idempotency_key: idempotencyKey, request_hash: 'request-hash',
    project_id: scope.projectId, project_seq: [1, 1], event_ids: ['event'], result, created_at: '2026-10-20T00:00:00Z' };
}
function initialBasis(): TimelineCommandBasis {
  const canonicalDocument = document();
  const publication = { project_id: scope.projectId, timeline_id: scope.timelineId, revision_id: h0.revisionId,
    old_head: null, new_head: h0.revisionId,
    content_digest: canonicalDocument.parent_revision.content_digest, payload: canonicalDocument.parent_revision.payload };
  return { head: h0, canonicalDocument, history: { head: { revision_id: h0.revisionId, publication_id: h0.publicationId }, next_cursor: null,
    items: [{ publication_id: h0.publicationId, revision_id: h0.revisionId, previous: null,
      receipt: receipt('parent_composition.publish', h0.publicationId, 'bootstrap:main', publication), intent: 'bootstrap',
      records: null, provider_version: null, compiler_version: null, publisher: null }] } };
}
function environment() {
  const factory = createFakeIndexedDB();
  const open = () => createCommitOutbox({ indexedDB: factory, exclusiveLock: async (_name, work) => work() });
  let basis = initialBasis();
  let history = basis.history!;
  const revisions = new Map([[h0.revisionId, document()]]);
  const created = { project_id: scope.projectId, timeline_id: scope.timelineId, archived: false,
    head_revision_id: h0.revisionId, head_publication_id: h0.publicationId };
  const createResult = () => Object.defineProperty({ ...created }, 'receipt', {
    value: receipt('timeline.create', 'create-receipt', key, created), enumerable: false,
  }) as MutationResult<Record<string, unknown>>;
  const createTimeline = vi.fn(async (_project: string, _timeline: string, _key: string, _name?: string) => createResult());
  const loadLatest = vi.fn(async () => structuredClone(basis));
  const commitTimeline = vi.fn(async (body: CommitRequest, commitKey: string): Promise<TimelineCommitResult> => {
    const response = acceptedCommit({ revision_id: 'initialized', publication_id: 'init-p1' },
      { revision_id: h0.revisionId, publication_id: h0.publicationId }, { projectId: scope.projectId, timelineId: scope.timelineId, commands: body.commands });
    const parent = { ...fixture.after_bundle.parent, name: body.commands[0].args.name as string,
      slug: body.commands[0].args.slug as string };
    const canonicalDocument = document(parent as typeof fixture.bundle.parent, 'initialized');
    response.data.canonical_document = canonicalDocument;
    response.data.document_digest = fixtureDigest(canonicalDocument);
    response.receipt.idempotency_key = commitKey;
    basis = { head: { revisionId: 'initialized', publicationId: 'init-p1' }, canonicalDocument };
    history = { head: { revision_id: basis.head.revisionId, publication_id: basis.head.publicationId }, next_cursor: null,
      items: [{ publication_id: basis.head.publicationId, revision_id: basis.head.revisionId,
        previous: { revision_id: h0.revisionId, publication_id: h0.publicationId }, receipt: structuredClone(response.receipt), intent: 'recorded',
        records: { schema_version: 1, commands: fixture.records.map((record, index) => ({ ...structuredClone(record),
          command: structuredClone(body.commands[index]) })) as CommandRecord[], undo_of: [], restored_from: null },
        provider_version: response.data.provider_version, compiler_version: response.data.compiler_version, publisher: response.data.publisher },
      initialBasis().history!.items[0]] };
    revisions.set(canonicalDocument.parent_revision.revision_id, structuredClone(canonicalDocument));
    return { response, accepted: basis.head, canonicalDocument, graph: {}, receipt: response.receipt };
  });
  const listTimelineCommits = vi.fn(async (_project: string, _timeline: string, _cursor?: string): Promise<HistoryPage> => structuredClone(history));
  const getProjectParentCompositionRevision = vi.fn(async (_project: string, _timeline: string, revision: string) => {
    const saved = revisions.get(revision)!;
    return { project_id: saved.project_id, timeline_id: saved.timeline_id, ...structuredClone(saved.parent_revision),
      dependency_manifest: structuredClone(saved.dependency_manifest) };
  });
  return { open, ports: { createTimeline, loadLatest, commitTimeline, listTimelineCommits, getProjectParentCompositionRevision }, createResult,
    setBasis: (next: TimelineCommandBasis) => { basis = next; } };
}

// Synthetic local adapter/storage inputs and mocked authority reads, not Runtime admission.
async function localInitAcceptance(env: ReturnType<typeof environment>,
  value: (result: TimelineCommitResult) => unknown = (result) => ({ kind: 'timeline-initialized', result }),
  changeRequest: (body: CommitRequest) => void = () => {}) {
  let owner = '';
  await env.open().create(scope, async (box, id) => {
    owner = id;
    await box.append({ kind: 'timeline-init', commands: fixture.commands as JSON }, { head: h0 });
    await box.dispatch(() => {
      const body: CommitRequest = { api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
        base_revision_id: h0.revisionId, base_publication_id: h0.publicationId,
        commands: structuredClone(fixture.commands) as CommitRequest['commands'], source: { via: 'app' } };
      changeRequest(body);
      return { method: 'POST', path: '/v1/projects/project-1/timelines/main/commit', body: body as unknown as JSON };
    }, async (request) => {
      const result = await env.ports.commitTimeline(JSON.parse(request.body) as CommitRequest, request.key);
      return { kind: 'accepted', head: structuredClone(result.accepted), value: JSON.parse(JSON.stringify(value(result))) as JSON };
    });
  });
  env.ports.loadLatest.mockClear();
  return owner;
}

describe('source-only create then native initialization', () => {
  it('refuses marker-only completion after reopening, keeping the owner at pristine H0', async () => {
    const env = environment();
    let owner = '';
    await env.open().create(scope, async (box, id) => {
      owner = id;
      await box.append({ unrelated: true }, { head: h0 });
      await box.dispatch(() => ({ method: 'POST', path: '/v1/projects/project-1/timelines/main/commit', body: {} }),
        async () => ({ kind: 'accepted', head: h0, value: { kind: 'timeline-initialized' } }));
    });
    const before = (await env.open().list(scope))[0];
    await env.open().recover(scope, owner, async (box) => {
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow();
      expect(await box.read()).toEqual({ ...before, generation: before.generation + 1 });
    });
    expect(await env.open().list(scope)).toHaveLength(1);
    expect(env.ports.createTimeline).not.toHaveBeenCalled();
    expect(env.ports.commitTimeline).not.toHaveBeenCalled();
  });

  it.each(['missing-result', 'project', 'timeline', 'base-revision', 'base-publication', 'commands', 'head', 'publication',
    'receipt-key', 'receipt-kind', 'receipt-result', 'detached-document', 'detached-receipt', 'preview'])(
    'refuses a reopened local init with %s and retains the complete owner', async (fault) => {
      const env = environment();
      const owner = await localInitAcceptance(env, (result) => {
        if (fault === 'missing-result') return { kind: 'timeline-initialized' };
        if (fault === 'project') result.canonicalDocument.project_id = 'other-project';
        if (fault === 'timeline') result.canonicalDocument.timeline_id = 'other-timeline';
        if (fault === 'base-revision') result.response.data.base_revision_id = 'other-revision';
        if (fault === 'base-publication') result.response.data.base_publication_id = 'other-publication';
        if (fault === 'commands') result.response.data.commands[0].args.name = 'changed';
        if (fault === 'head') result.accepted.revisionId = 'other-revision';
        if (fault === 'publication') result.accepted.publicationId = 'other-publication';
        if (fault === 'receipt-key') result.receipt.idempotency_key = 'other-key';
        if (fault === 'receipt-kind') result.receipt.command_kind = 'timeline.create';
        if (fault === 'receipt-result') result.receipt.result = {};
        if (fault === 'detached-document') result.canonicalDocument = document();
        if (fault === 'detached-receipt') result.receipt = { ...result.receipt, receipt_id: 'other-receipt' };
        if (fault === 'preview') Object.assign(result.response.data, { status: 'preview' });
        return { kind: 'timeline-initialized', result };
      });
      const before = (await env.open().list(scope))[0];
      await env.open().recover(scope, owner, async (box) => {
        await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('receipt does not match');
        expect(await box.read()).toEqual({ ...before, generation: before.generation + 1 });
      });
      expect(env.ports.listTimelineCommits).not.toHaveBeenCalled();
      expect(env.ports.loadLatest).not.toHaveBeenCalled();
      expect(env.ports.commitTimeline).toHaveBeenCalledTimes(1);
    });

  it.each(['commands', 'project', 'timeline', 'base', 'preview'])(
    'refuses saved original request %s mismatch independently of its matching saved result', async (fault) => {
      const env = environment();
      const owner = await localInitAcceptance(env, undefined, (body) => {
        if (fault === 'commands') body.commands[0].args.name = 'other-name';
        if (fault === 'project') body.project_id = 'other-project';
        if (fault === 'timeline') body.timeline_id = 'other-timeline';
        if (fault === 'base') body.base_publication_id = 'other-base';
        if (fault === 'preview') body.dry_run = true;
      });
      const before = (await env.open().list(scope))[0];
      await env.open().recover(scope, owner, async (box) => {
        await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('original request/commands');
        expect(await box.read()).toEqual({ ...before, generation: before.generation + 1 });
      });
      expect(env.ports.loadLatest).not.toHaveBeenCalled();
    });

  it.each(['missing', 'publication', 'revision', 'previous', 'receipt', 'scope', 'commands', 'provider', 'compiler', 'publisher', 'intent'])(
    'requires the exact historical init publication: %s mismatch keeps the owner', async (fault) => {
      const env = environment();
      const owner = await localInitAcceptance(env);
      const page = await env.ports.listTimelineCommits(scope.projectId, scope.timelineId);
      const entry = page.items[0];
      if (fault === 'missing') page.items.shift();
      if (fault === 'publication') entry.publication_id = 'same-revision-other-publication';
      if (fault === 'revision') entry.revision_id = 'other-revision';
      if (fault === 'previous') entry.previous!.publication_id = 'other-previous';
      if (fault === 'receipt') entry.receipt.idempotency_key = 'other-key';
      if (fault === 'scope') entry.receipt.project_id = 'other-project';
      if (fault === 'commands') entry.records!.commands[0].command.args.name = 'other-name';
      if (fault === 'provider') entry.provider_version = 'other-provider';
      if (fault === 'compiler') entry.compiler_version = 'other-compiler';
      if (fault === 'publisher') entry.publisher = 'other-publisher';
      if (fault === 'intent') entry.intent = 'bootstrap';
      env.ports.listTimelineCommits.mockResolvedValue(page);
      const before = (await env.open().list(scope))[0];
      await env.open().recover(scope, owner, async (box) => {
        await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('historical publication');
        expect(await box.read()).toEqual({ ...before, generation: before.generation + 1 });
      });
      expect(env.ports.getProjectParentCompositionRevision).not.toHaveBeenCalled();
      expect(env.ports.loadLatest).not.toHaveBeenCalled();
    });

  it.each(['project', 'timeline', 'revision', 'digest', 'payload', 'manifest'])(
    'requires the historical immutable closure: %s mismatch keeps the owner', async (fault) => {
      const env = environment();
      const owner = await localInitAcceptance(env);
      const parent = await env.ports.getProjectParentCompositionRevision(scope.projectId, scope.timelineId, 'initialized');
      if (fault === 'project') parent.project_id = 'other-project';
      if (fault === 'timeline') parent.timeline_id = 'other-timeline';
      if (fault === 'revision') parent.revision_id = 'other-revision';
      if (fault === 'digest') parent.content_digest = fixtureDigest('other');
      if (fault === 'payload') parent.payload.name = 'other-name';
      if (fault === 'manifest') parent.dependency_manifest.media.push({ media_id: 'media', content_digest: 'digest' });
      env.ports.getProjectParentCompositionRevision.mockResolvedValue(parent);
      const before = (await env.open().list(scope))[0];
      await env.open().recover(scope, owner, async (box) => {
        await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('immutable closure');
        expect(await box.read()).toEqual({ ...before, generation: before.generation + 1 });
      });
      expect(env.ports.loadLatest).not.toHaveBeenCalled();
    });

  it.each(['edit', 'undo', 'equal-byte-restore'])(
    'proves historical init through pagination after %s, then displays today after later owner ACKs', async (laterKind) => {
      const env = environment();
      // The tag is a dispatch hint; authoritative matching data also works without it.
      const owner = await localInitAcceptance(env, (result) => ({ result }));
      const init = (await env.open().list(scope))[0].initialization!;
      const head = { revisionId: laterKind === 'equal-byte-restore' ? 'initialized' : `${laterKind}-r3`, publicationId: `${laterKind}-p3` };
      const parent = laterKind === 'undo' ? fixture.bundle.parent : fixture.after_bundle.parent;
      const later = { head, canonicalDocument: document(parent as typeof fixture.bundle.parent, head.revisionId) };
      if (laterKind === 'edit') {
        const config = later.canonicalDocument.parent_revision.payload.config as { tracks: Array<{ label: string }> };
        config.tracks[0].label = 'Later label';
        later.canonicalDocument.parent_revision.content_digest = fixtureDigest(later.canonicalDocument.parent_revision.payload);
      }
      env.setBasis(later);
      const history = await env.ports.listTimelineCommits(scope.projectId, scope.timelineId);
      history.head = { revision_id: head.revisionId, publication_id: head.publicationId };
      const command: CommitRequest['commands'][number] = laterKind === 'undo'
        ? { schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: ['init-p1'] } }
        : laterKind === 'equal-byte-restore'
          ? { schema_version: 1, op: 'timeline.restore', version: '1', select: null,
            args: { revision_id: 'initialized', content_digest: later.canonicalDocument.parent_revision.content_digest } }
          : { schema_version: 1, op: 'track.set', version: '1', select: 'parent/track:V1', args: { values: { label: 'Later label' }, clear: [] } };
      const laterResponse = acceptedCommit(history.head, { revision_id: init.head.revisionId, publication_id: init.head.publicationId },
        { projectId: scope.projectId, timelineId: scope.timelineId, commands: [command] });
      laterResponse.data.canonical_document = later.canonicalDocument;
      laterResponse.data.document_digest = fixtureDigest(later.canonicalDocument);
      const laterEntry = { ...history.items[0], publication_id: head.publicationId, revision_id: head.revisionId,
        previous: { revision_id: init.head.revisionId, publication_id: init.head.publicationId }, receipt: laterResponse.receipt,
        records: { schema_version: 1 as const, commands: [{ ordinal: 0, command, writes: [], reads: [], selections: [], bindings: [],
          created: [], dependencies: [], derived_writes: [] }], undo_of: laterKind === 'undo' ? ['init-p1'] : [], restored_from: null } };
      env.ports.listTimelineCommits.mockImplementation(async (_project, _timeline, cursor) => cursor
        ? history : { head: history.head, items: [laterEntry], next_cursor: 'older-page' });
      await env.open().recover(scope, owner, async (box) => {
        await box.append({ kind: 'later-edit' }, { after: init.intent.id });
        await box.dispatch(() => ({ method: 'POST', path: '/v1/projects/project-1/timelines/main/commit', body: {} }),
          async () => ({ kind: 'accepted', head, value: { later: laterKind } }));
        expect((await box.read()).accepted?.value).toEqual({ later: laterKind });
        expect((await box.read()).initialization).toEqual(init);
      });
      env.ports.listTimelineCommits.mockClear();
      await env.open().recover(scope, owner, async (box) => {
        expect(await resumeBootstrapInitialization(box, env.ports)).toEqual(later);
        expect((await box.read()).initialization).toEqual(init);
      });
      expect(env.ports.listTimelineCommits.mock.calls).toEqual([
        [scope.projectId, scope.timelineId, undefined], [scope.projectId, scope.timelineId, 'older-page'],
      ]);
      expect(env.ports.getProjectParentCompositionRevision).toHaveBeenCalledWith(scope.projectId, scope.timelineId, 'initialized');
      expect(env.ports.commitTimeline).toHaveBeenCalledTimes(1);
      expect(env.ports.createTimeline).not.toHaveBeenCalled();
    });

  it('reserves identity/defaults before POST, captures sequentially at H0, then reloads the initialized basis', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      await reserveBootstrapInitialization(box, 'Main', key);
      const before = await box.read();
      expect(env.ports.createTimeline).not.toHaveBeenCalled();
      expect(before.pending!.request).toEqual({ method: 'POST', path: '/v1/projects/project-1/timelines',
        body: JSON.stringify({ timeline_id: 'main', name: 'Main' }), key });
      env.ports.createTimeline.mockImplementationOnce(async () => {
        expect((await box.read()).pending).toEqual(before.pending);
        return env.createResult();
      });
      env.ports.commitTimeline.mockImplementationOnce(async (body, commitKey) => {
        const pending = (await box.read()).pending!;
        expect(pending.request.body).toBe(JSON.stringify(body));
        expect(pending.request.key).toBe(commitKey);
        expect(body).toEqual({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
          base_revision_id: h0.revisionId, base_publication_id: h0.publicationId, commands: fixture.commands, source: { via: 'app' } });
        return env.ports.commitTimeline.getMockImplementation()!(body, commitKey);
      });
      const result = await resumeBootstrapInitialization(box, env.ports);
      expect(result.canonicalDocument.parent_revision.payload).toEqual({ ...fixture.after_bundle.parent, occurrences: [] });
      expect((await box.read()).intents).toEqual([]);
    });
  });

  it('keeps the reserved bootstrap owner scoped during create/init, then drains it after ACK', async () => {
    const env = environment();
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const create = env.ports.createTimeline.getMockImplementation()!;
    env.ports.createTimeline.mockImplementation(async (...args) => {
      const result = await create(...args);
      await createGate;
      return result;
    });
    let releaseInit!: () => void;
    const initGate = new Promise<void>((resolve) => { releaseInit = resolve; });
    const commit = env.ports.commitTimeline.getMockImplementation()!;
    env.ports.commitTimeline.mockImplementation(async (...args) => {
      const result = await commit(...args);
      await initGate;
      return result;
    });
    let ownerId = '';
    const running = env.open().create(scope, async (box, id) => {
      ownerId = id;
      await reserveBootstrapInitialization(box, 'Main', key);
      await resumeBootstrapInitialization(box, env.ports);
    });
    await vi.waitFor(async () => expect(env.ports.createTimeline).toHaveBeenCalledOnce());
    const [reserved] = await env.open().list(scope);
    expect(reserved).toMatchObject({ scope, ownerId, intents: [{ basis: { create: true } }] });
    expect(reserved.pending?.request).toEqual({ method: 'POST', path: '/v1/projects/project-1/timelines',
      body: JSON.stringify({ timeline_id: scope.timelineId, name: 'Main' }), key });

    releaseCreate();
    await vi.waitFor(async () => expect(env.ports.commitTimeline).toHaveBeenCalledOnce());
    const [initializing] = await env.open().list(scope);
    expect(initializing).toMatchObject({ scope, ownerId, intents: [{ payload: { kind: 'timeline-init' } }] });
    expect(initializing.pending?.request.path).toBe('/v1/projects/project-1/timelines/main/commit');

    releaseInit();
    await running;
    const [drained] = await env.open().list(scope);
    expect(drained).toMatchObject({ scope, ownerId, intents: [] });
    expect(drained.pending).toBeUndefined();
  });

  it('reopens the owner before first POST and after create loses its ACK, retaining exact identity and inputs', async () => {
    const env = environment();
    let owner = '';
    await env.open().create(scope, async (box, id) => { owner = id; await reserveBootstrapInitialization(box, 'Main', key); });
    env.ports.createTimeline.mockRejectedValueOnce(new Error('create ACK lost'));
    await env.open().recover(scope, owner, async (box) => {
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('create ACK lost');
    });
    const durable = (await env.open().list(scope))[0];
    expect(durable.pending?.request.key).toBe(key);
    await env.open().recover(scope, owner, async (box) => { await resumeBootstrapInitialization(box, env.ports); });
    expect(env.ports.createTimeline.mock.calls).toEqual([
      [scope.projectId, scope.timelineId, key, 'Main'], [scope.projectId, scope.timelineId, key, 'Main'],
    ]);
    expect(env.ports.commitTimeline).toHaveBeenCalledTimes(1);
  });

  it('discovers a reserved random additional timeline after restart without a remembered URL, ID or owner', async () => {
    const env = environment();
    const additional = { ...scope, timelineId: crypto.randomUUID() };
    const createKey = `astrid-timeline-create-${additional.projectId}-${additional.timelineId}`;
    await env.open().create(additional, async (box) => {
      await reserveBootstrapInitialization(box, 'Timeline 2', createKey);
    });
    const projectScope = { realmId: scope.realmId, actorId: scope.actorId, projectId: scope.projectId };
    expect(await env.open().list({ ...projectScope, actorId: 'other' })).toEqual([]);
    expect(await env.open().list({ ...projectScope, realmId: 'other' })).toEqual([]);
    expect(await env.open().list({ ...projectScope, projectId: 'other' })).toEqual([]);
    const [saved] = await env.open().list(projectScope);
    expect(saved.scope).toEqual(additional);
    expect(saved.intents[0].payload).toMatchObject({ name: 'Timeline 2', slug: 'timeline-2' });
    env.ports.createTimeline.mockRejectedValueOnce(new Error('ACK lost'));
    await env.open().recover(saved.scope, saved.ownerId, async (box) => {
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('ACK lost');
    });
    expect(env.ports.createTimeline).toHaveBeenCalledWith(scope.projectId, additional.timelineId, createKey, 'Timeline 2');
    expect((await env.open().list(projectScope))[0].pending!.request).toEqual(saved.pending!.request);
  });

  it('retains create ACK/defaults if history loading crashes before capture, then resumes without another create', async () => {
    const env = environment();
    let owner = '';
    env.ports.loadLatest.mockRejectedValueOnce(new Error('read interrupted'));
    await env.open().create(scope, async (box, id) => {
      owner = id;
      await reserveBootstrapInitialization(box, 'Main', key, null);
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('read interrupted');
      expect((await box.read()).accepted?.creation?.request.body).toBe('{"timeline_id":"main"}');
      expect((await box.read()).accepted?.value).toMatchObject({ receipt: { command_kind: 'timeline.create' } });
    });
    await env.open().recover(scope, owner, async (box) => { await resumeBootstrapInitialization(box, env.ports); });
    expect(env.ports.createTimeline).toHaveBeenCalledTimes(1);
    expect(env.ports.createTimeline).toHaveBeenCalledWith(scope.projectId, scope.timelineId, key, undefined);
  });

  it('reopens after capture is durable but before commit reservation without recapturing on a newer head', async () => {
    const env = environment();
    let owner = '';
    await env.open().create(scope, async (box, id) => {
      owner = id;
      await reserveBootstrapInitialization(box, 'Main', key);
      const dispatch = box.dispatch.bind(box);
      let calls = 0;
      box.dispatch = async (...args) => {
        if (++calls === 2) throw new Error('process stopped before init dispatch');
        return dispatch(...args);
      };
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('process stopped');
      const record = await box.read();
      expect(record.pending).toBeUndefined();
      expect(record.intents[0].payload).toEqual({ kind: 'timeline-init', commands: fixture.commands });
      expect(record.intents[0].readyBase).toEqual(h0);
    });
    env.ports.loadLatest.mockClear();
    const commit = env.ports.commitTimeline.getMockImplementation()!;
    env.ports.commitTimeline.mockImplementation(async (...args) => {
      expect(env.ports.loadLatest).not.toHaveBeenCalled();
      return commit(...args);
    });
    await env.open().recover(scope, owner, async (box) => { await resumeBootstrapInitialization(box, env.ports); });
    expect(env.ports.createTimeline).toHaveBeenCalledTimes(1);
  });

  it('reopens after init ACK is durable but display reload crashes, without another initialization', async () => {
    const env = environment();
    let owner = '';
    env.ports.loadLatest.mockResolvedValueOnce(initialBasis()).mockRejectedValueOnce(new Error('reload interrupted'));
    await env.open().create(scope, async (box, id) => {
      owner = id;
      await reserveBootstrapInitialization(box, 'Main', key);
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('reload interrupted');
      expect((await box.read()).accepted?.value).toMatchObject({ kind: 'timeline-initialized' });
      expect((await box.read()).intents).toEqual([]);
    });
    const later = { head: { revisionId: 'undo-r3', publicationId: 'undo-p3' }, canonicalDocument: document() };
    env.setBasis(later);
    await env.open().recover(scope, owner, async (box) => { expect(await resumeBootstrapInitialization(box, env.ports)).toEqual(later); });
    expect(env.ports.createTimeline).toHaveBeenCalledTimes(1);
    expect(env.ports.commitTimeline).toHaveBeenCalledTimes(1);
  });

  it('retries init after accepted/lost ACK and restart with identical request/key, without reading or recapturing today’s head', async () => {
    const env = environment();
    let owner = '';
    const commit = env.ports.commitTimeline.getMockImplementation()!;
    env.ports.commitTimeline.mockImplementationOnce(async (body, commitKey) => { await commit(body, commitKey); throw new Error('init ACK lost'); });
    await env.open().create(scope, async (box, id) => {
      owner = id;
      await reserveBootstrapInitialization(box, 'Main', key);
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('init ACK lost');
    });
    const original = (await env.open().list(scope))[0];
    const later = { head: { revisionId: 'edited-then-undone', publicationId: 'undo-p3' }, canonicalDocument: document() };
    env.setBasis(later);
    env.ports.loadLatest.mockClear();
    env.ports.commitTimeline.mockImplementation(async () => {
      expect(env.ports.loadLatest).not.toHaveBeenCalled();
      expect((await env.open().list(scope))[0].pending!.request).toEqual(original.pending!.request);
      // Exact replay returns the historical acceptance, never today's head.
      const result = await commit(...env.ports.commitTimeline.mock.calls[0]);
      env.setBasis(later);
      return result;
    });
    await env.open().recover(scope, owner, async (box) => {
      expect(await resumeBootstrapInitialization(box, env.ports)).toEqual(later);
    });
    expect(env.ports.commitTimeline.mock.calls[1]).toEqual(env.ports.commitTimeline.mock.calls[0]);
    expect(env.ports.createTimeline).toHaveBeenCalledTimes(1);
    expect(env.ports.loadLatest).toHaveBeenCalledTimes(1);
    await env.open().recover(scope, owner, async (box) => {
      expect(await resumeBootstrapInitialization(box, env.ports)).toEqual(later);
    });
    expect(env.ports.commitTimeline).toHaveBeenCalledTimes(2);
  });

  it.each(['advanced', 'publication', 'extra-history', 'cursor', 'receipt', 'scope', 'opaque', 'manifest', 'no-history'])('retains the draft and refuses fresh capture for %s even if displayed empty bytes match', async (fault) => {
    const env = environment();
    const basis = initialBasis();
    if (fault === 'advanced') basis.head = { revisionId: h0.revisionId, publicationId: 'undo-p3' };
    if (fault === 'publication') basis.history!.items[0].receipt.receipt_id = 'create-receipt';
    if (fault === 'extra-history') basis.history!.items.push(structuredClone(basis.history!.items[0]));
    if (fault === 'cursor') basis.history!.next_cursor = 'more-history';
    if (fault === 'receipt') basis.history!.items[0].receipt.project_id = 'other-project';
    if (fault === 'scope') basis.canonicalDocument.timeline_id = 'other-timeline';
    if (fault === 'opaque') {
      basis.canonicalDocument.parent_revision.payload.opaque = [null, { order: [3, 1, 2] }];
      const result = basis.history!.items[0].receipt.result as { payload: unknown };
      result.payload = structuredClone(basis.canonicalDocument.parent_revision.payload);
    }
    if (fault === 'manifest') basis.canonicalDocument.dependency_manifest.media.push({ media_id: 'media', content_digest: 'digest' });
    if (fault === 'no-history') delete basis.history;
    env.setBasis(basis);
    await env.open().create(scope, async (box) => {
      await reserveBootstrapInitialization(box, 'Main', key);
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow(/bootstrap|pristine/);
      expect((await box.read()).accepted?.creation).toBeDefined();
      expect(env.ports.commitTimeline).not.toHaveBeenCalled();
      expect(await env.ports.loadLatest(scope.timelineId)).toEqual(basis);
    });
  });

  it('does not fabricate H0 when the provider returns a headless create, and retains the exact flight', async () => {
    const env = environment();
    env.ports.createTimeline.mockResolvedValueOnce(Object.assign(env.createResult(), { head_publication_id: null }));
    await env.open().create(scope, async (box) => {
      await reserveBootstrapInitialization(box, 'Main', key);
      const original = await box.read();
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('tracked timeline');
      expect((await box.read()).pending!.request).toEqual(original.pending!.request);
      expect((await box.read()).accepted).toBeUndefined();
      expect(env.ports.loadLatest).not.toHaveBeenCalled();
      expect(env.ports.commitTimeline).not.toHaveBeenCalled();
    });
  });

  it('retains original native commands on a definitive intervening-write conflict', async () => {
    const env = environment();
    env.ports.commitTimeline.mockRejectedValueOnce(new ApiError(409, 'conflict', 'intervening_write', '', { status: 'conflict' }));
    await env.open().create(scope, async (box) => {
      await reserveBootstrapInitialization(box, 'Main', key);
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('intervening_write');
      const record = await box.read();
      expect((record.intents[0].payload as { commands: JSON }).commands).toEqual(fixture.commands);
      expect(record.intents[0].readyBase).toEqual(h0);
      expect(record.pending?.outcome?.kind).toBe('rejected');
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('rejected prefix');
      expect(env.ports.commitTimeline).toHaveBeenCalledTimes(1);
    });
  });

  it('retains an uncertain init flight when its returned receipt belongs to a different request', async () => {
    const env = environment();
    const commit = env.ports.commitTimeline.getMockImplementation()!;
    env.ports.commitTimeline.mockImplementationOnce(async (...args) => {
      const result = await commit(...args);
      result.response.receipt.idempotency_key = 'another-request';
      return result;
    });
    await env.open().create(scope, async (box) => {
      await reserveBootstrapInitialization(box, 'Main', key);
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('receipt does not match');
      const record = await box.read();
      expect(record.pending?.outcome?.kind).toBe('retry');
      expect(record.intents).toHaveLength(1);
      expect(record.accepted?.head).toEqual(h0);
    });
  });

  it.each(['', '   ', '  Authored Cut  ', 'x'.repeat(121)])('retains authored name %j across create retry and native capture', async (name) => {
    const env = environment();
    let owner = '';
    await env.open().create(scope, async (box, id) => {
      owner = id;
      await reserveBootstrapInitialization(box, name, key);
      const reserved = await box.read();
      expect(reserved.pending!.request.body).toBe('{"timeline_id":"main"}');
      expect(reserved.intents[0].payload).toMatchObject({ name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'timeline' });
      env.ports.createTimeline.mockRejectedValueOnce(new Error('ACK lost'));
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('ACK lost');
      expect((await box.read()).pending!.request).toEqual(reserved.pending!.request);
    });
    const commit = env.ports.commitTimeline.getMockImplementation()!;
    env.ports.commitTimeline.mockImplementation(async (...args) => {
      expect(args[0].commands[0].args.name).toBe(name);
      return commit(...args);
    });
    await env.open().recover(scope, owner, async (box) => {
      await resumeBootstrapInitialization(box, env.ports);
      expect((await box.read()).initialization!.intent.payload).toMatchObject({ commands: [
        expect.objectContaining({ args: expect.objectContaining({ name }) }), expect.anything(), expect.anything(),
      ] });
    });
    expect(env.ports.createTimeline.mock.calls).toEqual([
      [scope.projectId, scope.timelineId, key, undefined], [scope.projectId, scope.timelineId, key, undefined],
    ]);
  });

  it('refuses unsupported create names and owners without a reserved initialization', async () => {
    const env = environment();
    await env.open().create(scope, async (box: ClaimedOutbox) => {
      await expect(reserveBootstrapInitialization(box, 'Main', key, '')).rejects.toThrow('Create requires');
      await expect(reserveBootstrapInitialization(box, 'Main', key, 'x'.repeat(121))).rejects.toThrow('Create requires');
      await expect(resumeBootstrapInitialization(box, env.ports)).rejects.toThrow('No acknowledged');
      expect(env.ports.createTimeline).not.toHaveBeenCalled();
    });
  });
});
