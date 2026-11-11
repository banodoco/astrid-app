// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exitEditorTour,
  getEditorTourState,
  setEditorTourBeat,
  showEditorTourBeat,
  skipEditorTourAnimation,
  startEditorTour,
  type EditorTourAct,
  type EditorTourBeat,
} from '@/shared/state/editorTourStore.ts';
import {
  TimelineStoreProvider,
  createTimelineStore,
  type TimelineStoreApi,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { EDITOR_TOUR_TRACK_IDS } from '@/tools/video-editor/tour/anchors.ts';
import { EDITOR_TOUR_MEDIA } from '../tourMedia.ts';
import { TOUR_CLIP_IDS } from './tourStages.ts';
import { installFakeMedia } from './tourPictureTestMedia.ts';

vi.mock('./useTourMediaWarmup.ts', () => ({ useTourMediaWarmup: vi.fn(() => true), tourIdle: () => Promise.resolve() }));

const harness = vi.hoisted(() => ({
  centered: [] as string[],
  zooms: [] as number[],
}));

vi.mock('@/tools/video-editor/lib/timeline-viewport-events.ts', () => ({
  requestCenterTimelineClip: (clipId: string) => { harness.centered.push(clipId); },
}));

import { EditorTourTimelineDriver, TOUR_ANCHOR_DWELL_MS } from './EditorTourTimelineDriver.tsx';

function createHarness() {
  const apply = vi.fn((_patch: { operations: ReadonlyArray<{ op: string; target?: string; payload?: unknown }>; source?: string; version?: number }) => ({}));
  // The editor's own player: the tour must never drive it.
  const previewHandle = { seek: vi.fn(), play: vi.fn(), pause: vi.fn() };
  const times: number[] = [];
  const store: TimelineStoreApi = createTimelineStore();
  store.setState((state) => ({
    ...state,
    timelineOps: { apply } as never,
    data: { ...state.data, isLoading: false, data: {} as never, scaleWidth: 160 },
    playback: { ...state.playback, previewRef: { current: previewHandle } as never, onPreviewTimeUpdate: (time: number) => { times.push(time); } },
    chrome: {
      ...state.chrome,
      setScaleWidth: ((update: number | ((value: number) => number)) => {
        harness.zooms.push(typeof update === 'function' ? update(160) : update);
      }) as never,
    },
  }));
  const view = render(
    <TimelineStoreProvider store={store}>
      <EditorTourTimelineDriver />
    </TimelineStoreProvider>,
  );
  return { apply, previewHandle, times, store, ...view };
}

const goTo = (act: EditorTourAct, beat: EditorTourBeat) => act_(() => setEditorTourBeat(act, beat));
const act_ = (fn: () => void) => act(() => { fn(); });
const ready = () => getEditorTourState().ready.timeline;
const tick = (ms = 40) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const picture = () => document.querySelector<HTMLElement>('[data-editor-tour-picture]');
const poster = () => document.querySelector<HTMLImageElement>('[data-editor-tour-poster]');
const tourVideo = () => document.querySelector<HTMLVideoElement>('video[data-editor-tour-video]');
const shownStill = () => [...document.querySelectorAll<HTMLImageElement>('[data-editor-tour-still]')].filter((image) => image.style.visibility !== 'hidden').map((image) => image.getAttribute('src'));
/** Distinct reported times, in order (a jump is reported twice for the editor's throttled timecode). */
const distinct = (times: number[]) => times.filter((time, index) => index === 0 || time !== times[index - 1]);

describe('EditorTourTimelineDriver', () => {
  let preview: HTMLElement;
  let media: ReturnType<typeof installFakeMedia>;

  beforeEach(() => {
    harness.centered.length = 0;
    harness.zooms.length = 0;
    media = installFakeMedia();
    preview = document.createElement('div');
    preview.dataset.editorTour = 'preview';
    document.body.append(preview);
    act_(() => startEditorTour());
  });

  afterEach(() => {
    cleanup();
    act_(() => exitEditorTour());
    preview.remove();
    media.restore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  let presentationClock = 0;
  async function beginAnchorPresentation() {
    presentationClock = 0;
    const realNow = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + presentationClock);
    const view = createHarness();
    goTo(2, 'land');
    await waitFor(() => expect(shownStill()).toEqual([EDITOR_TOUR_MEDIA.stills[0].displayUrl]));
    return view;
  }

  const dwell = () => act(async () => {
    presentationClock += TOUR_ANCHOR_DWELL_MS + 32;
    await new Promise((resolve) => setTimeout(resolve, 35));
  });

  /** A forward landing on a video step whose first frame has been presented. */
  async function landPlaying(act: 1 | 3) {
    goTo(act, 'land');
    await waitFor(() => expect(media.play).toHaveBeenCalled());
    act_(() => media.frame(tourVideo()!, 0.04));
    await waitFor(() => expect(ready()).toBe(true));
  }

  it('never drives the editor player: the picture is the tour\'s own video and images over the preview surface', async () => {
    const { previewHandle } = createHarness();
    await landPlaying(1);
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    await landPlaying(3);
    expect(previewHandle.seek).not.toHaveBeenCalled();
    expect(previewHandle.play).not.toHaveBeenCalled();
    expect(previewHandle.pause).not.toHaveBeenCalled();
    expect(preview.contains(picture())).toBe(true);
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelectorAll('video')).toHaveLength(1);
  });

  it('presents all four stills in order with a readable dwell and holds the last', async () => {
    const { times } = await beginAnchorPresentation();
    const shown = (index: number) => [EDITOR_TOUR_MEDIA.stills[index].displayUrl];
    expect(ready()).toBe(false);
    expect(picture()).toHaveAttribute('data-editor-tour-picture', 'still');
    await dwell();
    expect(shownStill()).toEqual(shown(1));
    await dwell();
    expect(shownStill()).toEqual(shown(2));
    await dwell();
    expect(shownStill()).toEqual(shown(3));
    expect(ready()).toBe(false);
    await dwell();
    expect(ready()).toBe(true);
    expect(shownStill()).toEqual(shown(3));
    // Only the playhead and the picture move: the timeline never scrolls between the reference frames.
    expect(harness.centered).toEqual([]);
    expect(distinct(times).slice(-4)).toEqual([0, 6.5, 10, 13]);
    expect(media.play).not.toHaveBeenCalled();
  });

  it.each(['back', 'skip', 'exit', 'unmount', 'next-act'] as const)('cancels the still presentation on %s without late changes', async (destination) => {
    const view = await beginAnchorPresentation();
    await dwell();
    expect(distinct(view.times).slice(-2)).toEqual([0, 6.5]);
    if (destination === 'back') act_(() => setEditorTourBeat(2, 'compose', true));
    if (destination === 'skip') act_(() => skipEditorTourAnimation());
    if (destination === 'exit') act_(() => exitEditorTour());
    if (destination === 'unmount') view.unmount();
    if (destination === 'next-act') goTo(3, 'land');
    await dwell();
    await tick(350);
    const settled = [...view.times];
    presentationClock += 10_000;
    await tick(350);
    expect(view.times).toEqual(settled);
    // Skip shows the last frame at once and is ready; the others never reach the later anchors.
    if (destination === 'skip') {
      expect(ready()).toBe(true);
      expect(distinct(view.times).at(-1)).toBe(13);
    } else expect(distinct(view.times)).not.toContain(10);
  });

  it('lands each stage through ops.apply (act 2 holds its last frame when entered instantly)', async () => {
    const { apply } = createHarness();

    await landPlaying(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ source: 'editor-tour', version: 0 });
    expect(apply.mock.calls[0][0].operations.map((operation: { op: string }) => operation.op)).toEqual(['track.update', 'clip.add', 'clip.update']);
    expect(harness.centered).toEqual([]);

    // Staying on stage 1 through act 2's compose and respond applies nothing more, and the guide keeps playing.
    goTo(2, 'compose');
    await waitFor(() => expect(ready()).toBe(true));
    goTo(2, 'respond');
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(tourVideo()!.paused).toBe(false);
    expect(media.play).toHaveBeenCalledTimes(1);

    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][0].operations[0].op).toBe('track.add');
    expect(apply.mock.calls[1][0].operations[0].payload).toMatchObject({ before: EDITOR_TOUR_TRACK_IDS.scene });
    // An instant arrival skips the walk and holds the last reference frame; the guide stops behind it.
    expect(shownStill()).toEqual([EDITOR_TOUR_MEDIA.stills[3].displayUrl]);
    expect(tourVideo()!.paused).toBe(true);

    await landPlaying(3);
    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls[2][0].operations[0].payload).toMatchObject({ before: EDITOR_TOUR_TRACK_IDS.stills });
    expect(media.play).toHaveBeenCalledTimes(2);
  });

  describe('steps 1 and 3 play a plain muted video', () => {
    it('shows the first frame as a poster at once, plays the guide from 0, and is ready at its first presented frame', async () => {
      const { times } = createHarness();
      await tick();
      // Buffered before its beat: the element already holds the guide.
      expect(tourVideo()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.guide.playback!.large);
      expect(picture()).toHaveAttribute('data-editor-tour-picture', 'none');
      goTo(1, 'land');
      await waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));
      expect(poster()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.guide.displayUrl);
      expect(picture()).toHaveAttribute('data-state', 'poster');
      await tick();
      expect(ready()).toBe(false);

      act_(() => media.frame(tourVideo()!, 0.05));
      await waitFor(() => expect(ready()).toBe(true));
      expect(poster()).toBeNull();
      expect(picture()).toHaveAttribute('data-state', 'playing');
      // The playhead follows the picture.
      act_(() => { vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 500); media.frame(tourVideo()!, 2.5); });
      expect(times.at(-1)).toBe(2.5);
    });

    it('plays the H3 clip on step 3 over its own first frame, and keeps it playing under the cards that follow', async () => {
      createHarness();
      act_(() => setEditorTourBeat(2, 'land', true));
      await waitFor(() => expect(ready()).toBe(true));
      // The stills hide the element, so step 3's clip is buffered behind them.
      await waitFor(() => expect(tourVideo()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.video.playback!.large));
      goTo(3, 'land');
      await waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));
      expect(poster()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.video.displayUrl);
      act_(() => media.frame(tourVideo()!, 0.05));
      await waitFor(() => expect(ready()).toBe(true));
      goTo(3, 'finale');
      goTo(3, 'feedback');
      // Back to the landing: nothing restarts.
      act_(() => setEditorTourBeat(3, 'finale', true));
      act_(() => setEditorTourBeat(3, 'land', true));
      await waitFor(() => expect(ready()).toBe(true));
      expect(tourVideo()!.paused).toBe(false);
      expect(media.play).toHaveBeenCalledTimes(1);
      expect(picture()).toHaveAttribute('data-state', 'playing');
    });

    it('goes on with the poster when play() is refused, and starts on the next press', async () => {
      createHarness();
      media.refuse = true;
      goTo(1, 'land');
      await waitFor(() => expect(ready()).toBe(true));
      expect(poster()).not.toBeNull();
      media.refuse = false;
      act_(() => { document.body.click(); });
      act_(() => media.frame(tourVideo()!, 0.05));
      expect(poster()).toBeNull();
      expect(picture()).toHaveAttribute('data-state', 'playing');
    });

    it('lets skipAnimation go on before any frame, and still shows the video when it starts', async () => {
      createHarness();
      goTo(1, 'land');
      await waitFor(() => expect(media.play).toHaveBeenCalled());
      expect(ready()).toBe(false);
      act_(() => skipEditorTourAnimation());
      await waitFor(() => expect(ready()).toBe(true));
      expect(poster()).not.toBeNull();
      act_(() => media.frame(tourVideo()!, 0.4));
      expect(poster()).toBeNull();
    });

    it.each(['back', 'exit', 'unmount'] as const)('does not report ready or keep the picture after %s', async (destination) => {
      const view = createHarness();
      goTo(1, 'land');
      await waitFor(() => expect(media.play).toHaveBeenCalled());
      const video = tourVideo()!;
      if (destination === 'back') goTo(1, 'respond');
      if (destination === 'exit') act_(() => exitEditorTour());
      if (destination === 'unmount') view.unmount();
      await tick();
      expect(video.paused).toBe(true);
      if (destination === 'back') expect(picture()).toHaveAttribute('data-editor-tour-picture', 'none');
      if (destination === 'unmount') expect(video.hasAttribute('src')).toBe(false);
    });

    it('primes the video inside any press of the tour, without disturbing a landing', async () => {
      createHarness();
      await tick();
      act_(() => { document.body.click(); });
      expect(media.play).toHaveBeenCalledTimes(1);
      await tick();
      expect(tourVideo()!.paused).toBe(true);
      await landPlaying(1);
      act_(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(media.play).toHaveBeenCalledTimes(2);
      expect(tourVideo()!.paused).toBe(false);
    });
  });

  it('on a phone plays the 540p rendition, waits for its chat to leave, and stops the video behind the chat', async () => {
    const setWidth = (width: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    const before = window.innerWidth;
    try {
      setWidth(390);
      window.dispatchEvent(new Event('resize'));
      createHarness();
      goTo(1, 'respond');
      act_(() => showEditorTourBeat('respond'));
      await tick();
      expect(tourVideo()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.guide.playback!.small);
      goTo(1, 'land');
      await tick(80);
      expect(media.play).not.toHaveBeenCalled();
      act_(() => showEditorTourBeat('land'));
      await waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));
      act_(() => media.frame(tourVideo()!, 0.05));
      await waitFor(() => expect(ready()).toBe(true));
      goTo(2, 'compose');
      await waitFor(() => expect(tourVideo()!.paused).toBe(true));
    } finally {
      setWidth(before);
      window.dispatchEvent(new Event('resize'));
    }
  });

  it('with reduced motion keeps each landing still and creates no video: poster, last still, poster', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList));
    act_(() => startEditorTour());
    const { previewHandle } = createHarness();
    goTo(1, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    expect(poster()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.guide.displayUrl);

    goTo(2, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    expect(shownStill()).toEqual([EDITOR_TOUR_MEDIA.stills[3].displayUrl]);

    goTo(3, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    expect(poster()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.video.displayUrl);
    act_(() => { document.body.click(); });
    expect(document.querySelector('video')).toBeNull();
    expect(media.play).not.toHaveBeenCalled();
    expect(previewHandle.play).not.toHaveBeenCalled();
  });

  it('steps back a stage by removing the later rows at once, and replays nothing', async () => {
    const { apply } = createHarness();
    const targetsOf = () => apply.mock.calls.map(([patch]) => `${patch.operations[0].op}:${patch.operations[0].target}`);

    await landPlaying(1);
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(tourVideo()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.video.playback!.large));

    // Back from land(2) to compose(2): the stills row goes at once; the guide returns as its poster, not replayed.
    media.play.mockClear();
    act_(() => setEditorTourBeat(2, 'compose', true));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(3));
    expect(targetsOf()[2]).toBe(`track.remove:${EDITOR_TOUR_TRACK_IDS.stills}`);
    expect(media.play).not.toHaveBeenCalled();
    expect(poster()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.guide.displayUrl);
    expect(tourVideo()).toHaveAttribute('src', EDITOR_TOUR_MEDIA.guide.playback!.large);

    // Forward again lands the stills row afresh.
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(4));
    expect(apply.mock.calls[3][0].operations[0].op).toBe('track.add');

    // Back from land(1) to respond(1) removes the guide clip and the picture.
    act_(() => setEditorTourBeat(1, 'respond', true));
    await waitFor(() => expect(apply.mock.calls.slice(4).map(([patch]) => patch.operations[0].op)).toEqual(['track.remove', 'clip.remove']));
    expect(apply.mock.calls[5][0].operations[0].target).toBe(TOUR_CLIP_IDS.scene);
    expect(apply.mock.calls[5][0].operations[1]).toMatchObject({ op: 'track.update', target: EDITOR_TOUR_TRACK_IDS.scene, payload: { label: 'V1' } });
    await waitFor(() => expect(ready()).toBe(true));
    expect(picture()).toHaveAttribute('data-editor-tour-picture', 'none');
  });

  it('on gallery holds the last still without a patch, whether arrived at forward or by Back, and keeps no poster', async () => {
    const { apply, times } = createHarness();

    await landPlaying(1);
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(2);
    media.play.mockClear();

    // Forward: Next from land(2) (even mid-walk) leaves the dimmed preview on the last anchor.
    goTo(2, 'gallery');
    await waitFor(() => expect(ready()).toBe(true));
    expect(shownStill()).toEqual([EDITOR_TOUR_MEDIA.stills[3].displayUrl]);
    expect(times.at(-1)).toBe(13);
    expect(media.play).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(poster()).toBeNull();

    // Act 3's compose keeps stage 2: no patch. Its land applies act 3's patch once.
    goTo(3, 'compose');
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(2);
    goTo(3, 'land');
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(3));
    expect(apply.mock.calls[2][0].operations[0].payload).toMatchObject({ before: EDITOR_TOUR_TRACK_IDS.stills });

    // Back through compose(3) removes act 3's row; compose(3) -> gallery(2) -> land(2) patch nothing more.
    act_(() => setEditorTourBeat(3, 'compose', true));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(4));
    act_(() => setEditorTourBeat(2, 'gallery', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(shownStill()).toEqual([EDITOR_TOUR_MEDIA.stills[3].displayUrl]);
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(4);
  });

  it('retries a stage whose apply threw instead of stalling the tour', async () => {
    const { apply } = createHarness();
    apply.mockImplementationOnce(() => { throw new Error('not ready'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    goTo(1, 'land');
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it('frames the timeline once at 0 s with 14 s in view, and never scrolls or zooms it again', async () => {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-timeline-row-layout', 'managed');
    scroller.style.setProperty('--label-width', '144px');
    Object.defineProperty(scroller, 'clientWidth', { value: 560, configurable: true });
    scroller.scrollLeft = 7;
    document.body.append(scroller);
    try {
      createHarness();
        await waitFor(() => expect(harness.zooms).toEqual([Math.floor(((560 - 144 - 16) / 14) * 5)]));
      expect(scroller.scrollLeft).toBe(0);

      await landPlaying(1);
      expect(harness.centered).toEqual([]);
      expect(harness.zooms).toHaveLength(1);
    } finally {
      scroller.remove();
    }
  });

  it('writes no zoom when the timeline already fits, even as the chrome (and its setter) changes', async () => {
    // Each write saves a new preferences record and re-renders the editor; with a write per check, and a check per new
    // setter, the editor re-rendered every frame and starved the preview's first scene frame.
    const scroller = document.createElement('div');
    scroller.setAttribute('data-timeline-row-layout', 'managed');
    scroller.style.setProperty('--label-width', '144px');
    Object.defineProperty(scroller, 'clientWidth', { value: 1400, configurable: true });
    document.body.append(scroller);
    try {
      const { store } = createHarness();
        await act(async () => { await Promise.resolve(); });
      for (let i = 0; i < 5; i += 1) {
        act_(() => store.setState((state) => ({ ...state, chrome: { ...state.chrome, setScaleWidth: ((update: number) => { harness.zooms.push(update); }) as never } })));
      }
      await landPlaying(1);
      expect(harness.zooms).toEqual([]);
    } finally {
      scroller.remove();
    }
  });
});
