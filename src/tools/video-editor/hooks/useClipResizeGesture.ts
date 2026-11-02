import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { ShotGroup } from '@/tools/video-editor/hooks/useShotGroups.ts';
import { notifyInteractionEndIfIdle, notifyInteractionStart } from '@/tools/video-editor/lib/interaction-state.ts';
import type { TimelineGestureOwner, TimelineInputModality } from '@/tools/video-editor/lib/mobile-interaction-model.ts';
import type { ResizeDir } from '@/tools/video-editor/lib/resize-math.ts';
import {
  CLIP_ID_DATASET_KEY,
  RESIZE_EDGE_DATASET_KEY,
  RESIZE_EDGE_SELECTOR,
  ROW_ID_DATASET_KEY,
} from '@/tools/video-editor/lib/timeline-dom.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import type { TimelineAction, TimelineRow } from '@/tools/video-editor/types/timeline-canvas.ts';
import type { ClipEdgeResizeEndTarget, ClipEdgeResizeSession } from '@/tools/video-editor/hooks/useClipResize.ts';
import {
  RESIZE_ACTIVATION_THRESHOLD_PX,
  type ResizeOverride,
} from '@/tools/video-editor/components/TimelineEditor/timeline-canvas-constants.ts';
import {
  clearResizePreview,
  computeResizePreview,
  createResizePreviewStore,
  getPreviewUpdatesFromSnapshot,
  getResizePreviewIds,
  resolveClipEdgeResizeContext,
  updateResize,
  type ResizePreviewStore,
} from '@/tools/video-editor/hooks/useClipResizeGesture.helpers.ts';
import {
  useTimelineEditorDataSafe,
  useTimelineMutableAdaptersSafe,
  useTimelineEditorOpsSafe,
} from '@/tools/video-editor/hooks/timelineStore.ts';

export interface InternalResizeSession extends ClipEdgeResizeSession {
  startClientX: number;
  claimedGestureOwner: boolean;
}

export type ResizeMachineState =
  | { phase: 'idle' }
  | { phase: 'pending'; controller: AbortController; session: InternalResizeSession }
  | { phase: 'resizing'; controller: AbortController; session: InternalResizeSession };

interface UseClipResizeGestureLatest {
  gestureOwner: TimelineGestureOwner;
  setGestureOwner: (owner: TimelineGestureOwner) => void;
  rows: TimelineRow[];
  shotGroups: ShotGroup[];
  onActionResizeStart?: (params: {
    action: TimelineAction;
    row: TimelineRow;
    dir: ResizeDir;
  }) => void;
  onActionResizing?: (params: {
    action: TimelineAction;
    row: TimelineRow;
    start: number;
    end: number;
    dir: ResizeDir;
  }) => void;
  onClipEdgeResizeEnd?: (params: ClipEdgeResizeEndTarget) => void;
  onSelectClips?: (clipIds: string[]) => void;
  interactionStateRef?: import('@/tools/video-editor/lib/interaction-state').InteractionStateRef;
  setInputModalityFromPointerType: (
    pointerType: string | null | undefined,
  ) => TimelineInputModality;
  timeToPixel: (time: number) => number;
  pixelToTime: (pixel: number) => number;
  pixelsPerSecond: number;
  minDuration: number;
  hardDurationSeconds?: number;
}

export interface UseClipResizeGestureArgs extends UseClipResizeGestureLatest {
  timelineWrapperRef: RefObject<HTMLDivElement | null>;
  dataRef: MutableRefObject<TimelineData | null>;
}

export interface UseClipResizeGestureResult {
  resizePreviewSnapshot: Readonly<Record<string, ResizeOverride>>;
  resizeClampedActionId: string | null;
  resizeSessionRef: MutableRefObject<ClipEdgeResizeSession | null>;
}

export const useClipResizeGesture = ({
  timelineWrapperRef,
  dataRef,
  rows,
  shotGroups,
  gestureOwner,
  setGestureOwner,
  onActionResizeStart,
  onActionResizing,
  onClipEdgeResizeEnd,
  onSelectClips,
  interactionStateRef,
  setInputModalityFromPointerType,
  timeToPixel,
  pixelToTime,
  pixelsPerSecond,
  minDuration,
  hardDurationSeconds,
}: UseClipResizeGestureArgs): UseClipResizeGestureResult => {
  const storeData = useTimelineEditorDataSafe();
  const storeOps = useTimelineEditorOpsSafe();
  const storeAdapters = useTimelineMutableAdaptersSafe();
  const effectiveDataRef = storeAdapters?.dataRef ?? dataRef;
  const effectiveInteractionStateRef = storeAdapters?.interactionStateRef ?? interactionStateRef;
  const effectiveGestureOwner = storeData?.gestureOwner ?? gestureOwner;
  const effectiveSetGestureOwner = storeOps?.setGestureOwner ?? setGestureOwner;
  const effectiveSetInputModalityFromPointerType = storeOps?.setInputModalityFromPointerType ?? setInputModalityFromPointerType;
  const resizeSessionRef = useRef<ClipEdgeResizeSession | null>(null);
  const stateRef = useRef<ResizeMachineState>({ phase: 'idle' });
  const resizePreviewStoreRef = useRef<ResizePreviewStore>();
  if (!resizePreviewStoreRef.current) {
    resizePreviewStoreRef.current = createResizePreviewStore();
  }
  const resizePreviewStore = resizePreviewStoreRef.current;
  const resizePreviewSnapshot = useSyncExternalStore(
    resizePreviewStore.subscribe,
    resizePreviewStore.getSnapshot,
    resizePreviewStore.getSnapshot,
  );
  const [resizeClampedActionId, setResizeClampedActionId] = useState<string | null>(null);

  const latestRef = useRef<UseClipResizeGestureLatest>({
    gestureOwner: effectiveGestureOwner,
    setGestureOwner: effectiveSetGestureOwner,
    rows,
    shotGroups,
    onActionResizeStart,
    onActionResizing,
    onClipEdgeResizeEnd,
    onSelectClips,
    interactionStateRef: effectiveInteractionStateRef,
    setInputModalityFromPointerType: effectiveSetInputModalityFromPointerType,
    timeToPixel,
    pixelToTime,
    pixelsPerSecond,
    minDuration,
    hardDurationSeconds,
  });
  latestRef.current = {
    gestureOwner: effectiveGestureOwner,
    setGestureOwner: effectiveSetGestureOwner,
    rows,
    shotGroups,
    onActionResizeStart,
    onActionResizing,
    onClipEdgeResizeEnd,
    onSelectClips,
    interactionStateRef: effectiveInteractionStateRef,
    setInputModalityFromPointerType: effectiveSetInputModalityFromPointerType,
    timeToPixel,
    pixelToTime,
    pixelsPerSecond,
    minDuration,
    hardDurationSeconds,
  };

  useEffect(() => {
    const setState = (nextState: ResizeMachineState) => {
      stateRef.current = nextState;
      resizeSessionRef.current = nextState.phase === 'idle' ? null : nextState.session;
    };

    const getActiveState = (): Extract<ResizeMachineState, { phase: 'pending' | 'resizing' }> | null => {
      const currentState = stateRef.current;
      return currentState.phase === 'idle' ? null : currentState;
    };

    const endSession = ({
      cancelled,
      clientX,
    }: {
      cancelled: boolean;
      clientX?: number;
    }) => {
      const currentState = getActiveState();
      if (!currentState) {
        return;
      }

      currentState.controller.abort();
      const previewIds = getResizePreviewIds(currentState.session);

      if (currentState.phase === 'pending') {
        clearResizePreview(resizePreviewStore, previewIds);
        setResizeClampedActionId(null);
      }

      if (currentState.phase === 'resizing') {
        if (latestRef.current.interactionStateRef) {
          latestRef.current.interactionStateRef.current.resize = false;
          notifyInteractionEndIfIdle(latestRef.current.interactionStateRef);
        }
        const preview = !cancelled && typeof clientX === 'number' && Number.isFinite(clientX)
          ? computeResizePreview(
              currentState.session,
              clientX,
              latestRef.current.pixelToTime,
              latestRef.current.pixelsPerSecond,
              latestRef.current.minDuration,
            ).updates
          : getPreviewUpdatesFromSnapshot(
              currentState.session,
              resizePreviewStore.getSnapshot(),
            );
        latestRef.current.onClipEdgeResizeEnd?.({
          session: currentState.session,
          updates: preview,
          cancelled,
        });
        clearResizePreview(resizePreviewStore, previewIds);
        setResizeClampedActionId(null);
      }

      if (currentState.session.claimedGestureOwner) {
        latestRef.current.setGestureOwner('none');
      }

      setState({ phase: 'idle' });
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const wrapper = timelineWrapperRef.current;
      if (!wrapper || !wrapper.contains(event.target as Node)) {
        return;
      }

      const eventTarget = event.target instanceof HTMLElement ? event.target : null;
      const resizeTarget = eventTarget?.closest<HTMLElement>(RESIZE_EDGE_SELECTOR) ?? null;
      const edge = resizeTarget?.dataset[RESIZE_EDGE_DATASET_KEY];
      const clipId = resizeTarget?.dataset[CLIP_ID_DATASET_KEY];
      const rowId = resizeTarget?.dataset[ROW_ID_DATASET_KEY];
      if (!resizeTarget || !clipId || !rowId || (edge !== 'left' && edge !== 'right')) {
        return;
      }

      latestRef.current.setInputModalityFromPointerType(event.pointerType);
      const resolved = resolveClipEdgeResizeContext(
        latestRef.current.rows,
        latestRef.current.shotGroups,
        resizePreviewStore.getSnapshot(),
        rowId,
        clipId,
        edge,
        effectiveDataRef,
        latestRef.current.hardDurationSeconds,
      );
      if (!resolved) {
        return;
      }

      endSession({ cancelled: true });
      const session: InternalResizeSession = {
        pointerId: event.pointerId,
        rowId,
        clipId,
        edge,
        cursorOffsetPx: event.clientX - latestRef.current.timeToPixel(resolved.initialBoundaryTime),
        initialBoundaryTime: resolved.initialBoundaryTime,
        context: resolved.context,
        siblingTimes: resolved.siblingTimes,
        startClientX: event.clientX,
        claimedGestureOwner: false,
      };
      const controller = new AbortController();
      const signal = controller.signal;
      // Dragging a trim handle must not select text on the page; restored when the session ends.
      const previousBodyUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';
      signal.addEventListener('abort', () => {
        document.body.style.userSelect = previousBodyUserSelect;
      }, { once: true });

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const currentState = getActiveState();
        if (!currentState || moveEvent.pointerId !== currentState.session.pointerId) {
          return;
        }

        if (currentState.phase === 'pending') {
          if (Math.abs(moveEvent.clientX - currentState.session.startClientX) < RESIZE_ACTIVATION_THRESHOLD_PX) {
            return;
          }
          if (latestRef.current.gestureOwner !== 'none' && latestRef.current.gestureOwner !== 'trim') {
            endSession({ cancelled: true });
            return;
          }

          currentState.session.claimedGestureOwner = true;
          latestRef.current.setGestureOwner('trim');
          if (currentState.session.context.kind !== 'group') {
            const row = latestRef.current.rows.find((candidate) => candidate.id === currentState.session.rowId);
            const action = row?.actions.find((candidate) => candidate.id === currentState.session.clipId);
            if (row && action) {
              latestRef.current.onActionResizeStart?.({ action, row, dir: currentState.session.edge });
            }
          }
          if (latestRef.current.interactionStateRef) {
            latestRef.current.interactionStateRef.current.resize = true;
            notifyInteractionStart(latestRef.current.interactionStateRef);
          }
          setState({
            ...currentState,
            phase: 'resizing',
          });
        }

        const resizingState = getActiveState();
        if (!resizingState || resizingState.phase !== 'resizing' || moveEvent.pointerId !== resizingState.session.pointerId) {
          return;
        }

        moveEvent.preventDefault();
        updateResize(
          resizingState.session,
          moveEvent.clientX,
          latestRef.current,
          resizePreviewStore,
          setResizeClampedActionId,
        );
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        const currentState = getActiveState();
        if (!currentState || upEvent.pointerId !== currentState.session.pointerId) {
          return;
        }
        // A trim handle occupies much of a short clip and can be the only
        // exposed mouse target when captions overlap. Treat a press/release
        // that never crossed the resize threshold as selection; an actual
        // resize remains owned by the resizing branch and never selects here.
        if (currentState.phase === 'pending') {
          latestRef.current.onSelectClips?.([currentState.session.clipId]);
        }
        endSession({ cancelled: false, clientX: upEvent.clientX });
      };

      const handlePointerCancel = (cancelEvent: PointerEvent) => {
        const currentState = getActiveState();
        if (!currentState || cancelEvent.pointerId !== currentState.session.pointerId) {
          return;
        }
        endSession({ cancelled: true });
      };

      setResizeClampedActionId(null);
      setState({
        phase: 'pending',
        controller,
        session,
      });
      window.addEventListener('pointermove', handlePointerMove, { signal });
      window.addEventListener('pointerup', handlePointerUp, { signal });
      window.addEventListener('pointercancel', handlePointerCancel, { signal });
    };

    const handleBlur = () => {
      endSession({ cancelled: true });
    };

    const effectController = new AbortController();
    document.addEventListener('pointerdown', handlePointerDown, { signal: effectController.signal });
    window.addEventListener('blur', handleBlur, { signal: effectController.signal });
    return () => {
      endSession({ cancelled: true });
      effectController.abort();
    };
  }, [effectiveDataRef, timelineWrapperRef]);

  return {
    resizePreviewSnapshot,
    resizeClampedActionId,
    resizeSessionRef,
  };
};
