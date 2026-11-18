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
  type PreparedMediaDiagnostic,
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

/** The plain reason a dropped file was not placed. The headline says what happened; this says why. */
const DECLINED_DETAIL: Record<string, string> = {
  'command-schema': 'The drop was not understood.',
  'provisioned-asset': 'The uploaded file could not be read.',
  placement: 'It does not fit on that track at that time.',
  'final-config': 'Adding it would leave the timeline invalid.',
  missing_timeline: 'The timeline is not loaded yet.',
  preserved_track_unavailable: 'That track is no longer available.',
  missing_media_url: 'The file has no address to play from.',
};
export const fileNotAddedMessage = (reason: string): string =>
  `The file was not added to the timeline. ${DECLINED_DETAIL[reason] ?? reason}`;

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
    preparedInput: TimelineProvisionedAsset,
    trackId: string | undefined,
    time: number,
    forceNewTrack: boolean,
    insertAtTop: boolean,
    removeClipId?: string,
  ) => {
    let prepared = preparedInput;
    // A drop that cannot be placed must say so: the upload already finished, so a silent `false` leaves
    // the user with neither a clip nor a reason.
    // `reason` is the machine-readable cause (logged and sent to telemetry); `message` is the plain text.
    const decline = (reason: string, message: string = reason) => {
      console.warn('[video-editor] Dropped file was not added to the timeline', { reason, trackId, time });
      runtime.telemetry?.warn?.('[video-editor] drop declined', { reason, trackId, time });
      runtime.toast.error(fileNotAddedMessage(message));
      return false;
    };
    const declined = (reason: string) => decline(reason);
    const latestDataRef = getDataRef();
    const current = latestDataRef.current;
    if (!current) {
      return declined('missing_timeline');
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
      let media = prepared.mediaSelection;
      let existing = current.registry.assets[prepared.assetKey];
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
          || current.head.timelineId !== composition.parentDocumentId || current.head.headRevisionId !== composition.headRevisionId)))) return decline('shot-changed', 'The shot changed while the file was uploading.');
      // Judge only what this edit needs: a usable target track, a valid time, and a well-formed media
      // selection. Whole-state equality (registry, head, placeholder) is not the edit's business; the
      // Agent's clip.add-media is the authority on the document itself.
      const tracks = current.tracks.filter(track => track.id === trackId);
      if (tracks.length !== 1 || current.rows.filter(row => row.id === trackId).length !== 1) return decline('track-missing', 'preserved_track_unavailable');
      if (tracks[0].kind !== 'visual' || tracks[0].role === 'source') return decline('track-unsuitable', 'preserved_track_unavailable');
      if (['active', 'enabled'].some(key => Reflect.get(tracks[0], key) === false)
        || ['disabled', 'hidden', 'deleted'].some(key => Reflect.get(tracks[0], key) === true)) return decline('track-hidden-or-disabled', 'preserved_track_unavailable');
      if (!Number.isFinite(time) || time < 0) return decline('time-invalid', 'The drop position is not valid.');
      // Generation and variant travel together: both ids or neither, and the entry must carry the same pair.
      if (media.asset !== prepared.assetKey
        || !/^sha256:[0-9a-f]{64}$/.test(media.object_id) || !/^sha256:[0-9a-f]{64}$/.test(media.catalog_digest)) return decline('media-selection-invalid', 'provisioned-asset');
      if (Boolean(media.generation_id) !== Boolean(media.variant_id)) return decline('generation-variant-incomplete', 'provisioned-asset');
      if (prepared.entry.media_id !== media.object_id || prepared.entry.generationId !== (media.generation_id || undefined)
        || prepared.entry.variantId !== (media.variant_id || undefined)) return decline('media-entry-mismatch', 'provisioned-asset');
      // The registry key is a name, not an identity. The same media object under that key is reused as it
      // stands (the registry may carry fields the upload does not); a different object gets a key of its own.
      const sameObject = (entry: typeof existing) => entry?.media_id === media.object_id
        || (entry as { content_sha256?: string } | undefined)?.content_sha256 === media.object_id;
      if (existing && !sameObject(existing)) {
        const suffix = media.object_id.slice('sha256:'.length, 'sha256:'.length + 12);
        let key = `${prepared.assetKey}-${suffix}`;
        for (let n = 2; current.registry.assets[key] && !sameObject(current.registry.assets[key]); n++) key = `${prepared.assetKey}-${suffix}-${n}`;
        prepared = { ...prepared, assetKey: key, mediaSelection: { ...media, asset: key } };
        media = prepared.mediaSelection!;
        existing = current.registry.assets[key];
      }
      // Reusing means placing with the entry the registry already holds, so the document write is the identity.
      if (existing) prepared = { ...prepared, entry: existing };
      // A placeholder that is gone is not a reason to refuse while the track exists: place at the drop time.
      const row = current.rows.find(candidate => candidate.id === trackId);
      const placeholderActions = current.rows.flatMap(r => r.actions).filter(action => action.id === removeClipId);
      const placeholderPresent = placeholderActions.length > 0 || current.meta[removeClipId] !== undefined;
      if (placeholderPresent && (!removeClipId.startsWith('uploading-')
        || current.config.clips.some(clip => clip.id === removeClipId)
        || !current.meta[removeClipId]?.asset?.startsWith('uploading:')
        || current.meta[removeClipId]?.track !== trackId
        || placeholderActions.length !== 1
        || !row?.actions.some(action => action.id === removeClipId))) return decline('placeholder-inconsistent', 'The upload was removed from the timeline while it finished.');
      const effectiveRemoveClipId = placeholderPresent ? removeClipId : undefined;
      const command = buildPlacePreparedMediaCommand({ prepared, trackId, selectedTrackId: getSelectedTrackId(), time,
        forceNewTrack: false, insertAtTop: false, removeClipId: effectiveRemoveClipId });
      // Use the mounted editor's row preview. Whole-config prepared-media
      // validation cannot validate retained opaque or projected child fields.
      // A2 still owns the semantic command, original basis and durable save.
      const local = { ...current,
        rows: current.rows.map(row => ({ ...row, actions: row.actions.filter(action => action.id !== effectiveRemoveClipId) })) };
      const target = planAssetDropTarget({ current: local, assetKind: 'visual', trackId,
        selectedTrackId: getSelectedTrackId(), time, duration: 5 });
      if (!target.ok || target.trackId !== trackId || target.preparedCurrent !== local) return declined('placement');
      const edit = buildAssetDropEdit({ current: local, assetKey: prepared.assetKey, assetEntry: prepared.entry,
        trackId: target.trackId, time: target.snappedTime ?? time });
      if (!edit) return declined('placement');
      getApplyEdit()({ type: 'rows', rows: edit.rows, metaUpdates: edit.metaUpdates,
        metaDeletes: effectiveRemoveClipId ? [effectiveRemoveClipId] : [],
        clipOrderOverride: edit.clipOrderOverride,
        registryOverride: { ...current.registry, assets: { ...current.registry.assets, [prepared.assetKey]: prepared.entry } },
      }, { selectedClipId: edit.clipId, selectedTrackId: target.trackId, semantic: true,
        gestureBasis: { kind: 'prepared-media', config: current.config, registry: current.registry, clipId: edit.clipId, command } });
      return true;
    }
    let diagnostic: PreparedMediaDiagnostic | undefined;
    const preview = previewPreparedMediaCommand(current, command, { onFailure: failure => { diagnostic = failure; } });
    if (!preview?.commandResult?.detail) {
      return declined(diagnostic?.stage ?? 'placement');
    }
    const clipId = typeof preview.commandResult.detail.clipId === 'string'
      ? preview.commandResult.detail.clipId
      : null;
    const resolvedTrackId = typeof preview.commandResult.detail.trackId === 'string'
      ? preview.commandResult.detail.trackId
      : trackId ?? null;
    if (!clipId || !resolvedTrackId) {
      return declined('placement');
    }

    getApplyEdit()({ type: 'prepared-media', command }, {
      selectedClipId: clipId,
      selectedTrackId: resolvedTrackId,
      semantic: true,
    });
    return true;
  }, [getApplyEdit, getDataRef, getSelectedTrackId, runtime.toast, selectedProjectId]);

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
      runtime.toast.error(fileNotAddedMessage(targetPlan.error));
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
      runtime.toast.error(fileNotAddedMessage('placement'));
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
