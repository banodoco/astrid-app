import React, { useCallback, Suspense, useId, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { useExtraLargeModal } from '@/shared/hooks/useModal';
import { ImageGenerationForm } from '@/shared/components/ImageGenerationForm';
import { createImageGenerationTasks } from '@/shared/lib/taskCreation';
import { useProjectSelectionContext } from '@/shared/contexts/ProjectContext';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/lib/queryKeys';
import { toast } from '@/shared/components/ui/runtime/sonner';
import { useTaskPlaceholder } from '@/shared/hooks/tasks/useTaskPlaceholder';
import { Skeleton } from '@/shared/components/ui/skeleton';
import { ExternalLinkTooltipButton } from '@/shared/components/ui/composed/ExternalLinkTooltipButton';
import { useNavigate } from 'react-router-dom';
import { TOOL_ROUTES } from '@/shared/lib/tooling/toolRoutes';
import type { ImageGenerationPlacement, ImageGenerationTaskOptions } from '@/shared/lib/taskCreation/imageGeneration.ts';
import type { BatchImageGenerationTaskParams } from '@/shared/types/imageGeneration';
import { composeDisabledReason } from '@/shared/components/RuntimeConnection/copy.ts';

interface ImageGenerationModalProps {
  timelinePlacement?: ImageGenerationPlacement;
  isOpen: boolean;
  onClose: () => void;
  /** Pre-select a specific shot when the modal opens */
  initialShotId?: string | null;
}

export const ImageGenerationModal: React.FC<ImageGenerationModalProps> = ({
  isOpen,
  onClose,
  initialShotId,
  timelinePlacement,
}) => {
  const [autoPlace, setAutoPlace] = useState(false);
  const [ownerRef, setOwnerRef] = useState('');
  const [lane, setLane] = useState('');
  const [anchor, setAnchor] = useState('');
  const [placementError, setPlacementError] = useState<string | null>(null);
  const modal = useExtraLargeModal();
  const footerPortalId = useId();
  const { selectedProjectId } = useProjectSelectionContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const run = useTaskPlaceholder();

  const handleGenerate = useCallback(async (taskParams: BatchImageGenerationTaskParams): Promise<string[]> => {
    const disabledReason = composeDisabledReason();
    if (disabledReason) {
      toast.error(disabledReason);
      return [];
    }
    if (!selectedProjectId) {
      toast.error("No project selected. Please select a project before generating images.");
      return [];
    }

    let placementOptions: ImageGenerationTaskOptions | undefined;
    if (autoPlace) {
      try {
        if (!timelinePlacement || timelinePlacement.projectId !== selectedProjectId) {
          throw new Error('The original editor project changed. Keep this draft for manual use.');
        }
        if (taskParams.prompts.length !== 1 || taskParams.imagesPerPrompt !== 1) {
          throw new Error('Automatic placement requires one prompt and one image.');
        }
        placementOptions = await timelinePlacement.prepare({ ownerRef, lane, anchor: anchor || null });
        setPlacementError(null);
      } catch (error) {
        setPlacementError(error instanceof Error ? error.message : String(error));
        return [];
      }
    }
    await run({
      taskType: 'image_generation',
      label: taskParams.prompts?.[0]?.fullPrompt?.substring(0, 50) || 'Generating images...',
      context: 'ImageGenerationModal',
      toastTitle: 'Failed to create tasks',
      create: async () => {
        try {
          return placementOptions ? await createImageGenerationTasks(selectedProjectId, taskParams, placementOptions)
            : await createImageGenerationTasks(selectedProjectId, taskParams);
        } catch (error) {
          if (autoPlace) setPlacementError(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.unified.projectPrefix(selectedProjectId) });
      },
    });
    return [];
  }, [selectedProjectId, queryClient, run, autoPlace, timelinePlacement, ownerRef, lane, anchor]);

  const handleNavigateToTool = useCallback(() => {
    onClose();
    navigate(TOOL_ROUTES.IMAGE_GENERATION);
  }, [onClose, navigate]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={modal.className}
        style={{
          ...modal.style,
          maxWidth: '900px',
        }}
      >
        <DialogHeader className={modal.headerClass}>
          <div className="flex items-center gap-2">
            <DialogTitle className="text-xl font-light">Generate Images</DialogTitle>
            <ExternalLinkTooltipButton
              onClick={handleNavigateToTool}
              tooltipLabel="Open Tool"
              delayDuration={500}
            />
          </div>
        </DialogHeader>

        <div className={`${modal.scrollClass} -mx-6 px-6 flex-1 min-h-0 pb-4`}>
          {timelinePlacement && (
            <fieldset className="space-y-2 mb-4">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={autoPlace} onChange={(event) => setAutoPlace(event.target.checked)} />
                Add the generated image to this timeline (5 seconds)
              </label>
              {autoPlace && (
                <div className="space-y-2">
                  <label className="block">Raw occurrence reference
                    <input className="block border bg-background text-foreground" value={ownerRef} onChange={(event) => setOwnerRef(event.target.value)} placeholder="occurrence:…" />
                  </label>
                  <label className="block">Raw lane ID
                    <input className="block border bg-background text-foreground" value={lane} onChange={(event) => setLane(event.target.value)} />
                  </label>
                  <label className="block">Raw anchor clip ID (optional)
                    <input className="block border bg-background text-foreground" value={anchor} onChange={(event) => setAnchor(event.target.value)} />
                  </label>
                  <p>Place after this anchor, or at the end of the selected lane if the anchor is absent. One prompt and one image only.</p>
                </div>
              )}
              {timelinePlacement.unavailableReason && <p role="status">{timelinePlacement.unavailableReason}</p>}
              {placementError && <p role="alert">{placementError}</p>}
            </fieldset>
          )}
          <Suspense fallback={
            <div className="flex flex-col h-full">
              <div className="space-y-6 py-4 flex-1">
                {/* Main Content Layout - matches flex gap-6 flex-col md:flex-row */}
                <div className="flex gap-6 flex-col md:flex-row">
                  {/* Left Column - Prompts and Shot Selector */}
                  <div className="flex-1 space-y-6">
                    {/* PromptsSection skeleton */}
                    <div className="space-y-4">
                      <Skeleton className="h-8 w-32" />
                      <div className="space-y-3">
                        <Skeleton className="h-24 w-full rounded-md" />
                        <Skeleton className="h-24 w-full rounded-md" />
                      </div>
                      <div className="flex gap-2">
                        <Skeleton className="h-9 flex-1 rounded-md" />
                        <Skeleton className="h-9 w-24 rounded-md" />
                      </div>
                    </div>
                    {/* ShotSelector skeleton */}
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-10 w-full rounded-md" />
                    </div>
                  </div>

                  {/* Right Column - ModelSection */}
                  <div className="md:w-80 space-y-6">
                    {/* ModelSection skeleton */}
                    <div className="space-y-4">
                      <Skeleton className="h-8 w-40" />
                      <div className="space-y-3">
                        <Skeleton className="h-32 w-full rounded-md" />
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-10 w-full rounded-md" />
                        </div>
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-10 w-full rounded-md" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          }>
            <ImageGenerationForm
              onGenerate={handleGenerate}
              stickyFooter={true}
              footerPortalId={footerPortalId}
              initialShotId={initialShotId}
            />
          </Suspense>
        </div>

        {/* Footer portal target - outside scroll container so scrollbar appears behind it */}
        <div id={footerPortalId} className="-mx-6 -mb-6" />
      </DialogContent>
    </Dialog>
  );
};
