import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  editorTourStage,
  getEditorTourState,
  markEditorTourReady,
  subscribeEditorTour,
  useEditorTour,
  type EditorTourStage,
  type EditorTourState,
} from '@/shared/state/editorTourStore.ts';
import {
  useTimelineChromeSelector,
  useTimelineDataSelector,
  useTimelineMutableAdapters,
  useTimelineOpsFromStore,
  useTimelinePlaybackSelector,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { editorTourSelector } from '@/tools/video-editor/tour/anchors.ts';
import { useEditorDeviceClass } from '@/tools/video-editor/tour/runner/useIsDesktopEditor.ts';
import { TOUR_MOVE_MS } from '@/tools/video-editor/tour/runner/useSettledRects.ts';
import { registerEditorTourGesture } from '@/tools/video-editor/tour/runner/tourBeats.ts';
import { tourIdle, useTourMediaWarmup } from './useTourMediaWarmup.ts';
import { EDITOR_TOUR_MEDIA, tourPlaybackUrl, tourSaveData } from '../tourMedia.ts';
import { createTourVideoEngine, type TourVideoEngine } from './tourPicture.ts';
import { createEditorTourStagePatch, createEditorTourStageRemovalPatch, TOUR_ANCHORS } from './tourStages.ts';
import { tourFitScaleWidth } from './tourViewport.ts';

export const TOUR_ANCHOR_DWELL_MS = 1200;
/** How long a landing waits for the video's first moving frame before it goes on with the poster (the video may still start). */
export const TOUR_FIRST_FRAME_DEADLINE_MS = 2500;
/** How often the editor's timecode (React state) hears the playing video's time; the playhead itself moves every 100 ms. */
const TOUR_TIMECODE_REPORT_MS = 1000;
/** How long a phone's landing waits for its full-screen chat to leave before it starts the picture anyway. */
const CHAT_LEAVE_WAIT_MS = 2500;
/** How long after a phone's chat has set off to cover the screen its act's rows may be laid in behind it (the slide, and a breath). */
const BEHIND_CHAT_AFTER_MS = TOUR_MOVE_MS + 240;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Resolves once `check` is true on a frame, or after `timeoutMs` (the tour must never stall on a slow render). */
async function waitFor(check: () => boolean, timeoutMs: number, isCancelled: () => boolean): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!isCancelled() && !check() && performance.now() < deadline) await nextFrame();
}

/** Resolves when the tour's state satisfies `check`, or after `timeoutMs`. Costs nothing while it waits (no frame loop). */
function untilTour(check: (state: EditorTourState) => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (check(getEditorTourState())) return resolve();
    const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = subscribeEditorTour((state) => { if (check(state)) finish(); });
  });
}

const LAST_ANCHOR = TOUR_ANCHORS.length - 1;
const inChat = (beat: EditorTourState['beat']) => beat === 'compose' || beat === 'respond';
const PICTURE_FILL = 'absolute inset-0 h-full w-full object-contain';
const display = (slot: { displayUrl?: string; url: string }) => slot.displayUrl ?? slot.url;
const noEngine = { subscribe: () => () => undefined, presenting: () => false };

/** The timeline's scroll container, which publishes its label column width as `--label-width`. */
const TIMELINE_SCROLLER_SELECTOR = '[data-timeline-row-layout="managed"]';

/**
 * Frames the timeline once for the whole tour: scrolled to 0 s, with all 14 s in view (zooming out only when the
 * viewport is too narrow for the default zoom). After this nothing in the tour scrolls or zooms the timeline, so the
 * spotlight on a row holds still and only the playhead moves; Back never touches it either. Re-checked if the
 * timeline is resized (the chat pane opening), before any row has landed to be lit.
 */
function useTourTimelineFraming(loaded: boolean) {
  const setScaleWidth = useTimelineChromeSelector((chrome) => chrome.setScaleWidth);
  const scaleWidth = useTimelineDataSelector((data) => data.scaleWidth);
  // Read through refs: the setter is not stable, and an effect re-run per render would frame (and write) once per render.
  const chrome = useRef({ setScaleWidth, scaleWidth });
  chrome.current = { setScaleWidth, scaleWidth };
  useEffect(() => {
    if (!loaded) return;
    let observed: Element | null = null;
    let observer: ResizeObserver | null = null;
    const frame = () => {
      const scroller = document.querySelector<HTMLElement>(TIMELINE_SCROLLER_SELECTOR);
      if (!scroller) return;
      if (scroller.scrollLeft !== 0) scroller.scrollLeft = 0;
      const startLeft = parseFloat(getComputedStyle(scroller).getPropertyValue('--label-width')) || 0;
      const viewportWidth = scroller.clientWidth;
      // Only a real change is written: the setter saves a new preferences record even for the same zoom, and every save
      // re-renders the editor (a write per check kept React committing every frame and starved the preview's first frame).
      const fitted = tourFitScaleWidth({ viewportWidth, startLeft, scaleWidth: chrome.current.scaleWidth });
      if (fitted !== null) chrome.current.setScaleWidth(fitted);
      if (observed !== scroller) {
        observer?.disconnect();
        observed = scroller;
        observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(frame);
        observer?.observe(scroller);
      }
    };
    frame();
    // The scroller may mount after the data loads.
    const retry = window.setInterval(() => { if (!observed) frame(); else window.clearInterval(retry); }, 100);
    return () => { window.clearInterval(retry); observer?.disconnect(); };
  }, [loaded]);
}

/**
 * Lives inside the tour's editor and takes the demo timeline to the tour's stage through the editor's own ops
 * (`track.add`, `clip.add`, `clip.update`). The timeline is framed once (0-14 s) and never scrolls or zooms again.
 *
 * The picture is the tour's own, layered over the editor's preview surface (whose player stays idle while the tour runs:
 * `RemotionPreview` renders no clips then): a plain muted `<video>` for steps 1 and 3 (`tourPicture.ts`) and plain
 * `<img>`s for step 2's four stills. Nothing here waits on the editor's decoder, so a landing cannot stall on it:
 * - a forward `land` on steps 1 and 3 shows the clip's first frame as a poster at once, plays from 0 and reports
 *   `ready.timeline` at the first presented frame of the playing video, or when `play()` is refused, or after
 *   `TOUR_FIRST_FRAME_DEADLINE_MS`: then the poster stays (and gives way if the video starts late);
 * - step 2 walks its four stills, then holds the last;
 * - the video keeps playing (to its end, then holds its last frame) through the beats that follow, except behind a
 *   phone's full-screen chat; Back never restarts anything; with reduced motion nothing plays and no video is fetched.
 * The timeline's playhead follows the picture: imperatively while the video plays, with the preview's own time report
 * (`onPreviewTimeUpdate`, which also feeds the timecode) once a second and on every jump.
 */
export function EditorTourTimelineDriver() {
  const warm = useTourMediaWarmup();
  const runId = useEditorTour((state) => state.runId);
  const act = useEditorTour((state) => state.act);
  const beat = useEditorTour((state) => state.beat);
  const stage = editorTourStage(act, beat);
  const ops = useTimelineOpsFromStore();
  const reportPreviewTime = useTimelinePlaybackSelector((playback) => playback.onPreviewTimeUpdate);
  const loaded = useTimelineDataSelector((data) => !data.isLoading && data.data !== null);
  useTourTimelineFraming(loaded);
  const [appliedStage, setAppliedStage] = useState<EditorTourStage>(0);
  const [retry, setRetry] = useState(0);
  const [stillIndex, setStillIndex] = useState(LAST_ANCHOR);
  const [host, setHost] = useState<Element | null>(null);
  const applying = useRef(false);
  const instant = useEditorTour((state) => state.instant);
  const reducedMotion = useEditorTour((state) => state.reducedMotion);
  const phone = useEditorDeviceClass() === 'phone';

  // A phone's chat covers the whole editor while its prompt is typed. The act's rows are laid in behind it then, in an
  // idle moment, rather than inside the Send press: applying a stage re-renders the editor (about 110 ms of main-thread
  // work on a 4x-throttled phone profile), and everything the press sets off (the card leaving, the highlight moving to
  // the new row, the chat sliding away) had to wait behind it. Back takes the rows out again, as it does after a landing.
  const chatCovers = useEditorTour((state) => phone && inChat(state.beat) && inChat(state.shownBeat));
  const [behindChat, setBehindChat] = useState<string | null>(null);
  const actKey = `${runId}:${act}`;
  useEffect(() => {
    if (!chatCovers) {
      setBehindChat(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => void tourIdle().then(() => { if (!cancelled) setBehindChat(actKey); }), BEHIND_CHAT_AFTER_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [chatCovers, actKey]);
  /** The rows the timeline should hold: the tour's stage, or the coming one while a phone's chat hides the editor. */
  const rowStage = chatCovers && behindChat === actKey ? act : stage;

  useLayoutEffect(() => {
    setHost(document.querySelector('[data-testid="video-editor-preview-surface"]')
      ?? document.querySelector(editorTourSelector('preview')));
  }, [runId, act, beat, appliedStage]);

  /** The file the picture engine should hold for the tour's stage (the stage's clip, or the next one's while stills show). */
  const wantedClip = useRef<string | null>(null);
  // ---- the picture engine: one <video> per run, none with reduced motion
  const [engine, setEngine] = useState<TourVideoEngine | null>(null);
  useEffect(() => {
    if (reducedMotion) return undefined;
    const created = createTourVideoEngine();
    setEngine(created);
    // Every press of the tour (Next, Send, Enter) is a chance to start the video inside a user gesture. The clip the
    // tour shows next is assigned first, in case a quick advance cancelled the idle moment that would have buffered it.
    const prime = () => {
      if (wantedClip.current) created.load(wantedClip.current);
      created.prime();
    };
    const gestures = ['click', 'keydown', 'touchend'] as const;
    gestures.forEach((type) => document.addEventListener(type, prime, { capture: true, passive: true }));
    // The tour's own keys never reach the document (`useTourKeys` takes them on the window): its gesture seam does.
    const unregister = registerEditorTourGesture(prime);
    return () => {
      unregister();
      gestures.forEach((type) => document.removeEventListener(type, prime, { capture: true }));
      created.dispose();
      setEngine(null);
    };
  }, [runId, reducedMotion]);
  const revealed = useSyncExternalStore((engine ?? noEngine).subscribe, (engine ?? noEngine).presenting, () => false);

  // The playhead and the timecode follow the picture. The editor throttles its timecode to 4 Hz, so a jump is said twice.
  const report = useRef(reportPreviewTime);
  report.current = reportPreviewTime;
  const trailing = useRef<ReturnType<typeof setTimeout>>();
  const reportJump = useRef((seconds: number) => {
    report.current(seconds);
    clearTimeout(trailing.current);
    trailing.current = setTimeout(() => report.current(seconds), 300);
  }).current;
  useEffect(() => () => clearTimeout(trailing.current), []);
  // While the video plays, the playhead moves imperatively (no React work) ten times a second, and the editor's
  // timecode state, which re-renders the shell, is told once a second and at the end.
  const { timelineRef } = useTimelineMutableAdapters();
  useEffect(() => {
    if (!engine) return undefined;
    let lastState = 0;
    engine.onTime = (seconds, ended) => {
      clearTimeout(trailing.current);
      const now = performance.now();
      if (ended || now - lastState >= TOUR_TIMECODE_REPORT_MS) {
        lastState = now;
        report.current(seconds);
      } else timelineRef.current?.setTime(seconds);
    };
    return () => { engine.onTime = null; };
  }, [engine, timelineRef]);

  const videoSlot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = videoSlot.current;
    if (!engine || !slot || engine.element.parentElement === slot) return;
    // Moving a playing media element pauses it: start it again where it was.
    const wasPlaying = !engine.element.paused;
    slot.append(engine.element);
    if (wasPlaying) void engine.element.play()?.catch(() => undefined);
  }, [engine, host]);

  useEffect(() => {
    if (!loaded || !ops || applying.current) return;
    if (appliedStage > rowStage) {
      // Back: the later acts' rows leave at once, one stage at a time (a move back is never more than one).
      applying.current = true;
      try {
        ops.apply(createEditorTourStageRemovalPatch(appliedStage as 1 | 2 | 3));
        setAppliedStage((appliedStage - 1) as EditorTourStage);
      } catch (error) {
        console.error('Editor tour: could not step the demo timeline back; retrying.', error);
        window.setTimeout(() => setRetry((count) => count + 1), 250);
      } finally {
        applying.current = false;
      }
      return;
    }
    if (appliedStage >= rowStage) return;
    applying.current = true;
    const next = (appliedStage + 1) as 1 | 2 | 3;
    try {
      ops.apply(createEditorTourStagePatch(next));
      setAppliedStage(next);
    } catch (error) {
      console.error('Editor tour: could not apply the demo timeline stage; retrying.', error);
      window.setTimeout(() => setRetry((count) => count + 1), 250);
    } finally {
      applying.current = false;
    }
  }, [loaded, ops, rowStage, appliedStage, retry]);

  // The picture never waits for the timeline: it follows the tour's stage, not the applied patch (or rows laid in early).
  const running = useEditorTour((state) => state.status === 'running');
  useEffect(() => {
    if (!running) {
      engine?.hold();
      return undefined;
    }
    let cancelled = false;
    const skippedAtStart = getEditorTourState().skipAnimation;
    const isCancelled = () => {
      const current = getEditorTourState();
      return cancelled || current.status !== 'running' || current.runId !== runId || current.act !== act || current.beat !== beat;
    };
    const skipped = () => getEditorTourState().skipAnimation !== skippedAtStart;
    const done = () => { if (!isCancelled()) markEditorTourReady('timeline'); };
    const forward = beat === 'land' && !instant && !reducedMotion;
    const small = phone || tourSaveData();
    // The element holds the clip of this stage or the next one, buffered in idle time: the guide until the stills land.
    const clip = stage <= 1 ? EDITOR_TOUR_MEDIA.guide : EDITOR_TOUR_MEDIA.video;
    const load = () => engine?.load(tourPlaybackUrl(clip, small), tourSaveData() && !forward ? 'metadata' : 'auto');
    // (Not when the browser asks to save data: buffering then stays with the beats, which fetch metadata only.)
    wantedClip.current = tourSaveData() ? null : tourPlaybackUrl(clip, small);
    // A phone's chat covers the whole screen until the card and spotlight have left it, and then takes the length of
    // their move to slide away: the result starts (and its watch is timed) once it can be seen, and nothing starts
    // decoding on the frames of that move.
    const chatGone = async () => {
      if (!phone) return;
      await untilTour((state) => state.shownBeat === 'land' || isCancelled() || skipped(), CHAT_LEAVE_WAIT_MS);
      await untilTour(() => isCancelled() || skipped(), TOUR_MOVE_MS);
    };

    if (stage === 0 || stage === 2) {
      engine?.hold();
      if (stage === 0) {
        if (warm) void tourIdle().then(() => { if (!cancelled) load(); });
        reportJump(0);
        done();
        return () => { cancelled = true; };
      }
      void (async () => {
        if (forward) {
          await chatGone();
          for (let index = 0; index <= LAST_ANCHOR; index++) {
            if (isCancelled() || skipped()) break;
            setStillIndex(index);
            reportJump(TOUR_ANCHORS[index].at);
            await waitFor(skipped, TOUR_ANCHOR_DWELL_MS, isCancelled);
          }
        }
        if (cancelled) return;
        // Skipped, entered by Back, reduced motion, or a later beat of this stage: the last frame.
        setStillIndex(LAST_ANCHOR);
        if (!isCancelled()) reportJump(TOUR_ANCHORS[LAST_ANCHOR].at);
        done();
        // The stills hide the video element: time to buffer step 3's clip.
        await tourIdle();
        if (!cancelled) load();
      })();
      return () => { cancelled = true; };
    }

    load();
    if (!engine || !forward) {
      // Reduced motion: the poster is the whole presentation. Back, or a later beat of this stage: the picture stays
      // as it is (playing, ended, or its poster), except behind a phone's full-screen chat, where nobody sees it.
      if (engine && phone && (beat === 'compose' || beat === 'respond')) engine.hold();
      reportJump(engine?.presenting() ? engine.element.currentTime : 0);
      done();
      return () => { cancelled = true; };
    }
    void (async () => {
      await chatGone();
      if (isCancelled()) return;
      reportJump(0);
      await Promise.race([
        engine.start(TOUR_FIRST_FRAME_DEADLINE_MS),
        untilTour(() => isCancelled() || skipped(), TOUR_FIRST_FRAME_DEADLINE_MS + 1000),
      ]);
      done();
    })();
    return () => { cancelled = true; };
  }, [running, runId, act, beat, stage, instant, reducedMotion, engine, phone, warm, reportJump]);

  const kind = stage === 0 ? 'none' : stage === 2 ? 'still' : 'video';
  const clip = stage === 1 ? EDITOR_TOUR_MEDIA.guide : EDITOR_TOUR_MEDIA.video;
  const showVideo = kind === 'video' && revealed;
  return host && createPortal(
    <div aria-hidden data-editor-tour-picture={kind} data-state={kind === 'video' ? (showVideo ? 'playing' : 'poster') : kind === 'still' ? `still-${stillIndex}` : undefined}
      // Above the idle player, below the editor's own transport (z-10) and header row, which sit on the picture as they do on any clip.
      className="pointer-events-none absolute inset-0 z-[5]" style={kind === 'none' ? { visibility: 'hidden' } : undefined}>
      {/* The poster stays under the video once it plays: the first composited frame of a video that has just become
          visible can be empty, and what shows through it must be the clip's first frame, not the black behind it. */}
      {kind === 'video' && <img src={display(clip)} alt="" {...(showVideo ? { 'data-editor-tour-poster-under': '' } : { 'data-editor-tour-poster': '' })} className={PICTURE_FILL} />}
      <div ref={videoSlot} className="absolute inset-0" style={{ opacity: showVideo ? 1 : 0 }} />
      {kind === 'still' && EDITOR_TOUR_MEDIA.stills.map((still, index) => (
        <img key={still.url} src={display(still)} alt="" data-editor-tour-still={index} className={PICTURE_FILL}
          style={index === stillIndex ? undefined : { visibility: 'hidden' }} />
      ))}
    </div>,
    host,
  );
}
