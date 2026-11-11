import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  type RefObject,
} from 'react';
import { useRenderLogger } from '@/shared/lib/debug/debugRendering';
import { useSlidingPane } from '@/shared/hooks/useSlidingPane';
import { useNavigate, useLocation } from 'react-router-dom';
import { TOOL_ROUTES } from '@/shared/lib/tooling/toolRoutes';
import { type GalleryFilterState } from '@/shared/components/MediaGallery';
import { useGalleryPageState } from '@/features/gallery/hooks/useGalleryPageState';
import { useCurrentShot } from '@/shared/state/selectionStore';
import { usePanesStore } from '@/shared/state/panesStore';
import { useLightboxOpenState } from '@/shared/state/lightboxOpenState';
import { useShots } from '@/shared/contexts/ShotsContext';
import {
  useProjectCrudContext,
  useProjectSelectionContext,
} from '@/shared/contexts/ProjectContext';
import { useStableObject } from '@/shared/hooks/useStableObject';
import { usePaneInteractionLifecycle } from '@/shared/components/panes/usePaneInteractionLifecycle';
import { SHOT_FILTER, isSpecialFilter } from '@/shared/constants/filterConstants';
import { computePaneLayout } from '../lib/paneGridLayout';
import { resolvePaneDisplay, usePaneGeometry } from '../lib/paneGeometry';
import { describeEmptyState, type EmptyStateShotScope } from '../lib/emptyState';
import { useAppEventListener } from '@/shared/lib/typedEvents';
import { withRuntimeDocumentParams } from '@/app/runtime/runtimeDocument';
import { useResolvedGalleryProject } from '@/app/runtime/useResolvedGalleryProject';
import { isVideoEditorShellActiveForLocation } from '@/app/hooks/useVideoEditorRouteState';
import { useOptionalAgentChatBridge } from '@/shared/contexts/AgentChatContext';
import {
  ADD_GENERATION_PROJECT_PARAM,
  ADD_GENERATION_TIMELINE_PARAM,
  ADD_GENERATION_QUERY_PARAM,
} from '@/domains/media-lightbox/hooks/addToVideoEditorConstants';

type MediaTypeFilter = 'all' | 'image' | 'video' | 'audio';
const MEDIA_TYPE_SESSION_KEY = 'astrid.generationsPane.mediaType';

function readSessionMediaType(): MediaTypeFilter | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.sessionStorage.getItem(MEDIA_TYPE_SESSION_KEY);
    return value === 'all' || value === 'image' || value === 'video' || value === 'audio' ? value : null;
  } catch {
    return null;
  }
}

function saveSessionMediaType(value: MediaTypeFilter): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(MEDIA_TYPE_SESSION_KEY, value);
  } catch {
    // The current component state still remembers the choice when storage is unavailable.
  }
}

type BooleanStateSetter = (value: boolean) => void;
type GalleryPageState = ReturnType<typeof useGalleryPageState>;

interface GenerationDataParams {
  itemsPerPage: number;
  mediaTypeFilter: MediaTypeFilter;
  shouldEnableDataLoading: boolean;
  runtimeProjectId: string | null;
  runtimeAuthority: boolean;
}

const useGenerationData = ({
  itemsPerPage,
  mediaTypeFilter,
  shouldEnableDataLoading,
  runtimeProjectId,
  runtimeAuthority,
}: GenerationDataParams) => {
  const { shots: contextShots } = useShots();

  const galleryPageState = useGalleryPageState({
    itemsPerPage,
    mediaType: mediaTypeFilter,
    enableDataLoading: shouldEnableDataLoading,
    ...(runtimeProjectId ? { runtimeProjectId } : {}),
    runtimeAuthority,
  });
  const shotsForFilter = (galleryPageState.shotsData && galleryPageState.shotsData.length > 0)
    ? galleryPageState.shotsData
    : (contextShots || []);

  return {
    ...galleryPageState,
    shotsForFilter,
  };
};

interface GenerationFiltersParams {
  mediaTypeFilter: MediaTypeFilter;
  setMediaTypeFilter: (value: MediaTypeFilter) => void;
  selectedShotFilter: GalleryPageState['selectedShotFilter'];
  excludePositioned: GalleryPageState['excludePositioned'];
  starredOnly: GalleryPageState['starredOnly'];
  searchTerm: GalleryPageState['searchTerm'];
  setSelectedShotFilter: GalleryPageState['setSelectedShotFilter'];
  setExcludePositioned: GalleryPageState['setExcludePositioned'];
  setStarredOnly: GalleryPageState['setStarredOnly'];
  setSearchTerm: GalleryPageState['setSearchTerm'];
}

const useGenerationFilters = ({
  mediaTypeFilter,
  setMediaTypeFilter,
  selectedShotFilter,
  excludePositioned,
  starredOnly,
  searchTerm,
  setSelectedShotFilter,
  setExcludePositioned,
  setStarredOnly,
  setSearchTerm,
}: GenerationFiltersParams) => {
  const [shotFilterOpen, setShotFilterOpen] = useState(false);
  const [mediaTypeFilterOpen, setMediaTypeFilterOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null!);
  const shotFilterContentRef = useRef<HTMLDivElement>(null!);
  const mediaTypeContentRef = useRef<HTMLDivElement>(null!);

  const generationFilters = useStableObject(() => ({
    mediaType: mediaTypeFilter,
    shotId: selectedShotFilter === SHOT_FILTER.ALL ? undefined : selectedShotFilter,
    excludePositioned: selectedShotFilter !== SHOT_FILTER.ALL ? excludePositioned : undefined,
    starredOnly,
  }), [mediaTypeFilter, selectedShotFilter, excludePositioned, starredOnly]);

  const galleryFilters = useMemo((): GalleryFilterState => ({
    mediaType: mediaTypeFilter,
    shotFilter: selectedShotFilter,
    excludePositioned,
    searchTerm,
    starredOnly,
    toolTypeFilter: false,
  }), [mediaTypeFilter, selectedShotFilter, excludePositioned, searchTerm, starredOnly]);

  const handleGalleryFiltersChange = useCallback((newFilters: GalleryFilterState) => {
    setSelectedShotFilter(newFilters.shotFilter);
    setExcludePositioned(newFilters.excludePositioned);
    setSearchTerm(newFilters.searchTerm);
    setStarredOnly(newFilters.starredOnly);
    setMediaTypeFilter(newFilters.mediaType);
  }, [setSelectedShotFilter, setExcludePositioned, setSearchTerm, setStarredOnly, setMediaTypeFilter]);

  return {
    excludePositioned,
    galleryFilters,
    generationFilters,
    handleGalleryFiltersChange,
    isSearchOpen,
    mediaTypeContentRef,
    mediaTypeFilter,
    mediaTypeFilterOpen,
    searchInputRef,
    searchTerm,
    selectedShotFilter,
    setExcludePositioned,
    setIsSearchOpen,
    setMediaTypeFilter,
    setMediaTypeFilterOpen,
    setSelectedShotFilter,
    setShotFilterOpen,
    setStarredOnly,
    setSearchTerm,
    shotFilterContentRef,
    shotFilterOpen,
    starredOnly,
  };
};

interface PaneLifecycleParams {
  isGenerationsPaneLocked: boolean;
  setIsGenerationsPaneLocked: BooleanStateSetter;
  setIsGenerationsPaneOpen: BooleanStateSetter;
  isOnImageGenerationPage: boolean;
  shotFilterContentRef: RefObject<HTMLDivElement>;
  mediaTypeContentRef: RefObject<HTMLDivElement>;
  setShotFilterOpen: BooleanStateSetter;
  setMediaTypeFilterOpen: BooleanStateSetter;
}

const usePaneLifecycle = ({
  isGenerationsPaneLocked,
  setIsGenerationsPaneLocked,
  setIsGenerationsPaneOpen,
  isOnImageGenerationPage,
  shotFilterContentRef,
  mediaTypeContentRef,
  setShotFilterOpen,
  setMediaTypeFilterOpen,
}: PaneLifecycleParams) => {
  const isLightboxOpen = useLightboxOpenState();
  const isGenerationsPaneOpen = usePanesStore((state) => state.isGenerationsPaneOpen);
  const {
    isLocked,
    isOpen,
    toggleLock,
    openPane,
    paneProps,
    transformClass,
    handlePaneEnter,
    handlePaneLeave,
    showBackdrop,
    closePane,
  } = useSlidingPane({
    side: 'bottom',
    isLocked: isGenerationsPaneLocked,
    onToggleLock: () => setIsGenerationsPaneLocked(!isGenerationsPaneLocked),
    additionalRefs: [shotFilterContentRef, mediaTypeContentRef],
    overlayOpen: isLightboxOpen && isGenerationsPaneOpen,
  });
  const paneIsOpen = Boolean(isOpen);

  const handlePaneOpenStart = useCallback(() => {
    setShotFilterOpen(false);
    setMediaTypeFilterOpen(false);
  }, [setMediaTypeFilterOpen, setShotFilterOpen]);

  const { isPointerEventsEnabled, isInteractionDisabled } = usePaneInteractionLifecycle({
    isOpen: paneIsOpen,
    disableInteractionsDuringOpen: true,
    onOpenStart: handlePaneOpenStart,
  });

  const handleOpenGenerationsPane = useCallback(() => {
    openPane();
  }, [openPane]);
  useAppEventListener('openGenerationsPane', handleOpenGenerationsPane);

  useEffect(() => {
    setIsGenerationsPaneOpen(paneIsOpen);
  }, [paneIsOpen, setIsGenerationsPaneOpen]);

  useEffect(() => {
    if (isOnImageGenerationPage && (paneIsOpen || isLocked)) {
      setIsGenerationsPaneLocked(false);
    }
  }, [isOnImageGenerationPage, paneIsOpen, isLocked, setIsGenerationsPaneLocked]);

  return {
    closePane,
    handlePaneEnter,
    handlePaneLeave,
    isInteractionDisabled,
    isLocked,
    isPointerEventsEnabled,
    openPane,
    paneIsOpen,
    paneProps,
    showBackdrop: showBackdrop && !isLightboxOpen,
    toggleLock: (force?: boolean) => {
      if (isLocked && force !== true && isLightboxOpen) {
        // Release the viewer's hold as well as the lock.
        closePane();
        setIsGenerationsPaneOpen(false);
      }
      toggleLock(force);
    },
    transformClass,
  };
};

export const useGenerationsPaneController = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isVideoEditorShellActive = isVideoEditorShellActiveForLocation(
    location.pathname,
    location.search,
  );
  const selectedEditor = useOptionalAgentChatBridge()?.editorContext;
  const isGenerationsPaneLocked = usePanesStore((state) => state.isGenerationsPaneLocked);
  const setIsGenerationsPaneLocked = usePanesStore((state) => state.setIsGenerationsPaneLocked);
  const isGenerationsPaneOpen = usePanesStore((state) => state.isGenerationsPaneOpen);
  const setIsGenerationsPaneOpen = usePanesStore((state) => state.setIsGenerationsPaneOpen);
  const generationsPaneHeight = usePanesStore((state) => state.generationsPaneHeight);
  const isShotsPaneLocked = usePanesStore((state) => state.isShotsPaneLocked);
  const shotsPaneWidth = usePanesStore((state) => state.shotsPaneWidth);
  const isTasksPaneLocked = usePanesStore((state) => state.isTasksPaneLocked);
  const tasksPaneWidth = usePanesStore((state) => state.tasksPaneWidth);
  const isEditorPaneLocked = usePanesStore((state) => state.isEditorPaneLocked);
  const { selectedProjectId } = useProjectSelectionContext();
  const { projects } = useProjectCrudContext();
  const { currentShotId } = useCurrentShot();

  const resolvedGalleryProject = useResolvedGalleryProject();

  const isOnImageGenerationPage = location.pathname === TOOL_ROUTES.IMAGE_GENERATION;
  const currentProject = projects.find((project) => project.id === selectedProjectId);
  const projectAspectRatio = currentProject?.aspectRatio;
  // A locked pane is visible immediately even when it was opened from the
  // closed tab, so keep its Runtime gallery query enabled in that state too.
  const shouldEnableDataLoading = !isOnImageGenerationPage
    && (isGenerationsPaneOpen || isGenerationsPaneLocked);

  const setGenerationsPaneContentHeight = usePanesStore((state) => state.setGenerationsPaneContentHeight);
  const { galleryContainerRef, geometry, isMobile, measured } = usePaneGeometry(
    projectAspectRatio,
    isEditorPaneLocked,
    generationsPaneHeight,
  );
  // Stage 1: columns and page size come from the width and the cap only, never from the item count.
  const stage1 = useMemo(
    () => computePaneLayout({ ...geometry, itemCount: geometry.baseCols * geometry.maxRows }),
    [geometry],
  );
  const stage1Cols = measured ? stage1.cols : geometry.baseCols;

  const [savedMediaTypeFilter] = useState(readSessionMediaType);
  const [mediaTypeFilter, setMediaTypeFilterState] = useState<MediaTypeFilter>(savedMediaTypeFilter ?? 'all');
  const setMediaTypeFilter = useCallback((next: MediaTypeFilter) => {
    saveSessionMediaType(next);
    setMediaTypeFilterState(next);
  }, []);
  const generationData = useGenerationData({
    itemsPerPage: stage1Cols * geometry.maxRows,
    mediaTypeFilter,
    shouldEnableDataLoading,
    runtimeProjectId: resolvedGalleryProject.projectId,
    runtimeAuthority: resolvedGalleryProject.runtimeAuthority,
  });

  const filters = useGenerationFilters({
    mediaTypeFilter,
    setMediaTypeFilter,
    selectedShotFilter: generationData.selectedShotFilter,
    excludePositioned: generationData.excludePositioned,
    starredOnly: generationData.starredOnly,
    searchTerm: generationData.searchTerm,
    setSelectedShotFilter: generationData.setSelectedShotFilter,
    setExcludePositioned: generationData.setExcludePositioned,
    setStarredOnly: generationData.setStarredOnly,
    setSearchTerm: generationData.setSearchTerm,
  });

  const pane = usePaneLifecycle({
    isGenerationsPaneLocked,
    setIsGenerationsPaneLocked,
    setIsGenerationsPaneOpen,
    isOnImageGenerationPage,
    shotFilterContentRef: filters.shotFilterContentRef,
    mediaTypeContentRef: filters.mediaTypeContentRef,
    setShotFilterOpen: filters.setShotFilterOpen,
    setMediaTypeFilterOpen: filters.setMediaTypeFilterOpen,
  });

  const [isGenerationModalOpen, setIsGenerationModalOpen] = useState(false);

  const handleNavigateToImageGeneration = useCallback(() => {
    setIsGenerationsPaneLocked(false);
    navigate(withRuntimeDocumentParams(TOOL_ROUTES.IMAGE_GENERATION, location.search));
  }, [location.search, navigate, setIsGenerationsPaneLocked]);

  // The gallery lists the route's project, but an add lands in the selected editor, which can be another project's
  // (a dialog). The Runtime refuses an object another project owns, so that add is refused here instead of sent.
  const addTargetProjectMismatch = Boolean(
    selectedEditor?.projectId
    && resolvedGalleryProject.projectId
    && selectedEditor.projectId !== resolvedGalleryProject.projectId,
  );

  const handleAddGenerationToTimeline = useCallback((generationId: string) => {
    if (addTargetProjectMismatch) return;
    const nextSearch = new URLSearchParams(location.search);
    nextSearch.set(ADD_GENERATION_QUERY_PARAM, generationId);
    nextSearch.delete(ADD_GENERATION_PROJECT_PARAM);
    nextSearch.delete(ADD_GENERATION_TIMELINE_PARAM);
    if (selectedEditor?.projectId && selectedEditor.timelineId) {
      nextSearch.set(ADD_GENERATION_PROJECT_PARAM, selectedEditor.projectId);
      nextSearch.set(ADD_GENERATION_TIMELINE_PARAM, selectedEditor.timelineId);
    }
    navigate({ pathname: location.pathname, search: `?${nextSearch.toString()}` });
  }, [addTargetProjectMismatch, location.pathname, location.search, navigate, selectedEditor?.projectId, selectedEditor?.timelineId]);

  // Stage 2: the rows follow the set size. The Runtime total is a look-ahead while more pages exist, which
  // is still >= the page size, so the rows stay stable across pages of one set. Until a response arrives,
  // keep the last known count so the height does not jump while a query is in flight.
  const responseTotal = generationData.generationsResponse === undefined ? undefined : generationData.totalCount;
  const lastItemCountRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (responseTotal !== undefined) lastItemCountRef.current = responseTotal;
  }, [responseTotal]);
  const itemCount = responseTotal ?? lastItemCountRef.current ?? stage1Cols * geometry.maxRows;
  const paneLayout = resolvePaneDisplay(geometry, stage1, stage1Cols, itemCount);

  // Publish the content height so the pane, its tab and the layout follow it. The image generation page hides the pane.
  const publishedContentHeight = isOnImageGenerationPage ? null : Math.round(paneLayout.paneHeight);
  useEffect(() => {
    setGenerationsPaneContentHeight(publishedContentHeight);
  }, [publishedContentHeight, setGenerationsPaneContentHeight]);
  useEffect(() => () => setGenerationsPaneContentHeight(null), [setGenerationsPaneContentHeight]);

  const selectedShotFilter = generationData.selectedShotFilter;
  const shotScope: EmptyStateShotScope = selectedShotFilter === SHOT_FILTER.ALL
    ? { kind: 'all' }
    : selectedShotFilter === SHOT_FILTER.NO_SHOT
      ? { kind: 'none' }
      : { kind: 'shot', name: generationData.shotsForFilter.find((shot) => shot.id === selectedShotFilter)?.name };
  const emptyDescription = describeEmptyState({
    mediaType: mediaTypeFilter,
    starredOnly: generationData.starredOnly,
    searchTerm: generationData.searchTerm,
    shotScope,
  });
  const showEverything = () => {
    setMediaTypeFilter('all');
    filters.setStarredOnly(false);
    filters.setSearchTerm('');
    filters.setIsSearchOpen(false);
    filters.setSelectedShotFilter(SHOT_FILTER.ALL);
    filters.setExcludePositioned(false);
  };

  useRenderLogger('GenerationsPane', {
    page: generationData.page,
    totalItems: generationData.totalCount,
  });

  return {
    pane: {
      ...pane,
      generationsPaneHeight,
      isOnImageGenerationPage,
      isShotsPaneLocked,
      isTasksPaneLocked,
      shotsPaneWidth,
      tasksPaneWidth,
    },
    filters: {
      ...filters,
      currentShotId,
      isSpecialFilterSelected: isSpecialFilter(filters.selectedShotFilter),
      shotsForFilter: generationData.shotsForFilter,
    },
    gallery: {
      error: resolvedGalleryProject.error ?? generationData.error,
      runtimeProjectId: resolvedGalleryProject.projectId,
      runtimeAuthority: resolvedGalleryProject.runtimeAuthority,
      handleAddToShot: generationData.handleAddToShot,
      handleAddToShotWithoutPosition: generationData.handleAddToShotWithoutPosition,
      handleServerPageChange: generationData.handleServerPageChange,
      isLoading: resolvedGalleryProject.isResolving || generationData.isLoading,
      lastAffectedShotId: generationData.lastAffectedShotId,
      page: generationData.page,
      paginatedData: generationData.paginatedData,
      shotsData: generationData.shotsData,
      totalCount: generationData.totalCount,
      totalIsExact: generationData.totalIsExact,
      readOnly: resolvedGalleryProject.runtimeAuthority,
      emptyState: {
        message: emptyDescription.message,
        onShowEverything: emptyDescription.hasActiveFilters ? showEverything : undefined,
      },
      config: resolvedGalleryProject.runtimeAuthority ? {
        showDelete: false,
        showStar: false,
        showAddToShot: false,
        showEdit: false,
      } : undefined,
    },
    layout: {
      galleryContainerRef,
      isMobile,
      paneLayout,
      projectAspectRatio,
    },
    modal: {
      isGenerationModalOpen,
      setIsGenerationModalOpen,
    },
    navigation: {
      handleNavigateToImageGeneration,
      handleAddGenerationToTimeline,
      addTargetProjectMismatch,
      isVideoEditorShellActive,
    },
  };
};
