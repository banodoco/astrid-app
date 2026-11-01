// @vitest-environment jsdom
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox.ts';
import { createLocalSaveSession } from '../commands/localSaveSession.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { createShotCompositionAdapter } from '../data/shotCompositionAdapter.ts';
import { projectCanonicalComposition } from '../data/shotCompositionProjection.ts';
import { runtimeGraphToContractFromCanonicalDocument } from '@/integrations/runtime/dataProvider.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import type { DataProvider } from '../data/DataProvider.ts';
import { createShotTimelineDataProvider } from '@/tools/travel-between-images/components/shotTimelineDataProvider.ts';
import { createTimelineLocalSaveHandoff, resolveTimelinePersistenceHandoff, type TimelinePersistenceHandoff } from './timelineLocalSaveHandoff.ts';
import { TimelineEventBus } from './useTimelineEventBus.ts';
import { useTimelineCommit } from './useTimelineCommit.ts';
import { useAssetManagement } from './useAssetManagement.ts';
import { useExternalDrop } from './useExternalDrop.ts';
import { useDragCoordinator } from './useDragCoordinator.ts';

const media: MediaSelection = { asset: 'import-image', generation_id: 'generation-image', variant_id: 'variant-image',
  object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'b'.repeat(64)}` };
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  Object.defineProperty(navigator, 'locks', { configurable: true,
    value: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}) } });
});
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; vi.unstubAllGlobals(); });

async function environment(child: boolean, delayed = false, empty = false) {
  const parentConfig = createDefaultTimelineConfig();
  parentConfig.tracks = [{ id: 'V1', kind: 'visual', label: 'V1' }, { id: 'S1', kind: 'visual', label: 'S1' }];
  parentConfig.clips = [
    { id: 'parent-title', track: 'V1', at: 0, from: 0, to: 3, speed: 1, clipType: 'media', asset: 'existing-image' },
    { id: 'parent-reference', track: 'V1', at: 15, from: 0, to: 3, speed: 1, clipType: 'media', asset: 'existing-video' },
  ];
  Object.assign(parentConfig.clips[0], { opaqueClip: { nullable: null, ordered: [false, 0, '', [], { z: 2, a: 1 }] } });
  const registry = { assets: { 'existing-image': { file: 'existing.png', type: 'image/png', media_id: `sha256:${'c'.repeat(64)}`, content_sha256: `sha256:${'c'.repeat(64)}` },
    'existing-video': { file: 'existing.mp4', type: 'video/mp4', duration: 12, media_id: `sha256:${'d'.repeat(64)}`, content_sha256: `sha256:${'d'.repeat(64)}` } } };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
    { revision_id: 'r0', publication_id: 'p0' }, { children: true }).data.canonical_document;
  document.parent_revision.payload = { config: { ...parentConfig, registry }, clips: parentConfig.clips, registry,
    occurrences: [{ occurrence_id: 'occ-0', shot_id: 'shot-1', shot_revision_id: 'shot-r1',
      placement: { start_ms: 0 }, duration_ms: 12000, source_offset: 0, speed: 1, track: 'S1' }] };
  if (empty) {
    parentConfig.tracks = [];
    parentConfig.clips = [];
    document.parent_revision.payload = { config: { clips: [], tracks: [] }, registry: {}, clips: [], occurrences: [] };
    document.shot_revisions = [];
    document.internal_timeline_revisions = [];
    document.dependency_manifest = { shots: [], internal_timelines: [], media: [], documents: [] };
  }
  if (!empty) document.internal_timeline_revisions[0].payload = {
    tracks: [{ id: 'plate', kind: 'visual', label: 'plate' }, { id: 'V2', kind: 'visual', label: 'V2' }],
    clips: [{ id: 'plate', track: 'plate', at: 0, hold: 12, clipType: 'media', asset: 'existing-image' },
      { id: 'child-title', track: 'V2', at: 3, hold: 3, clipType: 'media', asset: 'existing-image' },
      { id: 'child-reference', track: 'V2', at: 6, hold: 3, clipType: 'media', asset: 'existing-image' }],
    output: parentConfig.output, registry,
  };
  if (!empty) {
  document.shot_revisions[0].payload = { ...document.shot_revisions[0].payload, timing: { duration_ms: 12000 } };
  document.internal_timeline_revisions[0].content_digest = fixtureDigest(document.internal_timeline_revisions[0].payload);
  document.shot_revisions[0].content_digest = fixtureDigest(document.shot_revisions[0].payload);
  document.dependency_manifest.internal_timelines[0].content_digest = document.internal_timeline_revisions[0].content_digest;
  document.dependency_manifest.shots[0].content_digest = document.shot_revisions[0].content_digest;
  }
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  const adapter = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() });
  const composition = adapter.prepare(runtimeGraphToContractFromCanonicalDocument(document.project_id, document.timeline_id, document, 'p0'));
  const occurrence = composition.occurrences[0];
  const initial = { head: { revisionId: document.parent_revision.revision_id, publicationId: 'p0' }, canonicalDocument: document };
  const head = { projectId: document.project_id, timelineId: document.timeline_id,
    headRevisionId: initial.head.revisionId, headPublicationId: initial.head.publicationId };
  const scope = { realmId: 'realm', actorId: 'actor', projectId: document.project_id, timelineId: document.timeline_id };
  const send = vi.fn();
  const entry = { file: media.object_id, media_id: media.object_id, type: 'image/png',
    generationId: media.generation_id, variantId: media.variant_id };
  let releaseImport!: () => void;
  const importGate = new Promise<void>(resolve => { releaseImport = resolve; });
  const descriptor = { provider: 'runtime' as const, project: document.project_id,
    importOperationId: 'import-operation', assetId: media.asset, generationId: media.generation_id,
    variantId: media.variant_id, entry, mediaSelection: structuredClone(media) };
  const prepareMediaImport = vi.fn(async () => { if (delayed) await importGate; return descriptor; });
  const provider = { supportsDirectAssetUpload: true, prepareMediaImport,
    getProjectMediaSelection: vi.fn(async () => media), loadTimelineCommandBasis: vi.fn(async () => initial),
    getRecoverableIdentity: vi.fn(async () => scope), commitTimeline: send,
    resolveAssetUrl: vi.fn(async () => 'import.png') } as unknown as DataProvider;
  const outboxes = createCommitOutbox();
  let handoff: TimelinePersistenceHandoff;
  let mountedProvider = provider;
  let data;
  if (child) {
    const config = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }, {
      output: { resolution: '1920x1080', fps: 30, file: 'shot.mp4' }, tracks: [], clips: [], registry: {},
    }, { clampToOccurrenceDuration: false }).config;
    const popup = createShotTimelineDataProvider(config, composition, occurrence.occurrenceId, adapter, undefined,
      undefined, 0, provider, provider);
    cleanups.push(() => popup.dispose());
    const loaded = await popup.loadTimeline('mounted-shot');
    data = await buildTimelineData(loaded.config, await popup.loadAssetRegistry('mounted-shot'));
    handoff = resolveTimelinePersistenceHandoff(popup.bindLocalDocumentSave('mounted-shot'), popup, 'mounted-shot')!;
    mountedProvider = popup;
  } else {
    data = await buildTimelineData(empty ? { ...parentConfig, tracks: [], clips: [] } : { ...parentConfig, registry }, empty ? { assets: {} } : registry, undefined, 1, undefined, head);
    const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(document), outboxes, send,
      loadLatest: async () => initial, prepareDisplay: async () => { throw new Error('No ACK fixture'); }, changed: () => {} });
    cleanups.push(() => session.dispose());
    handoff = createTimelineLocalSaveHandoff({ initial, source: { config: data.config, registry: data.registry, head },
      session, adopted: () => { throw new Error('No ACK fixture'); } });
  }
  const eventBus = new TimelineEventBus();
  const failures: string[] = [];
  const captures: Promise<void>[] = [];
  eventBus.on('scheduleSave', (next, options) => {
    captures.push(handoff.capture({ config: next.config, registry: next.registry, head: next.head }, options?.gestureBasis)
      .catch(error => { failures.push(error.message); }));
  });
  const runtime = { provider: mountedProvider, toast: { error: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
  const wrapper = ({ children }: { children: React.ReactNode }) => <VideoEditorRuntimeProvider value={runtime}>{children}</VideoEditorRuntimeProvider>;
  const trackId = child ? 'V2' : 'V1';
  const timelineWrapper = globalThis.document.createElement('div');
  timelineWrapper.className = 'timeline-wrapper';
  const editArea = globalThis.document.createElement('div');
  editArea.className = 'timeline-canvas-edit-area';
  timelineWrapper.append(editArea);
  timelineWrapper.getBoundingClientRect = editArea.getBoundingClientRect = () => ({
    x: 0, y: 18, left: 0, top: 18, right: 1000, bottom: 126, width: 1000, height: 108, toJSON() {},
  });
  globalThis.document.body.append(timelineWrapper);
  cleanups.push(() => timelineWrapper.remove());
  const mounted = renderHook(() => {
    const commit = useTimelineCommit({ initialData: data, eventBus, lastSavedSignatureRef: { current: data.stableSignature } });
    const drag = useDragCoordinator({ dataRef: commit.dataRef, scale: 5, scaleWidth: 160, startLeft: 144, rowHeight: 36 });
    const assets = useAssetManagement({ dataRef: commit.dataRef, selectedTrackId: trackId, selectedProjectId: document.project_id,
      selectClip: vi.fn(), setSelectedTrackId: commit.setSelectedTrackId, applyEdit: commit.applyEdit,
      patchRegistry: commit.patchRegistry, invalidateAssetRegistry: vi.fn(), resolveAssetUrl: provider.resolveAssetUrl });
    const drop = useExternalDrop({ ...assets, dataRef: commit.dataRef, pendingOpsRef: commit.pendingOpsRef,
      selectedTrackId: trackId, scale: 5, scaleWidth: 160, applyEdit: commit.applyEdit, invalidateAssetRegistry: vi.fn(),
      resolveAssetUrl: provider.resolveAssetUrl, coordinator: drag.coordinator, finalVideoMap: new Map() });
    return { ...drop, commit, assets, coordinator: drag.coordinator, indicatorRef: drag.indicatorRef };
  }, { wrapper });
  mounted.result.current.coordinator.editAreaRef.current = editArea;
  cleanups.push(() => mounted.unmount());
  return { mounted, outboxes, scope, captures, failures, send, prepareMediaImport, document, handoff, descriptor, releaseImport,
    coordinator: mounted.result.current.coordinator, indicatorRef: mounted.result.current.indicatorRef };
}

function fileDropEvent(child = false) {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: child ? 368 : 384, clientY: child ? 54 : 30,
    currentTarget: { dataset: {} }, dataTransfer: { types: ['Files'], files: [new File(['image'], 'drop.png', { type: 'image/png' })],
      items: [], getData: () => '' } } as unknown as React.DragEvent<HTMLDivElement>;
}

it.each([false, true])('routes a mounted file drop into A2 (embedded: %s)', async child => {
  const env = await environment(child);
  const indicator = { show: vi.fn(), hide: vi.fn(), showSecondaryGhosts: vi.fn() };
  env.mounted.result.current.indicatorRef.current = indicator;
  const preview = env.coordinator.update({ clientX: child ? 368 : 384, clientY: child ? 54 : 30,
    sourceKind: 'visual', managedImage: true });
  expect(preview.trackId).toBe(child ? 'V2' : 'V1');
  expect(preview.time).toBe(child ? 9 : 5);
  expect(indicator.show).toHaveBeenCalledWith(expect.objectContaining({
    trackId: child ? 'V2' : 'V1',
    label: child ? 'V2 · 9.0s' : 'V1 · 5.0s',
    ghostLabel: child ? '9.0s' : '5.0s',
    lineLeft: preview.screenCoords.ghostCenter,
    ghostLeft: preview.screenCoords.clipLeft,
    ghostWidth: preview.screenCoords.clipWidth,
    ghostTop: preview.screenCoords.rowTop + 2,
    ghostHeight: Math.max(0, preview.screenCoords.rowHeight - 4),
  }));
  const resolvedDrop = env.coordinator.update({ clientX: child ? 368 : 384, clientY: child ? 54 : 30, sourceKind: null });
  expect(resolvedDrop.time).toBe(child ? 4.5 : 5);
  expect(resolvedDrop.pointerTrackId).toBe(child ? 'V2' : 'V1');
  expect(resolvedDrop.trackId).toBe(child ? undefined : 'V1');
  await act(async () => { await env.mounted.result.current.onTimelineDrop(fileDropEvent(child)); });
  await Promise.all(env.captures);
  expect(env.prepareMediaImport).toHaveBeenCalledOnce();
  expect(env.captures).toHaveLength(1);
  expect(env.failures).toEqual([]);
  const [record] = await env.outboxes.list(env.scope);
  expect(record.intents).toHaveLength(1);
  expect(record.intents[0].payload).toMatchObject({ commands: [{ op: child ? 'occurrence.add-media' : 'clip.add-media',
    select: child ? 'occurrence:occ-0' : 'parent', args: { media, row: { asset: media.asset } } }] });
  expect(JSON.stringify(record.intents[0].payload)).not.toContain('uploading-');
  expect(env.mounted.result.current.commit.dataRef.current!.rows.flatMap(row => row.actions)
    .some(action => action.id.startsWith('uploading-'))).toBe(false);
  expect(env.send).not.toHaveBeenCalled();
  env.send.mockRejectedValue(new ApiError(422, 'invalid', 'Fixture refusal', { status: 'invalid', code: 'fixture_invalid' }));
  await expect(env.handoff.flush()).rejects.toThrow();
  expect(env.send).toHaveBeenCalledOnce();
  const [request, key] = env.send.mock.calls[0];
  expect(key).toEqual(expect.any(String));
  expect(request).toMatchObject({ api_version: 1, project_id: env.scope.projectId, timeline_id: env.scope.timelineId,
    base_revision_id: 'r0', base_publication_id: 'p0', label: child ? 'Edit shot timeline' : 'Add media',
    merge: 'fields', dry_run: false, source: { via: 'app' },
    commands: [{ op: child ? 'occurrence.add-media' : 'clip.add-media', args: { media } }],
    steps: [{ command_ordinals: [0], patch: [] }] });
  expect(request.commands[0]?.args.row).toMatchObject({ at: preview.time, track: preview.trackId });
  const owner = child ? 'occurrence:occ-0' : 'parent';
  expect(request.commands).toEqual([{ schema_version: 1, op: child ? 'occurrence.add-media' : 'clip.add-media',
    version: '1', select: owner, intent: child ? { ownership: 'occurrence' } : {},
    args: { media, row: { id: 'clip-0', at: child ? 9 : 5, track: child ? 'V2' : 'V1', asset: media.asset,
      clipType: 'hold', hold: 5, opacity: 1 } }, created: [`${owner}/asset:${media.asset}`, `${owner}/clip:clip-0`] }]);
});

it.each(['scope', 'head', 'missing occurrence', 'wrong occurrence', 'ambiguous occurrence', 'missing track', 'duplicate track',
  'missing row', 'media', 'registry'] as const)('refuses a mounted import after a stale %s', async changed => {
  const env = await environment(true, true);
  await act(async () => { await env.mounted.result.current.onTimelineDrop(fileDropEvent()); });
  expect(env.prepareMediaImport).toHaveBeenCalledOnce();
  const current = env.mounted.result.current.commit.dataRef.current!;
  const next = structuredClone(current);
  const composition = next.config.app!.canonicalComposition as { occurrenceIds: string[] };
  if (changed === 'scope' || changed === 'head') next.head = { projectId: env.scope.projectId,
    timelineId: changed === 'scope' ? 'another-timeline' : env.scope.timelineId,
    headRevisionId: 'r0', headPublicationId: changed === 'head' ? 'p1' : 'p0' };
  if (changed === 'missing occurrence') delete next.config.app!.canonicalComposition;
  if (changed === 'wrong occurrence') composition.occurrenceIds = ['another-occurrence'];
  if (changed === 'ambiguous occurrence') composition.occurrenceIds.push('another-occurrence');
  if (changed === 'missing track') next.tracks = next.tracks.filter(track => track.id !== 'V2');
  if (changed === 'duplicate track') next.tracks.push({ ...next.tracks.find(track => track.id === 'V2')! });
  if (changed === 'missing row') next.rows = next.rows.filter(row => row.id !== 'V2');
  if (changed === 'media') env.descriptor.mediaSelection.variant_id = 'different-variant';
  if (changed === 'registry') next.registry.assets[media.asset] = { ...env.descriptor.entry, media_id: `sha256:${'e'.repeat(64)}` };
  act(() => env.mounted.result.current.commit.commitData(next, { save: false }));
  await act(async () => { env.releaseImport(); });
  await Promise.all(env.captures);
  expect(env.captures).toEqual([]);
  expect((await env.outboxes.list(env.scope))[0].intents).toEqual([]);
  expect(env.send).not.toHaveBeenCalled();
});

it.each([false, true])('retains an authored uploading-looking clip during drop cleanup (embedded: %s)', async child => {
  const env = await environment(child);
  const current = env.mounted.result.current.commit.dataRef.current!;
  const trackId = child ? 'V2' : 'V1';
  const id = 'uploading-authored';
  const next = { ...current, config: { ...current.config,
    clips: [...current.config.clips, { id, track: trackId, at: 10, hold: 1, clipType: 'hold' as const, asset: 'existing-image' }] },
    rows: current.rows.map(row => row.id === trackId ? { ...row,
      actions: [...row.actions, { id, start: 10, end: 11, effectId: `effect-${id}` }] } : row),
    meta: { ...current.meta, [id]: { asset: 'uploading:authored.png', track: trackId, clipType: 'hold' as const, hold: 1 } } };
  act(() => env.mounted.result.current.commit.commitData(next, { save: false }));
  const prepared = { assetKey: media.asset, mediaType: 'image' as const, durationSeconds: null, source: 'registered' as const,
    entry: env.descriptor.entry, mediaSelection: media };
  expect(env.mounted.result.current.assets.handleAssetDrop(media.asset, trackId, 10, false, false, prepared, id)).toBe(false);
  expect(env.mounted.result.current.commit.dataRef.current).toBe(next);
  expect(env.captures).toEqual([]);
  expect((await env.outboxes.list(env.scope))[0].intents).toEqual([]);
});

it('chains another mounted file drop behind the first local semantic command', async () => {
  const env = await environment(false);
  for (let index = 0; index < 2; index++) {
    await act(async () => { await env.mounted.result.current.onTimelineDrop(fileDropEvent()); });
    await Promise.all(env.captures);
  }
  expect(env.failures).toEqual([]);
  const [record] = await env.outboxes.list(env.scope);
  expect(record.intents).toHaveLength(2);
  expect(record.intents[1].basis).toEqual({ after: record.intents[0].id });
  expect(record.intents[0].payload).toMatchObject({ commands: [{ op: 'clip.add-media', args: { media } }] });
  expect(record.intents[1].payload).toMatchObject({ commands: [{ op: 'clip.add-media', args: { media } }] });
  expect(JSON.stringify(record.intents)).not.toContain('uploading-');
  expect(env.send).not.toHaveBeenCalled();
});

// Unlike the seeded parent/shot fixtures above, a new Runtime timeline has no
// authored tracks, clips, output defaults or assets collection.
it('commits the track and image from a real file drop onto a bootstrap empty head', async () => {
  const env = await environment(false, false, true);
  expect(env.document.parent_revision.payload).toEqual({ config: { clips: [], tracks: [] }, registry: {}, clips: [], occurrences: [] });
  await act(async () => { await env.mounted.result.current.onTimelineDrop(fileDropEvent()); });
  await Promise.all(env.captures);
  expect(env.prepareMediaImport).toHaveBeenCalledOnce();
  expect(env.failures).toEqual([]);
  const [record] = await env.outboxes.list(env.scope);
  expect(record.intents).toHaveLength(1);
  env.send.mockRejectedValue(new ApiError(422, 'invalid', 'Fixture refusal', { status: 'invalid', code: 'fixture_invalid' }));
  await expect(env.handoff.flush()).rejects.toThrow();
  expect(env.send).toHaveBeenCalledOnce();
  const [request] = env.send.mock.calls[0];
  expect(request).toMatchObject({ source: { via: 'app' }, commands: [
    { op: 'track.create', args: { row: { id: 'V1', kind: 'visual' } } },
    { op: 'clip.add-media', args: { row: { track: 'V1', asset: media.asset }, media } },
  ], steps: [{ command_ordinals: [0, 1] }] });
});
