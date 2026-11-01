import type { DragEvent, MutableRefObject } from 'react';
import type { GenerationDropData } from '@/shared/lib/dnd/dragDrop.ts';
import { getDragType } from '@/shared/lib/dnd/dragDrop.ts';
import { createAutoScroller } from '@/tools/video-editor/lib/auto-scroll.ts';
import { getCompatibleTrackId, updateClipOrder } from '@/tools/video-editor/lib/coordinate-utils.ts';
import { getTrackIndex } from '@/tools/video-editor/lib/editor-utils.ts';
import { inferDragKind } from '@/tools/video-editor/lib/drop-position.ts';
import { resolveOverlaps } from '@/tools/video-editor/lib/resolve-overlaps.ts';
import {
  getDroppedGenerationDurationContract,
} from '@/tools/video-editor/lib/timeline-asset-durations.ts';
import {
  buildAssetDropEdit,
  estimateAssetDuration,
  getPlayableAssetKind,
  planAssetDropTarget,
  planGenerationAssetRegistration,
} from '@/tools/video-editor/lib/timeline-asset-plans.ts';
import {
  createEffectLayerClipMeta,
  getNextClipId,
  type ClipMeta,
  type TimelineData,
} from '@/tools/video-editor/lib/timeline-data.ts';
import { getAssetResolutionToken } from '@/tools/video-editor/lib/asset-registry.ts';
import type { UseAssetManagementResult } from '@/tools/video-editor/hooks/useAssetManagement.ts';
import type { TimelineProvisionedAsset } from '@/tools/video-editor/commands/provisioning.ts';
import { canonicalJsonStringify } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import type { DragCoordinator } from '@/tools/video-editor/hooks/useDragCoordinator.ts';
import type {
  TimelineApplyEdit,
  TimelineInvalidateAssetRegistry,
  TimelineUploadAsset,
} from '@/tools/video-editor/hooks/timeline-state-types.ts';
import type { TrackKind } from '@/tools/video-editor/types/index.ts';
import type { TimelineAction } from '@/tools/video-editor/types/timeline-canvas.ts';
import {
  assertRuntimeMediaImportSize,
  RUNTIME_MEDIA_IMPORT_MAX_BYTES,
} from '@/tools/video-editor/data/AssetResolver.ts';

export type TimelineDropPosition = NonNullable<ReturnType<DragCoordinator['update']>>;

type PreparedGenerationDropData = Parameters<UseAssetManagementResult['prepareGenerationAsset']>[0];

function prepareGenerationForDrop(
  generationData: PreparedGenerationDropData,
  dataRef: MutableRefObject<TimelineData | null>,
  registerGenerationAsset: UseAssetManagementResult['registerGenerationAsset'],
  prepareGenerationAsset?: UseAssetManagementResult['prepareGenerationAsset'],
): TimelineProvisionedAsset | null {
  const prepared = prepareGenerationAsset?.(generationData);
  if (prepared) {
    return prepared;
  }
  const assetKey = registerGenerationAsset(generationData);
  const entry = assetKey ? dataRef.current?.registry.assets[assetKey] : undefined;
  const mediaType = getPlayableAssetKind(entry);
  if (!assetKey || !entry || !mediaType) {
    return null;
  }
  return {
    assetKey,
    mediaType,
    durationSeconds: entry.duration ?? null,
    entry,
    source: 'registered',
  };
}

export function isGenerationDragType(dragType: ReturnType<typeof getDragType>) {
  return dragType === 'generation' || dragType === 'generation-multi';
}

export function createTrack(
  dataRef: MutableRefObject<TimelineData | null>,
  kind: 'audio' | 'visual',
  insertAtTop: boolean,
  label?: string,
): { trackId: string; insertAtTop: boolean } | null {
  const current = dataRef.current;
  if (!current) {
    return null;
  }

  const prefix = kind === 'audio' ? 'A' : 'V';
  const nextNumber = getTrackIndex(current.tracks, prefix) + 1;
  const trackId = `${prefix}${nextNumber}`;
  const nextTrack = { id: trackId, kind, label: label ?? trackId };
  const nextRow = { id: trackId, actions: [] };

  dataRef.current = {
    ...current,
    tracks: insertAtTop ? [nextTrack, ...current.tracks] : [...current.tracks, nextTrack],
    rows: insertAtTop ? [nextRow, ...current.rows] : [...current.rows, nextRow],
  };

  return { trackId, insertAtTop };
}

export function createTrackAtTop(
  dataRef: MutableRefObject<TimelineData | null>,
  kind: 'audio' | 'visual',
  label?: string,
): { trackId: string; insertAtTop: true } | null {
  const createdTrack = createTrack(dataRef, kind, true, label);
  return createdTrack ? { ...createdTrack, insertAtTop: true } : null;
}

export function createTrackForDrop(
  dataRef: MutableRefObject<TimelineData | null>,
  kind: 'audio' | 'visual',
  insertAtTop: boolean,
  label?: string,
): { trackId: string; insertAtTop: boolean } | null {
  return insertAtTop
    ? createTrackAtTop(dataRef, kind, label)
    : createTrack(dataRef, kind, false, label);
}

export function removeAction(rows: TimelineData['rows'], actionId: string) {
  return rows.map((row) => ({
    ...row,
    actions: row.actions.filter((action) => action.id !== actionId),
  }));
}

export function inferFileDropKind(file: File): TrackKind {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return ['.mp3', '.wav', '.aac', '.m4a'].includes(extension) ? 'audio' : 'visual';
}

export function isImageFile(file: File): boolean {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return file.type.startsWith('image/')
    || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(extension);
}

export function isVideoFile(file: File): boolean {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return file.type.startsWith('video/')
    || ['.mp4', '.mov', '.webm', '.m4v', '.avi'].includes(extension);
}

/**
 * Places an effect-layer clip on a visual track. Shared by the desktop drop
 * handler and the editor's `onAddEffectLayerAt`, which has no drag position to resolve.
 */
export function insertEffectLayerAt({
  dataRef,
  trackId,
  time,
  forceNewTrack = false,
  insertAtTop = false,
  selectedTrackId,
  applyEdit,
}: {
  dataRef: MutableRefObject<TimelineData | null>;
  trackId: string | undefined;
  time: number;
  forceNewTrack?: boolean;
  insertAtTop?: boolean;
  selectedTrackId: string | null;
  applyEdit: TimelineApplyEdit;
}): boolean {
  let current = dataRef.current;
  if (!current) {
    return false;
  }

  let targetTrackId = forceNewTrack
    ? null
    : getCompatibleTrackId(current.tracks, trackId, 'visual', selectedTrackId);

  if (!targetTrackId) {
    targetTrackId = createTrackForDrop(dataRef, 'visual', insertAtTop)?.trackId ?? null;
    current = dataRef.current;
  }

  if (!targetTrackId || !current) {
    return true;
  }

  const clipId = getNextClipId(current.meta);
  const clipMeta = createEffectLayerClipMeta(targetTrackId);
  const duration = clipMeta.hold ?? 5;
  const action: TimelineAction = {
    id: clipId,
    start: Math.max(0, time),
    end: Math.max(0, time) + duration,
    effectId: `effect-${clipId}`,
  };
  const rowsWithClip = current.rows.map((row) => (
    row.id === targetTrackId
      ? { ...row, actions: [...row.actions, action] }
      : row
  ));
  const { rows: nextRows, metaPatches, adjustments: _adjustments } = resolveOverlaps(
    rowsWithClip,
    targetTrackId,
    clipId,
    current.meta,
  );
  const resolvedAction = nextRows
    .find((row) => row.id === targetTrackId)
    ?.actions.find((candidate) => candidate.id === clipId);
  const nextClipOrder = updateClipOrder(current.clipOrder, targetTrackId, (ids) => [...ids, clipId]);

  applyEdit({
    type: 'rows',
    rows: nextRows,
    metaUpdates: {
      ...metaPatches,
      [clipId]: {
        ...clipMeta,
        hold: resolvedAction ? Math.max(0.05, resolvedAction.end - resolvedAction.start) : clipMeta.hold,
      },
    },
    clipOrderOverride: nextClipOrder,
  });
  return true;
}

export function handleEffectLayerDrop({
  dataRef,
  dropPosition,
  insertAtTop,
  selectedTrackId,
  applyEdit,
}: {
  dataRef: MutableRefObject<TimelineData | null>;
  dropPosition: TimelineDropPosition;
  insertAtTop: boolean;
  selectedTrackId: string | null;
  applyEdit: TimelineApplyEdit;
}): boolean {
  return insertEffectLayerAt({
    dataRef,
    trackId: dropPosition.trackId,
    time: dropPosition.time,
    forceNewTrack: dropPosition.isNewTrack,
    insertAtTop,
    selectedTrackId,
    applyEdit,
  });
}

export async function handleFileDrop({
  files,
  dataRef,
  pendingOpsRef,
  dropPosition,
  insertAtTop,
  selectedTrackId,
  applyEdit,
  prepareAssetUpload,
  invalidateAssetRegistry,
  resolveAssetUrl,
  registerGenerationAsset,
  prepareGenerationAsset,
  uploadImageGeneration,
  uploadVideoGeneration,
  dropAsset,
  directAssetUploadAllFiles = false,
  mediaImportForImageVideo = false,
  onAssetDropError,
}: {
  files: File[];
  dataRef: MutableRefObject<TimelineData | null>;
  pendingOpsRef: MutableRefObject<number>;
  dropPosition: TimelineDropPosition;
  insertAtTop: boolean;
  selectedTrackId: string | null;
  applyEdit: TimelineApplyEdit;
  prepareAssetUpload?: TimelineUploadAsset;
  invalidateAssetRegistry: TimelineInvalidateAssetRegistry;
  resolveAssetUrl: (file: string) => Promise<string>;
  registerGenerationAsset: UseAssetManagementResult['registerGenerationAsset'];
  prepareGenerationAsset?: UseAssetManagementResult['prepareGenerationAsset'];
  uploadImageGeneration: UseAssetManagementResult['uploadImageGeneration'];
  uploadVideoGeneration: UseAssetManagementResult['uploadVideoGeneration'];
  dropAsset: UseAssetManagementResult['handleAssetDrop'];
  directAssetUploadAllFiles?: boolean;
  mediaImportForImageVideo?: boolean;
  onAssetDropError?: (error: unknown) => void;
}): Promise<boolean> {
  if (!files.length || !dataRef.current) {
    return false;
  }

  const defaultClipDuration = 5;
  let targetTrackId = dropPosition.isNewTrack
    ? undefined
    : dropPosition.trackId;
  let forceNewTrack = dropPosition.isNewTrack;
  let timeOffset = 0;

  for (const file of files) {
    const kind = inferFileDropKind(file);
    let compatibleTrackId = forceNewTrack
      ? null
      : getCompatibleTrackId(dataRef.current.tracks, targetTrackId, kind, selectedTrackId);
    const isImageVideo = isImageFile(file) || isVideoFile(file);
    const managedImageTrackId = directAssetUploadAllFiles && mediaImportForImageVideo
      && files.length === 1 && isImageFile(file)
      ? dropPosition.pointerTrackId
      : undefined;
    if (managedImageTrackId) {
      targetTrackId = managedImageTrackId;
      compatibleTrackId = managedImageTrackId;
      forceNewTrack = false;
    }

    // A direct host without Runtime media-import capability must not fall
    // through to browser storage, local materialization, or a legacy
    // generation writer. Keep this before track/skeleton/registry mutation.
    if (isImageVideo && directAssetUploadAllFiles && !mediaImportForImageVideo) {
      onAssetDropError?.(new Error('This editor backend does not support Runtime image/video imports'));
      continue;
    }

    // Runtime rejects objects above this boundary. Check before creating a
    // temporary uploading clip so an oversized local file is side-effect free.
    if (isImageVideo && mediaImportForImageVideo && file.size > RUNTIME_MEDIA_IMPORT_MAX_BYTES) {
      try {
        assertRuntimeMediaImportSize(file);
      } catch (error) {
        onAssetDropError?.(error);
      }
      continue;
    }

    // Runtime image/video drops go through the canonical media-import
    // settlement so the gallery generation and the timeline placement share
    // one catalog identity. Other file kinds can still use the provider's
    // generic prepared-object path.
    if (directAssetUploadAllFiles && !isImageVideo) {
      try {
        if (!prepareAssetUpload) {
          throw new Error('This editor backend does not support prepared asset placement');
        }
        const result = await prepareAssetUpload(file);
        const sourceReference = getAssetResolutionToken(result.entry);
        if (!sourceReference) throw new Error('Uploaded asset has no file locator or media identity');
        await resolveAssetUrl(sourceReference);
        const playableKind = getPlayableAssetKind(result.entry);
        if (!playableKind) throw new Error('Uploaded asset is not playable media');
        const preparedAsset: TimelineProvisionedAsset = {
          assetKey: result.assetId,
          mediaType: playableKind,
          durationSeconds: result.entry.duration ?? null,
          entry: result.entry,
          source: 'registered',
        };
        const placed = dropAsset(
          result.assetId,
          compatibleTrackId ?? targetTrackId,
          dropPosition.time + timeOffset,
          forceNewTrack,
          forceNewTrack ? insertAtTop : false,
          preparedAsset,
        );
        if (!placed) {
          throw new Error('The timeline drop target changed before the prepared asset was placed');
        }
        void invalidateAssetRegistry();

        if (!forceNewTrack || !dataRef.current) {
          timeOffset += estimateAssetDuration(result.entry, kind);
          continue;
        }

        const createdTrackId = compatibleTrackId
          ?? (insertAtTop ? dataRef.current.tracks[0]?.id : dataRef.current.tracks[dataRef.current.tracks.length - 1]?.id);
        if (createdTrackId) {
          targetTrackId = createdTrackId;
        }
        forceNewTrack = false;
        timeOffset += estimateAssetDuration(result.entry, kind);
        continue;
      } catch (error) {
        console.error('[drop] Upload failed:', error);
        onAssetDropError?.(error);
      }
      continue;
    }

    // Generic files have no generation-upload fallback. Fail before creating
    // a track or a skeleton when the provider cannot prepare a placement-owned
    // asset, so unsupported preparation stays side-effect free.
    if (!isImageFile(file) && !isVideoFile(file) && !prepareAssetUpload) {
      onAssetDropError?.(new Error('This editor backend does not support prepared asset placement'));
      continue;
    }

    if (!compatibleTrackId) {
      compatibleTrackId = createTrackForDrop(dataRef, kind, insertAtTop)?.trackId ?? null;
    }

    if (!compatibleTrackId || !dataRef.current) {
      continue;
    }

    const clipTime = dropPosition.time + timeOffset;
    timeOffset += defaultClipDuration;
    const dropScope = canonicalJsonStringify({ head: dataRef.current.head,
      composition: dataRef.current.config.app?.canonicalComposition });
    const currentDropData = () => {
      const current = dataRef.current;
      return current && canonicalJsonStringify({ head: current.head,
        composition: current.config.app?.canonicalComposition }) === dropScope ? current : null;
    };

    const skeletonId = `uploading-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const skeletonMeta: ClipMeta = {
      asset: `uploading:${file.name}`,
      track: compatibleTrackId,
      clipType: kind === 'audio' ? 'media' : 'hold',
      hold: kind === 'audio' ? undefined : defaultClipDuration,
      from: kind === 'audio' ? 0 : undefined,
      to: kind === 'audio' ? defaultClipDuration : undefined,
    };
    const skeletonAction: TimelineAction = {
      id: skeletonId,
      start: clipTime,
      end: clipTime + defaultClipDuration,
      effectId: `effect-${skeletonId}`,
    };

    const nextRows = dataRef.current.rows.map((row) =>
      row.id === compatibleTrackId
        ? { ...row, actions: [...row.actions, skeletonAction] }
        : row,
    );
    applyEdit({
      type: 'rows',
      rows: nextRows,
      metaUpdates: { [skeletonId]: skeletonMeta },
    }, { save: false });

    const removeSkeleton = () => {
      const current = currentDropData();
      if (!current) {
        return;
      }
      applyEdit({
        type: 'rows',
        rows: removeAction(current.rows, skeletonId),
        metaDeletes: [skeletonId],
      }, { save: false });
    };

    pendingOpsRef.current += 1;
    void (async () => {
      try {
        if (isImageFile(file)) {
          const generationData = await uploadImageGeneration(file);
          const current = currentDropData();
          if (!current) {
            return;
          }

          const preparedAsset = prepareGenerationForDrop(generationData, dataRef, registerGenerationAsset, prepareGenerationAsset);
          if (!preparedAsset) {
            removeSkeleton();
            return;
          }
          const preparedManagedImageTrackId = files.length === 1 && isImageFile(file) && preparedAsset.mediaSelection
            ? dropPosition.pointerTrackId
            : undefined;
          if (!dropAsset(preparedAsset.assetKey, preparedManagedImageTrackId ?? compatibleTrackId ?? undefined, clipTime,
            false, false, preparedAsset, skeletonId)) {
            removeSkeleton();
          }
          return;
        }

        if (isVideoFile(file)) {
          const generationData = await uploadVideoGeneration(file);
          const current = currentDropData();
          if (!current) {
            return;
          }

          const preparedAsset = prepareGenerationForDrop(generationData, dataRef, registerGenerationAsset, prepareGenerationAsset);
          if (!preparedAsset) {
            removeSkeleton();
            return;
          }
          if (!dropAsset(preparedAsset.assetKey, compatibleTrackId ?? undefined, clipTime, false, false, preparedAsset, skeletonId)) {
            removeSkeleton();
          }
          return;
        }

        // Preparation is required for placement: the compound editor command
        // owns registry + clip persistence.
        if (!prepareAssetUpload) {
          throw new Error('This editor backend does not support prepared asset placement');
        }
        const result = await prepareAssetUpload(file);
        const sourceReference = getAssetResolutionToken(result.entry);
        if (!sourceReference) throw new Error('Uploaded asset has no file locator or media identity');
        await resolveAssetUrl(sourceReference);
        const playableKind = getPlayableAssetKind(result.entry);
        if (!playableKind) throw new Error('Uploaded asset is not playable media');
        const preparedAsset: TimelineProvisionedAsset = {
          assetKey: result.assetId,
          mediaType: playableKind,
          durationSeconds: result.entry.duration ?? null,
          entry: result.entry,
          source: 'registered',
        };
        const placed = dropAsset(result.assetId, compatibleTrackId ?? undefined, clipTime, false, false, preparedAsset, skeletonId);
        if (!placed) {
          removeSkeleton();
        }
        void invalidateAssetRegistry();
      } catch (error) {
        console.error('[drop] Upload failed:', error);
        onAssetDropError?.(error);
        const current = dataRef.current;
        if (!current) {
          return;
        }

        removeSkeleton();
      } finally {
        pendingOpsRef.current -= 1;
      }
    })();
  }

  return true;
}

export function handleMultiGenerationDrop({
  generationItems,
  dataRef,
  dropPosition,
  insertAtTop,
  registerGenerationAsset,
  prepareGenerationAsset,
  selectedTrackId,
  dropAsset,
}: {
  generationItems: GenerationDropData[];
  dataRef: MutableRefObject<TimelineData | null>;
  dropPosition: TimelineDropPosition;
  insertAtTop: boolean;
  registerGenerationAsset: UseAssetManagementResult['registerGenerationAsset'];
  prepareGenerationAsset?: UseAssetManagementResult['prepareGenerationAsset'];
  selectedTrackId: string | null;
  dropAsset: UseAssetManagementResult['handleAssetDrop'];
}): boolean {
  if (!generationItems.length || !dataRef.current) {
    return false;
  }

  let targetTrackId = dropPosition.isNewTrack ? undefined : dropPosition.trackId;
  let forceNewTrack = dropPosition.isNewTrack;
  let timeOffset = 0;

  for (const generationData of generationItems) {
    const durationContract = getDroppedGenerationDurationContract(generationData);
    const assetDurationSeconds = durationContract.assetDurationSeconds;
    const clipSpanSeconds = durationContract.clipSpanSeconds ?? 5;
    const registrationPlan = planGenerationAssetRegistration({
      generationId: generationData.generationId,
      variantId: generationData.variantId,
      variantType: generationData.variantType,
      mediaId: generationData.mediaId,
      imageUrl: generationData.imageUrl,
      thumbUrl: generationData.thumbUrl,
      assetDurationSeconds,
      metadata: generationData.metadata,
    });
    if (!registrationPlan.ok) {
      continue;
    }

    const playableKind = getPlayableAssetKind(registrationPlan.assetEntry);
    if (!playableKind) {
      continue;
    }
    const assetKind = playableKind === 'audio' ? 'audio' : 'visual';
    const targetPlan = planAssetDropTarget({
      current: dataRef.current,
      assetKind,
      trackId: targetTrackId,
      selectedTrackId,
      forceNewTrack,
      insertAtTop: forceNewTrack ? insertAtTop : false,
      time: dropPosition.time + timeOffset,
      duration: clipSpanSeconds,
    });
    if (!targetPlan.ok) {
      continue;
    }
    const previewEdit = buildAssetDropEdit({
      current: targetPlan.preparedCurrent,
      assetKey: registrationPlan.assetId,
      assetEntry: registrationPlan.assetEntry,
      trackId: targetPlan.trackId,
      time: targetPlan.snappedTime ?? (dropPosition.time + timeOffset),
      clipSpanSeconds,
    });
    if (!previewEdit) {
      continue;
    }

    const trackIdsBeforeDrop = new Set(dataRef.current.tracks.map((track) => track.id));
    const preparedAsset = prepareGenerationForDrop({
      ...generationData,
      assetId: registrationPlan.assetId,
      ...(assetDurationSeconds !== null ? { durationSeconds: assetDurationSeconds } : {}),
    }, dataRef, registerGenerationAsset, prepareGenerationAsset);

    if (!preparedAsset) {
      continue;
    }

    dropAsset(
      preparedAsset.assetKey,
      targetTrackId,
      dropPosition.time + timeOffset,
      forceNewTrack,
      forceNewTrack ? insertAtTop : false,
      preparedAsset,
    );

    timeOffset += previewEdit.duration;

    if (!forceNewTrack || !dataRef.current) {
      continue;
    }

    const createdTrackId = dataRef.current.tracks.find((track) => !trackIdsBeforeDrop.has(track.id))?.id
      ?? (insertAtTop ? dataRef.current.tracks[0]?.id : dataRef.current.tracks[dataRef.current.tracks.length - 1]?.id);
    if (createdTrackId) {
      targetTrackId = createdTrackId;
    }
    forceNewTrack = false;
  }

  return true;
}

export function handleSingleGenerationDrop({
  generationData,
  dataRef,
  dropPosition,
  insertAtTop,
  registerGenerationAsset,
  prepareGenerationAsset,
  selectedTrackId,
  dropAsset,
}: {
  generationData: GenerationDropData;
  dataRef: MutableRefObject<TimelineData | null>;
  dropPosition: TimelineDropPosition;
  insertAtTop: boolean;
  registerGenerationAsset: UseAssetManagementResult['registerGenerationAsset'];
  prepareGenerationAsset?: UseAssetManagementResult['prepareGenerationAsset'];
  selectedTrackId: string | null;
  dropAsset: UseAssetManagementResult['handleAssetDrop'];
}): boolean {
  if (!dataRef.current) {
    return false;
  }

  const durationContract = getDroppedGenerationDurationContract(generationData);
  const assetDurationSeconds = durationContract.assetDurationSeconds;
  const clipSpanSeconds = durationContract.clipSpanSeconds ?? 5;
  const registrationPlan = planGenerationAssetRegistration({
    generationId: generationData.generationId,
    variantId: generationData.variantId,
    variantType: generationData.variantType,
    mediaId: generationData.mediaId,
    imageUrl: generationData.imageUrl,
    thumbUrl: generationData.thumbUrl,
    assetDurationSeconds,
    metadata: generationData.metadata,
  });
  if (!registrationPlan.ok) {
    return true;
  }
  const playableKind = getPlayableAssetKind(registrationPlan.assetEntry);
  if (!playableKind) {
    return true;
  }
  const assetKind = playableKind === 'audio' ? 'audio' : 'visual';
  const targetPlan = planAssetDropTarget({
    current: dataRef.current,
    assetKind,
    trackId: dropPosition.isNewTrack ? undefined : dropPosition.trackId,
    selectedTrackId,
    forceNewTrack: dropPosition.isNewTrack,
    insertAtTop,
    time: dropPosition.time,
    duration: clipSpanSeconds,
  });
  if (!targetPlan.ok) {
    return true;
  }
  const previewEdit = buildAssetDropEdit({
    current: targetPlan.preparedCurrent,
    assetKey: registrationPlan.assetId,
    assetEntry: registrationPlan.assetEntry,
    trackId: targetPlan.trackId,
    time: targetPlan.snappedTime ?? dropPosition.time,
    clipSpanSeconds,
  });
  if (!previewEdit) {
    return true;
  }

  const preparedAsset = prepareGenerationForDrop({
    ...generationData,
    assetId: registrationPlan.assetId,
    ...(assetDurationSeconds !== null ? { durationSeconds: assetDurationSeconds } : {}),
  }, dataRef, registerGenerationAsset, prepareGenerationAsset);
  if (!preparedAsset) {
    return true;
  }

  dropAsset(
    preparedAsset.assetKey,
    dropPosition.isNewTrack ? undefined : dropPosition.trackId,
    dropPosition.time,
    dropPosition.isNewTrack,
    insertAtTop,
    preparedAsset,
  );
  return true;
}

export function handleAssetDrop({
  assetKey,
  assetKind,
  dataRef,
  dropPosition,
  insertAtTop,
  selectedTrackId,
  dropAsset,
}: {
  assetKey: string;
  assetKind: TrackKind;
  dataRef: MutableRefObject<TimelineData | null>;
  dropPosition: TimelineDropPosition;
  insertAtTop: boolean;
  selectedTrackId: string | null;
  dropAsset: UseAssetManagementResult['handleAssetDrop'];
}): boolean {
  if (!assetKey || !dataRef.current) {
    return false;
  }

  if (dropPosition.isNewTrack) {
    dropAsset(assetKey, undefined, dropPosition.time, true, insertAtTop);
    return true;
  }

  const compatibleTrackId = getCompatibleTrackId(
    dataRef.current.tracks,
    dropPosition.trackId,
    assetKind || 'visual',
    selectedTrackId,
  );
  if (!compatibleTrackId) {
    return true;
  }

  dropAsset(assetKey, compatibleTrackId, dropPosition.time);
  return true;
}

export function finalizeExternalDrop({
  event,
  coordinator,
  autoScrollerRef,
  externalDragFrameRef,
  latestExternalDragRef,
  latestExternalPositionRef,
  managedImage = false,
}: {
  event: DragEvent<HTMLDivElement>;
  coordinator: DragCoordinator;
  autoScrollerRef: MutableRefObject<ReturnType<typeof createAutoScroller> | null>;
  externalDragFrameRef: MutableRefObject<number | null>;
  latestExternalDragRef: MutableRefObject<{
    clientX: number;
    clientY: number;
    sourceKind: TrackKind | null;
    managedImage?: boolean;
  } | null>;
  latestExternalPositionRef: MutableRefObject<ReturnType<DragCoordinator['update']> | null>;
  managedImage?: boolean;
}): TimelineDropPosition {
  event.preventDefault();
  delete event.currentTarget.dataset.dragOver;
  autoScrollerRef.current?.stop();
  autoScrollerRef.current = null;
  if (externalDragFrameRef.current !== null) {
    window.cancelAnimationFrame(externalDragFrameRef.current);
    externalDragFrameRef.current = null;
  }

  if (latestExternalDragRef.current) {
    latestExternalPositionRef.current = coordinator.update({
      clientX: latestExternalDragRef.current.clientX,
      clientY: latestExternalDragRef.current.clientY,
      sourceKind: latestExternalDragRef.current.sourceKind,
      managedImage: latestExternalDragRef.current.managedImage,
    });
  }

  const dropPosition = coordinator.lastPosition
    ?? latestExternalPositionRef.current
    ?? coordinator.update({
      clientX: event.clientX,
      clientY: event.clientY,
      sourceKind: inferDragKind(event),
      managedImage,
    });

  latestExternalDragRef.current = null;
  latestExternalPositionRef.current = null;
  coordinator.end();
  return dropPosition;
}
