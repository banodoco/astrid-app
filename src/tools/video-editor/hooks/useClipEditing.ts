import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AgentChatEditorContext } from '@/shared/contexts/AgentChatContext.tsx';
import { canonicalJsonStringify } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import { toast } from '@/shared/components/ui/runtime/sonner.tsx';
import type { SelectClipOptions } from '@/shared/state/selectionStore.ts';
import {
  patchAffectsDuration,
  recalcActionEnd,
} from '@/tools/video-editor/lib/clip-editing-utils.ts';
import { findEnclosingPinnedGroup } from '@/tools/video-editor/lib/pinned-group-projection.ts';
import {
  type ClipMeta,
  type TimelineData,
} from '@/tools/video-editor/lib/timeline-data.ts';
import type { TimelineGestureReadBasis } from './timelineLocalSaveHandoff.ts';
import type { ApplyEditOptions } from '@/tools/video-editor/hooks/useTimelineCommit.ts';
import type {
  TimelineApplyEdit,
  TimelineSelectedTrack,
} from '@/tools/video-editor/hooks/timeline-state-types.ts';
import {
  useClipAudioManagement,
  useClipDeletion,
  useClipPositioning,
  useClipSplitting,
} from './clip-editing/index.ts';
import type { ClipEditingContext } from './clip-editing/index.ts';
import type { DeleteClipOptions } from './clip-editing/types.ts';

export interface UseClipEditingArgs {
  dataRef: MutableRefObject<TimelineData | null>;
  resolvedConfig: TimelineData['resolvedConfig'] | null;
  selectedClipId: string | null;
  selectedTrack: TimelineSelectedTrack;
  currentTime: number;
  selectClip: (clipId: string, opts?: SelectClipOptions) => void;
  setSelectedTrackId: Dispatch<SetStateAction<string | null>>;
  applyEdit: TimelineApplyEdit;
}

export interface UseClipEditingResult {
  onOverlayChange: (actionId: string, patch: Partial<ClipMeta>) => void;
  handleUpdateClips: (clipIds: string[], patch: Partial<ClipMeta>) => void;
  handleUpdateClipsDeep: (clipIds: string[], patchFn: (existing: ClipMeta) => Partial<ClipMeta>) => void;
  handleDeleteClips: (clipIds: string[], options?: DeleteClipOptions) => void;
  handleDeleteClip: (clipId: string, options?: DeleteClipOptions) => void;
  handleSelectedClipChange: (patch: Partial<ClipMeta> & { at?: number }, elementOwner?: AgentChatEditorContext | null) => void;
  handleResetClipPosition: () => void;
  handleResetClipsPosition: (clipIds: string[]) => void;
  handleSplitSelectedClip: () => void;
  handleSplitClipAtTime: (clipId: string, timeSeconds: number) => void;
  handleSplitClipsAtPlayhead: (clipIds: string[]) => void;
  handleToggleMuteClips: (clipIds: string[]) => void;
  handleToggleMute: () => void;
  handleDetachAudioClip: (clipId: string) => void;
}

export { DURATION_KEYS, patchAffectsDuration, recalcActionEnd } from '@/tools/video-editor/lib/clip-editing-utils.ts';
export type { DeleteClipOptions } from './clip-editing/types.ts';

const PINNED_GROUP_EDIT_MESSAGE = 'Use Delete shot from the shot menu';

export function useClipEditing({
  dataRef,
  resolvedConfig,
  selectedClipId,
  selectedTrack,
  currentTime,
  selectClip,
  setSelectedTrackId,
  applyEdit,
}: UseClipEditingArgs): UseClipEditingResult {
  const currentTimeRef = useRef(currentTime);

  const applyRowsEdit = useCallback((
    rows: TimelineData['rows'],
    metaUpdates?: Record<string, Partial<ClipMeta>>,
    metaDeletes?: string[],
    clipOrderOverride?: TimelineData['clipOrder'],
    options?: ApplyEditOptions,
  ) => {
    const mutation = {
      type: 'rows',
      rows,
      ...(metaUpdates ? { metaUpdates } : {}),
      ...(metaDeletes ? { metaDeletes } : {}),
      ...(clipOrderOverride ? { clipOrderOverride } : {}),
    } as const;

    if (options) {
      applyEdit(mutation, options);
      return;
    }

    applyEdit(mutation);
  }, [applyEdit]);

  const applyConfigEdit = useCallback((
    resolvedConfig: TimelineData['resolvedConfig'],
    options?: ApplyEditOptions,
  ) => {
    const mutation = {
      type: 'config',
      resolvedConfig,
    } as const;

    if (options) {
      applyEdit(mutation, options);
      return;
    }

    applyEdit(mutation);
  }, [applyEdit]);

  const isPinnedGroupMember = useCallback((clipId: string): boolean => {
    const current = dataRef.current;
    if (!current) {
      return false;
    }

    return findEnclosingPinnedGroup(current.config, clipId) !== null;
  }, [dataRef]);

  const notifyPinnedGroupEditBlocked = useCallback(() => {
    toast.error(PINNED_GROUP_EDIT_MESSAGE);
  }, []);

  useLayoutEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const onOverlayChange = useCallback((actionId: string, patch: Partial<ClipMeta>) => {
    const current = dataRef.current;
    if (!current) {
      return;
    }

    applyRowsEdit(current.rows, { [actionId]: patch });
  }, [applyRowsEdit, dataRef]);

  const getValidClipIds = useCallback((clipIds: string[]) => {
    const current = dataRef.current;
    if (!current) {
      return [];
    }

    const uniqueClipIds = new Set<string>();
    for (const clipId of clipIds) {
      if (clipId.startsWith('uploading-') || !current.meta[clipId]) {
        continue;
      }

      uniqueClipIds.add(clipId);
    }

    return [...uniqueClipIds];
  }, [dataRef]);

  const transitionClearBasis = useCallback((metaUpdates: Record<string, Partial<ClipMeta>>): TimelineGestureReadBasis | undefined => {
    const current = dataRef.current;
    const clipIds = Object.keys(metaUpdates);
    if (!current || current.resolvedConfig !== resolvedConfig || !clipIds.length
      || clipIds.some(id => Object.keys(metaUpdates[id]).length !== 1
        || !Object.prototype.hasOwnProperty.call(metaUpdates[id], 'transition') || metaUpdates[id].transition !== undefined)) return undefined;
    return structuredClone({ kind: 'transition-clear', clipId: clipIds[0], clipIds, config: current.config, registry: current.registry });
  }, [dataRef, resolvedConfig]);

  const handleUpdateClips = useCallback((clipIds: string[], patch: Partial<ClipMeta>) => {
    const current = dataRef.current;
    if (!current) {
      return;
    }

    const validClipIds = getValidClipIds(clipIds);
    if (validClipIds.length === 0) {
      return;
    }

    const metaUpdates = Object.fromEntries(
      validClipIds.map((clipId) => [clipId, patch]),
    ) as Record<string, Partial<ClipMeta>>;

    if (!patchAffectsDuration(patch)) {
      const gestureBasis = transitionClearBasis(metaUpdates);
      applyRowsEdit(current.rows, metaUpdates, undefined, undefined, gestureBasis ? { gestureBasis } : undefined);
      return;
    }

    const validClipIdSet = new Set(validClipIds);
    const nextRows = current.rows.map((row) => ({
      ...row,
      actions: row.actions.map((action) => {
        if (!validClipIdSet.has(action.id)) {
          return action;
        }

        const existing = current.meta[action.id];
        if (!existing) {
          return action;
        }

        return {
          ...action,
          end: recalcActionEnd(action, { ...existing, ...patch }),
        };
      }),
    }));

    applyRowsEdit(nextRows, metaUpdates);
  }, [applyRowsEdit, dataRef, getValidClipIds, transitionClearBasis]);

  const handleUpdateClipsDeep = useCallback((
    clipIds: string[],
    patchFn: (existing: ClipMeta) => Partial<ClipMeta>,
  ) => {
    const current = dataRef.current;
    if (!current) {
      return;
    }

    const validClipIds = getValidClipIds(clipIds);
    if (validClipIds.length === 0) {
      return;
    }

    const metaUpdates: Record<string, Partial<ClipMeta>> = {};

    for (const clipId of validClipIds) {
      const existing = current.meta[clipId];
      if (!existing) {
        continue;
      }

      metaUpdates[clipId] = patchFn(existing);
    }

    if (Object.keys(metaUpdates).length === 0) {
      return;
    }

    const gestureBasis = transitionClearBasis(metaUpdates);
    applyRowsEdit(current.rows, metaUpdates, undefined, undefined, gestureBasis ? { gestureBasis } : undefined);
  }, [applyRowsEdit, dataRef, getValidClipIds, transitionClearBasis]);

  const handleSelectedClipChange = useCallback((patch: Partial<ClipMeta> & { at?: number }, elementOwner?: AgentChatEditorContext | null) => {
    const current = dataRef.current;
    if (!current || !selectedClipId) {
      return;
    }

    const clipRow = current.rows.find((row) => row.actions.some((action) => action.id === selectedClipId));
    if (!clipRow) {
      return;
    }

    let elementBasis: TimelineGestureReadBasis | undefined;
    const selected = current.config.clips.filter(clip => clip.id === selectedClipId);
    if (selected[0]?.elementRef && Object.keys(patch).length === 1 && patch.params) {
      const clip = selected[0];
      const selection = elementOwner?.elementContext?.selectedClips.filter(item => item.id === selectedClipId);
      const same = (left: unknown, right: unknown) => left === undefined || right === undefined
        ? left === right : canonicalJsonStringify(left) === canonicalJsonStringify(right);
      if (selected.length !== 1 || !resolvedConfig || current.resolvedConfig !== resolvedConfig
        || !current.head || !elementOwner?.projectSlug || !elementOwner.timelineId
        || elementOwner.projectId !== current.head.projectId || elementOwner.timelineId !== current.head.timelineId
        || elementOwner.timelineSummary?.configVersion !== current.configVersion
        || selection?.length !== 1 || selection[0].scope !== 'parent-timeline'
        || selection[0].trackId !== clip.track || !same(selection[0].elementRef, clip.elementRef)
        || !same(selection[0].params, clip.params) || findEnclosingPinnedGroup(current.config, clip.id)) {
        toast.error('Element parameter ownership changed or is unavailable; reload the timeline before editing.');
        return;
      }
      elementBasis = { ...structuredClone({ kind: 'element' as const, clipId: selectedClipId, config: current.config, registry: current.registry,
        operation: { name: 'timeline.update_element' as const, project: elementOwner.projectSlug,
          timeline: elementOwner.timelineId, expected_version: current.configVersion, clip_id: selectedClipId, params: patch.params } }),
        context: elementOwner.elementContext! };
    }

    if (elementBasis) {
      applyConfigEdit({ ...resolvedConfig!, clips: resolvedConfig!.clips.map(clip => clip.id === selectedClipId
        ? { ...clip, params: { ...clip.params, ...patch.params } } : clip) }, { gestureBasis: elementBasis });
      return;
    }

    const gestureBasis = transitionClearBasis({ [selectedClipId]: patch }) ?? (resolvedConfig && current.resolvedConfig === resolvedConfig
      && Object.keys(patch).length > 0 && Object.keys(patch).every((key) => ['from', 'to', 'hold', 'speed'].includes(key))
      ? structuredClone({ kind: 'trim' as const, clipId: selectedClipId, patch, config: current.config, registry: current.registry }) : undefined);
    const { at: _at, ...metaPatch } = patch;
    const affectsDuration = patchAffectsDuration(metaPatch);
    const nextRows = current.rows.map((row) => {
      if (row.id !== clipRow.id || (patch.at === undefined && !affectsDuration)) {
        return row;
      }

      return {
        ...row,
        actions: row.actions.map((action) => {
          if (action.id !== selectedClipId) {
            return action;
          }

          const nextStart = patch.at ?? action.start;
          const nextAction = {
            ...action,
            start: nextStart,
            end: patch.at === undefined
              ? action.end
              : nextStart + (action.end - action.start),
          };

          if (!affectsDuration) {
            return nextAction;
          }

          const merged = { ...current.meta[selectedClipId], ...metaPatch };
          return {
            ...nextAction,
            end: recalcActionEnd(nextAction, merged),
          };
        }),
      };
    });

    if (gestureBasis) applyRowsEdit(nextRows, { [selectedClipId]: metaPatch }, undefined, undefined, { gestureBasis });
    else applyRowsEdit(nextRows, { [selectedClipId]: metaPatch });
  }, [applyConfigEdit, applyRowsEdit, dataRef, resolvedConfig, selectedClipId, transitionClearBasis]);

  const clipEditingContext: ClipEditingContext = {
    dataRef,
    resolvedConfig,
    selectedClipId,
    selectedTrack,
    currentTimeRef,
    applyRowsEdit,
    applyConfigEdit,
    isPinnedGroupMember,
    notifyPinnedGroupEditBlocked,
    getValidClipIds,
    selectClip,
    setSelectedTrackId,
  };

  const clipDeletion = useClipDeletion(clipEditingContext);
  const clipPositioning = useClipPositioning(clipEditingContext);
  const clipSplitting = useClipSplitting(clipEditingContext);
  const clipAudioManagement = useClipAudioManagement(clipEditingContext);

  return {
    onOverlayChange,
    handleUpdateClips,
    handleUpdateClipsDeep,
    ...clipDeletion,
    handleSelectedClipChange,
    ...clipPositioning,
    ...clipSplitting,
    ...clipAudioManagement,
  };
}
