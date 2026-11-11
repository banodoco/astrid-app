// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanesStoreApi } from '@/shared/state/panesStore';
import { acquirePaneControlsHost } from '@/shared/state/paneControlsHost';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';
import { EDITOR_TOUR_ANCHORS, editorTourSelector } from '../anchors';
import { EDITOR_TOUR_MEDIA } from '../tourMedia';
import { TOUR_MOVE_EASE, TOUR_MOVE_MS } from '../runner/useSettledRects';
import { EditorTourGenerationsPane } from './EditorTourGenerationsPane';
import { EDITOR_TOUR_GALLERY_LABELS } from './tourGalleryItems';

const frames = (count: number) => act(() => { vi.advanceTimersByTime(16 * count); });

function pane(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-testid="editor-tour-generations-pane"]')!;
}
function anchor(container: HTMLElement) {
  return container.querySelector<HTMLElement>(editorTourSelector(EDITOR_TOUR_ANCHORS.generationsPane));
}
/** The browser has loaded every image: fire `load` on the hidden preloaders so the tiles show them. */
function loadImages(container: HTMLElement) {
  act(() => { container.querySelectorAll('img').forEach((img) => fireEvent.load(img)); });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the tour pane'));
  window.localStorage.clear();
});
afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
});

describe('EditorTourGenerationsPane', () => {
  it('shows the four bundled stills, selected, inside an inert ancestor', () => {
    const { container } = render(<EditorTourGenerationsPane open animate={false} />);
    loadImages(container);

    const images = Array.from(container.querySelectorAll('img'));
    expect(images).toHaveLength(4);
    images.forEach((img, index) => {
      expect(img.getAttribute('src')).toBe(EDITOR_TOUR_MEDIA.stills[index].displayUrl);
      expect(img.getAttribute('alt')).toBe(EDITOR_TOUR_GALLERY_LABELS[index]);
      expect(img.closest('[inert]')).not.toBeNull();
    });
    const tiles = Array.from(container.querySelectorAll<HTMLElement>('[data-gallery-item-id]'));
    expect(tiles.map((tile) => tile.dataset.galleryItemId)).toEqual(['tour-still-1', 'tour-still-2', 'tour-still-3', 'tour-still-4']);
    tiles.forEach((tile) => {
      expect(tile.className).toContain('outline outline-2 outline-sky-400 -outline-offset-2');
    });
    // The only requests are the four image URLs (jsdom loads none); nothing goes through fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is one zero-size fixed box between the real pane and the tour shield', () => {
    const { getByTestId } = render(<EditorTourGenerationsPane open animate={false} />);
    const root = getByTestId('editor-tour-generations');
    expect(root.style.position).toBe('fixed');
    expect(root.style.width).toBe('0px');
    expect(root.style.height).toBe('0px');
    expect(root.style.zIndex).toBe(String(UI_Z_LAYERS.EDITOR_TOUR_GALLERY));
    expect(UI_Z_LAYERS.EDITOR_TOUR_GALLERY).toBeGreaterThan(UI_Z_LAYERS.GALLERY_PEEK);
    expect(UI_Z_LAYERS.EDITOR_TOUR_GALLERY).toBeLessThan(UI_Z_LAYERS.EDITOR_TOUR_SHIELD);
    expect(root.hasAttribute('inert')).toBe(true);
  });

  it('shows the real tab locked and open on desktop only', () => {
    const desktop = render(<EditorTourGenerationsPane open animate={false} />);
    const tab = desktop.container.querySelector('[data-pane-control][data-pane-control-side="bottom"]');
    expect(tab).not.toBeNull();
    expect(tab!.querySelector('[aria-label="Unlock pane"]')).not.toBeNull();
    expect(tab!.querySelector('[aria-label="Lock pane"]')).toBeNull();
    desktop.unmount();

    const release = acquirePaneControlsHost();
    try {
      const touch = render(<EditorTourGenerationsPane open animate={false} />);
      expect(touch.container.querySelector('[data-pane-control]')).toBeNull();
      // Touch layouts hide the chat, so the pane runs the full width.
      expect(pane(touch.container).style.right).toBe('0px');
    } finally {
      release();
    }
  });

  it('reserves the Tasks pane width on the right, as the real pane does', () => {
    const { container } = render(<EditorTourGenerationsPane open animate={false} />);
    const reserve = `${usePanesStoreApi().getState().tasksPaneWidth}px`;
    expect(pane(container).style.right).toBe(reserve);
    expect(pane(container).style.left).toBe('0px');
  });

  it('writes nothing to panesStore or storage while opening and closing', () => {
    const storeWrites = vi.fn();
    const unsubscribe = usePanesStoreApi().subscribe(storeWrites);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const onClosed = vi.fn();

    const view = render(<EditorTourGenerationsPane open={false} animate onClosed={onClosed} />);
    view.rerender(<EditorTourGenerationsPane open animate onClosed={onClosed} />);
    frames(5);
    view.rerender(<EditorTourGenerationsPane open={false} animate onClosed={onClosed} />);
    fireEvent.transitionEnd(pane(view.container), { propertyName: 'transform' });
    view.unmount();

    expect(storeWrites).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
    unsubscribe();
    setItem.mockRestore();
  });

  it('has its anchor at the resting rect before it opens, and slides up at once, with the tour move\'s duration and easing', () => {
    const view = render(<EditorTourGenerationsPane open={false} animate />);
    expect(anchor(view.container)).toBeNull();
    expect(pane(view.container).className).toContain('translate-y-full');
    frames(3); // painted closed: it mounts a step early

    // The tour is heading for the gallery: the anchor is there to be measured while the pane is still closed.
    view.rerender(<EditorTourGenerationsPane open={false} anchored animate />);
    const box = anchor(view.container)!;
    expect(pane(view.container).className).toContain('translate-y-full');
    expect(box.style.transform).toBe('');
    expect(box.style.height).toBe(pane(view.container).style.height);
    expect(box.style.right).toBe(pane(view.container).style.right);
    expect(box.style.left).toBe('0px');
    expect(box.style.bottom).toBe('0px');
    expect(box.style.pointerEvents).toBe('none');
    expect(box.closest('[inert]')).not.toBeNull();

    // The spotlight commits: the pane sets off in the same render pass, not frames later.
    view.rerender(<EditorTourGenerationsPane open anchored animate />);
    expect(pane(view.container).className).toContain('translate-y-0');
    expect(pane(view.container).className).not.toContain('translate-y-full');
    expect(pane(view.container).style.transitionDuration).toBe(`${TOUR_MOVE_MS}ms`);
    expect(pane(view.container).style.transitionTimingFunction).toBe(TOUR_MOVE_EASE);
    // The anchor never moved.
    expect(anchor(view.container)).toBe(box);
    expect(box.style.transform).toBe('');

    // And out again at once.
    view.rerender(<EditorTourGenerationsPane open={false} anchored={false} animate />);
    expect(pane(view.container).className).toContain('translate-y-full');
  });

  it('takes a frame at the closed position first when it is mounted already open', () => {
    const view = render(<EditorTourGenerationsPane open animate />);
    expect(pane(view.container).className).toContain('translate-y-full');
    frames(3);
    expect(pane(view.container).className).toContain('translate-y-0');
  });

  it('jumps in without a transition when it is not animated', () => {
    const { container } = render(<EditorTourGenerationsPane open animate={false} />);
    expect(pane(container).className).toContain('translate-y-0');
    expect(pane(container).className).toContain('transition-none');
  });

  it('slides out and reports closed on transitionend, or at once when not animated', () => {
    const onClosed = vi.fn();
    const view = render(<EditorTourGenerationsPane open animate onClosed={onClosed} />);
    frames(3);
    view.rerender(<EditorTourGenerationsPane open={false} animate onClosed={onClosed} />);
    expect(pane(view.container).className).toContain('translate-y-full');
    expect(anchor(view.container)).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    // A different element's or property's transition does not count.
    fireEvent.transitionEnd(pane(view.container), { propertyName: 'right' });
    expect(onClosed).not.toHaveBeenCalled();
    fireEvent.transitionEnd(pane(view.container), { propertyName: 'transform' });
    expect(onClosed).toHaveBeenCalledTimes(1);

    const instant = vi.fn();
    const second = render(<EditorTourGenerationsPane open animate={false} onClosed={instant} />);
    second.rerender(<EditorTourGenerationsPane open={false} animate={false} onClosed={instant} />);
    expect(instant).toHaveBeenCalledTimes(1);
  });

  it('still reports closed if the transition never ends', () => {
    const onClosed = vi.fn();
    const view = render(<EditorTourGenerationsPane open animate onClosed={onClosed} />);
    frames(3);
    view.rerender(<EditorTourGenerationsPane open={false} animate onClosed={onClosed} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('lays out in the requested number of columns, and in the real geometry by default', () => {
    const four = render(<EditorTourGenerationsPane open animate={false} columns={4} />);
    expect(four.container.querySelector<HTMLElement>('.grid')!.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    four.unmount();

    const real = render(<EditorTourGenerationsPane open animate={false} />);
    const template = real.container.querySelector<HTMLElement>('.grid')!.style.gridTemplateColumns;
    expect(template).toMatch(/^repeat\(\d+, minmax\(0, 1fr\)\)$/);
    expect(template).not.toBe('repeat(4, minmax(0, 1fr))');
  });

  it('shows no pager for four items', () => {
    const { container } = render(<EditorTourGenerationsPane open animate={false} />);
    expect(container.querySelector('[aria-label="Next page"]')).toBeNull();
    expect(container.querySelector('[aria-label="Media type"]')).not.toBeNull();
  });
});
