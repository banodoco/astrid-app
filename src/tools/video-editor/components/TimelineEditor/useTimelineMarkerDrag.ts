import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  TimelineMarkerChange,
  TimelineOverlayGeometry,
  TimelinePointMarker,
} from '@/sdk/video/families/timelineOverlays';
import { createAutoScroller } from '@/tools/video-editor/lib/auto-scroll.ts';
import { snapToFrameGrid } from '@/tools/video-editor/lib/time-grid.ts';

export const TIMELINE_MARKER_DRAG_THRESHOLD_PX = 4;

interface MarkerDragSession {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startTime: number;
  readonly startScrollLeft: number;
  readonly originalTransform: string;
  readonly controller: AbortController;
  readonly target: HTMLButtonElement;
  lastClientX: number;
  lastClientY: number;
  dragging: boolean;
  claimed: boolean;
  autoScroller: ReturnType<typeof createAutoScroller> | null;
}

export interface UseTimelineMarkerDragArgs<T> {
  marker: TimelinePointMarker<T>;
  geometry: TimelineOverlayGeometry;
  fps: number;
  interactive: boolean;
  snap: boolean;
  getScrollContainer: () => HTMLElement | null;
  claimPointer: () => boolean;
  releasePointer: () => void;
  onChange?: (change: TimelineMarkerChange) => void;
  onDragStateChange?: (markerId: string, dragging: boolean) => void;
}

export interface UseTimelineMarkerDragResult {
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Pointer state machine for one ruler marker.
 *
 * The pointer is intentionally claimed at the activation threshold, not on
 * pointer-down. `claimPointer()` is therefore the ownership re-check for the
 * exact event that turns a click candidate into a drag. All window listeners
 * belong to the session's AbortController and filter by pointer id.
 */
export function useTimelineMarkerDrag<T>({
  marker,
  geometry,
  fps,
  interactive,
  snap,
  getScrollContainer,
  claimPointer,
  releasePointer,
  onChange,
  onDragStateChange,
}: UseTimelineMarkerDragArgs<T>): UseTimelineMarkerDragResult {
  const sessionRef = useRef<MarkerDragSession | null>(null);
  const [dragging, setDragging] = useState(false);
  const latestRef = useRef({
    marker,
    geometry,
    fps,
    interactive,
    snap,
    getScrollContainer,
    claimPointer,
    releasePointer,
    onChange,
    onDragStateChange,
  });
  latestRef.current = {
    marker,
    geometry,
    fps,
    interactive,
    snap,
    getScrollContainer,
    claimPointer,
    releasePointer,
    onChange,
    onDragStateChange,
  };

  const rawTimeFor = useCallback((session: MarkerDragSession, clientX: number): number => {
    const current = latestRef.current;
    const scrollLeft = current.getScrollContainer()?.scrollLeft ?? session.startScrollLeft;
    // Re-derive the original anchor from time on every move. This keeps the
    // drag truthful when zoom changes during a session instead of retaining a
    // stale pixel from the old scale.
    const contentPixel = current.geometry.timeToPixel(session.startTime)
      + (clientX - session.startClientX)
      + (scrollLeft - session.startScrollLeft);
    const raw = current.geometry.pixelToTime(contentPixel);
    const min = Math.min(current.geometry.extentStart, current.geometry.extentEnd);
    const max = Math.max(current.geometry.extentStart, current.geometry.extentEnd);
    return Number.isFinite(raw) ? clamp(raw, min, max) : current.marker.time;
  }, []);

  const finishSession = useCallback((cancelled: boolean, clientX?: number) => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    sessionRef.current = null;

    if (!cancelled && session.dragging) {
      const current = latestRef.current;
      const rawTime = rawTimeFor(
        session,
        Number.isFinite(clientX) ? (clientX as number) : session.lastClientX,
      );
      const committedTime = current.snap ? snapToFrameGrid(rawTime, current.fps) : rawTime;
      // The button is the temporal anchor. Its visual collision offset lives
      // in a child, so this direct preview write must contain only the anchor.
      session.target.style.transform = `translateX(${current.geometry.timeToPixel(committedTime)}px)`;
      current.onChange?.({
        id: current.marker.id,
        time: committedTime,
        phase: 'commit',
      });
    } else {
      // A cancelled drag must not leave a preview transform behind. The
      // visual child (including any collision-column offset) never moves.
      session.target.style.transform = session.originalTransform;
    }

    session.autoScroller?.stop();
    session.controller.abort();
    if (session.claimed) {
      latestRef.current.releasePointer();
      latestRef.current.onDragStateChange?.(latestRef.current.marker.id, false);
    }
    if (typeof session.target.hasPointerCapture === 'function'
      && session.target.hasPointerCapture(session.pointerId)) {
      session.target.releasePointerCapture(session.pointerId);
    }
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    setDragging(false);
  }, [rawTimeFor]);

  const emitPreview = useCallback((session: MarkerDragSession, clientX: number) => {
    const current = latestRef.current;
    const rawTime = rawTimeFor(session, clientX);
    // Keep the immediate preview off the React render path. A controlled
    // consumer may still reflect this value back through `markers`.
    session.target.style.transform = `translateX(${current.geometry.timeToPixel(rawTime)}px)`;
    current.onChange?.({ id: current.marker.id, time: rawTime, phase: 'preview' });
  }, [rawTimeFor]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = latestRef.current;
    if (event.button !== 0 || !current.interactive || current.marker.disabled) {
      return;
    }

    finishSession(true);
    event.stopPropagation();

    const controller = new AbortController();
    const target = event.currentTarget;
    const container = current.getScrollContainer();
    const session: MarkerDragSession = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTime: current.marker.time,
      startScrollLeft: container?.scrollLeft ?? 0,
      originalTransform: target.style.transform,
      controller,
      target,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      dragging: false,
      claimed: false,
      autoScroller: null,
    };
    sessionRef.current = session;

    if (typeof target.setPointerCapture === 'function') {
      try { target.setPointerCapture(event.pointerId); }
      catch (error) {
        // Admission may replay a complete gesture after the native pointer ended.
        // The retained move/up stream still drives this same gesture owner.
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const active = sessionRef.current;
      if (!active || active !== session || moveEvent.pointerId !== active.pointerId) {
        return;
      }
      active.lastClientX = moveEvent.clientX;
      active.lastClientY = moveEvent.clientY;

      if (!active.dragging) {
        const distance = Math.hypot(
          moveEvent.clientX - active.startClientX,
          moveEvent.clientY - active.startClientY,
        );
        if (distance < TIMELINE_MARKER_DRAG_THRESHOLD_PX) {
          return;
        }

        // Ownership may have changed since pointer-down. This synchronous
        // re-check is the only transition into the dragging state.
        if (!latestRef.current.claimPointer()) {
          finishSession(true);
          return;
        }
        active.claimed = true;
        active.dragging = true;
        setDragging(true);
        latestRef.current.onDragStateChange?.(latestRef.current.marker.id, true);
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';

        const activeContainer = latestRef.current.getScrollContainer();
        if (activeContainer) {
          active.autoScroller = createAutoScroller(activeContainer, (clientX) => {
            if (sessionRef.current === active) {
              emitPreview(active, clientX);
            }
          });
        }
      }

      moveEvent.preventDefault();
      active.autoScroller?.update(moveEvent.clientX, moveEvent.clientY);
      emitPreview(active, moveEvent.clientX);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (sessionRef.current !== session || upEvent.pointerId !== session.pointerId) {
        return;
      }
      finishSession(false, upEvent.clientX);
    };

    const handlePointerCancel = (cancelEvent: PointerEvent) => {
      if (sessionRef.current !== session || cancelEvent.pointerId !== session.pointerId) {
        return;
      }
      finishSession(true);
    };

    const handleBlur = () => finishSession(true);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        finishSession(true);
      }
    };

    const signal = controller.signal;
    window.addEventListener('pointermove', handlePointerMove, { signal });
    window.addEventListener('pointerup', handlePointerUp, { signal });
    window.addEventListener('pointercancel', handlePointerCancel, { signal });
    window.addEventListener('blur', handleBlur, { signal });
    document.addEventListener('visibilitychange', handleVisibilityChange, { signal });
  }, [emitPreview, finishSession]);

  useEffect(() => () => finishSession(true), [finishSession]);

  return { dragging, onPointerDown };
}
