export type ResizeDir = 'left' | 'right';

export interface ResizeRange {
  start: number;
  end: number;
}

const MIN_CLIP_EDGE_RESIZE_DURATION = 0.05;

interface GroupEdgeResizeArgs {
  dir: ResizeDir;
  initial: ResizeRange;
  proposedBoundary: number;
  minimumDuration: number;
  minimumStart?: number;
}

interface GroupEdgeResizeResult extends ResizeRange {
  boundary: number;
  wasClamped: boolean;
}

export interface ClipEdgeResizeUpdate extends ResizeRange {
  clipId: string;
}

export interface FreeClipEdgeResizeContext {
  kind: 'free';
  clipId: string;
  initialStart: number;
  initialEnd: number;
  minStart?: number;
  maxEnd?: number;
}

export interface GroupClipEdgeResizeContext {
  kind: 'group';
  shotId: string;
  /** Set for a canonical shot occurrence: dragging its own block edge trims the shot (`occurrence.trim`). */
  occurrenceId?: string;
  trackId: string;
  draggedClipId: string;
  draggedIndex: number;
  groupClipIds: string[];
  groupChildrenSnapshot: ClipEdgeResizeUpdate[];
  /** Optional hard end for the enclosing shot-local timeline. */
  hardDurationSeconds?: number;
}

export type ClipEdgeResizeContext =
  | FreeClipEdgeResizeContext
  | GroupClipEdgeResizeContext;

export interface ApplyClipEdgeMoveResult {
  updates: ClipEdgeResizeUpdate[];
  wasClamped: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function computeGroupEdgeResize({
  dir,
  initial,
  proposedBoundary,
  minimumDuration,
  minimumStart = 0,
}: GroupEdgeResizeArgs): GroupEdgeResizeResult {
  const boundary = dir === 'left'
    ? clamp(proposedBoundary, minimumStart, initial.end - minimumDuration)
    : Math.max(initial.start + minimumDuration, proposedBoundary);

  return {
    boundary,
    wasClamped: boundary !== proposedBoundary,
    start: dir === 'left' ? boundary : initial.start,
    end: dir === 'right' ? boundary : initial.end,
  };
}

export function snapBoundaryToSiblings(
  boundaryTime: number,
  siblingTimes: number[],
  thresholdSeconds: number,
): number {
  if (thresholdSeconds < 0) {
    return boundaryTime;
  }

  let snappedBoundary = boundaryTime;
  let closestDistance = thresholdSeconds;

  for (const siblingTime of siblingTimes) {
    const distance = Math.abs(boundaryTime - siblingTime);
    if (distance < closestDistance) {
      closestDistance = distance;
      snappedBoundary = siblingTime;
    }
  }

  return snappedBoundary;
}

const applyFreeClipEdgeMove = (
  context: FreeClipEdgeResizeContext,
  edge: ResizeDir,
  newBoundaryTime: number,
): ApplyClipEdgeMoveResult => {
  if (edge === 'left') {
    const resized = computeGroupEdgeResize({
      dir: edge,
      initial: { start: context.initialStart, end: context.initialEnd },
      proposedBoundary: newBoundaryTime,
      minimumDuration: MIN_CLIP_EDGE_RESIZE_DURATION,
      minimumStart: context.minStart ?? 0,
    });

    return {
      updates: [{ clipId: context.clipId, start: resized.start, end: resized.end }],
      wasClamped: resized.wasClamped,
    };
  }

  const resized = computeGroupEdgeResize({
    dir: edge,
    initial: { start: context.initialStart, end: context.initialEnd },
    proposedBoundary: newBoundaryTime,
    minimumDuration: MIN_CLIP_EDGE_RESIZE_DURATION,
  });

  let end = resized.end;
  let wasClamped = resized.wasClamped;
  if (typeof context.maxEnd === 'number') {
    const maximumEnd = Math.max(context.initialStart + MIN_CLIP_EDGE_RESIZE_DURATION, context.maxEnd);
    if (end > maximumEnd) {
      end = maximumEnd;
      wasClamped = true;
    }
  }

  return {
    updates: [{ clipId: context.clipId, start: resized.start, end }],
    wasClamped,
  };
};

const applyGroupClipEdgeMove = (
  context: GroupClipEdgeResizeContext,
  edge: ResizeDir,
  newBoundaryTime: number,
): ApplyClipEdgeMoveResult => {
  const children = context.groupChildrenSnapshot;
  if (children.length === 0) {
    return { updates: [], wasClamped: false };
  }

  const draggedIndex = context.draggedIndex;
  const dragged = children[draggedIndex];

  // Clamp so the dragged clip can't collapse below minimum duration
  const trailingDuration = children[children.length - 1].end - dragged.end;
  const hardMaximumBoundary = typeof context.hardDurationSeconds === 'number'
    && Number.isFinite(context.hardDurationSeconds)
    ? context.hardDurationSeconds - trailingDuration
    : undefined;
  const boundary = edge === 'right'
    ? Math.min(
        Math.max(dragged.start + MIN_CLIP_EDGE_RESIZE_DURATION, newBoundaryTime),
        Math.max(dragged.start + MIN_CLIP_EDGE_RESIZE_DURATION, hardMaximumBoundary ?? Number.POSITIVE_INFINITY),
      )
    : Math.min(dragged.end - MIN_CLIP_EDGE_RESIZE_DURATION, newBoundaryTime);

  const wasClamped = boundary !== newBoundaryTime;

  // The old boundary position before the resize
  const oldBoundary = edge === 'right' ? dragged.end : dragged.start;
  const delta = boundary - oldBoundary;

  const updates: ClipEdgeResizeUpdate[] = [];

  if (edge === 'right') {
    // Clips before the dragged clip: unchanged
    for (let i = 0; i < draggedIndex; i++) {
      updates.push({ clipId: children[i].clipId, start: children[i].start, end: children[i].end });
    }
    // Dragged clip: resize right edge
    updates.push({ clipId: dragged.clipId, start: dragged.start, end: boundary });
    // Clips after the dragged clip: shift by delta
    for (let i = draggedIndex + 1; i < children.length; i++) {
      updates.push({
        clipId: children[i].clipId,
        start: children[i].start + delta,
        end: children[i].end + delta,
      });
    }
  } else {
    // Clips before the dragged clip: shift by delta
    for (let i = 0; i < draggedIndex; i++) {
      updates.push({
        clipId: children[i].clipId,
        start: children[i].start + delta,
        end: children[i].end + delta,
      });
    }
    // Dragged clip: resize left edge
    updates.push({ clipId: dragged.clipId, start: boundary, end: dragged.end });
    // Clips after the dragged clip: unchanged
    for (let i = draggedIndex + 1; i < children.length; i++) {
      updates.push({ clipId: children[i].clipId, start: children[i].start, end: children[i].end });
    }
  }

  return { updates, wasClamped };
};

export function applyClipEdgeMove(
  context: ClipEdgeResizeContext,
  edge: ResizeDir,
  newBoundaryTime: number,
): ApplyClipEdgeMoveResult {
  switch (context.kind) {
    case 'free':
      return applyFreeClipEdgeMove(context, edge, newBoundaryTime);
    case 'group':
      return applyGroupClipEdgeMove(context, edge, newBoundaryTime);
  }
}
