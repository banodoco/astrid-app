import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { EDITOR_TOUR_ANCHORS, EDITOR_TOUR_TRACK_IDS, editorTourSelector, editorTourTrackSelector } from '../anchors';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';
import { getEditorTourState, showEditorTourBeat, useEditorTour, type EditorTourAct, type EditorTourBeat } from '@/shared/state/editorTourStore';
import { TourCard } from '../card/TourCard';
import { TourGalleryLayer } from '../gallery/TourGalleryLayer';
import { TourSpotlight } from './TourSpotlight';
import { backEditorTour, finishEditorTour, runEditorTourPrimary, watchEditorTourSend } from './tourBeats';
import { placeCard, type CardPosition } from './cardPlacement';
import { TOUR_MOVE_EASE, TOUR_MOVE_MS, useSettledRects } from './useSettledRects';
import { spotlightTargetKey, useSpotlightMeasurement, useSpotlightRects, type SpotlightRect, type SpotlightTarget } from './useSpotlightRects';
import { useCardMove } from './useCardMove';
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
 * Desktop's respond beat comes in two phases, with no beat of its own between them: while the reply streams in (`working`)
 * the spotlight holds still over the whole transcript and the card waits beside it with a quiet line; once the chat is
 * ready it contracts onto the act's actions and the card moves beside them with the reply's line and Next. Arriving by
 * Back, or with reduced motion, the reply is already there: straight to the actions. Phones and tablets keep one phase.
 */
export function respondWorking(device: TimelineDeviceClass, beat: EditorTourBeat, { chatReady, instant, reducedMotion }: { chatReady: boolean; instant: boolean; reducedMotion: boolean }): boolean {
  return device === 'desktop' && beat === 'respond' && !chatReady && !instant && !reducedMotion;
}

/** `editorTourTargets`, with desktop's respond phases: the whole transcript box while the reply comes in, then its actions. */
export function spotlightTargets(act: EditorTourAct, beat: EditorTourBeat, device: TimelineDeviceClass, working: boolean): SpotlightTarget[] {
  if (device === 'desktop' && beat === 'respond') {
    return working ? [{ selector: editorTourSelector(EDITOR_TOUR_ANCHORS.chatTranscript), whole: true }] : [editorTourSelector(EDITOR_TOUR_ANCHORS.chatActions)];
  }
  return editorTourTargets(act, beat, device);
}

/**
 * Parts of the desktop editor the card keeps clear of when it can, beside what is spotlit: the chat pane, whenever the
 * chat is not what is lit (its own beats sit the card beside it anyway).
 */
function desktopCardAvoid(beat: EditorTourBeat): SpotlightRect[] {
  if (beat === 'compose' || beat === 'respond') return [];
  const box = document.querySelector(editorTourSelector(EDITOR_TOUR_ANCHORS.chatPane))?.getBoundingClientRect();
  return box && box.width > 0 && box.height > 0 && box.left < window.innerWidth ? [{ x: box.left, y: box.top, width: box.width, height: box.height }] : [];
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
  const chatReady = useEditorTour((s) => s.ready.chat);
  const instant = useEditorTour((s) => s.instant);
  const device = useEditorDeviceClass();
  const motion = !reducedMotion;
  // Respond has two phases on desktop: the reply coming in, then its actions (`respondWorking`).
  const working = respondWorking(device, beat, { chatReady, instant, reducedMotion });
  const stepKey = `${runId}:${act}:${beat}${working ? ':working' : ''}`;
  const cardRef = useRef<HTMLDivElement>(null);
  const targets = spotlightTargets(act, beat, device, working);
  const measurement = useSpotlightMeasurement(targets);
  // The card and spotlight show the step whose targets have all arrived and held still; it trails the store's by the leave.
  const cardMoving = useRef<() => boolean>(() => false);
  const commit = useSettledRects({ key: stepKey, targetsKey: spotlightTargetKey(targets), measurement, motion, moving: () => cardMoving.current() });
  const [, shownAct, shownBeat, shownPhase] = commit.key.split(':') as [string, `${EditorTourAct}`, EditorTourBeat, string | undefined];
  const pending = commit.key !== stepKey;
  // The browser tour's phone chat stays in until the card and spotlight have moved off it.
  useLayoutEffect(() => showEditorTourBeat(shownBeat), [shownBeat]);
  // The Send button is the one thing outside the card the user may press.
  const sendRects = useSpotlightRects(beat === 'compose' ? [editorTourSelector(EDITOR_TOUR_ANCHORS.chatSend)] : []);
  const { size, arrivedKey, moving } = useCardMove(cardRef, { key: commit.key, animate: commit.animate, motion, pending });
  cardMoving.current = moving;
  const arrived = !motion || arrivedKey === commit.key;
  // Whether this step's card rose into view by itself (the first card, a jump) or came in with the move; fixed per step.
  const rise = useRef({ key: '', rise: true });
  if (rise.current.key !== commit.key) rise.current = { key: commit.key, rise: !(motion && commit.animate) };

  // The card and the cutouts take their new places together, on the render that knows the new card's size; until then
  // (the render that mounts the new content, before paint) they hold where they are.
  const shown = useRef<{ rects: readonly SpotlightRect[]; position: CardPosition } | null>(null);
  if (size?.key === commit.key || !shown.current) {
    const cardSize = size ?? { width: 360, height: 160 };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const rects = device === 'phone' && shownBeat === 'land' ? phoneSpotlight(commit.rects, cardSize.height, viewport.height) : commit.rects;
    // A phone's card spans the width: in the middle of the screen, or right above or below what it points at.
    // On touch the reply's card sits under the reply, in the chat's own space, rather than over the editor beside it.
    const position = placeCard(rects, cardSize, viewport, {
      ...(device === 'phone' ? { edge: PHONE_EDGE, gap: PHONE_GAP } : {}),
      preferBelow: device !== 'desktop' && shownBeat === 'respond',
      ...(device === 'desktop' ? { avoid: desktopCardAvoid(shownBeat) } : {}),
    });
    shown.current = { rects, position };
  }
  const { rects: spotlit, position } = shown.current;
  const moves = motion && commit.animate;
  return (
    <>
      <TourGalleryLayer />
      <TourSpotlight rects={spotlit} clickable={sendRects[0] ?? null} reducedMotion={reducedMotion} animate={commit.animate} />
      <div
        ref={cardRef}
        data-editor-tour-card-host
        // On a phone the card keeps clear of the home indicator of a full-screen web app.
        className={device === 'phone' ? 'fixed left-0 top-0 pb-[env(safe-area-inset-bottom)]' : 'fixed left-0 top-0'}
        style={{
          zIndex: UI_Z_LAYERS.EDITOR_TOUR_CARD,
          transform: `translate3d(${position.left}px, ${position.top}px, 0)`,
          willChange: 'transform',
          transition: moves ? `transform ${TOUR_MOVE_MS}ms ${TOUR_MOVE_EASE}` : 'none',
          // Between the store's beat changing and the card showing it, the old card's buttons would act on the new beat;
          // while it travels in, its content is not there yet.
          pointerEvents: pending || !arrived ? 'none' : undefined,
        }}
      >
        <TourCard
          act={Number(shownAct) as EditorTourAct}
          beat={shownBeat}
          working={shownPhase === 'working'}
          arrived={arrived}
          rise={rise.current.rise}
          device={device}
          onPrimary={runEditorTourPrimary}
          onBack={backEditorTour}
          onSkip={finishEditorTour}
        />
      </div>
    </>
  );
}
