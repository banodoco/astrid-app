import { getShotPlacementTarget } from '@/shared/state/selectionStore';
import { useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/shared/components/ui/runtime/sonner';
import { useAddImageToShot, usePositionExistingGenerationInShot } from '@/shared/hooks/shots';
import { useShots } from '@/shared/contexts/ShotsContext';
import { useLastAffectedShot } from '@/shared/hooks/shots/useLastAffectedShot';
import { queryKeys } from '@/shared/lib/queryKeys';
import { normalizeAndPresentError } from '@/shared/lib/errorHandling/runtimeError';
import { deriveTargetShotInfo } from '@/shared/hooks/shots/targetShotInfo';

interface UseImageGenActionsParams {
  projectId: string | null;
  effectiveProjectId: string | null;
  selectedShotFilter: string;
  excludePositioned: boolean;
  generationsFilters: Record<string, unknown>;
  currentPage: number;
  itemsPerPage: number;
}

export function useImageGenActions({
  projectId,
  effectiveProjectId,
  selectedShotFilter,
  excludePositioned,
  generationsFilters,
  currentPage,
  itemsPerPage,
}: UseImageGenActionsParams) {
  const queryClient = useQueryClient();
  const { lastAffectedShotId, setLastAffectedShotId } = useLastAffectedShot();
  const addImageToShotMutation = useAddImageToShot();
  const positionExistingGenerationMutation = usePositionExistingGenerationInShot();
  const { shots } = useShots();

  const targetShotInfo = useMemo(
    () => deriveTargetShotInfo(lastAffectedShotId, shots),
    [lastAffectedShotId, shots]
  );

  const validShots = useMemo(() => shots || [], [shots]);

  const handleAddImageToTargetShot = useCallback(async (targetShotId: string, generationId: string, imageUrl?: string, thumbUrl?: string): Promise<boolean> => {
    const resolvedTargetShotId = targetShotId || targetShotInfo.targetShotIdForButton;
    if (!resolvedTargetShotId) {
      toast.error("No target shot available to add to. Create a shot first or interact with one.");
      return false;
    }
    if (!generationId) {
      toast.error("Image has no ID, cannot add to shot.");
      return false;
    }
    if (!projectId) {
      toast.error("No project selected. Cannot add image to shot.");
      return false;
    }

    const shouldPositionExisting = selectedShotFilter !== 'all' &&
      selectedShotFilter === resolvedTargetShotId &&
      excludePositioned;

    try {
      if (shouldPositionExisting) {
        await positionExistingGenerationMutation?.mutateAsync({
          ...getShotPlacementTarget(projectId, resolvedTargetShotId),
          generation_id: generationId,
          project_id: projectId,
        });
      } else {
        await addImageToShotMutation?.mutateAsync({
          ...getShotPlacementTarget(projectId, resolvedTargetShotId),
          generation_id: generationId,
          imageUrl,
          thumbUrl,
          project_id: projectId,
        });
      }
      setLastAffectedShotId(resolvedTargetShotId);
      queryClient.invalidateQueries({ queryKey: queryKeys.unified.projectPrefix(effectiveProjectId) });
      return true;
    } catch (error) {
      normalizeAndPresentError(error, { context: 'ImageGenerationToolPage.handleAddImageToTargetShot', toastTitle: 'Failed to add image to shot.' });
      return false;
    }
  }, [targetShotInfo.targetShotIdForButton, projectId, addImageToShotMutation, positionExistingGenerationMutation, setLastAffectedShotId, selectedShotFilter, excludePositioned, queryClient, effectiveProjectId]);

  const handleAddImageToTargetShotWithoutPosition = useCallback(async (targetShotId: string, generationId: string, imageUrl?: string, thumbUrl?: string): Promise<boolean> => {
    const resolvedTargetShotId = targetShotId || targetShotInfo.targetShotIdForButton;
    if (!resolvedTargetShotId) {
      toast.error("No target shot available to add to. Create a shot first or interact with one.");
      return false;
    }
    if (!generationId) {
      toast.error("Image has no ID, cannot add to shot.");
      return false;
    }
    if (!projectId) {
      toast.error("No project selected. Cannot add image to shot.");
      return false;
    }

    try {
      await addImageToShotMutation?.mutateAsyncWithoutPosition({
        ...getShotPlacementTarget(projectId, resolvedTargetShotId),
        generation_id: generationId,
        imageUrl,
        thumbUrl,
        project_id: projectId,
      });
      setLastAffectedShotId(resolvedTargetShotId);
      queryClient.invalidateQueries({ queryKey: queryKeys.unified.projectPrefix(effectiveProjectId) });
      return true;
    } catch (error) {
      normalizeAndPresentError(error, { context: 'ImageGenerationToolPage.handleAddImageToTargetShotWithoutPosition', toastTitle: 'Failed to add image to shot without position.' });
      return false;
    }
  }, [targetShotInfo.targetShotIdForButton, projectId, addImageToShotMutation, setLastAffectedShotId, queryClient, effectiveProjectId]);

  const handleBackfillRequest = useCallback(async (): Promise<void> => {
    if (!projectId) return;

    try {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.unified.projectPrefix(effectiveProjectId),
      });
      await queryClient.refetchQueries({
        queryKey: queryKeys.unified.byProject(
          effectiveProjectId,
          currentPage,
          itemsPerPage,
          JSON.stringify(generationsFilters)
        ),
      });
    } catch (error) {
      normalizeAndPresentError(error, { context: 'ImageGenerationToolPage.refetchGenerationsAfterChange', showToast: false });
      throw error;
    }
  }, [projectId, effectiveProjectId, currentPage, itemsPerPage, queryClient, generationsFilters]);

  return {
    targetShotInfo,
    validShots,
    handleAddImageToTargetShot,
    handleAddImageToTargetShotWithoutPosition,
    handleBackfillRequest,
    setLastAffectedShotId,
  };
}
