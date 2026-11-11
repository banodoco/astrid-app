import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitEditorTour, setEditorTourBeat, showEditorTourBeat, startEditorTour } from '@/shared/state/editorTourStore';
import { getPaneLockHolds } from '@/shared/state/paneLockHolds';
import { TourGalleryLayer } from './TourGalleryLayer';

const pane = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>>, mounts: 0, unmounts: 0 }));

vi.mock('./EditorTourGenerationsPane', async () => {
  const React = await import('react');
  return {
    EditorTourGenerationsPane: (props: Record<string, unknown>) => {
      pane.props.push(props);
      React.useEffect(() => { pane.mounts += 1; return () => { pane.unmounts += 1; }; }, []);
      return React.createElement('div', { 'data-testid': 'pane', 'data-open': String(props.open) });
    },
  };
});

const last = () => pane.props.at(-1)!;
const mounted = () => document.querySelector('[data-testid="pane"]') !== null;
const go = (tourAct: 1 | 2 | 3, beat: Parameters<typeof setEditorTourBeat>[1], instant = false) => act(() => setEditorTourBeat(tourAct, beat, instant));
const show = (beat: Parameters<typeof showEditorTourBeat>[0]) => act(() => showEditorTourBeat(beat));

beforeEach(() => {
  pane.props = [];
  pane.mounts = 0;
  pane.unmounts = 0;
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
  act(() => startEditorTour());
});

afterEach(() => {
  act(() => exitEditorTour());
  vi.restoreAllMocks();
});

describe('TourGalleryLayer', () => {
  it('mounts nothing before act 2\'s land', () => {
    render(<TourGalleryLayer />);
    expect(mounted()).toBe(false);
    go(1, 'land');
    expect(mounted()).toBe(false);
    go(2, 'compose');
    expect(mounted()).toBe(false);
  });

  it('mounts closed on act 2\'s land, and opens only when the card and spotlight commit to the gallery, not when the store moves', () => {
    render(<TourGalleryLayer />);
    go(2, 'land');
    show('land');
    expect(mounted()).toBe(true);
    expect(last()).toMatchObject({ open: false, anchored: false, animate: true });

    // The store is on gallery; the highlight has not set off. The anchor is there for it to measure; the pane waits.
    go(2, 'gallery');
    expect(last()).toMatchObject({ open: false, anchored: true });
    show('gallery');
    expect(last()).toMatchObject({ open: true, anchored: true });

    // The store has moved on, but the card and spotlight still show gallery: the pane stays open until they leave.
    go(3, 'compose');
    expect(last().open).toBe(true);
    expect(mounted()).toBe(true);

    show('compose');
    expect(last().open).toBe(false);
    expect(mounted()).toBe(true); // slides out with the highlight

    act(() => (last().onClosed as () => void)());
    expect(mounted()).toBe(false);
    expect(pane.mounts).toBe(1);
    expect(pane.unmounts).toBe(1);
  });

  it('on Back from gallery to land slides out as the highlight leaves, stays mounted closed; back to compose then unmounts it', () => {
    render(<TourGalleryLayer />);
    go(2, 'land');
    go(2, 'gallery');
    show('gallery');
    go(2, 'land', true);
    expect(last().open).toBe(true);
    show('land');
    expect(last()).toMatchObject({ open: false, animate: true });
    act(() => (last().onClosed as () => void)());
    expect(mounted()).toBe(true);
    go(2, 'compose', true);
    expect(mounted()).toBe(false);
  });

  it('slides on Back too (the highlight travels on Back), mounting closed first when returning from act 3', () => {
    render(<TourGalleryLayer />);
    go(2, 'land');
    go(2, 'gallery');
    show('gallery');
    go(3, 'compose');
    show('compose');
    act(() => (last().onClosed as () => void)());
    expect(mounted()).toBe(false);
    go(2, 'gallery', true);
    expect(last()).toMatchObject({ open: false, anchored: true, animate: true });
    show('gallery');
    expect(last()).toMatchObject({ open: true, animate: true });
  });

  it('never animates under reduced motion', () => {
    act(() => exitEditorTour());
    vi.mocked(window.matchMedia).mockImplementation((query) => ({ matches: query.includes('reduced-motion'), media: query } as MediaQueryList));
    act(() => startEditorTour());
    render(<TourGalleryLayer />);
    go(2, 'land');
    go(2, 'gallery');
    show('gallery');
    expect(last()).toMatchObject({ open: true, animate: false });
  });

  it('keeps the real gallery density: no columns prop', () => {
    render(<TourGalleryLayer />);
    go(2, 'land');
    go(2, 'gallery');
    show('gallery');
    expect(pane.props.every((props) => !('columns' in props))).toBe(true);
  });

  it('holds the Generations lock for the run and releases it on unmount', () => {
    const view = render(<TourGalleryLayer />);
    expect(getPaneLockHolds()).toMatchObject({ gens: false });
    view.unmount();
    expect(getPaneLockHolds().gens).toBeUndefined();
  });
});
