/** Page-level gallery controller for filters, pagination, and gallery actions. */

import { useState, useEffect, useMemo } from 'react';
import { useProjectSelectionContext } from '@/shared/contexts/ProjectContext';
import { useProjectGenerations, type GenerationsPaginatedResponse } from '@/shared/hooks/projects/useProjectGenerations';
import { useAddImageToShot, usePositionExistingGenerationInShot } from '@/shared/hooks/shots';
import { useShots } from '@/shared/contexts/ShotsContext';
import { toast } from '@/shared/components/ui/runtime/sonner';
import { normalizeAndPresentError } from '@/shared/lib/errorHandling/runtimeError';
import { useGalleryFilterState } from '@/shared/hooks/gallery/useGalleryFilterState';
import { dispatchAppEvent } from '@/shared/lib/typedEvents';
import { getShotPlacementTarget, useCurrentShot, useLastAffectedShot } from '@/shared/state/selectionStore';

interface UseGenerationsPageLogicOptions {
  itemsPerPage?: number;
  mediaType?: 'all' | 'image' | 'video' | 'audio';
  toolType?: string;
  enableDataLoading?: boolean;
  runtimeProjectId?: string | null;
  runtimeAuthority?: boolean;
}

/**
 * @internal Use `useGalleryPageState` instead (exported alias below).
 */
function useGenerationsPageLogic({
  itemsPerPage = 45,
  mediaType = 'image',
  toolType,
  enableDataLoading = true,
  runtimeProjectId = null,
  runtimeAuthority = runtimeProjectId !== null,
}: UseGenerationsPageLogicOptions = {}) {
  const { selectedProjectId } = useProjectSelectionContext();
  const { shots: shotsData } = useShots();

  const shouldLoadData = enableDataLoading && (
    runtimeAuthority ? Boolean(runtimeProjectId) : Boolean(runtimeProjectId ?? selectedProjectId)
  );
  const [page, setPage] = useState(1);

  const { currentShotId } = useCurrentShot();

  const { lastAffectedShotId, setLastAffectedShotId } = useLastAffectedShot();

  const filterState = useGalleryFilterState({
    shouldLoadData,
    onShotFilterApplied: setLastAffectedShotId,
  }, mediaType, toolType);

  const {
    selectedShotFilter,
    excludePositioned,
    searchTerm,
    starredOnly,
    filters,
    expectedItemCount,
    applyQueryFallback,
  } = filterState;

  // Any filter change restarts pagination from the first page.
  useEffect(() => {
    setPage(1);
  }, [selectedShotFilter, excludePositioned, searchTerm, mediaType, starredOnly]);

  const generationsQuery = useProjectGenerations(
    shouldLoadData && !runtimeProjectId ? selectedProjectId : null,
    page,
    itemsPerPage,
    shouldLoadData,
    filters,
    { runtimeProjectId, runtimeAuthority },
  );
  const generationsResponse = generationsQuery.data as GenerationsPaginatedResponse | undefined;
  const isFetching = generationsQuery.isFetching;
  const isError = generationsQuery.isError;
  const error = generationsQuery.error;

  const isPlaceholderData = generationsQuery.isPlaceholderData;

  const isLoading = generationsQuery.isLoading || (isFetching && isPlaceholderData);

  /**
   * The Runtime route returns no real total. While `hasMore` is true, `total` is a
   * look-ahead estimate (offset + items + 1); it is exact only once `hasMore` is false.
   * Consumers that show a total count or a last-page number should check this flag.
   */
  const totalIsExact = generationsResponse !== undefined && generationsResponse.hasMore === false;

  // Keep the current page inside [1, totalPages] when the response total or page size shrinks
  // (filter change, deletions, resize). Never clamp without a response: a loading query has no total.
  useEffect(() => {
    if (generationsResponse === undefined) return;
    const totalPages = Math.max(1, Math.ceil(generationsResponse.total / itemsPerPage));
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [generationsResponse, itemsPerPage, page]);

  useEffect(() => {
    applyQueryFallback({
      isLoading,
      isFetching,
      total: generationsResponse?.total,
      hasResponse: generationsResponse !== undefined,
    }, page);
  }, [selectedShotFilter, isLoading, isFetching, generationsResponse?.total, page, applyQueryFallback, generationsResponse]);


  const addImageToShotMutation = useAddImageToShot();
  const positionExistingGenerationMutation = usePositionExistingGenerationInShot();

  const paginatedData = useMemo(() => {
    const items = generationsResponse?.items ?? [];
    const total = generationsResponse?.total ?? 0;
    const totalPages = Math.ceil(total / itemsPerPage);

    return {
      items,
      totalPages,
      currentPage: page
    };
  }, [generationsResponse, page, itemsPerPage]);


  useEffect(() => {

    if (!lastAffectedShotId && shotsData && shotsData.length > 0) {
      setLastAffectedShotId(shotsData[0].id);
    }
  }, [lastAffectedShotId, shotsData, setLastAffectedShotId, currentShotId, selectedShotFilter]);


  const handleServerPageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handleAddToShot = async (targetShotId: string, generationId: string, imageUrl?: string, thumbUrl?: string): Promise<boolean> => {
    const resolvedTargetShotId = targetShotId || lastAffectedShotId || currentShotId;

    if (!resolvedTargetShotId || !selectedProjectId) {
      toast.error("No shot selected", {
        description: "Please select a shot in the gallery or create one first.",
      });
      return false;
    }

    const shouldPositionExisting = selectedShotFilter === resolvedTargetShotId && excludePositioned;

    const operationId = `${resolvedTargetShotId}:${generationId}:${Date.now()}`;
    dispatchAppEvent('shot-pending-upload', { shotId: resolvedTargetShotId, expectedCount: 1, operationId });

    try {
      if (shouldPositionExisting) {
        await positionExistingGenerationMutation.mutateAsync({
          ...getShotPlacementTarget(selectedProjectId, resolvedTargetShotId),
          generation_id: generationId,
          project_id: selectedProjectId,
        });
      } else {
        await addImageToShotMutation.mutateAsync({
          ...getShotPlacementTarget(selectedProjectId, resolvedTargetShotId),
          generation_id: generationId,
          imageUrl: imageUrl,
          thumbUrl: thumbUrl,
          project_id: selectedProjectId,
        });
      }

      setLastAffectedShotId(resolvedTargetShotId);
      dispatchAppEvent('shot-pending-upload-succeeded', { shotId: resolvedTargetShotId, operationId });
      return true;
    } catch (error) {
      normalizeAndPresentError(error, { context: 'useGenerationsPageLogic', toastTitle: 'Failed to add image to shot' });
      dispatchAppEvent('shot-pending-upload-failed', { shotId: resolvedTargetShotId, operationId });
      return false;
    }
  };

  const handleAddToShotWithoutPosition = async (targetShotId: string, generationId: string, imageUrl?: string, thumbUrl?: string): Promise<boolean> => {
    const resolvedTargetShotId = targetShotId || lastAffectedShotId || currentShotId;

    if (!resolvedTargetShotId || !selectedProjectId) {
      toast.error("No shot selected", {
        description: "Please select a shot in the gallery or create one first.",
      });
      return false;
    }

    try {
      await addImageToShotMutation.mutateAsyncWithoutPosition({
        ...getShotPlacementTarget(selectedProjectId, resolvedTargetShotId),
        generation_id: generationId,
        imageUrl: imageUrl,
        thumbUrl: thumbUrl,
        project_id: selectedProjectId,
      });
      setLastAffectedShotId(resolvedTargetShotId);
      return true;
    } catch (error) {
      normalizeAndPresentError(error, { context: 'useGenerationsPageLogic', toastTitle: 'Failed to add image to shot' });
      return false;
    }
  };

  return {
    selectedProjectId,
    shotsData,
    generationsResponse,
    paginatedData,
    lastAffectedShotId,
    totalCount: generationsResponse?.total ?? 0,
    totalIsExact,

    page,
    selectedShotFilter,
    excludePositioned,
    searchTerm,
    starredOnly,

    setPage,
    setSelectedShotFilter: filterState.setSelectedShotFilter,
    setExcludePositioned: filterState.setExcludePositioned,
    setSearchTerm: filterState.setSearchTerm,
    setStarredOnly: filterState.setStarredOnly,

    isLoading,
    isFetching,
    isError,
    error,

    expectedItemCount,

    handleServerPageChange,
    handleAddToShot,
    handleAddToShotWithoutPosition,
  };
}

export const useGalleryPageState = useGenerationsPageLogic;
