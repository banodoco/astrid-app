// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AstridTimelineEditor } from '@/tools/video-editor/components/AstridTimelineEditor';
import { getCanonicalLoadState } from '@/tools/video-editor/components/AstridTimelineEditor';
import {
  createTimelineStore,
  TimelineStoreProvider,
} from '@/tools/video-editor/hooks/timelineStore';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data';
import type { Shot } from '@/domains/generation/types/index.ts';
import { VideoEditorRuntimeProvider } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext';

// ---------------------------------------------------------------------------
// Mocks for hooks that require deep context chains or backend access
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  navigateToShot: vi.fn(),
  pinGroup: vi.fn(),
  shots: [] as Shot[],
  selectedProjectId: 'project-1',
}));

// '' is same-origin; a gateway origin is the hosted build.
let hostedOrigin = '';
vi.mock('@/integrations/runtime/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/connection.ts')>()),
  runtimeOrigin: () => hostedOrigin,
}));

vi.mock('@/tools/video-editor/hooks/usePerfDiagnostics', () => ({
  useRenderDiagnostic: () => undefined,
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
  useActiveTaskClips: () => ({ activeTaskAssetKeys: new Set<string>() }),
}));

vi.mock('@/tools/video-editor/hooks/useAddVariantAsGeneration', () => ({
  useAddVariantAsGeneration: () => ({
    addVariantAsGenerationAfterClip: vi.fn(),
    isPending: false,
    isAddingVariantAsGenerationPending: () => false,
  }),
}));

vi.mock('@/shared/hooks/shots/useShotNavigation', () => ({
  useShotNavigation: () => ({
    navigateToShot: mocks.navigateToShot,
    navigateToShotEditor: vi.fn(),
    navigateToNextShot: vi.fn(),
    navigateToPreviousShot: vi.fn(),
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/shared/contexts/ProjectContext', () => ({
  useProjectSelectionContext: () => ({ selectedProjectId: mocks.selectedProjectId }),
}));

vi.mock('@/shared/contexts/ShotsContext', () => ({
  useShots: () => ({ shots: mocks.shots }),
}));

vi.mock('@/tools/video-editor/hooks/useShotGroups', async (importOriginal) => (
  importOriginal<typeof import('@/tools/video-editor/hooks/useShotGroups')>()
));

vi.mock('@/tools/video-editor/hooks/usePinnedShotGroups', () => ({
  usePinnedShotGroupViews: () => [],
  usePinnedShotGroups: () => ({
    pinGroup: mocks.pinGroup,
    unpinGroup: vi.fn(),
    updatePinnedGroup: vi.fn(),
  }),
  usePinnedGroupSync: () => undefined,
}));

vi.mock('@/tools/video-editor/hooks/useShotGroupHandlers', () => ({
  useShotGroupHandlers: () => ({
    shotGroupClipIds: new Set<string>(),
    activeTaskClipIds: new Set<string>(),
    staleShotGroupIds: new Set<string>(),
    handleShotGroupNavigate: vi.fn(),
    handleShotGroupGenerateVideo: vi.fn(),
    handleDeleteShotGroup: vi.fn(),
    handleUpdateToLatestVideo: vi.fn(),
    handleShotGroupUnpin: vi.fn(),
    handleShotGroupSwitchToFinalVideo: vi.fn(),
    handleShotGroupSwitchToImages: vi.fn(),
  }),
}));

vi.mock('@/tools/video-editor/hooks/useSwitchToFinalVideo', () => ({
  useSwitchToFinalVideo: () => ({
    switchToFinalVideo: vi.fn(),
    updateToLatestVideo: vi.fn(),
    switchToImages: vi.fn(),
  }),
}));

vi.mock('@/tools/video-editor/hooks/useFinalVideoAvailable', () => ({
  useFinalVideoAvailable: () => ({
    finalVideoMap: new Map(),
    dismissFinalVideo: vi.fn(),
  }),
}));

vi.mock('@/tools/travel-between-images/components/VideoGenerationModal', () => ({
  VideoGenerationModal: () => null,
}));

vi.mock('@/tools/travel-between-images/pages/LocalTimelineShotBrowser', () => ({
  LocalTimelineShotBrowser: () => null,
}));

// ---------------------------------------------------------------------------
// Store data fixture: a minimal but structurally valid TimelineData
// ---------------------------------------------------------------------------

const timelineData: TimelineData = {
  config: {
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [
      { id: 'V1', kind: 'visual', label: 'V1' },
    ],
    clips: [],
    pinnedShotGroups: [],
  },
  configVersion: 1,
  registry: { assets: {} },
  resolvedConfig: {
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips: [],
    registry: { assets: {} },
  },
  rows: [{ id: 'V1', actions: [] }],
  meta: {},
  effects: {},
  assetMap: {},
  output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
  tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
  clipOrder: { V1: [] },
  signature: 'signature',
  stableSignature: 'stable-signature',
};

function createTestStore(data: TimelineData = timelineData) {
  const store = createTimelineStore();
  store.getState().syncSlices({
    data: {
      data,
      resolvedConfig: data.resolvedConfig,
      deviceClass: 'desktop' as const,
      inputModality: 'mouse' as const,
      interactionMode: 'browse' as const,
      gestureOwner: 'none' as const,
      contextTarget: 'timeline' as const,
      inspectorTarget: 'none' as const,
      interactionPolicy: {
        deviceClass: 'desktop' as const,
        inputModality: 'mouse' as const,
        interactionMode: 'browse' as const,
        gestureOwner: 'none' as const,
        contextTarget: 'timeline' as const,
        inspectorTarget: 'none' as const,
      },
      selectedClipId: null,
      selectedClipIds: new Set<string>(),
      selectedClipIdsRef: { current: new Set<string>() },
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
      dataRef: { current: data },
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
      setGestureOwner: vi.fn(),
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

function renderEditor(options: { data?: TimelineData; runtime?: Record<string, unknown> } = {}) {
  const store = createTestStore(options.data);
  const result = render(
    <div data-video-editor-instance="test-shell">
      <TimelineStoreProvider store={store}>
        <VideoEditorRuntimeProvider value={{
          userId: null,
          timelineId: 'timeline-1',
          project: { projectId: 'project-1' },
          provider: {},
          ...options.runtime,
        } as never}>
          <AstridTimelineEditor />
        </VideoEditorRuntimeProvider>
      </TimelineStoreProvider>
    </div>,
  );
  return { ...result, store };
}

function getTimelineBackground(container: HTMLElement) {
  const background = container.querySelector('.timeline-canvas-edit-area > .relative');
  if (!(background instanceof HTMLElement)) {
    throw new Error('expected timeline background');
  }
  return background;
}

describe('AstridTimelineEditor empty-area menu', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not offer shot creation from the empty-area context menu', () => {
    const { container, store } = renderEditor();
    const background = getTimelineBackground(container);

    fireEvent.contextMenu(background, { clientX: 100, clientY: 40 });

    expect(screen.queryByText('Create Shot')).not.toBeInTheDocument();
    expect(mocks.navigateToShot).not.toHaveBeenCalled();
    expect(store.getState().ops.applyEdit).not.toHaveBeenCalled();
  });
});

describe('AstridTimelineEditor canonical shot opening', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the existing shot popup for an ordinary-mode canonical occurrence double-click', async () => {
    const occurrenceId = 'occurrence-ordinary';
    const clipId = occurrenceId;
    const occurrence = {
      projectId: 'project-1',
      occurrenceId,
      parentDocumentId: 'timeline-1',
      shotId: 'shot-ordinary',
      revisionId: 'revision-1',
      ordinal: 0,
      atMs: 0,
      durationMs: 2000,
      stableDeepLink: '/shots/shot-ordinary',
      outputIdentity: 'output-1',
      revision: {
        internal_timeline_revision: {
          revision_id: 'internal-1',
          timeline: { tracks: [], clips: [{ id: 'child-1' }] },
        },
      },
    };
    const data: TimelineData = {
      ...timelineData,
      rows: [{ id: 'V1', actions: [{ id: clipId, start: 0, end: 2 }] }],
      meta: { [clipId]: { asset: 'asset-1', track: 'V1', clipType: 'shot' } },
    };
    const { container } = renderEditor({
      data,
      runtime: {
        userId: 'user-1',
        shots: { canonicalOccurrences: [occurrence] },
      },
    });
    const clip = container.querySelector(`[data-clip-id="${clipId}"]`);
    expect(clip).toBeTruthy();
    const gallery = document.createElement('div');
    document.body.append(gallery);

    fireEvent.doubleClick(clip!);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Edit shot-ordinary')).toBeInTheDocument();
    expect(container.querySelector('[data-video-editor-instance]')).toHaveAttribute('inert');
    expect(gallery).not.toHaveAttribute('inert');
    expect(container.querySelector('[data-action-id="shot-group-label"]')).toBeNull();
    await act(async () => {
      screen.getByRole('button', { name: 'Close' }).click();
    });
    await waitFor(() => expect(container.querySelector('[data-video-editor-instance]')).not.toHaveAttribute('inert'));
    gallery.remove();
  });
});

describe('AstridTimelineEditor canonical read state', () => {
  it('shows pending shot blocks without a full-width loading banner', () => {
    const { container } = renderEditor({ runtime: {
      shots: {
        shotComposition: {}, isLoading: true, canonicalComposition: null,
        canonicalOccurrences: [],
        pendingOccurrences: [{
          occurrenceId: 'occ-opening', shotId: 'chapter-opening', ordinal: 0,
          atMs: 0, durationMs: 2_000, trackId: 'V1',
        }],
      },
    } });

    expect(container.querySelector('[data-pending-shot-group]')).toBeTruthy();
    // Pending labels are unlabelled strips: no raw shot id shows while the name loads.
    expect(screen.queryByText('chapter opening')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading the canonical shot composition…')).not.toBeInTheDocument();
    expect(container.querySelector('[data-canonical-load-state="loading"]')).toBeNull();
  });

  it('keeps an empty successful composition on the canonical route', () => {
    expect(getCanonicalLoadState({
      canonicalRoute: true,
      isLoading: false,
      hasComposition: true,
      error: null,
    })).toBe('current');
    expect(getCanonicalLoadState({
      canonicalRoute: true,
      isLoading: false,
      hasComposition: false,
      error: null,
    })).toBe('loading');
  });

  it('distinguishes failed initial reads, stale pinned heads, and explicit legacy mode', () => {
    const error = new Error('temporary read failure');
    expect(getCanonicalLoadState({ canonicalRoute: true, isLoading: false, hasComposition: false, error })).toBe('error');
    expect(getCanonicalLoadState({ canonicalRoute: true, isLoading: false, hasComposition: true, error })).toBe('stale');
    expect(getCanonicalLoadState({ canonicalRoute: false, isLoading: false, hasComposition: false, error })).toBe('legacy');
  });

  it('keeps a failed canonical read visible and retries that route without legacy substitution', () => {
    const refetchShots = vi.fn();
    renderEditor({ runtime: {
      shots: {
        shotComposition: {},
        canonicalOccurrences: [],
        canonicalComposition: null,
        canonicalCompositionError: new Error('Runtime unavailable'),
        refetchShots,
      },
    } });

    expect(screen.getByRole('alert')).toHaveAttribute('data-canonical-load-state', 'error');
    expect(screen.getByText(/Legacy shot data was not substituted/)).toBeInTheDocument();
    expect(screen.queryByText(/explicit legacy shot view/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchShots).toHaveBeenCalledTimes(1);
  });

  describe('on the hosted build', () => {
    afterEach(() => { hostedOrigin = ''; });

    it('never prints the engineer-worded error line: the load-error card owns that moment', () => {
      hostedOrigin = 'http://127.0.0.1:17340';
      const refetchShots = vi.fn();
      const { container } = renderEditor({ runtime: {
        shots: {
          shotComposition: {},
          canonicalOccurrences: [],
          canonicalComposition: null,
          canonicalCompositionError: new Error('Runtime unavailable'),
          refetchShots,
        },
      } });

      expect(container.querySelector('[data-canonical-load-state="error"]')).toBeNull();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/canonical|Legacy shot data|substituted/i);
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });

    it('never prints the legacy shot view line either', () => {
      const runtime = { userId: null, shots: { canonicalOccurrences: [] } };
      // Same-origin the line is there (so the hosted absence below is not an empty render).
      const sameOrigin = renderEditor({ runtime });
      expect(sameOrigin.container.querySelector('[data-canonical-load-state="legacy"]')).not.toBeNull();
      sameOrigin.unmount();

      hostedOrigin = 'http://127.0.0.1:17340';
      const { container } = renderEditor({ runtime });
      expect(container.querySelector('[data-canonical-load-state="legacy"]')).toBeNull();
      expect(document.body.textContent).not.toMatch(/legacy shot view|Canonical shot composition/i);
    });

    it('still says a stale refresh in plain words', () => {
      hostedOrigin = 'http://127.0.0.1:17340';
      const { container } = renderEditor({ runtime: staleRuntime() });
      expect(container.querySelector('[data-canonical-load-state="stale"]')).toHaveTextContent("Couldn't refresh this timeline.");
    });
  });

  const STALE_HEAD = '3f1c2a9e-4b7d-4c1e-9a55-0d6e7f8a9b10';
  const staleRuntime = (refetchShots = vi.fn()) => ({
    shots: {
      shotComposition: {},
      canonicalOccurrences: [],
      canonicalComposition: { headRevisionId: STALE_HEAD },
      canonicalCompositionError: new Error('Runtime unavailable'),
      refetchShots,
    },
  });

  it('says a stale read in plain words, never prints the head id, and offers Try again', () => {
    const refetchShots = vi.fn();
    const { container } = renderEditor({ runtime: staleRuntime(refetchShots) });

    const banner = container.querySelector('[data-canonical-load-state="stale"]') as HTMLElement;
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent("Couldn't refresh this timeline. Showing your last saved version.");
    expect(banner.textContent).not.toContain(STALE_HEAD);
    expect(banner.textContent).not.toMatch(/canonical|head/i);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchShots).toHaveBeenCalledTimes(1);
  });

  it('retries the refresh by itself when the Astrid stopped card clears, so the stale line does not stay behind', () => {
    const refetchShots = vi.fn();
    act(() => setRecoveryCardShowing(true));
    try {
      renderEditor({ runtime: staleRuntime(refetchShots) });
      expect(refetchShots).not.toHaveBeenCalled();
      act(() => setRecoveryCardShowing(false));
      expect(refetchShots).toHaveBeenCalledTimes(1);
    } finally {
      act(() => setRecoveryCardShowing(false));
    }
  });

  it('stays quiet while the Astrid stopped / restarted card is showing, and speaks again when it is gone', () => {
    act(() => setRecoveryCardShowing(true));
    try {
      const { container } = renderEditor({ runtime: staleRuntime() });
      expect(container.querySelector('[data-canonical-load-state="stale"]')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      act(() => setRecoveryCardShowing(false));
      expect(container.querySelector('[data-canonical-load-state="stale"]')).not.toBeNull();
    } finally {
      act(() => setRecoveryCardShowing(false));
    }
  });
});
