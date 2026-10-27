import { useCallback, useEffect, useRef } from 'react';
import {
  getGenerationDropData,
  getMultiGenerationDropData,
  getShotDropData,
  getDragType,
} from '@/shared/lib/dnd/dragDrop.ts';
import { getMediaUrl, getThumbnailUrl } from '@/shared/lib/media/mediaTypeHelpers.ts';
import { isInvalidTimelineRowTarget, inferDragKind } from '@/tools/video-editor/lib/drop-position.ts';
import { resolveFinalVideoDurationSeconds } from '@/tools/video-editor/lib/finalVideoAssets.ts';
import {
  EXTERNAL_DROP_VISIBLE_VIDEO_FALLBACK_SECONDS,
  getFinalVideoDropDurationContract,
} from '@/tools/video-editor/lib/timeline-asset-durations.ts';
import {
  getPlayableAssetKind,
  planAssetDropTarget,
  planFinalVideoGenerationAssetRegistration,
  planGenerationAssetRegistration,
} from '@/tools/video-editor/lib/timeline-asset-plans.ts';
import type { DragCoordinator } from '@/tools/video-editor/hooks/useDragCoordinator.ts';
import { buildAssetDropEdit } from '@/tools/video-editor/lib/timeline-asset-plans.ts';
import type { UseAssetManagementResult } from '@/tools/video-editor/hooks/useAssetManagement.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import type {
  TimelineApplyEdit,
  TimelineInvalidateAssetRegistry,
  TimelineUploadAsset,
} from '@/tools/video-editor/hooks/timeline-state-types.ts';
import { type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import {
  finalizeExternalDrop,
  handleAssetDrop,
  handleEffectLayerDrop,
  handleFileDrop,
  handleMultiGenerationDrop,
  handleSingleGenerationDrop,
  isGenerationDragType,
  isImageFile,
  type TimelineDropPosition,
  type TimelineFileDropPosition,
} from '@/tools/video-editor/lib/external-drop-utils.ts';
import { RafLoopDetector } from '@/tools/video-editor/lib/perf-diagnostics.ts';
import { buildPinnedShotGroupsOverride } from '@/tools/video-editor/lib/shot-group-commands.ts';
import type { TrackKind } from '@/tools/video-editor/types/index.ts';
import { createAutoScroller } from '@/tools/video-editor/lib/auto-scroll.ts';
import type { Shot } from '@/domains/generation/types/index.ts';
import type { ShotFinalVideo } from '@/tools/video-editor/hooks/useFinalVideoAvailable.ts';
import type { TimelineStoreApi } from '@/tools/video-editor/hooks/timelineStore.ts';
import {
  applyPanelClipPlacement,
  isPanelClipDrag,
  planPanelClipPlacement,
  readPanelClipDrag,
} from '@/tools/video-editor/lib/panel-clip-drag.ts';

async function resolveFinalVideoDurationSecondsWithRetry(
  finalVideo: Parameters<typeof resolveFinalVideoDurationSeconds>[0],
  assets?: TimelineData['registry']['assets'],
): Promise<number | null> {
  const firstAttempt = await resolveFinalVideoDurationSeconds(finalVideo, assets);
  if (typeof firstAttempt === 'number') {
    return firstAttempt;
  }

  return resolveFinalVideoDurationSeconds(finalVideo, assets);
}

async function dispatchTimelineDrop({
  event,
  dataRef,
  dropPosition,
  selectedTrackId,
  applyEdit,
  registerGenerationAsset,
  prepareGenerationAsset,
  dropAsset,
  shots,
  finalVideoMap,
  onPanelClipDrop,
  onFilesDrop,
}: {
  onFilesDrop: (files: File[], position: TimelineDropPosition) => Promise<boolean>;
  event: React.DragEvent<HTMLDivElement>;
  dataRef: React.MutableRefObject<TimelineData | null>;
  dropPosition: TimelineDropPosition;
  selectedTrackId: string | null;
  applyEdit: TimelineApplyEdit;
  registerGenerationAsset: UseAssetManagementResult['registerGenerationAsset'];
  prepareGenerationAsset?: UseAssetManagementResult['prepareGenerationAsset'];
  dropAsset: UseAssetManagementResult['handleAssetDrop'];
  shots: Shot[] | undefined;
  finalVideoMap: Map<string, { id: string; location: string; thumbnailUrl: string | null; durationSeconds?: number | null }>;
  onPanelClipDrop?: (dropPosition: TimelineDropPosition) => Promise<void>;
}) {
  const insertAtTop = Boolean(dropPosition.isNewTrackTop);

  if (isPanelClipDrag(event.dataTransfer.types)) {
    await onPanelClipDrop?.(dropPosition);
    return;
  }

  if (event.dataTransfer.types.includes('effect-layer')) {
    handleEffectLayerDrop({ dataRef, dropPosition, insertAtTop, selectedTrackId, applyEdit });
    return;
  }

  if (await onFilesDrop(Array.from(event.dataTransfer.files), dropPosition)) return;

  const shotData = getShotDropData(event);
  if (shotData) {
    const finalVideo = finalVideoMap.get(shotData.shotId);
    if (finalVideo) {
      const assetDurationSeconds = await resolveFinalVideoDurationSecondsWithRetry(finalVideo, dataRef.current?.registry.assets);
      const durationContract = getFinalVideoDropDurationContract(assetDurationSeconds);
      const registrationPlan = planFinalVideoGenerationAssetRegistration({
        generationId: finalVideo.id,
        imageUrl: finalVideo.location,
        thumbUrl: finalVideo.thumbnailUrl ?? finalVideo.location,
        assetDurationSeconds: durationContract.assetDurationSeconds,
      });
      if (!registrationPlan.ok) {
        return;
      }

      const resolvedTarget = planAssetDropTarget({
        current: dataRef.current,
        assetKind: 'visual',
        trackId: dropPosition.isNewTrack ? undefined : dropPosition.trackId,
        selectedTrackId,
        forceNewTrack: dropPosition.isNewTrack,
        insertAtTop,
        time: dropPosition.time,
        duration: durationContract.clipSpanSeconds ?? EXTERNAL_DROP_VISIBLE_VIDEO_FALLBACK_SECONDS,
      });
      if (!resolvedTarget.ok) {
        return;
      }

      const nextEdit = buildAssetDropEdit({
        current: resolvedTarget.preparedCurrent,
        assetKey: registrationPlan.assetId,
        assetEntry: registrationPlan.assetEntry,
        trackId: resolvedTarget.trackId,
        time: resolvedTarget.snappedTime ?? dropPosition.time,
        clipSpanSeconds: durationContract.clipSpanSeconds,
      });
      if (!nextEdit) {
        return;
      }

      const generationData = {
        assetId: registrationPlan.assetId,
        generationId: finalVideo.id,
        variantType: 'video',
        imageUrl: finalVideo.location,
        thumbUrl: finalVideo.thumbnailUrl ?? finalVideo.location,
        ...(typeof durationContract.assetDurationSeconds === 'number'
          ? { durationSeconds: durationContract.assetDurationSeconds }
          : {}),
        metadata: {
          content_type: 'video/mp4',
        },
      };
      let asset = prepareGenerationAsset?.(generationData) ?? null;
      if (!asset) {
        const priorDataRef = dataRef.current;
        dataRef.current = resolvedTarget.preparedCurrent;
        const assetKey = registerGenerationAsset(generationData);
        const entry = assetKey ? dataRef.current?.registry.assets[assetKey] : undefined;
        dataRef.current = priorDataRef;
        if (!assetKey || !entry) {
          return;
        }
        asset = {
          assetKey,
          mediaType: 'video',
          durationSeconds: entry.duration ?? durationContract.assetDurationSeconds,
          entry,
          source: 'registered',
        };
      }
      const assetKey = asset.assetKey;
      if (!assetKey) {
        return;
      }
      const preparedEdit = buildAssetDropEdit({
        current: resolvedTarget.preparedCurrent,
        assetKey,
        assetEntry: asset.entry,
        trackId: resolvedTarget.trackId,
        time: resolvedTarget.snappedTime ?? dropPosition.time,
        clipSpanSeconds: durationContract.clipSpanSeconds,
      });
      if (!preparedEdit) {
        return;
      }
      dataRef.current = resolvedTarget.preparedCurrent;
      const nextData: TimelineData = {
        ...resolvedTarget.preparedCurrent,
        rows: preparedEdit.rows,
        meta: {
          ...resolvedTarget.preparedCurrent.meta,
          ...preparedEdit.metaUpdates,
        },
        clipOrder: preparedEdit.clipOrderOverride,
      };
      const nextRegistry = {
        ...resolvedTarget.preparedCurrent.registry,
        assets: {
          ...resolvedTarget.preparedCurrent.registry.assets,
          [asset.assetKey]: asset.entry,
        },
      };

      applyEdit({
        type: 'rows',
        rows: preparedEdit.rows,
        metaUpdates: preparedEdit.metaUpdates,
        clipOrderOverride: preparedEdit.clipOrderOverride,
        pinnedShotGroupsOverride: buildPinnedShotGroupsOverride(nextData, {
          shotId: shotData.shotId,
          trackId: resolvedTarget.trackId,
          clipIds: [preparedEdit.clipId],
          mode: 'video',
          videoAssetKey: assetKey,
        }),
        registryOverride: nextRegistry,
      }, {
        selectedClipId: preparedEdit.clipId,
        selectedTrackId: resolvedTarget.trackId,
      });
      return;
    }

    const shot = shots?.find((candidate) => candidate.id === shotData.shotId);
    const shotImages = shotData.imageGenerationIds
      .map((generationId) => shot?.images?.find((image) => image.generation_id === generationId))
      .filter((image): image is NonNullable<NonNullable<typeof shot>['images']>[number] => {
        return Boolean(image?.generation_id && getMediaUrl(image));
      });
    const shotGroupDuration = shotImages.length * 5;
    const resolvedTarget = planAssetDropTarget({
      current: dataRef.current,
      assetKind: 'visual',
      trackId: dropPosition.isNewTrack ? undefined : dropPosition.trackId,
      selectedTrackId,
      forceNewTrack: dropPosition.isNewTrack,
      insertAtTop,
      time: dropPosition.time,
      duration: shotGroupDuration,
    });

    if (!shot || !resolvedTarget.ok || shotImages.length === 0) {
      return;
    }
    const priorDataRef = dataRef.current;
    let workingData = resolvedTarget.preparedCurrent;
    const metaUpdates: Record<string, TimelineData['meta'][string]> = {};
    const createdClipIds: string[] = [];
    const baseTime = resolvedTarget.snappedTime ?? dropPosition.time;
    let timeOffset = 0;
    let hasPreparedTimelineState = false;

    for (const shotImage of shotImages) {
      const imageUrl = getMediaUrl(shotImage);
      if (!shotImage.generation_id) continue;
      if (!imageUrl) continue;
      const registrationPlan = planGenerationAssetRegistration({
        generationId: shotImage.generation_id,
        variantType: 'image',
        imageUrl,
        thumbUrl: getThumbnailUrl(shotImage) ?? imageUrl,
        metadata: {
          content_type: shotImage.contentType ?? shotImage.type ?? 'image/png',
        },
      });
      if (!registrationPlan.ok) {
        continue;
      }

      const nextEdit = buildAssetDropEdit({
        current: workingData,
        assetKey: registrationPlan.assetId,
        assetEntry: registrationPlan.assetEntry,
        trackId: resolvedTarget.trackId,
        time: baseTime + timeOffset,
      });
      if (!nextEdit) {
        continue;
      }

      if (!hasPreparedTimelineState) {
        dataRef.current = resolvedTarget.preparedCurrent;
        hasPreparedTimelineState = true;
      }
      const generationData = {
        assetId: registrationPlan.assetId,
        generationId: shotImage.generation_id,
        variantType: 'image',
        imageUrl,
        thumbUrl: getThumbnailUrl(shotImage) ?? imageUrl,
        metadata: {
          content_type: shotImage.contentType ?? shotImage.type ?? 'image/png',
        },
      };
      const preparedAsset = prepareGenerationAsset?.(generationData);
      let asset = preparedAsset;
      if (!asset) {
        dataRef.current = workingData;
        const assetKey = registerGenerationAsset(generationData);
        const entry = assetKey ? workingData.registry.assets[assetKey] : undefined;
        if (!assetKey || !entry) {
          continue;
        }
        asset = {
          assetKey,
          mediaType: getPlayableAssetKind(entry) ?? 'image',
          durationSeconds: entry.duration ?? null,
          entry,
          source: 'registered' as const,
        };
      }
      if (!asset) {
        continue;
      }

      const assetKey = asset.assetKey;
      const nextEditWithPreparedAsset = buildAssetDropEdit({
        current: workingData,
        assetKey,
        assetEntry: asset.entry,
        trackId: resolvedTarget.trackId,
        time: baseTime + timeOffset,
      });
      if (!nextEditWithPreparedAsset) {
        continue;
      }
      Object.assign(metaUpdates, nextEditWithPreparedAsset.metaUpdates);
      createdClipIds.push(nextEditWithPreparedAsset.clipId);
      timeOffset += nextEditWithPreparedAsset.duration;
      workingData = {
        ...workingData,
        rows: nextEditWithPreparedAsset.rows,
        meta: {
          ...workingData.meta,
          ...nextEditWithPreparedAsset.metaUpdates,
        },
        clipOrder: nextEditWithPreparedAsset.clipOrderOverride,
        registry: {
          ...workingData.registry,
          assets: {
            ...workingData.registry.assets,
            [assetKey]: asset.entry,
          },
        },
      };
    }

    if (createdClipIds.length === 0) {
      dataRef.current = priorDataRef;
      return;
    }
    const nextPinnedShotGroups = buildPinnedShotGroupsOverride(workingData, {
      shotId: shot.id,
      trackId: resolvedTarget.trackId,
      clipIds: createdClipIds,
      mode: 'images',
    });

    dataRef.current = workingData;
    applyEdit({
      type: 'rows',
      rows: workingData.rows,
      metaUpdates,
      clipOrderOverride: workingData.clipOrder,
      registryOverride: workingData.registry,
      pinnedShotGroupsOverride: nextPinnedShotGroups,
    }, {
      selectedClipId: createdClipIds[0] ?? null,
      selectedTrackId: resolvedTarget.trackId,
    });
    return;
  }

  const multiGenerationData = getMultiGenerationDropData(event);
  if (multiGenerationData?.length) {
    handleMultiGenerationDrop({
      generationItems: multiGenerationData,
      dataRef,
      dropPosition,
      insertAtTop,
      registerGenerationAsset,
      prepareGenerationAsset,
      selectedTrackId,
      dropAsset,
    });
    return;
  }

  const generationData = getGenerationDropData(event);
  if (generationData) {
    handleSingleGenerationDrop({
      generationData,
      dataRef,
      dropPosition,
      insertAtTop,
      registerGenerationAsset,
      prepareGenerationAsset,
      selectedTrackId,
      dropAsset,
    });
    return;
  }

  handleAssetDrop({
    assetKey: event.dataTransfer.getData('asset-key'),
    assetKind: event.dataTransfer.getData('asset-kind') as TrackKind,
    dataRef,
    dropPosition,
    insertAtTop,
    selectedTrackId,
    dropAsset,
  });
}

export interface UseExternalDropArgs {
  store?: TimelineStoreApi;
  dataRef: React.MutableRefObject<TimelineData | null>;
  pendingOpsRef: React.MutableRefObject<number>;
  scale: number;
  scaleWidth: number;
  selectedTrackId: string | null;
  applyEdit: TimelineApplyEdit;
  prepareAssetUpload?: TimelineUploadAsset;
  invalidateAssetRegistry: TimelineInvalidateAssetRegistry;
  resolveAssetUrl: (file: string) => Promise<string>;
  coordinator: DragCoordinator;
  registerGenerationAsset: UseAssetManagementResult['registerGenerationAsset'];
  prepareGenerationAsset?: UseAssetManagementResult['prepareGenerationAsset'];
  uploadImageGeneration: UseAssetManagementResult['uploadImageGeneration'];
  uploadVideoGeneration: UseAssetManagementResult['uploadVideoGeneration'];
  handleAssetDrop: UseAssetManagementResult['handleAssetDrop'];
  handleAssetBatchDrop?: UseAssetManagementResult['handleAssetBatchDrop'];
  onSeekToTime?: (time: number) => void;
  shots?: Shot[] | undefined;
  finalVideoMap: Map<string, ShotFinalVideo>;
}

export interface UseExternalDropResult {
  addMediaFiles: (files: File[], time: number) => Promise<void>;
  onTimelineDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onTimelineDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onTimelineDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}

export function useExternalDrop({
  store,
  dataRef,
  pendingOpsRef,
  selectedTrackId,
  applyEdit,
  prepareAssetUpload,
  invalidateAssetRegistry,
  resolveAssetUrl,
  coordinator,
  registerGenerationAsset,
  prepareGenerationAsset,
  uploadImageGeneration,
  uploadVideoGeneration,
  handleAssetDrop: dropAsset,
  handleAssetBatchDrop: dropAssets,
  onSeekToTime,
  shots,
  finalVideoMap,
}: UseExternalDropArgs): UseExternalDropResult {
  const runtime = useVideoEditorRuntime();
  // Declared capability, not a type sniff: the Astrid provider declares it,
  // everything else (including future providers) opts in explicitly.
  const directAssetUploadAllFiles = runtime.provider.supportsDirectAssetUpload === true;
  const mediaImportForImageVideo = typeof runtime.provider.prepareMediaImport === 'function';
  const externalDragFrameRef = useRef<number | null>(null);
  const autoScrollerRef = useRef<ReturnType<typeof createAutoScroller> | null>(null);
  const latestExternalDragRef = useRef<{
    clientX: number;
    clientY: number;
    sourceKind: TrackKind | null;
    managedImage?: boolean;
  } | null>(null);
  const latestExternalPositionRef = useRef<ReturnType<DragCoordinator['update']> | null>(null);
  const getDataRef = useCallback(() => {
    const storeDataRef = store?.getState().data.dataRef;
    return storeDataRef && storeDataRef.current !== null ? storeDataRef : dataRef;
  }, [dataRef, store]);
  const getPendingOpsRef = useCallback(() => {
    return store?.getState().data.pendingOpsRef ?? pendingOpsRef;
  }, [pendingOpsRef, store]);
  const getSelectedTrackId = useCallback(() => {
    return store?.getState().data.selectedTrackId ?? selectedTrackId;
  }, [selectedTrackId, store]);
  const getApplyEdit = useCallback(() => {
    return store?.getState().ops.applyEdit ?? applyEdit;
  }, [applyEdit, store]);
  const importFiles = useCallback((files: File[], dropPosition: TimelineFileDropPosition) => handleFileDrop({
    files, dropPosition, insertAtTop: Boolean(dropPosition.isNewTrackTop),
    dataRef: getDataRef(), pendingOpsRef: getPendingOpsRef(), selectedTrackId: getSelectedTrackId(),
    applyEdit: getApplyEdit(), prepareAssetUpload, invalidateAssetRegistry, resolveAssetUrl,
    registerGenerationAsset, prepareGenerationAsset, uploadImageGeneration, uploadVideoGeneration,
    dropAsset, dropAssets, directAssetUploadAllFiles, mediaImportForImageVideo,
    onAssetDropError: (error) => runtime.toast.error('Failed to save asset', {
      ...(error instanceof Error && error.message ? { description: error.message } : {}),
    }),
  }), [getDataRef, getPendingOpsRef, getSelectedTrackId, getApplyEdit, prepareAssetUpload,
    invalidateAssetRegistry, resolveAssetUrl, registerGenerationAsset, prepareGenerationAsset,
    uploadImageGeneration, uploadVideoGeneration, dropAsset, dropAssets, directAssetUploadAllFiles,
    mediaImportForImageVideo, runtime.toast]);
  const addMediaFiles = useCallback(async (files: File[], time: number) => {
    if (!files.length || runtime.timelineEditability?.checkTimeline?.().allowed === false) return;
    await importFiles(files, { time: Math.max(0, time), trackId: getSelectedTrackId() ?? undefined, isNewTrack: false });
    onSeekToTime?.(time);
  }, [getSelectedTrackId, importFiles, onSeekToTime, runtime.timelineEditability]);
  const isManagedImageFileDrag = useCallback((event: React.DragEvent<HTMLDivElement>): boolean => {
    if (!mediaImportForImageVideo) return false;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 1) return isImageFile(files[0]);
    const imageItems = Array.from(event.dataTransfer.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    return files.length === 0 && imageItems.length === 1;
  }, [mediaImportForImageVideo]);
  const placePanelClip = useCallback(async (
    dropPosition: TimelineDropPosition,
    drag: NonNullable<ReturnType<typeof readPanelClipDrag>>,
  ) => {
    const state = store?.getState();
    const ops = state?.timelineOps;
    const reader = state?.timelineReader;
    const current = getDataRef().current;
    if (!state || !ops || !reader || !current) return;
    try {
      const snapshot = reader.snapshot();
      const placement = planPanelClipPlacement({
        drag,
        tracks: current.tracks,
        clipIds: new Set(snapshot.clips.map((clip) => clip.id)),
        trackId: dropPosition.isNewTrack ? undefined : dropPosition.trackId,
        isNewTrack: Boolean(dropPosition.isNewTrack),
        selectedTrackId: getSelectedTrackId(),
        time: dropPosition.time,
        version: snapshot.baseVersion,
      });
      if (!placement) return;
      const clipId = await applyPanelClipPlacement(ops, placement);
      // Same selection as "Add to video" / an asset drop: the new clip, on its track.
      state.ops.selectClips([clipId]);
      state.ops.setSelectedTrackId?.(placement.trackId);
    } catch (error) {
      runtime.toast.error('Could not add the clip', {
        ...(error instanceof Error && error.message ? { description: error.message } : {}),
      });
    }
  }, [getDataRef, getSelectedTrackId, runtime.toast, store]);
  const clearExternalDragState = useCallback(() => {
    if (externalDragFrameRef.current !== null) {
      window.cancelAnimationFrame(externalDragFrameRef.current);
      externalDragFrameRef.current = null;
    }
    autoScrollerRef.current?.stop();
    autoScrollerRef.current = null;
    latestExternalDragRef.current = null;
    latestExternalPositionRef.current = null;
    coordinator.end();
  }, [coordinator]);

  useEffect(() => {
    return () => {
      clearExternalDragState();
    };
  }, [clearExternalDragState]);

  const onTimelineDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const dragType = getDragType(event);
    const types = Array.from(event.dataTransfer.types);
    if (!types.includes('asset-key')
      && !isPanelClipDrag(types)
      && !types.includes('effect-layer')
      && dragType !== 'file'
      && dragType !== 'shot'
      && !isGenerationDragType(dragType)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.dataset.dragOver = 'true';
    latestExternalDragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      sourceKind: inferDragKind(event),
      managedImage: isManagedImageFileDrag(event),
    };
    if (!autoScrollerRef.current && coordinator.editAreaRef.current) {
      autoScrollerRef.current = createAutoScroller(coordinator.editAreaRef.current, (clientX, clientY) => {
        const currentDrag = latestExternalDragRef.current;
        if (!currentDrag) {
          return;
        }

        latestExternalPositionRef.current = coordinator.update({
          clientX,
          clientY,
          sourceKind: currentDrag.sourceKind,
          managedImage: currentDrag.managedImage,
        });
      });
    }
    autoScrollerRef.current?.update(event.clientX, event.clientY);

    if (externalDragFrameRef.current !== null) {
      return;
    }

    externalDragFrameRef.current = window.requestAnimationFrame(() => {
      RafLoopDetector.track('externalDrop');
      externalDragFrameRef.current = null;
      const currentDrag = latestExternalDragRef.current;
      if (!currentDrag) {
        return;
      }

      latestExternalPositionRef.current = coordinator.update({
        clientX: currentDrag.clientX,
        clientY: currentDrag.clientY,
        sourceKind: currentDrag.sourceKind,
        managedImage: currentDrag.managedImage,
      });
    });
  }, [coordinator, isManagedImageFileDrag]);

  const onTimelineDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget as Node | null;
    // Ignore dragleave events that bubble up from child elements when the drag
    // is still inside the timeline wrapper; only clear state when actually leaving.
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    delete event.currentTarget.dataset.dragOver;
    clearExternalDragState();
  }, [clearExternalDragState]);

  const onTimelineDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    const permission = runtime.timelineEditability?.checkTimeline?.();
    if (permission?.allowed === false) {
      event.preventDefault();
      event.stopPropagation();
      delete event.currentTarget.dataset.dragOver;
      clearExternalDragState();
      return;
    }
    // Read before anything awaits: a DataTransfer is only readable during the event.
    const panelClip = isPanelClipDrag(event.dataTransfer.types) ? readPanelClipDrag(event.dataTransfer) : null;
    const dropPosition = finalizeExternalDrop({
      event,
      coordinator,
      autoScrollerRef,
      externalDragFrameRef,
      latestExternalDragRef,
      latestExternalPositionRef,
      managedImage: isManagedImageFileDrag(event),
    });
    if (isInvalidTimelineRowTarget(dropPosition.plan?.rejectReason)) return;
    await dispatchTimelineDrop({
      event,
      onFilesDrop: importFiles,
      dataRef: getDataRef(),
      dropPosition,
      selectedTrackId: getSelectedTrackId(),
      applyEdit: getApplyEdit(),
      registerGenerationAsset,
      prepareGenerationAsset,
      dropAsset,
      shots,
      finalVideoMap,
      onPanelClipDrop: panelClip ? (position) => placePanelClip(position, panelClip) : undefined,
    });
    onSeekToTime?.(dropPosition.time);
  }, [
    coordinator,
    clearExternalDragState,
    dropAsset,
    getApplyEdit,
    getDataRef,
    getSelectedTrackId,
    placePanelClip,
    importFiles,
    registerGenerationAsset,
    prepareGenerationAsset,
    isManagedImageFileDrag,
    runtime.timelineEditability,
    shots,
    finalVideoMap,
    onSeekToTime,
  ]);

  return {
    addMediaFiles,
    onTimelineDragOver,
    onTimelineDragLeave,
    onTimelineDrop,
  };
}
