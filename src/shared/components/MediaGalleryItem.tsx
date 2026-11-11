import React, { useCallback, useMemo, useState } from "react";
import { Eye } from "lucide-react";
import { DraggableImage } from "@/shared/components/DraggableImage";
import { TimeStamp } from "@/shared/components/TimeStamp";
import type { Shot } from "@/domains/generation/types";
import type { MediaGalleryItemProps } from "./MediaGalleryItem/types";
import { VideoContent } from "./MediaGalleryItem/components/VideoContent";
import { ImageContent } from "./MediaGalleryItem/components/ImageContent";
import { AudioContent } from "./MediaGalleryItem/components/AudioContent";
import { isAudioMedia, isVideoMedia } from '@/shared/lib/media/mediaTypeFilters';
import { ShotActions } from "./MediaGalleryItem/components/ShotActions";
import { ActionButtons } from "./MediaGalleryItem/components/ActionButtons";
import { AddToTimelineButton } from "./MediaGalleryItem/components/AddToTimelineButton";
import { HoverPeekButton } from "./MediaGalleryItem/components/HoverPeek";
import { ItemShotBadges } from "./MediaGalleryItem/components/ItemShotBadges";
import { ItemMetadataBar } from "./MediaGalleryItem/components/ItemMetadataBar";
import { useMediaGalleryItemShotActions } from "./MediaGalleryItem/hooks/useShotActions";
import { useImageLoading } from "./MediaGalleryItem/hooks/useImageLoading";
import { useMediaGalleryItemState } from "./MediaGalleryItem/hooks/useMediaGalleryItemState";
import { useStableMediaUrls } from "./MediaGalleryItem/hooks/useStableMediaUrls";
import { useShotPositionChecks } from "./MediaGalleryItem/hooks/useShotPositionChecks";
import { useItemInteraction } from "./MediaGalleryItem/hooks/useItemInteraction";
import {
  setGenerationDragData,
  setMultiGenerationDragData,
  createDragPreview,
  type GenerationDropData,
} from '@/shared/lib/dnd/dragDrop';
import type { GeneratedImageWithMetadata } from '@/shared/components/MediaGallery/types';
import { parseRatio } from '@/shared/lib/media/aspectRatios';
import {
  MediaGalleryTileFrame,
  extractResolutionFromMetadata,
  resolveAspectRatioPadding,
} from "./MediaGalleryItem/components/MediaGalleryTileFrame";
import { useProjectSelectionContext } from "@/shared/contexts/ProjectContext";
import { TOOL_IDS } from '@/shared/lib/tooling/toolIds';
import { useShotNavigation } from "@/shared/hooks/shots/useShotNavigation";
import { usePrefetchTaskData } from "@/shared/hooks/tasks/useTaskPrefetch";
import { useGenerationTaskMapping } from "@/domains/generation/hooks/tasks/useGenerationTaskMapping";
import { useTaskType } from "@/shared/hooks/tasks/useTaskType";
import { useGetTask } from "@/shared/hooks/tasks/useTasks";
import { deriveGalleryInputImages } from "./MediaGallery/utils";
import { isImageEditTaskType } from "@/shared/lib/taskParamsUtils";
import { useMarkVariantViewed } from "@/shared/hooks/variants/useMarkVariantViewed";
import { getGenerationId, getMediaUrl, getThumbnailUrl } from '@/shared/lib/media/mediaTypeHelpers';
import { bridgeMediaUrl } from '@/shared/lib/media/bridgeMediaUrl';
import { getProjectSelectionFallbackId } from '@/shared/contexts/projectSelectionStore';
import { useRenderBudget } from '@/shared/dev/useRenderBudget';
import { isAdditiveSelectionEvent, isClickLikePointerGesture, isPrimaryPointer } from '@/shared/lib/interactions/selectionGesture';

function toGenerationDragData(image: GeneratedImageWithMetadata): GenerationDropData | null {
  const generationId = getGenerationId(image) ?? image.id;
  const imageUrl = getMediaUrl(image);
  if (!imageUrl) {
    return null;
  }
  const variantId = image.primary_variant_id
    ?? (typeof image.metadata?.variant_id === 'string' ? image.metadata.variant_id : undefined)
    ?? (image.generation_id ? image.id : undefined);

  return {
    generationId,
    variantId,
    variantType: isAudioMedia(image) ? 'audio' : isVideoMedia(image) ? 'video' : 'image',
    mediaId: image.media_id ?? undefined,
    imageUrl,
    thumbUrl: getThumbnailUrl(image),
    metadata: image.metadata,
  };
}
export const MediaGalleryItem: React.FC<MediaGalleryItemProps> = ({
  image,
  index,
  shotWorkflow,
  mobileInteraction,
  features,
  actions,
  loading,
  isSelected = false,
  selectedItems = [],
  projectAspectRatio,
}) => {
  useRenderBudget('MediaGalleryItem', 5);
  const [isPeekOpen, setIsPeekOpen] = useState(false);
  const {
    selectedShotIdLocal,
    simplifiedShotOptions,
    setSelectedShotIdLocal,
    setLastAffectedShotId,
    showTickForImageId,
    onShowTick,
    onShowSecondaryTick,
    optimisticUnpositionedIds,
    optimisticPositionedIds,
    onOptimisticUnpositioned,
    onOptimisticPositioned,
    addingToShotImageId,
    setAddingToShotImageId,
    addingToShotWithoutPositionImageId,
    setAddingToShotWithoutPositionImageId,
    currentViewingShotId,
    onAddToLastShot,
    onAddToLastShotWithoutPosition,
  } = shotWorkflow;
  const {
    isMobile,
    mobileActiveImageId,
    mobilePopoverOpenImageId,
    onMobileTap,
  } = mobileInteraction;
  const {
    showDelete = true,
    showStar = true,
    showAddToShot = true,
    enableSingleClick = false,
    videosAsThumbnails = false,
  } = features;
  const {
    onOpenLightbox,
    onDelete,
    onToggleStar,
    onImageClick,
    onContextMenu,
    onImageLoaded,
    onAddToTimeline,
    addToTimelineDisabledReason,
  } = actions;
  const {
    shouldLoad = true,
    isPriority = false,
    isDeleting,
  } = loading;
  const {
    localStarred,
    setLocalStarred,
    isTogglingStar,
    setIsTogglingStar,
    isInfoOpen,
    setIsInfoOpen,
    isShotSelectorOpen,
    setIsShotSelectorOpen,
    isDragging,
    setIsDragging,
  } = useMediaGalleryItemState({ image });
  const prefetchTaskData = usePrefetchTaskData();
  const taskIdFromMetadata = image.metadata?.taskId as string | undefined;
  const actualGenerationId = getGenerationId(image);
  const generationIdForActions = actualGenerationId || image.id;
  const { selectedProjectId } = useProjectSelectionContext();
  const { data: taskIdMapping } = useGenerationTaskMapping(actualGenerationId ?? '');
  const taskIdFromCache = typeof taskIdMapping?.taskId === 'string' ? taskIdMapping.taskId : null;
  const taskId: string | null = taskIdFromMetadata || taskIdFromCache;
  const { data: taskData } = useGetTask(taskId ?? '', selectedProjectId ?? null);
  const handleMouseEnter = useCallback(() => {
    if (!isMobile && actualGenerationId) {
      prefetchTaskData(actualGenerationId);
    }
  }, [isMobile, actualGenerationId, prefetchTaskData]);
  const inputImages = useMemo(() => deriveGalleryInputImages(taskData), [taskData]);
  const taskType = taskData?.taskType;
  const { data: taskTypeInfo } = useTaskType(taskType || '');
  const isVideoTask = taskTypeInfo?.content_type === 'video' ||
    (!taskTypeInfo && image.metadata?.tool_type === TOOL_IDS.TRAVEL_BETWEEN_IMAGES);
  const isImageEditTask = isImageEditTaskType(taskType || undefined);
  const shouldShowTaskDetails = (!!taskData) && (isVideoTask || isImageEditTask);
  const { markAllViewed } = useMarkVariantViewed();
  const handleMarkAllVariantsViewed = useCallback(() => {
    if (actualGenerationId) {
      markAllViewed(actualGenerationId);
    }
  }, [actualGenerationId, markAllViewed]);
  const { navigateToShot } = useShotNavigation();
  const {
    isVideoContent,
    isAudioContent,
    displayUrl,
    stableDisplayUrl,
    stableVideoUrl,
    progressiveEnabled,
    isThumbShowing,
    isFullLoaded,
    progressiveRef,
  } = useStableMediaUrls({ image, isPriority });
  const {
    actualSrc,
    actualDisplayUrl,
    imageLoaded,
    imageLoadError,
    handleImageLoad,
    handleImageError,
    retryImageLoad,
    setImageLoading,
  } = useImageLoading({
    image,
    displayUrl,
    shouldLoad,
    onImageLoaded,
  });
  const { addToShot, addToShotWithoutPosition } = useMediaGalleryItemShotActions({
    imageId: image.id,
    generationId: generationIdForActions,
    imageUrl: image.url ?? displayUrl ?? '',
    thumbUrl: image.thumbUrl ?? image.url ?? displayUrl ?? '',
    displayUrl: displayUrl ?? image.url ?? '',
    selectedShotId: selectedShotIdLocal,
    isMobile,
    onAddToLastShot,
    onAddToLastShotWithoutPosition,
    onShowTick,
    onShowSecondaryTick,
    onOptimisticPositioned,
    onOptimisticUnpositioned,
    setAddingToShotImageId,
    setAddingToShotWithoutPositionImageId,
  });
  const shouldShowMetadata = useMemo(() => {
    if (!image.metadata) return false;
    return isMobile
      ? (mobilePopoverOpenImageId === image.id)
      : isInfoOpen;
  }, [image.metadata, isMobile, mobilePopoverOpenImageId, image.id, isInfoOpen]);
  const isCurrentDeleting = isDeleting === true || isDeleting === image.id;
  const imageKey = image.id || `image-${actualDisplayUrl}-${index}`;
  const isPlaceholder = !image.id && actualDisplayUrl === "/placeholder.svg";
  const currentTargetShotName = selectedShotIdLocal ? simplifiedShotOptions.find(s => s.id === selectedShotIdLocal)?.name : undefined;
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (isMobile) {
      e.preventDefault();
      return;
    }
    const selectedDragItems = isSelected && selectedItems.some((item) => item.id === image.id)
      ? selectedItems
      : [];
    const selectedDragPayloads = selectedDragItems
      .map(toGenerationDragData)
      .filter((payload): payload is GenerationDropData => payload !== null);
    const singleDragPayload = toGenerationDragData(image);

    if (selectedDragItems.length > 1 && selectedDragPayloads.length === 0) {
      e.preventDefault();
      return;
    }

    if (selectedDragItems.length <= 1 && !singleDragPayload) {
      e.preventDefault();
      return;
    }

    setIsDragging(true);
    if (selectedDragPayloads.length > 1) {
      setMultiGenerationDragData(e, selectedDragPayloads);
    } else {
      setGenerationDragData(e, selectedDragPayloads[0] ?? singleDragPayload!);
    }

    const cleanup = createDragPreview(
      e,
      selectedDragPayloads.length > 1 ? { badgeText: String(selectedDragPayloads.length) } : undefined,
    );
    if (cleanup) {
      setTimeout(cleanup, 0);
    }
  }, [image, isMobile, isSelected, selectedItems, setIsDragging]);
  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, [setIsDragging]);
  // Wrapper-level click detection for desktop. The native click on the inner
  // <img> is intermittently swallowed by the wrapper's HTML5 `draggable=true`
  // (any sub-pixel-or-two mousemove between mousedown and mouseup makes the
  // browser fire dragstart instead of click). We track pointerdown position and
  // treat sub-threshold pointerup gestures as clicks ourselves, regardless of
  // whether the browser would have synthesised a click. Real drags skip the
  // click and let the drag pipeline run.
  const pointerDownRef = React.useRef<{ x: number; y: number; pointerId: number; targetIsButton: boolean } | null>(null);

  const handleWrapperPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    if (!isPrimaryPointer(event.nativeEvent)) return;
    if (isMobile) return;
    const target = event.target as HTMLElement | null;
    const targetIsButton = Boolean(target?.closest('button, audio'));
    pointerDownRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      targetIsButton,
    };
  }, [isMobile]);

  const handleWrapperPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    if (start.targetIsButton) return; // Don't hijack clicks on internal action buttons.
    if (!enableSingleClick || !onImageClick) return;
    if (!isClickLikePointerGesture(start, { x: event.clientX, y: event.clientY })) return;
    onImageClick(image, {
      multiSelect: isAdditiveSelectionEvent(event),
    });
  }, [enableSingleClick, onImageClick, image]);

  const { handleTouchStart, handleInteraction } = useItemInteraction({
    image,
    isMobile,
    mobileActiveImageId,
    enableSingleClick,
    onImageClick,
    onMobileTap,
  });
  const {
    isAlreadyPositionedInSelectedShot,
    isAlreadyAssociatedWithoutPosition,
    shouldShowAddWithoutPositionButton,
  } = useShotPositionChecks({
    image,
    selectedShotIdLocal,
    currentViewingShotId,
    optimisticPositionedIds,
    optimisticUnpositionedIds,
    onAddToLastShotWithoutPosition,
    showTickForImageId,
    addingToShotImageId,
  });
  // A tap on the item. With single-click selection the wrapper owns it on any touch screen, for
  // images and videos alike: its pointer handlers are mouse-only, so without this a tap selects
  // nothing (an iPad is not `isMobile`). Otherwise phones keep their tap/double-tap, where a
  // video's own element takes the tap. Audio keeps its player's controls.
  const wrapperHandlesTouch = !isAudioContent && (enableSingleClick || (isMobile && !isVideoContent));
  const aspectRatioPadding = resolveAspectRatioPadding(image, projectAspectRatio);
  const metadataAspectRatio = useMemo(() => {
    const { width, height } = extractResolutionFromMetadata(image);
    return width && height ? width / height : null;
  }, [image]);
  const peekProjectAspectRatio = parseRatio(projectAspectRatio);
  const peekFullSrc = useMemo(() => {
    const mediaRef = getMediaUrl(image);
    return mediaRef ? bridgeMediaUrl(getProjectSelectionFallbackId(), mediaRef) : null;
  }, [image]);
  const minHeight = isAudioContent ? '160px' : '120px';
  if (isPlaceholder) {
    return (
      <div
        key={imageKey}
        className="border rounded-lg overflow-hidden bg-muted animate-pulse"
      >
        <div style={{ paddingBottom: aspectRatioPadding }} className="relative">
          <div className="absolute inset-0 flex items-center justify-center">
            <Eye className="h-12 w-12 text-muted-foreground opacity-30" />
          </div>
        </div>
      </div>
    );
  }
  const imageContent = (
    <MediaGalleryTileFrame
        data-gallery-item-id={image.id}
        isSelected={isSelected}
        isDragging={isDragging}
        isMobile={isMobile}
        aspectRatioPadding={aspectRatioPadding}
        minHeight={minHeight}
        draggable={!isMobile}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onMouseEnter={handleMouseEnter}
        onContextMenu={(event) => onContextMenu?.(event, image)}
        onTouchStart={wrapperHandlesTouch ? handleTouchStart : undefined}
        onTouchEnd={wrapperHandlesTouch ? handleInteraction : undefined}
        onPointerDown={handleWrapperPointerDown}
        onPointerUp={handleWrapperPointerUp}
        media={(
          <>
          {isAudioContent ? (
            <AudioContent image={image} shouldLoad={shouldLoad} onOpenLightbox={onOpenLightbox} onLoaded={() => onImageLoaded?.(image.id)} />
          ) : isVideoContent ? (
            <VideoContent
              image={image}
              stableDisplayUrl={stableDisplayUrl}
              stableVideoUrl={stableVideoUrl}
              actualSrc={actualSrc}
              shouldLoad={shouldLoad}
              imageLoaded={imageLoaded}
              videosAsThumbnails={videosAsThumbnails}
              isMobile={isMobile}
              enableSingleClick={enableSingleClick}
              onImageClick={onImageClick}
              onOpenLightbox={onOpenLightbox}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleInteraction}
              onVideoError={handleImageError}
              onLoadStart={() => setImageLoading(true)}
              onLoadedData={handleImageLoad}
            />
          ) : (
            <ImageContent
              image={image}
              index={index}
              actualSrc={actualSrc}
              imageLoaded={imageLoaded}
              imageLoadError={imageLoadError}
              progressiveEnabled={progressiveEnabled}
              isThumbShowing={isThumbShowing}
              isFullLoaded={isFullLoaded}
              progressiveRef={progressiveRef}
              isMobile={isMobile}
              enableSingleClick={enableSingleClick}
              onImageClick={onImageClick}
              onOpenLightbox={onOpenLightbox}
              onImageLoad={handleImageLoad}
              onImageError={handleImageError}
              onRetry={retryImageLoad}
              setImageLoading={setImageLoading}
            />
          )}
          </>
        )}
    >
      {/* Overlay layer — single container above the image for all UI controls */}
      {image.id && (
      <div className="absolute inset-0 z-10 pointer-events-none [&>*]:pointer-events-auto">
          <ItemShotBadges
            image={image}
            isVideoContent={isVideoContent}
            simplifiedShotOptions={simplifiedShotOptions}
            onMarkAllVariantsViewed={handleMarkAllVariantsViewed}
            onNavigateToShot={(shotId) => {
              const targetShot = simplifiedShotOptions.find((shot) => shot.id === shotId);
              if (targetShot) {
                navigateToShot(targetShot as Shot, { scrollToTop: true });
              }
            }}
          />
          {/* Add to Shot UI - Top Left (for non-video content) */}
          {showAddToShot && !isAudioContent && simplifiedShotOptions.length > 0 && onAddToLastShot && (
            <ShotActions
              image={image}
              selector={{
                selectedShotId: selectedShotIdLocal,
                simplifiedShotOptions,
                isShotSelectorOpen,
                setIsShotSelectorOpen,
                setSelectedShotIdLocal,
                setLastAffectedShotId,
              }}
              status={{
                isMobile,
                isVideoContent,
                addingToShotImageId,
                addingToShotWithoutPositionImageId: addingToShotWithoutPositionImageId ?? null,
                showTickForImageId,
                isAlreadyPositionedInSelectedShot,
                isAlreadyAssociatedWithoutPosition,
                shouldShowAddWithoutPositionButton,
                currentTargetShotName,
              }}
              actions={{
                onNavigateToShot: (shot) => navigateToShot(shot, { scrollToTop: true }),
                onAddToShot: addToShot,
                onAddToShotWithoutPosition: addToShotWithoutPosition,
              }}
            />
          )}
          {/* Timestamp - Top Right (hides on hover for images, stays visible for videos) */}
          <TimeStamp
            createdAt={image.createdAt}
            position="top-right"
            showOnHover={false}
            hideOnHover={!isVideoContent || Boolean(onAddToTimeline)}
            className={isPeekOpen ? '!opacity-0' : ''}
          />
          {/* Add to Timeline - Top Right, in place of the timestamp when it is shown on hover */}
          {onAddToTimeline && actualGenerationId && (
            <div className="absolute top-1.5 right-1.5">
              {!isAudioContent && (
                <HoverPeekButton
                  image={image}
                  thumbSrc={stableDisplayUrl || null}
                  fullSrc={isVideoContent ? null : peekFullSrc}
                  videoSrc={stableVideoUrl ?? actualSrc ?? null}
                  isVideo={isVideoContent}
                  metadataAspectRatio={metadataAspectRatio}
                  projectAspectRatio={Number.isFinite(peekProjectAspectRatio) ? peekProjectAspectRatio : null}
                  onOpenLightbox={onOpenLightbox}
                  onOpenChange={setIsPeekOpen}
                />
              )}
              <AddToTimelineButton
                generationId={generationIdForActions}
                onAddToTimeline={onAddToTimeline}
                disabledReason={addToTimelineDisabledReason}
                isSelected={isSelected}
              />
            </div>
          )}
          <ItemMetadataBar
            image={image}
            isVideoContent={isVideoContent}
            isMobile={isMobile}
            taskData={taskData}
            inputImages={inputImages}
            shouldShowMetadata={shouldShowMetadata}
            shouldShowTaskDetails={shouldShowTaskDetails}
            setIsInfoOpen={setIsInfoOpen}
            onMarkAllVariantsViewed={handleMarkAllVariantsViewed}
          />
          <ActionButtons
            image={image}
            localStarred={localStarred}
            isTogglingStar={isTogglingStar}
            isDeleting={isCurrentDeleting}
            showStar={showStar}
            showDelete={showDelete}
            onToggleStar={onToggleStar}
            setIsTogglingStar={setIsTogglingStar}
            setLocalStarred={setLocalStarred}
            onDelete={onDelete}
          />
      </div>)
      }
    </MediaGalleryTileFrame>
  );
  return isMobile ? (
    <React.Fragment key={imageKey}>
      {imageContent}
    </React.Fragment>
  ) : (
    <DraggableImage key={`draggable-${imageKey}`} image={image} onDoubleClick={() => onOpenLightbox(image)}>
      {imageContent}
    </DraggableImage>
  );
};
