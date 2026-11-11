import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ChevronsLeftRight } from 'lucide-react';
import { EDITOR_TOUR_MEDIA } from '../tourMedia';
import { TourMedia } from './TourMedia';
import { useEditorTour } from '@/shared/state/editorTourStore';
import { cn } from '@/shared/components/ui/contracts/cn.ts';

/** Where the divider rests (percent from the left): the middle, so the frame, the still and both labels read. */
export const COMPARE_REST = 50;
/**
 * The sweep starts a beat after the card has come to rest. It is one left-to-right pass in two overlapping parts: the still wipes
 * in across the frame, and the divider follows it in from the left edge to `COMPARE_REST`, bringing the frame back on its side.
 */
export const COMPARE_SWEEP_DELAY_MS = 200;
export const COMPARE_SWEEP_MS = 1700;
/** The wipe's share of the sweep, the width of its soft edge (percent of the picture), and when the divider sets off. */
const WIPE_END = 0.62;
const WIPE_FEATHER = 10;
const DIVIDER_START = 0.3;
/** The act-2 card's entrance: it settles (and reports ready) just after the sweep has come to rest. */
export const TOUR_COMPARE_ENTRANCE_MS = COMPARE_SWEEP_DELAY_MS + COMPARE_SWEEP_MS + 50;
/** A press this close to the divider (px) takes it where it is, so grabbing it never makes it jump. */
const GRAB_SLOP_PX = 18;
const KEY_STEP = 5;
const PAGE_STEP = 20;
/** The divider fades up over the first part of its travel, so it never appears stuck to the left edge. */
const FADE_PORTION = 0.12;
/** The most one animation frame advances the sweep (ms). */
const MAX_FRAME_MS = 100;

const clamp = (value: number) => Math.min(100, Math.max(0, value));
/** cubic-bezier(x1, 0, x2, 1) at progress `t`, solved for x by bisection (plenty for one sweep a tour). */
const bezier = (x1: number, x2: number) => (t: number) => {
  if (t <= 0 || t >= 1) return t <= 0 ? 0 : 1;
  const at = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (at(x1, x2, mid) < t) low = mid;
    else high = mid;
  }
  return at(0, 1, (low + high) / 2);
};
/** A gentle start that gets going soon, and a long, soft landing: cubic-bezier(0.4, 0, 0.2, 1). */
const ease = bezier(0.4, 0.2);

/** Where the arrival is at progress `t` (0–1): the divider, its handle's opacity, and the front of the still's wipe (percent). */
interface Pose { position: number; handle: number; front: number }
const part = (t: number, from: number, to: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));
function poseAt(t: number): Pose {
  return {
    front: (100 + WIPE_FEATHER) * ease(part(t, 0, WIPE_END)),
    position: COMPARE_REST * ease(part(t, DIVIDER_START, 1)),
    handle: part(t, DIVIDER_START, DIVIDER_START + FADE_PORTION),
  };
}
/** The still's soft leading edge while it wipes in; once it has crossed, the still is simply there. */
function wipeMask(front: number | null) {
  if (front === null || front >= 100 + WIPE_FEATHER) return undefined;
  const at = Math.round(front * 100) / 100;
  const mask = `linear-gradient(to right, #000 ${at - WIPE_FEATHER}%, transparent ${at}%)`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * The frame → still comparison: the Three.js frame on the left, the realistic still made from it on the right. As the
 * card arrives the picture is the frame alone; the still wipes in over it from left to right (the frame becomes the still), and
 * the divider follows from the left edge, uncovering the frame again on its side, and rests at `COMPARE_REST`. With the frame on
 * the left, a divider that only travelled right would uncover the frame and tell the story backwards; the wipe ahead of it is
 * what says which came first. From then on it is a slider: drag anywhere along the picture (mouse, pen or touch), or focus the handle and use
 * the arrow keys, Page Up/Down, Home and End. Taking it mid-sweep stops the sweep where it is. Each label is clipped with its
 * own picture, so it only ever names what is under it. Mounted without `sweep` (reduced motion, Back) it rests from the start.
 */
export function TourCompare({ labels: [source, model], sweep, waiting = false }: {
  labels: readonly [string, string];
  sweep: boolean;
  /** The card is still travelling in: the sweep holds at its start and begins as the card comes to rest. */
  waiting?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(sweep ? 0 : COMPARE_REST);
  const [reveal, setReveal] = useState(sweep ? 0 : 1);
  /** While the still wipes in: its front (percent from the left); null once it is simply there. */
  const [front, setFront] = useState<number | null>(sweep ? 0 : null);
  const [dragging, setDragging] = useState(false);
  const positionRef = useRef(position);
  /** Once the user takes the divider the sweep never moves it again. */
  const takenRef = useRef(false);
  const grabRef = useRef<{ pointerId: number; offset: number } | null>(null);

  const moveTo = (next: number) => {
    positionRef.current = next;
    setPosition(next);
  };
  const take = () => {
    takenRef.current = true;
    setReveal(1);
  };

  // The sweep belongs to the card's arrival: it starts as the card comes to rest (mounted with `sweep`), or not at all. Settling on time does not touch it (it has
  // landed by then, or is about to); a skip (Enter, or the runner's bump) finishes it where it would have ended.
  const sweepsRef = useRef(sweep);
  const skipAnimation = useEditorTour((state) => state.skipAnimation);
  const skipAtMount = useRef(skipAnimation);
  useEffect(() => {
    if (skipAnimation === skipAtMount.current || !sweepsRef.current) return;
    sweepsRef.current = false;
    setFront(null);
    if (takenRef.current) return;
    moveTo(COMPARE_REST);
    setReveal(1);
  }, [skipAnimation]);

  useEffect(() => {
    if (waiting || !sweepsRef.current) return;
    let frame = 0;
    let last: number | null = null;
    let elapsed = 0;
    const tick = (now: number) => {
      if (!sweepsRef.current) return;
      // A long frame (the editor busy loading) slows the sweep down rather than letting it skip ahead.
      elapsed += last === null ? 0 : Math.min(now - last, MAX_FRAME_MS);
      last = now;
      const t = Math.min(1, Math.max(0, (elapsed - COMPARE_SWEEP_DELAY_MS) / COMPARE_SWEEP_MS));
      const pose = poseAt(t);
      // Once taken, the divider is the user's; the wipe still finishes, so the picture never snaps.
      if (!takenRef.current) {
        moveTo(pose.position);
        setReveal(pose.handle);
      }
      setFront(t < WIPE_END ? pose.front : null);
      if (t < (takenRef.current ? WIPE_END : 1)) frame = requestAnimationFrame(tick);
      else sweepsRef.current = false;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [waiting]);

  const percentAt = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    return box && box.width > 0 ? clamp(((clientX - box.left) / box.width) * 100) : positionRef.current;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // No focus moves to the handle (ArrowLeft stays Back for a mouse user), and nothing is selected or dragged as an image.
    event.preventDefault();
    take();
    const box = boxRef.current?.getBoundingClientRect();
    const at = percentAt(event.clientX);
    const dividerX = box ? box.left + (positionRef.current / 100) * box.width : event.clientX;
    const offset = Math.abs(event.clientX - dividerX) <= GRAB_SLOP_PX ? positionRef.current - at : 0;
    grabRef.current = { pointerId: event.pointerId, offset };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    moveTo(clamp(at + offset));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const grab = grabRef.current;
    if (!grab || grab.pointerId !== event.pointerId) return;
    moveTo(clamp(percentAt(event.clientX) + grab.offset));
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (grabRef.current?.pointerId !== event.pointerId) return;
    grabRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = positionRef.current;
    const next = ({
      ArrowLeft: current - KEY_STEP, ArrowDown: current - KEY_STEP,
      ArrowRight: current + KEY_STEP, ArrowUp: current + KEY_STEP,
      PageDown: current - PAGE_STEP, PageUp: current + PAGE_STEP,
      Home: 0, End: 100,
    } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    take();
    moveTo(clamp(Math.round(next)));
  };

  const value = Math.round(position);
  return (
    <div
      ref={boxRef}
      data-tour-compare
      data-dragging={dragging || undefined}
      className="absolute inset-0 cursor-col-resize touch-pan-y select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onDragStart={(event) => event.preventDefault()}
    >
      <div className="absolute inset-0" aria-hidden="true">
        <TourMedia slot={EDITOR_TOUR_MEDIA.frames[0]} kind="frame" />
        <Chip className="left-2">{source}</Chip>
      </div>
      <div
        data-tour-compare-still
        className="absolute inset-0"
        style={{ clipPath: `inset(0 0 0 ${position}%)`, ...wipeMask(front) }}
        aria-hidden="true"
      >
        <TourMedia slot={EDITOR_TOUR_MEDIA.stills[0]} kind="still" />
        <Chip className="right-2">{model}</Chip>
      </div>
      <div
        data-tour-compare-divider
        className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-white/85 shadow-[0_0_0_0.5px_rgba(0,0,0,0.2)]"
        style={{ left: `${position}%`, opacity: reveal }}
      />
      <div
        role="slider"
        tabIndex={0}
        aria-label={`Compare the ${source.toLowerCase()} (left) with ${model} (right)`}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${source} ${value}%, ${model} ${100 - value}%`}
        // The tour's own keys (Enter, Esc) still reach the tour; this handle keeps the arrows, Page Up/Down, Home and End.
        data-editor-tour-keys="own"
        onKeyDown={onKeyDown}
        className={cn(
          'absolute top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md ring-1 ring-black/10',
          'transition-transform duration-150 ease-out hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          dragging && 'scale-110',
        )}
        // The handle stays whole at either end, while the line itself goes all the way.
        style={{ left: `clamp(14px, ${position}%, calc(100% - 14px))`, opacity: reveal }}
      >
        <ChevronsLeftRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      </div>
    </div>
  );
}

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={cn('absolute bottom-2 whitespace-nowrap rounded bg-background/80 px-1.5 py-0.5 text-[10px] leading-none text-foreground backdrop-blur-sm', className)}>
      {children}
    </span>
  );
}
