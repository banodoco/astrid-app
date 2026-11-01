/**
 * Shot-generation placement operations: add, remove, reorder images within
 * shots — all through the document-native placement service.
 *
 * Helpers live in ./shotMutationHelpers.ts
 */

import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getProjectSelectionFallbackId } from '@/shared/contexts/projectSelectionStore';
import { getShotPlacementTarget } from '@/shared/state/selectionStore';
import { GenerationRow } from '@/domains/generation/types';
import { toast } from '@/shared/components/ui/runtime/sonner';
import { enqueueGenerationsInvalidation } from '@/shared/hooks/invalidation';
import { queryKeys } from '@/shared/lib/queryKeys';
import {
  batchUpdatePlacementFrames,
  placeGeneration,
  unplaceGeneration,
  type PlaceGenerationRequest,
} from '@/shared/lib/placement/placementService';
import { placementEntryId } from '@/shared/lib/placement/documentPlacement';
import {
  runAddImageMutation,
  toAddImageErrorMessage,
  withVariableMetadata,
  type AddImageToShotVariables,
} from './addImageToShotHelpers';
import {
  cancelShotsQueries,
  findShotsCache,
  updateAllShotsCaches,
  rollbackShotsCaches,
  rollbackShotGenerationsCache,
  cancelShotGenerationsQuery
} from './cacheUtils';

// ============================================================================
// ADD IMAGE TO SHOT (unified hook)
// ============================================================================

type AddImageToShotWithoutPositionVariables = Omit<
  AddImageToShotVariables,
  'timelineFrame'
>;

function withPlacementTarget<T extends { project_id: string; shot_id: string; ownerRef?: PlaceGenerationRequest['ownerRef'] }>(variables: T): T {
  return variables.ownerRef === undefined ? {
    ...variables,
    ...getShotPlacementTarget(variables.project_id || getProjectSelectionFallbackId() || '', variables.shot_id),
  } : variables;
}

function withUnpositionedAddImageVariables(
  variables: AddImageToShotWithoutPositionVariables,
): AddImageToShotVariables {
  return {
    ...variables,
    timelineFrame: null,
  };
}

/**
 * Add a generation to a shot.
 *
 * This is the unified hook that handles both positioned and unpositioned additions:
 * - timelineFrame: undefined → auto-calculate position
 * - timelineFrame: null → add without position (appears in unpositioned section)
 * - timelineFrame: number → use explicit position
 */
export const useAddImageToShot = () => {
  const queryClient = useQueryClient();
  const mutation = useMutation<Record<string, unknown>, Error, AddImageToShotVariables>({
    mutationFn: async (variables: AddImageToShotVariables) => {
      const data = await runAddImageMutation(variables);
      return withVariableMetadata(data, variables);
    },

    onError: (error: Error) => {
      toast.error(`Failed to add image to shot: ${toAddImageErrorMessage(error)}`);
    },

    onSuccess: (_data, variables) => {
      const { project_id, shot_id } = variables;

      enqueueGenerationsInvalidation(queryClient, shot_id, {
        reason: 'add-image-to-shot',
        scope: 'all',
        includeShots: true,
        projectId: project_id,
        includeProjectUnified: true,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.segments.liveTimeline(shot_id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.segments.parents(shot_id, project_id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.generations.meta(shot_id) });
    },
  });

  // Capture selection and destination once per invocation, before React Query can retry it.
  const { mutateAsync: submitAsync, mutate: submit } = mutation;
  const mutateAsync = useCallback<typeof mutation.mutateAsync>(async (variables, options) =>
    submitAsync(withPlacementTarget(variables), options), [submitAsync]);
  const mutate = useCallback<typeof mutation.mutate>((variables, options) =>
    submit(withPlacementTarget(variables), options), [submit]);

  const mutateAsyncWithoutPosition = useCallback(
    async (variables: AddImageToShotWithoutPositionVariables) =>
      mutation.mutateAsync(withPlacementTarget(withUnpositionedAddImageVariables(variables))),
    [mutation],
  );

  const mutateWithoutPosition = useCallback(
    (variables: AddImageToShotWithoutPositionVariables) =>
      mutation.mutate(withPlacementTarget(withUnpositionedAddImageVariables(variables))),
    [mutation],
  );

  return {
    ...mutation,
    mutateAsync,
    mutate,
    mutateAsyncWithoutPosition,
    mutateWithoutPosition,
  };
};

// ============================================================================
// REMOVE IMAGE FROM SHOT
// ============================================================================

/**
 * Remove image from shot's timeline — pooled membership without a clip
 * (keepAsPooled). The placement expression leaves the document; the media
 * bytes stay in the registry.
 */
export const useRemoveImageFromShot = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      shotId,
      shotGenerationId,
      projectId,
      generationId,
      shiftItems,
    }: {
      shotId: string;
      shotGenerationId: string;
      projectId: string;
      /** Explicit generation id when the caller has it; otherwise derived from the entry id. */
      generationId?: string;
      /** When deleting the first item, shift remaining items back */
      shiftItems?: Array<{ id: string; newFrame: number }>;
    }) => {
      if (!shotId || !shotGenerationId || !projectId) {
        throw new Error(`Missing required parameters`);
      }

      const projectSlug = projectId || getProjectSelectionFallbackId();
      if (!projectSlug) {
        throw new Error('No project selected — cannot update image placement.');
      }

      const removed = resolveEntryParts(shotId, shotGenerationId);
      await unplaceGeneration({
        projectSlug,
        shotId,
        entryId: removed.entryId,
        generationId: generationId ?? removed.generationId,
        keepAsPooled: true,
      });

      // Persist frame shifts in ONE document CAS cycle (optimistic update
      // already applied in onMutate).
      if (shiftItems && shiftItems.length > 0) {
        await batchUpdatePlacementFrames({
          projectSlug,
          shotId,
          updates: shiftItems.map((item) => ({
            entryId: resolveEntryParts(shotId, item.id).entryId,
            timelineFrame: item.newFrame,
          })),
        });
      }

      return { shotId, shotGenerationId, projectId };
    },

    onMutate: async (variables) => {
      const { shotId, shotGenerationId, projectId, shiftItems } = variables;

      await cancelShotsQueries(queryClient, projectId);
      await cancelShotGenerationsQuery(queryClient, shotId);

      const previousShots = findShotsCache(queryClient, projectId);
      const previousFastGens = queryClient.getQueryData<GenerationRow[]>(
        queryKeys.generations.byShot(shotId)
      );

      // Build a shift lookup for items that need frame updates
      const shiftMap = new Map(shiftItems?.map(s => [s.id, s.newFrame]) ?? []);

      // Optimistically: set timeline_frame = null on deleted item + shift remaining
      if (previousFastGens) {
        queryClient.setQueryData(
          queryKeys.generations.byShot(shotId),
          previousFastGens.map(g => {
            if (g.id === shotGenerationId) return { ...g, timeline_frame: null };
            const shifted = shiftMap.get(g.id);
            if (shifted !== undefined) return { ...g, timeline_frame: shifted };
            return g;
          })
        );
      }

      if (previousShots) {
        updateAllShotsCaches(queryClient, projectId, (shots = []) =>
          shots.map(shot => {
            if (shot.id === shotId) {
              return {
                ...shot,
                images: (shot.images ?? []).map(img => {
                  if (img.id === shotGenerationId) return { ...img, timeline_frame: null };
                  const shifted = shiftMap.get(img.id);
                  if (shifted !== undefined) return { ...img, timeline_frame: shifted };
                  return img;
                }),
              };
            }
            return shot;
          })
        );
      }

      return { previousShots, previousFastGens, projectId, shotId };
    },

    onError: (err: Error, _variables, context) => {
      if (context?.previousShots && context.projectId) {
        rollbackShotsCaches(queryClient, context.projectId, context.previousShots);
      }
      if (context?.previousFastGens && context.shotId) {
        rollbackShotGenerationsCache(queryClient, context.shotId, context.previousFastGens);
      }

      toast.error(`Failed to remove image from timeline: ${err.message}`);
    },

    onSuccess: (data) => {
      // Invalidate segment queries
      queryClient.invalidateQueries({ queryKey: queryKeys.segments.liveTimeline(data.shotId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.segments.parents(data.shotId, data.projectId),
      });
    },
  });
};

/**
 * Callers identify placements either by the deterministic entry id
 * (`sg-<shotId>-<generationId>` — what placement reads surface as row id)
 * or by a bare generation id. Resolve both to the pair the placement
 * service needs; nothing else is accepted or parsed.
 */
function resolveEntryParts(shotId: string, idOrEntryId: string): { entryId: string; generationId: string } {
  const prefix = `sg-${shotId}-`;
  if (idOrEntryId.startsWith(prefix)) {
    return { entryId: idOrEntryId, generationId: idOrEntryId.slice(prefix.length) };
  }
  return { entryId: placementEntryId(shotId, idOrEntryId), generationId: idOrEntryId };
}

// ============================================================================
// UPDATE SHOT IMAGE ORDER
// ============================================================================

export const useUpdateShotImageOrder = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      updates,
      projectId,
      shotId,
    }: {
      updates: { shot_id: string; generation_id: string; timeline_frame: number }[];
      projectId: string;
      shotId: string;
    }) => {
      const projectSlug = projectId || getProjectSelectionFallbackId();
      if (!projectSlug) {
        throw new Error('No project selected — cannot reorder images.');
      }

      await batchUpdatePlacementFrames({
        projectSlug,
        shotId,
        updates: updates.map((update) => ({
          entryId: placementEntryId(update.shot_id, update.generation_id),
          timelineFrame: update.timeline_frame,
        })),
      });

      return { projectId, shotId, updates };
    },

    onMutate: async (variables) => {
      const { updates, shotId } = variables;

      await cancelShotGenerationsQuery(queryClient, shotId);

      const previousFastGens = queryClient.getQueryData<GenerationRow[]>(
        queryKeys.generations.byShot(shotId)
      );

      if (previousFastGens) {
        const updatedGens = previousFastGens.map(gen => {
          const update = updates.find(u => u.generation_id === gen.generation_id);
          if (update) {
            return { ...gen, timeline_frame: update.timeline_frame };
          }
          return gen;
        });

        updatedGens.sort((a, b) => (a.timeline_frame || 0) - (b.timeline_frame || 0));
        queryClient.setQueryData(queryKeys.generations.byShot(shotId), updatedGens);
      }

      return { previousFastGens, shotId };
    },

    onError: (_err: Error, _variables, context) => {
      if (context?.previousFastGens && context.shotId) {
        rollbackShotGenerationsCache(queryClient, context.shotId, context.previousFastGens);
      }

      toast.error('Failed to reorder images');
    },

    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.generations.meta(data.shotId) });
      queryClient.invalidateQueries({
        predicate: query => query.queryKey[0] === 'source-slot-generations',
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.segments.liveTimeline(data.shotId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.segments.parents(data.shotId, data.projectId) });
    },
  });
};

// ============================================================================
// POSITION EXISTING GENERATION IN SHOT
// ============================================================================

/**
 * Position an existing generation that has NULL timeline_frame.
 */
export const usePositionExistingGenerationInShot = () => {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async ({
      shot_id,
      generation_id,
      project_id,
      ownerRef,
      timelineRef,
    }: {
      shot_id: string;
      generation_id: string;
      project_id: string;
      /** Authenticated canonical occurrence owner; absent keeps parent-only callers unchanged. */
      ownerRef?: PlaceGenerationRequest['ownerRef'];
      timelineRef?: string;
    }) => {
      const projectSlug = project_id || getProjectSelectionFallbackId();
      if (!projectSlug) {
        throw new Error('No project selected — cannot position image.');
      }

      // Auto-position: the document places the clip after the shot's last
      // occupied frame (the old `p_with_position: true` RPC semantics).
      const placement = await placeGeneration({
        projectSlug,
        shotId: shot_id,
        generationId: generation_id,
        ...(ownerRef === undefined ? {} : { ownerRef }),
        ...(timelineRef === undefined ? {} : { timelineRef }),
      });

      return { shot_id, generation_id, project_id, placement };
    },

    onSuccess: (data) => {
      enqueueGenerationsInvalidation(queryClient, data.shot_id, {
        reason: 'add-image-to-shot',
        scope: 'all',
        includeShots: true,
        projectId: data.project_id,
        includeProjectUnified: true,
      });
    },

    onError: (error: Error) => {
      toast.error(`Failed to position image: ${error.message}`);
    },
  });
  const { mutateAsync: submitAsync, mutate: submit } = mutation;
  const mutateAsync = useCallback<typeof mutation.mutateAsync>(async (variables, options) =>
    submitAsync(withPlacementTarget(variables), options), [submitAsync]);
  const mutate = useCallback<typeof mutation.mutate>((variables, options) =>
    submit(withPlacementTarget(variables), options), [submit]);
  return { ...mutation, mutateAsync, mutate };
};
