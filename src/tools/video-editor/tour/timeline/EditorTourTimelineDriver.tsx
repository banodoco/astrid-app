import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  editorTourStage,
  getEditorTourState,
  markEditorTourReady,
  startEditorTour,
  useEditorTour,
  type EditorTourStage,
} from '@/shared/state/editorTourStore.ts';
import {
  useTimelineChromeSelector,
  useTimelineDataSelector,
  useTimelineMutableAdapters,
  useTimelineOpsFromStore,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { editorTourSelector, editorTourTrackSelector } from '@/tools/video-editor/tour/anchors.ts';
import { useTourMediaWarmup } from './useTourMediaWarmup.ts';
import { EDITOR_TOUR_MEDIA, tourSaveData } from '../tourMedia.ts';
import { loadTourLiveScene, TOUR_SCENE_SOURCE_FROM } from './tourSceneSource.ts';
import { createEditorTourStagePatch, createEditorTourStageRemovalPatch, tourTrackOrder, TOUR_ANCHORS } from './tourStages.ts';
import { tourFitScaleWidth } from './tourViewport.ts';

const SceneSurface = lazy(() => import('@astrid/packs/rendering/ui/threejs-live-editor/SceneSurface')
  .then((module) => ({ default: module.SceneSurface })));

const RENDER_WAIT_MS = 3000;
export const TOUR_ANCHOR_DWELL_MS = 1200;
const WARMUP_GIVE_UP_MS = 8000;
/** A slow first frame gets recovery UI, never permission to advance an unpainted scene. */
const SCENE_PREPARING_NOTICE_MS = 8000;
/** The visible live scene reports its phase on this element (the warm-up's `onReady` is the same signal). */
const SCENE_SELECTOR = '[data-testid="astrid-live-scene-entry"]';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Resolves once `check` is true on a frame, or after `timeoutMs` (the tour must never stall on a slow render). */
async function waitFor(check: () => boolean, timeoutMs: number, isCancelled: () => boolean): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!isCancelled() && !check() && performance.now() < deadline) await nextFrame();
}

/** Only the real preview's acknowledged opening frame can release stage 1 playback.
 * The warm-up and timeline thumbnails own separate iframes/GPU contexts, and cannot vouch for it. */
async function waitForTourSceneFrame(
  revision: unknown,
  isCancelled: () => boolean,
  onPreparing: (state: 'waiting' | 'error') => void,
): Promise<boolean> {
  const noticeAt = performance.now() + SCENE_PREPARING_NOTICE_MS;
  const openingTime = TOUR_SCENE_SOURCE_FROM.toFixed(3);
  while (!isCancelled()) {
    const preview = document.querySelector(editorTourSelector('preview'));
    const scene = [...(preview?.querySelectorAll<HTMLElement>(SCENE_SELECTOR) ?? [])]
      .find(element => element.dataset.desiredRevision === revision);
    if (scene?.dataset.phase === 'ready'
      && scene.dataset.displayedRevision === revision
      && scene.dataset.desiredTime === openingTime
      && scene.dataset.sourceTime === openingTime) return true;
    if (scene?.dataset.phase === 'error') onPreparing('error');
    else if (performance.now() >= noticeAt) onPreparing('waiting');
    await nextFrame();
  }
  return false;
}

/** A timeline row may mount before the paused player's debounced composition and decoder. */
async function waitForTourVideoFrame(frame: number | undefined, isCancelled: () => boolean): Promise<boolean> {
  const expectedSrc = new URL(EDITOR_TOUR_MEDIA.video.url, document.baseURI).href;
  while (!isCancelled()) {
    const preview = document.querySelector(editorTourSelector('preview'));
    const ready = [...(preview?.querySelectorAll<HTMLElement>('[data-preview-decoded-frame="true"]') ?? [])].some((element) => {
      const src = element.dataset.previewMediaSrc;
      return src && new URL(src, document.baseURI).href === expectedSrc
        && (frame === undefined || element.dataset.previewPresentedFrame === String(frame));
    });
    if (ready) return true;
    // No timeout fallthrough: playing an unready composition exposes the world underneath.
    // The decoder owns load errors/retry. Back, Skip and leaving the tour cancel this wait.
    await nextFrame();
  }
  return false;
}

/**
 * Before the first land, boot the world and render its opening frame in a composited iframe.
 * This warms its assets/code/shaders; the real preview still acknowledges its own first frame.
 */
function SceneWarmup({ liveScene, onWarm }: { liveScene: Record<string, unknown>; onWarm: () => void }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed bottom-0 right-0 -z-10 h-[180px] w-[320px] overflow-hidden opacity-0"
    >
      <Suspense fallback={null}>
        <SceneSurface
          source={liveScene}
          sourceTime={TOUR_SCENE_SOURCE_FROM}
          width={320}
          height={180}
          onReady={onWarm}
        />
      </Suspense>
    </div>
  );
}

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
      setScaleWidth((current) => tourFitScaleWidth({ viewportWidth, startLeft, scaleWidth: current }) ?? current);
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
  }, [loaded, setScaleWidth]);
}

/**
 * Lives inside the tour's editor and takes the demo timeline to the tour's stage through the editor's
 * own ops (`track.add`, `clip.add`, `clip.update`), then presents it: the timeline is framed once (0-14 s) and never
 * scrolls or zooms again, and on each `land` beat the driver plays the 14 s from the start (act 2 presents each reference frame, then holds the last).
 * With reduced motion nothing plays: acts 1 and 3 keep their poster and act 2 holds its last frame.
 * Reports `ready.timeline` per beat.
 */
export function EditorTourTimelineDriver() {
  const warmupStarted = useTourMediaWarmup();
  const runId = useEditorTour((state) => state.runId);
  const act = useEditorTour((state) => state.act);
  const beat = useEditorTour((state) => state.beat);
  const stage = editorTourStage(act, beat);
  const ops = useTimelineOpsFromStore();
  const { previewRef } = useTimelineMutableAdapters();
  const loaded = useTimelineDataSelector((data) => !data.isLoading && data.data !== null);
  useTourTimelineFraming(loaded);
  const [appliedStage, setAppliedStage] = useState<EditorTourStage>(0);
  const [liveScene, setLiveScene] = useState<Record<string, unknown> | null>(null);
  const [warm, setWarm] = useState(false);
  const [sceneLoadAttempt, setSceneLoadAttempt] = useState(0);
  const [sceneLoadError, setSceneLoadError] = useState(false);
  const [scenePreparing, setScenePreparing] = useState<'waiting' | 'error' | null>(null);
  const [retry, setRetry] = useState(0);
  const [presented, setPresented] = useState(false);
  const [posterHost, setPosterHost] = useState<Element | null>(null);
  const applying = useRef(false);

  // Start the world and its lazy authoring chunk after first paint, before any Send.
  useEffect(() => {
    if (!warmupStarted) return;
    let active = true;
    setSceneLoadError(false);
    loadTourLiveScene().then(
      (scene) => { if (active) setLiveScene(scene); },
      () => { if (active) setSceneLoadError(true); },
    );
    return () => { active = false; };
  }, [sceneLoadAttempt, warmupStarted]);

  useLayoutEffect(() => {
    setPresented(false);
    setPosterHost(document.querySelector('[data-testid="video-editor-preview-surface"]')
      ?? document.querySelector(editorTourSelector('preview')));
  }, [runId, act, beat, appliedStage]);

  useEffect(() => {
    if (!loaded || !ops || applying.current) return;
    if (appliedStage > stage) {
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
    if (!liveScene || appliedStage >= stage) return;
    applying.current = true;
    const next = (appliedStage + 1) as 1 | 2 | 3;
    try {
      ops.apply(createEditorTourStagePatch(next, liveScene));
      setAppliedStage(next);
    } catch (error) {
      console.error('Editor tour: could not apply the demo timeline stage; retrying.', error);
      window.setTimeout(() => setRetry((count) => count + 1), 250);
    } finally {
      applying.current = false;
    }
  }, [loaded, ops, liveScene, stage, appliedStage, retry]);

  const instant = useEditorTour((state) => state.instant);
  const reducedMotion = useEditorTour((state) => state.reducedMotion);
  const warming = warmupStarted && act === 1 && appliedStage === 0 && !instant
    && (!tourSaveData() || beat !== 'welcome');
  useEffect(() => {
    if (!warming) return;
    const timer = window.setTimeout(() => setWarm(true), WARMUP_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [warming]);

  useEffect(() => {
    if (!loaded || appliedStage !== stage) return;
    let cancelled = false;
    const skippedAtStart = getEditorTourState().skipAnimation;
    const isCancelled = () => {
      const current = getEditorTourState();
      return cancelled || current.status !== 'running' || current.runId !== runId || current.act !== act || current.beat !== beat;
    };
    void (async () => {
      if (beat === 'respond' && act === 1 && !instant) await waitFor(() => warm, WARMUP_GIVE_UP_MS, isCancelled);
      if (beat === 'gallery') {
        // The dimmed preview is the same whether the user arrived forward (Next can cut act 2's walk short) or by Back.
        await waitFor(() => previewRef.current !== null, RENDER_WAIT_MS, isCancelled);
        if (isCancelled()) return;
        previewRef.current?.pause();
        previewRef.current?.seek(TOUR_ANCHORS[TOUR_ANCHORS.length - 1].at);
      }
      if (beat === 'land') {
        const topTrack = tourTrackOrder(stage)[0];
        await waitFor(
          () => document.querySelector(editorTourTrackSelector(topTrack)) !== null,
          RENDER_WAIT_MS,
          isCancelled,
        );
        if (isCancelled()) return;
        await waitFor(() => previewRef.current !== null, RENDER_WAIT_MS, isCancelled);
        if (isCancelled()) return;
        // Pause before seeking so an earlier act's playback cannot overwrite the new position.
        previewRef.current?.pause();
        if (act === 2) {
          const skipped = getEditorTourState().skipAnimation;
          const anchors = instant || reducedMotion ? [TOUR_ANCHORS.length - 1] : TOUR_ANCHORS.map((_, index) => index);
          for (const index of anchors) {
            if (isCancelled() || getEditorTourState().skipAnimation !== skipped) break;
            previewRef.current?.seek(TOUR_ANCHORS[index].at);
            if (!instant && !reducedMotion) await waitFor(
              () => getEditorTourState().skipAnimation !== skipped,
              TOUR_ANCHOR_DWELL_MS,
              isCancelled,
            );
          }
        } else {
          if (reducedMotion) {
            // The poster stays over the paused preview: the still is the whole presentation.
            previewRef.current?.seek(0);
            if (!isCancelled()) markEditorTourReady('timeline');
            return;
          }
          if (act === 3) {
            const videoWaitCancelled = () => isCancelled() || getEditorTourState().skipAnimation !== skippedAtStart;
            // Keep the last reference frame underneath while H3 mounts and draws at the current
            // playhead. Only then seek the new composition, whose canvas retains its last picture.
            if (await waitForTourVideoFrame(undefined, videoWaitCancelled) && !videoWaitCancelled()) {
              previewRef.current?.seek(0);
              if (await waitForTourVideoFrame(0, videoWaitCancelled) && !videoWaitCancelled()) {
                setPresented(true);
                previewRef.current?.play();
              }
            }
            if (!isCancelled()) markEditorTourReady('timeline');
            return;
          }
          previewRef.current?.seek(0);
          if (act === 1) {
            setScenePreparing(null);
            const sceneWaitCancelled = () => isCancelled() || getEditorTourState().skipAnimation !== skippedAtStart;
            const painted = await waitForTourSceneFrame(liveScene?.revision, sceneWaitCancelled, setScenePreparing);
            // Skipping an animation may advance the card, but must not run an unready scene clock.
            // Back/instant entry still needs the actual opening frame before it can autoplay.
            if (painted && !sceneWaitCancelled()) {
              setPresented(true);
              previewRef.current?.play();
            }
            if (!isCancelled()) setScenePreparing(null);
          } else if (!isCancelled()) previewRef.current?.play();
        }
      }
      if (!isCancelled()) markEditorTourReady('timeline');
    })();
    return () => { cancelled = true; };
  }, [runId, act, beat, stage, appliedStage, loaded, warm, instant, reducedMotion, previewRef, liveScene]);

  const notice = sceneLoadError ? (
    <div role="alert" className="fixed bottom-6 left-1/2 z-[2147483647] flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background p-4 text-sm text-foreground shadow-lg">
      <span>The Lantern Valley demo could not load. Check your connection and try again.</span>
      <button type="button" className="shrink-0 rounded-md bg-primary px-3 py-2 text-primary-foreground" onClick={() => setSceneLoadAttempt((count) => count + 1)}>Retry demo</button>
    </div>
  ) : scenePreparing && act === 1 && beat === 'land' ? (
    <div role={scenePreparing === 'error' ? 'alert' : 'status'} className="fixed bottom-6 left-1/2 z-[2147483647] flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background p-4 text-sm text-foreground shadow-lg">
      <span>{scenePreparing === 'error' ? 'The 3D world could not render.' : 'Preparing the 3D world. Playback will start when its first frame is ready.'}</span>
      <button type="button" className="shrink-0 rounded-md bg-primary px-3 py-2 text-primary-foreground" onClick={() => { setScenePreparing(null); startEditorTour(); }}>Restart demo</button>
    </div>
  ) : null;
  return <>
    {notice}
    {warming && liveScene && <SceneWarmup liveScene={liveScene} onWarm={() => setWarm(true)} />}
    {posterHost && beat === 'land' && act !== 2 && !presented && createPortal(
      <img src={act === 1 ? EDITOR_TOUR_MEDIA.frames[0].url : EDITOR_TOUR_MEDIA.stills[0].url}
        alt="" aria-hidden data-editor-tour-poster
        className="pointer-events-none absolute inset-0 z-20 h-full w-full bg-black object-contain" />,
      posterHost,
    )}
  </>;
}
