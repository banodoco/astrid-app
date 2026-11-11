import React from 'react';
import { Sparkles, Images } from 'lucide-react';
import { cn } from '@/shared/components/ui/contracts/cn';
import { ImageGenerationModal } from '@/shared/components/modals/ImageGenerationModal';
import { PaneControlTab } from '@/shared/components/PaneControlTab';
import { GenerationsPaneControls } from './components/GenerationsPaneControls';
import { GenerationsPaneGallery } from './components/GenerationsPaneGallery';
import { GenerationsPaneFrame } from './components/GenerationsPaneFrame';
import { GenerationsDropChip } from './components/GenerationsDropChip';
import { useGenerationsPaneController } from './hooks/useGenerationsPaneController';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';
import { usePanesStore } from '@/shared/state/panesStore';
import { usePaneControlsHosted } from '@/shared/state/paneControlsHost';

type GenerationsPaneController = ReturnType<typeof useGenerationsPaneController>;

function GenerationsPaneBackdrop({ controller }: { controller: GenerationsPaneController }) {
  const { pane } = controller;

  if (!pane.showBackdrop) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 touch-none"
      style={{ zIndex: UI_Z_LAYERS.GENERATIONS_PANE_BACKDROP }}
      onTouchStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
        pane.closePane();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        pane.closePane();
      }}
      aria-hidden="true"
    />
  );
}

function GenerationsPaneTab({ controller }: { controller: GenerationsPaneController }) {
  const { pane, navigation, modal } = controller;
  const { isVideoEditorShellActive } = navigation;
  const effectiveGenerationsPaneHeight = usePanesStore((state) => state.effectiveGenerationsPaneHeight);

  if (pane.isOnImageGenerationPage) {
    return null;
  }

  return (
    <PaneControlTab
      position={{
        side: "bottom",
        paneDimension: effectiveGenerationsPaneHeight,
        horizontalOffset:
          (pane.isShotsPaneLocked ? pane.shotsPaneWidth : 0) -
          (pane.isTasksPaneLocked ? pane.tasksPaneWidth : 0),
      }}
      state={{ isLocked: pane.isLocked, isOpen: pane.paneIsOpen }}
      handlers={{
        toggleLock: pane.toggleLock,
        openPane: pane.openPane,
        handlePaneEnter: pane.handlePaneEnter,
        handlePaneLeave: pane.handlePaneLeave,
        customOpenAction: pane.openPane,
      }}
      display={{
        customIcon: <Images className="h-4 w-4" />,
        paneTooltip: "Open Gallery",
        allowMobileLock: true,
        shortcutHint: '⌥S',
      }}
      actions={{
        thirdButton: !isVideoEditorShellActive ? {
          onClick: navigation.handleNavigateToImageGeneration,
          ariaLabel: 'Go to Image Generation tool',
          tooltip: 'Go to Image Generation tool (⌥⇧S)',
          content: <Images className="h-4 w-4" />,
        } : undefined,
        fourthButton: !isVideoEditorShellActive ? {
          onClick: () => modal.setIsGenerationModalOpen(true),
          ariaLabel: 'Generate new image',
          tooltip: 'Generate new image',
          content: <Sparkles className="h-4 w-4" />,
        } : undefined,
      }}
    />
  );
}

function GenerationsPaneSurface({ controller }: { controller: GenerationsPaneController }) {
  const { pane, filters, gallery, layout, navigation } = controller;
  const effectiveGenerationsPaneHeight = usePanesStore((state) => state.effectiveGenerationsPaneHeight);
  // Opened from a page that hosts it (the touch editor), the gallery is a temporary sheet over
  // the timeline: adding media closes it, so the new clip is in view.
  const paneControlsHosted = usePaneControlsHosted();
  const addGenerationToTimeline = (generationId: string) => {
    navigation.handleAddGenerationToTimeline(generationId);
    if (paneControlsHosted) pane.closePane();
  };

  // The Image Generation tool owns the full-page gallery. Keep the app-shell
  // generations pane out of that route, including when it was left hovered or
  // locked open before navigation.
  if (pane.isOnImageGenerationPage) {
    return null;
  }

  return (
    <GenerationsPaneFrame
      {...pane.paneProps}
      data-testid="generations-pane"
      height={effectiveGenerationsPaneHeight}
      left={pane.isShotsPaneLocked ? pane.shotsPaneWidth : 0}
      right={pane.isTasksPaneLocked ? pane.tasksPaneWidth : 0}
      transformClass={pane.transformClass}
    >
      <div
        className={cn(
          'flex flex-col h-full min-h-0',
          pane.isPointerEventsEnabled ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <GenerationsPaneControls
          filters={{
            shots: filters.shotsForFilter,
            selectedShotFilter: filters.selectedShotFilter,
            onSelectedShotFilterChange: filters.setSelectedShotFilter,
            excludePositioned: filters.excludePositioned,
            onExcludePositionedChange: filters.setExcludePositioned,
            isMobile: layout.isMobile,
            shotFilterContentRef: filters.shotFilterContentRef,
            mediaTypeFilterContentRef: filters.mediaTypeContentRef,
            shotFilterOpen: filters.shotFilterOpen,
            onShotFilterOpenChange: filters.setShotFilterOpen,
            mediaTypeFilter: filters.mediaTypeFilter,
            onMediaTypeFilterChange: filters.setMediaTypeFilter,
            mediaTypeFilterOpen: filters.mediaTypeFilterOpen,
            onMediaTypeFilterOpenChange: filters.setMediaTypeFilterOpen,
            searchTerm: filters.searchTerm,
            onSearchTermChange: filters.setSearchTerm,
            isSearchOpen: filters.isSearchOpen,
            onSearchOpenChange: filters.setIsSearchOpen,
            searchInputRef: filters.searchInputRef,
            starredOnly: filters.starredOnly,
            onStarredOnlyChange: filters.setStarredOnly,
            currentShotId: filters.currentShotId,
            isSpecialFilterSelected: filters.isSpecialFilterSelected,
          }}
          pagination={{
            totalCount: gallery.totalCount,
            totalIsExact: gallery.totalIsExact,
            perPage: layout.paneLayout.itemsPerPage,
            page: gallery.page,
            onPageChange: gallery.handleServerPageChange,
          }}
          interaction={{ isInteractionDisabled: pane.isInteractionDisabled }}
        />

        <GenerationsPaneGallery
          containerRef={layout.galleryContainerRef}
          projectAspectRatio={layout.projectAspectRatio}
          layout={{
            cols: layout.paneLayout.cols,
            rows: layout.paneLayout.rows,
            itemsPerPage: layout.paneLayout.itemsPerPage,
            gridWidth: layout.paneLayout.gridWidth,
          }}
          loading={{
            isLoading: gallery.isLoading,
          }}
          pagination={{ page: gallery.page, totalCount: gallery.totalCount }}
          error={gallery.error}
          gallery={{
            runtimeProjectId: gallery.runtimeProjectId,
            runtimeAuthority: gallery.runtimeAuthority,
            items: gallery.paginatedData.items,
            allShots: gallery.shotsData || [],
            lastShotId: gallery.lastAffectedShotId || undefined,
            filters: filters.galleryFilters,
            onFiltersChange: filters.handleGalleryFiltersChange,
            onAddToShot: gallery.handleAddToShot,
            onAddToShotWithoutPosition: gallery.handleAddToShotWithoutPosition,
            onServerPageChange: gallery.handleServerPageChange,
            generationFilters: filters.generationFilters,
            currentViewingShotId: filters.currentShotId || undefined,
            onAddGenerationToTimeline: addGenerationToTimeline,
            addTargetProjectMismatch: navigation.addTargetProjectMismatch,
            config: gallery.config,
            readOnly: gallery.readOnly,
            emptyState: gallery.emptyState,
          }}
        />
      </div>
    </GenerationsPaneFrame>
  );
}

const GenerationsPaneComponent: React.FC = () => {
  const controller = useGenerationsPaneController();

  return (
    <>
      <GenerationsPaneBackdrop controller={controller} />
      <GenerationsDropChip controller={controller} />
      <GenerationsPaneTab controller={controller} />
      <GenerationsPaneSurface controller={controller} />

      <ImageGenerationModal
        isOpen={controller.modal.isGenerationModalOpen}
        onClose={() => controller.modal.setIsGenerationModalOpen(false)}
        initialShotId={controller.filters.currentShotId}
      />
    </>
  );
};

export const GenerationsPane = React.memo(GenerationsPaneComponent);
