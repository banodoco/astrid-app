import { EDITOR_TOUR_ANCHORS, editorTourSelector } from '../anchors';
import {
  exitEditorTour,
  EDITOR_TOUR_GALLERY_ACT,
  getEditorTourState,
  markEditorTourSent,
  setEditorTourBeat,
  skipEditorTourAnimation,
  subscribeEditorTour,
  type EditorTourState,
} from '@/shared/state/editorTourStore';

/**
 * The beat machine, and the only writer of `act`/`beat`.
 *   welcome -(OK)-> compose -(sent)-> respond -(Next)-> land -(Next)-> next act's compose ... -> finale -(Next)-> feedback -(Start creating)-> exit
 * Act 2's land is followed by `gallery` (the Generations pane slides up) before act 3's compose.
 * Act 1 stops on respond to explain the reply; on acts 2 and 3, Send goes straight to land.
 * Back returns to the previous place where the user acted (see `backEditorTour`).
 */

const LAST_ACT = 3;

// A browser-only host owns its handoff instead of writing Runtime tour records.
let browserTourFinish: (() => void) | null = null;
export function registerBrowserTourFinish(finish: () => void): () => void {
  browserTourFinish = finish;
  return () => { if (browserTourFinish === finish) browserTourFinish = null; };
}

/** Whether the parts that present the current beat have finished animating. */
export function isEditorTourBeatReady({ beat, ready }: EditorTourState): boolean {
  switch (beat) {
    case 'compose':
    case 'respond':
      return ready.chat;
    case 'land':
    case 'gallery':
      return ready.timeline && ready.card;
    case 'welcome':
    case 'finale':
    case 'feedback':
      return ready.card;
  }
}

function advanceBeat(): void {
  const { act, beat } = getEditorTourState();
  if (beat === 'welcome') return setEditorTourBeat(1, 'compose');
  if (beat === 'compose') return; // leaves only when the composer's Send is pressed
  if (beat === 'respond') return setEditorTourBeat(act, 'land');
  if (beat === 'land' && act === EDITOR_TOUR_GALLERY_ACT) return setEditorTourBeat(act, 'gallery');
  if (beat === 'land' || beat === 'gallery') {
    return act < LAST_ACT ? setEditorTourBeat((act + 1) as typeof LAST_ACT, 'compose') : setEditorTourBeat(LAST_ACT, 'finale');
  }
  if (beat === 'finale') return setEditorTourBeat(LAST_ACT, 'feedback');
  finishEditorTour();
}

/** Enter, and the card's OK / Next button: finish the animation first, then act. */
export function runEditorTourPrimary(): void {
  const state = getEditorTourState();
  if (state.status !== 'running') return;
  if (!isEditorTourBeatReady(state)) return skipEditorTourAnimation();
  if (state.beat === 'compose') {
    if (!state.sent) markEditorTourSent();
    return;
  }
  advanceBeat();
}

/**
 * ArrowLeft, Backspace and the card's Back: return to the previous place the user acted, with the beat
 * already finished (`instant`). Only act 1 has a respond beat, and welcome has no Back.
 */
export function backEditorTour(): void {
  const { status, act, beat } = getEditorTourState();
  if (status !== 'running') return;
  const previousAct = (act - 1) as typeof LAST_ACT;
  switch (beat) {
    case 'welcome':
      return;
    case 'compose':
      if (act === 1) return setEditorTourBeat(1, 'welcome', true);
      return act - 1 === EDITOR_TOUR_GALLERY_ACT ? setEditorTourBeat(previousAct, 'gallery', true) : setEditorTourBeat(previousAct, 'land', true);
    case 'respond':
      return setEditorTourBeat(act, 'compose', true);
    case 'land':
      return act === 1 ? setEditorTourBeat(1, 'respond', true) : setEditorTourBeat(act, 'compose', true);
    case 'gallery':
      return setEditorTourBeat(act, 'land', true);
    case 'finale':
      return setEditorTourBeat(LAST_ACT, 'land', true);
    case 'feedback':
      return setEditorTourBeat(LAST_ACT, 'finale', true);
  }
}

/** Back from the screen after a browser tour (a phone's "Open Astrid on your computer"): its last card again, settled. */
export function returnToEditorTourEnd(): void {
  if (getEditorTourState().status === 'running') setEditorTourBeat(LAST_ACT, 'feedback', true);
}

/**
 * Esc, Skip, leaving the page, and the end of the feedback card: leave the tour and hand the user their own chat.
 */
export function finishEditorTour(): void {
  const { status } = getEditorTourState();
  if (status !== 'running') return;
  const handoff = browserTourFinish;
  // Persist the next phase before subscribers unmount the tour.
  if (handoff) {
    handoff();
    exitEditorTour();
    return;
  }
  exitEditorTour();
  focusRealComposer();
}

const FOCUS_WAIT_MS = 5000;

/**
 * The real chat remounts after the tour's own unmounts and may enable its composer only once it has
 * connected, so look again every frame for a few seconds. The tour's composer is read-only: never focus it.
 */
function focusRealComposer(deadline = Date.now() + FOCUS_WAIT_MS): void {
  if (typeof document === 'undefined') return;
  requestAnimationFrame(() => {
    const host = document.querySelector<HTMLElement>(editorTourSelector(EDITOR_TOUR_ANCHORS.chatComposer));
    const fieldSelector = 'textarea:not([readonly]):not([disabled]), input:not([readonly]):not([disabled]), [contenteditable="true"]';
    const field = host?.matches(fieldSelector) ? host : host?.querySelector<HTMLElement>(fieldSelector);
    if (field) return field.focus();
    if (Date.now() < deadline) focusRealComposer(deadline);
  });
}

/** Sending moves compose on: to respond on act 1, straight to land on acts 2 and 3. Returns the unsubscribe. */
export function watchEditorTourSend(): () => void {
  return subscribeEditorTour((state) => {
    if (state.status === 'running' && state.beat === 'compose' && state.sent) {
      setEditorTourBeat(state.act, state.act === 1 ? 'respond' : 'land');
    }
  });
}
