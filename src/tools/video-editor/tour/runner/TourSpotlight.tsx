import { useLayoutEffect, useRef, useState } from 'react';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';
import type { SpotlightRect } from './useSpotlightRects';
import { TOUR_MOVE_EASE, TOUR_MOVE_MS } from './useSettledRects';

const MAX_CUTOUTS = 3;
const CORNER_RADIUS = 10;
/** A cutout opens from this far inside its target, and closes the same way, while the dim fades there. */
export const CUTOUT_INSET = 8;

interface Slot {
  /** Where the cutout is (its last target while closed); null until it first opens. */
  rect: SpotlightRect | null;
  open: boolean;
  /** Placed at its opening rect this render, unanimated, ready to open from there next render. */
  placing: boolean;
}

interface TourSpotlightProps {
  rects: readonly SpotlightRect[];
  /** A hole in the input shield (the chat Send button), or null. */
  clickable: SpotlightRect | null;
  reducedMotion: boolean;
  /** False for a jump (first placement, viewport resize): everything goes straight to its place. */
  animate?: boolean;
}

function holePath(r: SpotlightRect, w: number, h: number): string {
  return `path(evenodd, 'M0 0H${w}V${h}H0Z M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}Z')`;
}

export function insetRect(r: SpotlightRect, by = CUTOUT_INSET): SpotlightRect {
  const dx = Math.min(by, r.width / 4);
  const dy = Math.min(by, r.height / 4);
  return { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy };
}

const sameRect = (a: SpotlightRect | null, b: SpotlightRect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/**
 * The slots for a new set of rects. Slot i lights rects[i]: an open slot glides to its next target; a closed one is placed
 * just inside its target (to open there next render, `placing`); a slot that loses its target closes where it is. Nothing
 * ever travels to or from the page's corner. Without animation every slot simply is where it ends.
 */
export function nextSlots(previous: readonly Slot[], rects: readonly SpotlightRect[], animate: boolean): Slot[] {
  return Array.from({ length: MAX_CUTOUTS }, (_, i) => {
    const slot = previous[i] ?? { rect: null, open: false, placing: false };
    const target = rects[i] ?? null;
    if (!animate) return target ? { rect: target, open: true, placing: false } : { rect: slot.rect, open: false, placing: false };
    if (target) return slot.open ? { rect: target, open: true, placing: false } : { rect: insetRect(target), open: false, placing: true };
    return slot.open && slot.rect ? { rect: insetRect(slot.rect), open: false, placing: false } : { ...slot, placing: false };
  });
}

/**
 * Dims everything except the cutouts and eats pointer input everywhere except `clickable`. Cutout slots are fixed in
 * number so each keeps its identity: one that stays lit glides between targets in the shared move, one that is new opens
 * in place (the dim fades out there as it eases out from just inside the target) and one that is no longer needed closes
 * in place. The ring that marks each cutout on a dark page follows its cutout.
 */
export function TourSpotlight({ rects, clickable, reducedMotion, animate = true }: TourSpotlightProps) {
  const moves = animate && !reducedMotion;
  const [slots, setSlots] = useState<Slot[]>(() => nextSlots([], rects, false));
  const [lastRects, setLastRects] = useState(rects);
  const svgRef = useRef<SVGSVGElement>(null);
  if (lastRects !== rects && (lastRects.length !== rects.length || rects.some((r, i) => !sameRect(r, lastRects[i])))) {
    setLastRects(rects);
    setSlots((previous) => nextSlots(previous, rects, moves));
  }

  // A placed slot opens on the very next render: its start rect must reach the page first, in this same frame, so it
  // opens on the frame everything else starts moving.
  useLayoutEffect(() => {
    if (!slots.some((slot) => slot.placing)) return;
    svgRef.current?.querySelectorAll('rect').forEach((element) => getComputedStyle(element).x);
    setSlots((previous) => previous.map((slot, i) => (slot.placing && rects[i] ? { rect: rects[i], open: true, placing: false } : slot)));
  }, [slots, rects]);

  const viewport = typeof window === 'undefined' ? { w: 0, h: 0 } : { w: window.innerWidth, h: window.innerHeight };
  const transitionOf = (slot: Slot) => {
    if (!moves || slot.placing) return 'none';
    return ['x', 'y', 'width', 'height', 'fill-opacity', 'stroke-opacity'].map((property) => `${property} ${TOUR_MOVE_MS}ms ${TOUR_MOVE_EASE}`).join(', ');
  };
  const geometry = (slot: Slot) => ({ x: slot.rect?.x ?? 0, y: slot.rect?.y ?? 0, width: slot.rect?.width ?? 0, height: slot.rect?.height ?? 0 });

  return (
    <div
      aria-hidden
      data-editor-tour-shield
      className="fixed inset-0"
      style={{ zIndex: UI_Z_LAYERS.EDITOR_TOUR_SHIELD, ...(clickable ? { clipPath: holePath(clickable, viewport.w, viewport.h) } : {}) }}
    >
      <svg ref={svgRef} className="absolute inset-0 h-full w-full" style={{ pointerEvents: 'none' }}>
        <defs>
          <mask id="editor-tour-dim">
            <rect width="100%" height="100%" fill="white" />
            {slots.map((slot, i) => (
              <rect
                key={i}
                rx={CORNER_RADIUS}
                fill="black"
                {...geometry(slot)}
                data-open={slot.open || undefined}
                style={{ fillOpacity: slot.open ? 1 : 0, transition: transitionOf(slot) }}
              />
            ))}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgb(0 0 0 / 0.6)" mask="url(#editor-tour-dim)" />
        {/* On a dark page the dimmed edge alone barely shows, so each cutout gets a thin ring there. */}
        {slots.map((slot, i) => (
          <rect
            key={i}
            data-editor-tour-ring
            data-open={slot.open || undefined}
            rx={CORNER_RADIUS}
            {...geometry(slot)}
            className="fill-none stroke-transparent dark:stroke-primary/70"
            strokeWidth={1.5}
            style={{ strokeOpacity: slot.open ? 1 : 0, transition: transitionOf(slot) }}
          />
        ))}
      </svg>
    </div>
  );
}
