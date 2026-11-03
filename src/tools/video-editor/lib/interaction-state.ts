import type { MutableRefObject } from 'react';

/**
 * Shared drag/resize interaction state observed by the save scheduler, the poll
 * reconciler, and the interaction writers (useClipDrag, TimelineCanvas resize).
 *
 * The `listeners` set lets save/poll register flush callbacks that fire when a
 * gesture ends (both flags back to false). Writers call `notifyInteractionEndIfIdle`
 * after flipping their flag to false.
 */
export interface InteractionState {
  drag: boolean;
  resize: boolean;
  admissionPending?: boolean;
  listeners: Set<() => void>;
  startListeners: Set<() => void>;
}

export type InteractionStateRef = MutableRefObject<InteractionState>;

export function createInteractionState(): InteractionState {
  return { drag: false, resize: false, listeners: new Set(), startListeners: new Set() };
}

export function isInteractionActive(ref: InteractionStateRef): boolean {
  return ref.current.drag || ref.current.resize || ref.current.admissionPending === true;
}

/**
 * Register a callback that fires when the interaction is idle after a previously-
 * active gesture ends. Returns an unsubscribe function.
 */
export function onInteractionEnd(
  ref: InteractionStateRef,
  cb: () => void,
): () => void {
  ref.current.listeners.add(cb);
  return () => {
    ref.current.listeners.delete(cb);
  };
}

export function onInteractionStart(ref: InteractionStateRef, cb: () => void): () => void {
  ref.current.startListeners.add(cb);
  return () => { ref.current.startListeners.delete(cb); };
}

export function notifyInteractionStart(ref: InteractionStateRef): void {
  for (const listener of [...ref.current.startListeners]) {
    try { listener(); } catch (error) { console.error('[interactionState] start listener threw', error); }
  }
}

/**
 * Called by interaction writers after flipping their flag to false. If neither
 * flag is set, every registered end-listener fires once.
 */
export function notifyInteractionEndIfIdle(ref: InteractionStateRef): void {
  if (ref.current.drag || ref.current.resize) {
    return;
  }
  const listeners = [...ref.current.listeners];
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[interactionState] listener threw', error);
    }
  }
}

// The mounted owner also admits programmatic nested-draft entry. DOM entry
// points use the same owner through native capture before React can mutate.
type EditAdmission = (intent: () => void) => Promise<void>;
const editAdmissions = new WeakMap<HTMLElement, EditAdmission>();
export function registerTimelineEditAdmission(root: HTMLElement, admit: EditAdmission): () => void {
  editAdmissions.set(root, admit);
  return () => { if (editAdmissions.get(root) === admit) editAdmissions.delete(root); };
}
export function admitTimelineEdit(root: HTMLElement | null | undefined, intent: () => void): Promise<void> {
  const admit = root ? editAdmissions.get(root) : undefined;
  if (admit) return admit(intent);
  intent();
  return Promise.resolve();
}
