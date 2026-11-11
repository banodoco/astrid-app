// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CUTOUT_INSET, insetRect, nextSlots, TourSpotlight } from './TourSpotlight';
import type { SpotlightRect } from './useSpotlightRects';

const composer: SpotlightRect = { x: 1147, y: 778, width: 287, height: 116 };
const row: SpotlightRect = { x: 7, y: 614, width: 604, height: 48 };
const preview: SpotlightRect = { x: 6, y: 51, width: 756, height: 492 };

const atCorner = (r: SpotlightRect | null) => !!r && r.x === 0 && r.y === 0;

describe('nextSlots', () => {
  it('opens a new cutout at its own target, from just inside it, never from the page corner', () => {
    const [slot, unused] = nextSlots([], [composer], true);
    expect(slot).toEqual({ rect: insetRect(composer), open: false, placing: true });
    expect(slot.rect!.x).toBe(composer.x + CUTOUT_INSET);
    expect(unused).toEqual({ rect: null, open: false, placing: false });
  });

  it('glides a lit cutout to its next target and opens the extra one in place', () => {
    const lit = nextSlots([], [composer], false);
    const [first, second] = nextSlots(lit, [row, preview], true);
    expect(first).toEqual({ rect: row, open: true, placing: false });
    expect(second).toMatchObject({ rect: insetRect(preview), open: false, placing: true });
  });

  it('closes a cutout that loses its target where it is', () => {
    const lit = nextSlots([], [row, preview], false);
    const [first, second] = nextSlots(lit, [composer], true);
    expect(first).toEqual({ rect: composer, open: true, placing: false });
    expect(second).toEqual({ rect: insetRect(preview), open: false, placing: false });
    expect(nextSlots(lit, [], true).every((slot) => !slot.open && !atCorner(slot.rect))).toBe(true);
  });

  it('jumps without animation: every slot is simply where it ends', () => {
    const lit = nextSlots([], [row, preview], false);
    expect(nextSlots(lit, [composer], false).slice(0, 2)).toEqual([
      { rect: composer, open: true, placing: false },
      { rect: preview, open: false, placing: false },
    ]);
  });
});

describe('TourSpotlight', () => {
  const holes = (container: HTMLElement) => [...container.querySelectorAll('#editor-tour-dim rect[fill="black"]')] as SVGRectElement[];
  const box = (el: Element) => ['x', 'y', 'width', 'height'].map((name) => Number(el.getAttribute(name)));

  it('opens a cutout in place in the same render pass, with the shared move', () => {
    const { container, rerender } = render(<TourSpotlight rects={[]} clickable={null} reducedMotion={false} />);
    rerender(<TourSpotlight rects={[composer]} clickable={null} reducedMotion={false} />);
    const [hole] = holes(container);
    expect(box(hole)).toEqual([composer.x, composer.y, composer.width, composer.height]);
    expect(hole.style.fillOpacity).toBe('1');
    expect(hole.style.transition).toContain('fill-opacity 460ms');
  });

  it('closes a cutout in place, its ring with it', () => {
    const { container, rerender } = render(<TourSpotlight rects={[row, preview]} clickable={null} reducedMotion={false} />);
    rerender(<TourSpotlight rects={[composer]} clickable={null} reducedMotion={false} />);
    const second = holes(container)[1];
    const inside = insetRect(preview);
    expect(box(second)).toEqual([inside.x, inside.y, inside.width, inside.height]);
    expect(second.style.fillOpacity).toBe('0');
    const ring = container.querySelectorAll('[data-editor-tour-ring]')[1] as SVGRectElement;
    expect(box(ring)).toEqual(box(second));
    expect(ring.style.strokeOpacity).toBe('0');
  });

  it('moves nothing under reduced motion', () => {
    const { container, rerender } = render(<TourSpotlight rects={[row]} clickable={null} reducedMotion />);
    rerender(<TourSpotlight rects={[composer]} clickable={null} reducedMotion />);
    expect(holes(container).every((hole) => hole.style.transition === 'none')).toBe(true);
    expect(box(holes(container)[0])).toEqual([composer.x, composer.y, composer.width, composer.height]);
  });
});
