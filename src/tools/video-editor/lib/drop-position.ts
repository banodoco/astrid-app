import type { TimelineRowLayout } from '@/tools/video-editor/lib/timeline-row-layout.ts';
import type { DragEvent as ReactDragEvent, MutableRefObject } from 'react';
import { getDragType } from '@/shared/lib/dnd/dragDrop.ts';
import { rawRowIndexFromY } from '@/tools/video-editor/lib/coordinate-utils.ts';
import { planClipDrag, type ClipDragPlan } from '@/tools/video-editor/lib/clip-drag-planner.ts';
import { createTimelineScale } from '@/tools/video-editor/lib/timeline-scale.ts';
import { planAssetDropTarget } from '@/tools/video-editor/lib/timeline-asset-plans.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import type { TrackKind } from '@/tools/video-editor/types/index.ts';
import type { TimelineEditability } from '@/tools/video-editor/lib/timeline-editability.ts';

const EDGE_SNAP_THRESHOLD_PX = 8;

interface TimelineDomNodes {
  wrapper: HTMLDivElement;
  editArea: HTMLElement | null;
  grid: HTMLElement | null;
}

interface DropScreenCoords {
  rowTop: number;
  rowLeft: number;
  rowWidth: number;
  rowHeight: number;
  clipLeft: number;
  clipWidth: number;
  ghostCenter: number;
}

export interface DropPosition {
  time: number;
  rowIndex: number;
  trackId: string | undefined;
  /** The rendered track directly under the pointer before collision resolution. */
  pointerTrackId?: string;
  trackKind: TrackKind | null;
  trackName: string;
  isNewTrack: boolean;
  /** Whether the new track should be inserted at the top (true) or bottom (false/undefined). */
  isNewTrackTop?: boolean;
  isReject: boolean;
  /** When non-null, dropping here will create a new track of this kind. */
  newTrackKind: TrackKind | null;
  screenCoords: DropScreenCoords;
  /**
   * The underlying planner result that `computeDropPosition` resolved.
   * Carries snap threshold, collision resolution, and other plan-level
   * details so downstream commit paths can consume the same `ClipDragPlan`
   * used by the preview without recomputing snap or track resolution.
   */
  plan?: ClipDragPlan;
}

export interface ComputeDropPositionParams {
  clientX: number;
  clientY: number;
  wrapper: HTMLDivElement;
  dataRef: MutableRefObject<TimelineData | null>;
  scale: number;
  scaleWidth: number;
  startLeft: number;
  rowHeight: number;
  sourceKind?: TrackKind | null;
  clipDuration?: number;
  clipOffsetX?: number;
  excludeClipIds?: Set<string>;
  editability?: TimelineEditability;
  clipId?: string;
  /** Use the managed image asset planner used by the single-image import commit. */
  managedImage?: boolean;
}

interface PublishedRowLayout { layout: TimelineRowLayout; data: TimelineData | null }
const timelineRowLayouts = new WeakMap<HTMLElement, PublishedRowLayout>();
/** Ephemeral committed geometry; canonical tracks/config remain the authority. */
export function publishTimelineRowLayout(node: HTMLElement, layout: TimelineRowLayout, data: TimelineData | null): () => void {
  const publication = { layout, data };
  timelineRowLayouts.set(node, publication);
  return () => { if (timelineRowLayouts.get(node) === publication) timelineRowLayouts.delete(node); };
}
export function getPublishedTimelineRowLayout(node: HTMLElement | null, data: TimelineData | null): TimelineRowLayout | null {
  const publication = node ? timelineRowLayouts.get(node) : undefined;
  return publication?.data === data ? publication.layout : null;
}
export function isInvalidTimelineRowTarget(reason: string | null | undefined): boolean {
  return reason === 'data_lane_target' || reason === 'timeline_layout_unavailable';
}

const timelineDomNodeCache = new WeakMap<HTMLDivElement, Omit<TimelineDomNodes, 'wrapper'>>();
const isValidNode = (wrapper: HTMLDivElement, node: HTMLElement | null): boolean => {
  return node === null || (node.isConnected && wrapper.contains(node));
};
export const getTimelineDomNodes = (wrapper: HTMLDivElement): TimelineDomNodes => {
  const cached = timelineDomNodeCache.get(wrapper);
  if (
    cached
    && isValidNode(wrapper, cached.editArea)
    && isValidNode(wrapper, cached.grid)
  ) {
    return { wrapper, ...cached };
  }

  const editArea = wrapper.querySelector<HTMLElement>('.timeline-canvas-edit-area');
  // In TimelineCanvas the edit area IS the scroll container (grid).
  const grid = editArea;
  const nextNodes = { editArea, grid };
  timelineDomNodeCache.set(wrapper, nextNodes);
  return { wrapper, ...nextNodes };
};

export const computeDropPosition = ({
  clientX,
  clientY,
  wrapper,
  dataRef,
  scale,
  scaleWidth,
  startLeft,
  rowHeight,
  sourceKind = null,
  clipDuration = 5,
  clipOffsetX,
    excludeClipIds,
  editability,
  clipId = '__drop-preview__',
  managedImage = false,
}: ComputeDropPositionParams): DropPosition => {
  const current = dataRef.current;
  const { editArea, grid } = getTimelineDomNodes(wrapper);
  const wrapperRect = wrapper.getBoundingClientRect();
  const editRect = (editArea ?? wrapper).getBoundingClientRect();
  const scrollLeft = grid?.scrollLeft ?? 0;
  const scrollTop = grid?.scrollTop ?? 0;
  const { pixelsPerSecond, pixelToTime, timeToPixel } = createTimelineScale({ scale, scaleWidth, startLeft });
  const effectiveOffsetX = clipOffsetX ?? (clipDuration * pixelsPerSecond) / 2;
  const leftInGrid = clientX - editRect.left + scrollLeft - effectiveOffsetX;
  const time = Math.max(0, pixelToTime(leftInGrid));

  // Geometry is published from the rendered track order. Keep the planner's
  // row actions in that same order when a mutable row snapshot lags a track
  // projection; otherwise a hit on the first rendered track can inherit the
  // owner of a differently indexed row. A partial or unknown row snapshot is
  // invalid rather than an empty actionable target.
  const trackIds = new Set(current?.tracks.map((track) => track.id) ?? []);
  const rowIds = new Set(current?.rows.map((row) => row.id) ?? []);
  const hasInvalidRowOwnership = current !== null && (
    current.rows.length !== current.tracks.length
    || rowIds.size !== current.rows.length
    || current.tracks.some((track) => !rowIds.has(track.id))
    || current.rows.some((row) => !trackIds.has(row.id))
  );
  const plannerRows = current
    ? current.tracks.flatMap((track) => {
        const row = current.rows.find((candidate) => candidate.id === track.id);
        return row ? [row] : [];
      })
    : [];
  const rowCount = current?.tracks.length ?? 0;
  const layout = getPublishedTimelineRowLayout(editArea, current);
  const requiresLayout = editArea?.dataset.timelineRowLayout === 'managed';
  const relativeY = clientY - editRect.top + scrollTop;
  const visualRow = layout?.rows.find(row => relativeY >= row.top && relativeY < row.top + row.height);
  const invalidTarget = requiresLayout && !layout ? 'timeline_layout_unavailable'
    : visualRow?.kind === 'dataLane' ? 'data_lane_target'
    : hasInvalidRowOwnership ? 'timeline_layout_unavailable' : null;
  const rawRowIndex = layout
    ? (relativeY < 0 ? -1 : visualRow?.mediaRowIndex ?? rowCount)
    : rawRowIndexFromY(clientY, editRect.top, scrollTop, rowHeight);
  const isNewTrackBottom = layout ? relativeY >= layout.totalHeight : rowCount === 0 || rawRowIndex >= rowCount;
  // Only show top drop zone when fully scrolled up — otherwise auto-scroll handles it
  const isNewTrackTop = rawRowIndex < 0 && rowCount > 0 && scrollTop < 2;
  const requestedNewTrackPlacement = isNewTrackTop ? 'top' : isNewTrackBottom ? 'bottom' : null;
  const computedPlan = planClipDrag({
    pointerTime: time,
    clipDuration,
    clipId,
    excludeClipIds,
    sourceKind: sourceKind ?? 'visual',
    tracks: current?.tracks ?? [],
    rows: plannerRows,
    pointerRowIndex: rawRowIndex,
    pixelSnapThreshold: EDGE_SNAP_THRESHOLD_PX,
    pixelsPerSecond,
    requestedNewTrackPlacement,
    editability,
  });
  const plan: ClipDragPlan = invalidTarget ? {
    ...computedPlan, valid: false, rejectReason: invalidTarget, invalidReason: invalidTarget,
    targetTrackId: null, needsNewTrack: false, newTrackPlacement: null,
  } : computedPlan;
  const pointerTrack = visualRow?.kind === 'track'
    ? current?.tracks.find((track) => track.id === visualRow.id)
    : layout
      ? undefined
      : rawRowIndex >= 0 && rawRowIndex < plannerRows.length
        ? current?.tracks.find((track) => track.id === plannerRows[rawRowIndex]?.id)
        : undefined;
  // A Runtime-backed single image has no authoritative media identity until
  // drop, but its duration and placement semantics are already owned by the
  // existing managed-media planner. Use that planner against the rendered
  // pointer track so hover and the eventual prepared-media command settle on
  // the same target. Other drops retain the generic drag planner above.
  const managedPlacement = !invalidTarget && managedImage && current && pointerTrack?.kind === 'visual'
    ? planAssetDropTarget({
        current,
        assetKind: 'visual',
        trackId: pointerTrack.id,
        selectedTrackId: pointerTrack.id,
        time,
        duration: clipDuration,
      })
    : null;
  const resolvedPlan: ClipDragPlan = managedPlacement?.ok
    ? {
        ...plan,
        resolvedStart: managedPlacement.snappedTime ?? time,
        targetTrackId: managedPlacement.trackId,
        targetRowIndex: current?.tracks.findIndex((track) => track.id === managedPlacement.trackId) ?? -1,
        trackKind: 'visual',
        needsNewTrack: false,
        newTrackPlacement: null,
        snapped: managedPlacement.snappedTime !== undefined,
        snapEdgeType: managedPlacement.snappedTime !== undefined ? 'sibling-end' : 'none',
      }
    : plan;
  const rowIndex = resolvedPlan.targetRowIndex;
  const visualRowIndex = rowCount > 0 ? Math.min(rowIndex, rowCount - 1) : -1;
  const targetTrack = rowIndex >= 0 && rowIndex < (current?.tracks.length ?? 0)
    ? current?.tracks[rowIndex]
    : undefined;
  const rowTop = visualRowIndex >= 0
    ? editRect.top + (layout?.trackRects.get(current?.tracks[visualRowIndex]?.id ?? '')?.top ?? visualRowIndex * rowHeight) - scrollTop
    : editRect.top;
  // Viewport-aware long-clip ghost clipping using true rectangle math.
  // trueLeft / trueRight = the full clip extent in screen pixels (may extend
  // beyond the visible viewport). The ghost visual is clamped to the visible
  // viewport; the line/label anchors to trueLeft so the time label stays
  // accurate when the ghost rectangle is clipped offscreen.
  const trueLeft = editRect.left + timeToPixel(resolvedPlan.resolvedStart) - scrollLeft;
  const trueRight = trueLeft + clipDuration * pixelsPerSecond;
  const visibleLeft = editRect.left;
  const visibleRight = editRect.right;
  const intersects = trueLeft < visibleRight && trueRight > visibleLeft;

  let ghostLeft: number;
  let ghostWidth: number;
  if (intersects) {
    ghostLeft = Math.max(trueLeft, visibleLeft);
    ghostWidth = Math.min(trueRight, visibleRight) - ghostLeft;
  } else {
    ghostLeft = visibleLeft;
    ghostWidth = 0;
  }

  // Line/label anchors to the planned start (trueLeft), not the ghost center.
  const clipLeft = ghostLeft;
  const clipWidth = ghostWidth;
  const ghostCenter = trueLeft;

  const resolvedTrack = resolvedPlan.targetTrackId
    ? current?.tracks.find((track) => track.id === resolvedPlan.targetTrackId) ?? targetTrack
    : undefined;
  const resolvedTrackName = resolvedTrack?.label ?? resolvedTrack?.id ?? '';
  const finalRowTop = layout && resolvedPlan.needsNewTrack
    ? editRect.top + (resolvedPlan.newTrackPlacement === 'bottom' ? layout.totalHeight : 0) - scrollTop
    : rowIndex >= 0 && rowIndex < rowCount
    ? editRect.top + (layout?.trackRects.get(current?.tracks[rowIndex]?.id ?? '')?.top ?? rowIndex * rowHeight) - scrollTop
    : rowTop;
  const finalClipLeft = clipLeft;
  const finalClipWidth = clipWidth;
  const finalGhostCenter = ghostCenter;

  return {
    time: resolvedPlan.resolvedStart,
    rowIndex,
    trackId: resolvedPlan.targetTrackId ?? undefined,
    ...(invalidTarget || !pointerTrack || pointerTrack.kind !== (sourceKind ?? 'visual')
      ? {}
      : { pointerTrackId: pointerTrack.id }),
    trackKind: resolvedPlan.needsNewTrack ? (sourceKind ?? resolvedPlan.trackKind) : resolvedPlan.trackKind,
    trackName: resolvedTrackName,
    isNewTrack: resolvedPlan.needsNewTrack,
    isNewTrackTop: resolvedPlan.needsNewTrack && resolvedPlan.newTrackPlacement === 'top',
    isReject: resolvedPlan.rejectReason !== null,
    newTrackKind: resolvedPlan.needsNewTrack ? resolvedPlan.trackKind : null,
    screenCoords: {
      rowTop: finalRowTop,
      rowLeft: wrapperRect.left,
      rowWidth: wrapperRect.width,
      rowHeight,
      clipLeft: finalClipLeft,
      clipWidth: finalClipWidth,
      ghostCenter: finalGhostCenter,
    },
    plan: resolvedPlan,
  };
};

export const inferDragKind = (event: ReactDragEvent<HTMLDivElement>): TrackKind | null => {
  const types = Array.from(event.dataTransfer.types);
  if (types.includes('asset-kind:audio')) return 'audio';
  if (types.includes('asset-kind:visual')) return 'visual';
  if (types.includes('asset-key')) return null;
  if (getDragType(event) === 'generation') return 'visual';
  if (event.dataTransfer.items.length > 0) {
    for (const item of Array.from(event.dataTransfer.items)) {
      if (item.type.startsWith('audio/')) {
        return 'audio';
      }
    }
    return 'visual';
  }
  return null;
};
