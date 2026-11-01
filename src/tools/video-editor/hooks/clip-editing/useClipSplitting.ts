import { useCallback } from 'react';
import { splitClipAtPlayhead } from '@/tools/video-editor/lib/editor-utils.ts';
import { splitIntersectingClipsAtPlayhead } from '@/tools/video-editor/lib/clip-editing-utils.ts';
import { withAuthoredClipLabels } from '@/tools/video-editor/lib/serialize.ts';
import type { ClipEditingContext } from './types.ts';

export function useClipSplitting(ctx: ClipEditingContext) {
  const {
    applyConfigEdit,
    dataRef,
    resolvedConfig,
    selectedClipId,
    currentTimeRef,
    getValidClipIds,
    isPinnedGroupMember,
    notifyPinnedGroupEditBlocked,
  } = ctx;

  const handleSplitSelectedClip = useCallback(() => {
    if (!selectedClipId || !resolvedConfig) {
      return;
    }

    if (isPinnedGroupMember(selectedClipId)) {
      notifyPinnedGroupEditBlocked();
      return;
    }

    const current = dataRef.current;
    const gestureBasis = current?.resolvedConfig === resolvedConfig ? structuredClone({
      kind: 'split' as const, clipId: selectedClipId, timeSeconds: currentTimeRef.current,
      config: current.config, registry: current.registry,
    }) : undefined;
    const authored = current ? withAuthoredClipLabels(resolvedConfig, current.config) : resolvedConfig;
    const splitResult = splitClipAtPlayhead(authored, selectedClipId, currentTimeRef.current);
    if (!splitResult.nextSelectedClipId) {
      return;
    }

    applyConfigEdit(splitResult.config, { selectedClipId: splitResult.nextSelectedClipId, gestureBasis });
  }, [applyConfigEdit, dataRef, isPinnedGroupMember, notifyPinnedGroupEditBlocked, resolvedConfig, selectedClipId]);

  const handleSplitClipAtTime = useCallback((clipId: string, timeSeconds: number) => {
    if (!resolvedConfig) {
      return;
    }

    if (isPinnedGroupMember(clipId)) {
      notifyPinnedGroupEditBlocked();
      return;
    }

    const current = dataRef.current;
    const gestureBasis = current?.resolvedConfig === resolvedConfig ? structuredClone({
      kind: 'split' as const, clipId, timeSeconds, config: current.config, registry: current.registry,
    }) : undefined;
    const authored = current ? withAuthoredClipLabels(resolvedConfig, current.config) : resolvedConfig;
    const splitResult = splitClipAtPlayhead(authored, clipId, timeSeconds);
    if (!splitResult.nextSelectedClipId) {
      return;
    }

    applyConfigEdit(splitResult.config, { selectedClipId: splitResult.nextSelectedClipId, gestureBasis });
  }, [applyConfigEdit, dataRef, isPinnedGroupMember, notifyPinnedGroupEditBlocked, resolvedConfig]);

  const handleSplitClipsAtPlayhead = useCallback((clipIds: string[]) => {
    const current = dataRef.current;
    if (!current || !resolvedConfig) {
      return;
    }

    const validClipIds = getValidClipIds(clipIds);
    if (validClipIds.length === 0) {
      return;
    }

    if (validClipIds.some((clipId) => isPinnedGroupMember(clipId))) {
      notifyPinnedGroupEditBlocked();
      return;
    }

    const { config: nextResolvedConfig, didSplit } = splitIntersectingClipsAtPlayhead(
      withAuthoredClipLabels(resolvedConfig, current.config),
      current.rows,
      validClipIds,
      currentTimeRef.current,
    );
    if (!didSplit) {
      return;
    }

    applyConfigEdit(nextResolvedConfig);
  }, [applyConfigEdit, dataRef, getValidClipIds, isPinnedGroupMember, notifyPinnedGroupEditBlocked, resolvedConfig]);

  return { handleSplitSelectedClip, handleSplitClipAtTime, handleSplitClipsAtPlayhead };
}
