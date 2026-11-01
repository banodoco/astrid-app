import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  Suspense,
  type MutableRefObject
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Shot } from '@/domains/generation/types';
import { Button } from '@/shared/components/ui/button';
import { useCurrentShot } from '@/shared/state/selectionStore';
import { useIsMobile } from '@/shared/hooks/mobile';
import { useShotNavigation } from '@/shared/hooks/shots/useShotNavigation';
import { usePrimeShotImagesCache } from '@/shared/hooks/shots/useShotImages';
import { shotListLocation } from '@/shared/lib/tooling/toolRoutes.ts';
import { normalizeAndPresentError } from '@/shared/lib/errorHandling/runtimeError.ts';
import { useEnqueueGenerationsInvalidation } from '@/shared/hooks/invalidation/useGenerationInvalidation';
import { useProjectVideoCountsCache } from '@/shared/hooks/projects/useProjectVideoCountsCache';
import { useProjectGenerationModesCache } from '@/shared/hooks/projects/useProjectGenerationModesCache';
import { useVideoGalleryPreloader } from '@/shared/hooks/gallery/useVideoGalleryPreloader';
import { ShotSettingsEditor } from '../components/ShotEditor';
import {
  VideoTravelSettingsProvider,
  useVideoTravelSettingsMutations,
} from '../providers';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { VideoTravelFloatingOverlay } from '../components/VideoTravelFloatingOverlay';
import { useStickyHeader } from '../hooks/useStickyHeader';
import { useNavigationState } from '../hooks/navigation/useNavigationState';
import { useOperationTracking } from '../hooks/useOperationTracking';
import { usePanesStore } from '@/shared/state/panesStore';
import { hasRuntimeDocumentIdentity } from '@/app/runtime/runtimeDocument';
import type { LocalTimelineShotModel } from './localTimelineShotModel.ts';
import type {
  PreparedShotComposition,
  ShotCompositionAdapter,
} from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';
import type {
  CanonicalShotTimelineDraft,
  CanonicalShotTimelinePublication,
  CanonicalShotTimelineScope,
} from '@/tools/video-editor/runtime/ports.ts';
import {
  enqueueCanonicalShotPublish,
  updateCanonicalShotName,
  updateCanonicalShotSettings,
} from '@/tools/video-editor/data/shotCompositionEditor.ts';
import { ShotTimelinePreview } from '../components/ShotTimelinePreview.tsx';
import { normalizeVideoTravelSettings } from '../settings';

interface ShotEditorViewProps {
  /** The shot to edit */
  shotToEdit: Shot;
  /** Selected project ID */
  selectedProjectId: string;
  /** Whether this is a newly created shot */
  isNewlyCreatedShot: boolean;
  /** Shot data from navigation state (for optimistic updates) */
  shotFromState: Shot | undefined;
  /** Array of all shots (for navigation) */
  shots: Shot[] | undefined;
  /** Available LoRAs */
  /** Sort mode for shot navigation */
  shotSortMode?: 'ordered' | 'newest' | 'oldest';
  /** Canonical occurrence identity used by local/read-only composition views. */
  canonicalOccurrence?: Pick<LocalTimelineShotModel, 'occurrenceId' | 'shotId' | 'revisionId' | 'parentDocumentId' | 'stableDeepLink' | 'outputIdentity'> & { projectId?: string | null };
  /** The same adapter used by the overview; embedded canonical mode can publish shot revisions. */
  canonicalShotComposition?: ShotCompositionAdapter;
  /** Parent Runtime provider reused by the nested popup's A2 save funnel. */
  timelineDataProvider?: DataProvider;
  /** Prepared canonical graph shared by the overview and the shot-local preview. */
  canonicalComposition?: PreparedShotComposition;
  /** Optional embedded-mode close action; avoids navigating the parent route. */
  onClose?: () => void;
  /** Receives the durable graph after a canonical shot edit is published. */
  onCanonicalCompositionPublished?: (
    composition: PreparedShotComposition,
    publication?: CanonicalShotTimelinePublication,
  ) => void;
  onCanonicalDraftSessionChange?: (scope: CanonicalShotTimelineScope, active: boolean) => void;
  onCanonicalDraftProjectionChange?: (draft: CanonicalShotTimelineDraft) => void;
  onCanonicalDraftProjectionClear?: (scope: CanonicalShotTimelineScope, generation: number) => void;
  /** Reports unsaved shot-local edits so parent-head refreshes do not overwrite them. */
  onCanonicalDraftStateChange?: (dirty: boolean) => void;
}

/**
 * Shot editor view - wraps ShotSettingsEditor with all necessary setup.
 * Handles settings, navigation, and state coordination.
 */
export function ShotEditorView({
  shotToEdit,
  selectedProjectId,
  isNewlyCreatedShot,
  shotFromState,
  shots,
  shotSortMode = 'ordered',
  canonicalOccurrence,
  canonicalShotComposition,
  timelineDataProvider,
  canonicalComposition,
  onClose,
  onCanonicalCompositionPublished,
  onCanonicalDraftSessionChange,
  onCanonicalDraftProjectionChange,
  onCanonicalDraftProjectionClear,
  onCanonicalDraftStateChange,
}: ShotEditorViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const isLocalMode = hasRuntimeDocumentIdentity(location.search);
  const canEditCanonicalShot = Boolean(
    canonicalShotComposition?.publish && canonicalComposition && canonicalOccurrence,
  );
  const editorReadOnly = isLocalMode && !canEditCanonicalShot;

  const canonicalSettingsBase = useRef<{ scope: string; composition: PreparedShotComposition } | null>(null);
  const canonicalSettingsScope = canonicalComposition && canonicalOccurrence
    ? JSON.stringify([canonicalComposition.projectId, canonicalComposition.parentDocumentId, canonicalOccurrence.occurrenceId])
    : null;
  if (canonicalSettingsScope && canonicalComposition && canonicalSettingsBase.current?.scope !== canonicalSettingsScope) {
    canonicalSettingsBase.current = { scope: canonicalSettingsScope, composition: canonicalComposition };
  } else if (!canonicalSettingsScope) {
    canonicalSettingsBase.current = null;
  }

  const canonicalSettingsPersistence = useMemo(() => {
    if (!canEditCanonicalShot || !canonicalShotComposition || !canonicalComposition || !canonicalOccurrence) {
      return undefined;
    }

    const projectId = canonicalComposition.projectId;
    const parentDocumentId = canonicalComposition.parentDocumentId;
    const occurrenceId = canonicalOccurrence.occurrenceId;
    const publish = canonicalShotComposition.publish;

    return {
      domainKey: `canonical-shot-settings:${projectId}:${parentDocumentId}`,
      entityId: shotToEdit.id,
      load: async (_entityId: string) => {
        const current = await canonicalShotComposition.load({ projectId, parentDocumentId });
        canonicalSettingsBase.current = { scope: canonicalSettingsScope!, composition: current };
        const occurrence = current.occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);
        const settings = occurrence?.revision.settings;
        return settings && typeof settings === 'object' && !Array.isArray(settings)
          ? normalizeVideoTravelSettings(settings)
          : null;
      },
      save: async (_entityId: string, settings: Parameters<typeof normalizeVideoTravelSettings>[0]) => {
        if (!publish) throw new Error('The canonical shot-composition provider is read-only');
        const editingBase = canonicalSettingsBase.current;
        if (!editingBase || editingBase.scope !== canonicalSettingsScope) {
          throw new Error('The canonical shot-settings editing base is unavailable');
        }
        await enqueueCanonicalShotPublish(projectId, parentDocumentId, async () => {
          const current = editingBase.composition;
          const graph = await updateCanonicalShotSettings(current.contract, occurrenceId, settings as Record<string, unknown>);
          const published = await publish({
            projectId,
            parentDocumentId,
            expectedHeadRevisionId: current.headRevisionId,
            graph,
          });
          if (canonicalSettingsBase.current === editingBase) {
            canonicalSettingsBase.current = { scope: editingBase.scope, composition: published };
          }
          onCanonicalCompositionPublished?.(published);
        });
      },
    };
  }, [canEditCanonicalShot, canonicalComposition, canonicalOccurrence, canonicalSettingsScope, canonicalShotComposition, onCanonicalCompositionPublished, shotToEdit.id]);

  const { setCurrentShotId } = useCurrentShot();
  const { navigateToPreviousShot, navigateToNextShot } = useShotNavigation();
  const invalidateGenerations = useEnqueueGenerationsInvalidation();

  // Project caches
  const { getFinalVideoCount, getHasStructureVideo } = useProjectVideoCountsCache(selectedProjectId);
  const { updateShotMode } = useProjectGenerationModesCache(selectedProjectId);

  // Dimension state (local, not persisted)
  const [dimensionSource, setDimensionSource] = useState<'project' | 'firstImage' | 'custom'>('firstImage');
  const [customWidth, setCustomWidth] = useState<number | undefined>(undefined);
  const [customHeight, setCustomHeight] = useState<number | undefined>(undefined);

  const handleDimensionSourceChange = useCallback((source: 'project' | 'firstImage' | 'custom') => {
    setDimensionSource(source);
  }, []);

  const handleCustomWidthChange = useCallback((width?: number) => {
    setCustomWidth(width);
  }, []);

  const handleCustomHeightChange = useCallback((height?: number) => {
    setCustomHeight(height);
  }, []);

  // Navigation state
  const { sortedShots, hasPrevious, hasNext } = useNavigationState({
    shots,
    shotSortMode,
    selectedShot: shotToEdit,
  });

  // Video gallery thumbnail preloader
  useVideoGalleryPreloader({
    selectedShot: shotToEdit,
    shouldShowShotEditor: true,
  });

  // Operation tracking
  const {
    setIsDraggingInTimeline,
    signalShotOperation,
  } = useOperationTracking();

  // Prime the shot images cache with context data for instant display
  const contextImages = shotToEdit.images || [];
  usePrimeShotImagesCache(shotToEdit.id, contextImages);
  // NOTE: useShotImages query is active in useShotEditorSetup — no need for a
  // duplicate observer here. The duplicate caused ShotEditorView to re-render
  // on every query state change (loading→success), cascading to all children.

  // Sticky header
  const headerContainerRef = useRef<HTMLDivElement>(null) as MutableRefObject<HTMLDivElement | null>;
  const [headerReady, setHeaderReady] = useState(false);
  const headerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    headerContainerRef.current = node;
    setHeaderReady(!!node);
  }, []);

  const nameClickRef = useRef<(() => void) | null>(null);

  const stickyHeader = useStickyHeader({
    headerRef: headerContainerRef,
    isMobile,
    enabled: headerReady
  });

  // Pane widths for floating overlay
  const isShotsPaneLocked = usePanesStore((state) => state.isShotsPaneLocked);
  const shotsPaneWidth = usePanesStore((state) => state.shotsPaneWidth);
  const isTasksPaneLocked = usePanesStore((state) => state.isTasksPaneLocked);
  const tasksPaneWidth = usePanesStore((state) => state.tasksPaneWidth);

  // Navigation handlers
  const handleBackToShotList = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    setCurrentShotId(null);
    const localScope = hasRuntimeDocumentIdentity(location.search);
    navigate(
      localScope
        ? shotListLocation(location.pathname, location.search)
        : location.pathname,
      { replace: true, state: { fromShotClick: false } },
    );
  }, [location.pathname, location.search, navigate, onClose, setCurrentShotId]);

  const handlePreviousShot = useCallback(() => {
    if (sortedShots && shotToEdit) {
      navigateToPreviousShot(sortedShots, shotToEdit, { scrollToTop: true });
    }
  }, [sortedShots, shotToEdit, navigateToPreviousShot]);

  const handleNextShot = useCallback(() => {
    if (sortedShots && shotToEdit) {
      navigateToNextShot(sortedShots, shotToEdit, { scrollToTop: true });
    }
  }, [sortedShots, shotToEdit, navigateToNextShot]);

  const handlePreviousShotNoScroll = useCallback(() => {
    if (sortedShots && shotToEdit) {
      navigateToPreviousShot(sortedShots, shotToEdit, { scrollToTop: false });
    }
  }, [sortedShots, shotToEdit, navigateToPreviousShot]);

  const handleNextShotNoScroll = useCallback(() => {
    if (sortedShots && shotToEdit) {
      navigateToNextShot(sortedShots, shotToEdit, { scrollToTop: false });
    }
  }, [sortedShots, shotToEdit, navigateToNextShot]);

  const canRenameCanonicalShot = Boolean(
    canonicalSettingsPersistence && canonicalShotComposition && canonicalComposition && canonicalOccurrence,
  );

  const handleUpdateShotName = useCallback((newName: string) => {
    if (!canonicalSettingsPersistence || !canonicalShotComposition || !canonicalComposition || !canonicalOccurrence) {
      return;
    }
    const editingBase = canonicalComposition;
    void enqueueCanonicalShotPublish(
      editingBase.projectId,
      canonicalComposition.parentDocumentId,
      async () => {
        const current = editingBase;
        const graph = await updateCanonicalShotName(current.contract, canonicalOccurrence.occurrenceId, newName);
        const published = await canonicalShotComposition.publish?.({
          projectId: current.projectId,
          parentDocumentId: current.parentDocumentId,
          expectedHeadRevisionId: current.headRevisionId,
          graph,
        });
        if (published) onCanonicalCompositionPublished?.(published);
      },
    ).catch((error: unknown) => {
      normalizeAndPresentError(error, {
        context: 'canonical-shot:update-name',
        toastTitle: 'Failed to save shot name',
      });
    });
  }, [canonicalComposition, canonicalOccurrence, canonicalSettingsPersistence, canonicalShotComposition, onCanonicalCompositionPublished]);

  const handleShotImagesUpdate = useCallback(async () => {
    invalidateGenerations(shotToEdit.id, {
      reason: 'shot-operation-complete',
      scope: 'all',
      includeShots: true,
      projectId: selectedProjectId
    });
    signalShotOperation();
  }, [selectedProjectId, shotToEdit.id, invalidateGenerations, signalShotOperation]);

  const handleFloatingHeaderNameClick = useCallback(() => {
    if (editorReadOnly) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => {
      if (nameClickRef.current) {
        nameClickRef.current();
      }
    }, 600);
  }, [editorReadOnly]);

  return (
    <>
      <div
        className="px-4 max-w-7xl mx-auto pt-4"
        data-canonical-occurrence-id={canonicalOccurrence?.occurrenceId}
        data-canonical-project-id={canonicalOccurrence?.projectId ?? selectedProjectId}
        data-canonical-parent-document-id={canonicalOccurrence?.parentDocumentId}
        data-canonical-shot-id={canonicalOccurrence?.shotId}
        data-canonical-revision-id={canonicalOccurrence?.revisionId}
        data-canonical-deep-link={canonicalOccurrence?.stableDeepLink}
        data-canonical-output-identity={canonicalOccurrence?.outputIdentity}
        data-canonical-adapter={canonicalShotComposition ? 'shot-composition' : undefined}
      >
        {canonicalComposition && canonicalOccurrence ? (
          <ShotTimelinePreview
            composition={canonicalComposition}
            occurrenceId={canonicalOccurrence.occurrenceId}
            shotCompositionAdapter={canonicalShotComposition}
            timelineDataProvider={timelineDataProvider}
            onCanonicalCompositionPublished={onCanonicalCompositionPublished}
            onCanonicalDraftSessionChange={onCanonicalDraftSessionChange}
            onCanonicalDraftProjectionChange={onCanonicalDraftProjectionChange}
            onCanonicalDraftProjectionClear={onCanonicalDraftProjectionClear}
            onCanonicalDraftStateChange={onCanonicalDraftStateChange}
          />
        ) : null}
        <Suspense fallback={<LoadingSkeleton type="editor" />}>
          <VideoTravelSettingsProvider
            projectId={selectedProjectId}
            shotId={shotToEdit.id}
            selectedShot={shotToEdit}
            updateShotMode={updateShotMode}
            shotSettingsPersistence={canonicalSettingsPersistence}
          >
            <SettingsAutoDisable shotId={shotToEdit.id} readOnly={editorReadOnly} />
            <ShotSettingsEditor
              // Core identifiers
              selectedShotId={shotToEdit.id}
              projectId={selectedProjectId}
              canonicalOnly={Boolean(canonicalComposition && canonicalOccurrence)}
              optimisticShotData={isNewlyCreatedShot ? shotFromState : undefined}
              // Callbacks
              onShotImagesUpdate={handleShotImagesUpdate}
              onBack={handleBackToShotList}
              // Dimension settings
              dimensionSource={dimensionSource}
              onDimensionSourceChange={handleDimensionSourceChange}
              customWidth={customWidth}
              onCustomWidthChange={handleCustomWidthChange}
              customHeight={customHeight}
              onCustomHeightChange={handleCustomHeightChange}
              // Navigation
              onPreviousShot={handlePreviousShot}
              onNextShot={handleNextShot}
              hasPrevious={hasPrevious}
              hasNext={hasNext}
              onUpdateShotName={editorReadOnly || !canRenameCanonicalShot ? undefined : handleUpdateShotName}
              readOnly={editorReadOnly}
              // Loading and cache
              getFinalVideoCount={getFinalVideoCount}
              getHasStructureVideo={getHasStructureVideo}
              // UI coordination
              onDragStateChange={setIsDraggingInTimeline}
              headerContainerRef={headerCallbackRef}
              nameClickRef={nameClickRef}
              isSticky={stickyHeader.isSticky}
            />
          </VideoTravelSettingsProvider>
        </Suspense>
      </div>

      {/* Floating sticky header */}
      <VideoTravelFloatingOverlay
        sticky={{
          shouldShowShotEditor: true,
          readOnly: editorReadOnly,
          stickyHeader,
          shotToEdit,
          isMobile,
          isShotsPaneLocked,
          shotsPaneWidth,
          isTasksPaneLocked,
          tasksPaneWidth,
          hasPrevious,
          hasNext,
          onPreviousShot: handlePreviousShotNoScroll,
          onNextShot: handleNextShotNoScroll,
          onBackToShotList: handleBackToShotList,
          onFloatingHeaderNameClick: handleFloatingHeaderNameClick,
        }}
      />
    </>
  );
}

/**
 * Renderless component that auto-disables conflicting settings.
 * Lives inside VideoTravelSettingsProvider to access settings context.
 */
function SettingsAutoDisable({ shotId, readOnly }: {
  shotId: string;
  readOnly?: boolean;
}) {
  const { settings, status, shotId: loadedShotId, updateFields } =
    useVideoTravelSettingsMutations();
  const { turboMode = false, advancedMode = false } = settings;

  // Auto-disable advanced mode when turbo mode is on
  useEffect(() => {
    if (readOnly || status !== 'ready' || loadedShotId !== shotId) return;
    if (turboMode && advancedMode) updateFields({ advancedMode: false, motionMode: 'basic' });
  }, [turboMode, advancedMode, status, loadedShotId, shotId, updateFields, readOnly]);

  return null;
}

/**
 * Loading state shown while waiting for shot data.
 */
export function ShotEditorLoading() {
  return (
    <div className="px-4 max-w-7xl mx-auto pt-4">
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading shot...</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Error state shown when shot is not found.
 */
export function ShotEditorNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="px-4 max-w-7xl mx-auto pt-4">
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Shot not found</p>
          <Button onClick={onBack} variant="outline" size="sm">
            Back to Shots
          </Button>
        </div>
      </div>
    </div>
  );
}
