// @vitest-environment jsdom
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';
import * as externalDropUtils from '@/tools/video-editor/lib/external-drop-utils.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import type { DataProvider } from '../data/DataProvider.ts';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox.ts';
import { createLocalSaveSession } from '../commands/localSaveSession.ts';
import { createTimelineLocalSaveHandoff } from './timelineLocalSaveHandoff.ts';
import { TimelineEventBus } from './useTimelineEventBus.ts';
import { useTimelineCommit } from './useTimelineCommit.ts';
import { useAssetManagement } from './useAssetManagement.ts';
import { useExternalDrop } from './useExternalDrop.ts';
import type { DragCoordinator } from './useDragCoordinator.ts';
import * as videoMetadata from '@/shared/lib/media/videoMetadata.ts';

afterEach(() => vi.restoreAllMocks());

it('routes a picked file batch through the file-drop recipe once and commits all placements together', async () => {
  const data = await buildTimelineData(createDefaultTimelineConfig(), { assets: {} });
  let nextAsset = 0;
  const prepareMediaImport = vi.fn(async (file: File) => {
    const index = nextAsset++;
    const assetId = `picked-asset-${index}`;
    return {
      provider: 'runtime',
      project: 'project-1',
      importOperationId: `picked-import-${index}`,
      generationId: `picked-generation-${index}`,
      variantId: `picked-variant-${index}`,
      assetId,
      entry: { file: `/media/${file.name}`, type: file.type, media_id: `sha256:${String(index).padStart(64, '0')}` },
    };
  });
  const provider = {
    supportsDirectAssetUpload: true,
    prepareMediaImport,
    resolveAssetUrl: vi.fn(async (url: string) => url),
  } as unknown as DataProvider;
  const runtime = { provider, toast: { error: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <VideoEditorRuntimeProvider value={runtime}>{children}</VideoEditorRuntimeProvider>
  );
  const eventBus = new TimelineEventBus();
  const scheduleSave = vi.fn();
  const localCommit = vi.fn();
  eventBus.on('scheduleSave', scheduleSave);
  eventBus.on('localCommit', localCommit);
  const fileDrop = vi.spyOn(externalDropUtils, 'handleFileDrop');
  const coordinator = {
    update: vi.fn(),
    showSecondaryGhosts: vi.fn(),
    end: vi.fn(),
    lastPosition: null,
    lastPlan: null,
    editAreaRef: { current: null },
  } as unknown as DragCoordinator;

  const mounted = renderHook(() => {
    const commit = useTimelineCommit({
      initialData: data,
      eventBus,
      lastSavedSignatureRef: { current: data.stableSignature },
    });
    const assets = useAssetManagement({
      dataRef: commit.dataRef,
      selectedTrackId: 'V1',
      selectedProjectId: 'project-1',
      selectClip: vi.fn(),
      setSelectedTrackId: commit.setSelectedTrackId,
      applyEdit: commit.applyEdit,
      patchRegistry: commit.patchRegistry,
      invalidateAssetRegistry: vi.fn(),
      resolveAssetUrl: provider.resolveAssetUrl,
    });
    const drop = useExternalDrop({
      ...assets,
      dataRef: commit.dataRef,
      pendingOpsRef: commit.pendingOpsRef,
      selectedTrackId: 'V1',
      scale: 5,
      scaleWidth: 160,
      applyEdit: commit.applyEdit,
      invalidateAssetRegistry: vi.fn(),
      resolveAssetUrl: provider.resolveAssetUrl,
      coordinator,
      finalVideoMap: new Map(),
    });
    return { ...drop, commit };
  }, { wrapper });

  const files = [
    new File(['one'], 'one.png', { type: 'image/png' }),
    new File(['two'], 'two.png', { type: 'image/png' }),
    new File(['three'], 'three.png', { type: 'image/png' }),
  ];
  await act(async () => { await mounted.result.current.addMediaFiles(files, 12); });

  expect(fileDrop).toHaveBeenCalledOnce();
  expect(fileDrop.mock.calls[0]?.[0].files).toEqual(files);
  expect(prepareMediaImport).toHaveBeenCalledTimes(3);
  expect(prepareMediaImport.mock.calls.map(([file]) => file.name)).toEqual(['one.png', 'two.png', 'three.png']);
  expect(localCommit).toHaveBeenCalledOnce();
  expect(scheduleSave).toHaveBeenCalledOnce();
  const clips = mounted.result.current.commit.dataRef.current!.config.clips;
  expect(clips).toHaveLength(3);
  expect(clips.map(clip => clip.asset)).toEqual(['picked-asset-0', 'picked-asset-1', 'picked-asset-2']);
  expect(clips.map(clip => clip.at)).toEqual([12, 17, 22]);
  mounted.unmount();
});

it('persists one picker batch as one Runtime append with ordered image and video placements', async () => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}) },
  });
  vi.spyOn(videoMetadata, 'extractVideoMetadata').mockResolvedValue({
    duration_seconds: 6,
    frame_rate: 30,
    total_frames: 180,
    width: 1920,
    height: 1080,
    file_size: 3,
  });

  const config = createDefaultTimelineConfig();
  const registry = { assets: {} };
  const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-1', timelineId: 'timeline-1' };
  const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
    { revision_id: 'r0', publication_id: 'p0' }, { projectId: scope.projectId, timelineId: scope.timelineId })
    .data.canonical_document;
  const parentPayload = { config: { ...config, registry }, clips: config.clips, registry, occurrences: [] };
  document.parent_revision.payload = parentPayload;
  document.parent_revision.content_digest = fixtureDigest(parentPayload);
  const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
  const data = await buildTimelineData({ ...config, registry }, registry, undefined, 1, undefined, head);
  const outboxes = createCommitOutbox();
  const session = await createLocalSaveSession({
    scope,
    initial,
    document: toOutboxJson(document),
    outboxes,
    send: vi.fn(),
    loadLatest: async () => initial,
    prepareDisplay: async () => { throw new Error('The batch test does not flush the local intent'); },
    changed: () => {},
  });

  let nextAsset = 0;
  const prepareMediaImport = vi.fn(async (file: File) => {
    const index = nextAsset++;
    const selection: MediaSelection = {
      asset: `picked-asset-${index}`,
      generation_id: `picked-generation-${index}`,
      variant_id: `picked-variant-${index}`,
      object_id: `sha256:${String.fromCharCode(97 + index).repeat(64)}`,
      catalog_digest: `sha256:${String.fromCharCode(100 + index).repeat(64)}`,
    };
    return {
      provider: 'runtime',
      project: scope.projectId,
      importOperationId: `picked-import-${index}`,
      generationId: selection.generation_id,
      variantId: selection.variant_id,
      assetId: selection.asset,
      entry: {
        file: `/media/${file.name}`,
        type: file.type,
        media_id: selection.object_id,
        content_sha256: selection.object_id,
        generationId: selection.generation_id,
        variantId: selection.variant_id,
      },
      mediaSelection: selection,
    };
  });
  const provider = {
    supportsDirectAssetUpload: true,
    prepareMediaImport,
    resolveAssetUrl: vi.fn(async (url: string) => url),
  } as unknown as DataProvider;
  const runtime = { provider, toast: { error: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <VideoEditorRuntimeProvider value={runtime}>{children}</VideoEditorRuntimeProvider>
  );
  const eventBus = new TimelineEventBus();
  const captures: Promise<void>[] = [];
  const failures: unknown[] = [];
  const handoff = createTimelineLocalSaveHandoff({
    initial,
    source: { config: data.config, registry: data.registry, head },
    session,
    adopted: () => { throw new Error('The batch test only captures its first append'); },
  });
  eventBus.on('scheduleSave', (next, options) => {
    captures.push(handoff.capture({ config: next.config, registry: next.registry, head: next.head }, options?.gestureBasis)
      .catch(error => { failures.push(error); }));
  });
  const coordinator = {
    update: vi.fn(), showSecondaryGhosts: vi.fn(), end: vi.fn(), lastPosition: null, lastPlan: null,
    editAreaRef: { current: null },
  } as unknown as DragCoordinator;
  const mounted = renderHook(() => {
    const commit = useTimelineCommit({ initialData: data, eventBus,
      lastSavedSignatureRef: { current: data.stableSignature } });
    const assets = useAssetManagement({ dataRef: commit.dataRef, selectedTrackId: 'V1', selectedProjectId: scope.projectId,
      selectClip: vi.fn(), setSelectedTrackId: commit.setSelectedTrackId, applyEdit: commit.applyEdit,
      patchRegistry: commit.patchRegistry, invalidateAssetRegistry: vi.fn(), resolveAssetUrl: provider.resolveAssetUrl });
    const drop = useExternalDrop({ ...assets, dataRef: commit.dataRef, pendingOpsRef: commit.pendingOpsRef,
      selectedTrackId: 'V1', scale: 5, scaleWidth: 160, applyEdit: commit.applyEdit,
      invalidateAssetRegistry: vi.fn(), resolveAssetUrl: provider.resolveAssetUrl, coordinator, finalVideoMap: new Map() });
    return { ...drop, commit };
  }, { wrapper });

  const files = [
    new File(['one'], 'one.png', { type: 'image/png' }),
    new File(['two'], 'two.png', { type: 'image/png' }),
    new File(['three'], 'three.mp4', { type: 'video/mp4' }),
  ];
  await act(async () => { await mounted.result.current.addMediaFiles(files, 12); });
  await Promise.all(captures);

  expect(failures).toEqual([]);
  expect(captures).toHaveLength(1);
  const [record] = await outboxes.list(scope);
  expect(record.intents).toHaveLength(1);
  const commands = (record.intents[0].payload as { commands: Array<{ op: string; args: { media: MediaSelection; row: { at: number; asset: string } } }> }).commands;
  expect(commands.map(command => command.op)).toEqual(['clip.add-media', 'clip.add-media', 'clip.add-media']);
  expect(commands.map(command => command.args.media.asset)).toEqual(['picked-asset-0', 'picked-asset-1', 'picked-asset-2']);
  expect(commands.map(command => command.args.row)).toEqual([
    expect.objectContaining({ at: 12, asset: 'picked-asset-0' }),
    expect.objectContaining({ at: 17, asset: 'picked-asset-1' }),
    expect.objectContaining({ at: 22, asset: 'picked-asset-2' }),
  ]);
  expect(commands[0]?.args.media).toEqual({
    asset: 'picked-asset-0', generation_id: 'picked-generation-0', variant_id: 'picked-variant-0',
    object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'d'.repeat(64)}`,
  });
  expect(commands[2]?.args.media).toEqual({
    asset: 'picked-asset-2', generation_id: 'picked-generation-2', variant_id: 'picked-variant-2',
    object_id: `sha256:${'c'.repeat(64)}`, catalog_digest: `sha256:${'f'.repeat(64)}`,
  });

  mounted.unmount();
  await session.dispose();
});
