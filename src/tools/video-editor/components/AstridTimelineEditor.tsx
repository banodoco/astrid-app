import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shallow } from 'zustand/shallow';
import type { Shot } from '@/domains/generation/types/index.ts';
import { Dialog, DialogContent, DialogTitle } from '@/shared/components/ui/dialog.tsx';
import { toast } from '@/shared/components/ui/runtime/sonner.tsx';
import { normalizeAndPresentError } from '@/shared/lib/errorHandling/runtimeError.ts';
import { useOnRecoveryCardCleared, useRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { useProjectSelectionContext } from '@/shared/contexts/ProjectContext.tsx';
import { useShots } from '@/shared/contexts/ShotsContext.tsx';
import { useShotNavigation } from '@/shared/hooks/shots/useShotNavigation.ts';
import { VideoGenerationModal } from '@/tools/travel-between-images/components/VideoGenerationModal.tsx';
import { LocalTimelineShotBrowser } from '@/tools/travel-between-images/pages/LocalTimelineShotBrowser.tsx';
import { AstridLocalClient } from '@/integrations/astrid/client.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { TimelineEditorCore, resolveSelectedGenerationIdsForShotCreation } from '@/tools/video-editor/components/TimelineEditor/TimelineEditorCore.tsx';
import { useActiveTaskClips } from '@/tools/video-editor/hooks/useActiveTaskClips.ts';
import {
  formatManagedOutputExportReceipt,
  useFinalVideoAvailable,
} from '@/tools/video-editor/hooks/useFinalVideoAvailable.ts';
import {
  usePinnedGroupSync,
  usePinnedShotGroups,
  usePinnedShotGroupViews,
} from '@/tools/video-editor/hooks/usePinnedShotGroups.ts';
import { useShotGroupHandlers } from '@/tools/video-editor/hooks/useShotGroupHandlers.ts';
import { useShotGroups } from '@/tools/video-editor/hooks/useShotGroups.ts';
import { shotGroupVideoKey } from '@/tools/video-editor/hooks/useShotGroups.ts';
import { useSwitchToFinalVideo } from '@/tools/video-editor/hooks/useSwitchToFinalVideo.ts';
import { useTimelineCommandsService } from '@/tools/video-editor/hooks/useTimelineCommandsService.ts';
import {
  useTimelineDataSelector,
  useTimelineChromeSelector,
  useTimelineConfigVersion,
  useTimelineOpsSelector,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { planGenerationAssetRegistration } from '@/tools/video-editor/lib/timeline-asset-plans.ts';
import { duplicateGenerationAsset } from '@/tools/video-editor/lib/generation-utils.ts';
import {
  duplicateShotGroup,
  promotePrimaryVariant,
} from '@/tools/video-editor/lib/shot-group-pack-commands.ts';
import {
  duplicateIndependentShot,
} from '@/tools/video-editor/data/shotCompositionEditor.ts';
import type {
  CanonicalShotOccurrence,
  PreparedShotComposition,
  ShotPlacement,
} from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import type { CanonicalShotTimelinePublication } from '@/tools/video-editor/runtime/ports.ts';
import { managedOutputMatchesOccurrence } from '@/tools/video-editor/data/shotCompositionProjection.ts';
import { useEditorTourRunning } from '@/shared/state/editorTourStore.ts';
import { usePanesStore } from '@/shared/state/panesStore.ts';

interface AstridTimelineEditorProps {
  onOpenSequenceCreator?: () => void;
  onOpenExtensionManager?: () => void;
  onOpenElementCreationPrompt?: (prompt: string) => void;
}

const EMPTY_ASSET_GENERATION_MAP: Record<string, string> = {};
const EMPTY_SHOT_PLACEMENTS: readonly ShotPlacement[] = [];

type PublishedCanonicalCompositionOverride = Readonly<{
  composition: PreparedShotComposition;
  staleHeadRevisionIds: readonly (string | null)[];
}>;

export type CanonicalLoadState = 'legacy' | 'loading' | 'current' | 'error' | 'stale';

export function getCanonicalLoadState(input: {
  canonicalRoute: boolean;
  isLoading: boolean;
  hasComposition: boolean;
  error: Error | null | undefined;
}): CanonicalLoadState {
  if (!input.canonicalRoute) return 'legacy';
  if (input.isLoading) return 'loading';
  if (input.error) return input.hasComposition ? 'stale' : 'error';
  if (input.hasComposition) return 'current';
  // A canonical route without either a snapshot or an error is still waiting
  // for its first successful read. It must not be treated as legacy content.
  return 'loading';
}

export function shouldKeepPublishedCanonicalCompositionOverride(
  publishedHeadRevisionId: string,
  staleHeadRevisionIds: readonly (string | null)[],
  runtimeHeadRevisionId: string | null,
): boolean {
  if (runtimeHeadRevisionId === publishedHeadRevisionId) return false;
  if (runtimeHeadRevisionId === null) return true;
  return staleHeadRevisionIds.includes(runtimeHeadRevisionId);
}

function AstridTimelineEditorComponent({ onOpenSequenceCreator, onOpenElementCreationPrompt, onOpenExtensionManager }: AstridTimelineEditorProps) {
  const editorContentRef = useRef<HTMLDivElement>(null);
  const [videoModalShot, setVideoModalShot] = useState<Shot | null>(null);
  const [videoModalShowImages, setVideoModalShowImages] = useState(false);
  const [canonicalShotEditor, setCanonicalShotEditor] = useState<CanonicalShotOccurrence | null>(null);
  const [duplicatingClipId, setDuplicatingClipId] = useState<string | null>(null);
  const { navigateToShot } = useShotNavigation();
  const { selectedProjectId } = useProjectSelectionContext();
  const { shots } = useShots();
  const isGenerationsPaneLocked = usePanesStore((state) => state.isGenerationsPaneLocked);
  const isGenerationsPaneOpen = usePanesStore((state) => state.isGenerationsPaneOpen);
  const effectiveGenerationsPaneHeight = usePanesStore((state) => state.effectiveGenerationsPaneHeight);
  const runtime = useVideoEditorRuntime();
  // The hosted build's "Astrid stopped" / "restarted" card is what tells the person what to do; this banner stays quiet then.
  const recoveryCardShowing = useRecoveryCardShowing();
  // On the hosted build the friendly cards own every failed-to-load moment (TimelineLoadErrorCard, the stopped and
  // restarted cards): the engineer-worded "canonical shot composition" lines never reach a person there.
  const hosted = runtimeOrigin() !== '';
  // Astrid answering again clears the card; the refresh that failed while it was stopped is retried here, so the
  // "Couldn't refresh this timeline" line does not outlive the stop it was about.
  useOnRecoveryCardCleared(() => {
    if (runtime.shots?.canonicalCompositionError ?? runtime.shots?.error) runtime.shots?.refetchShots();
  });
  const isDocumentShotMode = runtime.userId === null;
  // The tour's demo timeline is in-memory local mode, which this banner would misreport as a missing shot composition.
  const tourRunning = useEditorTourRunning();
  const canonicalOccurrences = runtime.shots?.canonicalOccurrences ?? [];
  const pendingOccurrences = (runtime.shots as (typeof runtime.shots & {
    pendingOccurrences?: readonly ShotPlacement[];
  }))?.pendingOccurrences ?? EMPTY_SHOT_PLACEMENTS;
  const hasCanonicalOccurrences = canonicalOccurrences.length > 0;
  // Route from the configured authority, not from the data returned by it:
  // an empty or failed canonical read must not activate UUID/legacy groups.
  const isCanonicalEditor = isDocumentShotMode && Boolean(runtime.shots?.shotComposition);
  const canonicalLoadState = getCanonicalLoadState({
    canonicalRoute: isCanonicalEditor,
    isLoading: Boolean(runtime.shots?.isLoading),
    hasComposition: Boolean(runtime.shots?.canonicalComposition),
    error: runtime.shots?.canonicalCompositionError ?? runtime.shots?.error,
  });
  const [publishedCanonicalComposition, setPublishedCanonicalComposition] = useState<PublishedCanonicalCompositionOverride | null>(null);
  useEffect(() => {
    const shellRoot = editorContentRef.current?.closest<HTMLElement>('[data-video-editor-instance]');
    if (!shellRoot) return undefined;
    const previousInert = shellRoot.inert;
    const hadInertAttribute = shellRoot.hasAttribute('inert');
    shellRoot.inert = Boolean(canonicalShotEditor);
    shellRoot.toggleAttribute('inert', Boolean(canonicalShotEditor));
    return () => {
      shellRoot.inert = previousInert;
      shellRoot.toggleAttribute('inert', hadInertAttribute);
    };
  }, [canonicalShotEditor]);
  useEffect(() => {
    setPublishedCanonicalComposition(null);
  }, [runtime.timelineId]);
  const runtimeCanonicalHeadRevisionId = runtime.shots?.canonicalComposition?.headRevisionId ?? null;
  useEffect(() => {
    if (!publishedCanonicalComposition) return;
    if (!shouldKeepPublishedCanonicalCompositionOverride(
      publishedCanonicalComposition.composition.headRevisionId,
      publishedCanonicalComposition.staleHeadRevisionIds,
      runtimeCanonicalHeadRevisionId,
    )) {
      setPublishedCanonicalComposition(null);
    }
  }, [publishedCanonicalComposition, runtimeCanonicalHeadRevisionId]);
  const handleCanonicalCompositionPublished = useCallback((
    composition: PreparedShotComposition,
    publication?: CanonicalShotTimelinePublication,
  ) => {
    const hostHead = runtime.shots?.canonicalComposition?.headRevisionId ?? null;
    const expectedHead = publication?.expectedHeadRevisionId !== undefined
      ? publication.expectedHeadRevisionId
      : composition.publicationReceipt?.expectedHead !== undefined
        ? composition.publicationReceipt.expectedHead
      : hostHead;
    setPublishedCanonicalComposition({
      composition,
      staleHeadRevisionIds: [...new Set([hostHead, expectedHead])],
    });
    runtime.shots?.adoptCanonicalComposition?.(composition, publication);
  }, [runtime.shots]);
  const configVersion = useTimelineConfigVersion();
  const reloadFromServer = useTimelineChromeSelector((chrome) => chrome.reloadFromServer);
  const {
    data,
    resolvedConfig,
    dataRef,
    selectedClipIds,
    selectedDataItems,
    interactionStateRef,
  } = useTimelineDataSelector((timeline) => ({
    data: timeline.data,
    resolvedConfig: timeline.resolvedConfig,
    dataRef: timeline.dataRef,
    selectedClipIds: timeline.selectedClipIds,
    selectedDataItems: timeline.selectedDataItems,
    interactionStateRef: timeline.interactionStateRef,
  }), shallow);
  const commands = useTimelineCommandsService();
  const {
    applyEdit,
    prepareGenerationAsset,
    registerGenerationAsset,
  } = useTimelineOpsSelector((ops) => ({
    applyEdit: ops.applyEdit,
    prepareGenerationAsset: ops.prepareGenerationAsset,
    registerGenerationAsset: ops.registerGenerationAsset,
  }), shallow);

  const assetGenerationMap = useMemo<Record<string, string>>(() => {
    const assets = data?.registry?.assets;
    if (!assets) {
      return EMPTY_ASSET_GENERATION_MAP;
    }

    return Object.entries(assets).reduce<Record<string, string>>((acc, [assetKey, assetEntry]) => {
      if (typeof assetEntry?.generationId === 'string' && assetEntry.generationId.length > 0) {
        acc[assetKey] = assetEntry.generationId;
      }
      return acc;
    }, {});
  }, [data?.registry?.assets]);

  const selectionShotCreationState = useMemo(() => {
    if (!data?.rows || !data?.meta) {
      return { canCreateShot: false, generationIds: [] as string[], orderedClipIds: [] as string[], trackId: undefined as string | undefined };
    }

    return resolveSelectedGenerationIdsForShotCreation({
      rows: data.rows,
      meta: data.meta,
      assetGenerationMap,
      selectedClipIds,
    });
  }, [assetGenerationMap, data?.meta, data?.rows, selectedClipIds]);

  const existingShotsForSelection = useMemo(() => {
    if (selectionShotCreationState.generationIds.length === 0 || !shots?.length) {
      return [] as Shot[];
    }

    return shots.filter((shot) => {
      const shotGenerationIds = new Set(
        (shot.images ?? [])
          .map((image) => image.generation_id)
          .filter((generationId): generationId is string => typeof generationId === 'string' && generationId.length > 0),
      );

      return selectionShotCreationState.generationIds.every((generationId) => shotGenerationIds.has(generationId));
    });
  }, [selectionShotCreationState.generationIds, shots]);

  const {
    pinGroup,
    unpinGroup,
  } = usePinnedShotGroups({
    dataRef,
    applyEdit,
    enabled: !isCanonicalEditor,
  });

  const handleCreateDocumentShotFromSelection = useCallback(async (): Promise<Shot | null> => {
    if (selectedDataItems?.length || !selectionShotCreationState.canCreateShot) return null;
    const trackId = selectionShotCreationState.trackId;
    const orderedClipIds = selectionShotCreationState.orderedClipIds;
    if (!trackId) return null;
    const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? String(Date.now());
    pinGroup(`shot-${suffix}`, trackId, orderedClipIds, 'New shot');
    return null;
  }, [pinGroup, selectionShotCreationState, selectedDataItems]);

  const handleNavigateToShot = useCallback((shot: Shot) => {
    navigateToShot(shot, { isNewlyCreated: true });
  }, [navigateToShot]);

  const handleOpenGenerateVideo = useCallback((shot: Shot) => {
    setVideoModalShot(shot);
  }, []);

  const { activeTaskAssetKeys } = useActiveTaskClips({ registry: resolvedConfig?.registry });
  const {
    finalVideoMap,
    dismissFinalVideo,
    exportRuntimeManagedOutput,
  } = useFinalVideoAvailable();

  const handleExportManagedOutput = useCallback(async (group: { shotId: string; clipIds: string[]; rowId: string; canonicalIdentity?: CanonicalShotOccurrence }) => {
    const finalVideo = finalVideoMap.get(shotGroupVideoKey(group));
    const managedOutput = finalVideo?.managedOutput;
    if (!managedOutput) {
      toast.error('Selected final video is not a Runtime-managed output.');
      return;
    }
    if (group.canonicalIdentity
      && finalVideo?.canonicalOccurrenceId !== group.canonicalIdentity.occurrenceId
      && !managedOutputMatchesOccurrence(managedOutput as unknown as Record<string, unknown>, group.canonicalIdentity)) {
      toast.error('The selected managed output does not belong to this shot occurrence.');
      return;
    }

    try {
      const result = await exportRuntimeManagedOutput(managedOutput);
      toast.success('Managed output exported', {
        description: `${formatManagedOutputExportReceipt(result)} · receipt_id=${result.receipt.receipt_id} · event_ids=${result.receipt.event_ids.join(',') || 'none'}`,
        duration: 10_000,
      });
    } catch (error) {
      normalizeAndPresentError(error, {
        context: 'video-editor:export-managed-output',
        toastTitle: 'Failed to export managed output',
      });
    }
  }, [exportRuntimeManagedOutput, finalVideoMap]);
  const documentShotGroups = usePinnedShotGroupViews(data, !isDocumentShotMode);
  const legacyCanonicalShellClipIds = useMemo(() => new Set(Object.entries(data?.meta ?? {})
    .filter(([, clip]) => clip.clipType === 'shot')
    .map(([clipId]) => clipId)), [data?.meta]);
  const shotGroups = useShotGroups(
    data?.rows ?? [],
    documentShotGroups,
    isCanonicalEditor ? canonicalOccurrences : [],
    isCanonicalEditor ? runtime.shots?.canonicalThumbnailUrls : undefined,
    legacyCanonicalShellClipIds,
    isCanonicalEditor ? pendingOccurrences : EMPTY_SHOT_PLACEMENTS,
  );

  const handleOpenCanonicalOccurrence = useCallback((occurrence: CanonicalShotOccurrence) => {
    // Reuse the canonical travel-tool browser/editor inside a dialog. The
    // stable deep link remains the identity, but the parent timeline route is
    // left untouched so closing the editor returns to the exact same canvas.
    setCanonicalShotEditor(occurrence);
  }, []);

  const handleDuplicateDocumentShotGroup = useCallback(async (locator: { shotId: string; trackId: string; canonicalIdentity?: CanonicalShotOccurrence }) => {
    if (locator.canonicalIdentity && runtime.shots?.shotComposition && runtime.shots.canonicalComposition) {
      const occurrence = locator.canonicalIdentity;
      const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? String(Date.now());
      try {
        const graph = duplicateIndependentShot(
          runtime.shots.canonicalComposition.contract,
          occurrence.occurrenceId,
          {
            shotId: `${occurrence.shotId}-copy-${suffix}`,
            revisionId: `${occurrence.revisionId}-copy-${suffix}`,
            internalTimelineRevisionId: `${occurrence.revisionId}-timeline-copy-${suffix}`,
            occurrenceId: `${occurrence.occurrenceId}-copy-${suffix}`,
          },
        );
        await runtime.shots.shotComposition.publish?.({
          projectId: occurrence.projectId,
          parentDocumentId: occurrence.parentDocumentId,
          expectedHeadRevisionId: runtime.shots.canonicalComposition.headRevisionId,
          graph,
        });
        runtime.shots.refetchShots();
        toast.success('Independent shot duplicated');
      } catch (error) {
        normalizeAndPresentError(error, {
          context: 'video-editor:duplicate-canonical-shot',
          toastTitle: 'Failed to duplicate canonical shot',
        });
      }
      return;
    }

    const projectSlug = runtime.project.projectId;
    if (!projectSlug) {
      toast.error('Select an Astrid project before duplicating a shot.');
      return;
    }
    const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? String(Date.now());
    try {
      await duplicateShotGroup({
        projectSlug,
        timelineRef: runtime.timelineId,
        configVersion,
        source: locator,
        destinationShotId: `${locator.shotId}-copy-${suffix}`,
        destinationTrackId: locator.trackId,
      });
      await reloadFromServer();
      toast.success('Shot duplicated');
    } catch (error) {
      normalizeAndPresentError(error, {
        context: 'video-editor:duplicate-shot-group',
        toastTitle: 'Failed to duplicate shot',
      });
    }
  }, [configVersion, reloadFromServer, runtime.project.projectId, runtime.shots, runtime.timelineId]);

  const handlePromoteDocumentShotGroupPrimary = useCallback(async (locator: { shotId: string; trackId: string }) => {
    const projectSlug = runtime.project.projectId;
    const group = shotGroups.find((candidate) => (
      candidate.shotId === locator.shotId && candidate.rowId === locator.trackId
    ));
    if (!projectSlug || !group) {
      toast.error('The active Astrid shot is unavailable.');
      return;
    }
    try {
      const client = new AstridLocalClient({
        projectSlug,
        baseUrl: (runtime.provider as { apiBaseUrl?: string }).apiBaseUrl,
      });
      const generationIds = Array.from(new Set([
        ...Object.keys(group.variantIdsByGenerationId),
        ...group.poolGenerationIds,
      ]));
      let candidate: { generationId: string; variantId: string } | null = null;
      for (const generationId of generationIds) {
        const detail = await client.gallery.get(generationId);
        const alternative = detail.variants.find((variant) => !variant.is_primary);
        if (alternative) {
          candidate = { generationId, variantId: alternative.id };
          break;
        }
      }
      if (!candidate) {
        toast.info('This shot has no alternate variant to promote.');
        return;
      }
      await promotePrimaryVariant({
        projectSlug,
        timelineRef: runtime.timelineId,
        configVersion,
        ...candidate,
      });
      await reloadFromServer();
      toast.success('Primary variant promoted');
    } catch (error) {
      normalizeAndPresentError(error, {
        context: 'video-editor:promote-shot-primary',
        toastTitle: 'Failed to promote primary variant',
      });
    }
  }, [configVersion, reloadFromServer, runtime.project.projectId, runtime.provider, runtime.timelineId, shotGroups]);
  const {
    switchToFinalVideo,
    updateToLatestVideo,
    switchToImages,
  } = useSwitchToFinalVideo({
    applyEdit,
    dataRef,
    finalVideoMap,
    commands,
  });
  const {
    shotGroupClipIds,
    activeTaskClipIds,
    staleShotGroupIds,
    handleShotGroupNavigate,
    handleShotGroupGenerateVideo,
    handleDeleteShotGroup,
    handleUpdateToLatestVideo,
    handleShotGroupUnpin,
    handleShotGroupSwitchToFinalVideo,
    handleShotGroupSwitchToImages,
  } = useShotGroupHandlers({
    shots: isDocumentShotMode ? undefined : shots,
    shotGroups,
    data,
    resolvedRegistry: resolvedConfig?.registry,
    activeTaskAssetKeys,
    finalVideoMap,
    applyEdit,
    dataRef,
    dismissFinalVideo,
    switchToFinalVideo,
    switchToImages,
    updateToLatestVideo,
    unpinGroup,
    setVideoModalShot,
    setVideoModalShowImages,
  });

  const isInteractionActive = useCallback(() => {
    return interactionStateRef.current.drag || interactionStateRef.current.resize;
  }, [interactionStateRef]);

  usePinnedGroupSync({
    data,
    dataRef,
    applyEdit,
    shots: isDocumentShotMode ? undefined : shots,
    registerGenerationAsset,
    prepareGenerationAsset,
    isInteractionActive,
    enabled: !isCanonicalEditor,
  });

  const handleOpenShotVideoModal = useCallback((shotId: string) => {
    const shot = shots?.find((candidate) => candidate.id === shotId);
    if (shot) {
      setVideoModalShot(shot);
    }
  }, [shots]);

  const handleDuplicateGenerationClip = useCallback(async (clipId: string) => {
    if (!selectedProjectId) {
      toast.error('Select a project before duplicating a generation.');
      return;
    }

    const current = dataRef.current;
    if (!current) {
      return;
    }

    const clipMeta = current.meta[clipId];
    const assetKey = clipMeta?.asset;
    const assetEntry = assetKey ? current.registry.assets[assetKey] : undefined;
    const generationId = assetEntry?.generationId;
    if (!generationId) {
      toast.error('This clip is not linked to a generation.');
      return;
    }

    setDuplicatingClipId(clipId);
    try {
      const duplicatedGeneration = await duplicateGenerationAsset({
        generationId,
        projectId: selectedProjectId,
      });
      const registrationPlan = planGenerationAssetRegistration({
        generationId: duplicatedGeneration.generationId,
        variantId: duplicatedGeneration.variantId,
        variantType: duplicatedGeneration.variantType,
        imageUrl: duplicatedGeneration.imageUrl,
        thumbUrl: duplicatedGeneration.thumbUrl,
        assetDurationSeconds: typeof assetEntry?.duration === 'number' ? assetEntry.duration : undefined,
        metadata: {
          content_type: assetEntry?.type ?? (
            duplicatedGeneration.variantType === 'video' ? 'video/mp4' : 'image/png'
          ),
        },
      });

      if (!registrationPlan.ok) {
        throw new Error('Failed to register the duplicated asset.');
      }

      const result = commands.addClip({
        preparedAsset: {
          assetKey: registrationPlan.assetId,
          mediaType: duplicatedGeneration.variantType,
          durationSeconds: registrationPlan.assetEntry.duration ?? null,
          entry: registrationPlan.assetEntry,
          source: 'registered',
        },
        afterClipId: clipId,
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      normalizeAndPresentError(error, {
        context: 'video-editor:duplicate-generation-clip',
        toastTitle: 'Failed to duplicate generation',
      });
    } finally {
      setDuplicatingClipId((currentClipId) => (currentClipId === clipId ? null : currentClipId));
    }
  }, [commands, dataRef, selectedProjectId]);

  return (
    <div ref={editorContentRef} className="contents">
      {!hosted && !tourRunning && isDocumentShotMode && !isCanonicalEditor ? (
        <div role="status" data-canonical-load-state="legacy" className="border-b px-3 py-1.5 text-center text-xs">
          Canonical shot composition is unavailable; showing the explicit legacy shot view.
        </div>
      ) : null}
      {isCanonicalEditor && !recoveryCardShowing && (canonicalLoadState === 'stale' || (canonicalLoadState === 'error' && !hosted)) ? (
        <div
          role={canonicalLoadState === 'error' ? 'alert' : 'status'}
          data-canonical-load-state={canonicalLoadState}
          className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-center text-xs text-amber-900 dark:text-amber-100"
        >
          {canonicalLoadState === 'error' && 'Could not load the canonical shot composition. Legacy shot data was not substituted.'}
          {canonicalLoadState === 'stale' && "Couldn't refresh this timeline. Showing your last saved version."}
          <button type="button" className="ml-2 underline" onClick={() => runtime.shots?.refetchShots()}>
            Try again
          </button>
        </div>
      ) : null}
      {runtime.shots?.canonicalDraft ? (
        <div
          role="status"
          data-unsaved-shot-timeline-draft="true"
          className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-center text-xs text-amber-900 dark:text-amber-100"
        >
          Main timeline preview includes unsaved shot changes. Parent timeline editing is paused until that shot is saved.
        </div>
      ) : null}
      <TimelineEditorCore
        onOpenSequenceCreator={onOpenSequenceCreator}
        onOpenExtensionManager={onOpenExtensionManager}
        onOpenElementCreationPrompt={onOpenElementCreationPrompt}
        finalVideoMap={finalVideoMap}
        shotGroups={shotGroups}
        canonicalOccurrences={canonicalOccurrences}
        staleShotGroupIds={staleShotGroupIds}
        activeTaskClipIds={activeTaskClipIds}
        shotGroupClipIds={shotGroupClipIds}
        onShotGroupNavigate={isDocumentShotMode ? undefined : handleShotGroupNavigate}
        onShotGroupOpen={hasCanonicalOccurrences ? handleOpenCanonicalOccurrence : undefined}
        onShotGroupGenerateVideo={isDocumentShotMode ? undefined : handleShotGroupGenerateVideo}
        onShotGroupDuplicate={isDocumentShotMode ? handleDuplicateDocumentShotGroup : undefined}
        onShotGroupPromotePrimary={isDocumentShotMode ? handlePromoteDocumentShotGroupPrimary : undefined}
        onShotGroupUnpin={isCanonicalEditor ? undefined : handleShotGroupUnpin}
        onShotGroupDelete={isCanonicalEditor ? undefined : handleDeleteShotGroup}
        onShotGroupSwitchToFinalVideo={isCanonicalEditor ? undefined : handleShotGroupSwitchToFinalVideo}
        onShotGroupExportManagedOutput={handleExportManagedOutput}
        onShotGroupSwitchToImages={isCanonicalEditor ? undefined : handleShotGroupSwitchToImages}
        onShotGroupUpdateToLatestVideo={isCanonicalEditor ? undefined : handleUpdateToLatestVideo}
        canCreateShotFromSelection={!selectedDataItems?.length && selectionShotCreationState.canCreateShot}
        existingShots={isDocumentShotMode ? [] : existingShotsForSelection}
        onCreateShotFromSelection={isDocumentShotMode ? handleCreateDocumentShotFromSelection : undefined}
        onNavigateToShot={isDocumentShotMode ? undefined : handleNavigateToShot}
        onOpenGenerateVideo={isDocumentShotMode ? undefined : handleOpenGenerateVideo}
        duplicatingClipId={duplicatingClipId}
        onDuplicateGenerationClip={handleDuplicateGenerationClip}
        onOpenShotVideoModal={isDocumentShotMode ? undefined : handleOpenShotVideoModal}
      />

      {!isDocumentShotMode && videoModalShot && (
        <VideoGenerationModal
          isOpen={true}
          onClose={() => { setVideoModalShot(null); setVideoModalShowImages(false); }}
          shot={videoModalShot}
          defaultTopOpen={videoModalShowImages}
        />
      )}

      <Dialog
        open={Boolean(canonicalShotEditor)}
        modal={false}
        disablePointerDismissal
        onOpenChange={(open) => {
          if (!open) setCanonicalShotEditor(null);
        }}
      >
        <DialogContent
          modal={false}
          showBackdrop={false}
          className="h-[min(90vh,900px)] max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl overflow-hidden p-0"
          style={{
            top: '1rem',
            transform: 'translateX(-50%)',
            maxHeight: `calc(100dvh - ${isGenerationsPaneLocked || isGenerationsPaneOpen ? effectiveGenerationsPaneHeight : 0}px - 1rem)`,
          }}
          finalFocus={false}
          onKeyDown={(event) => {
            // This dialog has no trigger element. Handle Escape here so the
            // parent timeline's pointer/focus surface cannot receive the
            // dismissal event and immediately reopen the shot editor.
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setCanonicalShotEditor(null);
          }}
        >
          <DialogTitle className="sr-only">
            {canonicalShotEditor ? `Edit ${canonicalShotEditor.shotId}` : 'Edit shot'}
          </DialogTitle>
          {canonicalShotEditor && (
            <div className="h-full min-h-0 overflow-y-auto">
              <LocalTimelineShotBrowser
                projectSlug={runtime.project.projectSlug ?? runtime.project.projectId ?? canonicalShotEditor.projectId}
                projectId={runtime.project.projectId ?? undefined}
                timelineRef={canonicalShotEditor.parentDocumentId}
                shotCompositionAdapter={runtime.shots.shotComposition ?? undefined}
                shotRef={canonicalShotEditor.stableDeepLink}
                initialComposition={publishedCanonicalComposition?.composition ?? runtime.shots.canonicalComposition ?? undefined}
                onClose={() => setCanonicalShotEditor(null)}
                onCanonicalCompositionPublished={handleCanonicalCompositionPublished}
                onCanonicalDraftSessionChange={(scope, active) => {
                  if (active) runtime.shots?.beginCanonicalDraftSession?.(scope);
                  else runtime.shots?.endCanonicalDraftSession?.(scope);
                }}
                onCanonicalDraftProjectionChange={(draft) => runtime.shots?.setCanonicalDraftProjection?.(draft)}
                onCanonicalDraftProjectionClear={(scope, generation) => (
                  runtime.shots?.clearCanonicalDraftProjection?.(scope, generation)
                )}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const AstridTimelineEditor = memo(AstridTimelineEditorComponent);
