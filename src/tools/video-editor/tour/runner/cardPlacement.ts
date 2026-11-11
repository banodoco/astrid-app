import type { SpotlightRect } from './useSpotlightRects';

const GAP = 16;
const EDGE = 16;

export interface CardPosition {
  left: number;
  top: number;
}

export interface CardPlacementOptions {
  /** Space kept between the card and the viewport's edges. */
  edge?: number;
  /** Space kept between the card and the spotlit area it sits beside. */
  gap?: number;
  /** Take the spot below the spotlit area whenever it fits, before the roomiest side (the chat's reply: the card stays in its panel). */
  preferBelow?: boolean;
  /** Take the spot above the spotlit area whenever it fits (a touch card over the chat's actions, which sit at the bottom). */
  preferAbove?: boolean;
  /**
   * Parts of the screen the card keeps out of when it can (the desktop chat pane while the chat is not lit). A column along
   * the left or right edge narrows the space the card is placed in; if nothing fits there, the whole viewport is used.
   */
  avoid?: readonly SpotlightRect[];
}

interface Bounds { left: number; top: number; right: number; bottom: number }

/** The viewport less any avoided column that runs along its left or right edge. */
function boundsWithout(viewport: { width: number; height: number }, avoid: readonly SpotlightRect[]): Bounds {
  const bounds = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  for (const r of avoid) {
    if (r.height < viewport.height / 2) continue;
    if (r.x + r.width >= viewport.width - 1 && r.x > viewport.width / 2) bounds.right = Math.min(bounds.right, r.x);
    else if (r.x <= 1 && r.x + r.width < viewport.width / 2) bounds.left = Math.max(bounds.left, r.x + r.width);
  }
  return bounds;
}

function overlapArea(position: CardPosition, card: { width: number; height: number }, rects: readonly SpotlightRect[]): number {
  return rects.reduce((total, r) => {
    const width = Math.min(position.left + card.width, r.x + r.width) - Math.max(position.left, r.x);
    const height = Math.min(position.top + card.height, r.y + r.height) - Math.max(position.top, r.y);
    return total + (width > 0 && height > 0 ? width * height : 0);
  }, 0);
}

/**
 * Where the card goes: beside the spotlighted area on whichever side leaves the most room (right,
 * left, below, above), clamped to the viewport; in the middle of the screen when nothing is
 * spotlighted. When no side of the whole area fits the card, it takes the spot beside a single target,
 * or along an edge, that covers the least of the targets (bottom-right first). With `avoid`, all of this happens in the
 * space left beside the avoided columns first, and only falls back to the whole viewport when the card fits nowhere there
 * without covering a target.
 */
export function placeCard(
  rects: readonly SpotlightRect[],
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  { edge = EDGE, gap = GAP, preferBelow = false, preferAbove = false, avoid = [] }: CardPlacementOptions = {},
): CardPosition {
  if (rects.length === 0) return { left: (viewport.width - card.width) / 2, top: (viewport.height - card.height) / 2 };
  const full = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const narrowed = boundsWithout(viewport, avoid);
  if (narrowed.right - narrowed.left < full.right) {
    const inside = placeWithin(rects, card, narrowed, edge, gap, preferBelow, preferAbove);
    if (overlapArea(inside, card, rects) === 0) return inside;
  }
  return placeWithin(rects, card, full, edge, gap, preferBelow, preferAbove);
}

function placeWithin(rects: readonly SpotlightRect[], card: { width: number; height: number }, bounds: Bounds, edge: number, gap: number, preferBelow: boolean, preferAbove: boolean): CardPosition {
  const clamp = (value: number, size: number, low: number, high: number) => Math.max(low + edge, Math.min(value, high - size - edge));
  const at = (left: number, top: number): CardPosition => ({ left: clamp(left, card.width, bounds.left, bounds.right), top: clamp(top, card.height, bounds.top, bounds.bottom) });
  const sidesOf = (area: readonly SpotlightRect[]) => {
    const left = Math.min(...area.map((r) => r.x));
    const top = Math.min(...area.map((r) => r.y));
    const right = Math.max(...area.map((r) => r.x + r.width));
    const lower = Math.max(...area.map((r) => r.y + r.height));
    const midX = (left + right) / 2 - card.width / 2;
    const midY = (top + lower) / 2 - card.height / 2;
    return [
      { room: bounds.right - right - gap - edge, need: card.width, left: right + gap, top: midY },
      { room: left - bounds.left - gap - edge, need: card.width, left: left - gap - card.width, top: midY },
      { room: bounds.bottom - lower - gap - edge, need: card.height, left: midX, top: lower + gap },
      { room: top - bounds.top - gap - edge, need: card.height, left: midX, top: top - gap - card.height },
    ];
  };

  const sides = sidesOf(rects);
  const below = sides[2];
  const above = sides[3];
  const fitting = preferAbove && above.room >= above.need ? above : preferBelow && below.room >= below.need ? below : sides.filter((side) => side.room >= side.need).sort((a, b) => b.room - a.room)[0];
  if (fitting) return at(fitting.left, fitting.top);

  const candidates = [at(bounds.right, bounds.bottom), ...rects.flatMap((rect) => sidesOf([rect]).map((side) => at(side.left, side.top))), at(bounds.left, bounds.bottom), at(bounds.right, bounds.top), at(bounds.left, bounds.top)];
  return candidates.reduce((best, candidate) => (overlapArea(candidate, card, rects) < overlapArea(best, card, rects) ? candidate : best));
}
