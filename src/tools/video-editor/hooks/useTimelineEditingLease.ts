import { flushSync } from 'react-dom';
import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';
import { isInteractionActive, onInteractionEnd, onInteractionStart, registerTimelineEditAdmission, admitTimelineEdit, type InteractionStateRef } from '@/tools/video-editor/lib/interaction-state.ts';

export const TIMELINE_EDITING_LEASE_TTL_SECONDS = 10;
export const TIMELINE_EDITING_LEASE_RENEW_MS = 3_000;
export const TIMELINE_EDITING_IDLE_MS = 2_000;

const TAB_SESSION_STORAGE_KEY = 'astrid.timeline-editing.tab.v1';
type TabOwner = { id: string; sequence: number; storage?: Storage };

function newTabSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* use the local fallback below */ }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getTabOwner(): TabOwner {
  let storage: Storage | undefined;
  try { storage = typeof sessionStorage === 'undefined' ? undefined : sessionStorage; }
  catch { /* storage can be unavailable in private or embedded contexts */ }
  // Each mounted editor owns its lease independently, including a nested draft
  // in the same browser tab. Its idle/unmount release cannot clear its parent.
  return { id: newTabSessionId(), sequence: 0, storage };
}

function nextSequence(owner: TabOwner): number {
  owner.sequence += 1;
  try { owner.storage?.setItem(TAB_SESSION_STORAGE_KEY, JSON.stringify({ id: owner.id, sequence: owner.sequence })); } catch { /* lease remains best effort */ }
  return owner.sequence;
}

function acknowledgedLease(value: unknown, tabSessionId: string, sequence: number, active: boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  const receipt = data as Record<string, unknown>;
  return receipt.tab_session_id === tabSessionId && receipt.sequence === sequence && receipt.active === active;
}

interface UseTimelineEditingLeaseOptions {
  provider: DataProvider;
  timelineId: string;
  editSeq: number;
  dirty: boolean;
  saving: boolean;
  nestedDraftActive: boolean;
  interactionStateRef: InteractionStateRef;
  shellRootRef?: MutableRefObject<HTMLElement | null>;
  reconcileCanonical?: () => Promise<void>;
}

/** Keeps the App's owner/tab editing lease warm while local timeline work is active. */
export function useTimelineEditingLease({
  provider,
  timelineId,
  editSeq,
  dirty,
  saving,
  nestedDraftActive,
  interactionStateRef,
  shellRootRef,
  reconcileCanonical,
}: UseTimelineEditingLeaseOptions): boolean {
  const canonicalRef = useRef(reconcileCanonical);
  canonicalRef.current = reconcileCanonical;
  const leaseApi = provider.timelineEditingLease;
  const ownerRef = useRef<TabOwner>();
  if (!ownerRef.current) ownerRef.current = getTabOwner();
  const owner = ownerRef.current;
  const wantedRef = useRef(false);
  const hasLeaseRef = useRef(false);
  const acknowledgedSequenceRef = useRef<number | null>(null);
  const latestSequenceRef = useRef<number | null>(null);
  const activeInputsRef = useRef({ dirty, saving, nestedDraftActive });
  activeInputsRef.current = { dirty, saving, nestedDraftActive };
  const interactionRef = useRef(interactionStateRef);
  interactionRef.current = interactionStateRef;
  const rootRef = useRef(shellRootRef);
  rootRef.current = shellRootRef;
  const lastActivityAtRef = useRef(0);
  const lastEditSeqRef = useRef(editSeq);
  const previousSavePendingRef = useRef(dirty || saving);
  const reconcileRef = useRef<() => void>(() => {});
  const composingRef = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useLayoutEffect(() => {
    if (!leaseApi || !timelineId) return;
    let mounted = true;
    let ownershipGeneration = 0;
    let admitted = false;
    let reconciling = false;
    let replaying = false;
    let settledSequence = -1;
    let presenceOffline = false;
    type PendingText = { value: string; start: number; end: number; anchor: number; focus: number;
      composition?: { start: number; end: number } };
    let pendingText = new WeakMap<Element, PendingText>();
    const textState = (target: HTMLInputElement | HTMLTextAreaElement): PendingText => {
      const existing = pendingText.get(target);
      if (existing) return existing;
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      const backwards = target.selectionDirection === 'backward';
      const state = { value: target.value, start, end, anchor: backwards ? end : start, focus: backwards ? start : end };
      pendingText.set(target, state);
      return state;
    };
    const intents: Array<{ run: () => void; resolve: () => void; reject: (error: unknown) => void }> = [];
    const finishAdmission = async () => {
      if (!mounted || admitted || reconciling || !wantedRef.current || (acknowledgedSequenceRef.current === null && !presenceOffline) || !intents.length) return;
      const generation = ownershipGeneration;
      reconciling = true;
      try {
        await canonicalRef.current?.();
        if (!mounted || !wantedRef.current || generation !== ownershipGeneration) return;
        // Canonical state and its handlers must commit before intent is replayed.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (!mounted || !wantedRef.current || generation !== ownershipGeneration) return;
        admitted = true;
        setAcknowledged(acknowledgedSequenceRef.current !== null);
        lastActivityAtRef.current = Date.now();
        replaying = true;
        while (intents.length) {
          const intent = intents[0];
          try { flushSync(intent.run); intents.shift(); intent.resolve(); }
          catch { admitted = false; setAcknowledged(false); break; }
        }
      } catch { /* retain intent; the next acknowledged heartbeat retries admission */ }
      finally {
        replaying = false;
        reconciling = false;
        interactionStateRef.current.admissionPending = intents.length > 0;
        if (mounted) reconcileRef.current();
      }
    };
    const clearIdleTimer = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const stopHeartbeat = () => {
      if (heartbeatRef.current !== null) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    };
    const startHeartbeat = () => {
      if (heartbeatRef.current !== null) return;
      heartbeatRef.current = setInterval(() => { if (wantedRef.current) sendPut(true); }, TIMELINE_EDITING_LEASE_RENEW_MS);
    };
    const sendPut = (force = false) => {
      if (!mounted || !leaseApi || !timelineId) return;
      if (wantedRef.current && !force && hasLeaseRef.current) return;
      if (!wantedRef.current) ownershipGeneration++;
      const generation = ownershipGeneration;
      wantedRef.current = true;
      hasLeaseRef.current = true;
      startHeartbeat();
      // Heartbeat renewal must preserve the idle-release deadline established
      // after a save acknowledgement. Activity reconciliation owns that timer.
      const sequence = nextSequence(owner);
      latestSequenceRef.current = sequence;
      try {
        void leaseApi.renew(timelineId, owner.id, sequence, TIMELINE_EDITING_LEASE_TTL_SECONDS).then((response) => {
          if (!mounted || !wantedRef.current || ownershipGeneration !== generation) return;
          const accepted = acknowledgedLease(response, owner.id, sequence, true);
          const inactive = acknowledgedLease(response, owner.id, sequence, false);
          if (sequence > settledSequence && (accepted || inactive)) {
            settledSequence = sequence;
            acknowledgedSequenceRef.current = accepted ? sequence : null;
            if (accepted) { presenceOffline = false; if (!canonicalRef.current || admitted) setAcknowledged(true); void finishAdmission(); }
            else { admitted = false; setAcknowledged(false); }
          }
        }).catch((error: unknown) => {
          if (!mounted || !wantedRef.current || ownershipGeneration !== generation) return;
          // The frozen offline recovery lane retains durable local editing when
          // the presence channel is unavailable. An in-flight PUT is never this
          // branch; connected input continues to await acknowledgment.
          if (error instanceof TypeError || error instanceof Error && error.name === 'RuntimeUnavailableError'
            && (error as Error & { failureKind?: string }).failureKind === 'transport') {
            presenceOffline = true;
            void finishAdmission();
          }
        });
      } catch { /* synchronous transport failures are also best effort */ }
    };
    const sendDelete = () => {
      if (!leaseApi || !timelineId || !hasLeaseRef.current) return;
      ownershipGeneration++;
      admitted = false;
      presenceOffline = false;
      pendingText = new WeakMap();
      wantedRef.current = false;
      hasLeaseRef.current = false;
      stopHeartbeat();
      acknowledgedSequenceRef.current = null;
      setAcknowledged(false);
      const sequence = nextSequence(owner);
      latestSequenceRef.current = sequence;
      try { void leaseApi.release(timelineId, owner.id, sequence).catch(() => { /* expiry is the fallback */ }); }
      catch { /* synchronous transport failures leave the Runtime TTL as fallback */ }
    };
    const hasImmediateActivity = () => {
      const inputs = activeInputsRef.current;
      return intents.length > 0 || reconciling || inputs.dirty || inputs.saving || inputs.nestedDraftActive
        || composingRef.current || isInteractionActive(interactionRef.current);
    };
    const reconcile = () => {
      if (!mounted) return;
      const now = Date.now();
      const recentlyActive = lastActivityAtRef.current > 0 && now - lastActivityAtRef.current < TIMELINE_EDITING_IDLE_MS;
      if (hasImmediateActivity()) {
        sendPut();
        return;
      }
      if (recentlyActive) {
        sendPut();
        clearIdleTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          reconcile();
        }, Math.max(0, lastActivityAtRef.current + TIMELINE_EDITING_IDLE_MS - now));
        return;
      }
      clearIdleTimer();
      if (!hasLeaseRef.current) return;
      const remaining = Math.max(0, lastActivityAtRef.current + TIMELINE_EDITING_IDLE_MS - now);
      if (remaining === 0) {
        sendDelete();
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        reconcile();
      }, remaining);
    };
    const markActivity = (forcePut = true) => {
      lastActivityAtRef.current = Date.now();
      // Native capture listeners run before React's input/change handlers.
      // Keep activity in refs: rendering here can restore a controlled input's
      // old value before React has captured what the user just typed.
      if (forcePut) sendPut();
      reconcile();
    };

    if (hasImmediateActivity()) lastActivityAtRef.current = Math.max(lastActivityAtRef.current, Date.now());
    reconcile();

    const onInteractionStarted = () => markActivity(true);
    const onInteractionEnded = () => {
      lastActivityAtRef.current = Date.now();
      reconcile();
    };
    const offStart = onInteractionStart(interactionStateRef, onInteractionStarted);
    const offEnd = onInteractionEnd(interactionStateRef, onInteractionEnded);
    const ownsTarget = (target: EventTarget | null): target is Element => {
      const root = rootRef.current?.current;
      return Boolean(root && target instanceof Element && root.contains(target));
    };
    const admit = (run: () => void): Promise<void> => {
      markActivity(true);
      if (admitted || !canonicalRef.current) { run(); return Promise.resolve(); }
      interactionStateRef.current.admissionPending = true;
      const result = new Promise<void>((resolve, reject) => { intents.push({ run, resolve, reject }); });
      void finishAdmission();
      return result;
    };
    const root = rootRef.current?.current;
    const unregisterAdmission = root && canonicalRef.current ? registerTimelineEditAdmission(root, admit) : () => {};
    const setText = (target: HTMLInputElement | HTMLTextAreaElement, value: string, caret?: number) => {
      if (!target.isConnected) throw new Error('Edit target changed before admission.');
      const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value);
      if (caret !== undefined) { try { target.setSelectionRange(caret, caret); } catch { /* non-text input */ } }
      target.dispatchEvent(new Event('input', { bubbles: true }));
    };
    let pendingGestureTarget: Element | null = null;
    const captureIntent = (event: Event) => {
      const continuation = ['pointermove', 'pointerup', 'mousemove', 'mouseup'].includes(event.type);
      if (!canonicalRef.current || replaying || admitted || (!ownsTarget(event.target) && !(continuation && pendingGestureTarget))) return;
      const target = continuation && pendingGestureTarget ? pendingGestureTarget : event.target as Element;
      if (event.type === 'pointerdown' || event.type === 'mousedown') pendingGestureTarget = target;
      if (event.type === 'pointerup' || event.type === 'mouseup') pendingGestureTarget = null;
      if (['pointermove', 'pointerup', 'mousemove', 'mouseup'].includes(event.type) && !intents.length) return;
      // A key's native text action is captured by beforeinput. Keep that native
      // action alive, while preventing React shortcuts from starting an edit.
      const text = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
        && !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(target.type);
      const keyboard = event instanceof KeyboardEvent;
      const textKey = keyboard && text && !event.ctrlKey && !event.metaKey && (event.key.length === 1 || ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Shift', 'Tab'].includes(event.key));
      let selection: { start: number; end: number } | undefined;
      if (keyboard && text) {
        const state = textState(target);
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          state.start = 0; state.end = Number.MAX_SAFE_INTEGER;
          state.anchor = 0; state.focus = state.value.length;
          selection = { start: 0, end: Number.MAX_SAFE_INTEGER };
        } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          let focus = state.focus;
          if (event.key === 'Home') focus = 0;
          else if (event.key === 'End') focus = state.value.length;
          else if (!event.shiftKey && state.start !== state.end) focus = event.key === 'ArrowLeft' ? state.start : Math.min(state.end, state.value.length);
          else focus = Math.max(0, Math.min(state.value.length, focus + (event.key === 'ArrowLeft' ? -1 : 1)));
          if (!event.shiftKey) state.anchor = focus;
          state.focus = focus;
          state.start = Math.min(state.anchor, focus); state.end = Math.max(state.anchor, focus);
          state.composition = undefined;
          selection = { start: state.start, end: state.end };
        }
      }
      if (event.type === 'compositionstart' && text) {
        const state = textState(target);
        state.composition = { start: state.start, end: state.end };
      }
      const inputType = event.type === 'beforeinput' ? (event as InputEvent).inputType : '';
      const replayableInput = ['insertText', 'insertReplacementText', 'insertFromPaste', 'insertFromDrop',
        'insertCompositionText', 'insertFromComposition', 'insertLineBreak', 'insertParagraph', 'deleteContentBackward', 'deleteContentForward',
        'deleteByCut', 'deleteByDrag'].includes(inputType);
      // For native editing actions without a faithful manual equivalent, the
      // subsequent input supplies the complete intended value before React.
      const nativeInput = event.type === 'beforeinput' && (!event.cancelable || !replayableInput);
      if (!textKey && !nativeInput && event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'beforeinput' && text && nativeInput) { markActivity(true); return; }
      if (event.type === 'beforeinput' && text) {
        const input = event as InputEvent;
        const state = textState(target);
        const composition = ['insertCompositionText', 'insertFromComposition'].includes(input.inputType);
        const start = composition && state.composition ? state.composition.start : state.start;
        const end = composition && state.composition ? state.composition.end : state.end;
        const data = ['insertLineBreak', 'insertParagraph'].includes(input.inputType) ? '\n'
          : input.data ?? input.dataTransfer?.getData('text/plain') ?? '';
        const from = input.inputType === 'deleteContentBackward' && start === end ? Math.max(0, start - 1) : start;
        const to = input.inputType === 'deleteContentForward' && start === end ? end + 1 : end;
        const insert = input.inputType.startsWith('delete') ? '' : data;
        state.value = state.value.slice(0, from) + insert + state.value.slice(to);
        state.start = state.end = state.anchor = state.focus = from + insert.length;
        state.composition = input.inputType === 'insertCompositionText' ? { start: from, end: from + insert.length } : undefined;
        // Preserve the literal field value the person authored while waiting.
        // Canonical reconciliation refreshes the command basis and other fields;
        // it must not splice this input into an intervening writer's text.
        const intendedValue = state.value;
        void admitTimelineEdit(root, () => {
          setText(target, intendedValue, from + insert.length);
          pendingText.delete(target);
        }).catch(() => {});
        return;
      }
      if (event.type === 'input' && text) {
        // Programmatic/native replacement (including IME final text) has already
        // reached the DOM but has not reached React or the timeline draft.
        const value = target.value;
        const caret = target.selectionStart ?? value.length;
        pendingText.set(target, { value, start: caret, end: caret, anchor: caret, focus: caret });
        const tracker = (target as HTMLInputElement & { _valueTracker?: { getValue(): string } })._valueTracker;
        if (tracker) {
          const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, tracker.getValue());
        }
        void admitTimelineEdit(root, () => setText(target, value, caret)).catch(() => {});
        return;
      }
      const Constructor = event.constructor as new (type: string, init: EventInit) => Event;
      const clone = new Constructor(event.type, event);
      void admitTimelineEdit(root, () => {
        if (!target.isConnected) throw new Error('Edit target changed during admission; intent retained.');
        if (event.type === 'pointerdown' || event.type === 'mousedown') (target as HTMLElement).focus?.();
        if (selection && text) { try { target.setSelectionRange(selection.start, selection.end); } catch { /* non-text field */ } }
        target.dispatchEvent(clone);
      }).catch(() => {});
    };
    const admissionEvents = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'keydown', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend'];
    for (const type of admissionEvents) window.addEventListener(type, captureIntent, true);
    const onTextInput = (event: Event) => {
      if (!ownsTarget(event.target)) return;
      if (event.type === 'input' || event.type === 'beforeinput') markActivity(true);
    };
    const onCompositionStart = (event: Event) => {
      if (!ownsTarget(event.target)) return;
      composingRef.current = true;
      markActivity(true);
    };
    const onCompositionEnd = (event: Event) => {
      if (!ownsTarget(event.target)) return;
      composingRef.current = false;
      markActivity(false);
    };
    const onBlur = (event: FocusEvent) => {
      if (!ownsTarget(event.target) || ownsTarget(event.relatedTarget)) return;
      composingRef.current = false;
      lastActivityAtRef.current = 0;
      reconcile();
    };
    const renewIfActive = () => { if (hasImmediateActivity() || lastActivityAtRef.current > Date.now() - TIMELINE_EDITING_IDLE_MS) sendPut(true); };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') renewIfActive(); };
    const onPageShow = () => renewIfActive();
    const onPageHide = () => { if (hasLeaseRef.current) sendDelete(); };
    reconcileRef.current = reconcile;
    document.addEventListener('beforeinput', onTextInput, true);
    document.addEventListener('input', onTextInput, true);
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    document.addEventListener('focusout', onBlur, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mounted = false;
      clearIdleTimer();
      stopHeartbeat();
      unregisterAdmission();
      for (const type of admissionEvents) window.removeEventListener(type, captureIntent, true);
      interactionStateRef.current.admissionPending = false;
      for (const intent of intents.splice(0)) intent.reject(new Error('Timeline edit owner replaced before admission.'));
      offStart();
      offEnd();
      document.removeEventListener('beforeinput', onTextInput, true);
      document.removeEventListener('input', onTextInput, true);
      document.removeEventListener('compositionstart', onCompositionStart, true);
      document.removeEventListener('compositionend', onCompositionEnd, true);
      document.removeEventListener('focusout', onBlur, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      sendDelete();
    };
  }, [interactionStateRef, leaseApi, owner, provider, shellRootRef, timelineId]);

  useLayoutEffect(() => {
    const wasPendingSave = previousSavePendingRef.current;
    const isPendingSave = dirty || saving;
    if (wasPendingSave && !isPendingSave) lastActivityAtRef.current = Date.now();
    previousSavePendingRef.current = isPendingSave;
    if (editSeq !== lastEditSeqRef.current) {
      lastEditSeqRef.current = editSeq;
      lastActivityAtRef.current = Date.now();
    }
    reconcileRef.current();
  }, [dirty, editSeq, nestedDraftActive, saving]);

  return acknowledged && acknowledgedSequenceRef.current !== null;
}
