import { useEffect, useMemo, useRef, useState } from 'react';
import { CENTISECOND_TIME_OPTIONS, formatTime } from '@/shared/lib/timeFormatting';
import { useTimelineScale } from '@/tools/video-editor/hooks/useTimelineScale.ts';
import type { TimelineGestureOwner, TimelineInputModality } from '@/tools/video-editor/lib/mobile-interaction-model.ts';

const POINTER_DRAG_THRESHOLD_PX = 3;
const OVERSCAN_STEPS = 4;

export interface TimeRulerProps {
  scale: number;
  scaleWidth: number;
  scaleSplitCount: number;
  startLeft: number;
  scrollLeft: number;
  totalWidth: number;
  gestureOwner: TimelineGestureOwner;
  onClickTimeArea: (time: number) => void;
  onCursorDrag: (time: number) => void;
  setGestureOwner: (owner: TimelineGestureOwner) => void;
  setInputModalityFromPointerType: (pointerType: string | null | undefined) => TimelineInputModality;
  /** Label major ticks as `m:ss` (touch) instead of `m:ss.cc`. */
  compactLabels?: boolean;
}

interface PointerSession {
  pointerId: number;
  startClientX: number;
  isDragging: boolean;
  claimedOwnership: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function TimeRuler({
  scale,
  scaleWidth,
  scaleSplitCount,
  startLeft,
  scrollLeft,
  totalWidth,
  gestureOwner,
  onClickTimeArea,
  onCursorDrag,
  setGestureOwner,
  setInputModalityFromPointerType,
  compactLabels = false,
}: TimeRulerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pointerSessionRef = useRef<PointerSession | null>(null);
  const gestureOwnerRef = useRef(gestureOwner);
  gestureOwnerRef.current = gestureOwner;
  const [viewportWidth, setViewportWidth] = useState(0);

  const safeSplitCount = Math.max(1, scaleSplitCount);
  const contentWidth = Math.max(totalWidth, startLeft + scaleWidth);
  const { pixelsPerSecond, pixelToTime } = useTimelineScale({ scale, scaleWidth, startLeft });
  const minorStepWidth = scaleWidth / safeSplitCount;
  const maxTime = Math.max(0, pixelToTime(contentWidth));

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return undefined;
    }

    const updateWidth = () => setViewportWidth(element.clientWidth);
    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const visibleRange = useMemo(() => {
    // Before layout measures the viewport, mount one division rather than all
    // ticks in a potentially hours-long timeline. The measured window follows.
    const viewWidth = viewportWidth || Math.min(contentWidth, scaleWidth);
    const visibleLeft = Math.max(0, scrollLeft);
    const visibleRight = Math.min(contentWidth, visibleLeft + viewWidth);
    const firstMinorIndex = Math.max(
      0,
      Math.floor((visibleLeft - startLeft) / minorStepWidth) - OVERSCAN_STEPS,
    );
    const lastMinorIndex = Math.max(
      firstMinorIndex,
      Math.ceil((visibleRight - startLeft) / minorStepWidth) + OVERSCAN_STEPS,
    );

    return { firstMinorIndex, lastMinorIndex };
  }, [contentWidth, minorStepWidth, scaleWidth, scrollLeft, startLeft, viewportWidth]);

  const majorTicks = useMemo(() => {
    const firstMajorIndex = Math.floor(visibleRange.firstMinorIndex / safeSplitCount);
    const lastMajorIndex = Math.ceil(visibleRange.lastMinorIndex / safeSplitCount);
    const ticks: Array<{ key: string; left: number; label: string | null }> = [];

    for (let index = firstMajorIndex; index <= lastMajorIndex; index += 1) {
      const left = startLeft + index * scaleWidth;
      if (left > contentWidth) {
        break;
      }

      ticks.push({
        key: `major-${index}`,
        left,
        label: compactLabels ? formatTime(index * scale) : formatTime(index * scale, CENTISECOND_TIME_OPTIONS),
      });
    }

    return ticks;
  }, [compactLabels, contentWidth, safeSplitCount, scale, scaleWidth, startLeft, visibleRange.firstMinorIndex, visibleRange.lastMinorIndex]);

  const minorTicks = useMemo(() => {
    const ticks: Array<{ key: string; left: number; isMajor: boolean }> = [];

    for (let index = visibleRange.firstMinorIndex; index <= visibleRange.lastMinorIndex; index += 1) {
      const left = startLeft + index * minorStepWidth;
      if (left < startLeft || left > contentWidth) {
        continue;
      }

      ticks.push({
        key: `minor-${index}`,
        left,
        isMajor: index % safeSplitCount === 0,
      });
    }

    return ticks;
  }, [contentWidth, minorStepWidth, safeSplitCount, startLeft, visibleRange.firstMinorIndex, visibleRange.lastMinorIndex]);

  const clientXToTime = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return 0;
    }

    const relativeX = clientX - rect.left + scrollLeft;
    return clamp(pixelToTime(relativeX), 0, maxTime);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    if (gestureOwnerRef.current !== 'none' && gestureOwnerRef.current !== 'ruler') {
      return;
    }

    setInputModalityFromPointerType(event.pointerType);
    pointerSessionRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      isDragging: false,
      claimedOwnership: true,
    };
    setGestureOwner('ruler');
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch (error) {
      // Admission may replay a complete gesture after the native pointer ended.
      // The retained move/up stream still drives this same gesture owner.
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    if (!session.isDragging && Math.abs(event.clientX - session.startClientX) >= POINTER_DRAG_THRESHOLD_PX) {
      session.isDragging = true;
    }

    if (!session.isDragging) {
      return;
    }

    onCursorDrag(clientXToTime(event.clientX));
  };

  const finishPointerSession = (
    event: React.PointerEvent<HTMLDivElement>,
    cancelled: boolean,
  ) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    pointerSessionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (session.claimedOwnership) {
      setGestureOwner('none');
    }

    if (cancelled) {
      return;
    }

    onClickTimeArea(clientXToTime(event.clientX));
  };

  return (
    <div
      ref={containerRef}
      data-testid="timeline-ruler"
      className="relative h-[30px] overflow-hidden border-b border-border bg-card/80 select-none"
    >
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: contentWidth,
          transform: `translateX(${-scrollLeft}px)`,
        }}
      >
        <div
          className="absolute inset-y-0 left-0 border-r border-border/70 bg-card/90"
          style={{ width: startLeft }}
        />

        {minorTicks.map((tick) => (
          <div
            key={tick.key}
            className={tick.isMajor ? 'absolute bottom-0 w-px bg-border/80' : 'absolute bottom-0 w-px bg-border/35'}
            style={{
              left: tick.left,
              height: tick.isMajor ? '100%' : '45%',
            }}
          />
        ))}
      </div>

      {/* The time labels get their own scrolled layer above the extension ruler overlay (`z-20` in
          `TimelineCanvas`), so a marker diamond can never cover a label's text. That overlay's root also
          holds the layer legend and pager in the label column (`z-40`), and both share the canvas's
          stacking context: the wrapper clips the labels to the timeline area (x >= startLeft) so a
          scrolled label never paints over the gutter. */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-30 overflow-hidden"
        style={{ left: startLeft }}
      >
        <div
          data-testid="timeline-ruler-labels"
          className="absolute inset-y-0 left-0"
          style={{
            width: contentWidth,
            transform: `translateX(${-(scrollLeft + startLeft)}px)`,
          }}
        >
          {majorTicks.map((tick) => (
            tick.label === null ? null : (
              <div
                key={tick.key}
                className="absolute left-0 top-0"
                style={{
                  transform: `translateX(${tick.left + 6}px)`,
                }}
              >
                <span className="rounded-sm bg-card/85 px-1 py-0.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                  {tick.label}
                </span>
              </div>
            )
          ))}
        </div>
      </div>

      <div
        className="absolute inset-0 cursor-pointer touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointerSession(event, false)}
        onPointerCancel={(event) => finishPointerSession(event, true)}
      />
    </div>
  );
}
