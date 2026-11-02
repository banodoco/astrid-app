import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';
import { isInteractionActive, onInteractionEnd, onInteractionStart, type InteractionStateRef } from '@/tools/video-editor/lib/interaction-state.ts';

export const TIMELINE_EDITING_LEASE_TTL_SECONDS = 10;
export const TIMELINE_EDITING_LEASE_RENEW_MS = 3_000;
export const TIMELINE_EDITING_IDLE_MS = 2_000;

const TAB_SESSION_STORAGE_KEY = 'astrid.timeline-editing.tab.v1';
type TabOwner = { id: string; sequence: number; storage?: Storage };
const ownersByStorage = new WeakMap<object, TabOwner>();
let fallbackOwner: TabOwner | undefined;

function newTabSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* use the local fallback below */ }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getTabOwner(): TabOwner {
  let storage: Storage | undefined;
  try {
    storage = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    if (storage) {
      const existing = ownersByStorage.get(storage);
      if (existing) return existing;
    } else if (fallbackOwner) return fallbackOwner;
  } catch { /* storage can be unavailable in private or embedded contexts */ }
  const owner = { id: newTabSessionId(), sequence: 0, storage };
  if (storage) ownersByStorage.set(storage, owner); else fallbackOwner = owner;
  return owner;
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
}: UseTimelineEditingLeaseOptions): boolean {
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
  const [, rerender] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useLayoutEffect(() => {
    if (!leaseApi || !timelineId) return;
    let mounted = true;
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
      clearIdleTimer();
      if (wantedRef.current && !force && hasLeaseRef.current) return;
      wantedRef.current = true;
      hasLeaseRef.current = true;
      startHeartbeat();
      clearIdleTimer();
      const sequence = nextSequence(owner);
      latestSequenceRef.current = sequence;
      acknowledgedSequenceRef.current = null;
      setAcknowledged(false);
      try {
        void leaseApi.renew(timelineId, owner.id, sequence, TIMELINE_EDITING_LEASE_TTL_SECONDS).then((response) => {
          if (!mounted || !wantedRef.current || latestSequenceRef.current !== sequence) return;
          const accepted = acknowledgedLease(response, owner.id, sequence, true);
          acknowledgedSequenceRef.current = accepted ? sequence : null;
          setAcknowledged(accepted);
        }).catch(() => { /* network failure must never interrupt local editing */ });
      } catch { /* synchronous transport failures are also best effort */ }
    };
    const sendDelete = () => {
      if (!leaseApi || !timelineId || !hasLeaseRef.current) return;
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
      return inputs.dirty || inputs.saving || inputs.nestedDraftActive
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
      rerender((value) => value + 1);
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

  return acknowledged && acknowledgedSequenceRef.current === latestSequenceRef.current;
}
