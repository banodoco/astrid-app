import type { TimelineEditability } from '@/tools/video-editor/lib/timeline-editability.ts';
import type { MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';
import { getAssetImmediateSource } from '../lib/asset-registry.ts';
import { canonicalJsonStringify } from '../data/typed/timelineBundle.ts';
import { useMemo } from 'react';
import {
  addTrack as addTrackToConfig,
  getClipEndSeconds,
  getTrackById,
  isHoldClip,
  roundTimelineValue,
  splitClipAtPlayhead,
  updateClipInConfig,
} from '@/tools/video-editor/lib/editor-utils.ts';
import { buildDuplicateClipEdit } from '@/tools/video-editor/lib/duplicate-clip.ts';
import { findEnclosingPinnedGroup } from '@/tools/video-editor/lib/pinned-group-projection.ts';
import { previewTimelineMutation } from '@/tools/video-editor/lib/timeline-mutation-engine.ts';
import {
  buildAssetDropEdit,
  estimateAssetDuration,
  getPlayableAssetKind,
  planAssetDropTarget,
  planGenerationAssetRegistration,
  type TimelineAssetPlacementPolicy,
} from '@/tools/video-editor/lib/timeline-asset-plans.ts';
import { readPositiveDurationSeconds } from '@/tools/video-editor/lib/timeline-asset-durations.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { moveTrackWithinKind } from '@/tools/video-editor/hooks/useTimelineTrackManagement.ts';
import {
  hasMountedTimelineAvailability,
  useTimelineAvailabilityState,
  useTimelineStoreApi,
  useTimelineStoreApiSafe,
  type TimelineStoreApi,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import type {
  TimelineEditorDataContextValue,
  TimelineEditorOpsContextValue,
} from '@/tools/video-editor/hooks/useTimelineState.types.ts';
import type { AssetRegistryEntry, TimelineClip, TrackKind, PinnedShotGroup } from '@/tools/video-editor/types/index.ts';
import type { ManagedObjectGuard, ManagedObjectInfo } from '@/tools/video-editor/lib/managed-object-guard';
import { detachManagedApp } from '@/tools/video-editor/lib/managed-object-guard';
import {
  applyPreparedMediaCommand,
  type PreparedMediaDiagnostic,
  type PlacePreparedMediaCommand,
} from '@/tools/video-editor/commands/media.ts';
import type { TimelineProvisionedAsset } from '@/tools/video-editor/commands/provisioning.ts';
import { useOptionalVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';

export type TimelineCommandErrorCode =
  | 'editor_not_mounted'
  | 'timeline_unavailable'
  | 'timeline_read_only'
  | 'clip_not_found'
  | 'track_not_found'
  | 'asset_not_found'
  | 'unsupported_asset_type'
  | 'invalid_argument'
  | 'pinned_group_edit_blocked'
  | 'managed_object_blocked'
  | 'mutation_failed'
  | 'asset_registration_failed'
  | 'timeline_read_only';

export interface TimelineCommandError {
  code: TimelineCommandErrorCode;
  message: string;
  level?: string;
  issues?: unknown[];
  cause?: unknown;
  diagnostic?: PreparedMediaDiagnostic;
  /** Managed-object metadata when code is 'managed_object_blocked'. */
  managedInfo?: ManagedObjectInfo;
}

export type TimelineCommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: TimelineCommandError };

export interface AddClipCommandInput {
  assetId?: string;
  preparedAsset?: TimelineProvisionedAsset;
  time?: number;
  trackId?: string;
  forceNewTrack?: boolean;
  insertAtTop?: boolean;
  clipSpanSeconds?: number | null;
  afterClipId?: string;
  oldMediaSelection?: MediaSelection;
  clipId?: string;
  removeClipId?: string;
  removeClipIds?: string[];
  replaceClipId?: string;
  pinnedShotGroupsOverride?: PinnedShotGroup[];
  /** Preserve a caller-captured occurrence raw track during prepared placement. */
  placementPolicy?: TimelineAssetPlacementPolicy;
}

export interface UpdateClipCommandInput {
  clipId: string;
  patch: Partial<Omit<TimelineClip, 'id'>>;
}

export interface MoveClipCommandInput {
  clipId: string;
  trackId?: string;
  time?: number;
}

export interface TrimClipCommandInput {
  clipId: string;
  startTime?: number;
  endTime?: number;
}

export interface SplitClipCommandInput {
  clipId: string;
  time: number;
}

export interface DeleteClipCommandInput {
  clipId: string;
  allowPinnedGroupDelete?: boolean;
}

export interface AddTrackCommandInput {
  kind: TrackKind;
  index?: number;
}

export interface MoveTrackCommandInput {
  trackId: string;
  overTrackId: string;
}

export type RegisterAssetCommandInput =
  | {
      assetId: string;
      entry: AssetRegistryEntry;
      sourceUrl?: string;
    }
  | {
      assetId?: string;
      generationId: string;
      variantId?: string;
      variantType?: string;
      imageUrl: string;
      thumbUrl?: string | null;
      metadata?: Record<string, unknown> | null | undefined;
      assetDurationSeconds?: number | null;
    };

export interface SetClipParamsCommandInput {
  clipId: string;
  params: Record<string, unknown> | undefined;
}

/** Input for detaching a managed clip from its owning extension. */
export interface DetachManagedClipCommandInput {
  clipId: string;
}

export interface TimelineCommands {
  /**
   * Insert a registry-backed asset clip onto the timeline without exposing the
   * raw rows/meta/clipOrder mutation path.
   */
  addClip: (input: AddClipCommandInput) => TimelineCommandResult<{ clipId: string; trackId: string }>;
  /**
   * Apply a shallow persisted-clip patch and route validation through the
   * canonical config mutation path.
   */
  updateClip: (input: UpdateClipCommandInput) => TimelineCommandResult<{ clipId: string }>;
  /**
   * Move a clip by timeline time and/or track using the canonical config path.
   * Pinned-group drag semantics stay internal for Sprint 2.
   */
  moveClip: (input: MoveClipCommandInput) => TimelineCommandResult<{ clipId: string; trackId: string; time: number }>;
  /**
   * Trim a clip by timeline start/end while preserving the existing clip's
   * source-time interpretation.
   */
  trimClip: (input: TrimClipCommandInput) => TimelineCommandResult<{ clipId: string; startTime: number; endTime: number }>;
  /**
   * Split a clip at the requested timeline time.
   */
  splitClip: (input: SplitClipCommandInput) => TimelineCommandResult<{ clipId: string; nextClipId: string }>;
  /**
   * Delete a clip through the existing commit pipeline.
   */
  deleteClip: (input: DeleteClipCommandInput) => TimelineCommandResult<{ clipId: string }>;
  /**
   * Add a track and select it.
   */
  addTrack: (input: AddTrackCommandInput) => TimelineCommandResult<{ trackId: string }>;
  /**
   * Reorder a track within its kind lane.
   */
  moveTrack: (input: MoveTrackCommandInput) => TimelineCommandResult<{ trackId: string }>;
  /**
   * Accept an optimistic registry edit into the canonical timeline save path.
   * `{ok: true}` confirms edit acceptance; durable acknowledgement is obtained
   * through `TimelineOps.flush()`, which rejects when the save is unverified.
   */
  registerAsset: (input: RegisterAssetCommandInput) => Promise<TimelineCommandResult<{ assetId: string }>>;
  /**
   * Replace the persisted `params` blob for a clip.
   */
  setClipParams: (input: SetClipParamsCommandInput) => TimelineCommandResult<{ clipId: string }>;
  /**
   * Detach a clip from extension management by clearing managed-object
   * metadata (managedBy, __generated__, extension namespace keys, source_uuid).
   *
   * After detachment the clip becomes a regular user-owned clip and future
   * edits will not trigger the managed-object confirmation dialog.
   */
  detachManagedClip: (input: DetachManagedClipCommandInput) => TimelineCommandResult<{ clipId: string }>;
}

/**
 * Sprint 2 public command surface for non-gesture callers.
 *
 * Keep this list narrow so developers and agents mutate timelines through the
 * facade without depending on raw rows/meta/clipOrder internals.
 */
export const PUBLIC_TIMELINE_COMMAND_NAMES = [
  'addClip',
  'updateClip',
  'moveClip',
  'trimClip',
  'splitClip',
  'deleteClip',
  'addTrack',
  'moveTrack',
  'registerAsset',
  'setClipParams',
  'detachManagedClip',
] as const satisfies ReadonlyArray<keyof TimelineCommands>;

/**
 * Sprint 2 intentionally keeps the public facade on non-gesture entrypoints.
 * Gesture-driven timeline edits continue to reuse shared planners internally.
 */
export const PUBLIC_TIMELINE_COMMAND_SCOPE = 'non-gesture' as const;
export const INTERNAL_GESTURE_TIMELINE_MUTATIONS = [
  'useExternalDrop',
  'usePinnedShotGroups',
] as const;

const PUBLIC_TIMELINE_COMMAND_NAME_SET = new Set<string>(PUBLIC_TIMELINE_COMMAND_NAMES);

export function isPublicTimelineCommandName(value: string): value is typeof PUBLIC_TIMELINE_COMMAND_NAMES[number] {
  return PUBLIC_TIMELINE_COMMAND_NAME_SET.has(value);
}

type CommandStoreState = {
  data: TimelineEditorDataContextValue;
  ops: TimelineEditorOpsContextValue;
  availability: { mounted: boolean };
};

const success = <T,>(data: T): TimelineCommandResult<T> => ({ ok: true, data });

const failure = (
  code: TimelineCommandErrorCode,
  message: string,
  extra?: Partial<Omit<TimelineCommandError, 'code' | 'message'>>,
): TimelineCommandResult<never> => ({
  ok: false,
  error: {
    code,
    message,
    ...(extra?.level ? { level: extra.level } : {}),
    ...(extra?.issues ? { issues: extra.issues } : {}),
    ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
    ...(extra?.diagnostic ? { diagnostic: extra.diagnostic } : {}),
    ...(extra?.managedInfo ? { managedInfo: extra.managedInfo } : {}),
  },
});

const getCurrentData = (state: CommandStoreState): TimelineData | null => {
  return state.data.dataRef.current ?? state.data.data;
};

const getResolvedClip = (current: TimelineData, clipId: string) => {
  return current.resolvedConfig.clips.find((clip) => clip.id === clipId) ?? null;
};

const isPinnedGroupClip = (current: TimelineData, clipId: string): boolean => {
  return findEnclosingPinnedGroup(current.config, clipId) !== null;
};

const getClipTrackKind = (current: TimelineData, clip: TimelineData['resolvedConfig']['clips'][number]): TrackKind => {
  if (clip.clipType === 'text' || clip.clipType === 'hold' || clip.clipType === 'effect-layer') {
    return 'visual';
  }

  if (clip.asset) {
    const assetEntry = current.registry.assets[clip.asset];
    return getPlayableAssetKind(assetEntry) === 'audio' ? 'audio' : 'visual';
  }

  return 'visual';
};

const validateMutation = (
  current: TimelineData,
  mutation: Parameters<typeof previewTimelineMutation>[1],
): TimelineCommandResult<null> => {
  const preview = previewTimelineMutation(current, mutation);
  if (!preview.ok) {
    return failure(
      'mutation_failed',
      preview.error.message,
      {
        level: preview.error.level,
        issues: preview.error.issues,
        cause: preview.error.cause,
      },
    );
  }

  return success(null);
};

const applyValidatedMutation = <T,>(
  store: TimelineStoreApi,
  current: TimelineData,
  mutation: Parameters<typeof previewTimelineMutation>[1],
  result: T,
  options?: Parameters<TimelineEditorOpsContextValue['applyEdit']>[1],
  preparedCurrent?: TimelineData,
): TimelineCommandResult<T> => {
  const validation = validateMutation(preparedCurrent ?? current, mutation);
  if (!validation.ok) {
    return validation;
  }

  const state = store.getState();
  const previousCurrent = state.data.dataRef.current;

  try {
    if (preparedCurrent) {
      state.data.dataRef.current = preparedCurrent;
    }
    state.ops.applyEdit(mutation, options);
    return success(result);
  } catch (cause) {
    state.data.dataRef.current = previousCurrent;
    return failure(
      'mutation_failed',
      cause instanceof Error ? cause.message : 'Timeline mutation failed',
      { cause },
    );
  }
};

export interface CreateTimelineCommandsOptions {
  /** Optional ManagedObjectGuard for intercepting edits on managed clips. */
  managedObjectGuard?: ManagedObjectGuard | null;
  /** Optional host-owned policy that can deny all timeline mutations. */
  timelineEditability?: TimelineEditability;
  /** Runtime save hosts need the original selection before admitting new media. */
  preparedMediaRequiresSelection?: boolean;
}

/**
 * Build the mounted command facade from the timeline store.
 *
 * Prefer `useTimelineCommandsService()` or `useTimelineCommandsServiceSafe()` at runtime.
 */
export function createTimelineCommands(
  store: TimelineStoreApi,
  options?: CreateTimelineCommandsOptions,
): TimelineCommands {
  const registrationPlans = new WeakMap<object, Map<string, { assetId: string; entry: AssetRegistryEntry; sourceUrl?: string }>>();
  const explicitGuard = options?.managedObjectGuard;
  const checkTimelineEditable = (): TimelineCommandResult<never> | null => {
    const permission = options?.timelineEditability?.checkTimeline?.();
    if (!permission || permission.allowed) return null;
    return failure(
      'timeline_read_only',
      permission.reason
        ? `Timeline is read-only (${permission.reason}).`
        : 'Timeline is read-only.',
    );
  };
  const getManagedObjectGuard = (): ManagedObjectGuard | null => {
    if (explicitGuard !== undefined) return explicitGuard;
    return store.getState().managedObjectGuard ?? null;
  };

  const getMountedState = (): CommandStoreState | null => {
    const state = store.getState();
    if (!state.availability.mounted) {
      return null;
    }
    return state;
  };

  /**
   * Check if a clip is managed by an extension and return a blocked error
   * if it is. Returns null if the clip can be freely edited.
   */
  const checkManagedClip = (clipId: string): TimelineCommandResult<never> | null => {
    const guard = getManagedObjectGuard();
    if (!guard) return null;
    const info = guard.checkClipManaged(clipId);
    if (!info) return null;

    return failure(
      'managed_object_blocked',
      `Clip '${clipId}' is managed by ${info.managedBy}. Confirm to detach and edit anyway.`,
      { managedInfo: info },
    );
  };

  /**
   * Build a patch that detaches managed-object metadata from the clip's app
   * and source_uuid fields, using the store's extension requirements for
   * namespace key detection.
   */
  const buildDetachPatch = (clip: TimelineClip): Partial<Omit<TimelineClip, 'id'>> => {
    const state = store.getState();
    // Collect known extension IDs from the store's extension requirements.
    const extensionIds = new Set<string>();
    if (state.timelineOps) {
      const snapshot = state.timelineOps;
      // We need to get extension IDs — read from the timeline reader if available.
    }
    // Fallback: use the managedBy value from the clip itself.
    const knownExtIds: ReadonlySet<string> = new Set(
      clip.app && typeof clip.app.managedBy === 'string' ? [clip.app.managedBy] : [],
    );

    const nextApp = detachManagedApp(clip.app as Record<string, unknown> | undefined, knownExtIds);

    const patch: Partial<Omit<TimelineClip, 'id'>> = {
      app: nextApp as any,
    };

    // Also clear source_uuid if it matches a known extension.
    if (clip.source_uuid && knownExtIds.has(clip.source_uuid)) {
      patch.source_uuid = undefined as any;
    }

    return patch;
  };

  const commands: TimelineCommands = {
    addClip(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      if (input.preparedAsset) {
        if (options?.preparedMediaRequiresSelection && !current.registry.assets[input.preparedAsset.assetKey]
          && !input.preparedAsset.mediaSelection) {
          return failure('invalid_argument', 'Could not resolve the Runtime project media selection. Import the media again.');
        }
        let preparedAt = input.time;
        const preparedTrackId = input.trackId;
        if (input.afterClipId) {
          if (isPinnedGroupClip(current, input.afterClipId)) {
            return failure('pinned_group_edit_blocked', 'Pinned shot-group duplication stays on the internal shot-group path in Sprint 2.');
          }
          const sourceClip = getResolvedClip(current, input.afterClipId);
          if (!sourceClip) {
            return failure('clip_not_found', `Clip '${input.afterClipId}' was not found.`);
          }
          preparedAt ??= 0;
        }
        if (typeof preparedAt !== 'number') {
          return failure('invalid_argument', 'A prepared asset requires a target time or afterClipId.');
        }
        const command: PlacePreparedMediaCommand = {
          type: 'place-prepared-media',
          payload: {
            asset: input.preparedAsset,
            ...(preparedTrackId !== undefined ? { trackId: preparedTrackId } : {}),
            ...(state.data.selectedTrackId !== undefined
              ? { selectedTrackId: state.data.selectedTrackId }
              : {}),
            at: Math.max(0, preparedAt),
            ...(input.afterClipId !== undefined ? { afterClipId: input.afterClipId } : {}),
            ...(input.oldMediaSelection !== undefined ? { oldMediaSelection: input.oldMediaSelection } : {}),
            forceNewTrack: input.forceNewTrack ?? false,
            insertAtTop: input.insertAtTop ?? false,
            ...(input.clipSpanSeconds !== undefined ? { clipSpanSeconds: input.clipSpanSeconds } : {}),
            ...(input.clipId !== undefined ? { clipId: input.clipId } : {}),
            ...(input.removeClipId !== undefined ? { removeClipId: input.removeClipId } : {}),
            ...(input.removeClipIds !== undefined ? { removeClipIds: input.removeClipIds } : {}),
            ...(input.replaceClipId !== undefined ? { replaceClipId: input.replaceClipId } : {}),
            ...(input.pinnedShotGroupsOverride !== undefined
              ? { pinnedShotGroupsOverride: input.pinnedShotGroupsOverride }
              : {}),
            ...(input.placementPolicy !== undefined ? { placementPolicy: input.placementPolicy } : {}),
          },
        };
        let diagnostic: PreparedMediaDiagnostic | undefined;
        const preview = applyPreparedMediaCommand(current, command, {
          onFailure: (failureDiagnostic) => {
            diagnostic = failureDiagnostic;
          },
        });
        const detail = preview?.commandResult?.detail;
        if (!detail || typeof detail.clipId !== 'string' || typeof detail.trackId !== 'string') {
          return failure('mutation_failed', 'Failed to place the prepared asset on the timeline.', diagnostic ? { diagnostic } : undefined);
        }
        state.ops.applyEdit({ type: 'prepared-media', command }, {
          selectedClipId: detail.clipId,
          selectedTrackId: detail.trackId,
          semantic: true,
        });
        return success({ clipId: detail.clipId, trackId: detail.trackId });
      }

      if (!input.assetId) {
        return failure('invalid_argument', 'addClip requires assetId or preparedAsset.');
      }

      const assetEntry = current.registry.assets[input.assetId];
      const playableKind = getPlayableAssetKind(assetEntry);
      if (!assetEntry) {
        return failure('asset_not_found', `Asset '${input.assetId}' is not registered in the timeline registry.`);
      }
      if (!playableKind) {
        return failure('unsupported_asset_type', 'Only image, video, and audio assets can be added to the timeline.');
      }

      const assetKind = playableKind === 'audio' ? 'audio' : 'visual';
      if (input.afterClipId) {
        if (isPinnedGroupClip(current, input.afterClipId)) {
          return failure('pinned_group_edit_blocked', 'Pinned shot-group duplication stays on the internal shot-group path in Sprint 2.');
        }

        const nextEdit = buildDuplicateClipEdit(current, input.afterClipId, input.assetId);
        if (!nextEdit) {
          return failure('clip_not_found', `Clip '${input.afterClipId}' was not found.`);
        }

        return applyValidatedMutation(
          store,
          current,
          {
            type: 'rows',
            rows: nextEdit.rows,
            metaUpdates: nextEdit.metaUpdates,
            clipOrderOverride: nextEdit.clipOrderOverride,
          },
          {
            clipId: nextEdit.clipId,
            trackId: nextEdit.trackId,
          },
          {
            selectedClipId: nextEdit.clipId,
            selectedTrackId: nextEdit.trackId,
            semantic: true,
          },
        );
      }

      if (typeof input.time !== 'number') {
        return failure('invalid_argument', 'addClip requires a target time unless `afterClipId` is provided.');
      }

      const plannedDuration = readPositiveDurationSeconds(input.clipSpanSeconds)
        ?? estimateAssetDuration(assetEntry, assetKind);
      const targetPlan = planAssetDropTarget({
        current,
        assetKind,
        trackId: input.trackId,
        selectedTrackId: state.data.selectedTrackId,
        forceNewTrack: input.forceNewTrack ?? false,
        insertAtTop: input.insertAtTop ?? false,
        time: Math.max(0, input.time),
        duration: plannedDuration,
      });
      if (!targetPlan.ok) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const nextEdit = buildAssetDropEdit({
        current: targetPlan.preparedCurrent,
        assetKey: input.assetId,
        trackId: targetPlan.trackId,
        time: targetPlan.snappedTime ?? Math.max(0, input.time),
        clipSpanSeconds: input.clipSpanSeconds,
      });
      if (!nextEdit) {
        return failure('mutation_failed', 'Failed to build an insert mutation for the requested asset.');
      }

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'rows',
          rows: nextEdit.rows,
          metaUpdates: nextEdit.metaUpdates,
          clipOrderOverride: nextEdit.clipOrderOverride,
        },
        {
          clipId: nextEdit.clipId,
          trackId: targetPlan.trackId,
        },
        {
          selectedClipId: nextEdit.clipId,
          selectedTrackId: targetPlan.trackId,
          semantic: true,
        },
        targetPlan.preparedCurrent,
      );
    },

    updateClip(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const clip = getResolvedClip(current, input.clipId);
      if (!clip) {
        return failure('clip_not_found', `Clip '${input.clipId}' was not found.`);
      }

      // --- M3 managed-object guard ---
      const managedBlock = checkManagedClip(input.clipId);
      if (managedBlock) return managedBlock;

      if (input.patch.track) {
        const targetTrack = getTrackById(current.resolvedConfig, input.patch.track);
        if (!targetTrack) {
          return failure('track_not_found', `Track '${input.patch.track}' was not found.`);
        }
        const clipTrackKind = getClipTrackKind(current, clip);
        if (targetTrack.kind !== clipTrackKind) {
          return failure('invalid_argument', `Clip '${input.clipId}' cannot be moved to ${targetTrack.kind} track '${targetTrack.id}'.`);
        }
      }

      const nextConfig = updateClipInConfig(current.resolvedConfig, input.clipId, (existingClip) => ({
        ...existingClip,
        ...input.patch,
        ...(typeof input.patch.at === 'number' ? { at: Math.max(0, roundTimelineValue(input.patch.at)) } : {}),
      }));

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'config',
          resolvedConfig: nextConfig,
        },
        { clipId: input.clipId },
        {
          selectedClipId: input.clipId,
          selectedTrackId: input.patch.track ?? clip.track,
        },
      );
    },

    moveClip(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const clip = getResolvedClip(current, input.clipId);
      if (!clip) {
        return failure('clip_not_found', `Clip '${input.clipId}' was not found.`);
      }
      if (isPinnedGroupClip(current, input.clipId)) {
        return failure('pinned_group_edit_blocked', 'Pinned shot-group clip movement stays on the internal gesture path in Sprint 2.');
      }
      if (input.trackId === undefined && input.time === undefined) {
        return failure('invalid_argument', 'moveClip requires a target track, a target time, or both.');
      }

      // --- M3 managed-object guard ---
      const managedBlock = checkManagedClip(input.clipId);
      if (managedBlock) return managedBlock;

      const nextTrackId = input.trackId ?? clip.track;
      const targetTrack = getTrackById(current.resolvedConfig, nextTrackId);
      if (!targetTrack) {
        return failure('track_not_found', `Track '${nextTrackId}' was not found.`);
      }

      const clipTrackKind = getClipTrackKind(current, clip);
      if (targetTrack.kind !== clipTrackKind) {
        return failure('invalid_argument', `Clip '${input.clipId}' cannot be moved to ${targetTrack.kind} track '${targetTrack.id}'.`);
      }

      const nextTime = input.time === undefined ? clip.at : Math.max(0, roundTimelineValue(input.time));
      const nextConfig = updateClipInConfig(current.resolvedConfig, input.clipId, (existingClip) => ({
        ...existingClip,
        at: nextTime,
        track: nextTrackId,
      }));

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'config',
          resolvedConfig: nextConfig,
        },
        { clipId: input.clipId, trackId: nextTrackId, time: nextTime },
        {
          selectedClipId: input.clipId,
          selectedTrackId: nextTrackId,
          semantic: true,
        },
      );
    },

    trimClip(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const clip = getResolvedClip(current, input.clipId);
      if (!clip) {
        return failure('clip_not_found', `Clip '${input.clipId}' was not found.`);
      }
      if (isPinnedGroupClip(current, input.clipId)) {
        return failure('pinned_group_edit_blocked', 'Pinned shot-group clip trimming stays on the internal gesture path in Sprint 2.');
      }

      // --- M3 managed-object guard ---
      const managedBlock = checkManagedClip(input.clipId);
      if (managedBlock) return managedBlock;

      const currentStart = clip.at;
      const currentEnd = getClipEndSeconds(clip);
      const nextStart = input.startTime === undefined ? currentStart : roundTimelineValue(input.startTime);
      const nextEnd = input.endTime === undefined ? currentEnd : roundTimelineValue(input.endTime);

      if (nextStart < currentStart || nextEnd > currentEnd) {
        return failure('invalid_argument', 'trimClip only supports trimming within the clip’s current timeline bounds.');
      }
      if (nextEnd <= nextStart) {
        return failure('invalid_argument', 'trimClip requires an end time after the start time.');
      }

      const nextConfig = updateClipInConfig(current.resolvedConfig, input.clipId, (existingClip) => {
        if (isHoldClip(existingClip)) {
          return {
            ...existingClip,
            at: nextStart,
            hold: roundTimelineValue(nextEnd - nextStart),
          };
        }

        const speed = existingClip.speed ?? 1;
        const currentFrom = existingClip.from ?? 0;
        const nextFrom = roundTimelineValue(currentFrom + (nextStart - existingClip.at) * speed);
        const nextTo = roundTimelineValue(nextFrom + (nextEnd - nextStart) * speed);
        return {
          ...existingClip,
          at: nextStart,
          from: nextFrom,
          to: nextTo,
        };
      });

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'config',
          resolvedConfig: nextConfig,
        },
        { clipId: input.clipId, startTime: nextStart, endTime: nextEnd },
        {
          selectedClipId: input.clipId,
          selectedTrackId: clip.track,
          semantic: true,
        },
      );
    },

    splitClip(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const clip = getResolvedClip(current, input.clipId);
      if (!clip) {
        return failure('clip_not_found', `Clip '${input.clipId}' was not found.`);
      }
      if (isPinnedGroupClip(current, input.clipId)) {
        return failure('pinned_group_edit_blocked', 'Pinned shot-group clip splitting stays on the internal gesture path in Sprint 2.');
      }

      // --- M3 managed-object guard ---
      const managedBlock = checkManagedClip(input.clipId);
      if (managedBlock) return managedBlock;

      const splitResult = splitClipAtPlayhead(current.resolvedConfig, input.clipId, input.time);
      if (!splitResult.nextSelectedClipId) {
        return failure('invalid_argument', 'The requested split time is outside the clip’s playable range.');
      }

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'config',
          resolvedConfig: splitResult.config,
        },
        { clipId: input.clipId, nextClipId: splitResult.nextSelectedClipId },
        {
          selectedClipId: splitResult.nextSelectedClipId,
          selectedTrackId: clip.track,
          semantic: true,
        },
      );
    },

    deleteClip(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const clip = getResolvedClip(current, input.clipId);
      if (!clip) {
        return failure('clip_not_found', `Clip '${input.clipId}' was not found.`);
      }
      if (!input.allowPinnedGroupDelete && isPinnedGroupClip(current, input.clipId)) {
        return failure('pinned_group_edit_blocked', 'Use the shot-group delete flow for pinned shot clips.');
      }

      // --- M3 managed-object guard ---
      const managedBlock = checkManagedClip(input.clipId);
      if (managedBlock) return managedBlock;

      const nextRows = current.rows.map((row) => ({
        ...row,
        actions: row.actions.filter((action) => action.id !== input.clipId),
      }));

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'rows',
          rows: nextRows,
          metaDeletes: [input.clipId],
        },
        { clipId: input.clipId },
        { semantic: true },
      );
    },

    addTrack(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const nextConfig = addTrackToConfig(current.resolvedConfig, input.kind, input.index);
      const nextTrack = nextConfig.tracks.find((track) => (
        !current.resolvedConfig.tracks.some((existingTrack) => existingTrack.id === track.id)
      )) ?? nextConfig.tracks[nextConfig.tracks.length - 1];
      if (!nextTrack) {
        return failure('mutation_failed', 'Failed to create the requested track.');
      }

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'config',
          resolvedConfig: nextConfig,
        },
        { trackId: nextTrack.id },
        {
          selectedTrackId: nextTrack.id,
        },
      );
    },

    moveTrack(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const activeTrack = current.resolvedConfig.tracks.find((track) => track.id === input.trackId);
      const overTrack = current.resolvedConfig.tracks.find((track) => track.id === input.overTrackId);
      if (!activeTrack) {
        return failure('track_not_found', `Track '${input.trackId}' was not found.`);
      }
      if (!overTrack) {
        return failure('track_not_found', `Track '${input.overTrackId}' was not found.`);
      }
      if (activeTrack.kind !== overTrack.kind) {
        return failure('invalid_argument', 'Tracks can only be reordered within the same kind.');
      }

      const nextTracks = moveTrackWithinKind(current.resolvedConfig.tracks, input.trackId, input.overTrackId);
      if (nextTracks === current.resolvedConfig.tracks) {
        return failure('invalid_argument', 'The requested track reorder does not change the current order.');
      }

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'config',
          resolvedConfig: {
            ...current.resolvedConfig,
            tracks: nextTracks,
          },
        },
        { trackId: input.trackId },
        {
          selectedTrackId: input.trackId,
        },
      );
    },

    async registerAsset(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      let plans = registrationPlans.get(state.data.dataRef);
      if (!plans) {
        plans = new Map();
        registrationPlans.set(state.data.dataRef, plans);
      }
      const key = canonicalJsonStringify(input);
      let normalized = plans.get(key);
      if (!normalized) {
        if ('entry' in input) {
          if (!input.assetId.trim() || !input.entry || !(input.sourceUrl ?? getAssetImmediateSource(input.entry))?.trim()) {
            return failure('invalid_argument', 'registerAsset requires an asset identity and media source.');
          }
          normalized = { assetId: input.assetId, entry: structuredClone(input.entry), sourceUrl: input.sourceUrl ?? getAssetImmediateSource(input.entry) };
        } else {
          const plan = planGenerationAssetRegistration(input);
          if (!plan.ok || !input.imageUrl.trim()) {
            return failure('invalid_argument', 'registerAsset requires a non-empty media URL.');
          }
          normalized = { assetId: plan.assetId, entry: plan.assetEntry, sourceUrl: plan.sourceUrl };
        }
        plans.set(key, normalized);
      }
      try {
        // Asset registration is accepted into the mounted timeline's canonical
        // registry. TimelineOps owns the durable save and acknowledgement; the
        // public command must not start a separate host write.
        state.ops.patchRegistry(normalized.assetId, normalized.entry, normalized.sourceUrl);
        return success({ assetId: normalized.assetId });
      } catch (cause) {
        return failure('asset_registration_failed', cause instanceof Error ? cause.message : 'Asset registration failed.', { cause });
      }
    },

    setClipParams(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      // --- M3 managed-object guard ---
      const managedBlock = checkManagedClip(input.clipId);
      if (managedBlock) return managedBlock;

      return commands.updateClip({
        clipId: input.clipId,
        patch: {
          params: input.params,
        },
      });
    },

    detachManagedClip(input) {
      const readOnly = checkTimelineEditable();
      if (readOnly) return readOnly;
      const state = getMountedState();
      if (!state) {
        return failure('editor_not_mounted', 'Timeline commands are only available in a mounted editor.');
      }

      const current = getCurrentData(state);
      if (!current) {
        return failure('timeline_unavailable', 'Timeline data is not loaded.');
      }

      const clip = getResolvedClip(current, input.clipId);
      if (!clip) {
        return failure('clip_not_found', `Clip '${input.clipId}' was not found.`);
      }

      // Build detach patch from the current clip.
      const detachPatch = buildDetachPatch(clip);

      const nextConfig = updateClipInConfig(current.resolvedConfig, input.clipId, (existingClip) => ({
        ...existingClip,
        ...detachPatch,
      }));

      return applyValidatedMutation(
        store,
        current,
        {
          type: 'config',
          resolvedConfig: nextConfig,
        },
        { clipId: input.clipId },
        {
          selectedClipId: input.clipId,
          selectedTrackId: clip.track,
          semantic: true,
        },
      );
    },
  };

  return commands;
}

/**
 * Mounted-only public timeline command facade.
 *
 * This is the Sprint 2 recommended mutation surface for non-gesture callers.
 *
 * *Builds* the `TimelineCommands` facade from the store api. Components
 * rendering inside the editor normally want `useTimelineCommands` in
 * `hooks/timelineStore.ts` instead — a plain selector for `state.ops.commands`.
 */
export function useTimelineCommandsService(): TimelineCommands {
  const store = useTimelineStoreApi();
  const runtime = useOptionalVideoEditorRuntime();
  const editability = runtime?.timelineEditability;
  const preparedMediaRequiresSelection = Boolean(runtime?.provider.commitTimeline);
  return useMemo(() => createTimelineCommands(store, {timelineEditability: editability, preparedMediaRequiresSelection}), [store, editability, preparedMediaRequiresSelection]);
}

/**
 * Nullable mounted-safe command facade.
 *
 * Outside a mounted editor this returns `null` so staged add-to-editor flows can
 * preserve their existing fallback behavior.
 */
export function useTimelineCommandsServiceSafe(): TimelineCommands | null {
  const runtime = useOptionalVideoEditorRuntime();
  const editability = runtime?.timelineEditability;
  const preparedMediaRequiresSelection = Boolean(runtime?.provider.commitTimeline);
  const store = useTimelineStoreApiSafe();
  const availability = useTimelineAvailabilityState();

  return useMemo(() => {
    if (!store || !hasMountedTimelineAvailability(availability)) {
      return null;
    }
    return createTimelineCommands(store, {timelineEditability: editability, preparedMediaRequiresSelection});
  }, [availability.hasProvider, availability.mounted, store, editability, preparedMediaRequiresSelection]);
}
