import { z } from 'zod';
import { updateClipOrder } from '@/tools/video-editor/lib/coordinate-utils.ts';
import type { MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';
import { getNextClipId, rowsToConfig, type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import {
  buildAssetDropEdit,
  planAssetDropTarget,
  type TimelineAssetPlacementPolicy,
} from '@/tools/video-editor/lib/timeline-asset-plans.ts';
import { buildDuplicateClipEdit } from '@/tools/video-editor/lib/duplicate-clip.ts';
import { getAssetImmediateSource } from '@/tools/video-editor/lib/asset-registry.ts';
import { buildDataFromCurrentRegistry } from '@/tools/video-editor/lib/timeline-save-utils.ts';
import { validateSerializedConfig } from '@/tools/video-editor/lib/serialize.ts';
import type { AssetRegistry, TimelineClip, ResolvedTimelineConfig, PinnedShotGroup } from '@/tools/video-editor/types/index.ts';
import type {
  TimelineCommand,
  TimelineCommandDescriptor,
  TimelineCommandEffect,
  TimelineCommandHistoryMetadata,
  TimelineCommandStepResult,
} from './types.ts';
import {
  estimateProvisionedAssetDuration,
  type TimelineProvisionedAsset,
} from './provisioning.ts';

type AddMediaPayload = {
  trackId: string;
  at: number;
  asset: TimelineProvisionedAsset;
};

export type AddMediaCommand = Omit<TimelineCommand<'add-media', AddMediaPayload>, 'payload'> & {
  payload: AddMediaPayload;
};

type SwapMediaPayload = {
  clipId: string;
  asset: TimelineProvisionedAsset;
};

export type SwapMediaCommand = Omit<TimelineCommand<'swap', SwapMediaPayload>, 'payload'> & {
  payload: SwapMediaPayload;
};

export type PlacePreparedMediaPayload = {
  asset: TimelineProvisionedAsset;
  trackId?: string;
  selectedTrackId?: string | null;
  at: number;
  forceNewTrack?: boolean;
  insertAtTop?: boolean;
  clipSpanSeconds?: number | null;
  /** Use the clip id allocated by the caller's compound mutation. */
  clipId?: string;
  /** Duplicate an existing clip using the normal ripple and metadata rules. */
  afterClipId?: string;
  oldMediaSelection?: MediaSelection;
  removeClipId?: string;
  /** Remove several clips as part of the same prepared-media mutation. */
  removeClipIds?: string[];
  /** Replace an existing clip while preserving its id/history identity. */
  replaceClipId?: string;
  /** Keep group membership/metadata in the same editor save as the media. */
  pinnedShotGroupsOverride?: PinnedShotGroup[];
  placementPolicy?: TimelineAssetPlacementPolicy;
};

export type PlacePreparedMediaCommand = Omit<TimelineCommand<'place-prepared-media', PlacePreparedMediaPayload>, 'payload'> & {
  payload: PlacePreparedMediaPayload;
};

export type PreparedMediaDiagnosticStage =
  | 'command-schema'
  | 'provisioned-asset'
  | 'placement'
  | 'final-config';

export type PreparedMediaDiagnosticReason =
  | 'invalid-command'
  | 'invalid-asset'
  | 'invalid-placement'
  | 'invalid-config';

export type PreparedMediaDiagnosticFieldCategory =
  | 'command'
  | 'asset'
  | 'placement'
  | 'config';

export type PreparedMediaDiagnostic = Readonly<{
  stage: PreparedMediaDiagnosticStage;
  reason: PreparedMediaDiagnosticReason;
  fieldCategory: PreparedMediaDiagnosticFieldCategory;
}>;

export type ApplyPreparedMediaCommandOptions = Readonly<{
  onFailure?: (diagnostic: PreparedMediaDiagnostic) => void;
}>;

const roundSeconds = (value: number): number => Math.round(value * 1000) / 1000;

const preparedMediaInput = z.object({
  type: z.string().trim().pipe(z.literal('place-prepared-media')),
  payload: z.record(z.string(), z.json()),
  commandId: z.string().optional(),
  metadata: z.record(z.string(), z.json()).optional(),
});

const getTrackForClip = (
  data: TimelineData,
  clipId: string,
) => {
  const trackId = data.meta[clipId]?.track;
  return trackId ? data.tracks.find((track) => track.id === trackId) ?? null : null;
};

const getClipMediaType = (
  data: TimelineData,
  clip: TimelineClip,
): 'image' | 'video' | 'audio' => {
  const track = getTrackForClip(data, clip.id);
  if (track?.kind === 'audio') {
    return 'audio';
  }

  return clip.clipType === 'hold' ? 'image' : 'video';
};

const getVisualClipType = (
  asset: TimelineProvisionedAsset,
): 'hold' | 'media' => {
  return asset.mediaType === 'image' ? 'hold' : 'media';
};

const validateProvisionedAsset = (
  asset: TimelineProvisionedAsset | undefined,
  path: string,
) => {
  const errors = [];
  if (!asset || typeof asset !== 'object') {
    errors.push({
      path,
      code: 'missing_asset',
      message: 'A provisioned asset is required.',
    });
    return errors;
  }

  if (typeof asset.assetKey !== 'string' || asset.assetKey.trim().length === 0) {
    errors.push({
      path: `${path}.assetKey`,
      code: 'invalid_asset_key',
      message: 'asset.assetKey must be a non-empty string.',
    });
  }

  if (!['image', 'video', 'audio'].includes(asset.mediaType)) {
    errors.push({
      path: `${path}.mediaType`,
      code: 'invalid_media_type',
      message: 'asset.mediaType must be image, video, or audio.',
    });
  }

  return errors;
};

export const buildAddMediaCommandEffect = (
  currentData: TimelineData,
  payload: AddMediaCommand['payload'],
): TimelineCommandEffect => {
  const track = currentData.tracks.find((candidate) => candidate.id === payload.trackId);
  if (!track) {
    throw new Error(`Track ${payload.trackId} does not exist.`);
  }

  const clipId = getNextClipId(currentData.meta);
  const duration = estimateProvisionedAssetDuration(payload.asset);
  const isManual = track.fit === 'manual';
  const clipType = track.kind === 'audio'
    ? 'media'
    : getVisualClipType(payload.asset);
  const nextMeta = track.kind === 'audio'
    ? {
        asset: payload.asset.assetKey,
        track: payload.trackId,
        clipType: 'media',
        from: 0,
        to: duration,
        speed: 1,
        volume: 1,
      }
    : payload.asset.mediaType === 'image'
      ? {
          asset: payload.asset.assetKey,
          track: payload.trackId,
          clipType,
          hold: 5,
          opacity: 1,
          x: isManual ? 100 : undefined,
          y: isManual ? 100 : undefined,
          width: isManual ? 320 : undefined,
          height: isManual ? 240 : undefined,
        }
      : {
          asset: payload.asset.assetKey,
          track: payload.trackId,
          clipType,
          from: 0,
          to: duration,
          speed: 1,
          volume: 1,
          opacity: 1,
          x: isManual ? 100 : undefined,
          y: isManual ? 100 : undefined,
          width: isManual ? 320 : undefined,
          height: isManual ? 240 : undefined,
        };
  const nextRows = currentData.rows.map((row) => (
    row.id === payload.trackId
      ? {
          ...row,
          actions: [
            ...row.actions,
            {
              id: clipId,
              start: payload.at,
              end: payload.at + duration,
              effectId: `effect-${clipId}`,
            },
          ],
        }
      : row
  ));

  return {
    mutation: {
      type: 'rows',
      rows: nextRows,
      metaUpdates: {
        [clipId]: nextMeta,
      },
      clipOrderOverride: updateClipOrder(currentData.clipOrder, payload.trackId, (ids) => [...ids, clipId]),
    },
    summary: `Added media clip ${clipId} on track ${payload.trackId} at ${roundSeconds(payload.at)}s using asset ${payload.asset.assetKey}.`,
    detail: {
      clipId,
      trackId: payload.trackId,
      assetKey: payload.asset.assetKey,
    },
  };
};

const buildSwappedClip = (
  clip: TimelineClip,
  asset: TimelineProvisionedAsset,
): TimelineClip => {
  const nextClip = {
    ...clip,
    asset: asset.assetKey,
  } as TimelineClip;
  const nextClipType = asset.mediaType === 'image' ? 'hold' : 'media';

  if (clip.clipType === nextClipType) {
    return nextClip;
  }

  if (asset.mediaType === 'image') {
    nextClip.clipType = 'hold';
    nextClip.hold = 5;
    delete nextClip.from;
    delete nextClip.to;
    delete nextClip.speed;
    delete nextClip.volume;
    return nextClip;
  }

  nextClip.clipType = nextClipType;
  nextClip.from = 0;
  nextClip.to = roundSeconds(estimateProvisionedAssetDuration(asset));
  nextClip.speed = 1;
  delete nextClip.volume;
  delete nextClip.hold;
  return nextClip;
};

export const buildSwapMediaCommandEffect = (
  currentData: TimelineData,
  payload: SwapMediaCommand['payload'],
): TimelineCommandEffect => {
  const src = getAssetImmediateSource(payload.asset.entry);
  if (!src) {
    throw new Error(`Cannot swap asset '${payload.asset.assetKey}' without a file locator or media identity`);
  }
  const nextResolvedConfig: ResolvedTimelineConfig = {
    ...currentData.resolvedConfig,
    output: { ...currentData.resolvedConfig.output },
    tracks: currentData.resolvedConfig.tracks.map((track) => ({ ...track })),
    registry: {
      ...currentData.resolvedConfig.registry,
      [payload.asset.assetKey]: {
        ...payload.asset.entry,
        src,
      },
    },
    clips: currentData.resolvedConfig.clips.map((clip) => (
      clip.id === payload.clipId
        ? buildSwappedClip(clip, payload.asset)
        : { ...clip }
    )),
    ...(currentData.resolvedConfig.theme !== undefined ? { theme: currentData.resolvedConfig.theme } : {}),
    ...(currentData.resolvedConfig.theme_overrides !== undefined ? { theme_overrides: currentData.resolvedConfig.theme_overrides } : {}),
    ...(currentData.resolvedConfig.generation_defaults !== undefined ? { generation_defaults: currentData.resolvedConfig.generation_defaults } : {}),
  };
  const currentClip = currentData.resolvedConfig.clips.find((clip) => clip.id === payload.clipId);
  const currentMediaType = currentClip
    ? getClipMediaType(currentData, currentClip)
    : null;
  const summary = currentMediaType === payload.asset.mediaType
    ? `Swapped asset on clip ${payload.clipId} to ${payload.asset.assetKey}.`
    : `Swapped clip ${payload.clipId} to ${payload.asset.mediaType} asset ${payload.asset.assetKey}.`;

  return {
    mutation: {
      type: 'resolved-config',
      resolvedConfig: nextResolvedConfig,
      pinnedShotGroupsOverride: currentData.config.pinnedShotGroups,
    },
    summary,
    detail: {
      clipId: payload.clipId,
      assetKey: payload.asset.assetKey,
    },
  };
};

export const ADD_MEDIA_COMMAND_DESCRIPTOR: TimelineCommandDescriptor<AddMediaCommand> = {
  type: 'add-media',
  validate: (context) => {
    const errors = [];
    const { trackId, at, asset } = context.command.payload;
    errors.push(...validateProvisionedAsset(asset, `$.commands[${context.commandIndex}].payload.asset`));

    if (typeof trackId !== 'string' || trackId.trim().length === 0) {
      errors.push({
        path: `$.commands[${context.commandIndex}].payload.trackId`,
        code: 'invalid_track',
        message: 'trackId must be a non-empty string.',
      });
      return errors;
    }

    const track = context.currentData.tracks.find((candidate) => candidate.id === trackId);
    if (!track) {
      errors.push({
        path: `$.commands[${context.commandIndex}].payload.trackId`,
        code: 'missing_track',
        message: `Track ${trackId} does not exist.`,
      });
    }

    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
      errors.push({
        path: `$.commands[${context.commandIndex}].payload.at`,
        code: 'invalid_at',
        message: 'at must be a finite non-negative number.',
      });
    }

    if (track && asset) {
      if (track.kind === 'visual' && asset.mediaType === 'audio') {
        errors.push({
          path: `$.commands[${context.commandIndex}].payload.asset.mediaType`,
          code: 'incompatible_asset',
          message: `Track ${track.id} does not accept audio assets.`,
        });
      }

      if (track.kind === 'audio' && asset.mediaType !== 'audio') {
        errors.push({
          path: `$.commands[${context.commandIndex}].payload.asset.mediaType`,
          code: 'incompatible_asset',
          message: `Track ${track.id} only accepts audio assets.`,
        });
      }
    }

    return errors;
  },
  dryRun: (context) => buildAddMediaCommandEffect(context.currentData, context.command.payload!),
  apply: (context) => buildAddMediaCommandEffect(context.currentData, context.command.payload!),
  invert: () => null,
};

export const SWAP_MEDIA_COMMAND_DESCRIPTOR: TimelineCommandDescriptor<SwapMediaCommand> = {
  type: 'swap',
  validate: (context) => {
    const errors = [];
    const { clipId, asset } = context.command.payload;
    errors.push(...validateProvisionedAsset(asset, `$.commands[${context.commandIndex}].payload.asset`));

    if (typeof clipId !== 'string' || clipId.trim().length === 0) {
      errors.push({
        path: `$.commands[${context.commandIndex}].payload.clipId`,
        code: 'invalid_clip_id',
        message: 'clipId must be a non-empty string.',
      });
      return errors;
    }

    const clip = context.currentData.resolvedConfig.clips.find((candidate) => candidate.id === clipId);
    if (!clip) {
      errors.push({
        path: `$.commands[${context.commandIndex}].payload.clipId`,
        code: 'missing_clip',
        message: `Clip ${clipId} was not found.`,
      });
      return errors;
    }

    if (clip.clipType === 'text' || clip.clipType === 'effect-layer') {
      errors.push({
        path: `$.commands[${context.commandIndex}].payload.clipId`,
        code: 'unsupported_clip_type',
        message: `Clip ${clip.id} cannot swap media assets.`,
      });
    }

    const track = getTrackForClip(context.currentData, clipId);
    if (track && asset) {
      if (track.kind === 'visual' && asset.mediaType === 'audio') {
        errors.push({
          path: `$.commands[${context.commandIndex}].payload.asset.mediaType`,
          code: 'incompatible_asset',
          message: `Track ${track.id} does not accept audio assets.`,
        });
      }

      if (track.kind === 'audio' && asset.mediaType !== 'audio') {
        errors.push({
          path: `$.commands[${context.commandIndex}].payload.asset.mediaType`,
          code: 'incompatible_asset',
          message: `Track ${track.id} only accepts audio assets.`,
        });
      }
    }

    return errors;
  },
  dryRun: (context) => buildSwapMediaCommandEffect(context.currentData, context.command.payload!),
  apply: (context) => buildSwapMediaCommandEffect(context.currentData, context.command.payload!),
  invert: (context) => {
    const clip = context.currentData.resolvedConfig.clips.find((candidate) => candidate.id === context.command.payload?.clipId);
    if (!clip?.asset) {
      return null;
    }

    const assetEntry = context.currentData.registry.assets[clip.asset];
    if (!assetEntry) {
      return null;
    }

    return {
      type: 'swap' as const,
      payload: {
        clipId: clip.id,
        asset: {
          assetKey: clip.asset,
          mediaType: getClipMediaType(context.currentData, clip),
          durationSeconds: typeof assetEntry.duration === 'number' ? assetEntry.duration : null,
          entry: { ...assetEntry },
          source: 'registered' as const,
        },
      },
    };
  },
};

const removeClipFromWorkingData = (current: TimelineData, clipIds: readonly string[]): TimelineData => {
  if (clipIds.length === 0) {
    return current;
  }

  const clipIdSet = new Set(clipIds);
  const nextMeta = { ...current.meta };
  for (const clipId of clipIdSet) {
    delete nextMeta[clipId];
  }
  return {
    ...current,
    rows: current.rows.map((row) => ({
      ...row,
      actions: row.actions.filter((action) => !clipIdSet.has(action.id)),
    })),
    meta: nextMeta,
    clipOrder: Object.fromEntries(
      Object.entries(current.clipOrder).map(([trackId, clipIds]) => [
        trackId,
        clipIds.filter((candidate) => !clipIdSet.has(candidate)),
      ]),
    ),
  };
};

const stripDerivedAssetEntry = (base: TimelineData, clip: TimelineClip): TimelineClip => {
  if (!Object.prototype.hasOwnProperty.call(clip, 'assetEntry') || !clip.asset) {
    return clip;
  }

  const resolvedClip = base.resolvedConfig.clips.find((candidate) => candidate.id === clip.id);
  const assetEntry = (clip as TimelineClip & { assetEntry?: unknown }).assetEntry;
  if (resolvedClip?.assetEntry !== assetEntry || base.resolvedConfig.registry[clip.asset] !== assetEntry) {
    return clip;
  }

  const { assetEntry: _assetEntry, ...authoredClip } = clip as TimelineClip & { assetEntry?: unknown };
  return authoredClip;
};

const buildPreparedReplacementEdit = (
  current: TimelineData,
  payload: PlacePreparedMediaCommand['payload'],
) => {
  const clipId = payload.replaceClipId;
  if (!clipId) {
    return null;
  }

  const row = current.rows.find((candidate) => candidate.actions.some((action) => action.id === clipId));
  const action = row?.actions.find((candidate) => candidate.id === clipId);
  const currentMeta = current.meta[clipId];
  if (!row || !action || !currentMeta) {
    return null;
  }

  const currentDuration = Math.max(0.05, action.end - action.start);
  const requestedDuration = payload.clipSpanSeconds;
  const duration = typeof requestedDuration === 'number'
    && Number.isFinite(requestedDuration)
    && requestedDuration > 0
    ? requestedDuration
    : currentDuration;
  const hasDurationChange = Math.abs(duration - currentDuration) > 0.0001;
  const rows = hasDurationChange
    ? current.rows.map((candidate) => candidate.id === row.id
      ? {
          ...candidate,
          actions: candidate.actions.map((candidateAction) => candidateAction.id === clipId
            ? { ...candidateAction, end: candidateAction.start + duration }
            : candidateAction),
        }
      : candidate)
    : current.rows;
  const metaUpdate: Partial<TimelineData['meta'][string]> = {
    asset: payload.asset.assetKey,
  };
  if (hasDurationChange) {
    if (typeof currentMeta.hold === 'number') {
      metaUpdate.hold = duration;
    } else {
      const from = typeof currentMeta.from === 'number' ? currentMeta.from : 0;
      const speed = typeof currentMeta.speed === 'number' && currentMeta.speed > 0
        ? currentMeta.speed
        : 1;
      metaUpdate.to = from + duration * speed;
    }
  }

  return {
    clipId,
    trackId: row.id,
    duration,
    rows,
    metaUpdates: { [clipId]: metaUpdate },
    clipOrderOverride: current.clipOrder,
  };
};

const materializePreparedData = ({
  base,
  rows,
  meta,
  clipOrder,
  pinnedShotGroups,
  registry,
  resolvedRegistry,
}: {
  base: TimelineData;
  rows: TimelineData['rows'];
  meta: TimelineData['meta'];
  clipOrder: TimelineData['clipOrder'];
  pinnedShotGroups: TimelineData['config']['pinnedShotGroups'];
  registry: AssetRegistry;
  resolvedRegistry: TimelineData['resolvedConfig']['registry'];
}): TimelineData => {
  // The editor preview uses seconds; raw command capture keeps the original
  // source and validates its codecs separately. Normalize only a matching alias
  // before rowsToConfig restores raw fields (including on rippled peers).
  const editorClips = base.config.clips.map((rawClip) => {
    const clip = stripDerivedAssetEntry(base, rawClip);
    if (!Object.prototype.hasOwnProperty.call(clip, 'at_ms')) return clip;
    const { at_ms: atMs, ...editorClip } = clip as typeof clip & { at_ms: unknown };
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || clip.at !== atMs / 1000) {
      throw new Error(`Prepared media clip '${clip.id}' has contradictory at/at_ms timing.`);
    }
    return editorClip;
  });
  const config = rowsToConfig(
    rows,
    meta,
    base.output,
    clipOrder,
    base.tracks,
    pinnedShotGroups,
    { ...base.config, clips: editorClips },
  );
  const nextData = buildDataFromCurrentRegistry(config, base, {
    registry,
    resolvedRegistry,
  });
  return {
    ...nextData,
    config,
    rows,
    meta,
    clipOrder,
  };
};

const buildPlacePreparedMediaEffect = (
  currentData: TimelineData,
  payload: PlacePreparedMediaCommand['payload'],
): TimelineCommandEffect & { mutation: { type: 'data'; data: TimelineData } } => {
  const assetKind = payload.asset.mediaType === 'audio' ? 'audio' : 'visual';
  const duration = payload.clipSpanSeconds
    ?? estimateProvisionedAssetDuration(payload.asset);
  const requestedRemovalIds = [
    ...(payload.removeClipId ? [payload.removeClipId] : []),
    ...(payload.removeClipIds ?? []),
  ];
  const uniqueRemovalIds = [...new Set(requestedRemovalIds)];
  for (const clipId of uniqueRemovalIds) {
    const exists = currentData.meta[clipId]
      && currentData.rows.some((row) => row.actions.some((action) => action.id === clipId));
    if (!exists) {
      throw new Error(`Prepared media target clip '${clipId}' no longer exists.`);
    }
  }
  if (payload.replaceClipId) {
    const exists = currentData.meta[payload.replaceClipId]
      && currentData.rows.some((row) => row.actions.some((action) => action.id === payload.replaceClipId));
    if (!exists) {
      throw new Error(`Prepared media replacement target clip '${payload.replaceClipId}' no longer exists.`);
    }
  }
  const workingData = removeClipFromWorkingData(currentData, uniqueRemovalIds);

  const source = getAssetImmediateSource(payload.asset.entry);
  if (!source) {
    throw new Error(`Prepared asset '${payload.asset.assetKey}' has no file locator or media identity.`);
  }

  const nextRegistry: AssetRegistry = {
    ...workingData.registry,
    assets: {
      ...workingData.registry.assets,
      [payload.asset.assetKey]: payload.asset.entry,
    },
  };
  const nextResolvedRegistry = {
    ...workingData.resolvedConfig.registry,
    [payload.asset.assetKey]: {
      ...payload.asset.entry,
      src: source,
    },
  };

  if (payload.afterClipId) {
    const duplicateEdit = buildDuplicateClipEdit(workingData, payload.afterClipId, payload.asset.assetKey);
    if (!duplicateEdit) {
      throw new Error(`Cannot duplicate clip '${payload.afterClipId}' for prepared media placement.`);
    }
    const nextMeta = { ...workingData.meta };
    for (const [clipId, patch] of Object.entries(duplicateEdit.metaUpdates)) {
      nextMeta[clipId] = {
        ...nextMeta[clipId],
        ...patch,
      };
    }
    const nextData = materializePreparedData({
      base: workingData,
      rows: duplicateEdit.rows,
      meta: nextMeta,
      clipOrder: duplicateEdit.clipOrderOverride,
      pinnedShotGroups: payload.pinnedShotGroupsOverride ?? workingData.config.pinnedShotGroups,
      registry: nextRegistry,
      resolvedRegistry: nextResolvedRegistry,
    });
    return {
      mutation: { type: 'data', data: nextData },
      summary: `Duplicated prepared asset ${payload.asset.assetKey} after clip ${payload.afterClipId}.`,
      detail: {
        assetKey: payload.asset.assetKey,
        clipId: duplicateEdit.clipId,
        trackId: duplicateEdit.trackId,
      },
    };
  }

  const replacementEdit = buildPreparedReplacementEdit(workingData, payload);
  let baseForEdit: TimelineData;
  let nextEdit: NonNullable<ReturnType<typeof buildAssetDropEdit>> | NonNullable<ReturnType<typeof buildPreparedReplacementEdit>>;
  let targetTrackId: string;
  if (replacementEdit) {
    baseForEdit = workingData;
    nextEdit = replacementEdit;
    targetTrackId = replacementEdit.trackId;
  } else {
    const targetPlan = planAssetDropTarget({
      current: workingData,
      assetKind,
      trackId: payload.trackId,
      selectedTrackId: payload.selectedTrackId ?? null,
      forceNewTrack: payload.forceNewTrack ?? false,
      insertAtTop: payload.insertAtTop ?? false,
      time: Math.max(0, payload.at),
      duration,
      placementPolicy: payload.placementPolicy,
    });
    if (!targetPlan.ok) {
      throw new Error(targetPlan.error === 'preserved_track_unavailable'
        ? 'The captured occurrence raw track is unavailable.'
        : 'Timeline data is not available for prepared media placement.');
    }
    const insertedEdit = buildAssetDropEdit({
      current: targetPlan.preparedCurrent,
      assetKey: payload.asset.assetKey,
      assetEntry: payload.asset.entry,
      trackId: targetPlan.trackId,
      time: targetPlan.snappedTime ?? Math.max(0, payload.at),
      clipSpanSeconds: payload.clipSpanSeconds,
      clipId: payload.clipId,
    });
    if (!insertedEdit) {
      throw new Error(`Cannot place prepared asset '${payload.asset.assetKey}' on the requested track.`);
    }
    baseForEdit = targetPlan.preparedCurrent;
    nextEdit = insertedEdit;
    targetTrackId = targetPlan.trackId;
  }

  const nextMeta = { ...baseForEdit.meta };
  for (const [clipId, patch] of Object.entries(nextEdit.metaUpdates)) {
    nextMeta[clipId] = {
      ...nextMeta[clipId],
      ...patch,
    };
  }
  const nextData = materializePreparedData({
    base: baseForEdit,
    rows: nextEdit.rows,
    meta: nextMeta,
    clipOrder: nextEdit.clipOrderOverride,
    pinnedShotGroups: payload.pinnedShotGroupsOverride ?? baseForEdit.config.pinnedShotGroups,
    registry: nextRegistry,
    resolvedRegistry: nextResolvedRegistry,
  });

  return {
    mutation: { type: 'data', data: nextData },
    summary: `Placed prepared asset ${payload.asset.assetKey} on track ${targetTrackId}.`,
    detail: {
      assetKey: payload.asset.assetKey,
      clipId: nextEdit.clipId,
      trackId: targetTrackId,
    },
  };
};

export const PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR: TimelineCommandDescriptor<PlacePreparedMediaCommand> = {
  type: 'place-prepared-media',
  validate: (context) => {
    const { asset, at } = context.command.payload;
    const errors = validateProvisionedAsset(asset, `$.commands[${context.commandIndex}].payload.asset`);
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
      errors.push({
        path: `$.commands[${context.commandIndex}].payload.at`,
        code: 'invalid_at',
        message: 'at must be a finite non-negative number.',
      });
    }
    if (asset) {
      try {
        buildPlacePreparedMediaEffect(context.currentData, context.command.payload);
      } catch (error) {
        errors.push({
          path: `$.commands[${context.commandIndex}].payload`,
          code: 'invalid_placement',
          message: error instanceof Error ? error.message : 'Prepared media placement is invalid.',
        });
      }
    }
    return errors;
  },
  dryRun: (context) => buildPlacePreparedMediaEffect(context.currentData, context.command.payload),
  apply: (context) => buildPlacePreparedMediaEffect(context.currentData, context.command.payload),
  invert: () => null,
};

export const MEDIA_COMMAND_DESCRIPTORS = [
  ADD_MEDIA_COMMAND_DESCRIPTOR,
  SWAP_MEDIA_COMMAND_DESCRIPTOR,
  PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR,
] as const;

export const applyPreparedMediaCommand = (
  currentData: TimelineData,
  command: PlacePreparedMediaCommand,
  options?: ApplyPreparedMediaCommandOptions,
): {
  nextData: TimelineData;
  commandResult: TimelineCommandStepResult<PlacePreparedMediaCommand>;
  history: TimelineCommandHistoryMetadata;
} | null => {
  let diagnostic: PreparedMediaDiagnostic = {
    stage: 'command-schema',
    reason: 'invalid-command',
    fieldCategory: 'command',
  };
  const refuse = () => {
    try {
      options?.onFailure?.(Object.freeze(diagnostic));
    } catch {
      // Diagnostics must never change the existing refusal behavior.
    }
    return null;
  };
  if (!preparedMediaInput.safeParse(command).success) {
    return refuse();
  }
  const payload = command.payload;
  diagnostic = {
    stage: 'provisioned-asset',
    reason: 'invalid-asset',
    fieldCategory: 'asset',
  };
  if (!payload || validateProvisionedAsset(payload.asset, '$.payload.asset').length > 0) {
    return refuse();
  }
  if (!Number.isFinite(payload.at) || payload.at < 0) {
    diagnostic = {
      stage: 'command-schema',
      reason: 'invalid-command',
      fieldCategory: 'placement',
    };
    return refuse();
  }

  diagnostic = {
    stage: 'placement',
    reason: 'invalid-placement',
    fieldCategory: 'placement',
  };
  try {
    const effect = buildPlacePreparedMediaEffect(currentData, payload);
    const nextData = effect.mutation.data;
    diagnostic = {
      stage: 'final-config',
      reason: 'invalid-config',
      fieldCategory: 'config',
    };
    validateSerializedConfig(nextData.config);
    return {
      nextData,
      commandResult: {
        command: {
          type: 'place-prepared-media',
          payload,
          ...(command.commandId !== undefined ? { commandId: command.commandId } : {}),
          ...(command.metadata !== undefined ? { metadata: command.metadata } : {}),
        },
        commandIndex: 0,
        status: 'applied',
        beforeSignature: currentData.stableSignature,
        afterSignature: nextData.stableSignature,
        summary: effect.summary,
        detail: effect.detail,
        inverse: null,
      },
      history: {
        kind: 'command',
        transactionId: undefined,
        commandTypes: ['place-prepared-media'],
        commandIds: command.commandId === undefined ? [] : [command.commandId],
        strategy: 'snapshot_fallback',
        inverseTransaction: null,
        executionMode: 'atomic',
        runMode: 'apply',
        appliedCount: 1,
        failedCount: 0,
        partial: false,
      },
    };
  } catch {
    return refuse();
  }
};

export const previewPreparedMediaCommand = applyPreparedMediaCommand;
