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

  it('mounts closed on act 2\'s land, opens on gallery, stays while the shown beat is still gallery, then unmounts after onClosed', () => {
    render(<TourGalleryLayer />);
    go(2, 'land');
    show('land');
    expect(mounted()).toBe(true);
    expect(last()).toMatchObject({ open: false, animate: true });

    go(2, 'gallery');
    expect(last().open).toBe(true);
    show('gallery');
    expect(last().open).toBe(true);

    // The store has moved on, but the card and spotlight still show gallery: the pane stays open.
    go(3, 'compose');
    expect(last().open).toBe(true);
    expect(mounted()).toBe(true);

    show('compose');
    expect(last().open).toBe(false);
    expect(mounted()).toBe(true); // slides out first

    act(() => (last().onClosed as () => void)());
    expect(mounted()).toBe(false);
    expect(pane.mounts).toBe(1);
    expect(pane.unmounts).toBe(1);
  });

  it('on Back from gallery to land stays mounted and closed; back to compose then unmounts it at once', () => {
    render(<TourGalleryLayer />);
    go(2, 'land');
    go(2, 'gallery');
    show('gallery');
    go(2, 'land', true);
    show('land');
    expect(last()).toMatchObject({ open: false, animate: false });
    act(() => (last().onClosed as () => void)());
    expect(mounted()).toBe(true);
    go(2, 'compose', true);
    expect(mounted()).toBe(false);
  });

  it('animates only without reduced motion and when not arriving by Back', () => {
    render(<TourGalleryLayer />);
    go(2, 'land');
    go(2, 'gallery');
    expect(last().animate).toBe(true);
    go(3, 'compose');
    go(2, 'gallery', true);
    expect(last().animate).toBe(false);
  });

  it('never animates under reduced motion', () => {
    act(() => exitEditorTour());
    vi.mocked(window.matchMedia).mockImplementation((query) => ({ matches: query.includes('reduced-motion'), media: query } as MediaQueryList));
    act(() => startEditorTour());
    render(<TourGalleryLayer />);
    go(2, 'land');
    go(2, 'gallery');
    expect(last()).toMatchObject({ open: true, animate: false });
  });

  it('keeps the real gallery density: no columns prop', () => {
    render(<TourGalleryLayer />);
    go(2, 'land');
    go(2, 'gallery');
    expect(pane.props.every((props) => !('columns' in props))).toBe(true);
  });

  it('holds the Generations lock for the run and releases it on unmount', () => {
    const view = render(<TourGalleryLayer />);
    expect(getPaneLockHolds()).toMatchObject({ gens: false });
    view.unmount();
    expect(getPaneLockHolds().gens).toBeUndefined();
  });
});
