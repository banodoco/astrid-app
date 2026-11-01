import { describe, expect, it, vi } from 'vitest';
import type { CanonicalDocument, CommitRequest, EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import type { ResolvedTimelineConfig } from '../types/index.ts';
import type { PreparedShotComposition } from '../data/shotCompositionAdapter.ts';
import { projectCanonicalComposition } from '../data/shotCompositionProjection.ts';
import { stableOccurrenceDeepLink, stableOutputIdentity } from '../data/shotComposition.ts';
import { assembleTimelineData, type TimelineData } from '../lib/timeline-data.ts';
import { compileTimelinePatch } from '../lib/timeline-patch.ts';
import { createTimelineCommandSession } from './commitSession.ts';
import { captureClipScalarEdit, submitClipScalarEdit, type ClipScalarArgs } from './clipScalarGesture.ts';
import { captureTrackLabelEdit, submitTrackLabelEdit } from './trackLabelGesture.ts';
import { environment, scope } from './__tests__/commitSessionEnvironment.ts';
import { AuthoredState, copy } from './clipMovePrimitives.ts';
import fixture from './fixtures/recipe_m2_app_clip_scalar_fields.json';

const golden = fixture;
const head = { revisionId: 'r0', publicationId: 'p0' };
const holdRef = 'occurrence:f2-occurrence/clip:f2-agent-clip';
const assetRef = 'occurrence:f2-occurrence/clip:f2-agent-clear-clip';
const transitionRef = 'parent/clip:f2-transition-clip';
const cases: Array<[string, ClipScalarArgs]> = [
  [holdRef, { values: { hold: 4 }, clear: [] }],
  [assetRef, { values: {}, clear: ['asset'] }],
  [transitionRef, { values: {}, clear: ['transition'] }],
];
const owner = (ref: string) => ref.slice(0, ref.lastIndexOf('/')) as 'parent' | `occurrence:${string}`;
const displayId = (ref: string) => owner(ref) === 'parent' ? ref.split('/clip:')[1] : `${owner(ref).slice(11)}:${ref.split('/clip:')[1]}`;

function rawDocument(): CanonicalDocument {
  const raw = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
    { revision_id: 'initial', publication_id: 'initial' }, { children: true }).data.canonical_document;
  raw.parent_revision.payload = { ...copy(golden.bundle.parent), occurrences: golden.bundle.placements.map((placement) => ({
    ...copy(placement), shot_id: 'shot-1', shot_revision_id: 'shot-r1',
  })) };
  raw.parent_revision.content_digest = fixtureDigest(raw.parent_revision.payload);
  const internal = raw.internal_timeline_revisions[0];
  internal.payload = copy(Object.values(golden.bundle.shots)[0].internal_timeline);
  internal.content_digest = fixtureDigest(internal.payload);
  raw.dependency_manifest.internal_timelines[0].content_digest = internal.content_digest;
  return raw;
}

function display(raw: CanonicalDocument, pin = head): TimelineData {
  const parent = raw.parent_revision.payload;
  const occurrences = (parent.occurrences as Array<Record<string, JSON>>).map((occurrence, ordinal) => {
    const shot = raw.shot_revisions.find((image) => image.revision_id === occurrence.shot_revision_id)!;
    const internal = raw.internal_timeline_revisions.find((image) => image.revision_id === shot.internal_timeline_revision_id)!;
    const occurrenceId = occurrence.occurrence_id as string;
    return { projectId: raw.project_id, parentDocumentId: raw.timeline_id, occurrenceId,
      shotId: shot.shot_id, revisionId: shot.revision_id, ordinal,
      atMs: (occurrence.placement as { start_ms: number }).start_ms, durationMs: occurrence.duration_ms as number,
      trackId: occurrence.track as string, sourceOffsetMs: occurrence.source_offset as number,
      speed: occurrence.speed as number, gain: occurrence.gain as number, muted: occurrence.muted as boolean,
      stableDeepLink: stableOccurrenceDeepLink(raw.project_id, raw.timeline_id, shot.shot_id, shot.revision_id, occurrenceId),
      outputIdentity: stableOutputIdentity(raw.project_id, raw.timeline_id, occurrenceId),
      revision: { ...copy(shot.payload), shot_id: shot.shot_id, revision_id: shot.revision_id,
        internal_timeline_revision: { revision_id: internal.revision_id, timeline: copy(internal.payload) } },
    };
  });
  const composition: PreparedShotComposition = {
    projectId: raw.project_id, parentDocumentId: raw.timeline_id, headRevisionId: pin.revisionId, occurrences,
    contract: { schema_version: 1, project: { project_id: raw.project_id, document_id: raw.timeline_id },
      primary_timeline: { document_id: raw.timeline_id, head: { revision_id: pin.revisionId } },
      parent_composition: copy(parent), shot_revisions: raw.shot_revisions.map((shot) =>
        occurrences.find((occurrence) => occurrence.shotId === shot.shot_id && occurrence.revisionId === shot.revision_id)!.revision),
      occurrences: copy(parent.occurrences) as Array<Record<string, JSON>>, cases: {} },
  };
  const { config } = projectCanonicalComposition(composition, {
    ...copy(parent.config as object), output: { fps: 30, resolution: '1920x1080' },
    clips: copy(parent.clips), registry: {},
  } as ResolvedTimelineConfig);
  return assembleTimelineData({ config, configVersion: 1, head: { ...scope,
    headRevisionId: pin.revisionId, headPublicationId: pin.publicationId }, registry: { assets: {} },
  resolvedConfig: { ...config, tracks: config.tracks ?? [], registry: {} }, output: config.output, assetMap: {} });
}

async function setup(raw = rawDocument()) {
  const storage = await environment();
  let current = display(raw);
  const initial: TimelineCommandBasis = { head, canonicalDocument: raw };
  const requests: Array<{ body: string; key: string }> = [];
  // Unit transport deliberately remains uncertain: no Runtime scalar acceptance is simulated.
  let send: (request: CommitRequest, key: string) => Promise<TimelineCommitResult> = async () => { throw new Error('unknown outcome'); };
  const project = vi.fn(async (basis, previews) => {
    current = display(basis.canonicalDocument, basis.head);
    for (const patch of previews) {
      const compiled = compileTimelinePatch(patch, current);
      if (!compiled.nextData) throw new Error('invalid recovered preview');
      current = compiled.nextData;
    }
  });
  const mount = (basis = initial) => createTimelineCommandSession({ scope, initial: basis, outboxes: storage.outboxes,
    send: (request, key) => { requests.push({ body: JSON.stringify(request), key }); return send(request, key); },
    preview: (patch) => {
      const compiled = compileTimelinePatch(patch, current);
      if (!compiled.nextData) throw new Error('invalid scalar preview');
      current = compiled.nextData;
    }, project, changed: () => {} });
  return { ...storage, initial, mount, requests, project, current: () => current,
    setSend: (next: typeof send) => { send = next; } };
}
const rawRow = (bundle: unknown, ref: string) => new AuthoredState(bundle as never).entity(ref)!;

describe('clip scalars in the existing durable session (unit transport only)', () => {
  it('refuses a stale binding to a shared sibling before capture or local mutation', async () => {
    const env = await setup();
    const session = await env.mount();
    const current = env.current();
    const id = displayId(assetRef);
    const selected = current.resolvedConfig.clips.find((clip) => clip.id === id)!;
    selected.app = { ...selected.app, canonical: {
      ...(selected.app?.canonical as object), clipRef: 'occurrence:shared-sibling/clip:f2-agent-clear-clip',
    } };
    const before = copy(current);
    const [outbox] = await env.outboxes.list(scope);
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, id, 'occurrence:shared-sibling'))
      .toThrow('matching raw clip owner');
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, id))
      .toThrow('matching raw clip owner');
    expect(env.current()).toEqual(before);
    expect(await env.outboxes.list(scope)).toEqual([outbox]);
    expect(env.requests).toHaveLength(0);
    await session.dispose();
  });

  it.each([
    ['same-owner wrong clip', { clipRef: holdRef }],
    ['wrong raw ID', { rawClipId: 'f2-agent-clip' }],
    ['wrong owner', { ownerRef: 'occurrence:shared-sibling' }],
    ['wrong occurrence', { occurrenceId: 'shared-sibling' }],
    ['wrong project', { projectId: 'other-project' }],
    ['wrong parent', { parentDocumentId: 'other-timeline' }],
    ['wrong shot', { shotId: 'other-shot' }],
    ['stale shot revision', { revisionId: 'old-shot-revision' }],
    ['stale internal revision', { internalTimelineRevisionId: 'old-internal-revision' }],
    ['wrong output identity', { outputIdentity: 'other-output' }],
    ['missing raw ID', { rawClipId: null }],
    ['unaddressable binding', { clipRef: null }],
    ['missing raw target', { clipRef: 'occurrence:f2-occurrence/clip:missing', rawClipId: 'missing' }],
    ['missing binding', undefined],
    ['clipRef alone', { clipRef: assetRef }],
  ] as const)('refuses %s without changing data or appending an outbox intent', async (_name, forged) => {
    const env = await setup();
    const session = await env.mount();
    const current = env.current();
    const id = displayId(assetRef);
    const selected = current.resolvedConfig.clips.find((clip) => clip.id === id)!;
    const canonical = forged === undefined ? undefined : _name === 'clipRef alone'
      ? forged : { ...(selected.app?.canonical as object), ...forged };
    selected.app = { ...selected.app, canonical };
    const before = copy(current);
    const outboxes = await env.outboxes.list(scope);
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, id, owner(assetRef)))
      .toThrow('matching raw clip owner');
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, id))
      .toThrow('matching raw clip owner');
    expect(env.current()).toEqual(before);
    expect(await env.outboxes.list(scope)).toEqual(outboxes);
    expect(env.requests).toHaveLength(0);
    await session.dispose();
  });

  it('refuses a complete sibling identity attached to a different projector output ID', async () => {
    const env = await setup();
    const session = await env.mount();
    const current = env.current();
    const selected = current.resolvedConfig.clips.find((clip) => clip.id === displayId(assetRef))!;
    const sibling = current.resolvedConfig.clips.find((clip) => clip.id === 'shared-sibling:f2-agent-clear-clip')!;
    selected.app = { ...selected.app, canonical: copy(sibling.app!.canonical) };
    const before = copy(current);
    const outboxes = await env.outboxes.list(scope);
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, selected.id, 'occurrence:shared-sibling'))
      .toThrow('matching raw clip owner');
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, selected.id))
      .toThrow('matching raw clip owner');
    expect(env.current()).toEqual(before);
    expect(await env.outboxes.list(scope)).toEqual(outboxes);
    expect(env.requests).toHaveLength(0);
    await session.dispose();
  });

  it('binds parent rows to their raw parent identity despite opaque authored canonical fields', async () => {
    const raw = rawDocument();
    const row = (raw.parent_revision.payload.clips as Array<Record<string, JSON>>)[0];
    const occurrenceClip = display(raw).resolvedConfig.clips.find((clip) => clip.id === displayId(assetRef))!;
    row.app = { canonical: copy(occurrenceClip.app!.canonical) as JSON, opaque: { keep: [null, 'parent'] } };
    const env = await setup(raw);
    const session = await env.mount();
    const current = env.current();
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, row.id as string, owner(assetRef)))
      .toThrow('matching raw clip owner');
    const captured = captureClipScalarEdit(session.clipScalarPort, current, row.id as string, 'parent');
    expect(captureClipScalarEdit(session.clipScalarPort, current, row.id as string).basis).toEqual(captured.basis);
    submitClipScalarEdit(captured, { values: {}, clear: ['asset'] });
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const [stored] = await env.outboxes.list(scope);
    const payload = stored.intents[0].payload as { commands: EditCommand[]; after: unknown };
    expect(payload.commands[0].select).toBe(`parent/clip:${row.id}`);
    expect(rawRow(payload.after, `parent/clip:${row.id}`).app).toEqual(row.app);
    expect(env.current().config.clips.find((clip) => clip.id === row.id)).not.toHaveProperty('asset');
    await session.dispose();
  });

  it('refuses authored parent metadata impersonating an otherwise valid projected occurrence', async () => {
    const raw = rawDocument();
    const id = displayId(assetRef);
    const projected = display(raw).resolvedConfig.clips.find((clip) => clip.id === id)!;
    const row = (raw.parent_revision.payload.clips as Array<Record<string, JSON>>)[0];
    row.id = id;
    row.app = { canonical: copy(projected.app!.canonical) as JSON };
    const env = await setup(raw);
    const session = await env.mount();
    const current = env.current();
    // Even if only the forged parent row is presented, its authored metadata is not a binding.
    const parent = current.resolvedConfig.clips.find((clip) => clip.id === id)!;
    current.resolvedConfig.clips = current.resolvedConfig.clips.filter((clip) => clip.id !== id || clip === parent);
    const before = copy(current);
    const outboxes = await env.outboxes.list(scope);
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, id, owner(assetRef)))
      .toThrow('matching raw clip owner');
    expect(env.current()).toEqual(before);
    expect(await env.outboxes.list(scope)).toEqual(outboxes);
    expect(env.requests).toHaveLength(0);
    await session.dispose();
  });

  it.each(['bad/id', 'bad::id'])('refuses production unaddressable projected ID %s', async (rawId) => {
    const raw = rawDocument();
    (raw.internal_timeline_revisions[0].payload.clips as Array<Record<string, JSON>>)[0].id = rawId;
    const env = await setup(raw);
    const session = await env.mount();
    const current = env.current();
    const id = `f2-occurrence:${rawId}`;
    expect(current.resolvedConfig.clips.find((clip) => clip.id === id)!.app!.canonical).toMatchObject({
      rawClipId: rawId, clipRef: null,
    });
    const before = copy(current);
    const outboxes = await env.outboxes.list(scope);
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, id, owner(holdRef)))
      .toThrow('matching raw clip owner');
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, id))
      .toThrow('matching raw clip owner');
    expect(env.current()).toEqual(before);
    expect(await env.outboxes.list(scope)).toEqual(outboxes);
    expect(env.requests).toHaveLength(0);
    await session.dispose();
  });

  it('refuses duplicate selected display rows before capture', async () => {
    const env = await setup();
    const session = await env.mount();
    const current = env.current();
    current.resolvedConfig.clips.push(copy(current.resolvedConfig.clips.find((clip) => clip.id === displayId(assetRef))!));
    const before = copy(current);
    const outboxes = await env.outboxes.list(scope);
    expect(() => session.clipScalarPort.capture({ current, clipId: displayId(assetRef), ownerRef: owner(assetRef) }))
      .toThrow('one raw clip identity');
    expect(() => session.clipScalarPort.capture({ current, clipId: displayId(assetRef) }))
      .toThrow('one raw clip identity');
    expect(env.current()).toEqual(before);
    expect(await env.outboxes.list(scope)).toEqual(outboxes);
    expect(env.requests).toHaveLength(0);
    await session.dispose();
  });

  it('refuses duplicate raw clip identities even though the projector can display them', async () => {
    const raw = rawDocument();
    const clips = raw.internal_timeline_revisions[0].payload.clips as Array<Record<string, JSON>>;
    clips.push(copy(clips.find((clip) => clip.id === 'f2-agent-clip')!));
    const env = await setup(raw);
    const before = copy(env.current());
    expect(before.resolvedConfig.clips.filter((clip) => clip.id === displayId(holdRef))).toHaveLength(2);
    expect(before.resolvedConfig.clips.filter((clip) => clip.id === displayId(holdRef))[1].app!.canonical)
      .toMatchObject({ clipRef: null });
    await expect(env.mount()).rejects.toThrow('duplicate identity');
    expect(env.current()).toEqual(before);
    expect(await env.outboxes.list(scope)).toEqual([]);
    expect(env.requests).toHaveLength(0);
  });

  it.each(cases)('captures original journey intent %s → previews → persists → reloads → retries exact bytes/key', async (ref, args) => {
    const env = await setup();
    const session = await env.mount();
    const before = copy(env.current().config);
    const id = displayId(ref);
    const sibling = copy(before.clips.find((clip) => clip.id === `shared-sibling:${ref.split('/clip:')[1]}`));
    const captured = captureClipScalarEdit(session.clipScalarPort, env.current(), id, owner(ref));
    expect(captureClipScalarEdit(session.clipScalarPort, env.current(), id).basis).toEqual(captured.basis);
    const { command } = session.clipScalarPort.finish(captured.basis, args);
    submitClipScalarEdit(captured, args);
    const previewRow = env.current().config.clips.find((clip) => clip.id === id)!;
    for (const key of args.clear) {
      expect(previewRow).not.toHaveProperty(key);
      expect(env.current().resolvedConfig.clips.find((clip) => clip.id === id)).not.toHaveProperty(key);
    }
    if ('hold' in args.values) expect(previewRow.hold).toBe(4);
    expect(env.current().config.clips.map((clip) => clip.id)).toEqual(before.clips.map((clip) => clip.id));
    if (sibling) expect(env.current().config.clips.find((clip) => clip.id === sibling.id)).toEqual(sibling);
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const [stored] = await env.outboxes.list(scope);
    const payload = stored.intents[0].payload as unknown as { commands: EditCommand[]; after: unknown };
    expect(payload.commands).toEqual([command]);
    expect(JSON.parse(env.requests[0].body)).toEqual({ api_version: 1, project_id: scope.projectId,
      timeline_id: scope.timelineId, base_revision_id: head.revisionId, base_publication_id: head.publicationId,
      commands: [command], label: 'Edit timeline', steps: [{ id: stored.intents[0].id, label: 'Edit timeline',
        intent: 'Edit timeline', tags: [], command_ordinals: [0], patch: [] }], merge: 'fields', reads: [],
      dry_run: false, source: { via: 'app' } });
    // Original native reads (including absent/null) stay at the command's capture boundary.
    expect(command.reads?.length).toBeGreaterThan(0);
    const row = rawRow(payload.after, ref);
    const original = rawRow(captured.basis.bundle, ref);
    const expected = { ...original, ...args.values };
    for (const key of args.clear) delete expected[key];
    expect(row).toEqual(expected);
    expect(payload.commands[0]).toMatchObject({ select: ref, op: 'clip.set', args, bindings: { 'scalar.target': ref } });
    expect(stored.pending!.request.body).toBe(env.requests[0].body);
    expect(stored.pending!.request.key).toBe(env.requests[0].key);
    await session.dispose();
    const reopened = await env.mount();
    expect(reopened.getState().status).toBe('recovery');
    expect(env.requests).toHaveLength(1);
    await reopened.recover(stored.ownerId);
    expect(env.requests[1]).toEqual(env.requests[0]);
    const recovered = env.current().config.clips.find((clip) => clip.id === id)!;
    for (const key of args.clear) expect(recovered).not.toHaveProperty(key);
    if ('hold' in args.values) expect(recovered.hold).toBe(4);
    expect(JSON.parse(env.requests[0].body).commands).toEqual([command]);
    await reopened.dispose();
  });

  it.each(['absent', 'null', 'empty'] as const)('retains original %s and clears asset to ABSENT through recovery', async (state) => {
    const raw = rawDocument();
    const row = (raw.parent_revision.payload.clips as Array<Record<string, JSON>>)[0];
    if (state === 'absent') delete row.asset;
    else row.asset = state === 'null' ? null : '';
    const env = await setup(raw);
    const session = await env.mount();
    submitClipScalarEdit(captureClipScalarEdit(session.clipScalarPort, env.current(), row.id as string, 'parent'),
      { values: {}, clear: ['asset'] });
    expect(env.current().config.clips[0]).not.toHaveProperty('asset');
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const command = JSON.parse(env.requests[0].body).commands[0];
    expect(command.expect[`parent/clip:${row.id}::asset`]).toEqual(state === 'absent'
      ? { state: 'absent' } : { state: 'present', value: state === 'null' ? null : '' });
    await session.dispose();
    const [stored] = await env.outboxes.list(scope);
    const reopened = await env.mount();
    await reopened.recover(stored.ownerId);
    expect(env.current().config.clips[0]).not.toHaveProperty('asset');
    expect(env.requests[1]).toEqual(env.requests[0]);
    await reopened.dispose();
  });

  it('keeps B original guards and predecessor across A acknowledgement without refreshing capture', async () => {
    const env = await setup();
    const session = await env.mount();
    submitTrackLabelEdit(captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1'), { values: { label: 'A' }, clear: [] });
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const captured = captureClipScalarEdit(session.clipScalarPort, env.current(), displayId(assetRef), owner(assetRef));
    const original = copy(captured.basis);
    submitClipScalarEdit(captured, cases[1][1]);
    await vi.waitFor(async () => expect((await env.outboxes.list(scope))[0].intents).toHaveLength(2));
    const [stored] = await env.outboxes.list(scope);
    const suffix = copy(stored.intents[1]);
    expect(suffix.basis).toEqual({ after: stored.intents[0].id });
    const next = copy(env.initial.canonicalDocument);
    (next.parent_revision.payload.config as { tracks: Array<{ label: string }> }).tracks[0].label = 'A';
    next.parent_revision.revision_id = 'r1';
    env.setSend(async (request, key) => {
      if (request.commands[0].op !== 'track.set') throw new Error('unknown scalar outcome');
      const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' });
      response.data.canonical_document = next;
      return { accepted: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: next, response,
        receipt: { ...response.receipt, idempotency_key: key }, graph: {} };
    });
    await session.retry();
    const scalarRequest = env.requests.at(-1)!;
    expect(env.requests.slice(0, -1).every((request) => request.body === env.requests[0].body && request.key === env.requests[0].key)).toBe(true);
    expect(JSON.parse(scalarRequest.body)).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1',
      commands: (suffix.payload as { commands: unknown }).commands });
    expect(scalarRequest.key).not.toBe(env.requests[0].key);
    expect(captured.basis).toEqual(original);
    expect(env.current().config.clips.find((clip) => clip.id === displayId(assetRef))).not.toHaveProperty('asset');
    await session.dispose();
    const reopened = await env.mount({ head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: next });
    await reopened.recover(stored.ownerId);
    expect(env.requests.at(-1)).toEqual(scalarRequest);
    expect(env.project.mock.calls.at(-1)![0].head).toEqual(head);
    await reopened.dispose();
  });

  it('finishes a capture after A acknowledgement with identical original claims and raw opaque bytes', async () => {
    const env = await setup();
    const session = await env.mount();
    submitTrackLabelEdit(captureTrackLabelEdit(session.trackLabelPort, env.current(), 'V1'), { values: { label: 'A' }, clear: [] });
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const captured = captureClipScalarEdit(session.clipScalarPort, env.current(), displayId(assetRef), owner(assetRef));
    const original = session.clipScalarPort.finish(captured.basis, cases[1][1]).command;
    const next = copy(env.initial.canonicalDocument);
    (next.parent_revision.payload.config as { tracks: Array<{ label: string }> }).tracks[0].label = 'A';
    next.parent_revision.payload.opaque_after_capture = { keep: [null, 9] };
    next.parent_revision.revision_id = 'r1';
    env.setSend(async (request) => {
      if (request.commands[0].op !== 'track.set') throw new Error('unknown scalar outcome');
      const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' });
      response.data.canonical_document = next;
      return { accepted: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: next, response,
        receipt: response.receipt, graph: {} };
    });
    await session.retry();
    expect(session.getState().status).toBe('saved');
    expect(session.clipScalarPort.finish(captured.basis, cases[1][1]).command).toEqual(original);
    submitClipScalarEdit(captured, cases[1][1]);
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    expect(JSON.parse(env.requests.at(-1)!.body)).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1', commands: [original] });
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents[0].payload).toMatchObject({ after: { parent: { opaque_after_capture: { keep: [null, 9] } } } });
    await session.dispose();
  });

  it('clears hold only when its source window survives, preserving speed and exact window leaves', async () => {
    const raw = rawDocument();
    const row = (raw.internal_timeline_revisions[0].payload.clips as Array<Record<string, JSON>>).find((clip) => clip.id === 'f2-agent-clip')!;
    Object.assign(row, { from: 1, to: 4, speed: 2 });
    const env = await setup(raw);
    const session = await env.mount();
    submitClipScalarEdit(captureClipScalarEdit(session.clipScalarPort, env.current(), displayId(holdRef), owner(holdRef)),
      { values: {}, clear: ['hold'] });
    const preview = env.current().config.clips.find((clip) => clip.id === displayId(holdRef))!;
    expect(preview).not.toHaveProperty('hold');
    expect(preview).toMatchObject({ from: 1, to: 4, speed: 2 });
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));
    const [stored] = await env.outboxes.list(scope);
    const after = rawRow((stored.intents[0].payload as { after: unknown }).after, holdRef);
    expect(after).not.toHaveProperty('hold');
    expect(after).toMatchObject({ from: 1, to: 4, speed: 2 });
    await session.dispose();
  });

  it('rejects wrong owners, stale claims and forged previews while preserving the local draft', async () => {
    const env = await setup();
    const session = await env.mount();
    const current = env.current();
    expect(() => captureClipScalarEdit(session.clipScalarPort, current, displayId(assetRef), 'parent')).toThrow('matching raw clip owner');
    const captured = captureClipScalarEdit(session.clipScalarPort, current, displayId(assetRef), owner(assetRef));
    const prepared = session.clipScalarPort.finish(captured.basis, cases[1][1]);
    expect(() => session.clipScalarPort.submit({ command: prepared.command, preview: { version: 1, operations: [
      { op: 'clip.update', target: displayId(assetRef), payload: { asset: null } },
    ] } })).toThrow('exact leaf-only preview');
    expect(env.current()).toBe(current);
    expect(env.requests).toHaveLength(0);
    const beforeArgs = copy(cases[1][1]);
    submitClipScalarEdit(captured, cases[1][1]);
    expect(() => submitClipScalarEdit(captured, cases[1][1])).toThrow('Timeline changed');
    expect(cases[1][1]).toEqual(beforeArgs);
    expect(env.current().config.clips.find((clip) => clip.id === displayId(assetRef))).not.toHaveProperty('asset');
    await session.dispose();
  });

  it('keeps unsupported hold-after-move intentions visibly refused without changing the draft', async () => {
    const raw = rawDocument();
    const row = (raw.internal_timeline_revisions[0].payload.clips as Array<Record<string, JSON>>).find((clip) => clip.id === 'f2-agent-clip')!;
    row.app = { astrid: { for: 3 } };
    const env = await setup(raw);
    const session = await env.mount();
    const current = env.current();
    const captured = captureClipScalarEdit(session.clipScalarPort, current, displayId(holdRef), owner(holdRef));
    expect(() => submitClipScalarEdit(captured, cases[0][1])).toThrow('does not support for');
    expect(env.current()).toBe(current);
    expect(env.requests).toHaveLength(0);
    await session.dispose();
  });
});
