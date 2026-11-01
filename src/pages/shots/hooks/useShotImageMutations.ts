import { getShotPlacementTarget } from '@/shared/state/selectionStore';
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/shared/components/ui/runtime/sonner';
import { normalizeAndPresentError } from '@/shared/lib/errorHandling/runtimeError';
import { shotQueryKeys } from '@/shared/lib/queryKeys/shots';
import {
  useAddImageToShot,
  useRemoveImageFromShot,
  useUpdateShotImageOrder
} from '@/shared/hooks/shots';
import type { GenerationRow, Shot } from '@/domains/generation/types';

interface UseShotImageMutationsInput {
  selectedProjectId: string | null;
  currentShotId: string | null;
  selectedShot: Shot | null;
  setManagedImages: Dispatch<SetStateAction<GenerationRow[]>>;
}

interface UseShotImageMutationsResult {
  handleDeleteImage: (id: string) => void;
  handleReorderImage: (orderedShotGenerationIds: string[]) => void;
  handleAddToShot: (generationId: string, imageUrl?: string, thumbUrl?: string) => Promise<boolean>;
  handleAddToShotWithoutPosition: (generationId: string, imageUrl?: string, thumbUrl?: string) => Promise<boolean>;
}

export function useShotImageMutations(input: UseShotImageMutationsInput): UseShotImageMutationsResult {
  const { selectedProjectId, currentShotId, selectedShot, setManagedImages } = input;
  const queryClient = useQueryClient();

  const removeImageFromShotMutation = useRemoveImageFromShot();
  const updateShotImageOrderMutation = useUpdateShotImageOrder();
  const addImageToShotMutation = useAddImageToShot();

  const refreshSelectedShotImages = useCallback(async () => {
    if (currentShotId && selectedProjectId) {
      await queryClient.invalidateQueries({ queryKey: shotQueryKeys.list(selectedProjectId) });
    }
  }, [currentShotId, queryClient, selectedProjectId]);

  const handleDeleteImage = useCallback((id: string) => {
    if (!selectedShot || !selectedProjectId) {
      toast.error('Cannot delete image: Shot or Project ID is missing.');
      return;
    }

    const originalImages = selectedShot.images || [];
    const updatedImages = originalImages.filter(img => img.id !== id);
    setManagedImages(updatedImages);

    removeImageFromShotMutation.mutate({
      shotId: selectedShot.id,
      shotGenerationId: id,
      projectId: selectedProjectId,
    }, {
      onError: (error) => {
        toast.error(`Failed to remove image from timeline: ${error.message}`);
        setManagedImages(originalImages);
      },
    });
  }, [removeImageFromShotMutation, selectedProjectId, selectedShot, setManagedImages]);

  const handleReorderImage = useCallback((orderedShotGenerationIds: string[]) => {
    if (!selectedShot || !selectedProjectId) {
      toast.error('Cannot reorder images: Shot or Project ID is missing.');
      return;
    }

    const originalImages = selectedShot.images || [];
    const imageMap = new Map(originalImages.map(img => [img.id, img]));
    const reorderedImages = orderedShotGenerationIds
      .map(id => imageMap.get(id))
      .filter((img): img is GenerationRow => !!img);
    setManagedImages(reorderedImages);

    updateShotImageOrderMutation.mutate({
      updates: orderedShotGenerationIds.map((generationId, index) => ({
        shot_id: selectedShot.id,
        generation_id: generationId,
        timeline_frame: index,
      })),
      shotId: selectedShot.id,
      projectId: selectedProjectId,
    }, {
      onError: (error) => {
        toast.error(`Failed to update image order: ${error.message}`);
        setManagedImages(originalImages);
      },
    });
  }, [selectedProjectId, selectedShot, setManagedImages, updateShotImageOrderMutation]);

  const handleAddToShot = useCallback(async (
    generationId: string,
    imageUrl?: string,
    thumbUrl?: string
  ): Promise<boolean> => {
    if (!currentShotId || !selectedProjectId) {
      toast.error('Cannot add to shot: No shot or project selected');
      return false;
    }

    try {
      await addImageToShotMutation.mutateAsync({
        ...getShotPlacementTarget(selectedProjectId, currentShotId),
        generation_id: generationId,
        imageUrl,
        thumbUrl,
        project_id: selectedProjectId,
      });

      await refreshSelectedShotImages();
      return true;
    } catch (error) {
      normalizeAndPresentError(error, { context: 'ShotsPage', toastTitle: 'Failed to add to shot' });
      return false;
    }
  }, [addImageToShotMutation, currentShotId, refreshSelectedShotImages, selectedProjectId]);

  const handleAddToShotWithoutPosition = useCallback(async (
    generationId: string,
    imageUrl?: string,
    thumbUrl?: string
  ): Promise<boolean> => {
    if (!currentShotId || !selectedProjectId) {
      toast.error('Cannot add to shot: No shot or project selected');
      return false;
    }

    try {
      await addImageToShotMutation.mutateAsyncWithoutPosition({
        ...getShotPlacementTarget(selectedProjectId, currentShotId),
        generation_id: generationId,
        imageUrl,
        thumbUrl,
        project_id: selectedProjectId,
      });

      await refreshSelectedShotImages();
      return true;
    } catch (error) {
      normalizeAndPresentError(error, { context: 'ShotsPage', toastTitle: 'Failed to add to shot' });
      return false;
    }
  }, [addImageToShotMutation, currentShotId, refreshSelectedShotImages, selectedProjectId]);

  return {
    handleDeleteImage,
    handleReorderImage,
    handleAddToShot,
    handleAddToShotWithoutPosition,
  };
}
