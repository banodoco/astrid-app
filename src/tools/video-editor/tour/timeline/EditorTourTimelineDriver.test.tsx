// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exitEditorTour,
  getEditorTourState,
  setEditorTourBeat,
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
import { EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS } from '@/tools/video-editor/tour/anchors.ts';
import { loadTourLiveScene, TOUR_SCENE_SOURCE_FROM } from './tourSceneSource.ts';
import { EDITOR_TOUR_MEDIA } from '../tourMedia.ts';
import { TOUR_CLIP_IDS } from './tourStages.ts';

vi.mock('./useTourMediaWarmup.ts', () => ({ useTourMediaWarmup: vi.fn(() => true) }));

const fakeLiveScene = { kind: 'fake-live-scene', revision: 'sha256:tour-world' };
const harness = vi.hoisted(() => ({
  warmups: [] as Array<{ sourceTime: number; onReady?: (info: unknown) => void }>,
  centered: [] as string[],
  zooms: [] as number[],
}));

vi.mock('./tourSceneSource.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tourSceneSource.ts')>()),
  loadTourLiveScene: vi.fn(async () => fakeLiveScene),
}));
vi.mock('@/tools/video-editor/lib/timeline-viewport-events.ts', () => ({
  requestCenterTimelineClip: (clipId: string) => { harness.centered.push(clipId); },
}));
vi.mock('@astrid/packs/rendering/ui/threejs-live-editor/SceneSurface', () => ({
  SceneSurface: (props: { sourceTime: number; onReady?: (info: unknown) => void }) => {
    harness.warmups.push(props);
    return <div data-testid="warm-scene" data-source-time={props.sourceTime} />;
  },
}));

import { EditorTourTimelineDriver, TOUR_ANCHOR_DWELL_MS } from './EditorTourTimelineDriver.tsx';

function createHarness() {
  const calls: string[] = [];
  const apply = vi.fn((patch: { operations: ReadonlyArray<{ op: string }> }) => {
    calls.push(`apply:${patch.operations[0].op}`);
    return {};
  });
  const previewHandle = {
    seek: vi.fn((time: number) => { calls.push(`seek:${time}`); }),
    play: vi.fn(() => { calls.push('play'); }),
    pause: vi.fn(() => { calls.push('pause'); }),
  };
  const store: TimelineStoreApi = createTimelineStore();
  store.setState((state) => ({
    ...state,
    timelineOps: { apply } as never,
    data: { ...state.data, isLoading: false, data: {} as never, scaleWidth: 160 },
    playback: { ...state.playback, previewRef: { current: previewHandle } as never },
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
  return { apply, calls, previewHandle, store, ...view };
}

const goTo = (act: EditorTourAct, beat: EditorTourBeat) => act_(() => setEditorTourBeat(act, beat));
const act_ = (fn: () => void) => act(() => { fn(); });
const ready = () => getEditorTourState().ready.timeline;

/** The visible live scene's status element, as `SceneSurface` renders it. */
function addScene(phase: 'loading' | 'ready'): HTMLElement {
  const scene = document.createElement('div');
  scene.setAttribute('data-testid', 'astrid-live-scene-entry');
  scene.setAttribute('data-phase', phase);
  scene.dataset.desiredRevision = fakeLiveScene.revision;
  scene.dataset.displayedRevision = fakeLiveScene.revision;
  scene.dataset.desiredTime = TOUR_SCENE_SOURCE_FROM.toFixed(3);
  scene.dataset.sourceTime = TOUR_SCENE_SOURCE_FROM.toFixed(3);
  document.querySelector('[data-editor-tour="preview"]')!.append(scene);
  return scene;
}

describe('EditorTourTimelineDriver', () => {
  let trackRow: HTMLElement;
  let preview: HTMLElement;
  function addDecodedVideo(frame: number, parent = preview, src = EDITOR_TOUR_MEDIA.video.url) {
    const marker = document.createElement('span');
    marker.dataset.previewDecodedFrame = 'true';
    marker.dataset.previewMediaSrc = src;
    marker.dataset.previewPresentedFrame = String(frame);
    parent.append(marker);
    return marker;
  }

  beforeEach(() => {
    harness.warmups.length = 0;
    harness.centered.length = 0;
    harness.zooms.length = 0;
    // The landed row the driver waits for before it scrolls and plays.
    trackRow = document.createElement('div');
    trackRow.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS.scene);
    document.body.append(trackRow);
    preview = document.createElement('div');
    preview.dataset.editorTour = 'preview';
    document.body.append(preview);
    addDecodedVideo(0);
    act_(() => startEditorTour());
  });

  afterEach(() => {
    trackRow.remove();
    preview.remove();
    document.querySelectorAll(`[${EDITOR_TOUR_TRACK_ATTRIBUTE}]`).forEach((row) => row.remove());
    document.querySelectorAll('[data-testid="astrid-live-scene-entry"]').forEach((scene) => scene.remove());
    vi.useRealTimers();
    vi.restoreAllMocks();
    act_(() => exitEditorTour());
  });

  it('shows a retry when the world fails to load and lands the stage after retry succeeds', async () => {
    vi.mocked(loadTourLiveScene).mockRejectedValueOnce(new Error('offline'));
    const view = createHarness();
    addScene('ready');
    goTo(1, 'land');
    expect(await view.findByRole('alert')).toHaveTextContent('could not load');
    expect(view.apply).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Retry demo' }));
    await waitFor(() => expect(view.apply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ready()).toBe(true));
    expect(view.queryByRole('alert')).toBeNull();
  });

  let presentationClock = 0;
  async function beginAnchorPresentation() {
    presentationClock = 0;
    const realNow = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + presentationClock);
    const view = createHarness();
    const row = document.createElement('div');
    row.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS.stills);
    document.body.append(row);
    goTo(2, 'land');
    await waitFor(() => expect(view.previewHandle.seek).toHaveBeenCalledWith(0));
    return view;
  }

  const dwell = () => act(async () => {
    presentationClock += TOUR_ANCHOR_DWELL_MS + 32;
    await new Promise((resolve) => setTimeout(resolve, 35));
  });

  it('presents all four anchors in order with a readable dwell and holds the final frame', async () => {
    const { previewHandle } = await beginAnchorPresentation();
    expect(ready()).toBe(false);
    expect(previewHandle.seek.mock.calls).toEqual([[0]]);
    await dwell();
    expect(previewHandle.seek.mock.calls).toEqual([[0], [6.5]]);
    await dwell();
    expect(previewHandle.seek.mock.calls).toEqual([[0], [6.5], [10]]);
    await dwell();
    expect(previewHandle.seek.mock.calls).toEqual([[0], [6.5], [10], [13]]);
    expect(ready()).toBe(false);
    await dwell();
    expect(ready()).toBe(true);
    // The timeline never scrolls between the reference frames: only the playhead and the preview move.
    expect(harness.centered).toEqual([]);
    expect(previewHandle.pause).toHaveBeenCalledTimes(1);
    expect(previewHandle.play).not.toHaveBeenCalled();
    await dwell();
    expect(previewHandle.seek).toHaveBeenCalledTimes(4);
  });

  it.each(['back', 'skip', 'exit', 'unmount', 'next-act'] as const)('cancels the anchor presentation on %s without delayed seeks', async (destination) => {
    const view = await beginAnchorPresentation();
    await dwell();
    expect(view.previewHandle.seek.mock.calls).toEqual([[0], [6.5]]);
    if (destination === 'back') act_(() => setEditorTourBeat(2, 'compose', true));
    if (destination === 'skip') act_(() => skipEditorTourAnimation());
    if (destination === 'exit') act_(() => exitEditorTour());
    if (destination === 'unmount') view.unmount();
    if (destination === 'next-act') {
      const row = document.createElement('div');
      row.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS.videos);
      document.body.append(row);
      goTo(3, 'land');
    }
    await dwell();
    const calls = view.previewHandle.seek.mock.calls.map(([time]) => time);
    expect(calls).toEqual(destination === 'next-act' ? [0, 6.5, 0] : [0, 6.5]);
    presentationClock += 10_000;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)); });
    expect(view.previewHandle.seek.mock.calls.map(([time]) => time)).toEqual(calls);
    if (destination === 'skip') expect(ready()).toBe(true);
  });

  async function beginVideoLanding() {
    preview.replaceChildren();
    const view = createHarness();
    for (const id of [EDITOR_TOUR_TRACK_IDS.stills, EDITOR_TOUR_TRACK_IDS.videos]) {
      const row = document.createElement('div');
      row.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, id);
      document.body.append(row);
    }
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(view.previewHandle.seek).toHaveBeenLastCalledWith(13);
    view.previewHandle.seek.mockClear();
    view.previewHandle.play.mockClear();
    goTo(3, 'land');
    await waitFor(() => expect(view.apply).toHaveBeenCalledTimes(3));
    return view;
  }

  it('keeps the town frame while the new video composition arrives, then waits for decoded frame zero before playing', async () => {
    const view = await beginVideoLanding();
    // Track DOM and the preview handle exist, but the old paused composition is still displayed.
    const elsewhere = addDecodedVideo(0, document.body);
    addDecodedVideo(0, preview, '/different-video.mp4');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(view.previewHandle.seek).not.toHaveBeenCalled();
    expect(view.previewHandle.play).not.toHaveBeenCalled();
    expect(ready()).toBe(false);
    const video = addDecodedVideo(390, preview, new URL(EDITOR_TOUR_MEDIA.video.url, document.baseURI).href);
    await waitFor(() => expect(view.previewHandle.seek).toHaveBeenCalledWith(0));
    expect(view.previewHandle.play).not.toHaveBeenCalled();
    expect(ready()).toBe(false);
    video.dataset.previewPresentedFrame = '0';
    await waitFor(() => expect(view.previewHandle.play).toHaveBeenCalledTimes(1));
    expect(ready()).toBe(true);
    elsewhere.remove();
  });

  it.each(['before-seek', 'after-seek'] as const)('cancels video readiness %s when leaving the beat, without late playback', async (phase) => {
    const view = await beginVideoLanding();
    let video: HTMLElement | undefined;
    if (phase === 'after-seek') {
      video = addDecodedVideo(390);
      await waitFor(() => expect(view.previewHandle.seek).toHaveBeenCalledWith(0));
    }
    act_(() => setEditorTourBeat(3, 'compose', true));
    if (video) video.dataset.previewPresentedFrame = '0';
    else addDecodedVideo(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(view.previewHandle.play).not.toHaveBeenCalled();
    expect(view.previewHandle.seek).toHaveBeenCalledTimes(phase === 'after-seek' ? 1 : 0);
  });

  it('lets Skip finish a video wait without seeking or playing the old composition', async () => {
    const view = await beginVideoLanding();
    act_(() => skipEditorTourAnimation());
    await waitFor(() => expect(ready()).toBe(true));
    addDecodedVideo(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(view.previewHandle.seek).not.toHaveBeenCalled();
    expect(view.previewHandle.play).not.toHaveBeenCalled();
  });

  it('boots the opening scene during welcome without touching the timeline', async () => {
    const { apply, findByTestId } = createHarness();
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).not.toHaveBeenCalled();
    expect(await findByTestId('warm-scene')).toHaveAttribute('data-source-time', String(TOUR_SCENE_SOURCE_FROM));
  });

  it('warms the scene during act 1 respond and holds ready until it has booted', async () => {
    const { apply, findByTestId } = createHarness();
    await waitFor(() => expect(ready()).toBe(true));

    goTo(1, 'respond');
    const warm = await findByTestId('warm-scene');
    // Seeked into the clip's source range, so the world is compiled at the frame 1c will show.
    expect(warm).toHaveAttribute('data-source-time', String(TOUR_SCENE_SOURCE_FROM));
    expect(ready()).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    act_(() => harness.warmups.at(-1)!.onReady?.({}));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).not.toHaveBeenCalled();
  });

  it('lands each stage through ops.apply, then seeks 0 and plays (act 2 holds its last frame when entered instantly)', async () => {
    const { apply, calls, previewHandle } = createHarness();
    addScene('ready');

    goTo(1, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ source: 'editor-tour', version: 0 });
    expect(apply.mock.calls[0][0].operations.map((operation: { op: string }) => operation.op)).toEqual(['track.update', 'clip.add', 'clip.update']);
    expect(harness.centered).toEqual([]);
    expect(previewHandle.seek).toHaveBeenCalledWith(0);
    expect(previewHandle.play).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('seek:0')).toBeGreaterThan(calls.indexOf('apply:clip.add'));
    expect(calls.indexOf('play')).toBeGreaterThan(calls.indexOf('seek:0'));
    // It pauses before seeking, so the seek isn't lost to an earlier act's playback.
    expect(calls.indexOf('pause')).toBeLessThan(calls.indexOf('seek:0'));

    // Staying on stage 1 through act 2's compose and respond applies nothing more.
    goTo(2, 'compose');
    await waitFor(() => expect(ready()).toBe(true));
    goTo(2, 'respond');
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(1);

    const stillsRow = document.createElement('div');
    stillsRow.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS.stills);
    document.body.append(stillsRow);
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][0].operations[0].op).toBe('track.add');
    expect(apply.mock.calls[1][0].operations[0].payload).toMatchObject({ before: EDITOR_TOUR_TRACK_IDS.scene });
    expect(harness.centered).toEqual([]);
    // An instant arrival skips the presentation and holds the last reference frame.
    expect(previewHandle.seek).toHaveBeenCalledTimes(2);
    expect(previewHandle.play).toHaveBeenCalledTimes(1);
    expect(previewHandle.pause).toHaveBeenCalledTimes(2);
    expect(calls.slice(-2)).toEqual(['pause', 'seek:13']);

    const videosRow = document.createElement('div');
    videosRow.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS.videos);
    document.body.append(videosRow);
    goTo(3, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls[2][0].operations[0].payload).toMatchObject({ before: EDITOR_TOUR_TRACK_IDS.stills });
    expect(harness.centered).toEqual([]);
    expect(previewHandle.play).toHaveBeenCalledTimes(2);
  });

  it('with reduced motion keeps each landing still: the poster stays, act 2 holds its last frame, nothing plays', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query } as MediaQueryList));
    act_(() => startEditorTour());
    const { previewHandle } = createHarness();
    goTo(1, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    expect(previewHandle.seek).toHaveBeenCalledWith(0);
    expect(document.querySelector('[data-editor-tour-poster]')).toHaveAttribute('src', EDITOR_TOUR_MEDIA.frames[0].url);

    const stillsRow = document.createElement('div');
    stillsRow.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS.stills);
    document.body.append(stillsRow);
    goTo(2, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    expect(previewHandle.seek).toHaveBeenLastCalledWith(13);

    const videosRow = document.createElement('div');
    videosRow.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS.videos);
    document.body.append(videosRow);
    goTo(3, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    expect(document.querySelector('[data-editor-tour-poster]')).toHaveAttribute('src', EDITOR_TOUR_MEDIA.stills[0].url);
    expect(previewHandle.play).not.toHaveBeenCalled();
  });

  it('steps back a stage by removing the later rows at once, and replays the landing going forward', async () => {
    const { apply, previewHandle } = createHarness();
    addScene('ready');
    const rows = [EDITOR_TOUR_TRACK_IDS.stills, EDITOR_TOUR_TRACK_IDS.videos].map((id) => {
      const row = document.createElement('div');
      row.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, id);
      document.body.append(row);
      return row;
    });
    const targetsOf = () => apply.mock.calls.map(([patch]) => `${patch.operations[0].op}:${patch.operations[0].target}`);

    goTo(1, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(2);

    // Back from land(2) to compose(2): the stills row goes at once, nothing is replayed.
    previewHandle.play.mockClear();
    act_(() => setEditorTourBeat(2, 'compose', true));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(3));
    expect(targetsOf()[2]).toBe(`track.remove:${EDITOR_TOUR_TRACK_IDS.stills}`);
    expect(previewHandle.play).not.toHaveBeenCalled();

    // Forward again lands the stills row afresh.
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(4));
    expect(apply.mock.calls[3][0].operations[0].op).toBe('track.add');

    // Back from land(1) to respond(1) removes the scene clip, with no warm-up and no waiting on a scene.
    act_(() => setEditorTourBeat(1, 'respond', true));
    await waitFor(() => expect(apply.mock.calls.slice(4).map(([patch]) => patch.operations[0].op)).toEqual(['track.remove', 'clip.remove']));
    expect(apply.mock.calls[5][0].operations[0].target).toBe(TOUR_CLIP_IDS.scene);
    expect(apply.mock.calls[5][0].operations[1]).toMatchObject({ op: 'track.update', target: EDITOR_TOUR_TRACK_IDS.scene, payload: { label: 'V1' } });
    await waitFor(() => expect(ready()).toBe(true));
    expect(document.querySelector('[data-testid="warm-scene"]')).toBeNull();
    rows.forEach((row) => row.remove());
  });

  it('on gallery pauses and seeks the last anchor without a patch, whether arrived at forward or by Back, and keeps no poster', async () => {
    const { apply, calls, previewHandle } = createHarness();
    addScene('ready');
    const rows = [EDITOR_TOUR_TRACK_IDS.stills, EDITOR_TOUR_TRACK_IDS.videos].map((id) => {
      const row = document.createElement('div');
      row.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, id);
      document.body.append(row);
      return row;
    });

    goTo(1, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(2);
    previewHandle.seek.mockClear();
    previewHandle.play.mockClear();
    calls.length = 0;

    // Forward: Next from land(2) (even mid-walk) leaves the dimmed preview on the last anchor.
    goTo(2, 'gallery');
    expect(ready()).toBe(false);
    await waitFor(() => expect(ready()).toBe(true));
    expect(calls).toEqual(['pause', 'seek:13']);
    expect(previewHandle.play).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-editor-tour-poster]')).toBeNull();

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
    calls.length = 0;
    act_(() => setEditorTourBeat(2, 'gallery', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(calls.slice(-2)).toEqual(['pause', 'seek:13']);
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(apply).toHaveBeenCalledTimes(4);
    rows.forEach((row) => row.remove());
  });

  it('holds act 1 land at 0 until the visible scene has painted, then plays and reports ready', async () => {
    const { previewHandle } = createHarness();
    const scene = addScene('loading');

    goTo(1, 'land');
    await waitFor(() => expect(previewHandle.seek).toHaveBeenCalledWith(0));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(previewHandle.play).not.toHaveBeenCalled();
    expect(ready()).toBe(false);
    expect(document.querySelector('[data-editor-tour-poster]')).toHaveAttribute('src', EDITOR_TOUR_MEDIA.frames[0].url);

    scene.setAttribute('data-phase', 'ready');
    await waitFor(() => expect(ready()).toBe(true));
    expect(previewHandle.play).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-editor-tour-poster]')).toBeNull();
  });

  it('lets skipAnimation advance the card without autoplaying an unready world', async () => {
    const { previewHandle } = createHarness();
    addScene('loading');

    goTo(1, 'land');
    await waitFor(() => expect(previewHandle.seek).toHaveBeenCalledWith(0));
    expect(ready()).toBe(false);

    act_(() => skipEditorTourAnimation());
    await waitFor(() => expect(ready()).toBe(true));
    expect(previewHandle.play).not.toHaveBeenCalled();
  });

  it('keeps the scene paused past eight seconds, offers recovery, and starts only at the acknowledged opening frame', async () => {
    const realNow = performance.now.bind(performance);
    let offset = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
    const { previewHandle, findByRole, queryByRole } = createHarness();
    const scene = addScene('loading');

    goTo(1, 'land');
    await waitFor(() => expect(previewHandle.seek).toHaveBeenCalledWith(0));
    expect(ready()).toBe(false);

    offset = 9000;
    expect(await findByRole('status')).toHaveTextContent('Preparing the 3D world');
    expect(previewHandle.play).not.toHaveBeenCalled();
    expect(ready()).toBe(false);
    scene.dataset.phase = 'ready';
    await waitFor(() => expect(ready()).toBe(true));
    expect(queryByRole('status')).toBeNull();
    expect(previewHandle.play).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-editor-tour-poster]')).toBeNull();
  });

  it('ignores ready thumbnails and stale preview frames, including on an instant return', async () => {
    const { previewHandle } = createHarness();
    const thumbnail = addScene('ready');
    document.body.append(thumbnail);
    const scene = addScene('ready');
    scene.dataset.displayedRevision = 'sha256:old-world';
    act_(() => setEditorTourBeat(1, 'land', true));
    await waitFor(() => expect(previewHandle.seek).toHaveBeenCalledWith(0));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
    expect(previewHandle.play).not.toHaveBeenCalled();
    scene.dataset.displayedRevision = fakeLiveScene.revision;
    scene.dataset.sourceTime = '7.000';
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
    expect(previewHandle.play).not.toHaveBeenCalled();
    scene.dataset.sourceTime = TOUR_SCENE_SOURCE_FROM.toFixed(3);
    scene.dataset.desiredTime = '7.000';
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
    expect(previewHandle.play).not.toHaveBeenCalled();
    scene.dataset.desiredTime = TOUR_SCENE_SOURCE_FROM.toFixed(3);
    await waitFor(() => expect(previewHandle.play).toHaveBeenCalledOnce());
  });

  it.each(['back', 'skip', 'exit', 'unmount'] as const)('does not autoplay a late scene acknowledgement after %s', async destination => {
    const view = createHarness();
    const scene = addScene('loading');
    goTo(1, 'land');
    await waitFor(() => expect(view.previewHandle.seek).toHaveBeenCalledWith(0));
    if (destination === 'back') goTo(1, 'respond');
    if (destination === 'skip') act_(() => skipEditorTourAnimation());
    if (destination === 'exit') act_(() => exitEditorTour());
    if (destination === 'unmount') view.unmount();
    scene.dataset.phase = 'ready';
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
    expect(view.previewHandle.play).not.toHaveBeenCalled();
  });

  it('offers a restart after a visible world error without starting playback', async () => {
    const view = createHarness();
    const scene = addScene('loading');
    goTo(1, 'land');
    await waitFor(() => expect(view.previewHandle.seek).toHaveBeenCalledWith(0));
    scene.dataset.phase = 'error';
    expect(await view.findByRole('alert')).toHaveTextContent('could not render');
    fireEvent.click(view.getByRole('button', { name: 'Restart demo' }));
    expect(getEditorTourState().beat).toBe('welcome');
    expect(view.previewHandle.play).not.toHaveBeenCalled();
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('does not wait for the scene on later acts, where the preview shows other media', async () => {
    const { previewHandle } = createHarness();
    addScene('ready');
    goTo(1, 'land');
    await waitFor(() => expect(ready()).toBe(true));
    document.querySelectorAll('[data-testid="astrid-live-scene-entry"]').forEach((scene) => scene.remove());
    addScene('loading');

    const stillsRow = document.createElement('div');
    stillsRow.setAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE, EDITOR_TOUR_TRACK_IDS.stills);
    document.body.append(stillsRow);
    act_(() => setEditorTourBeat(2, 'land', true));
    await waitFor(() => expect(ready()).toBe(true));
    expect(previewHandle.seek).toHaveBeenCalledTimes(2);
    expect(previewHandle.pause).toHaveBeenCalledTimes(2);
  });

  it('retries a stage whose apply threw instead of stalling the tour', async () => {
    const { apply } = createHarness();
    apply.mockImplementationOnce(() => { throw new Error('not ready'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    addScene('ready');

    goTo(1, 'land');
    await waitFor(() => expect(ready()).toBe(true), { timeout: 3000 });
    expect(apply).toHaveBeenCalledTimes(2);
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
      addScene('ready');
      await waitFor(() => expect(harness.zooms).toEqual([Math.floor(((560 - 144 - 16) / 14) * 5)]));
      expect(scroller.scrollLeft).toBe(0);

      goTo(1, 'land');
      await waitFor(() => expect(ready()).toBe(true));
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
      addScene('ready');
      await act(async () => { await Promise.resolve(); });
      for (let i = 0; i < 5; i += 1) {
        act_(() => store.setState((state) => ({ ...state, chrome: { ...state.chrome, setScaleWidth: ((update: number) => { harness.zooms.push(update); }) as never } })));
      }
      goTo(1, 'land');
      await waitFor(() => expect(ready()).toBe(true));
      expect(harness.zooms).toEqual([]);
    } finally {
      scroller.remove();
    }
  });
});
