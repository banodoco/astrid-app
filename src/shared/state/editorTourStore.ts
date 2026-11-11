import { createStore, useStore } from 'zustand';

/**
 * The editor's first-run tour. This store is the one contract between the tour's parts: the runner
 * (the only writer of `act`/`beat`), the demo timeline, the tour chat panel and the explainer card.
 * Each part renders from it and reports its own `ready` flag.
 */

export type EditorTourAct = 1 | 2 | 3;
/**
 * `welcome` comes once, before act 1's `compose`; the acts then run compose → respond → land; `finale` and then `feedback` end.
 * Act `EDITOR_TOUR_GALLERY_ACT` has one more beat after its `land`: `gallery`, where the Generations pane slides up.
 */
export type EditorTourBeat = 'welcome' | 'compose' | 'respond' | 'land' | 'gallery' | 'finale' | 'feedback';
/** Rows on the demo timeline: 0 none · 1 scene · 2 + stills row · 3 + video row. */
export type EditorTourStage = 0 | 1 | 2 | 3;
export type EditorTourStatus = 'idle' | 'running';
/** The act whose `land` is followed by the `gallery` beat (step 2, part 2 of 2). */
export const EDITOR_TOUR_GALLERY_ACT: EditorTourAct = 2;
export type EditorTourReadyKey = 'chat' | 'timeline' | 'card';

export interface EditorTourState {
  /** Bumps on every start or replay, so parts can reset per run. */
  runId: number;
  status: EditorTourStatus;
  act: EditorTourAct;
  beat: EditorTourBeat;
  /** The beat the card and spotlight show: it trails `beat` while the new beat's targets settle. */
  shownBeat: EditorTourBeat;
  /** The composer's Send was pressed for the current act. */
  sent: boolean;
  /** Reset on every beat change; each part sets its own flag once it has finished presenting the beat. */
  ready: Readonly<Record<EditorTourReadyKey, boolean>>;
  reducedMotion: boolean;
  /**
   * Set when the user arrived by Back, cleared on any forward move: every part finishes the beat at once,
   * exactly as it does for reduced motion (nothing re-types, re-streams or re-reveals).
   */
  instant: boolean;
  /** Bumps when the user asks to finish the current animation now (first Enter mid-animation). */
  skipAnimation: number;
}

const NOT_READY: EditorTourState['ready'] = Object.freeze({ chat: false, timeline: false, card: false });

const editorTourStore = createStore<EditorTourState>(() => ({
  runId: 0,
  status: 'idle',
  act: 1,
  beat: 'compose',
  shownBeat: 'compose',
  sent: false,
  ready: NOT_READY,
  reducedMotion: false,
  instant: false,
  skipAnimation: 0,
}));

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Each act's result lands on its `land` beat and stays for the rest of the tour. */
export function editorTourStage(act: EditorTourAct, beat: EditorTourBeat): EditorTourStage {
  if (beat === 'welcome') return 0;
  if (beat === 'gallery') return 2; // the gallery changes nothing on the timeline: act 2's result stays
  if (beat === 'finale' || beat === 'feedback') return 3;
  return (beat === 'land' ? act : act - 1) as EditorTourStage;
}

export function startEditorTour(): void {
  editorTourStore.setState((state) => ({
    runId: state.runId + 1,
    status: 'running',
    act: 1,
    beat: 'welcome',
    shownBeat: 'welcome',
    sent: false,
    ready: NOT_READY,
    reducedMotion: prefersReducedMotion(),
    instant: false,
    skipAnimation: 0,
  }));
}

/** Runner only. `instant` is true only for a move back; any forward move clears it. */
export function setEditorTourBeat(act: EditorTourAct, beat: EditorTourBeat, instant = false): void {
  editorTourStore.setState({ act, beat, sent: false, ready: NOT_READY, instant });
}

/** Runner only: the card and spotlight now show this beat. */
export function showEditorTourBeat(shownBeat: EditorTourBeat): void {
  editorTourStore.setState((state) => (state.shownBeat === shownBeat ? state : { shownBeat }));
}

/** Runner only. */
export function skipEditorTourAnimation(): void {
  editorTourStore.setState((state) => ({ skipAnimation: state.skipAnimation + 1 }));
}

/** Runner only: the demo timeline and tour chat unmount, and the user's own editor returns. */
export function exitEditorTour(): void {
  editorTourStore.setState({ status: 'idle', sent: false, ready: NOT_READY, instant: false });
}

/** Tour chat panel only. */
export function markEditorTourSent(): void {
  editorTourStore.setState({ sent: true });
}

export function markEditorTourReady(key: EditorTourReadyKey): void {
  editorTourStore.setState((state) => (state.ready[key] ? state : { ready: { ...state.ready, [key]: true } }));
}

export function getEditorTourState(): EditorTourState {
  return editorTourStore.getState();
}

export function subscribeEditorTour(listener: (state: EditorTourState) => void): () => void {
  return editorTourStore.subscribe(listener);
}

export function useEditorTour<T>(selector: (state: EditorTourState) => T): T {
  return useStore(editorTourStore, selector);
}

export function useEditorTourRunning(): boolean {
  return useStore(editorTourStore, (state) => state.status === 'running');
}
