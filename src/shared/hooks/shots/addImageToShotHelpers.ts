import { getProjectSelectionFallbackId } from '@/shared/contexts/projectSelectionStore';
import { placeGeneration, type PlaceGenerationRequest } from '@/shared/lib/placement/placementService';
import { isQuotaOrServerError } from './shotMutationHelpers';

export interface AddImageToShotVariables {
  shot_id: string;
  generation_id: string;
  project_id: string;
  imageUrl?: string;
  thumbUrl?: string;
  /** Authenticated canonical occurrence owner; absent keeps parent-only callers unchanged. */
  ownerRef?: PlaceGenerationRequest['ownerRef'];
  timelineRef?: string;
  timelineFrame?: number | null;
  abortSignal?: AbortSignal;
  onMaterializeProgress?: (progress: number) => void;
}

export const withVariableMetadata = (data: Record<string, unknown>, variables: AddImageToShotVariables) => ({
  ...data,
  project_id: variables.project_id,
  imageUrl: variables.imageUrl,
  thumbUrl: variables.thumbUrl,
});

/**
 * Place a generation into a shot on the timeline document (the only
 * placement authority).
 *
 * - timelineFrame: null     → pooled membership (no clip)
 * - timelineFrame: undefined → auto-position after the shot's last clip
 * - timelineFrame: number    → explicit frame
 */
export async function runAddImageMutation(
  variables: AddImageToShotVariables,
): Promise<Record<string, unknown>> {
  const { shot_id, generation_id, timelineFrame } = variables;

  const projectSlug = variables.project_id || getProjectSelectionFallbackId();
  if (!projectSlug) {
    throw new Error('No project selected — cannot place image into shot.');
  }

  const placement = await placeGeneration({
    projectSlug,
    shotId: shot_id,
    generationId: generation_id,
    ...(variables.ownerRef === undefined ? {} : { ownerRef: variables.ownerRef }),
    ...(variables.timelineRef === undefined ? {} : { timelineRef: variables.timelineRef }),
    timelineFrame,
  });

  // Record-like row shape keeps withVariableMetadata/consumers compatible;
  // `id` is the deterministic placement entry id.
  return {
    id: placement.entryId,
    shot_id: placement.shotId,
    generation_id: placement.generationId,
    timeline_frame: placement.timelineFrame,
  };
}

export function toAddImageErrorMessage(error: Error): string {
  if (error.message.includes('Load failed') || error.message.includes('TypeError')) {
    return 'Network connection issue. Please check your internet connection and try again.';
  }
  if (error.message.includes('fetch')) {
    return 'Unable to connect to server. Please try again in a moment.';
  }
  if (isQuotaOrServerError(error)) {
    return 'Server is temporarily busy. Please wait a moment before trying again.';
  }
  return error.message;
}
