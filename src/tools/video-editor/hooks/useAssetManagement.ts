import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { GenerationDropData } from '@/shared/lib/dnd/dragDrop.ts';
import { normalizeAndPresentError } from '@/shared/lib/errorHandling/runtimeError.ts';
import { getMediaUrl, getThumbnailUrl } from '@/shared/lib/media/mediaTypeHelpers.ts';
import { extractVideoMetadata } from '@/shared/lib/media/videoMetadata.ts';
import type { SelectClipOptions } from '@/shared/state/selectionStore.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import {
  previewPreparedMediaCommand,
  type PlacePreparedMediaCommand,
} from '@/tools/video-editor/commands/media.ts';
import {
  assertRuntimeMediaImportSize,
  type PreparedMediaImport,
} from '@/tools/video-editor/data/AssetResolver.ts';
import type { TimelineProvisionedAsset } from '@/tools/video-editor/commands/provisioning.ts';
import {
  type TimelineData,
} from '@/tools/video-editor/lib/timeline-data.ts';
import {
  buildAssetDropEdit,
  estimateAssetDuration,
  getPlayableAssetKind,
  planAssetDropTarget,
  planGenerationAssetRegistration,
} from '@/tools/video-editor/lib/timeline-asset-plans.ts';
import type {
  TimelineApplyEdit,
  TimelineInvalidateAssetRegistry,
  TimelinePatchRegistry,
} from '@/tools/video-editor/hooks/timeline-state-types.ts';
import type { TimelineStoreApi } from '@/tools/video-editor/hooks/timelineStore.ts';
import { canonicalJsonStringify } from '@/tools/video-editor/data/typed/timelineBundle.ts';

type UploadedGenerationData = GenerationDropData & {
  assetId?: string;
  durationSeconds?: number;
  mediaImport?: PreparedMediaImport;
};

type UploadedGenerationResult = {
  generationId: string;
  variantId?: string;
  variantType: 'image' | 'video';
  assetId?: string;
  imageUrl: string;
  thumbUrl?: string;
  durationSeconds?: number;
  metadata: {
    content_type: string;
    original_filename: string;
  };
  mediaImport?: PreparedMediaImport;
};

export interface UseAssetManagementArgs {
  store?: TimelineStoreApi;
  dataRef: MutableRefObject<TimelineData | null>;
  selectedTrackId: string | null;
  selectedProjectId: string | null;
  selectClip: (clipId: string, opts?: SelectClipOptions) => void;
  setSelectedTrackId: Dispatch<SetStateAction<string | null>>;
  applyEdit: TimelineApplyEdit;
  patchRegistry: TimelinePatchRegistry;
  invalidateAssetRegistry: TimelineInvalidateAssetRegistry;
  resolveAssetUrl: (file: string) => Promise<string>;
  /** Retained for the pre-A2 caller shape; Runtime-backed asset commands own placement. */
  commands?: unknown;
}

export interface UseAssetManagementResult {
  prepareGenerationAsset: (data: UploadedGenerationData | null) => TimelineProvisionedAsset | null;
  registerGenerationAsset: (data: UploadedGenerationData | null) => string | null;
  uploadImageGeneration: (file: File) => Promise<UploadedGenerationResult>;
  uploadVideoGeneration: (file: File) => Promise<UploadedGenerationResult>;
  handleAssetDrop: (
    assetKey: string,
    trackId: string | undefined,
    time: number,
    forceNewTrack?: boolean,
    insertAtTop?: boolean,
    preparedAsset?: TimelineProvisionedAsset,
    removeClipId?: string,
  ) => boolean;
}

export interface AssetDropTargetResolution {
  current: TimelineData;
  trackId: string;
  snappedTime?: number;
}

export function buildPlacePreparedMediaCommand({
  prepared,
  trackId,
  selectedTrackId,
  time,
  forceNewTrack,
  insertAtTop,
  removeClipId,
}: {
  prepared: TimelineProvisionedAsset;
  trackId?: string;
  selectedTrackId?: string | null;
  time: number;
  forceNewTrack: boolean;
  insertAtTop: boolean;
  removeClipId?: string;
}): PlacePreparedMediaCommand {
  return {
    type: 'place-prepared-media',
    payload: {
      asset: prepared,
      ...(trackId !== undefined ? { trackId } : {}),
      ...(selectedTrackId !== undefined ? { selectedTrackId } : {}),
      at: time,
      forceNewTrack,
      insertAtTop,
      ...(removeClipId !== undefined ? { removeClipId } : {}),
    },
  };
}

export { buildAssetDropEdit };
export type { BuildAssetDropEditResult } from '@/tools/video-editor/lib/timeline-asset-plans.ts';

export function resolveAssetDropTarget({
  dataRef,
  assetKind,
  trackId,
  selectedTrackId,
  forceNewTrack = false,
  insertAtTop = false,
  time,
  duration,
}: {
  dataRef: MutableRefObject<TimelineData | null>;
  assetKind: 'audio' | 'visual';
  trackId: string | undefined;
  selectedTrackId: string | null;
  forceNewTrack?: boolean;
  insertAtTop?: boolean;
  time?: number;
  duration?: number;
}): AssetDropTargetResolution | null {
  const plan = planAssetDropTarget({
    current: dataRef.current,
    assetKind,
    trackId,
    selectedTrackId,
    forceNewTrack,
    insertAtTop,
    time,
    duration,
  });
  if (!plan.ok) {
    return null;
  }

  dataRef.current = plan.preparedCurrent;
  return {
    current: plan.preparedCurrent,
    trackId: plan.trackId,
    ...(plan.snappedTime !== undefined ? { snappedTime: plan.snappedTime } : {}),
  };
}

export function useAssetManagement({
  store,
  dataRef,
  selectedTrackId,
  selectedProjectId,
  selectClip,
  setSelectedTrackId,
  applyEdit,
  patchRegistry,
}: UseAssetManagementArgs): UseAssetManagementResult {
  const runtime = useVideoEditorRuntime();
  const getDataRef = useCallback(() => {
    const storeDataRef = store?.getState().data.dataRef;
    return storeDataRef && storeDataRef.current !== null ? storeDataRef : dataRef;
  }, [dataRef, store]);
  const getSelectedTrackId = useCallback(() => {
    return store?.getState().data.selectedTrackId ?? selectedTrackId;
  }, [selectedTrackId, store]);
  const getPatchRegistry = useCallback(() => {
    return store?.getState().ops.patchRegistry ?? patchRegistry;
  }, [patchRegistry, store]);
  const getApplyEdit = useCallback(() => {
    return store?.getState().ops.applyEdit ?? applyEdit;
  }, [applyEdit, store]);
  const getSelectClip = useCallback(() => {
    return store?.getState().ops.selectClip ?? selectClip;
  }, [selectClip, store]);
  const getSetSelectedTrackId = useCallback(() => {
    return store?.getState().ops.setSelectedTrackId ?? setSelectedTrackId;
  }, [setSelectedTrackId, store]);

  const prepareGenerationAsset = useCallback((generationData: UploadedGenerationData | null): TimelineProvisionedAsset | null => {
    if (!generationData) {
      return null;
    }

    const imageUrl = getMediaUrl(generationData) ?? generationData.mediaImport?.entry.file;
    if (!imageUrl) {
      return null;
    }
    const plan = planGenerationAssetRegistration({
      generationId: generationData.generationId,
      assetId: generationData.assetId ?? generationData.mediaImport?.assetId,
      variantId: generationData.variantId,
      variantType: generationData.variantType,
      mediaId: generationData.mediaId ?? generationData.mediaImport?.assetId,
      imageUrl,
      thumbUrl: getThumbnailUrl(generationData),
      assetDurationSeconds: generationData.durationSeconds,
      metadata: generationData.metadata,
    });
    if (!plan.ok) {
      console.warn('[video-editor] Skipping generation asset registration because media URL is empty', {
        generationId: generationData.generationId,
        variantId: generationData.variantId,
        variantType: generationData.variantType,
      });
      return null;
    }

    const assetEntry = generationData.mediaImport
      ? {
          ...generationData.mediaImport.entry,
          generationId: generationData.mediaImport.generationId,
          variantId: generationData.mediaImport.variantId,
        }
      : plan.assetEntry;
    const playableKind = getPlayableAssetKind(assetEntry);
    if (!playableKind) {
      return null;
    }

    return {
      assetKey: plan.assetId,
      mediaType: playableKind,
      durationSeconds: assetEntry.duration ?? null,
      entry: assetEntry,
      source: 'registered',
      ...(generationData.mediaImport?.mediaSelection
        ? { mediaSelection: generationData.mediaImport.mediaSelection }
        : {}),
    };
  }, []);

  const registerGenerationAsset = useCallback((generationData: UploadedGenerationData | null) => {
    const prepared = prepareGenerationAsset(generationData);
    if (!prepared) {
      return null;
    }

    const assetKey = prepared.assetKey;
    // Registry-only generation enrichment is still an editor mutation. The
    // commit layer owns the queued CAS save; do not start a competing provider
    // registration that can race the following clip mutation.
    getPatchRegistry()(assetKey, prepared.entry, prepared.entry.file);

    return assetKey;
  }, [getPatchRegistry, prepareGenerationAsset]);

  const placePreparedAsset = useCallback((
    prepared: TimelineProvisionedAsset,
    trackId: string | undefined,
    time: number,
    forceNewTrack: boolean,
    insertAtTop: boolean,
    removeClipId?: string,
  ) => {
    const latestDataRef = getDataRef();
    const current = latestDataRef.current;
    if (!current) {
      return false;
    }

    const command = buildPlacePreparedMediaCommand({
      prepared,
      trackId,
      selectedTrackId: getSelectedTrackId(),
      time,
      forceNewTrack,
      insertAtTop,
      removeClipId,
    });
    if (removeClipId !== undefined && prepared.mediaType === 'image' && prepared.mediaSelection) {
      const media = prepared.mediaSelection;
      const existing = current.registry.assets[prepared.assetKey];
      const composition = current.config.app?.canonicalComposition as {
        projectId?: string; parentDocumentId?: string; headRevisionId?: string; occurrenceIds?: string[];
      } | undefined;
      const identities = current.config.clips.flatMap(clip => clip.app?.canonical ? [clip.app.canonical] : []) as Array<{
        projectId?: string; parentDocumentId?: string; occurrenceId?: string;
      }>;
      if ((composition || identities.length) && (!composition || composition.projectId !== selectedProjectId
        || composition.occurrenceIds?.length !== 1 || !composition.occurrenceIds[0]
        || identities.some(identity => identity.projectId !== composition.projectId
          || identity.parentDocumentId !== composition.parentDocumentId || identity.occurrenceId !== composition.occurrenceIds![0])
        || (current.head && (current.head.projectId !== composition.projectId
          || current.head.timelineId !== composition.parentDocumentId || current.head.headRevisionId !== composition.headRevisionId)))) return false;
      const tracks = current.tracks.filter(track => track.id === trackId);
      if (forceNewTrack || insertAtTop || tracks.length !== 1 || tracks[0].kind !== 'visual'
        || tracks[0].role === 'source' || current.rows.filter(row => row.id === trackId).length !== 1
        || ['active', 'enabled'].some(key => Reflect.get(tracks[0], key) === false)
        || ['disabled', 'hidden', 'deleted'].some(key => Reflect.get(tracks[0], key) === true)
        || (current.head && current.head.projectId !== selectedProjectId)
        || !Number.isFinite(time) || time < 0 || media.asset !== prepared.assetKey
        || Object.keys(media).sort().join() !== 'asset,catalog_digest,generation_id,object_id,variant_id'
        || !media.generation_id || !media.variant_id || !/^sha256:[0-9a-f]{64}$/.test(media.object_id)
        || !/^sha256:[0-9a-f]{64}$/.test(media.catalog_digest)
        || prepared.entry.media_id !== media.object_id || prepared.entry.generationId !== media.generation_id
        || prepared.entry.variantId !== media.variant_id
        || (existing && canonicalJsonStringify(existing) !== canonicalJsonStringify(prepared.entry))) return false;
      if (!removeClipId.startsWith('uploading-')
        || current.config.clips.some(clip => clip.id === removeClipId)
        || !current.meta[removeClipId]?.asset?.startsWith('uploading:')
        || current.meta[removeClipId]?.track !== trackId
        || current.rows.flatMap(row => row.actions).filter(action => action.id === removeClipId).length !== 1) return false;
      // Use the mounted editor's row preview. Whole-config prepared-media
      // validation cannot validate retained opaque or projected child fields.
      // A2 still owns the semantic command, original basis and durable save.
      const local = { ...current,
        rows: current.rows.map(row => ({ ...row, actions: row.actions.filter(action => action.id !== removeClipId) })) };
      const target = planAssetDropTarget({ current: local, assetKind: 'visual', trackId,
        selectedTrackId: getSelectedTrackId(), time, duration: 5 });
      if (!target.ok || target.trackId !== trackId || target.preparedCurrent !== local) return false;
      const edit = buildAssetDropEdit({ current: local, assetKey: prepared.assetKey, assetEntry: prepared.entry,
        trackId: target.trackId, time: target.snappedTime ?? time });
      if (!edit) return false;
      getApplyEdit()({ type: 'rows', rows: edit.rows, metaUpdates: edit.metaUpdates,
        metaDeletes: [removeClipId],
        clipOrderOverride: edit.clipOrderOverride,
        registryOverride: { ...current.registry, assets: { ...current.registry.assets, [prepared.assetKey]: prepared.entry } },
      }, { selectedClipId: edit.clipId, selectedTrackId: target.trackId, semantic: true,
        gestureBasis: { kind: 'prepared-media', config: current.config, registry: current.registry, clipId: edit.clipId, command } });
      return true;
    }
    const preview = previewPreparedMediaCommand(current, command);
    if (!preview?.commandResult?.detail) {
      return false;
    }
    const clipId = typeof preview.commandResult.detail.clipId === 'string'
      ? preview.commandResult.detail.clipId
      : null;
    const resolvedTrackId = typeof preview.commandResult.detail.trackId === 'string'
      ? preview.commandResult.detail.trackId
      : trackId ?? null;
    if (!clipId || !resolvedTrackId) {
      return false;
    }

    getApplyEdit()({ type: 'prepared-media', command }, {
      selectedClipId: clipId,
      selectedTrackId: resolvedTrackId,
      semantic: true,
    });
    return true;
  }, [getApplyEdit, getDataRef, getSelectedTrackId, selectedProjectId]);

  const handleAssetDrop = useCallback((assetKey: string, trackId: string | undefined, time: number, forceNewTrack = false, insertAtTop = false, preparedAsset?: TimelineProvisionedAsset, removeClipId?: string) => {
    if (preparedAsset) {
      return placePreparedAsset(preparedAsset, trackId, time, forceNewTrack, insertAtTop, removeClipId);
    }

    const latestDataRef = getDataRef();
    const current = latestDataRef.current;
    const assetEntry = current?.registry.assets[assetKey];
    const playableKind = getPlayableAssetKind(assetEntry);
    if (!assetEntry || !playableKind) {
      runtime.toast.error('Only image, video, and audio assets can be added to the timeline');
      return false;
    }
    const assetKind = playableKind === 'audio' ? 'audio' : 'visual';
    const duration = estimateAssetDuration(assetEntry, assetKind);
    const targetPlan = planAssetDropTarget({
      current,
      assetKind,
      trackId,
      selectedTrackId: getSelectedTrackId(),
      forceNewTrack,
      insertAtTop,
      time,
      duration,
    });
    if (!targetPlan.ok) {
      return false;
    }
    const resolvedTarget = {
      current: targetPlan.preparedCurrent,
      trackId: targetPlan.trackId,
      snappedTime: targetPlan.snappedTime,
    };
    const nextEdit = buildAssetDropEdit({
      current: resolvedTarget.current,
      assetKey,
      trackId: resolvedTarget.trackId,
      time: resolvedTarget.snappedTime ?? time,
    });
    if (!nextEdit) {
      return false;
    }
    latestDataRef.current = resolvedTarget.current;
    getApplyEdit()({
      type: 'rows',
      rows: nextEdit.rows,
      metaUpdates: nextEdit.metaUpdates,
      clipOrderOverride: nextEdit.clipOrderOverride,
    });
    getSelectClip()(nextEdit.clipId);
    getSetSelectedTrackId()(resolvedTarget.trackId);
    return true;
  }, [getApplyEdit, getDataRef, getSelectedTrackId, getSelectClip, getSetSelectedTrackId, placePreparedAsset, runtime.toast]);

  const uploadImageGeneration = useCallback(async (file: File) => {
    if (!selectedProjectId) {
      throw new Error('External image drop requires a selected project');
    }

    const runtimeMediaImport = runtime.provider.prepareMediaImport;
    if (runtimeMediaImport) {
      assertRuntimeMediaImportSize(file);
      const mediaImport = await runtimeMediaImport.call(runtime.provider, file, {
        filename: file.name,
        mediaType: file.type || 'image/png',
      });
      if (mediaImport.provider !== 'runtime') {
        throw new Error('The media import provider returned a non-Runtime descriptor');
      }
      if (selectedProjectId && mediaImport.project !== selectedProjectId) {
        throw new Error('Runtime media import belongs to a different project');
      }
      const imageUrl = mediaImport.entry.file ?? await runtime.provider.resolveAssetUrl(mediaImport.assetId);
      return {
        generationId: mediaImport.generationId,
        variantId: mediaImport.variantId,
        variantType: 'image' as const,
        assetId: mediaImport.assetId,
        imageUrl,
        metadata: {
          content_type: file.type || 'image/png',
          original_filename: file.name,
        },
        mediaImport,
      };
    }

    throw new Error('This editor backend does not support Runtime image/video imports');
  }, [runtime.provider, selectedProjectId]);

  const uploadVideoGeneration = useCallback(async (file: File) => {
    if (!selectedProjectId) {
      throw new Error('No project selected');
    }

    let durationSeconds: number | undefined;
    try {
      const metadata = await extractVideoMetadata(file);
      durationSeconds = metadata.duration_seconds;
    } catch (error) {
      normalizeAndPresentError(error, { context: `video-editor:external-video-metadata:${file.name}`, showToast: false });
    }

    const runtimeMediaImport = runtime.provider.prepareMediaImport;
    if (runtimeMediaImport) {
      assertRuntimeMediaImportSize(file);
      const mediaImport = await runtimeMediaImport.call(runtime.provider, file, {
        filename: file.name,
        mediaType: file.type || 'video/mp4',
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      });
      if (mediaImport.provider !== 'runtime') {
        throw new Error('The media import provider returned a non-Runtime descriptor');
      }
      if (selectedProjectId && mediaImport.project !== selectedProjectId) {
        throw new Error('Runtime media import belongs to a different project');
      }
      const videoUrl = mediaImport.entry.file ?? await runtime.provider.resolveAssetUrl(mediaImport.assetId);
      return {
        generationId: mediaImport.generationId,
        variantId: mediaImport.variantId,
        variantType: 'video' as const,
        assetId: mediaImport.assetId,
        imageUrl: videoUrl,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        metadata: {
          content_type: file.type || 'video/mp4',
          original_filename: file.name,
        },
        mediaImport,
      };
    }

    throw new Error('This editor backend does not support Runtime image/video imports');
  }, [runtime.provider, selectedProjectId]);

  return {
    prepareGenerationAsset,
    registerGenerationAsset,
    uploadImageGeneration,
    uploadVideoGeneration,
    handleAssetDrop,
  };
}
