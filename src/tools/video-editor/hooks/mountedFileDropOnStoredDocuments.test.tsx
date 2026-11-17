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
import { withDefaultTimelineOutput } from '../lib/defaults.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
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


// A drop onto a stored timeline that already has content (anonymised long-lived corpus documents with several
// tracks, clips on later tracks and several shots) must place the file, or name the gate that refused it.
interface StoredDocument { config: Record<string, unknown>; clips?: Array<Record<string, unknown>>; registry: AssetRegistry; occurrences: Array<Record<string, unknown>> }
const corpus = Object.entries(import.meta.glob('./__fixtures__/corpus/*.json', { eager: true, import: 'default' }) as Record<string, StoredDocument>)
  .map(([path, document]) => ({ name: path.split('/').pop()!, stored: document }));

async function environment(stored: StoredDocument) {
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { children: false }).data.canonical_document;
  document.parent_revision.payload = structuredClone(stored) as never;
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  for (const [index, occurrence] of stored.occurrences.entries()) {
    const internalId = `internal-${index}`;
    const internalPayload = { tracks: [{ id: 'v1', kind: 'visual', label: 'Track' }], clips: [] };
    const shotPayload = { name: 'Shot', internal_timeline_revision_id: internalId, timing: { duration_ms: 1000 }, assets: [] };
    const shot = { shot_id: occurrence.shot_id as string, revision_id: occurrence.shot_revision_id as string, internal_timeline_revision_id: internalId,
      content_digest: fixtureDigest(shotPayload), payload: shotPayload };
    const internal = { timeline_id: `internal-timeline-${index}`, revision_id: internalId, content_digest: fixtureDigest(internalPayload), payload: internalPayload };
    document.shot_revisions.push(shot as never);
    document.internal_timeline_revisions.push(internal as never);
    document.dependency_manifest.shots.push({ shot_id: shot.shot_id, revision_id: shot.revision_id, internal_timeline_revision_id: internalId, content_digest: shot.content_digest });
    document.dependency_manifest.internal_timelines.push({ timeline_id: internal.timeline_id, revision_id: internalId, content_digest: internal.content_digest });
  }
  const initial = { head: { revisionId: document.parent_revision.revision_id, publicationId: 'p0' }, canonicalDocument: document };
  const head = { projectId: document.project_id, timelineId: document.timeline_id, headRevisionId: initial.head.revisionId, headPublicationId: 'p0' };
  const scope = { realmId: 'realm', actorId: 'actor', projectId: document.project_id, timelineId: document.timeline_id };
  const send = vi.fn();
  const entry = { file: media.object_id, media_id: media.object_id, type: 'image/png', generationId: media.generation_id, variantId: media.variant_id };
  const descriptor = { provider: 'runtime' as const, project: document.project_id, importOperationId: 'import-operation', assetId: media.asset,
    generationId: media.generation_id, variantId: media.variant_id, entry, mediaSelection: structuredClone(media) };
  const prepareMediaImport = vi.fn(async () => descriptor);
  const provider = { supportsDirectAssetUpload: true, prepareMediaImport, getProjectMediaSelection: vi.fn(async () => media),
    loadTimelineCommandBasis: vi.fn(async () => initial), getRecoverableIdentity: vi.fn(async () => scope), commitTimeline: send,
    resolveAssetUrl: vi.fn(async () => 'import.png') } as unknown as DataProvider;
  const config = { ...structuredClone(stored.config), ...(stored.config.clips ? {} : { clips: structuredClone(stored.clips) }) };
  const data = await buildTimelineData({ ...config, ...withDefaultTimelineOutput(config as never) } as TimelineConfig, structuredClone(stored.registry), undefined, 1, undefined, head);
  const outboxes = createCommitOutbox();
  const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(document), outboxes, send,
    loadLatest: async () => initial, prepareDisplay: async () => { throw new Error('No ACK fixture'); }, changed: () => {} });
  cleanups.push(() => session.dispose());
  const handoff = createTimelineLocalSaveHandoff({ initial, source: { config: data.config, registry: data.registry, head },
    session, adopted: () => { throw new Error('No ACK fixture'); } });
  const eventBus = new TimelineEventBus();
  const failures: string[] = [];
  const captures: Promise<void>[] = [];
  eventBus.on('scheduleSave', (next, options) => {
    captures.push(handoff.capture({ config: next.config, registry: next.registry, head: next.head }, options?.gestureBasis)
      .catch(error => { failures.push(error.message); }));
  });
  const toast = vi.fn();
  const runtime = { provider, toast: { error: toast } } as unknown as VideoEditorRuntimeContextValue;
  const wrapper = ({ children }: { children: React.ReactNode }) => <VideoEditorRuntimeProvider value={runtime}>{children}</VideoEditorRuntimeProvider>;
  const trackId = (data.tracks.find(track => track.kind === 'visual') ?? data.tracks[0]).id;
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
  return { mounted, toast, captures, failures, outboxes, scope, prepareMediaImport, data };
}

function fileDropEvent() {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 384, clientY: 30, currentTarget: { dataset: {} },
    dataTransfer: { types: ['Files'], files: [new File(['image'], 'drop.png', { type: 'image/png' })], items: [], getData: () => '' } } as unknown as React.DragEvent<HTMLDivElement>;
}

// The placement pre-checks in useAssetManagement (single-shot identity, head, registry, placeholder) belong to the shot
// pop-up, whose data carries `canonicalComposition` for exactly one occurrence. A parent timeline with many shots has
// none, so none of them may decline its drop; the drop reaches the save handoff, which owns the outcome (see
// timelineLocalSaveHandoff.corpus.test.ts for every document x gesture x track).
it.each(corpus)('no pre-check declines a file dropped onto the stored timeline $name', async ({ stored }) => {
  const env = await environment(stored);
  expect(stored.occurrences.length).toBeGreaterThan(1);
  expect(env.data.config.app?.canonicalComposition).toBeUndefined();
  expect(env.data.config.clips.some(clip => clip.app?.canonical)).toBe(false);
  await act(async () => { await env.mounted.result.current.onTimelineDrop(fileDropEvent()); });
  await Promise.all(env.captures);
  expect(env.prepareMediaImport).toHaveBeenCalledOnce();
  expect(env.toast.mock.calls).toEqual([]);
  expect(env.captures).toHaveLength(1);
});
