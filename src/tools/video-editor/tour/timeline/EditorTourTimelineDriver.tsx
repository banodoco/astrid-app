import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  editorTourStage,
  getEditorTourState,
  markEditorTourReady,
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
import { useEditorDeviceClass } from '@/tools/video-editor/tour/runner/useIsDesktopEditor.ts';
import { useTourMediaWarmup } from './useTourMediaWarmup.ts';
import { EDITOR_TOUR_MEDIA } from '../tourMedia.ts';
import { createEditorTourStagePatch, createEditorTourStageRemovalPatch, tourTrackOrder, TOUR_ANCHORS } from './tourStages.ts';
import { tourFitScaleWidth } from './tourViewport.ts';

const RENDER_WAIT_MS = 3000;
export const TOUR_ANCHOR_DWELL_MS = 1200;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Resolves once `check` is true on a frame, or after `timeoutMs` (the tour must never stall on a slow render). */
async function waitFor(check: () => boolean, timeoutMs: number, isCancelled: () => boolean): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!isCancelled() && !check() && performance.now() < deadline) await nextFrame();
}

/** A timeline row may mount before the paused player's debounced composition and decoder. */
async function waitForTourVideoFrame(mediaUrl: string, frame: number | undefined, isCancelled: () => boolean): Promise<boolean> {
  const expectedSrc = new URL(mediaUrl, document.baseURI).href;
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
 * Lives inside the tour's editor and takes the demo timeline to the tour's stage through the editor's
 * own ops (`track.add`, `clip.add`, `clip.update`), then presents it: the timeline is framed once (0-14 s) and never
 * scrolls or zooms again, and on each `land` beat the driver plays the 14 s from the start (act 2 presents each reference frame, then holds the last).
 * With reduced motion nothing plays: acts 1 and 3 keep their poster and act 2 holds its last frame.
 * Reports `ready.timeline` per beat.
 */
export function EditorTourTimelineDriver() {
  useTourMediaWarmup();
  const runId = useEditorTour((state) => state.runId);
  const act = useEditorTour((state) => state.act);
  const beat = useEditorTour((state) => state.beat);
  const stage = editorTourStage(act, beat);
  const ops = useTimelineOpsFromStore();
  const { previewRef } = useTimelineMutableAdapters();
  const loaded = useTimelineDataSelector((data) => !data.isLoading && data.data !== null);
  useTourTimelineFraming(loaded);
  const [appliedStage, setAppliedStage] = useState<EditorTourStage>(0);
  const [retry, setRetry] = useState(0);
  const [presented, setPresented] = useState(false);
  const [posterHost, setPosterHost] = useState<Element | null>(null);
  const applying = useRef(false);

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
    if (appliedStage >= stage) return;
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
  }, [loaded, ops, stage, appliedStage, retry]);

  const instant = useEditorTour((state) => state.instant);
  const reducedMotion = useEditorTour((state) => state.reducedMotion);

  // A phone's chat covers the whole screen while it has the spotlight: nothing plays (and the editor behind it is not
  // re-rendered at the playback clock's pace) for a picture nobody can see. Landing the next result plays it afresh.
  const phone = useEditorDeviceClass() === 'phone';
  const inChat = beat === 'compose' || beat === 'respond';
  useEffect(() => {
    if (phone && inChat) previewRef.current?.pause();
  }, [phone, inChat, runId, act, previewRef]);

  useEffect(() => {
    if (!loaded || appliedStage !== stage) return;
    let cancelled = false;
    const skippedAtStart = getEditorTourState().skipAnimation;
    const isCancelled = () => {
      const current = getEditorTourState();
      return cancelled || current.status !== 'running' || current.runId !== runId || current.act !== act || current.beat !== beat;
    };
    void (async () => {
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
          // Acts 1 and 3 play an ordinary media clip: the poster stays over the preview until the player has drawn the
          // clip's first frame at the playhead, then the video plays. Keep the previous picture underneath while the
          // clip mounts and draws, and only then seek the clip, whose canvas retains its last picture.
          const mediaUrl = act === 1 ? EDITOR_TOUR_MEDIA.guide.url : EDITOR_TOUR_MEDIA.video.url;
          const videoWaitCancelled = () => isCancelled() || getEditorTourState().skipAnimation !== skippedAtStart;
          if (await waitForTourVideoFrame(mediaUrl, undefined, videoWaitCancelled) && !videoWaitCancelled()) {
            previewRef.current?.seek(0);
            if (await waitForTourVideoFrame(mediaUrl, 0, videoWaitCancelled) && !videoWaitCancelled()) {
              setPresented(true);
              previewRef.current?.play();
            }
          }
          if (!isCancelled()) markEditorTourReady('timeline');
          return;
        }
      }
      if (!isCancelled()) markEditorTourReady('timeline');
    })();
    return () => { cancelled = true; };
  }, [runId, act, beat, stage, appliedStage, loaded, instant, reducedMotion, previewRef]);

  return <>
    {posterHost && beat === 'land' && act !== 2 && !presented && createPortal(
      <img src={act === 1 ? EDITOR_TOUR_MEDIA.frames[0].url : EDITOR_TOUR_MEDIA.stills[0].url}
        alt="" aria-hidden data-editor-tour-poster
        className="pointer-events-none absolute inset-0 z-20 h-full w-full bg-black object-contain" />,
      posterHost,
    )}
  </>;
}
