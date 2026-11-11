import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { EDITOR_TOUR_ANCHORS, EDITOR_TOUR_TRACK_IDS, editorTourSelector, editorTourTrackSelector } from '../anchors';
import { EDITOR_TOUR_SCRIPT as SCRIPT } from '../tourScript';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';
import { getEditorTourState, showEditorTourBeat, useEditorTour, type EditorTourAct, type EditorTourBeat } from '@/shared/state/editorTourStore';
import { TourCard } from '../card/TourCard';
import { TourGalleryLayer } from '../gallery/TourGalleryLayer';
import { TourSpotlight } from './TourSpotlight';
import { backEditorTour, finishEditorTour, isEditorTourBeatReady, runEditorTourPrimary, watchEditorTourSend } from './tourBeats';
import { placeCard, type CardPosition } from './cardPlacement';
import { TOUR_LEAVE_MS, TOUR_MOVE_EASE, TOUR_MOVE_MS, useSettledRects } from './useSettledRects';
import { spotlightTargetKey, useSpotlightMeasurement, useSpotlightRects, type SpotlightRect, type SpotlightTarget } from './useSpotlightRects';
import { TOUR_ARRIVE_MS, useCardMove } from './useCardMove';
import { LAND_WATCH_HOLD_MS, useLandWatch, WATCH_SUFFIX } from './landWatch';
import { useTourKeys } from './useTourKeys';
import { useEditorDeviceClass } from './useIsDesktopEditor';
import type { TimelineDeviceClass } from '../../lib/mobile-interaction-model';

/** Matches the phone card's `w-[calc(100vw-24px)]`. */
const PHONE_EDGE = 12;
/** How close to the top of the screen a phone's land card may sit, to stay off the preview on the shortest phones. */
const PHONE_LAND_TOP = 6;
/** The gap between a phone's card and what it points at. */
const PHONE_GAP = 8;

const ACT_TRACK: Record<EditorTourAct, string> = {
  1: EDITOR_TOUR_TRACK_IDS.scene,
  2: EDITOR_TOUR_TRACK_IDS.stills,
  3: EDITOR_TOUR_TRACK_IDS.videos,
};

/**
 * What each beat spotlights: chat composer and Send, the transcript, the act's new row with the preview, or nothing (the welcome,
 * the finale and the feedback card). On respond it is the act's actions, the beat's settled state (while the reply is
 * still coming in the runner holds the whole transcript instead: `spotlightTargets`).
 */
export function editorTourTargets(act: EditorTourAct, beat: EditorTourBeat, _device: TimelineDeviceClass = 'desktop'): string[] {
  switch (beat) {
    case 'compose':
      return [editorTourSelector(EDITOR_TOUR_ANCHORS.chatComposer)];
    case 'respond':
      return [editorTourSelector(EDITOR_TOUR_ANCHORS.chatActions)];
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
 * The respond beat comes in two phases, with no beat of its own between them: while the reply streams in (`working`) the
 * spotlight lights the exchange; as the reply's actions begin to appear (`actionsShowing`: their group already has its
 * final size) it makes one move onto them, travelling while they appear, with the card beside them (above them on touch)
 * carrying the reply's line and Next. On desktop the card waits beside the transcript with a quiet line meanwhile; on a
 * phone or tablet there is no card at all until then. Arriving by Back, or with reduced motion, the reply is already
 * there: straight to the actions.
 */
export function respondWorking(beat: EditorTourBeat, { actionsShowing, instant, reducedMotion }: { actionsShowing: boolean; instant: boolean; reducedMotion: boolean }): boolean {
  return beat === 'respond' && !actionsShowing && !instant && !reducedMotion;
}

/** The whole transcript box: what desktop's working card sits beside (so it holds still while the lit exchange expands). */
const TRANSCRIPT_BOX: SpotlightTarget = { selector: editorTourSelector(EDITOR_TOUR_ANCHORS.chatTranscript), whole: true };

/**
 * `editorTourTargets`, with respond's working phase, which lights the act's exchange: first the sent prompt with the
 * thinking line (tight), then, when the reply starts, one expansion to the prompt and the reply (the reply bubble takes its
 * final size from its first character, so nothing chases it). The chat keeps it scrolled into view.
 */
export function spotlightTargets(act: EditorTourAct, beat: EditorTourBeat, device: TimelineDeviceClass, working: boolean): SpotlightTarget[] {
  if (beat === 'respond' && working) return [editorTourSelector(EDITOR_TOUR_ANCHORS.chatExchange)];
  return editorTourTargets(act, beat, device);
}

/** Steps that show no card at all: a touch layout while the reply comes in, and a land beat's watch (the result alone). */
export function cardHidden(device: TimelineDeviceClass, phase: string | undefined): boolean {
  return (phase === 'working' && device !== 'desktop') || phase === 'watch';
}

/**
 * A phone's land card sits above the preview, over the editor's dimmed header, so the preview and the timeline rows under
 * it stay in view. When it is taller than the space there it starts at the top edge and overlaps the preview's top a little.
 */
export function phoneLandPosition(rects: readonly SpotlightRect[], card: { height: number }): CardPosition {
  const top = Math.min(...rects.map((r) => r.y));
  return { left: PHONE_EDGE, top: Math.max(PHONE_LAND_TOP, top - PHONE_GAP - card.height) };
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
  useEffect(() => {
    // Read-only, while a tour runs: what `scripts/tour-motion-trace.mjs` reads the tour's state from on a production build.
    const readers = { getEditorTourState, isEditorTourBeatReady };
    const host = window as Window & { __astridEditorTour?: typeof readers };
    host.__astridEditorTour = readers;
    return () => { if (host.__astridEditorTour === readers) delete host.__astridEditorTour; };
  }, []);
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
  const actionsShowing = useEditorTour((s) => s.ready.actions || s.ready.chat);
  const instant = useEditorTour((s) => s.instant);
  const device = useEditorDeviceClass();
  const motion = !reducedMotion;
  // Respond has two phases: the reply coming in, then its actions (`respondWorking`).
  const working = respondWorking(beat, { actionsShowing, instant, reducedMotion });
  // A land beat first lets its result play alone (`useLandWatch`), then shows its explainer: two steps, one beat.
  const watching = useLandWatch(`${runId}:${act}:${beat}`, act, beat);
  const stepKey = `${runId}:${act}:${beat}${working ? ':working' : ''}${watching ? WATCH_SUFFIX : ''}`;
  const cardRef = useRef<HTMLDivElement>(null);
  const targets = spotlightTargets(act, beat, device, working);
  const measurement = useSpotlightMeasurement(targets);
  // The card and spotlight show the step whose targets have all arrived and held still; it trails the store's by the leave.
  const cardMoving = useRef<() => boolean>(() => false);
  const shownStep = useRef('');
  // After a step with no card there is nothing that has to leave before the next step commits. Before one, nothing either:
  // the card fades out where it stands on the very frame the spotlight sets off (after Send, the result's watch).
  const nothingToLeave = cardHidden(device, shownStep.current.split(':')[3]);
  const noCardNext = cardHidden(device, stepKey.split(':')[3]);
  const commit = useSettledRects({ key: stepKey, targetsKey: spotlightTargetKey(targets), measurement, motion, moving: () => cardMoving.current(), leaves: !nothingToLeave && !noCardNext });
  shownStep.current = commit.key;
  const [, shownAct, shownBeat, shownPhase] = commit.key.split(':') as [string, `${EditorTourAct}`, EditorTourBeat, string | undefined];
  const pending = commit.key !== stepKey;
  const watchShown = shownPhase === 'watch';
  // The browser tour's phone chat stays in until the card and spotlight have moved off it.
  useLayoutEffect(() => showEditorTourBeat(shownBeat), [shownBeat]);
  // Measured from compose on, so it is known by the time the working card needs it.
  const transcriptBox = useSpotlightRects(device === 'desktop' && (beat === 'compose' || beat === 'respond') ? [TRANSCRIPT_BOX] : []);
  // The Send button is the one thing outside the card the user may press.
  const sendRects = useSpotlightRects(beat === 'compose' ? [editorTourSelector(EDITOR_TOUR_ANCHORS.chatSend)] : []);
  // A step with no card: the card fades out where it stands and takes its next place unseen; the step after it appears
  // in place (a fade, no travel, no morph).
  const hidden = cardHidden(device, shownPhase);
  const appearance = useRef({ key: '', inPlace: false, lastHidden: false });
  if (appearance.current.key !== commit.key) appearance.current = { key: commit.key, inPlace: appearance.current.lastHidden, lastHidden: hidden };
  const inPlace = appearance.current.inPlace;
  const { size, arrivedKey, moving } = useCardMove(cardRef, { key: commit.key, animate: commit.animate && !hidden && !inPlace, motion, pending: pending && !hidden && !noCardNext });
  cardMoving.current = moving;
  // `landed`: the card's move is over. `arrived`: the explainer itself is there (never during a watch), so its entrance
  // and its readiness wait for it.
  const landed = !motion || arrivedKey === commit.key;
  const arrived = landed && !watchShown && !hidden;
  // Whether this step's card rose into view by itself (the first card, a jump) or came in with the move; fixed per step.
  const rise = useRef({ key: '', rise: true });
  if (rise.current.key !== commit.key) rise.current = { key: commit.key, rise: !(motion && commit.animate) || hidden || inPlace };

  // The card and the cutouts take their new places together, on the render that knows the new card's size; until then
  // (the render that mounts the new content, before paint) they hold where they are.
  const shown = useRef<{ rects: readonly SpotlightRect[]; position: CardPosition } | null>(null);
  if (size?.key === commit.key || !shown.current) {
    const cardSize = size ?? { width: 360, height: 160 };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const rects = commit.rects;
    // Desktop's working card stays beside the transcript as a whole, so it does not hop when the lit exchange expands.
    const beside = device === 'desktop' && shownPhase === 'working' && transcriptBox.length ? transcriptBox : rects;
    // A phone's card spans the width: in the middle of the screen, or right above or below what it points at; on a land
    // beat always above the preview. On touch the reply's card sits just above the actions it explains, in the chat.
    const position = device === 'phone' && shownBeat === 'land' && rects.length ? phoneLandPosition(rects, cardSize) : placeCard(beside, cardSize, viewport, {
      ...(device === 'phone' ? { edge: PHONE_EDGE, gap: PHONE_GAP } : {}),
      preferAbove: device !== 'desktop' && shownBeat === 'respond',
      ...(device === 'desktop' ? { avoid: desktopCardAvoid(shownBeat) } : {}),
    });
    shown.current = { rects, position };
  }
  const { rects: spotlit, position } = shown.current;
  // Stable elements: a new rect or position re-renders this component, not the gallery layer or the card's content.
  const gallery = useMemo(() => <TourGalleryLayer />, []);
  // A step with no card keeps the last card's content while its host fades out where it stands (and unseen after that):
  // the next card's content arrives with the step that shows it, never inside a box that is on its way out.
  const stepOfCard = () => ({ act: Number(shownAct) as EditorTourAct, beat: shownBeat, working: shownPhase === 'working', rise: rise.current.rise });
  const cardStep = useRef(stepOfCard());
  if (!hidden) cardStep.current = stepOfCard();
  const { act: shownActNumber, beat: cardBeat, working: shownWorking, rise: cardRise } = cardStep.current;
  const card = useMemo(() => (
    <TourCard
      act={shownActNumber}
      beat={cardBeat}
      working={shownWorking}
      arrived={arrived}
      rise={cardRise}
      device={device}
      onPrimary={runEditorTourPrimary}
      onBack={backEditorTour}
      onSkip={finishEditorTour}
    />
  ), [shownActNumber, cardBeat, shownWorking, arrived, cardRise, device]);
  const moves = motion && commit.animate;
  return (
    <>
      {gallery}
      {/* While a result plays alone there is no card on screen: say so to those who cannot see it play. */}
      <div role="status" aria-live="polite" className="sr-only" data-editor-tour-watch-status>{watchShown ? SCRIPT.watching : ''}</div>
      <TourSpotlight rects={spotlit} clickable={sendRects[0] ?? null} reducedMotion={reducedMotion} animate={commit.animate} />
      <div
        ref={cardRef}
        data-editor-tour-card-host
        data-editor-tour-watch={watchShown || undefined}
        // No card on this step: nothing in it can be reached by keyboard or assistive technology either.
        {...(hidden ? { inert: '', 'aria-hidden': true } : {})}
        data-editor-tour-watch-hold={shownBeat === 'land' ? LAND_WATCH_HOLD_MS[Number(shownAct) as EditorTourAct] : undefined}
        // On a phone the card keeps clear of the home indicator of a full-screen web app.
        className={device === 'phone' ? 'fixed left-0 top-0 pb-[env(safe-area-inset-bottom)]' : 'fixed left-0 top-0'}
        style={{
          zIndex: UI_Z_LAYERS.EDITOR_TOUR_CARD,
          transform: `translate3d(${position.left}px, ${position.top}px, 0)`,
          willChange: 'transform',
          opacity: hidden ? 0 : 1,
          transition: !moves ? 'none'
            : hidden ? `opacity ${TOUR_LEAVE_MS}ms ease-out, transform 0s linear ${TOUR_LEAVE_MS}ms`
            : inPlace ? `opacity ${TOUR_ARRIVE_MS}ms ease-out`
            : `transform ${TOUR_MOVE_MS}ms ${TOUR_MOVE_EASE}`,
          // Between the store's beat changing and the card showing it, the old card's buttons would act on the new beat;
          // while it travels in, its content is not there yet.
          pointerEvents: pending || !landed || hidden ? 'none' : undefined,
        }}
      >
        {card}
      </div>
    </>
  );
}
