import { useEffect, useSyncExternalStore } from 'react';

/**
 * Temporary pane-lock overrides that never touch what the user saved.
 *
 * A page that needs a pane locked (or unlocked) for as long as it is mounted, such as the first-run tour that
 * keeps the chat pane open, acquires a hold. `usePaneLockPolicyState` layers the held values over the user's
 * saved locks for what the app sees; nothing is written to settings or localStorage, so releasing the hold gives
 * the user back exactly what they had. Same shape as `paneControlsHost.ts`: a module store and a release function.
 */
export interface PaneLockHold {
  shots?: boolean;
  tasks?: boolean;
  gens?: boolean;
  editor?: boolean;
}

type Listener = () => void;

const NO_HOLDS: Readonly<PaneLockHold> = Object.freeze({});

let entries: Array<{ hold: Readonly<PaneLockHold> }> = [];
let snapshot: Readonly<PaneLockHold> = NO_HOLDS;
const listeners = new Set<Listener>();

function recompute(): void {
  // Later holds win where two disagree.
  const merged: PaneLockHold = {};
  for (const { hold } of entries) Object.assign(merged, hold);
  snapshot = Object.keys(merged).length === 0 ? NO_HOLDS : Object.freeze(merged);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Readonly<PaneLockHold> {
  return snapshot;
}

/** Holds the given locks until the returned function is called. Calling it twice is harmless. */
export function acquirePaneLockHold(hold: PaneLockHold): () => void {
  const entry = { hold: Object.freeze({ ...hold }) };
  entries = [...entries, entry];
  recompute();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entries = entries.filter((candidate) => candidate !== entry);
    recompute();
  };
}

/** The merged holds in force right now, for code outside React. */
export function getPaneLockHolds(): Readonly<PaneLockHold> {
  return snapshot;
}

/** The merged holds in force right now; an empty object when there are none. */
export function usePaneLockHolds(): Readonly<PaneLockHold> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * What the first-run tour needs: its chat is the Tasks pane, so Tasks reads locked-open; the user's Generations
 * lock reads unlocked, so a locked real gallery neither condenses the tour editor nor shows around the tour's own.
 */
export const EDITOR_TOUR_PANE_LOCK_HOLD: Readonly<PaneLockHold> = Object.freeze({ tasks: true, gens: false });

/** Holds the tour's pane locks while the calling component is mounted. */
export function useEditorTourPaneLockHold(): void {
  useEffect(() => acquirePaneLockHold(EDITOR_TOUR_PANE_LOCK_HOLD), []);
}
