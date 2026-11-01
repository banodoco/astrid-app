import { describe, expect, it, vi } from 'vitest';
import { captureTrackLabelEdit, submitTrackLabelEdit } from './trackLabelGesture.ts';
import type { TrackLabelArgs } from './trackLabelCapture.ts';
import { fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { acceptedCommit } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { captureClipMove, submitClipMove } from './semanticGestures.ts';
import { environment, scope, document } from './__tests__/commitSessionEnvironment.ts';
import { createTimelineCommandSession } from './commitSession.ts';
import { createCommitOutbox, toOutboxJson, type OutboxRecord, type OutboxRequest } from './commitOutbox.ts';
import type { TimelineCommandBasis } from '../data/DataProvider.ts';
import { createFakeIndexedDB } from 'fake-indexeddb';
import type { CanonicalDocument } from '@/integrations/runtime/generated.ts';
import type { EditCommand, JSON, MediaSelection, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import { captureOccurrenceAddMedia, finishOccurrenceAddMedia } from './occurrenceMediaCapture.ts';
import occurrenceFixture from './fixtures/recipe_m2_app_occurrence_duplicate.json';
import type { TimelineData } from '../lib/timeline-data.ts';

async function editOwner(env: Awaited<ReturnType<typeof environment>>, change: (record: OutboxRecord) => void) {
  await new Promise<void>((resolve, reject) => {
    const request = env.factory.open('astrid.command-outbox', 1);
    request.addEventListener('error', () => reject(request.error));
    request.addEventListener('success', () => {
      const db = request.result;
      const tx = db.transaction('owners', 'readwrite');
      const store = tx.objectStore('owners');
      const read = store.getAll();
      read.addEventListener('success', () => {
        for (const record of read.result as OutboxRecord[]) {
          change(record);
          store.put(record, JSON.stringify([scope.realmId, scope.actorId, scope.projectId, scope.timelineId, record.ownerId]));
        }
      });
      tx.addEventListener('complete', () => { db.close(); resolve(); });
      tx.addEventListener('abort', () => { db.close(); reject(tx.error); });
    });
  });
}

const occurrenceScope = { projectId: 'project-1', timelineId: 'doc /é', realmId: 'realm-1', actorId: 'actor-1' };
const occurrenceOwner = 'occurrence:occ-0' as const;
const occurrenceMedia: MediaSelection = {
  asset: 'reserved-new', generation_id: 'generation-new', variant_id: 'variant-new',
  object_id: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  catalog_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};
const occurrenceRow: Record<string, JSON> = {
  id: 'reserved-child', clipType: 'video', asset: 'reserved-new', track: 'picture', at: 0.125, hold: 4,
  from: 2, to: 6, speed: 2, params: null, opaque: [null, false, {}],
};
const occurrenceVerified: VerifiedMedia = {
  selection: occurrenceMedia, media_type: 'video/fixture', size: 123, duration_seconds: 6,
};

function occurrenceDocument(): CanonicalDocument {
  const raw = structuredClone(occurrenceFixture.bundle.source_mapping._runtime_document) as unknown as CanonicalDocument;
  for (const internal of raw.internal_timeline_revisions) {
    const payload = internal.payload as Record<string, JSON>;
    delete payload.source_window;
    internal.content_digest = fixtureDigest(payload);
    const manifest = raw.dependency_manifest.internal_timelines.find((pin) => pin.timeline_id === internal.timeline_id);
    if (manifest) manifest.content_digest = internal.content_digest;
  }
  return raw;
}

describe('real clip move session through the Runtime HTTP boundary', () => {
  it('keeps an unknown free transform conservative instead of inferring reads from its changes', async () => {
    const env = await environment();
    const bundle = await authoringBundleFromDocument(env.initial.canonicalDocument);
    const change = { op: 'set', ref: 'parent', path: ['opaque', 'absent'],
      before: { state: 'present', value: null }, value: 'authored' };
    const command: EditCommand = { schema_version: 1, op: 'doc.patch', version: '1', select: null,
      args: { changes: [change] }, reads: [] };
    let intentId = '';
    await env.outboxes.create(scope, async (box) => {
      intentId = await box.append(toOutboxJson({ commands: [command], before: bundle, after: bundle,
        preview: null, displayBasis: env.initial }), { head: env.initial.head });
    });
    const session = await env.mount();
    await session.recover(session.getState().recoverableOwners[0]);
    const [sent] = env.commits();
    expect(sent.body).toEqual({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
      base_revision_id: 'r0', base_publication_id: 'p0', commands: [command], label: 'Edit timeline',
      steps: [{ id: intentId, label: 'Edit timeline', intent: 'Edit timeline', tags: [], command_ordinals: [0],
        patch: [change] }], merge: 'atomic', dry_run: false, source: { via: 'app' } });
    expect(sent.body).not.toHaveProperty('reads');
    // This unit transport cannot accept patches; its uncertain result must still retain exact bytes/key.
    expect(session.getState().status).toBe('retry');
    await session.retry();
    expect(env.commits()[1]).toEqual(sent);
    await session.dispose();
  });

  it('fences parent-media preparation across a newer local session generation', async () => {
    const env = await environment();
    const session = await env.mount();
    const addPreparation = session.parentClipAddMediaPort.prepare();
    const swapPreparation = session.parentClipSwapMediaPort.prepare();

    env.move(session, 5);

    expect(() => session.parentClipAddMediaPort.assertPreparationCurrent(addPreparation))
      .toThrow('parent clip.add-media preparation');
    expect(() => session.parentClipSwapMediaPort.assertPreparationCurrent(swapPreparation))
      .toThrow('parent clip.swap-media preparation');
    await session.dispose();
  });

  it('queues one literal overlay command through the native port and preserves its exact retry payload', async () => {
    const env = await environment();
    const session = await env.mount();
    const prepared = session.elementOverlay.finish(session.elementOverlay.capture({
      current: env.current(),
      operation: {
        kind: 'create',
        row: {
          id: 'element-literal-1000', at: 0, track: 'V1', clipType: 'literal', hold: 1,
          elementRef: { id: 'literal', kind: 'effect', revision: 'rev-1' },
        },
      },
    }));
    session.elementOverlay.submit(prepared);
    await session.dispose();

    expect(env.commits()).toHaveLength(0);
    const [owner] = await env.outboxes.list(scope);
    expect(owner.intents).toHaveLength(1);
    expect(owner.intents[0].payload.commands).toHaveLength(1);
    expect(owner.intents[0].payload.commands[0]).toMatchObject({
      op: 'clip.add',
      args: { row: { id: 'element-literal-1000', elementRef: { id: 'literal', kind: 'effect', revision: 'rev-1' } } },
    });
  });

  it('queues one native parent intent and retries its exact request after an unknown ACK', async () => {
    const env = await environment();
    const session = await env.mount();
    const media: MediaSelection = {
      asset: 'reserved-media',
      generation_id: 'generation-media',
      variant_id: 'variant-media',
      object_id: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      catalog_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const row = { id: 'native-clip', track: 'V1', at: 2, clipType: 'video', asset: 'reserved-media', from: 0, to: 1, hold: 1, speed: 1 };
    const basis = session.parentClipAddMediaPort.capture({ row, media, current: env.current() });
    const captured = session.parentClipAddMediaPort.finish(basis, {
      selection: { ...media }, media_type: 'video/mp4', size: 1, duration_seconds: 1,
    });
    env.setFault('lost');
    session.parentClipAddMediaPort.submit(captured);

    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const first = structuredClone(env.commits()[0]);
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(1);
    expect(stored.intents[0].payload).toMatchObject({ commands: [{ op: 'clip.add-media', args: { row, media } }] });

    await session.retry();
    expect(env.commits()).toHaveLength(2);
    expect(env.commits()[1]).toEqual(first);
    expect(env.current().config.clips).toContainEqual(expect.objectContaining({ id: 'native-clip', asset: 'reserved-media' }));
    await session.dispose();
  });

  it('captures one occurrence ADD batch through the session outbox and refuses stale or unverified input', async () => {
    const initialDocument = occurrenceDocument();
    const initial: TimelineCommandBasis = {
      head: { revisionId: initialDocument.parent_revision.revision_id, publicationId: 'p0' },
      canonicalDocument: initialDocument,
    };
    const held = new Set<string>();
    const outboxes = createCommitOutbox({
      indexedDB: createFakeIndexedDB(),
      exclusiveLock: async (key, work) => {
        if (held.has(key)) throw new Error('claimed');
        held.add(key);
        try { return await work(); } finally { held.delete(key); }
      },
    });
    const calls: EditCommand[][] = [];
    const send = async (request: { commands: EditCommand[] }, key: string) => {
      calls.push(structuredClone(request.commands));
      const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' },
        { revision_id: initial.head.revisionId, publication_id: initial.head.publicationId }, {
          projectId: occurrenceScope.projectId, timelineId: occurrenceScope.timelineId, commands: request.commands,
        });
      response.data.canonical_document = structuredClone(initialDocument);
      response.data.document_digest = fixtureDigest(initialDocument);
      response.receipt.result = response.data;
      response.receipt.idempotency_key = key;
      return {
        response,
        canonicalDocument: structuredClone(initialDocument),
        graph: {},
        receipt: response.receipt,
        accepted: { revisionId: 'r1', publicationId: 'p1' },
      };
    };
    const project = vi.fn(async () => undefined);
    const preview = vi.fn();
    const session = await createTimelineCommandSession({
      scope: occurrenceScope,
      initial,
      outboxes,
      send,
      preview,
      project,
      changed: () => {},
    });
    const current = { head: {
      projectId: occurrenceScope.projectId, timelineId: occurrenceScope.timelineId,
      headRevisionId: initial.head.revisionId, headPublicationId: initial.head.publicationId,
    } } as TimelineData;
    const basisBundle = await authoringBundleFromDocument(initialDocument);
    const expected = finishOccurrenceAddMedia(captureOccurrenceAddMedia(
      basisBundle, occurrenceOwner, occurrenceRow, occurrenceMedia, [occurrenceVerified],
    ));
    const captured = session.occurrenceAddMediaPort.capture({
      ownerRef: occurrenceOwner, row: occurrenceRow, media: occurrenceMedia, current,
    });
    expect(() => session.occurrenceAddMediaPort.capture({
      ownerRef: occurrenceOwner, row: occurrenceRow, media: occurrenceMedia,
      current: { ...current, head: { ...current.head, headRevisionId: 'stale' } },
    })).toThrow('Displayed timeline does not match the raw authoring basis');
    expect(() => session.occurrenceAddMediaPort.finish(captured, {
      ...occurrenceVerified, selection: { ...occurrenceMedia, asset: 'wrong-reserved-id' },
    })).toThrow('exact Runtime-verified media input');

    const finished = session.occurrenceAddMediaPort.finish(captured, occurrenceVerified);
    expect(finished).toEqual({ command: expected.command, preview: null });
    session.occurrenceAddMediaPort.submit(finished);
    await expect(session.flush()).resolves.toEqual({ revisionId: 'r1', publicationId: 'p1' });

    expect(calls).toEqual([[expected.command]]);
    expect(expected.record).toMatchObject({ command: expected.command, reads: expected.command.reads,
      selections: expected.command.selections, created: expect.arrayContaining([
        { ref: `${occurrenceOwner}/asset:${occurrenceMedia.asset}`, kind: 'asset', owner: occurrenceOwner },
        { ref: `${occurrenceOwner}/clip:${occurrenceRow.id}`, kind: 'clip', owner: occurrenceOwner },
      ]) });
    expect(preview).not.toHaveBeenCalled();
    expect(project.mock.calls.every(([, patches]) => patches?.length === 0)).toBe(true);
    await session.dispose();
  });

  it('opens the exact public immutable closure, preserving unknown/null/absent fields and child scope', async () => {
    const raw = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
      { revision_id: 'old', publication_id: 'old' }, { children: true }).data.canonical_document;
    const env = await environment(raw);
    expect(env.initial.canonicalDocument).toEqual(raw);
    const projectReads = env.calls.filter((call) => call.path.startsWith('/v1/projects/')).map((call) => call.path);
    expect(projectReads).toEqual([
      '/v1/projects/project-commit/timelines/timeline-commit/commits?limit=50',
      '/v1/projects/project-commit/timelines/timeline-commit/composition-revisions/r0',
      '/v1/projects/project-commit/shots/shot-1/revisions/shot-r1',
      '/v1/projects/project-commit/timelines/child-timeline/revisions/internal-r1',
    ]);
  });
  it('refuses a missing raw manifest without inferring document or child pins', async () => {
    const raw = document();
    delete (raw as Partial<typeof raw>).dependency_manifest;
    await expect(environment(raw)).rejects.toThrow('dependency manifest');
  });
  it.each([
    ['missing dependency manifest', (raw: Record<string, unknown>) => { delete raw.dependency_manifest; }, 'dependency_manifest'],
    ['changed project scope', (raw: Record<string, unknown>) => { raw.project_id = 'other-project'; }, 'outside the requested project/timeline'],
  ] as const)('refuses a corrupt original display closure and retains the saved draft: %s', async (_name, corrupt, reason) => {
    const env = await environment();
    const first = await env.mount();
    env.setFault('busy');
    env.move(first, 5);
    await vi.waitFor(() => expect(first.getState().status).toBe('retry'));
    await first.dispose();
    const [saved] = await env.outboxes.list(scope);

    await editOwner(env, (record) => {
      const payload = record.intents[0].payload as unknown as { displayBasis?: { canonicalDocument?: Record<string, unknown> } };
      corrupt(payload.displayBasis!.canonicalDocument!);
    });
    const [corrupted] = await env.outboxes.list(scope);
    const newer = { ...env.initial, head: { revisionId: 'newer', publicationId: 'newer-p' },
      canonicalDocument: { ...env.initial.canonicalDocument,
        parent_revision: { ...env.initial.canonicalDocument.parent_revision, revision_id: 'newer' } } };
    const beforeRefusal = { intents: structuredClone(corrupted.intents), pending: structuredClone(corrupted.pending) };
    const reopened = await env.mount(newer);
    await expect(reopened.recover(saved.ownerId)).rejects.toThrow(reason);
    expect(reopened.getState()).toMatchObject({ status: 'error', canUndo: false });
    expect(env.projected).toHaveLength(0);
    expect(env.commits()).toHaveLength(1);
    const [retained] = await env.outboxes.list(scope);
    expect({ intents: retained.intents, pending: retained.pending }).toEqual(beforeRefusal);
    await reopened.dispose();
  });
  it('captures dependent A5/B7 before preview, submits B at HA with original guards and a fresh key', async () => {
    const env = await environment();
    const session = await env.mount();
    const gate = env.pause();
    env.move(session, 5);
    env.move(session, 7);
    await vi.waitFor(() => expect(env.commits()).toHaveLength(1));
    expect(env.previews).toHaveBeenCalledTimes(2);
    gate.resolve();
    await session.flush();
    const [a, b] = env.commits();
    expect(a.body?.base_publication_id).toBe('p0');
    expect(b.body?.base_publication_id).toBe('p1');
    expect(b.body?.commands[0].expect?.['parent/clip:x::at']).toEqual({ state: 'present', value: 5 });
    expect(b.key).not.toBe(a.key);
    expect(env.projected.at(-1)?.head.publicationId).toBe('p2');
    expect(env.calls.filter((call) => call.method !== 'GET' && call.path !== '/v1/handshake').map((call) => call.path)).toEqual(env.commits().map((call) => call.path));
    await session.dispose();
  });
  it('keeps a drag capture original when its predecessor is acknowledged before drop', async () => {
    const env = await environment();
    const session = await env.mount();
    env.setFault('lost');
    env.move(session, 5);
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const captured = captureClipMove(session.port, env.current(), 'x');
    const original = structuredClone(captured.basis);
    await session.retry();
    submitClipMove(captured, 7);
    await session.flush();
    expect(captured.basis).toEqual(original);
    expect(env.commits()[2].body?.base_publication_id).toBe('p1');
    expect(env.commits()[2].body?.commands[0].expect?.['parent/clip:x::at']).toEqual({ state: 'present', value: 5 });
    await session.dispose();
  });
  it('advances publication identity when a same-value move reuses the content revision', async () => {
    const env = await environment();
    const session = await env.mount();
    env.move(session, 5);
    await session.flush();
    env.move(session, 5);
    await session.flush();
    expect(env.projected.slice(-2).map((basis) => basis.head)).toEqual([
      { revisionId: 'r1', publicationId: 'p1' }, { revisionId: 'r1', publicationId: 'p2' },
    ]);
    await session.undo();
    expect(env.commits()[2].body).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p2',
      commands: [{ op: 'timeline.inverse', args: { publications: ['p2'] } }] });
    await session.dispose();
  });
  it.each(['accepted', 'conflict'] as const)(
    'queues B authored after uncertain A without retransmitting, then recovers exact A: %s', async (outcome) => {
      const env = await environment();
      const first = await env.mount();
      env.setFault('lost');
      env.move(first, 5);
      await vi.waitFor(() => expect(first.getState().status).toBe('retry'));
      const [original] = await env.outboxes.list(scope);
      const requestA = original.pending!.request;
      const wireA = structuredClone(env.commits()[0]);
      expect(wireA).toMatchObject({ method: requestA.method, path: requestA.path,
        bodyText: requestA.body, key: requestA.key });
      // The fake transport has already accepted A, but the session still displays H0 + A.
      const acceptedA = await env.provider.loadTimelineCommandBasis(scope.timelineId);
      expect(acceptedA.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
      expect(env.current().head?.headPublicationId).toBe('p0');
      expect(env.current().config.clips[0].at).toBe(5);
      expect(env.projected).toHaveLength(0);
      for (const head of [ { ...env.current().head!, headRevisionId: 'other' },
        { ...env.current().head!, headPublicationId: 'other' } ]) {
        expect(() => captureClipMove(first.port, { ...env.current(), head }, 'x')).toThrow('Displayed timeline');
      }
      const captured = captureClipMove(first.port, env.current(), 'x');
      const originalCapture = structuredClone(captured.basis);
      const finish = vi.spyOn(first.port, 'finish');
      submitClipMove(captured, 7);
      const commandB = structuredClone(finish.mock.results[0].value.command) as EditCommand;
      expect(commandB.expect!['parent/clip:x::at']).toEqual({ state: 'present', value: 5 });
      expect(commandB.reads!.length).toBeGreaterThan(0);
      expect(commandB.selections!.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(first.getState().status).toBe('retry'));
      const [queued] = await env.outboxes.list(scope);
      expect(env.commits()).toEqual([wireA]);
      expect(queued.pending).toEqual(original.pending);
      expect(queued.intents).toHaveLength(2);
      expect(queued.intents[0]).toEqual(original.intents[0]);
      expect(queued.intents[1]).toMatchObject({ basis: { after: original.intents[0].id },
        payload: { commands: [commandB], displayBasis: env.initial } });
      expect(queued.intents[1].readyBase).toBeUndefined();
      expect(captured.basis).toEqual(originalCapture);
      expect(() => submitClipMove(captured, 9)).toThrow('Timeline changed during the move');
      await expect(first.undo()).rejects.toThrow('uncertain');
      await expect(env.outboxes.recover(scope, queued.ownerId, async () => {})).rejects.toThrow('claimed');
      for (const field of ['realmId', 'actorId', 'projectId', 'timelineId']) {
        const other = { ...scope, [field]: 'other' };
        expect(await env.outboxes.list(other)).toEqual([]);
        await expect(env.outboxes.recover(other, queued.ownerId, async () => {})).rejects.toThrow('explicit claim');
      }
      await first.dispose();
      expect((await env.outboxes.list(scope))[0].intents).toEqual(queued.intents);
      const recovered = await env.mount(acceptedA);
      expect(recovered.getState()).toMatchObject({ status: 'recovery', recoverableOwners: [queued.ownerId] });
      expect(env.commits()).toEqual([wireA]);
      if (outcome === 'conflict') env.setFault('conflict');
      await recovered.recover(queued.ownerId);
      expect(env.project.mock.calls[0]).toEqual([env.initial, queued.intents.map((intent) => (intent.payload as { preview: unknown }).preview)]);
      expect(env.commits()[1]).toEqual(wireA);
      expect(finish.mock.results.map((result) => result.type)).toEqual(['return', 'throw']);
      if (outcome === 'accepted') {
        expect(env.commits()).toHaveLength(3);
        const wireB = env.commits()[2];
        expect(wireB.body).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1', commands: [commandB] });
        expect(wireB.body?.commands).toEqual([commandB]);
        expect(wireB.key).not.toBe(wireA.key);
        expect(wireB.path).toBe(wireA.path);
        expect(recovered.getState()).toMatchObject({ status: 'saved', canUndo: true });
        expect(env.current().config.clips[0].at).toBe(7);
        expect(env.project.mock.calls.at(-1)?.[0].head).toEqual({ revisionId: 'r2', publicationId: 'p2' });
        expect(env.project.mock.calls.at(-1)?.[0].canonicalDocument.parent_revision.payload.clips).toMatchObject([{ id: 'x', at: 7 }]);
        await recovered.undo();
        await recovered.flush();
        expect(env.commits()[3].body).toMatchObject({ base_revision_id: 'r2', base_publication_id: 'p2',
          commands: [{ op: 'timeline.inverse', args: { publications: ['p2'] } }] });
        expect(env.commits()[3].key).not.toBe(wireB.key);
      } else {
        expect(recovered.getState()).toMatchObject({ status: 'conflict', canUndo: false });
        const [retained] = await env.outboxes.list(scope);
        expect(retained.intents.map(({ conflict, ...intent }) => intent)).toEqual(queued.intents);
        expect(retained.intents.every((intent) => intent.conflict !== undefined)).toBe(true);
        expect(retained.pending?.request).toEqual(requestA);
        expect(retained.intents[1].readyBase).toBeUndefined();
        await recovered.retry();
        await expect(recovered.flush()).rejects.toThrow('conflict');
        expect(env.commits()).toHaveLength(2);
      }
      await recovered.dispose();
    });
  it.each([true, false])('recovers legacy work only with a matching original document: %s', async (matching) => {
    const env = await environment();
    const session = await env.mount();
    env.setFault('busy');
    env.move(session, 5);
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    await session.dispose();
    await editOwner(env, (record) => {
      delete (record.intents[0].payload as Record<string, unknown>).displayBasis;
      if (!matching && 'head' in record.intents[0].basis) record.intents[0].basis.head.revisionId = 'another-revision';
    });
    const reopened = await env.mount({ ...env.initial, head: { revisionId: 'r0', publicationId: 'new-publication' } });
    const [saved] = await env.outboxes.list(scope);
    if (matching) {
      await reopened.recover(session.getState().ownerId!);
      expect(env.projected.at(-1)).toEqual({ head: env.initial.head, canonicalDocument: env.initial.canonicalDocument });
      expect(reopened.getState().status).toBe('retry');
    } else {
      await expect(reopened.recover(session.getState().ownerId!)).rejects.toThrow('verified original display basis');
      expect(env.projected).toHaveLength(0);
      expect(env.commits()).toHaveLength(1);
      const [retained] = await env.outboxes.list(scope);
      expect(retained.intents).toEqual(saved.intents);
      expect(retained.pending).toEqual(saved.pending);
    }
    await reopened.dispose();
  });
  it('routes a persisted native bootstrap owner through its existing carrier before generic edit recovery', async () => {
    const runtime = {} as { env: Awaited<ReturnType<typeof environment>> };
    const recoverBootstrap = async (claimedOwner: string): Promise<TimelineCommandBasis> => {
      expect(claimedOwner).toBe(ownerId);
      await runtime.env.outboxes.recover(scope, claimedOwner, async (box) => {
        expect((await box.read()).pending?.request).toEqual(nativeRequest);
        await box.dispatch(() => { throw new Error('pending native request must be reused'); }, async (request) => {
          expect(request).toEqual(nativeRequest);
          return { kind: 'accepted', head: { revisionId: 'r1', publicationId: 'p1' }, value: {} };
        });
      });
      return runtime.env.initial;
    };
    const env = await environment(undefined, { recoverBootstrap });
    runtime.env = env;
    const nativeBody = { api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
      base_revision_id: 'r0', base_publication_id: 'p0', commands: [{ op: 'timeline.init' }], source: { via: 'app' } };
    let nativeRequest!: OutboxRequest;
    let ownerId = '';
    await env.outboxes.create(scope, async (box) => {
      await box.append({ kind: 'timeline-init', commands: [{ op: 'timeline.init' }] }, { head: { revisionId: 'r0', publicationId: 'p0' } });
      await box.dispatch(() => ({ method: 'POST', path: '/v1/projects/project-commit/timelines/timeline-commit/commit', body: nativeBody }), async (request) => {
        nativeRequest = request;
        expect(request.body).toBe(JSON.stringify(nativeBody));
        return { kind: 'retry', error: { message: 'lost acknowledgement' } };
      });
    });
    ownerId = (await env.outboxes.list(scope))[0].ownerId;
    const session = await env.mount();
    expect(session.getState()).toMatchObject({ status: 'recovery', recoverableOwners: [ownerId] });
    await session.recover(ownerId);
    expect(session.getState()).toMatchObject({ status: 'saved', ownerId });
    const recovered = (await env.outboxes.list(scope))[0];
    expect(recovered.intents).toEqual([]);
    expect(recovered.pending).toBeUndefined();
    await session.dispose();
  });
  it('recovers B on its original display closure after A is acknowledged without changing submission bytes', async () => {
    const env = await environment();
    const first = await env.mount();
    env.setFault('lost');
    env.move(first, 5);
    env.move(first, 7);
    await vi.waitFor(() => expect(first.getState().status).toBe('retry'));
    const [original] = await env.outboxes.list(scope);
    const b = original.intents[1];
    await env.provider.undoTimeline({ projectId: scope.projectId, timelineId: scope.timelineId,
      headRevisionId: 'r1', headPublicationId: 'p1' }, ['p1'], 'independent-c');
    await first.retry();
    expect(env.commits()[2]).toEqual(env.commits()[0]);
    const requestB = structuredClone(env.commits()[3]);
    expect(requestB.body).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1',
      commands: [{ args: { on: 7 }, expect: { 'parent/clip:x::at': { state: 'present', value: 5 } } }] });
    expect(requestB.key).not.toBe(env.commits()[0].key);
    expect(first.getState()).toMatchObject({ status: 'conflict', error: expect.stringContaining('expect') });
    const [beforeClose] = await env.outboxes.list(scope);
    expect(JSON.parse(beforeClose.pending!.request.body)).toEqual(requestB.body);
    expect(beforeClose.pending!.request.key).toBe(requestB.key);
    expect(beforeClose.intents[0]).toMatchObject({ ...b, readyBase: { revisionId: 'r1', publicationId: 'p1' } });
    expect(beforeClose.accepted?.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
    await first.dispose();
    const project = vi.fn(async () => {});
    const reopened = await createTimelineCommandSession({
      initial: await env.provider.loadTimelineCommandBasis('timeline-commit'), scope, outboxes: env.outboxes,
      send: (request, key) => env.provider.commitTimeline(request, key),
      preview: env.previews, project, changed: () => {},
    });
    await reopened.recover(original.ownerId);
    expect(project).toHaveBeenCalledExactlyOnceWith(env.initial, [(b.payload as any).preview]);
    expect((b.payload as any).preview.operations).toEqual([{ op: 'clip.move', target: 'x', payload: { at: 7 } }]);
    // B's failed original guard is a durable typed conflict; recovery cannot resend it.
    expect(env.commits()).toHaveLength(4);
    expect(reopened.getState()).toMatchObject({ status: 'conflict', error: first.getState().error, canUndo: false });
    await reopened.retry();
    await expect(reopened.flush()).rejects.toThrow(first.getState().error!);
    expect(env.commits()).toHaveLength(4);
    const [recovered] = await env.outboxes.list(scope);
    expect(recovered.intents).toEqual(beforeClose.intents);
    expect(recovered.pending).toEqual(beforeClose.pending);
    expect(recovered.accepted).toEqual(beforeClose.accepted);
    await reopened.dispose();
  });
  it.each((['conflict', 'refused', 'validation', 'authorization'] as const).flatMap((fault) =>
    [true, false].map((pending) => ({ fault, pending }))))(
    'retains typed $fault on recovery with pending request: $pending', async ({ fault, pending }) => {
      const env = await environment();
      const first = await env.mount();
      env.setFault(fault);
      env.move(first, 5);
      env.move(first, 7);
      const status = fault === 'conflict' ? 'conflict' : 'error';
      await vi.waitFor(() => expect(first.getState().status).toBe(status));
      const original = first.getState();
      await first.dispose();
      if (!pending) {
        // A retained rejection blocks the first intent even without a request reservation.
        await editOwner(env, (record) => { delete record.pending; });
      }
      const [saved] = await env.outboxes.list(scope);
      const reopened = await env.mount();
      await reopened.recover(original.ownerId!);
      expect(reopened.getState()).toMatchObject({ status, error: original.error, canUndo: false });
      await reopened.retry();
      expect(reopened.getState()).toMatchObject({ status, error: original.error, canUndo: false });
      await expect(reopened.flush()).rejects.toThrow(original.error!);
      expect(env.commits()).toHaveLength(1);
      expect((await env.outboxes.list(scope))[0].intents).toHaveLength(2);
      const [retained] = await env.outboxes.list(scope);
      expect(retained.intents).toEqual(saved.intents);
      expect(retained.pending).toEqual(saved.pending);
      await reopened.dispose();
    });
  it('keeps newer observed C when an old A acknowledgement arrives', async () => {
    const env = await environment();
    const session = await env.mount();
    const gate = env.pause();
    env.move(session, 5);
    await vi.waitFor(() => expect(env.commits()).toHaveLength(1));
    session.observe({ head: { revisionId: 'rc', publicationId: 'pc' }, canonicalDocument: document(9, 'rc') });
    gate.resolve();
    await session.flush();
    expect(env.projected.at(-1)?.head.publicationId).toBe('pc');
    await session.dispose();
  });
  it.each(['busy', 'unavailable', 'conflict'] as const)('distinguishes %s from an accepted move and retains its suffix', async (fault) => {
    const env = await environment();
    const session = await env.mount();
    env.setFault(fault);
    env.move(session, 5);
    env.move(session, 7);
    await vi.waitFor(() => expect(session.getState().status).toBe(fault === 'conflict' ? 'conflict' : 'retry'));
    const owners = await env.outboxes.list(scope);
    expect(owners[0].intents).toHaveLength(2);
    await expect(session.undo()).rejects.toThrow();
    if (fault !== 'conflict') {
      const first = env.commits()[0];
      env.setFault(null);
      await session.retry();
      expect(env.commits()[1]).toEqual(first);
      expect(session.getState().status).toBe('saved');
    }
    await session.dispose();
  });
  it('keeps the preview visible and sends nothing when durable append fails', async () => {
    const env = await environment();
    const session = await env.mount();
    const originalOpen = env.factory.open.bind(env.factory);
    env.factory.open = () => { throw new Error('disk full'); };
    env.move(session, 5);
    await vi.waitFor(() => expect(session.getState().status).toBe('error'));
    expect(session.getState().error).toContain('Unsaved move');
    expect(env.previews).toHaveBeenCalledOnce();
    expect(env.commits()).toHaveLength(0);
    await expect(session.flush()).rejects.toThrow();
    env.factory.open = originalOpen;
    await session.retry();
    expect(env.commits()).toHaveLength(1);
    expect(session.getState().status).toBe('saved');
    await session.dispose();
  });
  it('undo sends the explicit accepted publication via the same durable commit path', async () => {
    const env = await environment();
    const session = await env.mount();
    env.move(session, 5);
    await session.flush();
    await session.undo();
    await session.flush();
    expect(env.commits()[1].body?.commands).toEqual([{ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: ['p1'] } }]);
    expect(env.commits()[1].key).not.toBe(env.commits()[0].key);
    await session.dispose();
  });
});

function rawTrack(raw: ReturnType<typeof document>) {
  return (raw.parent_revision.payload.config as { tracks: Array<{ id: string; label?: string }> }).tracks[0];
}

function rename(session: Awaited<ReturnType<typeof createTimelineCommandSession>>, current: ReturnType<Awaited<ReturnType<typeof environment>>['current']>, label: string) {
  submitTrackLabelEdit(captureTrackLabelEdit(session.trackLabelPort, current, 'V1'), { values: { label }, clear: [] });
}

describe('track labels in the existing durable command session', () => {
  it.each([undefined, 'Original', ''])('keeps original presence %j for value, empty and clear edits', async (original) => {
    for (const args of [
      { values: { label: 'Renamed' }, clear: [] },
      { values: { label: '' }, clear: [] },
      { values: {}, clear: ['label'] },
    ] as TrackLabelArgs[]) {
      const raw = document();
      if (original !== undefined) rawTrack(raw).label = original;
      raw.parent_revision.content_digest = fixtureDigest(raw.parent_revision.payload);
      const env = await environment(raw);
      const session = await env.mount();
      const captured = captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1');
      submitTrackLabelEdit(captured, args);
      await session.flush();
      const command = env.commits()[0].body!.commands[0];
      expect(command).toMatchObject({ op: 'track.set', version: '1', select: 'parent/track:V1', args,
        expect: { 'parent/track:V1::label': original === undefined ? { state: 'absent' } : { state: 'present', value: original } },
        bindings: { 'scalar.target': 'parent/track:V1' } });
      expect(Object.keys(command.expect!)).toEqual(['parent/track:V1::label']);
      expect(command.reads).toEqual([{ ref: 'parent/track:V1', path: ['id'], state: { state: 'present', value: 'V1' } }]);
      const accepted = env.projected.at(-1)!.canonicalDocument;
      if ('label' in args.values) expect(rawTrack(accepted).label).toBe(args.values.label);
      else expect(rawTrack(accepted)).not.toHaveProperty('label');
      expect(accepted.parent_revision.payload.opaque).toEqual({ absent: null });
      expect(accepted.parent_revision.payload.clips).toEqual(raw.parent_revision.payload.clips);
      expect(env.previews.mock.calls[0][0]).toEqual({ version: 1, operations: [{ op: 'track.update', target: 'V1',
        payload: { label: 'label' in args.values ? args.values.label : 'V1' } }] });
      await session.undo();
      await session.flush();
      expect(env.commits()[1].body!.commands[0]).toMatchObject({ op: 'timeline.inverse', args: { publications: ['p1'] } });
      const restored = rawTrack(env.projected.at(-1)!.canonicalDocument);
      if (original === undefined) expect(restored).not.toHaveProperty('label');
      else expect(restored.label).toBe(original);
      await session.dispose();
    }
  });
  it('keeps queued move → label guards and the exact native pending identity through reload', async () => {
    const env = await environment();
    const session = await env.mount();
    env.setFault('lost');
    env.move(session, 5);
    rename(session, env.current(), 'Queued label');
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const original = structuredClone(env.commits()[0]);
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(2);
    expect(stored.intents[1].basis).toEqual({ after: stored.intents[0].id });
    const labelPayload = structuredClone(stored.intents[1].payload);
    expect(labelPayload).toMatchObject({ commands: [{ op: 'track.set', args: { values: { label: 'Queued label' }, clear: [] },
      expect: { 'parent/track:V1::label': { state: 'absent' } } }],
    after: { parent: { clips: [{ at: 5 }], config: { tracks: [{ label: 'Queued label' }] } } } });
    expect(stored.pending?.request.key).toBe(original.key);
    expect(JSON.parse(stored.pending!.request.body)).toEqual(original.body);
    await session.dispose();
    const reopened = await env.mount(await env.provider.loadTimelineCommandBasis('timeline-commit'));
    expect(reopened.getState().status).toBe('recovery');
    expect(env.commits()).toHaveLength(1);
    await reopened.recover(stored.ownerId);
    expect(env.commits()[1]).toEqual(original);
    expect(env.commits()[2].body).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1',
      commands: (labelPayload as { commands: unknown }).commands });
    expect(env.commits()[2].key).not.toBe(original.key);
    expect(env.current().config.clips[0].at).toBe(5);
    expect(rawTrack(env.projected.at(-1)!.canonicalDocument).label).toBe('Queued label');
    await reopened.undo();
    await reopened.flush();
    expect(rawTrack(env.projected.at(-1)!.canonicalDocument)).not.toHaveProperty('label');
    expect(env.current().config.clips[0].at).toBe(5);
    await reopened.dispose();
  });
  it('keeps typing capture original when A is acknowledged before label completion', async () => {
    const env = await environment();
    const session = await env.mount();
    env.setFault('lost');
    env.move(session, 5);
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const captured = captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1');
    const basis = structuredClone(captured.basis);
    await session.retry();
    submitTrackLabelEdit(captured, { values: { label: 'Typed over A' }, clear: [] });
    await session.flush();
    expect(captured.basis).toEqual(basis);
    expect(env.commits()[2].body).toMatchObject({ base_publication_id: 'p1', commands: [{ op: 'track.set',
      expect: { 'parent/track:V1::label': { state: 'absent' } } }] });
    expect(env.current().config.clips[0].at).toBe(5);
    await session.dispose();
  });
  it('refuses an observed external label mutation during typing without replacing the input', async () => {
    const env = await environment();
    const session = await env.mount();
    const captured = captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1');
    session.observe(await env.external((raw) => { rawTrack(raw).label = 'Someone else'; }));
    await vi.waitFor(() => expect(env.current().config.tracks[0].label).toBe('Someone else'));
    const args: TrackLabelArgs = { values: { label: 'My typing' }, clear: [] };
    expect(() => submitTrackLabelEdit(captured, args)).toThrow('Track label changed');
    expect(args.values.label).toBe('My typing');
    expect(captured.basis.command).toMatchObject({ expect: { 'parent/track:V1::label': { state: 'absent' } } });
    expect(env.commits()).toHaveLength(0);
    expect((await env.outboxes.list(scope))[0].intents).toHaveLength(0);
    await session.dispose();
  });
  it('surfaces an unobserved external label change as a real guarded conflict', async () => {
    const env = await environment();
    const session = await env.mount();
    const captured = captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1');
    await env.external((raw) => { rawTrack(raw).label = 'Someone else'; });
    submitTrackLabelEdit(captured, { values: { label: 'My typing' }, clear: [] });
    await expect(session.flush()).rejects.toThrow('original capture');
    expect(session.getState().status).toBe('conflict');
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents[0].payload).toMatchObject({ commands: [{ args: { values: { label: 'My typing' } } }],
      preview: { operations: [{ payload: { label: 'My typing' } }] } });
    await session.dispose();
  });
  it.each(['move', 'label'] as const)('allows disjoint remote editing while %s guards stay original', async (operation) => {
    const env = await environment();
    const session = await env.mount();
    const capturedMove = captureClipMove(session.port, env.current(), 'x');
    const capturedLabel = captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1');
    const remote = await env.external((raw) => {
      if (operation === 'move') rawTrack(raw).label = 'Remote label';
      else {
        (raw.parent_revision.payload.clips as Array<{ at: number }>)[0].at = 8;
        (raw.parent_revision.payload.config as { clips: Array<{ at: number }> }).clips[0].at = 8;
      }
    });
    session.observe(remote);
    await vi.waitFor(() => expect(env.current().head?.headRevisionId).toBe(remote.head.revisionId));
    if (operation === 'move') submitClipMove(capturedMove, 5);
    else submitTrackLabelEdit(capturedLabel, { values: { label: 'Local label' }, clear: [] });
    await session.flush();
    const accepted = env.projected.at(-1)!.canonicalDocument;
    expect(env.current().config.clips[0].at).toBe(operation === 'move' ? 5 : 8);
    expect(rawTrack(accepted).label).toBe(operation === 'move' ? 'Remote label' : 'Local label');
    const command = env.commits()[0].body!.commands[0];
    expect(command.expect?.[operation === 'move' ? 'parent/clip:x::at' : 'parent/track:V1::label'])
      .toEqual(operation === 'move' ? { state: 'present', value: 1 } : { state: 'absent' });
    if (operation === 'move') expect(command.reads?.some((read) => read.path.includes('label'))).toBe(false);
    else expect(command.reads?.some((read) => read.ref.includes('/clip:'))).toBe(false);
    await session.dispose();
  });
  it('refuses synthetic or ambiguous track ownership and unprepared commands atomically', async () => {
    const raw = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
      { revision_id: 'old', publication_id: 'old' }, { children: true }).data.canonical_document;
    const env = await environment(raw);
    const session = await env.mount();
    expect(() => captureTrackLabelEdit(session.trackLabelPort, env.current(), env.current().config.tracks[0].id)).toThrow();
    expect(() => session.trackLabelPort.submit({ command: { schema_version: 1, op: 'track.set', version: '1',
      select: 'parent/track:V1', args: { values: { label: 'Uncaptured' }, clear: [] } },
    preview: { version: 1, operations: [] } })).toThrow('not captured');
    expect(env.previews).not.toHaveBeenCalled();
    expect(env.commits()).toHaveLength(0);
    await session.dispose();
  });
  it.each(['project', 'timeline', 'publication', 'synthetic'] as const)('refuses a mismatched %s display basis', async (mismatch) => {
    const env = await environment();
    const session = await env.mount();
    const current = structuredClone(env.current());
    if (mismatch === 'project') current.head!.projectId = 'other-project';
    if (mismatch === 'timeline') current.head!.timelineId = 'other-timeline';
    if (mismatch === 'publication') delete current.head!.headPublicationId;
    if (mismatch === 'synthetic') {
      current.resolvedConfig.tracks[0].id = 'display-only';
      current.config.tracks[0].id = 'display-only';
    }
    expect(() => captureTrackLabelEdit(session.trackLabelPort, current, mismatch === 'synthetic' ? 'display-only' : 'V1')).toThrow();
    expect(env.previews).not.toHaveBeenCalled();
    expect(env.commits()).toHaveLength(0);
    await session.dispose();
  });
  it('refuses mixed previews atomically and keeps the original capture available', async () => {
    const env = await environment();
    const session = await env.mount();
    const captured = captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1');
    const args: TrackLabelArgs = { values: { label: 'Only label' }, clear: [] };
    const { command } = session.trackLabelPort.finish(captured.basis, args);
    expect(() => session.trackLabelPort.submit({ command, preview: { version: 1, operations: [
      { op: 'track.update', target: 'V1', payload: { label: 'Only label', muted: true } },
    ] } })).toThrow('label-only preview');
    expect(env.previews).not.toHaveBeenCalled();
    expect((await env.outboxes.list(scope))[0].intents).toHaveLength(0);
    submitTrackLabelEdit(captured, args);
    await session.flush();
    expect(env.commits()).toHaveLength(1);
    expect(env.commits()[0].body!.commands[0]).toEqual(command);
    await session.dispose();
  });
});

// HTTP and acceptance are fabricated by the unit fixture; browser/Runtime proof is a separate lane.
describe('explicit resolution in the same command session', () => {
  it('keeps the unknown-ACK barrier and offers only exact retry', async () => {
    const env = await environment();
    const session = await env.mount();
    env.setFault('lost');
    rename(session, env.current(), 'Mine');
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const original = structuredClone((await env.outboxes.list(scope))[0]);
    expect(session.getState()).toMatchObject({ canDiscardRejected: false, canReapplyLabel: false });
    await expect(session.useLatest()).rejects.toThrow('definitively rejected');
    await expect(session.keepLabelChanges()).rejects.toThrow('definitively rejected');
    expect((await env.outboxes.list(scope))[0]).toEqual(original);
    expect(env.commits()).toHaveLength(1);
    await session.retry();
    expect(env.commits()[1]).toEqual(env.commits()[0]);
    await session.dispose();
  });

  it.each<TrackLabelArgs>([
    { values: { label: 'Mine' }, clear: [] },
    { values: { label: '' }, clear: [] },
    { values: {}, clear: ['label'] },
  ])('authors a new explicit label intent %j, then reloads and retries it exactly', async (args) => {
    const env = await environment();
    const session = await env.mount();
    const captured = captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1');
    const remote = await env.external((raw) => { rawTrack(raw).label = 'Someone else'; });
    submitTrackLabelEdit(captured, args);
    await expect(session.flush()).rejects.toThrow('original capture');
    const [rejected] = await env.outboxes.list(scope);
    const original = structuredClone(env.commits()[0]);
    expect(session.getState()).toMatchObject({ canDiscardRejected: true, canReapplyLabel: true });
    session.observe(remote);
    await session.retry();
    expect(env.commits()).toEqual([original]);
    expect((await env.outboxes.list(scope))[0]).toEqual(rejected);
    expect(env.projected).toHaveLength(0);

    // A further external write must be guarded only by the explicit NEW intent.
    const fresh = await env.external((raw) => { rawTrack(raw).label = 'Latest label'; });
    env.setFault('lost');
    await session.keepLabelChanges();
    expect(session.getState().status).toBe('retry');
    const [kept] = await env.outboxes.list(scope);
    expect(kept.ownerId).toBe(rejected.ownerId);
    expect(kept.intents).toHaveLength(1);
    expect(kept.intents[0].id).not.toBe(rejected.intents[0].id);
    const replacement = structuredClone(env.commits()[1]);
    expect(replacement.key).not.toBe(original.key);
    expect(replacement.body).toMatchObject({ base_revision_id: fresh.head.revisionId,
      base_publication_id: fresh.head.publicationId, commands: [{ op: 'track.set', select: 'parent/track:V1', args,
        expect: { 'parent/track:V1::label': { state: 'present', value: 'Latest label' } } }] });
    expect(replacement.body!.commands[0].bindings).toEqual(original.body!.commands[0].bindings);
    expect(kept.intents[0].payload).toMatchObject({ before: { base_parent: { revision_id: fresh.head.revisionId } } });
    expect(env.commits()[0]).toEqual(original);
    expect(JSON.parse(rejected.pending!.request.body)).toEqual(original.body);
    expect(rejected.intents[0].payload).toMatchObject({ commands: [original.body!.commands[0]] });
    await session.dispose();

    const reopened = await env.mount(await env.provider.loadTimelineCommandBasis(scope.timelineId));
    await reopened.recover(kept.ownerId);
    expect(env.commits()[2]).toEqual(replacement);
    expect(reopened.getState().status).toBe('saved');
    const accepted = env.projected.at(-1)!.canonicalDocument;
    if ('label' in args.values) expect(rawTrack(accepted).label).toBe(args.values.label);
    else expect(rawTrack(accepted)).not.toHaveProperty('label');
    await reopened.undo();
    await reopened.flush();
    expect(rawTrack(env.projected.at(-1)!.canonicalDocument).label).toBe('Latest label');
    await reopened.dispose();
  });

  it('retains dependent B and unsupported operations until Use latest explicitly discards all displayed work', async () => {
    const env = await environment();
    const session = await env.mount();
    env.setFault('conflict');
    env.move(session, 5);
    rename(session, env.current(), 'Dependent B');
    await expect(session.flush()).rejects.toThrow('conflict');
    const [original] = await env.outboxes.list(scope);
    expect(original.intents).toHaveLength(2);
    expect(session.getState()).toMatchObject({ canDiscardRejected: true, canReapplyLabel: false });
    await expect(session.keepLabelChanges()).rejects.toThrow('no retained suffix');
    await session.retry();
    expect((await env.outboxes.list(scope))[0]).toEqual(original);
    expect(env.commits()).toHaveLength(1);
    env.setFault(null);
    const fresh = await env.external((raw) => { rawTrack(raw).label = 'Remote'; });
    await session.useLatest();
    expect(session.getState()).toMatchObject({ status: 'saved', canDiscardRejected: false, canReapplyLabel: false });
    const [cleared] = await env.outboxes.list(scope);
    expect(cleared.ownerId).toBe(original.ownerId);
    expect(cleared.intents).toEqual([]);
    expect(cleared.pending).toBeUndefined();
    expect(env.current().config.clips[0].at).toBe(1);
    expect(env.current().config.tracks[0].label).toBe('Remote');
    expect(env.current().head?.headPublicationId).toBe(fresh.head.publicationId);
    expect(env.commits()).toHaveLength(1);
    const next = captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1');
    submitTrackLabelEdit(next, { values: { label: 'Next' }, clear: [] });
    await session.flush();
    expect(env.commits()[1].body).toMatchObject({ base_revision_id: fresh.head.revisionId,
      base_publication_id: fresh.head.publicationId });
    await session.dispose();
    const reopened = await env.mount(await env.provider.loadTimelineCommandBasis(scope.timelineId));
    expect(reopened.getState().status).toBe('saved');
    expect(reopened.getState().recoverableOwners).toEqual([]);
    await reopened.dispose();
  });

  it('disables Keep for a rejected parent-label prefix with an original dependent suffix', async () => {
    const env = await environment();
    const session = await env.mount();
    env.setFault('conflict');
    rename(session, env.current(), 'A');
    env.move(session, 7);
    await expect(session.flush()).rejects.toThrow('conflict');
    const [original] = await env.outboxes.list(scope);
    expect(original.intents[1]).toMatchObject({ basis: { after: original.intents[0].id },
      payload: { commands: [{ op: 'clip.move', expect: { 'parent/clip:x::at': { state: 'present', value: 1 } } }] } });
    expect(session.getState()).toMatchObject({ canDiscardRejected: true, canReapplyLabel: false });
    await expect(session.keepLabelChanges()).rejects.toThrow('no retained suffix');
    expect((await env.outboxes.list(scope))[0]).toEqual(original);
    expect(env.commits()).toHaveLength(1);
    await session.dispose();
  });

  it.each(['deleted target', 'ambiguous owner', 'wrong scope', 'wrong revision', 'read failure', 'storage failure'] as const)(
    'preserves the original rejected request on %s', async (failure) => {
      const env = await environment();
      const session = await env.mount();
      env.setFault('conflict');
      rename(session, env.current(), 'Retain me');
      await expect(session.flush()).rejects.toThrow('conflict');
      const [original] = await env.outboxes.list(scope);
      const fresh = await env.external((raw) => {
        if (failure === 'deleted target') (raw.parent_revision.payload.config as { tracks: unknown[] }).tracks = [];
        if (failure === 'ambiguous owner') {
          const children = acceptedCommit({ revision_id: 'child-parent', publication_id: 'child-p' },
            { revision_id: 'old', publication_id: 'old' }, { children: true }).data.canonical_document;
          raw.parent_revision.payload.occurrences = children.parent_revision.payload.occurrences;
          raw.shot_revisions = children.shot_revisions;
          raw.internal_timeline_revisions = children.internal_timeline_revisions;
          raw.dependency_manifest = children.dependency_manifest;
        }
      });
      const load = vi.spyOn(env.provider, 'loadTimelineCommandBasis');
      if (failure === 'wrong scope') load.mockResolvedValueOnce({ ...fresh,
        canonicalDocument: { ...fresh.canonicalDocument, project_id: 'other-project' } });
      if (failure === 'wrong revision') load.mockResolvedValueOnce({ ...fresh, head: { ...fresh.head, revisionId: 'other' } });
      if (failure === 'read failure') load.mockRejectedValueOnce(new Error('cannot fetch closure'));
      const open = env.factory.open;
      if (failure === 'storage failure') env.factory.open = () => { throw new Error('disk full'); };
      await expect(session.keepLabelChanges()).rejects.toThrow();
      env.factory.open = open;
      load.mockRestore();
      expect((await env.outboxes.list(scope))[0]).toEqual(original);
      expect(env.commits()).toHaveLength(1);
      expect(env.projected).toHaveLength(0);
      expect(session.getState().canDiscardRejected).toBe(true);
      await session.dispose();
      const reopened = await env.mount();
      await reopened.recover(original.ownerId);
      expect((await env.outboxes.list(scope))[0].pending).toEqual(original.pending);
      await reopened.dispose();
    },
  );

  it.each(['keep', 'latest'] as const)('fences %s when dispose races the fresh read', async (action) => {
    const env = await environment();
    const session = await env.mount();
    env.setFault('conflict');
    rename(session, env.current(), 'Retain me');
    await expect(session.flush()).rejects.toThrow('conflict');
    const [original] = await env.outboxes.list(scope);
    let finish!: (basis: typeof env.initial) => void;
    const load = vi.spyOn(env.provider, 'loadTimelineCommandBasis').mockImplementationOnce(() =>
      new Promise((resolve) => { finish = resolve; }));
    const resolving = action === 'keep' ? session.keepLabelChanges() : session.useLatest();
    const refused = expect(resolving).rejects.toThrow(/closed|Stale/);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await session.dispose();
    finish(env.initial);
    await refused;
    expect((await env.outboxes.list(scope))[0]).toEqual(original);
    expect(env.projected).toHaveLength(0);
    load.mockRestore();
  });
});
