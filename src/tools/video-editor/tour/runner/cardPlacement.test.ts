import { describe, expect, it } from 'vitest';
import { placeCard } from './cardPlacement';
import type { SpotlightRect } from './useSpotlightRects';

const VIEWPORT = { width: 1440, height: 900 };
const CARD = { width: 300, height: 200 };
const EDGE = 16;

function expectInViewport(position: { left: number; top: number }, card = CARD) {
  expect(position.left).toBeGreaterThanOrEqual(EDGE);
  expect(position.top).toBeGreaterThanOrEqual(EDGE);
  expect(position.left + card.width).toBeLessThanOrEqual(VIEWPORT.width - EDGE);
  expect(position.top + card.height).toBeLessThanOrEqual(VIEWPORT.height - EDGE);
}

describe('placeCard', () => {
  it('centres the card when nothing is spotlighted', () => {
    expect(placeCard([], CARD, VIEWPORT)).toEqual({ left: 570, top: 350 });
  });

  it('puts the card to the right of a rect on the left', () => {
    const rect: SpotlightRect = { x: 20, y: 300, width: 200, height: 300 };

    const position = placeCard([rect], CARD, VIEWPORT);

    expect(position.left).toBeGreaterThanOrEqual(rect.x + rect.width);
    expect(position.top).toBeLessThan(rect.y + rect.height);
    expectInViewport(position);
  });

  it('puts the card to the left of a rect on the far right', () => {
    const rect: SpotlightRect = { x: 1200, y: 300, width: 220, height: 300 };

    const position = placeCard([rect], CARD, VIEWPORT);

    expect(position.left + CARD.width).toBeLessThanOrEqual(rect.x);
    expectInViewport(position);
  });

  it('puts the card below a full-width rect near the top', () => {
    const rect: SpotlightRect = { x: 0, y: 20, width: 1440, height: 100 };

    const position = placeCard([rect], CARD, VIEWPORT);

    expect(position.top).toBeGreaterThanOrEqual(rect.y + rect.height);
    expectInViewport(position);
  });

  it.each([
    [{ width: 1440, height: 900 }, 380],
    [{ width: 1280, height: 720 }, 300],
  ])('puts the gallery card above a full-width bottom strip at %o, clear of it', (viewport, paneHeight) => {
    const card = { width: 380, height: 220 };
    const pane: SpotlightRect = { x: 0, y: viewport.height - paneHeight, width: viewport.width, height: paneHeight };

    const position = placeCard([pane], card, viewport);

    expect(position.top + card.height).toBeLessThanOrEqual(pane.y);
    expect(position.top).toBeGreaterThanOrEqual(EDGE);
    expect(position.left).toBeGreaterThanOrEqual(EDGE);
    expect(position.left + card.width).toBeLessThanOrEqual(viewport.width - EDGE);
  });

  it('docks bottom-right when the rects cover the whole viewport', () => {
    const rect: SpotlightRect = { x: 0, y: 0, width: 1440, height: 900 };

    expect(placeCard([rect], CARD, VIEWPORT)).toEqual({
      left: VIEWPORT.width - CARD.width - EDGE,
      top: VIEWPORT.height - CARD.height - EDGE,
    });
  });

  it('centres a phone card when nothing is spotlighted, never along the bottom', () => {
    const phone = { width: 375, height: 667 };
    expect(placeCard([], { width: 351, height: 240 }, phone, { edge: 12, gap: 8 })).toEqual({ left: 12, top: 213.5 });
  });

  it('puts a phone card right under the spotlit preview, the gap apart', () => {
    const phone = { width: 393, height: 659 };
    const preview: SpotlightRect = { x: 7, y: 148, width: 379, height: 218 };
    expect(placeCard([preview], { width: 369, height: 257 }, phone, { edge: 12, gap: 8 })).toEqual({ left: 12, top: 374 });
  });

  it('puts a phone card right above the spotlit composer', () => {
    const phone = { width: 393, height: 659 };
    const composer: SpotlightRect = { x: 7, y: 521, width: 380, height: 132 };
    expect(placeCard([composer], { width: 369, height: 202 }, phone, { edge: 12, gap: 8 })).toEqual({ left: 12, top: 311 });
  });

  it('when no side of the whole area fits, takes the spot that covers the least of the targets', () => {
    // A tablet in landscape: a centred preview with a short track row under its left half.
    const viewport = { width: 1180, height: 820 };
    const card = { width: 520, height: 330 };
    const preview: SpotlightRect = { x: 278, y: 143, width: 616, height: 362 };
    const track: SpotlightRect = { x: 6, y: 582, width: 510, height: 60 };
    const position = placeCard([preview, track], card, viewport);
    const covers = (r: SpotlightRect) => position.left < r.x + r.width && position.left + card.width > r.x
      && position.top < r.y + r.height && position.top + card.height > r.y;
    expect(covers(track)).toBe(false);
    expect(position.left + card.width).toBeLessThanOrEqual(viewport.width - EDGE);
    expect(position.top + card.height).toBeLessThanOrEqual(viewport.height - EDGE);
  });

  it('can prefer the spot below the area, over a roomier side', () => {
    const transcript: SpotlightRect = { x: 732, y: 40, width: 448, height: 380 };
    const viewport = { width: 1180, height: 820 };
    expect(placeCard([transcript], CARD, viewport).left + CARD.width).toBeLessThanOrEqual(transcript.x);
    expect(placeCard([transcript], CARD, viewport, { preferBelow: true }).top).toBeGreaterThanOrEqual(transcript.y + transcript.height);
  });

  it('always keeps the card inside the viewport', () => {
    const layouts: SpotlightRect[][] = [
      [{ x: 0, y: 0, width: 10, height: 10 }],
      [{ x: 1430, y: 890, width: 10, height: 10 }],
      [{ x: 700, y: 400, width: 40, height: 40 }],
      [{ x: 0, y: 0, width: 720, height: 900 }],
      [{ x: 720, y: 0, width: 720, height: 900 }],
      [{ x: 100, y: 100, width: 1200, height: 700 }],
      [
        { x: 10, y: 10, width: 300, height: 300 },
        { x: 1100, y: 500, width: 300, height: 300 },
      ],
    ];
    for (const rects of layouts) {
      expectInViewport(placeCard(rects, CARD, VIEWPORT));
    }
  });
});
