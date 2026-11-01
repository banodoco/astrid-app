import { getShotPlacementTarget } from '@/shared/state/selectionStore';
import { useCallback } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';
import { normalizeAndPresentError } from '@/shared/lib/errorHandling/runtimeError';

interface DropZoneData {
  type?: 'shot-group' | string;
  shotId?: string;
}

interface DraggableData {
  generationId?: string;
  imageUrl?: string;
  thumbUrl?: string;
}

interface AddImageInput {
  shot_id: string;
  generation_id: string;
  imageUrl?: string;
  thumbUrl?: string;
  project_id: string;
}

interface UseAppExternalDropOptions {
  selectedProjectId: string | null;
  setLastAffectedShotId: (shotId: string) => void;
  addImageToShotMutation: { mutateAsync: (input: AddImageInput) => Promise<unknown> };
  onDropHandled: () => void;
}

export function useAppExternalDrop(options: UseAppExternalDropOptions) {
  const {
    selectedProjectId,
    setLastAffectedShotId,
    addImageToShotMutation,
    onDropHandled,
  } = options;

  return useCallback(async (event: DragEndEvent) => {
    try {
      const { active, over } = event;
      if (!selectedProjectId || !over) {
        return;
      }

      const draggableItem = active.data.current as DraggableData | undefined;
      const droppableZone = over.data.current as DropZoneData | undefined;
      if (!draggableItem || !droppableZone) {
        return;
      }

      const { generationId, imageUrl, thumbUrl } = draggableItem;
      if (!generationId) {
        return;
      }

      if (droppableZone.type === 'shot-group' && droppableZone.shotId) {
        await addImageToShotMutation.mutateAsync({
          ...getShotPlacementTarget(selectedProjectId, droppableZone.shotId),
          generation_id: generationId,
          imageUrl,
          thumbUrl,
          project_id: selectedProjectId,
        });
        setLastAffectedShotId(droppableZone.shotId);
      }
    } catch (error) {
      normalizeAndPresentError(error, { context: 'App', showToast: false });
    } finally {
      // Always finalize drag overlay state, including invalid targets and failed drops.
      onDropHandled();
    }
  }, [
    addImageToShotMutation,
    onDropHandled,
    selectedProjectId,
    setLastAffectedShotId,
  ]);
}
