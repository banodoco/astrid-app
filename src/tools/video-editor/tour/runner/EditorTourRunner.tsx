import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EDITOR_TOUR_ANCHORS, EDITOR_TOUR_TRACK_IDS, editorTourSelector, editorTourTrackSelector } from '../anchors';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';
import { getEditorTourState, showEditorTourBeat, useEditorTour, type EditorTourAct, type EditorTourBeat } from '@/shared/state/editorTourStore';
import { TourCard } from '../card/TourCard';
import { TourGalleryLayer } from '../gallery/TourGalleryLayer';
import { TourSpotlight } from './TourSpotlight';
import { backEditorTour, finishEditorTour, runEditorTourPrimary, watchEditorTourSend } from './tourBeats';
import { placeCard } from './cardPlacement';
import { useSettledRects } from './useSettledRects';
import { useSpotlightRects, type SpotlightRect } from './useSpotlightRects';
import { useTourKeys } from './useTourKeys';
import { useEditorDeviceClass } from './useIsDesktopEditor';
import type { TimelineDeviceClass } from '../../lib/mobile-interaction-model';

/** Matches the phone card's `w-[calc(100vw-24px)]`. */
const PHONE_EDGE = 12;
/** Close enough that the card covers the playback row under the preview, rather than leaving its controls peeking out. */
const PHONE_GAP = 8;

/**
 * A phone's card sits under everything spotlit when it fits there. On a short phone it cannot fit under both the preview
 * and the act's new row, so the row gives way (it would sit under the card) and the preview alone stays lit, clear of it.
 */
export function phoneSpotlight(rects: readonly SpotlightRect[], cardHeight: number, viewportHeight: number): readonly SpotlightRect[] {
  if (rects.length < 2) return rects;
  const room = (lit: readonly SpotlightRect[]) => viewportHeight - Math.max(...lit.map((r) => r.y + r.height)) - PHONE_GAP - PHONE_EDGE;
  if (room(rects) >= cardHeight) return rects;
  const preview = rects[rects.length - 1];
  return [preview];
}

const ACT_TRACK: Record<EditorTourAct, string> = {
  1: EDITOR_TOUR_TRACK_IDS.scene,
  2: EDITOR_TOUR_TRACK_IDS.stills,
  3: EDITOR_TOUR_TRACK_IDS.videos,
};

/**
 * What each beat spotlights: chat composer and Send, the transcript, the act's new row with the preview, or nothing (the welcome,
 * the finale and the feedback card). A phone's full-screen chat has no room for the card beside the whole transcript, so there
 * the reply and its actions alone are lit, with the card just above them.
 */
export function editorTourTargets(act: EditorTourAct, beat: EditorTourBeat, device: TimelineDeviceClass = 'desktop'): string[] {
  switch (beat) {
    case 'compose':
      return [editorTourSelector(EDITOR_TOUR_ANCHORS.chatComposer)];
    case 'respond':
      return [editorTourSelector(device === 'phone' ? EDITOR_TOUR_ANCHORS.chatReply : EDITOR_TOUR_ANCHORS.chatTranscript)];
    case 'land':
      return [editorTourTrackSelector(ACT_TRACK[act]), editorTourSelector(EDITOR_TOUR_ANCHORS.preview)];
    case 'gallery':
      return [editorTourSelector(EDITOR_TOUR_ANCHORS.generationsPane)];
    case 'welcome':
    case 'finale':
    case 'feedback':
      return [];
  }
}

/**
 * The running tour's overlay: keys, spotlight with input shield, and the card beside it.
 * Registered in the editor page's tour slot (`useEditorTourHost`), which mounts it only while the tour
 * runs, so it is mounted exactly for the length of a run.
 */
export function EditorTourRunner() {
  useEffect(() => watchEditorTourSend(), []);
  useEndTourOnUnmount();
  useTourKeys(true);
  // On <body>, not inside the page: the page's own stacking context sits below the panes (the Tasks pane chat).
  return createPortal(<RunningTour />, document.body);
}

/** Leaving the page mid-tour ends that run. Defer to survive StrictMode replay and guard replacement runs. */
function useEndTourOnUnmount(): void {
  const mounted = useRef(false);
  useEffect(() => {
    const runId = getEditorTourState().runId;
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        const current = getEditorTourState();
        if (!mounted.current && current.runId === runId) finishEditorTour();
      }, 0);
    };
  }, []);
}

function RunningTour() {
  const act = useEditorTour((s) => s.act);
  const beat = useEditorTour((s) => s.beat);
  const reducedMotion = useEditorTour((s) => s.reducedMotion);
  const runId = useEditorTour((s) => s.runId);
  const device = useEditorDeviceClass();
  const beatKey = `${runId}:${act}:${beat}`;
  const cardRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 360, height: 160 });
  const measured = useSpotlightRects(editorTourTargets(act, beat, device));
  const rects = useMemo(
    () => (device === 'phone' && beat === 'land' ? phoneSpotlight(measured, size.height, window.innerHeight) : measured),
    [device, beat, measured, size.height],
  );
  // The card and spotlight show the beat whose targets have settled; it trails the store's beat by a frame or two.
  const settled = useSettledRects(beatKey, rects);
  const [, shownAct, shownBeat] = settled.beatKey.split(':') as [string, `${EditorTourAct}`, EditorTourBeat];
  const pending = settled.beatKey !== beatKey;
  // The browser tour's phone chat stays in until the card and spotlight have moved off it.
  useLayoutEffect(() => showEditorTourBeat(shownBeat), [shownBeat]);
  // The Send button is the one thing outside the card the user may press.
  const sendRects = useSpotlightRects(beat === 'compose' ? [editorTourSelector(EDITOR_TOUR_ANCHORS.chatSend)] : []);

  // The shown beat swaps the card's content and size. Read the new size before paint, so the move starts
  // toward the spot for the new card and the content changes as the card starts to move.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    setSize((previous) => (previous.width === card.offsetWidth && previous.height === card.offsetHeight ? previous : { width: card.offsetWidth, height: card.offsetHeight }));
  }, [settled.beatKey]);

  // Later size changes within a beat (content loading in).
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const observer = new ResizeObserver(() => setSize((previous) => (previous.width === card.offsetWidth && previous.height === card.offsetHeight ? previous : { width: card.offsetWidth, height: card.offsetHeight })));
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  // A phone's card spans the width: in the middle of the screen, or right above or below what it points at.
  // On touch the reply's card sits under the reply, in the chat's own space, rather than over the editor beside it.
  const position = placeCard(settled.value, size, { width: window.innerWidth, height: window.innerHeight }, {
    ...(device === 'phone' ? { edge: PHONE_EDGE, gap: PHONE_GAP } : {}),
    preferBelow: device !== 'desktop' && shownBeat === 'respond',
  });
  return (
    <>
      <TourGalleryLayer />
      <TourSpotlight rects={settled.value} clickable={sendRects[0] ?? null} reducedMotion={reducedMotion} />
      <div
        ref={cardRef}
        data-editor-tour-card-host
        // On a phone the card keeps clear of the home indicator of a full-screen web app.
        className={device === 'phone' ? 'fixed left-0 top-0 pb-[env(safe-area-inset-bottom)]' : 'fixed left-0 top-0'}
        style={{
          zIndex: UI_Z_LAYERS.EDITOR_TOUR_CARD,
          transform: `translate3d(${position.left}px, ${position.top}px, 0)`,
          willChange: 'transform',
          transition: reducedMotion || !settled.animate ? 'none' : 'transform 450ms cubic-bezier(0.22, 1, 0.36, 1)',
          // Between the store's beat changing and the card showing it, the old card's buttons would act on the new beat.
          pointerEvents: pending ? 'none' : undefined,
        }}
      >
        <TourCard act={Number(shownAct) as EditorTourAct} beat={shownBeat} device={device} onPrimary={runEditorTourPrimary} onBack={backEditorTour} onSkip={finishEditorTour} />
      </div>
    </>
  );
}
