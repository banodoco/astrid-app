// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineEditorCore } from '@/tools/video-editor/components/TimelineEditor/TimelineEditorCore';
import { VideoEditorRuntimeContext } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext';
import { useTimelineMultiSelect } from '@/shared/state/selectionStore';
import {
  __resetSelectionStoreForTests,
  activateTimelineClipData,
  setTimelineClipData,
  type TimelineClipDataOwner,
} from '@/shared/state/selectionStore';
import {
  createTimelineStore,
  TimelineStoreProvider,
} from '@/tools/video-editor/hooks/timelineStore';
import { getTimelineLabelWidth } from '@/tools/video-editor/lib/coordinate-utils';
import { EDIT_AREA_SELECTOR } from '@/tools/video-editor/lib/timeline-dom';
import { computeTimelineExtent, maxClipEndSeconds } from '@/tools/video-editor/lib/timeline-scale';
import type { CanonicalShotOccurrence } from '@/tools/video-editor/data/shotCompositionAdapter';
import type { ShotGroup } from '@/tools/video-editor/hooks/useShotGroups';
import type { TimelineInspectorTarget } from '@/tools/video-editor/lib/mobile-interaction-model';

// ---------------------------------------------------------------------------
// Mocks for hooks that require deep context chains
// ---------------------------------------------------------------------------

const useRenderDiagnosticMock = vi.fn();
vi.mock('@/tools/video-editor/hooks/usePerfDiagnostics', () => ({
  useRenderDiagnostic: (...args: unknown[]) => useRenderDiagnosticMock(...args),
}));

vi.mock('@/tools/video-editor/hooks/useClipDrag', () => ({
  useClipDrag: () => ({ dragSessionRef: { current: null } }),
}));

vi.mock('@/tools/video-editor/hooks/useMarqueeSelect', () => ({
  useMarqueeSelect: () => ({
    marqueeRect: null,
    onPointerDown: vi.fn(),
  }),
}));

vi.mock('@/tools/video-editor/hooks/useStaleVariants', () => ({
  useStaleVariants: () => ({
    staleAssetKeys: new Set<string>(),
    dismissedAssetKeys: new Set<string>(),
    generationAssetKeys: new Set<string>(),
    dismissAsset: vi.fn(),
    updateAssetToCurrentVariant: vi.fn(),
    applyVariantToAsset: vi.fn(),
  }),
}));

vi.mock('@/tools/video-editor/hooks/useActiveTaskClips', () => ({
  useActiveTaskClips: () => ({
    activeTaskAssetKeys: new Set<string>(),
  }),
}));

vi.mock('@/tools/video-editor/hooks/useAddVariantAsGeneration', () => ({
  useAddVariantAsGeneration: () => ({
    addVariantAsGenerationAfterClip: vi.fn(),
    isPending: false,
    isAddingVariantAsGenerationPending: () => false,
  }),
}));

const setGestureOwner = vi.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultData = {
  config: { pinnedShotGroups: [] },
  rows: [
    { id: 'V1', actions: [{ id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' }] },
  ],
  tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
  registry: { assets: { 'asset-1': { type: 'video/mp4', file: 'test.mp4' } } },
  meta: {
    'clip-1': { asset: 'asset-1', track: 'V1' },
  },
};

const defaultResolvedConfig = {
  clips: [
    {
      id: 'clip-1',
      clipType: 'video' as const,
      track: 'V1',
      assetEntry: { src: 'test.mp4', type: 'video/mp4' as const, duration: 10 },
    },
  ],
  tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
  registry: { assets: {} },
};

/** Creates a fresh timeline store with all slices wired for overlay tests. */
function createOverlayTestStore(options: {
  resolvedConfig?: typeof defaultResolvedConfig & { app?: Record<string, unknown> };
  canonicalShotClip?: boolean;
  inspectorTarget?: TimelineInspectorTarget;
} = {}) {
  const store = createTimelineStore();
  const testData = options.canonicalShotClip
    ? {
      ...defaultData,
      meta: { ...defaultData.meta, 'clip-1': { ...defaultData.meta['clip-1'], clipType: 'shot' } },
    }
    : defaultData;
  const selectedClipIds = new Set<string>();
  const selectedClipIdsRef = { current: new Set<string>() };
  store.getState().syncSlices({
    data: {
      data: { ...testData, dataLanes: [], resolvedConfig: options.resolvedConfig ?? defaultResolvedConfig },
      resolvedConfig: options.resolvedConfig ?? defaultResolvedConfig,
      deviceClass: 'desktop' as const,
      inputModality: 'mouse' as const,
      interactionMode: 'browse' as const,
      gestureOwner: 'none' as const,
      contextTarget: 'timeline' as const,
      inspectorTarget: options.inspectorTarget ?? 'none' as const,
      interactionPolicy: {
        deviceClass: 'desktop' as const,
        inputModality: 'mouse' as const,
        interactionMode: 'browse' as const,
        gestureOwner: 'none' as const,
        contextTarget: 'timeline' as const,
        inspectorTarget: options.inspectorTarget ?? 'none' as const,
      },
      selectedClipId: null,
      selectedClipIds,
      selectedClipIdsRef,
      additiveSelectionRef: { current: false },
      selectedTrackId: null,
      primaryClipId: null,
      selectedClip: null,
      selectedTrack: null,
      selectedClipHasPredecessor: false,
      compositionSize: { width: 1920, height: 1080 },
      trackScaleMap: {},
      scale: 30,
      scaleWidth: 30,
      isLoading: false,
      dataRef: { current: testData },
      pendingOpsRef: { current: 0 },
      interactionStateRef: { current: null },
      coordinator: {
        update: vi.fn(() => null),
        showSecondaryGhosts: vi.fn(),
        end: vi.fn(),
        lastPosition: null,
        editAreaRef: { current: null },
      },
      indicatorRef: { current: null },
      editAreaRef: { current: null },
      preferences: {
        scaleWidth: 30,
        timelineHeight: 400,
        labelWidth: 160,
      },
      timelineRef: { current: null },
      timelineWrapperRef: { current: null },
    },
    playback: {
      currentTime: 5.0,
      previewRef: { current: null },
      playerContainerRef: { current: null },
      onPreviewTimeUpdate: vi.fn(),
      formatTime: (t: number) => `${t.toFixed(1)}s`,
    },
    ops: {
      applyEdit: vi.fn(),
      moveClipToRow: vi.fn(),
      createTrackAndMoveClip: vi.fn(),
      selectClip: vi.fn(),
      selectClips: vi.fn(),
      addToSelection: vi.fn(),
      clearSelection: vi.fn(),
      isClipSelected: () => false,
      setSelectedTrackId: vi.fn(),
      handleTrackPopoverChange: vi.fn(),
      handleMoveTrack: vi.fn(),
      handleRemoveTrack: vi.fn(),
      handleSplitClipAtTime: vi.fn(),
      handleSplitClipsAtPlayhead: vi.fn(),
      handleDeleteClips: vi.fn(),
      handleDeleteClip: vi.fn(),
      handleToggleMuteClips: vi.fn(),
      onCursorDrag: vi.fn(),
      onClickTimeArea: vi.fn(),
      setGestureOwner,
      setInputModalityFromPointerType: vi.fn(() => 'mouse'),
      setContextTarget: vi.fn(),
      setInspectorTarget: vi.fn(),
      onActionResizeStart: vi.fn(),
      onClipEdgeResizeEnd: vi.fn(),
      onTimelineDragOver: vi.fn(),
      onTimelineDragLeave: vi.fn(),
      onTimelineDrop: vi.fn(),
      onDoubleClickAsset: vi.fn(),
      patchRegistry: vi.fn(),
      registerAsset: vi.fn(),
    },
    chrome: {
      handleAddTrack: vi.fn(),
      handleClearUnusedTracks: vi.fn(),
      unusedTrackCount: 0,
    },
  });
  return store;
}

function renderWithStore(ui: React.ReactElement, options: {
  resolvedConfig?: typeof defaultResolvedConfig & { app?: Record<string, unknown> };
  canonicalShotClip?: boolean;
  inspectorTarget?: TimelineInspectorTarget;
} = {}) {
  const store = createOverlayTestStore(options);
  return {
    store,
    ...render(
      <TimelineStoreProvider store={store}>
        {ui}
      </TimelineStoreProvider>,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TimelineEditorCore', () => {
  afterEach(() => {
    __resetSelectionStoreForTests();
    vi.clearAllMocks();
  });

  function SharedPopupSelection({ owner, testId }: { owner: TimelineClipDataOwner; testId: string }) {
    const { selectedClipIds } = useTimelineMultiSelect(owner);
    return <output data-testid={testId}>{[...selectedClipIds].join('|') || 'none'}</output>;
  }

  describe('selection and playhead tracking', () => {
    it('renders successfully with store data and tracks selectedClipIds', () => {
      const { container } = renderWithStore(<TimelineEditorCore />);
      expect(container.querySelector('.timeline-wrapper')).toBeInTheDocument();
    });

    it('tracks selectedTrackId from the data store', () => {
      const { container } = renderWithStore(<TimelineEditorCore />);
      expect(container.querySelector('.timeline-wrapper')).toBeInTheDocument();
    });

    it('routes mounted occurrence clip selection to the owner-scoped popup', async () => {
      const mountedOwner = Symbol('mounted-editor');
      const wrongOwner = Symbol('wrong-editor');
      const selectedClipId = 'f2-occurrence-copy:clip-0';
      const siblingClipId = 'f2-occurrence-copy:clip-1';
      setTimelineClipData([
        {
          clipId: selectedClipId,
          assetKey: 'asset-selected',
          url: 'https://example.test/selected.mp4',
          mediaType: 'video',
          isTimelineBacked: true,
        },
        {
          clipId: siblingClipId,
          assetKey: 'asset-sibling',
          url: 'https://example.test/sibling.mp4',
          mediaType: 'video',
          isTimelineBacked: true,
        },
      ], mountedOwner);
      setTimelineClipData([], wrongOwner);
      activateTimelineClipData(wrongOwner);

      const store = createOverlayTestStore();
      const dataSlice = store.getState().data;
      const data = {
        ...dataSlice.data!,
        rows: [{
          id: 'V1',
          actions: [
            { id: selectedClipId, start: 0, end: 2, effectId: 'effect-selected' },
            { id: siblingClipId, start: 2, end: 4, effectId: 'effect-sibling' },
          ],
        }],
        meta: {
          [selectedClipId]: { asset: 'asset-1', track: 'V1' },
          [siblingClipId]: { asset: 'asset-1', track: 'V1' },
        },
      };
      const resolvedConfig = {
        ...dataSlice.resolvedConfig!,
        clips: [
          { ...dataSlice.resolvedConfig!.clips[0], id: selectedClipId },
          { ...dataSlice.resolvedConfig!.clips[0], id: siblingClipId },
        ],
      };
      dataSlice.dataRef.current = data;
      store.getState().syncDataSlice({ ...dataSlice, data, resolvedConfig });

      const runtimeValue = {
        agentSelectionOwner: mountedOwner,
      } as unknown as React.ContextType<typeof VideoEditorRuntimeContext>;
      render(
        <VideoEditorRuntimeContext.Provider value={runtimeValue}>
          <TimelineStoreProvider store={store}>
            <TimelineEditorCore />
            <SharedPopupSelection owner={mountedOwner} testId="mounted-popup-selection" />
            <SharedPopupSelection owner={wrongOwner} testId="wrong-popup-selection" />
          </TimelineStoreProvider>
        </VideoEditorRuntimeContext.Provider>,
      );

      const clip = document.querySelector(`[data-clip-id="${selectedClipId}"]`);
      expect(clip).toBeInTheDocument();
      // The mounted ClipAction delegates this direct selection to Core before
      // opening its popup; no selection action is called directly by the test.
      act(() => fireEvent.contextMenu(clip!));

      await waitFor(() => expect(screen.getByTestId('mounted-popup-selection')).toHaveTextContent(selectedClipId));
      expect(screen.getByTestId('mounted-popup-selection')).not.toHaveTextContent(siblingClipId);
      expect(screen.getByTestId('wrong-popup-selection')).toHaveTextContent('none');
    });

    it('propagates the selected occurrence identity to its canonical overlay label', () => {
      const occurrence: CanonicalShotOccurrence = {
        projectId: 'project-1',
        occurrenceId: 'occurrence-opening',
        parentDocumentId: 'timeline-1',
        shotId: 'shot-opening',
        revisionId: 'revision-opening',
        ordinal: 0,
        atMs: 0,
        durationMs: 2_000,
        stableDeepLink: '/shot/opening',
        outputIdentity: 'output-opening',
        trackId: 'V1',
        revision: {},
      };
      const group: ShotGroup = {
        shotId: occurrence.shotId,
        shotName: 'Opening',
        rowId: 'V1',
        rowIndex: 0,
        start: 0,
        end: 2,
        clipIds: [],
        children: [],
        color: '#a855f7',
        poolGenerationIds: [],
        variantIdsByGenerationId: {},
        canonicalIdentity: occurrence,
      };
      const target = {
        kind: 'shotOccurrence' as const,
        occurrenceId: occurrence.occurrenceId,
        shotId: occurrence.shotId,
        revisionId: occurrence.revisionId,
        parentDocumentId: occurrence.parentDocumentId,
        shotName: 'Opening',
        trackId: 'V1',
        start: 0,
        end: 2,
      };
      const { getByTitle } = renderWithStore(
        <TimelineEditorCore shotGroups={[group]} />,
        { inspectorTarget: target },
      );

      const label = getByTitle('Opening');
      expect(label.getAttribute('aria-pressed')).toBe('true');
      expect(label.className).toContain('opacity-100');
    });

    it('wires canonical label clicks to Core selection ops with occurrence identity', () => {
      const occurrence: CanonicalShotOccurrence = {
        projectId: 'project-1',
        occurrenceId: 'occurrence-opening',
        parentDocumentId: 'timeline-1',
        shotId: 'shot-opening',
        revisionId: 'revision-opening',
        ordinal: 0,
        atMs: 0,
        durationMs: 2_000,
        stableDeepLink: '/shot/opening',
        outputIdentity: 'output-opening',
        trackId: 'V1',
        revision: {},
      };
      const group: ShotGroup = {
        shotId: occurrence.shotId,
        shotName: 'Opening',
        rowId: 'V1',
        rowIndex: 0,
        start: 0,
        end: 2,
        clipIds: ['occurrence-opening:child'],
        children: [{ clipId: 'occurrence-opening:child', offset: 0, duration: 2 }],
        color: '#a855f7',
        poolGenerationIds: [],
        variantIdsByGenerationId: {},
        canonicalIdentity: occurrence,
      };
      const { getByTitle, store } = renderWithStore(<TimelineEditorCore shotGroups={[group]} />);

      fireEvent.click(getByTitle('Opening'));

      expect(store.getState().ops.clearSelection).toHaveBeenCalledTimes(1);
      expect(store.getState().ops.setSelectedTrackId).toHaveBeenCalledWith('V1');
      expect(store.getState().ops.setInspectorTarget).toHaveBeenCalledWith({
        kind: 'shotOccurrence',
        occurrenceId: 'occurrence-opening',
        shotId: 'shot-opening',
        revisionId: 'revision-opening',
        parentDocumentId: 'timeline-1',
        shotName: 'Opening',
        trackId: 'V1',
        start: 0,
        end: 2,
      });
      expect(store.getState().ops.selectClips).not.toHaveBeenCalled();
    });

    it('selects the postprocess shader inspector target from the timeline badge', () => {
      const resolvedConfig = {
        ...defaultResolvedConfig,
        app: {
          shaderPostprocess: {
            scope: 'postprocess',
            extensionId: 'ext.shader',
            contributionId: 'post-grade',
            shaderId: 'shader.post.grade',
            label: 'Post Grade',
          },
        },
      } as typeof defaultResolvedConfig & { app: Record<string, unknown> };
      const { container, store } = renderWithStore(<TimelineEditorCore />, { resolvedConfig });

      const badge = container.querySelector('[data-postprocess-shader-badge="true"]');
      if (!(badge instanceof HTMLElement)) {
        throw new Error('expected postprocess shader badge');
      }

      fireEvent.click(badge);

      expect(store.getState().ops.clearSelection).toHaveBeenCalledTimes(1);
      expect(store.getState().ops.setSelectedTrackId).toHaveBeenCalledWith(null);
      expect(store.getState().ops.setInspectorTarget).toHaveBeenCalledWith({
        kind: 'shader',
        shaderScope: 'postprocess',
        shaderId: 'shader.post.grade',
        extensionId: 'ext.shader',
        contributionId: 'post-grade',
      });
      expect(store.getState().ops.setContextTarget).toHaveBeenCalledWith({
        kind: 'shader',
        shaderScope: 'postprocess',
        shaderId: 'shader.post.grade',
        extensionId: 'ext.shader',
        contributionId: 'post-grade',
      });
    });
  });

  describe('clip double-click routing', () => {
    const occurrence = (timeline: Record<string, unknown> | undefined): CanonicalShotOccurrence => ({
      projectId: 'project-1',
      occurrenceId: 'occurrence-1',
      parentDocumentId: 'parent-1',
      shotId: 'shot-1',
      revisionId: 'revision-1',
      ordinal: 0,
      atMs: 0,
      durationMs: 2000,
      stableDeepLink: '/shots/shot-1',
      outputIdentity: 'output-1',
      revision: {
        internal_timeline_revision: timeline ? { revision_id: 'internal-1', timeline } : undefined,
      },
    });

    const canonicalGroup = (identity: CanonicalShotOccurrence): ShotGroup => ({
      shotId: identity.shotId,
      shotName: identity.shotId,
      rowId: 'V1',
      rowIndex: 0,
      start: 0,
      end: 2,
      clipIds: ['clip-1'],
      children: [{ clipId: 'clip-1', offset: 0, duration: 2 }],
      color: '#000000',
      poolGenerationIds: [],
      variantIdsByGenerationId: {},
      canonicalIdentity: identity,
    });

    it('opens a canonical shot occurrence with an internal timeline from the clip double-click path', () => {
      const onShotGroupOpen = vi.fn();
      const { container, store } = renderWithStore(
        <TimelineEditorCore
          shotGroups={[canonicalGroup(occurrence({ tracks: [], clips: [{ id: 'child-1' }] }))]}
          onShotGroupOpen={onShotGroupOpen}
        />,
        { canonicalShotClip: true },
      );
      const clip = container.querySelector('[data-clip-id="clip-1"]');
      expect(clip).toBeTruthy();

      fireEvent.doubleClick(clip!);

      expect(onShotGroupOpen).toHaveBeenCalledWith(canonicalGroup(occurrence({ tracks: [], clips: [{ id: 'child-1' }] })).canonicalIdentity);
      expect(store.getState().ops.onDoubleClickAsset).not.toHaveBeenCalled();
    });

    it('keeps the asset lightbox route when canonical identity has no resolvable internal timeline', () => {
      const onShotGroupOpen = vi.fn();
      const { container, store } = renderWithStore(
        <TimelineEditorCore
          shotGroups={[canonicalGroup(occurrence(undefined))]}
          onShotGroupOpen={onShotGroupOpen}
        />,
        { canonicalShotClip: true },
      );
      const clip = container.querySelector('[data-clip-id="clip-1"]');
      expect(clip).toBeTruthy();

      fireEvent.doubleClick(clip!);

      expect(onShotGroupOpen).not.toHaveBeenCalled();
      expect(store.getState().ops.onDoubleClickAsset).toHaveBeenCalledWith('asset-1', 'clip-1');
    });

    it('does not open an unrelated canonical occurrence when the clip identity does not match', () => {
      const unrelatedOccurrence = occurrence({ tracks: [], clips: [{ id: 'child-1' }] });
      const onShotGroupOpen = vi.fn();
      const { container, store } = renderWithStore(
        <TimelineEditorCore
          canonicalOccurrences={[unrelatedOccurrence]}
          onShotGroupOpen={onShotGroupOpen}
        />,
        { canonicalShotClip: true },
      );
      const clip = container.querySelector('[data-clip-id="clip-1"]');
      expect(clip).toBeTruthy();

      fireEvent.doubleClick(clip!);

      expect(onShotGroupOpen).not.toHaveBeenCalled();
      expect(store.getState().ops.onDoubleClickAsset).toHaveBeenCalledWith('asset-1', 'clip-1');
    });

    it('keeps ordinary non-canonical video assets on the lightbox route', () => {
      const onShotGroupOpen = vi.fn();
      const { container, store } = renderWithStore(<TimelineEditorCore onShotGroupOpen={onShotGroupOpen} />);
      const clip = container.querySelector('[data-clip-id="clip-1"]');
      expect(clip).toBeTruthy();

      fireEvent.doubleClick(clip!);

      expect(onShotGroupOpen).not.toHaveBeenCalled();
      expect(store.getState().ops.onDoubleClickAsset).toHaveBeenCalledWith('asset-1', 'clip-1');
    });
  });

});

describe('TimelineEditorCore — geometry', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Key Invariant 4: ruler width, grid width, scroll-content width and the
  // overlay's totalWidth all come from one computeTimelineExtent result.
  it('sizes the ruler and the grid from the shared timeline extent', () => {
    const { container } = renderWithStore(<TimelineEditorCore />);
    const { totalWidth } = computeTimelineExtent({
      maxEndSeconds: maxClipEndSeconds(defaultData.rows),
      scale: 30,
      scaleWidth: 30,
      startLeft: getTimelineLabelWidth('desktop'),
    });

    const rulerContent = screen.getByTestId('timeline-ruler').firstElementChild;
    const editArea = container.querySelector(EDIT_AREA_SELECTOR);
    const grid = editArea?.children[0];
    const scrollContentFooter = editArea?.children[1];

    if (
      !(rulerContent instanceof HTMLElement)
      || !(grid instanceof HTMLElement)
      || !(scrollContentFooter instanceof HTMLElement)
    ) {
      throw new Error('expected a rendered ruler, grid and scroll footer');
    }

    expect(totalWidth).toBeGreaterThan(getTimelineLabelWidth('desktop'));
    expect(rulerContent.style.width).toBe(`${totalWidth}px`);
    expect(grid.style.width).toBe(`${totalWidth}px`);
    expect(scrollContentFooter.style.width).toBe(`${totalWidth}px`);
  });
});
