import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import fixture from '@/tools/video-editor/data/shotComposition.fixture.json';
import { createShotCompositionAdapter } from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import { VisualSeamAdmissionError } from '@/tools/video-editor/data/visualSeamContract.ts';
import { projectCanonicalComposition } from '@/tools/video-editor/data/shotCompositionProjection.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { useTimelineQueries } from '@/tools/video-editor/hooks/useTimelineQueries.ts';
import { timelineQueryKey } from '@/tools/video-editor/hooks/useTimeline.ts';
import { useTimelineHistory } from '@/tools/video-editor/hooks/useTimelineHistory.ts';
import { createInteractionState } from '@/tools/video-editor/lib/interaction-state.ts';
import { buildTimelineData, configToRows, type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { getConfigSignature, getStableConfigSignature } from '@/tools/video-editor/lib/config-utils.ts';
import type { ResolvedTimelineConfig, TimelineConfig } from '@/tools/video-editor/types/index.ts';
import { boundCanonicalClipToOccurrence } from '@/tools/video-editor/lib/canonicalRenderBounds.ts';
import {
  clearTimelineDraft,
  loadTimelineDraft,
  saveTimelineDraft,
} from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';
import { normalizeAndPresentError } from '@/shared/lib/errorHandling/runtimeError.ts';
import { boundShotTimelinePreviewConfig, ShotTimelinePreview } from './ShotTimelinePreview.tsx';
import {
  createShotTimelineDataProvider,
  createShotTimelineEditorSessionToken,
  shotTimelineRecoveryId,
  shotTimelineDurationSeconds,
  shotTimelineSessionId,
} from './shotTimelineDataProvider.ts';

vi.stubGlobal('indexedDB', createFakeIndexedDB());

function authoredRecoveryClips(config: TimelineConfig, occurrenceId: string): TimelineConfig['clips'] {
  const prefix = `${occurrenceId}:`;
  const trackPrefix = `${occurrenceId}~`;
  return config.clips.map((clip) => {
    const { assetEntry: _assetEntry, app: _app, ...withoutAssetEntry } = clip as typeof clip & { assetEntry?: unknown };
    const app = clip.app ? { ...clip.app } : undefined;
    for (const key of ['group', 'canonical', 'canonicalTiming', 'canonicalEffects']) {
      if (app) Reflect.deleteProperty(app, key);
    }
    return {
      ...withoutAssetEntry,
      id: clip.id.startsWith(prefix) ? clip.id.slice(prefix.length) : clip.id,
      track: clip.track.startsWith(trackPrefix) ? clip.track.slice(trackPrefix.length) : clip.track,
      ...(app && Object.keys(app).length > 0 ? { app } : {}),
    };
  });
}

function setAlphaStartWithAuthoredPause(graph: typeof fixture, atMs: number): void {
  const revision = graph.shot_revisions.find((candidate) => candidate.shot_id === 'shot-alpha' && candidate.revision_id === 'rev-a')!;
  const clip = revision.internal_timeline_revision.timeline.clips[0]!;
  clip.at_ms = atMs;
  const gaps = graph.parent_composition.config.app.visualSeamContract.gaps;
  const pauses = gaps.filter((gap) => gap.kind === 'pause' && gap.track === 'video');
  const deltaFrames = Math.round(atMs * 30 / 1000);
  pauses[0]!.startFrame = 60 + deltaFrames;
  pauses[0]!.endFrame = 120 + deltaFrames;
  pauses[1]!.startFrame = 180 + deltaFrames;
  pauses[1]!.endFrame = 240;
}

// Spy on the shared presenter while keeping its real behavior.
vi.mock('@/shared/lib/errorHandling/runtimeError.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/errorHandling/runtimeError.ts')>();
  return { ...actual, normalizeAndPresentError: vi.fn(actual.normalizeAndPresentError) };
});

// The mounted editors below stand in for the real editor's save path, which
// never leaves a provider save un-awaited. Their un-awaited gesture handlers
// must route a refused publication through the shared presenter instead of
// leaking it as an unhandled rejection.
function presentEditorSaveFailure(error: unknown): void {
  normalizeAndPresentError(error, { context: 'shot-timeline-preview:test-editor-save' });
}
const popupChrome = vi.hoisted(() => ({
  saveStatus: 'saved' as 'saved' | 'saving' | 'dirty' | 'retrying' | 'error',
  isConflictExhausted: false,
  recoveryDraft: null as { updatedAt: string; baseVersion: number } | null,
  reloadFromServer: vi.fn(),
  retrySaveAfterConflict: vi.fn(),
  retryRecoveredDraft: vi.fn(),
  discardRecoveredDraft: vi.fn(),
  timelineLoadGate: null as Promise<void> | null,
  onTimelineLoadStarted: vi.fn(),
}));
const previewProps = vi.hoisted(() => ({
  currentTime: undefined as number | undefined,
  previewRevision: undefined as unknown,
  config: undefined as ResolvedTimelineConfig | undefined,
}));

vi.mock('@/tools/video-editor/hooks/timelineStore.ts', async () => {
  const ReactModule = await import('react');
  const context = ReactModule.createContext<Record<string, unknown>>({});
  return {
    __shotTimelineTestContext: context,
    useTimelinePlaybackContext: () => ReactModule.useContext(context),
    useTimelineEditorData: () => ReactModule.useContext(context),
    useTimelineEditorOps: () => ({
      selectClip: vi.fn(),
      setSelectedTrackId: vi.fn(),
      applyEdit: vi.fn(),
      patchRegistry: vi.fn(),
    }),
    useTimelineChromeContext: () => popupChrome,
  };
});

vi.mock('@/tools/video-editor/hooks/useAssetManagement.ts', () => ({
  useAssetManagement: () => ({
    prepareGenerationAsset: vi.fn(),
    uploadImageGeneration: vi.fn(),
    uploadVideoGeneration: vi.fn(),
  }),
}));

vi.mock('@/tools/video-editor/hooks/useTimelineCommandsService.ts', () => ({
  useTimelineCommandsService: () => ({ addClip: vi.fn() }),
}));

vi.mock('@/tools/video-editor/contexts/VideoEditorProvider.tsx', async () => {
  const ReactModule = await import('react');
  const store = await import('@/tools/video-editor/hooks/timelineStore.ts') as unknown as {
    __shotTimelineTestContext: React.Context<Record<string, unknown>>;
  };
  function VideoEditorProvider({ children, dataProvider, timelineId, timelineEditability }: {
    children: React.ReactNode;
    dataProvider: {
      readonly timelineQueryIdentity: string;
      loadTimeline: (id: string) => Promise<{ config: { clips: Array<{ id: string; at: number; hold?: number }>; app?: unknown }; configVersion: number }>;
      saveTimeline: (id: string, config: { clips: Array<{ id: string; at: number; hold?: number }>; app?: unknown }, version: number) => Promise<unknown>;
    };
    timelineId: string;
    timelineEditability: {
      check: (input: { clipId: string; sourceTrackId: string | null; targetTrackId: string | null }) => { allowed: boolean };
    };
  }) {
    const [undoCount, setUndoCount] = ReactModule.useState(0);
    const [loaded, setLoaded] = ReactModule.useState<{
      config: { clips: Array<{ id: string; at: number; hold?: number }>; app?: unknown };
      configVersion: number;
    } | null>(null);
    const queryIdentity = dataProvider.timelineQueryIdentity;
    ReactModule.useEffect(() => {
      let active = true;
      void (async () => {
        popupChrome.onTimelineLoadStarted(queryIdentity);
        if (popupChrome.timelineLoadGate) await popupChrome.timelineLoadGate;
        const next = await dataProvider.loadTimeline(timelineId);
        if (active) setLoaded(next);
      })();
      return () => { active = false; };
    }, [dataProvider, timelineId, queryIdentity]);
    const value = ReactModule.useMemo(() => ({
      previewRef: { current: null },
      playerContainerRef: { current: null },
      currentTime: 0,
      onPreviewTimeUpdate: () => undefined,
      resolvedConfig: loaded?.config ?? null,
      dataRef: { current: null },
      selectedTrackId: null,
      selectedClipIds: new Set<string>(),
      undo: () => setUndoCount((count) => count + 1),
    }), [loaded, undoCount]);
    return ReactModule.createElement(store.__shotTimelineTestContext.Provider, { value },
      children,
      ReactModule.createElement('output', { 'data-testid': 'undo-count' }, undoCount),
      ReactModule.createElement('output', { 'data-testid': 'loaded-geometry' }, loaded?.config.clips.map((clip) => `${clip.at}:${clip.hold ?? ''}`).join('|') ?? 'loading'),
      ReactModule.createElement('button', {
        type: 'button',
        disabled: !loaded || !timelineEditability.check({
          clipId: loaded.config.clips[0]?.id ?? '',
          sourceTrackId: 'V1',
          targetTrackId: 'V1',
        }).allowed,
        onClick: () => loaded && void dataProvider.saveTimeline(timelineId, {
          ...loaded.config,
          clips: loaded.config.clips.map((clip) => ({ ...clip, hold: (clip.hold ?? 0) + 0.1 })),
        }, loaded.configVersion).catch(presentEditorSaveFailure),
      }, 'Edit and publish visible timeline'));
  }
  return { VideoEditorProvider };
});

vi.mock('@/tools/video-editor/components/PreviewPanel/RemotionPreview.tsx', () => ({
  RemotionPreview: (props: {currentTime?: number; previewRevision?: unknown; config: ResolvedTimelineConfig}) => {
    previewProps.currentTime = props.currentTime;
    previewProps.previewRevision = props.previewRevision;
    previewProps.config = props.config;
    return React.createElement('div', { 'data-testid': 'preview' });
  },
}));

vi.mock('@/tools/video-editor/components/TimelineEditor/TimelineEditorCore.tsx', async () => {
  const ReactModule = await import('react');
  const store = await import('@/tools/video-editor/hooks/timelineStore.ts') as unknown as {
    __shotTimelineTestContext: React.Context<Record<string, unknown>>;
  };
  return {
    TimelineEditorCore: () => {
      const context = ReactModule.useContext(store.__shotTimelineTestContext);
      return ReactModule.createElement('button', { onClick: context.undo as () => void }, 'Undo');
    },
  };
});

vi.mock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx')>();
  return {
    ...actual,
    useVideoEditorRuntime: () => ({
      provider: { resolveAssetUrl: async (file: string) => file },
      assetResolver: { resolveAssetUrl: async (file: string) => file },
      project: { projectId: 'popup-test-project', projectSlug: 'popup-test-project' },
      timelineId: 'popup-test-timeline',
      timelineEditability: undefined,
    }),
    useOptionalVideoEditorRuntime: () => null,
  };
});

describe('shot timeline popup persistence', () => {
  beforeEach(async () => {
    resetFakeIndexedDB();
    // A save that is still in flight when the previous test ends can write its
    // recovery draft into the fresh store; clear the stable key so no test
    // inherits another test's unsaved draft.
    await clearTimelineDraft(shotTimelineRecoveryId('document-primary', 'occ-1'));
    popupChrome.isConflictExhausted = false;
    popupChrome.saveStatus = 'saved';
    popupChrome.recoveryDraft = null;
    popupChrome.timelineLoadGate = null;
    vi.clearAllMocks();
    previewProps.currentTime = undefined;
    previewProps.previewRevision = undefined;
    previewProps.config = undefined;
    popupChrome.reloadFromServer.mockResolvedValue(undefined);
  });

  it('does not pass current-time mirroring into the imperative preview seek path', async () => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);

    render(React.createElement(ShotTimelinePreview, { composition, occurrenceId: 'occ-1' }));

    await waitFor(() => expect(screen.getByTestId('preview')).toBeTruthy());
    expect(previewProps.currentTime).toBeUndefined();
  });

  it('passes film effects and child Source visuals to the mounted preview after loading authored data', async () => {
    const graph = structuredClone(fixture);
    const timeline = graph.shot_revisions.find((shot) => shot.shot_id === 'shot-alpha' && shot.revision_id === 'rev-a')!
      .internal_timeline_revision.timeline;
    const localEffects = [{ type: 'blur', params: { radius: 2 } }];
    const shotEffects = [{ type: 'brightness', params: { amount: 0.5 } }];
    Object.assign(timeline, { effects: shotEffects });
    Object.assign(timeline.tracks[0], { role: 'source' });
    Object.assign(timeline.clips[0], { effects: localEffects });
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(graph);
    render(React.createElement(ShotTimelinePreview, { composition, occurrenceId: 'occ-1' }));
    await waitFor(() => expect(previewProps.config?.clips.some((clip) => clip.id === 'alpha-video')).toBe(true));
    expect(previewProps.config?.clips.find((clip) => clip.id === 'alpha-video')?.effects).toEqual([...localEffects, ...shotEffects]);
    expect(previewProps.config?.tracks.find((track) => track.id === 'video')?.role).toBe('output');
    expect(timeline.clips[0]).toMatchObject({ effects: localEffects });
    expect(timeline.tracks[0]).toMatchObject({ role: 'source' });
  });

  it('labels the embedded preview from the authoritative canonical head', async () => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);

    render(React.createElement(ShotTimelinePreview, { composition, occurrenceId: 'occ-1' }));

    await waitFor(() => expect(screen.getByTestId('preview')).toBeTruthy());
    expect(previewProps.previewRevision).toEqual({
      kind: 'committed',
      revisionId: composition.headRevisionId,
    });
  });

  it.each([
    ['saving', false],
    ['dirty', false],
    ['retrying', false],
    ['error', false],
    ['saved', true],
  ] as const)('keeps the embedded preview honest while the mounted save is %s', async (status, committed) => {
    popupChrome.saveStatus = status === 'saved' ? 'saved' : status;
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);

    render(React.createElement(ShotTimelinePreview, { composition, occurrenceId: 'occ-1' }));

    await waitFor(() => expect(screen.getByTestId('preview')).toBeTruthy());
    expect(previewProps.previewRevision).toEqual(committed
      ? { kind: 'committed', revisionId: composition.headRevisionId }
      : { kind: 'local', baseRevisionId: composition.headRevisionId });
  });

  it('keeps a conflicted embedded preview local instead of claiming the canonical head', async () => {
    popupChrome.isConflictExhausted = true;
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);

    render(React.createElement(ShotTimelinePreview, { composition, occurrenceId: 'occ-1' }));

    await waitFor(() => expect(screen.getByTestId('preview')).toBeTruthy());
    expect(previewProps.previewRevision).toEqual({
      kind: 'local',
      baseRevisionId: composition.headRevisionId,
    });
  });

  it('renders recovery controls in the mounted popup surface', async () => {
    popupChrome.recoveryDraft = { updatedAt: '2026-09-23T00:00:00.000Z', baseVersion: 4 };
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);

    render(React.createElement(ShotTimelinePreview, { composition, occurrenceId: 'occ-1' }));

    await waitFor(() => expect(document.querySelector('[data-shot-timeline-recovery="true"]')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(popupChrome.retryRecoveredDraft).toHaveBeenCalled();
    expect(popupChrome.discardRecoveredDraft).toHaveBeenCalled();
    expect(popupChrome.reloadFromServer).toHaveBeenCalled();
  });

  it('resolves canonical managed popup media to its browser content URL', async () => {
    const graph = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    const managedObjectId = `sha256:${'0e8c1e8c5c205762a720bd4182c3ae96d2b4f36cc5ccbf13db1a0c80ab4314c5'}`;
    const alphaRevision = graph.shot_revisions.find((revision) => (
      revision.shot_id === 'shot-alpha' && revision.revision_id === 'rev-a'
    ))!;
    alphaRevision.assets[0]!.object_id = managedObjectId;
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(graph);
    const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-1')!;
    const popupConfig = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }).config;
    const provider = createShotTimelineDataProvider(popupConfig, composition, occurrence.occurrenceId);
    const popupTimeline = await buildTimelineData(
      popupConfig,
      { assets: popupConfig.registry },
      provider.resolveAssetUrl,
    );

    expect(popupConfig.clips.find((clip) => clip.asset === 'alpha-image')?.assetEntry?.src)
      .toBe(`/api/astrid/v1/objects/${encodeURIComponent(managedObjectId)}`);
    expect(popupTimeline.resolvedConfig.clips.find((clip) => clip.asset === 'alpha-image')?.assetEntry?.src)
      .toBe(`/api/astrid/v1/objects/${encodeURIComponent(managedObjectId)}`);
    await expect(provider.resolveAssetUrl(managedObjectId)).resolves.toBe(
      `/api/astrid/v1/objects/${encodeURIComponent(managedObjectId)}`,
    );
    await expect(provider.resolveAssetUrl('https://cdn.example/legacy.mp4')).resolves.toBe(
      'https://cdn.example/legacy.mp4',
    );
    const urlFallbackProvider = createShotTimelineDataProvider({
      ...popupConfig,
      registry: {
        ...popupConfig.registry,
        'legacy-url-fallback': {
          ...Object.values(popupConfig.registry)[0]!,
          file: 'legacy-url-fallback',
          url: 'https://cdn.example/registry-fallback.mp4',
          src: '',
        },
      },
    }, composition, occurrence.occurrenceId);
    await expect(urlFallbackProvider.resolveAssetUrl('legacy-url-fallback')).resolves.toBe(
      'https://cdn.example/registry-fallback.mp4',
    );
    const unregisteredManagedObjectId = `sha256:${'1'.repeat(64)}`;
    await expect(provider.resolveAssetUrl(unregisteredManagedObjectId)).resolves.toBe(
      `/api/astrid/v1/objects/${encodeURIComponent(unregisteredManagedObjectId)}`,
    );
    await expect(provider.resolveAssetUrl('/api/astrid/v1/objects/already-resolved'))
      .resolves.toBe('/api/astrid/v1/objects/already-resolved');
  });

  it('keeps the parent Runtime media seam on the nested popup provider', async () => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-1')!;
    const popupConfig = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }).config;
    const prepareMediaImport = vi.fn().mockResolvedValue({} as never);
    const mediaProvider = {
      supportsDirectAssetUpload: true,
      prepareMediaImport,
      getProjectMediaSelection: vi.fn(),
      getProjectVerifiedMedia: vi.fn(),
    };

    const provider = createShotTimelineDataProvider(
      popupConfig,
      composition,
      occurrence.occurrenceId,
      undefined,
      undefined,
      undefined,
      0,
      mediaProvider,
    );
    const file = new File(['popup'], 'popup.png', { type: 'image/png' });

    expect(provider.supportsDirectAssetUpload).toBe(true);
    await provider.prepareMediaImport?.(file);
    expect(prepareMediaImport).toHaveBeenCalledWith(file);
    expect(provider.getProjectMediaSelection).toBeDefined();
    expect(provider.getProjectVerifiedMedia).toBeDefined();
  });

  it('keeps the mounted editor and undo history across its own publication acknowledgement', async () => {
    const adapter = createShotCompositionAdapter({ load: vi.fn().mockResolvedValue(fixture), publish: vi.fn() });
    const composition = adapter.prepare(fixture);
    const acknowledgedContract = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    acknowledgedContract.primary_timeline.head.revision_id = 'head-after-own-publication';
    const acknowledged = adapter.prepare(acknowledgedContract);
    const props = { composition, occurrenceId: 'occ-1', shotCompositionAdapter: adapter };
    const { rerender } = render(React.createElement(ShotTimelinePreview, props));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('undo-count')).toHaveTextContent('1');
    rerender(React.createElement(ShotTimelinePreview, { ...props, composition: acknowledged }));

    await waitFor(() => expect(screen.getByTestId('undo-count')).toHaveTextContent('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('undo-count')).toHaveTextContent('2');
  });

  it('fetches the latest canonical head on popup open and hydrates the stable recovery record', async () => {
    await clearTimelineDraft(shotTimelineRecoveryId('document-primary', 'occ-1'));
    const latestContract = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    latestContract.primary_timeline.head.revision_id = 'head-latest-on-open';
    setAlphaStartWithAuthoredPause(latestContract, 500);
    const port = { load: vi.fn().mockResolvedValue(latestContract), publish: vi.fn() };
    const adapter = createShotCompositionAdapter(port);
    const composition = adapter.prepare(fixture);
    const { unmount } = render(React.createElement(ShotTimelinePreview, {
      composition,
      occurrenceId: 'occ-1',
      shotCompositionAdapter: adapter,
    }));

    await waitFor(() => expect(port.load).toHaveBeenCalledWith({
      projectId: 'project-001', parentDocumentId: 'document-primary',
    }));
    await waitFor(() => expect(screen.getByTestId('loaded-geometry')).toHaveTextContent('0.5:2'));
    unmount();
  });

  it('presents a refused publication once, keeps its recovery candidate, and leaks no unhandled rejection', async () => {
    const recoveryKey = shotTimelineRecoveryId('document-primary', 'occ-1');
    const latestContract = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    latestContract.primary_timeline.head.revision_id = 'head-refused-publication';
    latestContract.shot_revisions.find((revision) => revision.shot_id === 'shot-alpha' && revision.revision_id === 'rev-a')!
      .internal_timeline_revision.timeline.clips[0]!.at_ms = 700;
    const publish = vi.fn(async (request) => request.graph);
    const adapter = createShotCompositionAdapter({ load: vi.fn().mockResolvedValue(latestContract), publish });
    render(React.createElement(ShotTimelinePreview, {
      composition: adapter.prepare(fixture),
      occurrenceId: 'occ-1',
      shotCompositionAdapter: adapter,
    }));
    await waitFor(() => expect(screen.getByTestId('loaded-geometry')).toHaveTextContent('0.7:2'));

    fireEvent.click(screen.getByRole('button', { name: 'Edit and publish visible timeline' }));

    await waitFor(() => expect(normalizeAndPresentError).toHaveBeenCalledTimes(1));
    expect(vi.mocked(normalizeAndPresentError).mock.calls[0]![0]).toBeInstanceOf(VisualSeamAdmissionError);
    expect(vi.mocked(normalizeAndPresentError).mock.calls[0]![1]).toMatchObject({
      context: 'shot-timeline-preview:test-editor-save',
    });
    // The refusal happens before the port is called, so nothing was published,
    // and the exact candidate stays in the durable recovery draft for retry.
    expect(publish).not.toHaveBeenCalled();
    const recovery = await loadTimelineDraft(recoveryKey);
    expect(recovery?.draft.canonicalPublication).toMatchObject({
      expectedHeadRevisionId: 'head-refused-publication',
    });
    // Give any stray rejection a turn to surface; Vitest fails the run on one.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(normalizeAndPresentError).toHaveBeenCalledTimes(1);
  });

  it('keeps the clean mounted editor on the freshly loaded head when stale props arrive', async () => {
    const latestContract = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    latestContract.primary_timeline.head.revision_id = 'head-visible-current';
    setAlphaStartWithAuthoredPause(latestContract, 700);
    const publish = vi.fn(async (request) => request.graph);
    const adapter = createShotCompositionAdapter({
      load: vi.fn().mockResolvedValue(latestContract),
      publish,
    });
    const props = {
      composition: adapter.prepare(fixture),
      occurrenceId: 'occ-1',
      shotCompositionAdapter: adapter,
    };
    const { rerender } = render(React.createElement(ShotTimelinePreview, props));
    await waitFor(() => expect(screen.getByTestId('loaded-geometry')).toHaveTextContent('0.7:2'));

    rerender(React.createElement(ShotTimelinePreview, props));
    await waitFor(() => expect(screen.getByTestId('loaded-geometry')).toHaveTextContent('0.7:2'));
    expect(screen.getByRole('region', { name: 'Shot timeline' })).toHaveAttribute(
      'data-shot-timeline-head-revision-id',
      'head-visible-current',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit and publish visible timeline' }));
    await waitFor(() => expect(publish).toHaveBeenCalled());
    const publishedComposition = adapter.prepare(publish.mock.calls[0]![0].graph);
    const publishedOccurrence = publishedComposition.occurrences.find((item) => item.occurrenceId === 'occ-1')!;
    const publishedProjection = projectCanonicalComposition(
      { ...publishedComposition, occurrences: [publishedOccurrence] },
    ).config;
    expect(publishedProjection.clips[0]?.at).toBeCloseTo(0.7, 5);
  });

  it('pauses popup editing while H1 is canonical but its mounted editor query is still showing H0', async () => {
    await clearTimelineDraft(shotTimelineRecoveryId('document-primary', 'occ-1'));
    const graphH0 = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    graphH0.primary_timeline.head.revision_id = 'head-held-h0';
    setAlphaStartWithAuthoredPause(graphH0, 200);
    const graphH1 = JSON.parse(JSON.stringify(graphH0)) as typeof fixture;
    graphH1.primary_timeline.head.revision_id = 'head-held-h1';
    setAlphaStartWithAuthoredPause(graphH1, 900);
    const publish = vi.fn(async (request) => request.graph);
    const adapter = createShotCompositionAdapter({
      load: vi.fn().mockResolvedValueOnce(graphH0).mockResolvedValue(graphH1),
      publish,
    });
    const compositionH0 = adapter.prepare(graphH0);
    const compositionH1 = adapter.prepare(graphH1);
    let releaseQuery: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const props = { composition: compositionH0, occurrenceId: 'occ-1', shotCompositionAdapter: adapter };
    const view = render(React.createElement(ShotTimelinePreview, props));
    await waitFor(() => expect(screen.getByTestId('loaded-geometry')).toHaveTextContent('0.2:2'));

    popupChrome.timelineLoadGate = gate;
    popupChrome.onTimelineLoadStarted.mockClear();
    view.rerender(React.createElement(ShotTimelinePreview, { ...props, composition: compositionH1 }));
    await waitFor(() => expect(popupChrome.onTimelineLoadStarted).toHaveBeenCalledWith(compositionH1.headRevisionId));
    expect(await screen.findByText('Updating canonical shot; editing is paused.')).toBeTruthy();
    const editButton = screen.getByRole('button', { name: 'Edit and publish visible timeline' });
    expect(editButton).toBeDisabled();
    fireEvent.click(editButton);
    expect(publish).not.toHaveBeenCalled();

    await act(async () => { releaseQuery(); });
    await waitFor(() => expect(screen.getByTestId('loaded-geometry')).toHaveTextContent('0.9:2'));
    // The production editor checks this permission dynamically at the gesture
    // boundary. Rerender the test double so its disabled button reflects the
    // updated shared head ref, as real store consumers do.
    view.rerender(React.createElement(ShotTimelinePreview, { ...props, composition: compositionH1 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit and publish visible timeline' })).toBeEnabled());
    expect(screen.queryByText('Updating canonical shot; editing is paused.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit and publish visible timeline' }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]![0].expectedHeadRevisionId).toBe(compositionH1.headRevisionId);
    view.unmount();
    popupChrome.timelineLoadGate = null;
    await clearTimelineDraft(shotTimelineRecoveryId('document-primary', 'occ-1'));
  });

  it('adopts H1 through the real query/provider path, then publishes the immediate edit against H1 without remounting', async () => {
    await clearTimelineDraft(shotTimelineRecoveryId('document-primary', 'occ-1'));
    const graphH0 = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    graphH0.primary_timeline.head.revision_id = 'head-query-h0';
    setAlphaStartWithAuthoredPause(graphH0, 200);
    const graphH1 = JSON.parse(JSON.stringify(graphH0)) as typeof fixture;
    graphH1.primary_timeline.head.revision_id = 'head-query-h1';
    setAlphaStartWithAuthoredPause(graphH1, 900);
    const publish = vi.fn();
    const adapter = createShotCompositionAdapter({
      load: vi.fn().mockResolvedValue(graphH1),
      publish: async (request) => {
        publish(request);
        return request.graph;
      },
    });
    const compositionH0 = adapter.prepare(graphH0);
    const compositionH1 = adapter.prepare(graphH1);
    const occurrenceH0 = compositionH0.occurrences.find((item) => item.occurrenceId === 'occ-1')!;
    const configH0 = projectCanonicalComposition({ ...compositionH0, occurrences: [occurrenceH0] }).config!;
    const provider = createShotTimelineDataProvider(configH0, compositionH0, 'occ-1', adapter);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } },
    });
    const timelineId = shotTimelineSessionId('document-primary', 'occ-1', 'stable-editor-session');

    function MountedEditor({ nextComposition }: { nextComposition: typeof compositionH0 }) {
      const [session] = React.useState(() => `mounted-${Math.random()}`);
      const [adoptedHead, setAdoptedHead] = React.useState(compositionH0.headRevisionId);
      const query = useTimelineQueries(provider, timelineId, provider.resolveAssetUrl).timelineQuery;
      const nextOccurrence = nextComposition.occurrences.find((item) => item.occurrenceId === 'occ-1')!;
      const nextConfig = projectCanonicalComposition({ ...nextComposition, occurrences: [nextOccurrence] }).config!;
      React.useEffect(() => {
        if (nextComposition.headRevisionId !== adoptedHead
          && provider.adoptCleanBaseline(nextConfig, nextComposition)) {
          setAdoptedHead(nextComposition.headRevisionId);
        }
      }, [adoptedHead, nextComposition, nextConfig]);
      const clips = query.data?.config.clips ?? [];
      return React.createElement(React.Fragment, null,
        React.createElement('output', { 'data-testid': 'query-head' }, adoptedHead),
        React.createElement('output', { 'data-testid': 'query-geometry' }, clips.map((clip) => clip.at).join('|')),
        React.createElement('output', { 'data-testid': 'editor-session' }, session),
        React.createElement('button', {
          type: 'button',
          disabled: !query.data,
          onClick: () => {
            const config = query.data!.config;
            void provider.saveTimeline(timelineId, {
              ...config,
              clips: config.clips.map((clip) => ({ ...clip, hold: (clip.hold ?? 0) + 0.25 })),
            }, query.data!.configVersion).catch(presentEditorSaveFailure);
          },
        }, 'Edit immediately'));
    }

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(QueryClientProvider, { client: queryClient }, children)
    );
    const view = render(React.createElement(MountedEditor, { nextComposition: compositionH0 }), { wrapper });
    await waitFor(() => expect(screen.getByTestId('query-geometry')).toHaveTextContent('0.2'));
    const originalSession = screen.getByTestId('editor-session').textContent;
    expect(queryClient.getQueryData([
      ...timelineQueryKey(timelineId), compositionH0.headRevisionId,
    ])).toBeTruthy();

    view.rerender(React.createElement(MountedEditor, { nextComposition: compositionH1 }));
    await waitFor(() => expect(screen.getByTestId('query-head')).toHaveTextContent(compositionH1.headRevisionId));
    await waitFor(() => expect(screen.getByTestId('query-geometry')).toHaveTextContent('0.9'));
    expect(screen.getByTestId('editor-session').textContent).toBe(originalSession);
    fireEvent.click(screen.getByRole('button', { name: 'Edit immediately' }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const request = publish.mock.calls[0]![0];
    expect(request.expectedHeadRevisionId).toBe(compositionH1.headRevisionId);
    const published = adapter.prepare(request.graph);
    const publishedOccurrence = published.occurrences.find((item) => item.occurrenceId === 'occ-1')!;
    const publishedProjection = projectCanonicalComposition({
      ...published,
      occurrences: [publishedOccurrence],
    }).config;
    expect(publishedProjection.clips[0]?.at).toBeCloseTo(0.9, 5);
    expect(publishedProjection.clips[0]?.hold).toBeCloseTo(2.25, 5);
    view.unmount();
    await clearTimelineDraft(shotTimelineRecoveryId('document-primary', 'occ-1'));
  });

  it('uses real editor history for edit, acknowledged save, undo, remount, and canonical reopen', async () => {
    const base = createShotCompositionAdapter({ load: vi.fn().mockResolvedValue(fixture), publish: vi.fn() }).prepare(fixture);
    const original = projectCanonicalComposition({ ...base, occurrences: [base.occurrences[0]!] }).config;
    const published: import('@/tools/video-editor/data/shotCompositionAdapter.ts').PreparedShotComposition[] = [];
    const adapter = createShotCompositionAdapter({
      load: vi.fn().mockResolvedValue(fixture),
      publish: vi.fn(async (request) => request.graph),
    });
    const provider = createShotTimelineDataProvider(original, base, 'occ-1', adapter, (next) => published.push(next));
    const toData = (config: TimelineConfig): TimelineData => {
      const registry = { assets: original.registry };
      const resolvedConfig = { ...config, registry } as typeof original;
      const rowData = configToRows(config);
      return {
        config,
        configVersion: 1,
        registry,
        resolvedConfig,
        rows: rowData.rows,
        meta: rowData.meta,
        effects: rowData.effects,
        assetMap: {},
        output: config.output,
        tracks: config.tracks ?? [],
        clipOrder: rowData.clipOrder,
        signature: getConfigSignature(resolvedConfig),
        stableSignature: getStableConfigSignature(config, registry),
      };
    };
    const timelineId = 'real-history-session';
    const dataRef = { current: toData(original) };
    let pendingSave: Promise<number> | null = null;
    const commitData = (next: TimelineData, options?: { save?: boolean }) => {
      dataRef.current = next;
      if (options?.save) pendingSave = provider.saveTimeline(timelineId, next.config, 1);
    };
    const runtimeValue = {
      provider,
      project: { projectId: base.projectId },
      timelineId,
      userId: null,
    } as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(
      VideoEditorRuntimeProvider, { value: runtimeValue }, children,
    );
    const hook = renderHook(() => useTimelineHistory({
      dataRef,
      commitData,
      interactionStateRef: { current: createInteractionState() },
      pendingOpsRef: { current: 0 },
    }), { wrapper });
    const edited = {
      ...original,
      clips: original.clips.map((clip, index) => index === 0 ? { ...clip, at: 0.5 } : clip),
    };
    act(() => {
      hook.result.current.onBeforeCommit(dataRef.current, { semantic: true });
      dataRef.current = toData(edited);
    });
    await act(async () => { await provider.saveTimeline(timelineId, edited, 1); });
    expect(published).toHaveLength(1);
    expect(published[0]?.occurrences.find((entry) => entry.occurrenceId === 'occ-1')?.revisionId)
      .not.toBe(base.occurrences[0]?.revisionId);

    act(() => hook.result.current.undo());
    expect(dataRef.current?.config.clips[0]?.at).toBe(0);
    await act(async () => { await pendingSave; });
    hook.unmount();

    const canonicalAfterUndo = published.at(-1)!;
    const reopenedConfig = projectCanonicalComposition({
      ...canonicalAfterUndo,
      occurrences: [canonicalAfterUndo.occurrences.find((entry) => entry.occurrenceId === 'occ-1')!],
    }).config;
    const reopened = createShotTimelineDataProvider(reopenedConfig, canonicalAfterUndo, 'occ-1', adapter);
    const loaded = await reopened.loadTimeline('new-popup-session');
    expect(loaded.config.clips.map(({ at, hold }) => ({ at, hold }))).toEqual(
      reopenedConfig.clips.map(({ at, hold }) => ({ at, hold })),
    );
    expect(canonicalAfterUndo.headRevisionId).toBe(published.at(-1)?.headRevisionId);
  });

  it('publishes against the mounted canonical head and surfaces a CAS conflict', async () => {
    const port = {
      load: vi.fn(),
      publish: vi.fn().mockRejectedValue(Object.assign(new Error('head moved'), { status: 409 })),
    };
    const adapter = createShotCompositionAdapter(port);
    const composition = adapter.prepare(fixture);
    const localComposition = { ...composition, occurrences: [composition.occurrences[0]!] };
    const config = projectCanonicalComposition(localComposition).config;
    const provider = createShotTimelineDataProvider(config, composition, 'occ-1', adapter);

    await expect(provider.saveTimeline('shot:occ-1', config)).rejects.toMatchObject({
      code: 'stale_write',
      status: 409,
    });
    expect(port.publish).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadRevisionId: composition.headRevisionId,
    }));
  });
  it('adopts a clean external head and publishes the refreshed authoritative graph', async () => {
    await clearTimelineDraft(shotTimelineRecoveryId('document-primary', 'occ-1'));
    const nextContract = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    nextContract.primary_timeline.head.revision_id = 'head-external';
    const port = {
      load: vi.fn(),
      publish: vi.fn().mockResolvedValue(nextContract),
    };
    const adapter = createShotCompositionAdapter(port);
    const composition = adapter.prepare(fixture);
    const nextComposition = adapter.prepare(nextContract);
    const config = projectCanonicalComposition({ ...composition, occurrences: [composition.occurrences[0]!] }).config;
    const nextConfig = {
      ...config,
      clips: config.clips.map((clip) => ({ ...clip, hold: 3 })),
    };
    const provider = createShotTimelineDataProvider(config, composition, 'occ-1', adapter);
    expect(provider.adoptCleanBaseline(nextConfig, nextComposition)).toBe(true);

    const loaded = await provider.loadTimeline('shot');
    expect(loaded.config).toMatchObject({
      output: nextConfig.output,
      tracks: [{ id: 'video' }, { id: 'audio' }],
      clips: [{ id: 'alpha-video', hold: 2 }, { id: 'alpha-audio', hold: 2 }],
    });
    await provider.saveTimeline('shot', nextConfig);

    expect(port.publish).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadRevisionId: 'head-external',
    }));
  });

  it('does not adopt a new parent head over a dirty popup draft', async () => {
    const nextContract = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    nextContract.primary_timeline.head.revision_id = 'head-external';
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() });
    const composition = adapter.prepare(fixture);
    const nextComposition = adapter.prepare(nextContract);
    const config = projectCanonicalComposition({ ...composition, occurrences: [composition.occurrences[0]!] }).config;
    const nextConfig = {
      ...config,
      clips: config.clips.map((clip) => ({ ...clip, to: 2, duration: 2 })),
    };
    const provider = createShotTimelineDataProvider(config, composition, 'occ-1', adapter);
    const baseline = structuredClone((await provider.loadTimeline('shot')).config);
    provider.setDraftState(true);

    expect(provider.adoptCleanBaseline(nextConfig, nextComposition)).toBe(false);
    const loaded = await provider.loadTimeline('shot');
    expect(baseline.clips).toMatchObject([
      { id: 'alpha-video', hold: 2 },
      { id: 'alpha-audio', hold: 2 },
    ]);
    for (const clip of baseline.clips) {
      expect(clip).not.toHaveProperty('to');
      expect(clip).not.toHaveProperty('duration');
    }
    expect(loaded.config).toStrictEqual(baseline);
  });

  it.each(['shot-local', 'projected'])('round-trips %s child clips without projection IDs or groups', async (source) => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const publish = vi.fn(async (request) => request.graph);
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish });
    const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-4')!;
    const projected = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }).config;
    const provider = createShotTimelineDataProvider(projected, composition, 'occ-4', adapter);

    const loaded = await provider.loadTimeline('shot-round-trip');
    expect(loaded.config.clips.map((clip) => clip.id)).toEqual(['beta-video']);
    expect(loaded.config.tracks?.map((track) => track.id)).toEqual(['video', 'audio']);
    const edited = {
      ...loaded.config,
      tracks: source === 'projected' ? projected.tracks : loaded.config.tracks,
      clips: (source === 'projected' ? projected.clips : loaded.config.clips).map((clip) => ({
        ...clip,
        at: source === 'projected' ? clip.at - occurrence.atMs / 1000 : clip.at,
        label: 'Edited child clip',
        hold: 1.5,
        app: {
          ...clip.app,
          authoredClipMetadata: { preserve: [null, false, 7] },
          ...(source === 'projected' ? { group: { id: 'occ-4', sourceTrack: 'video' } } : {}),
        },
      })),
    };

    await provider.saveTimeline('shot-round-trip', edited, loaded.configVersion);
    const saved = publish.mock.calls[0]![0].graph;
    const publishedOccurrence = saved.occurrences.find((item) => item.occurrence_id === 'occ-4')!;
    const savedRevision = saved.shot_revisions.find((item) => (
      item.shot_id === publishedOccurrence.shot_id && item.revision_id === publishedOccurrence.revision_id
    ))!;
    const savedTimeline = savedRevision.internal_timeline_revision.timeline;
    expect(savedTimeline.clips.map((clip) => clip.id)).toEqual(['beta-video']);
    expect(savedTimeline.clips.find((clip) => clip.id === 'beta-video')).toMatchObject({
      id: 'beta-video', label: 'Edited child clip', hold: 1.5,
    });
    expect(savedTimeline.tracks.every((track) => !track.id.includes('~'))).toBe(true);
    expect(savedTimeline.clips.every((clip) => !clip.id.includes('occ-4:'))).toBe(true);
    expect(savedTimeline.tracks.every((track) => !track.app?.group)).toBe(true);
    expect(savedTimeline.clips.every((clip) => !clip.track.includes('~'))).toBe(true);
    expect(savedTimeline.clips.every((clip) => !Object.hasOwn(clip.app ?? {}, 'group'))).toBe(true);
    expect(savedTimeline.clips[0].app).toMatchObject({ authoredClipMetadata: { preserve: [null, false, 7] } });
    expect(edited.clips[0].track).toBe(source === 'projected' ? 'occ-4~video' : 'video');
    expect(Object.hasOwn(edited.clips[0].app, 'group')).toBe(source === 'projected');

    const savedComposition = adapter.prepare(saved);
    const savedOccurrence = savedComposition.occurrences.find((item) => item.occurrenceId === 'occ-4')!;
    const reopened = createShotTimelineDataProvider(
      projectCanonicalComposition({ ...savedComposition, occurrences: [savedOccurrence] }).config,
      savedComposition,
      'occ-4',
      adapter,
    );
    const reloaded = await reopened.loadTimeline('shot-round-trip-reload');
    expect(reloaded.config.clips.find((clip) => clip.id === 'beta-video')).toMatchObject({
      id: 'beta-video', label: 'Edited child clip', hold: 1.5,
    });
  });

  it('saves one gallery clip from the loaded shot-local config with authored IDs and tracks', async () => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const publish = vi.fn(async (request: { graph: typeof fixture }) => request.graph);
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish });
    const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-4')!;
    const projected = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }).config;
    const provider = createShotTimelineDataProvider(projected, composition, 'occ-4', adapter);

    const loaded = await provider.loadTimeline('shot-gallery-save');
    expect(loaded.config.app).toMatchObject({ canonicalComposition: { occurrenceIds: ['occ-4'] } });
    expect(loaded.config.clips.map((clip) => clip.id)).toEqual(['beta-video']);
    expect(loaded.config.tracks?.map((track) => track.id)).toEqual(['video', 'audio']);

    const nextConfig = {
      ...loaded.config,
      clips: [...loaded.config.clips, {
        id: 'gallery-drop-clip',
        track: 'video',
        clipType: 'media',
        at: 1.2,
        hold: 0.5,
        asset: 'gallery-image',
      }],
    };
    await provider.saveTimeline('shot-gallery-save', nextConfig, loaded.configVersion);

    expect(publish).toHaveBeenCalledTimes(1);
    const saved = publish.mock.calls[0]![0].graph;
    const savedOccurrence = saved.occurrences.find((item) => item.occurrence_id === 'occ-4')!;
    const savedRevision = saved.shot_revisions.find((item) => (
      item.shot_id === savedOccurrence.shot_id && item.revision_id === savedOccurrence.revision_id
    ))!;
    const savedTimeline = savedRevision.internal_timeline_revision.timeline;
    expect(savedTimeline.clips).toHaveLength(2);
    expect(savedTimeline.clips.find((clip) => clip.id === 'gallery-drop-clip')).toMatchObject({
      id: 'gallery-drop-clip', track: 'video', asset: 'gallery-image',
    });
    expect(savedTimeline.tracks.map((track) => track.id)).toEqual(['video', 'audio']);
    expect(savedTimeline.clips.every((clip) => !clip.app?.group)).toBe(true);
    expect(savedTimeline.tracks.every((track) => !track.app?.group)).toBe(true);
  });

  it('persists a gallery clip on a bare authored new track', async () => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const publish = vi.fn(async (request: { graph: typeof fixture }) => request.graph);
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish });
    const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-4')!;
    const projected = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }).config;
    const provider = createShotTimelineDataProvider(projected, composition, 'occ-4', adapter);
    const loaded = await provider.loadTimeline('shot-gallery-new-track');
    const nextConfig = {
      ...loaded.config,
      tracks: [...(loaded.config.tracks ?? []), { id: 'overlay', kind: 'visual' as const, label: 'Overlay' }],
      clips: [...loaded.config.clips, {
        id: 'gallery-new-track-clip',
        track: 'overlay',
        clipType: 'media',
        at: 1.2,
        hold: 0.5,
        asset: 'gallery-image',
      }],
    };

    await provider.saveTimeline('shot-gallery-new-track', nextConfig, loaded.configVersion);

    expect(publish).toHaveBeenCalledTimes(1);
    const saved = publish.mock.calls[0]![0].graph;
    const savedOccurrence = saved.occurrences.find((item) => item.occurrence_id === 'occ-4')!;
    const savedRevision = saved.shot_revisions.find((item) => (
      item.shot_id === savedOccurrence.shot_id && item.revision_id === savedOccurrence.revision_id
    ))!;
    const savedTimeline = savedRevision.internal_timeline_revision.timeline;
    expect(savedTimeline.clips.filter((clip) => clip.id === 'gallery-new-track-clip')).toHaveLength(1);
    expect(savedTimeline.clips.find((clip) => clip.id === 'gallery-new-track-clip')).toMatchObject({ track: 'overlay' });
    expect(savedTimeline.tracks.map((track) => track.id)).toEqual(['video', 'audio', 'overlay']);
    expect(savedTimeline.clips.every((clip) => !clip.app?.group)).toBe(true);
    expect(savedTimeline.tracks.every((track) => !track.app?.group)).toBe(true);
  });

  it('forks a shared shot for one gallery clip while leaving the other occurrence unchanged', async () => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const publish = vi.fn(async (request: { graph: typeof fixture }) => request.graph);
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish });
    const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-1')!;
    const sibling = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-2')!;
    const projected = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }).config;
    const provider = createShotTimelineDataProvider(projected, composition, 'occ-1', adapter);
    const loaded = await provider.loadTimeline('shot-gallery-shared');
    expect(loaded.config.app).toMatchObject({ canonicalComposition: { occurrenceIds: ['occ-1'] } });

    const nextConfig = {
      ...loaded.config,
      clips: [...loaded.config.clips, {
        id: 'gallery-shared-clip',
        track: 'video',
        clipType: 'media',
        at: 2,
        hold: 0.5,
        asset: 'gallery-image',
      }],
    };
    await provider.saveTimeline('shot-gallery-shared', nextConfig, loaded.configVersion);

    expect(publish).toHaveBeenCalledTimes(1);
    const saved = publish.mock.calls[0]![0].graph;
    const savedOccurrence = saved.occurrences.find((item) => item.occurrence_id === 'occ-1')!;
    const savedSibling = saved.occurrences.find((item) => item.occurrence_id === 'occ-2')!;
    expect(savedOccurrence.shot_id).not.toBe(occurrence.shotId);
    expect(savedOccurrence.revision_id).not.toBe(occurrence.revisionId);
    expect(savedSibling.shot_id).toBe(sibling.shotId);
    expect(savedSibling.revision_id).toBe(sibling.revisionId);

    const forkRevision = saved.shot_revisions.find((item) => (
      item.shot_id === savedOccurrence.shot_id && item.revision_id === savedOccurrence.revision_id
    ))!;
    const forkTimeline = forkRevision.internal_timeline_revision.timeline;
    expect(forkTimeline.clips).toHaveLength(3);
    expect(forkTimeline.clips.filter((clip) => String(clip.id).endsWith(':gallery-shared-clip'))).toHaveLength(1);
    expect(forkTimeline.clips.find((clip) => String(clip.id).endsWith(':gallery-shared-clip'))).toMatchObject({ track: 'video', asset: 'gallery-image' });
    expect(forkTimeline.clips.every((clip) => !clip.app?.group)).toBe(true);
    expect(forkTimeline.tracks.every((track) => !track.app?.group)).toBe(true);

    const originalSiblingRevision = fixture.shot_revisions.find((item) => (
      item.shot_id === sibling.shotId && item.revision_id === sibling.revisionId
    ))!;
    const persistedSiblingRevision = saved.shot_revisions.find((item) => (
      item.shot_id === savedSibling.shot_id && item.revision_id === savedSibling.revision_id
    ))!;
    expect(persistedSiblingRevision.internal_timeline_revision.timeline).toEqual(
      originalSiblingRevision.internal_timeline_revision.timeline,
    );
  });

  it.each([
    { source: 'shot-local', authoredMetadata: true },
    { source: 'projected', authoredMetadata: true },
    { source: 'shot-local', authoredMetadata: false },
    { source: 'projected', authoredMetadata: false },
  ])('sanitizes $source clips (authored metadata: $authoredMetadata) in durable recovery and retry bytes', async ({ source, authoredMetadata }) => {
    resetFakeIndexedDB();
    const graph = structuredClone(fixture);
    const childTimeline = graph.shot_revisions.find((revision) => revision.shot_id === 'shot-alpha' && revision.revision_id === 'rev-a')!
      .internal_timeline_revision.timeline;
    if (!authoredMetadata) {
      for (const clip of childTimeline.clips) Reflect.deleteProperty(clip, 'app');
    }
    const childTrack = childTimeline.tracks.find((track) => track.id === 'video') as Record<string, unknown>;
    childTrack.app = { authoredTrackMetadata: { preserve: [null, false, 7] } };
    childTrack.opaqueTrackMetadata = { preserve: { nested: true } };
    const baseAdapter = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() });
    const composition = baseAdapter.prepare(graph);
    const projected = projectCanonicalComposition({
      ...composition,
      occurrences: [composition.occurrences.find((occurrence) => occurrence.occurrenceId === 'occ-1')!],
    }).config;
    const publish = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('keep recovery draft'), { status: 503 }))
      .mockImplementation(async (request) => request.graph);
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish });
    const provider = createShotTimelineDataProvider(projected, composition, 'occ-1', adapter);
    const loaded = await provider.loadTimeline('shot-recovery');
    const clipApp = {
      group: { id: 'occ-1', sourceTrack: 'video' },
      canonical: { occurrenceId: 'occ-1' },
      canonicalTiming: { occurrenceStartMs: 0, occurrenceDurationMs: 2000 },
      canonicalEffects: { inherited: true },
      ...(authoredMetadata ? { authoredClipMetadata: { preserve: [null, false, 7] } } : {}),
    };
    const edited = {
      ...loaded.config,
      tracks: projected.tracks,
      clips: [
        ...(source === 'projected' ? projected.clips : loaded.config.clips).map((clip) => ({
          ...clip, track: clip.track === 'audio' ? 'audio' : 'occ-1~video', hold: 1.5,
          app: { ...clipApp, ...clip.app },
        })),
        {
          id: 'new-child-clip', track: 'occ-1~video', at: 1.5, hold: 0.5, clipType: 'text',
          text: { content: 'New child' },
          app: { ...clipApp },
        },
      ],
    };
    const originalEdited = structuredClone(edited);

    await expect(provider.saveTimeline('shot-recovery', edited, 1)).rejects.toThrow('keep recovery draft');

    const recoveryKey = shotTimelineRecoveryId('document-primary', 'occ-1');
    const recovery = await loadTimelineDraft(recoveryKey);
    expect(recovery).not.toBeNull();
    const recoveryGraph = recovery!.draft.canonicalPublication!.graph as unknown as typeof fixture;
    const recoveryOccurrence = recoveryGraph.occurrences.find((occurrence) => occurrence.occurrence_id === 'occ-1')!;
    const recoveryTimeline = recoveryGraph.shot_revisions
      .find((revision) => revision.shot_id === recoveryOccurrence.shot_id
        && revision.revision_id === recoveryOccurrence.revision_id)!
      .internal_timeline_revision.timeline;
    expect(recoveryTimeline.tracks.map((track) => track.id)).toEqual(['video', 'audio']);
    expect(recoveryTimeline.tracks.every((track) => !track.app?.group)).toBe(true);
    expect(recoveryTimeline.tracks.find((track) => track.id === 'video')).toMatchObject({
      app: { authoredTrackMetadata: { preserve: [null, false, 7] } },
      opaqueTrackMetadata: { preserve: { nested: true } },
    });
    expect(recoveryTimeline.clips.find((clip) => clip.track === 'video')).toMatchObject({
      hold: 1.5,
    });
    expect(recoveryTimeline.clips.map((clip) => clip.id)).toEqual(
      ['alpha-video', 'alpha-audio', 'new-child-clip'].map((id) => `${recoveryOccurrence.shot_id}:${id}`),
    );

    const recoveryConfig = recovery!.draft.config as TimelineConfig;
    expect(recoveryConfig.tracks?.map((track) => track.id)).toEqual(['video', 'audio']);
    expect(recoveryConfig.clips.map((clip) => clip.id)).toEqual(['alpha-video', 'alpha-audio', 'new-child-clip']);
    expect(recoveryConfig.tracks?.every((track) => !track.app?.group)).toBe(true);
    expect(recoveryConfig.clips.find((clip) => clip.track === 'video')).toMatchObject({
      hold: 1.5,
    });

    const reopened = createShotTimelineDataProvider(projected, composition, 'occ-1', adapter);
    const reloaded = await reopened.loadTimeline('shot-recovery-reload');
    expect(reloaded.config.tracks?.map((track) => track.id)).toEqual(['video', 'audio']);
    expect(reloaded.config.clips.map((clip) => clip.id)).toEqual(['alpha-video', 'alpha-audio', 'new-child-clip']);
    expect(reloaded.config.tracks?.every((track) => !track.app?.group)).toBe(true);
    expect(reloaded.config.clips.find((clip) => clip.track === 'video')).toMatchObject({
      hold: 1.5,
    });

    await expect(reopened.saveTimeline('shot-recovery-reload', reloaded.config, reloaded.configVersion)).resolves.toBe(2);
    const retryGraph = publish.mock.calls[1]![0].graph as unknown as typeof fixture;
    const retryOccurrence = retryGraph.occurrences.find((occurrence) => occurrence.occurrence_id === 'occ-1')!;
    const retryTimeline = retryGraph.shot_revisions
      .find((revision) => revision.shot_id === retryOccurrence.shot_id
        && revision.revision_id === retryOccurrence.revision_id)!
      .internal_timeline_revision.timeline;
    expect(retryTimeline.tracks.map((track) => track.id)).toEqual(['video', 'audio']);
    expect(retryTimeline.tracks.every((track) => !track.app?.group)).toBe(true);
    expect(retryTimeline.clips.find((clip) => clip.track === 'video')).toMatchObject({
      hold: 1.5,
    });
    expect(retryTimeline.clips.map((clip) => clip.id)).toEqual(recoveryTimeline.clips.map((clip) => clip.id));
    for (const timeline of [recoveryTimeline, recoveryConfig, reloaded.config, retryTimeline]) {
      expect(timeline.clips.map((clip) => clip.track)).toEqual(['video', 'audio', 'video']);
      expect(timeline.clips.every((clip) => !clip.id.startsWith('occ-1:'))).toBe(true);
      expect(timeline.clips.every((clip) => !clip.track.includes('~'))).toBe(true);
      expect(timeline.clips.every((clip) => !Object.hasOwn(clip.app ?? {}, 'group'))).toBe(true);
      expect(timeline.clips.every((clip) => !Object.hasOwn(clip.app ?? {}, 'canonical'))).toBe(true);
      expect(timeline.clips.every((clip) => !Object.hasOwn(clip.app ?? {}, 'canonicalTiming'))).toBe(true);
      expect(timeline.clips.every((clip) => !Object.hasOwn(clip.app ?? {}, 'canonicalEffects'))).toBe(true);
      for (const clip of timeline.clips) {
        if (authoredMetadata) {
          expect(clip.app).toMatchObject({ authoredClipMetadata: { preserve: [null, false, 7] } });
        } else {
          expect(clip).not.toHaveProperty('app');
        }
      }
    }
    expect(edited).toStrictEqual(originalEdited);
    expect(edited.clips.map((clip) => clip.track)).toEqual(['occ-1~video', 'audio', 'occ-1~video']);
    expect(edited.clips.every((clip) => clip.app.group)).toBe(true);

    await clearTimelineDraft(recoveryKey);
  });


  it('separates per-open editor cache identity from stable occurrence recovery identity', () => {
    const token = createShotTimelineEditorSessionToken();
    const first = shotTimelineSessionId('document-primary', 'occ-1', token);
    const afterPublish = shotTimelineSessionId('document-primary', 'occ-1', token);
    const reopened = shotTimelineSessionId('document-primary', 'occ-1', createShotTimelineEditorSessionToken());
    const otherShot = shotTimelineSessionId('document-primary', 'occ-2', token);

    expect(afterPublish).toBe(first);
    expect(reopened).not.toBe(first);
    expect(otherShot).not.toBe(first);
    expect(shotTimelineRecoveryId('document-primary', 'occ-1'))
      .toBe(shotTimelineRecoveryId('document-primary', 'occ-1'));
    expect(shotTimelineRecoveryId('document-primary', 'occ-2'))
      .not.toBe(shotTimelineRecoveryId('document-primary', 'occ-1'));
  });

  it('restores raw opaque app collisions in publication and the real rejected-publication draft', async () => {
    resetFakeIndexedDB();
    const graph = structuredClone(fixture);
    const raw = graph.shot_revisions.find((item) => item.shot_id === 'shot-alpha' && item.revision_id === 'rev-a')!
        .internal_timeline_revision.timeline.clips[0] as Record<string, unknown>;
    const app = JSON.parse('{"canonical":null,"canonicalTiming":{"storedOccurrenceDurationMs":null,"__proto__":[false,null]},"ordered":[0,false,null]}');
    raw.app = app;
    const composition = createShotCompositionAdapter({ load: vi.fn() }).prepare(graph);
    const config = projectCanonicalComposition({ ...composition, occurrences: [composition.occurrences[0]] }).config;
    const publish = vi.fn().mockRejectedValue(Object.assign(new Error('keep draft'), { status: 409 }));
    const provider = createShotTimelineDataProvider(config, composition, 'occ-1', createShotCompositionAdapter({ load: vi.fn(), publish }));
    const remember = vi.fn();
    provider.getTimelineDraftRecoveryMetadata?.(remember);
    expect(remember).toHaveBeenCalledWith(composition);
    await expect(provider.saveTimeline('raw-collision-popup', config, 1)).rejects.toMatchObject({ status: 409 });
    const candidate = publish.mock.calls[0][0].graph;
    const updated = candidate.shot_revisions.at(-1).internal_timeline_revision.timeline.clips[0];
    expect(updated.app).toStrictEqual(app);
    const record = await loadTimelineDraft(shotTimelineRecoveryId('document-primary', 'occ-1'));
    const draft = record!.draft.config as TimelineConfig;
    expect(draft.clips[0].app).toStrictEqual(app);
    expect(JSON.stringify(draft.clips[0].app)).toBe(JSON.stringify(app));
    expect(raw.app).toStrictEqual(app);
    expect(config.clips[0].app?.canonicalTiming).toHaveProperty('storedOccurrenceDurationMs', 2000);
  });

  it('bounds the preview from live draft extent and the hard blocker, not committed timing', () => {
    const baseConfig = projectCanonicalComposition({
      ...createShotCompositionAdapter({ load: vi.fn() }).prepare(fixture),
      occurrences: [createShotCompositionAdapter({ load: vi.fn() }).prepare(fixture).occurrences[0]!],
    }).config;
    const committed = baseConfig.clips[0]!;
    const draft = { ...baseConfig, clips: [{ ...committed, at: 0, hold: 5.5 }] };

    const extended = boundShotTimelinePreviewConfig(draft, 6);
    expect(extended.clips[0]?.app?.canonicalTiming).toMatchObject({ occurrenceDurationMs: 5_500 });
    expect(boundCanonicalClipToOccurrence(extended.clips[0]!)?.hold).toBe(5.5);

    const shortened = boundShotTimelinePreviewConfig({ ...draft, clips: [{ ...committed, at: 0, hold: 3 }] }, 6);
    expect(shortened.clips[0]?.app?.canonicalTiming).toMatchObject({ occurrenceDurationMs: 3_000 });
    expect(boundCanonicalClipToOccurrence(shortened.clips[0]!)?.hold).toBe(3);

    const blocked = boundShotTimelinePreviewConfig(draft, 4);
    expect(blocked.clips[0]?.app?.canonicalTiming).toMatchObject({ occurrenceDurationMs: 4_000 });
    expect(boundCanonicalClipToOccurrence(blocked.clips[0]!)?.hold).toBe(4);
  });

  it('derives the live shot end from current content, shrinks with the draft, and never crosses the blocker', () => {
    const base = { output: { resolution: '1920x1080', fps: 30, file: 'shot.mp4' }, tracks: [], clips: [] };
    const clip = { id: 'clip-a', track: 'video', at: 0, from: 0, to: 2, asset: 'asset-a' };

    expect(shotTimelineDurationSeconds({ ...base, clips: [clip] })).toBe(2);
    expect(shotTimelineDurationSeconds({ ...base, clips: [{ ...clip, to: 4 }] })).toBe(4);
    expect(shotTimelineDurationSeconds({ ...base, clips: [{ ...clip, to: 1.25 }] })).toBe(1.25);
    expect(shotTimelineDurationSeconds({ ...base, clips: [{ ...clip, to: 8 }] }, 5.9)).toBe(5.9);
  });

  it('serializes A then B against each acknowledged head without resetting the session version', async () => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const config = projectCanonicalComposition({ ...composition, occurrences: [composition.occurrences[0]!] }).config;
    const ackA = { ...composition, headRevisionId: 'head-after-a' };
    const ackB = { ...composition, headRevisionId: 'head-after-b' };
    let releaseA!: () => void;
    const waitForA = new Promise<void>((resolve) => { releaseA = resolve; });
    const publish = vi.fn()
      .mockImplementationOnce(async () => { await waitForA; return ackA; })
      .mockResolvedValueOnce(ackB);
    const adapter = {
      ...createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }),
      publish,
    } as unknown as ShotCompositionAdapter;
    const publishedHeads: string[] = [];
    const provider = createShotTimelineDataProvider(
      config,
      composition,
      'occ-1',
      adapter,
      (next) => publishedHeads.push(next.headRevisionId),
    );
    const draftA = { ...config, clips: config.clips.map((clip) => ({ ...clip, duration: 2, to: 2 })) };
    const draftB = { ...config, clips: config.clips.map((clip) => ({ ...clip, duration: 3, to: 3 })) };

    const saveA = provider.saveTimeline('shot', draftA);
    const saveB = provider.saveTimeline('shot', draftB);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    // The live end calculation reflects B before publication A is acknowledged.
    try {
      expect(shotTimelineDurationSeconds(draftB)).toBe(3);
    } finally {
      releaseA();
    }

    await expect(Promise.all([saveA, saveB])).resolves.toEqual([2, 3]);
    expect(publish.mock.calls.map(([request]) => request.expectedHeadRevisionId)).toEqual([
      composition.headRevisionId,
      ackA.headRevisionId,
    ]);
    expect(publishedHeads).toEqual([ackA.headRevisionId, ackB.headRevisionId]);
    expect(provider.adoptCleanBaseline(config, ackB)).toBe(true);
    await expect(provider.loadTimeline('shot')).resolves.toMatchObject({ configVersion: 3 });
  });

  it('keeps the draft retryable after a failed publication and retries against the last acknowledged head', async () => {
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const config = projectCanonicalComposition({ ...composition, occurrences: [composition.occurrences[0]!] }).config;
    const acknowledged = { ...composition, headRevisionId: 'head-after-retry' };
    const publish = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporary failure'), { status: 503 }))
      .mockResolvedValueOnce(acknowledged);
    const provider = createShotTimelineDataProvider(
      config,
      composition,
      'occ-1',
      { publish } as unknown as ShotCompositionAdapter,
    );

    await expect(provider.saveTimeline('shot', config)).rejects.toThrow('temporary failure');
    await expect(provider.saveTimeline('shot', config)).resolves.toBe(2);
    expect(publish.mock.calls.map(([request]) => request.expectedHeadRevisionId)).toEqual([
      composition.headRevisionId,
      composition.headRevisionId,
    ]);
  });

  it('reopens the occurrence recovery slot and reuses the exact candidate and idempotency key after response loss', async () => {
    resetFakeIndexedDB();
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() });
    const composition = adapter.prepare(fixture);
    const config = projectCanonicalComposition({ ...composition, occurrences: [composition.occurrences[0]!] }).config;
    const recoveryId = shotTimelineSessionId('document-primary', 'occ-1', createShotTimelineEditorSessionToken());
    const recoveryKey = shotTimelineRecoveryId('document-primary', 'occ-1');
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockResolvedValueOnce({ ...composition, headRevisionId: 'head-after-replay' });
    const port = { publish } as unknown as ShotCompositionAdapter;
    const firstProvider = createShotTimelineDataProvider(config, composition, 'occ-1', port);

    await expect(firstProvider.saveTimeline(recoveryId, config, 1)).rejects.toThrow('response lost after commit');
    const firstRequest = publish.mock.calls[0]?.[0];
    const reopenedProvider = createShotTimelineDataProvider(config, composition, 'occ-1', port);
    await reopenedProvider.loadTimeline(recoveryId);
    await expect(reopenedProvider.saveTimeline(recoveryId, config, 1)).resolves.toBe(2);

    const replayRequest = publish.mock.calls[1]?.[0];
    expect(replayRequest).toMatchObject({
      expectedHeadRevisionId: firstRequest.expectedHeadRevisionId,
      idempotencyKey: firstRequest.idempotencyKey,
      graph: firstRequest.graph,
    });
    expect(publish).toHaveBeenCalledTimes(2);
    await clearTimelineDraft(recoveryKey);
  });

  it('preserves recovery B stored while publication A is still preparing', async () => {
    resetFakeIndexedDB();
    const base = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const config = projectCanonicalComposition({ ...base, occurrences: [base.occurrences[0]!] }).config;
    const provider = createShotTimelineDataProvider(config, base, 'occ-1', {
      publish: vi.fn().mockResolvedValue({ ...base, headRevisionId: 'head-after-A' }),
    } as unknown as ShotCompositionAdapter);
    const recoveryKey = shotTimelineRecoveryId('document-primary', 'occ-1');
    const draftA = { ...config, clips: config.clips.map((clip) => ({ ...clip, hold: 2.5 })) };
    const draftB = { ...config, clips: config.clips.map((clip) => ({ ...clip, hold: 3.75 })) };
    await saveTimelineDraft('session-A', { config: draftA, registry: config.registry }, 1, {
      ...provider.getTimelineDraftRecoveryMetadata?.(),
      draftIdentity: 'edit-A',
    });
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let releaseDigest!: () => void;
    const digestHeld = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (...args) => {
      await digestHeld;
      return originalDigest(...args);
    });
    try {
      const saveA = provider.saveTimeline('session-A', draftA, 1);
      await vi.waitFor(() => expect(digestSpy).toHaveBeenCalled());
      await saveTimelineDraft('session-B', { config: draftB, registry: config.registry }, 1, {
        ...provider.getTimelineDraftRecoveryMetadata?.(),
        draftIdentity: 'edit-B',
      });
      releaseDigest();
      await expect(saveA).resolves.toBe(2);
      const recovered = await loadTimelineDraft(recoveryKey);
      expect((recovered?.draft.config as TimelineConfig).clips).toEqual(draftB.clips);
      expect((recovered?.draft.config as TimelineConfig).app).toMatchObject({
        canonicalComposition: { headRevisionId: 'head-after-A' },
      });
      expect(recovered?.draftIdentity).toBe('edit-B');
      expect(recovered?.draft.canonicalPublication).toMatchObject({
        idempotencyKey: expect.stringMatching(/^astrid\.shot-popup\./),
      });

      const reopened = createShotTimelineDataProvider(config, base, 'occ-1');
      const recoveredAgain = await reopened.loadTimeline('new-session');
      expect((recoveredAgain.config as TimelineConfig).clips).toEqual(authoredRecoveryClips(draftB, 'occ-1'));
      expect((recoveredAgain.config as TimelineConfig).app).toMatchObject({
        canonicalComposition: { headRevisionId: 'head-after-A' },
      });
    } finally {
      releaseDigest();
      digestSpy.mockRestore();
      await clearTimelineDraft(recoveryKey);
    }
  });

  it('preserves a newer B recovery record when publication A acknowledges, then reloads B', async () => {
    resetFakeIndexedDB();
    const base = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const config = projectCanonicalComposition({ ...base, occurrences: [base.occurrences[0]!] }).config;
    const graphAfterA = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    graphAfterA.primary_timeline.head.revision_id = 'head-after-A';
    const graphAfterB = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    graphAfterB.primary_timeline.head.revision_id = 'head-after-B';
    const compositionAdapter = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() });
    const ackA = compositionAdapter.prepare(graphAfterA);
    const ackB = compositionAdapter.prepare(graphAfterB);
    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
    const publish = vi.fn()
      .mockImplementationOnce(async () => { await heldA; return ackA; })
      .mockResolvedValueOnce(ackB);
    const adapter = {
      ...createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }),
      publish,
    } as unknown as ShotCompositionAdapter;
    const providerA = createShotTimelineDataProvider(config, base, 'occ-1', adapter);
    const recoveryKey = shotTimelineRecoveryId('document-primary', 'occ-1');
    const draftA = { ...config, clips: config.clips.map((clip) => ({ ...clip, hold: 2.5 })) };
    const draftB = { ...config, clips: config.clips.map((clip) => ({ ...clip, hold: 3.25 })) };
    const saveA = providerA.saveTimeline('session-A', draftA, 1);
    await vi.waitFor(async () => expect(publish).toHaveBeenCalledTimes(1));
    await saveTimelineDraft('session-B', { config: draftB, registry: config.registry }, 1, {
      ...providerA.getTimelineDraftRecoveryMetadata?.(),
      recoveryKey,
      draftIdentity: 'edit-B',
    });
    releaseA();
    await expect(saveA).resolves.toBe(2);

    const recovered = await loadTimelineDraft(recoveryKey);
    const persistedConfig = recovered?.draft.config as TimelineConfig;
    expect(persistedConfig.clips).toEqual(draftB.clips);
    expect(persistedConfig.app).toMatchObject({
      canonicalComposition: { headRevisionId: ackA.headRevisionId },
    });
    expect(recovered?.baseHeadRevisionId).toBe(ackA.headRevisionId);
    expect(recovered?.baseCanonicalGraph).toEqual(ackA.contract);
    const reopened = createShotTimelineDataProvider(config, ackA, 'occ-1', adapter);
    const reopenedConfig = (await reopened.loadTimeline('session-C')).config as TimelineConfig;
    expect(reopenedConfig.clips).toEqual(authoredRecoveryClips(draftB, 'occ-1'));
    await expect(reopened.saveTimeline('session-C', reopenedConfig, 1)).resolves.toBe(2);
    expect(publish.mock.calls[1]?.[0]).toMatchObject({ expectedHeadRevisionId: ackA.headRevisionId });
    expect(await loadTimelineDraft(recoveryKey)).toBeNull();
  });

  it('reconciles a stale config marker from H0 to its acknowledged H1 recovery base before Retry', async () => {
    resetFakeIndexedDB();
    const recoveryKey = shotTimelineRecoveryId('document-primary', 'occ-1');
    const base = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const config = projectCanonicalComposition({ ...base, occurrences: [base.occurrences[0]!] }).config;
    const graphAfterA = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    graphAfterA.primary_timeline.head.revision_id = 'head-after-A-before-query-echo';
    const graphAfterB = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    graphAfterB.primary_timeline.head.revision_id = 'head-after-B';
    const compositionAdapter = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() });
    const ackA = compositionAdapter.prepare(graphAfterA);
    const ackB = compositionAdapter.prepare(graphAfterB);
    const publish = vi.fn()
      .mockResolvedValueOnce(ackA)
      .mockResolvedValueOnce(ackB);
    const adapter = {
      ...createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }),
      publish,
    } as unknown as ShotCompositionAdapter;
    const providerA = createShotTimelineDataProvider(config, base, 'occ-1', adapter);
    const draftA = { ...config, clips: config.clips.map((clip) => ({ ...clip, hold: 2.5 })) };
    await expect(providerA.saveTimeline('session-A', draftA, 1)).resolves.toBe(2);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ expectedHeadRevisionId: base.headRevisionId });

    const draftB = {
      ...config,
      clips: config.clips.map((clip, index) => index === 0 ? { ...clip, at: 0.725 } : clip),
    };
    await saveTimelineDraft('session-B', { config: draftB, registry: config.registry }, 1, {
      ...providerA.getTimelineDraftRecoveryMetadata?.(),
      recoveryKey,
      draftIdentity: 'edit-B-after-A-ack',
    });
    const persistedB = await loadTimelineDraft(recoveryKey);
    expect(persistedB?.baseHeadRevisionId).toBe(ackA.headRevisionId);
    expect((persistedB?.draft.config as TimelineConfig).app).toMatchObject({
      canonicalComposition: { headRevisionId: base.headRevisionId },
    });

    // Reopen on the current canonical head with a durable config that still carries
    // the previous head's marker. Validated provenance for the current head reconciles only that marker.
    const reopened = createShotTimelineDataProvider(config, ackA, 'occ-1', adapter);
    const loaded = await reopened.loadTimeline('session-C');
    const reconciled = loaded.config as TimelineConfig;
    expect(reconciled.clips).toEqual(authoredRecoveryClips(draftB, 'occ-1'));
    expect(reconciled.app).toMatchObject({
      canonicalComposition: { headRevisionId: ackA.headRevisionId },
    });
    const normalizedPersistedB = await loadTimelineDraft(recoveryKey);
    expect((normalizedPersistedB?.draft.config as TimelineConfig).clips).toEqual(draftB.clips);
    expect((normalizedPersistedB?.draft.config as TimelineConfig).app).toMatchObject({
      canonicalComposition: { headRevisionId: ackA.headRevisionId },
    });
    expect(normalizedPersistedB?.draftIdentity).toBe(persistedB?.draftIdentity);

    await expect(reopened.saveTimeline('session-C', reconciled, 1)).resolves.toBe(2);
    expect(publish.mock.calls[1]?.[0]).toMatchObject({ expectedHeadRevisionId: ackA.headRevisionId });
    const publishedGraph = publish.mock.calls[1]?.[0].graph as typeof fixture;
    const publishedOccurrence = publishedGraph.occurrences.find((occurrence) => occurrence.occurrence_id === 'occ-1')!;
    const publishedClip = publishedGraph.shot_revisions
      .find((revision) => revision.shot_id === publishedOccurrence.shot_id
        && revision.revision_id === publishedOccurrence.revision_id)!
      .internal_timeline_revision.timeline.clips[0]!;
    expect(publishedClip.at).toBe(0.725);
    expect(await loadTimelineDraft(recoveryKey)).toBeNull();
  });

  it('retains the original canonical CAS base for a pre-debounce recovered edit', async () => {
    resetFakeIndexedDB();
    const base = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(fixture);
    const externalContract = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    externalContract.primary_timeline.head.revision_id = 'head-external-before-debounce';
    const external = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(externalContract);
    const config = projectCanonicalComposition({ ...base, occurrences: [base.occurrences[0]!] }).config;
    const draft = { ...config, clips: config.clips.map((clip) => ({ ...clip, hold: 3.5 })) };
    const original = createShotTimelineDataProvider(config, base, 'occ-1', createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }));
    const recoveryKey = shotTimelineRecoveryId('document-primary', 'occ-1');
    await saveTimelineDraft('session-before-debounce', { config: draft, registry: config.registry }, 1, {
      ...original.getTimelineDraftRecoveryMetadata?.(),
      recoveryKey,
      draftIdentity: 'pre-debounce-edit',
    });
    const publish = vi.fn().mockRejectedValue(Object.assign(new Error('stale canonical head'), { status: 409 }));
    const reopened = createShotTimelineDataProvider(config, external, 'occ-1', createShotCompositionAdapter({ load: vi.fn(), publish }));
    const recovered = await reopened.loadTimeline('fresh-session');
    expect(recovered.config.clips).toEqual(authoredRecoveryClips(draft, 'occ-1'));
    await expect(reopened.saveTimeline('fresh-session', draft, 1)).rejects.toMatchObject({ status: 409 });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadRevisionId: base.headRevisionId }));
    const persisted = (await loadTimelineDraft(recoveryKey))?.draft.config as TimelineConfig;
    const { tracks: _persistedTracks, ...persistedWithoutTracks } = persisted;
    const { tracks: _draftTracks, ...draftWithoutTracks } = draft;
    expect(persistedWithoutTracks).toEqual({
      ...draftWithoutTracks,
      clips: authoredRecoveryClips(draft, 'occ-1'),
    });
    expect(persisted.clips.every((clip) => !clip.track.includes('~'))).toBe(true);
    expect(persisted.clips.every((clip) => !Object.hasOwn(clip.app ?? {}, 'group'))).toBe(true);
    expect(persisted.tracks?.map((track) => track.id)).toEqual(['video', 'audio']);
    expect(persisted.tracks?.every((track) => !track.app?.group)).toBe(true);
  });

  it('preserves inactive child state through projection, popup save, and re-enable', async () => {
    const graph = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    const timeline = graph.shot_revisions.find((revision) => revision.shot_id === 'shot-alpha' && revision.revision_id === 'rev-a')!
      .internal_timeline_revision.timeline;
    timeline.clips.push({
      id: 'disabled-long-clip', clip_type: 'media', track: 'video', at_ms: 0,
      duration_ms: 4000, asset_id: 'alpha-image', enabled: false, active: false,
      disabled: true, hidden: true, deleted: false,
    });
    const composition = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() }).prepare(graph);
    const occurrence = composition.occurrences[0]!;
    const single = { ...composition, occurrences: [occurrence] };
    const projected = projectCanonicalComposition(single).config;
    const disabled = projected.clips.find((clip) => clip.id === 'occ-1:disabled-long-clip');
    expect(disabled).toMatchObject({ enabled: false, active: false, disabled: true, hidden: true, deleted: false });
    expect(shotTimelineDurationSeconds(projected)).toBe(2);
    expect(boundCanonicalClipToOccurrence(disabled!)).toBeNull();
    const published: Array<Record<string, unknown>> = [];
    const provider = createShotTimelineDataProvider(projected, composition, 'occ-1', {
      publish: vi.fn(async (request) => { published.push(request as unknown as Record<string, unknown>); return composition; }),
    } as unknown as ShotCompositionAdapter);
    await provider.saveTimeline('popup-session', projected, 1);
    const savedGraph = published[0]?.graph as typeof fixture;
    const savedDisabledOccurrence = savedGraph.occurrences.find((item) => item.occurrence_id === 'occ-1')!;
    const savedRevision = savedGraph.shot_revisions.find((item) => (
      item.shot_id === savedDisabledOccurrence.shot_id && item.revision_id === savedDisabledOccurrence.revision_id
    ))!;
    const savedClips = savedRevision.internal_timeline_revision.timeline.clips;
    expect(savedClips.find((clip) => clip.id.endsWith(':disabled-long-clip'))).toMatchObject({
      enabled: false, active: false, disabled: true, hidden: true, deleted: false, hold: 4,
    });

    const reenabled = { ...projected, clips: projected.clips.map((clip) => clip.id.endsWith('disabled-long-clip')
      ? { ...clip, enabled: true, active: true, disabled: false, hidden: false, deleted: false }
      : clip) };
    expect(shotTimelineDurationSeconds(reenabled)).toBe(4);
    expect(boundCanonicalClipToOccurrence(reenabled.clips.find((clip) => clip.id.endsWith('disabled-long-clip'))!)).not.toBeNull();
  });
});
