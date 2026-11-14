import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { PublicAstridEnvironment } from './publicAstridLifecycle';
import type { PublicAstridExperience } from './publicAstridMotion';

export function readPublicAstridExperience(): PublicAstridExperience {
  // App is the public landing experience; explicit Agent links survive reloads.
  return { audience: new URLSearchParams(window.location.search).get('experience') === 'agent' ? 'agent' : 'app' };
}

export function writePublicAstridExperience(next: PublicAstridExperience, replace: boolean) {
  const url = new URL(window.location.href);
  if (next.audience === 'agent') url.searchParams.set('experience', 'agent');
  else url.searchParams.delete('experience');
  url.searchParams.delete('view');
  const entry = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
  window.history[replace ? 'replaceState' : 'pushState']({ ...entry, astridExperience: next }, '', url);
}

interface PublicViewTransition {
  finished: Promise<void>;
  skipTransition?: () => void;
}
type TransitionDocument = Document & { startViewTransition?: (update: () => void) => PublicViewTransition };

/** Page and audience callbacks share this owner at Site; standalone Home has its own adapter. */
export function usePublicAstridNavigation(environment: PublicAstridEnvironment) {
  const environmentRef = useRef(environment);
  environmentRef.current = environment;
  const operationRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingRef = useRef<{ id: number; commit: () => void; transition?: PublicViewTransition; committed: boolean } | null>(null);
  const markerOwnerRef = useRef<number | null>(null);

  const clearMarker = useCallback((id: number) => {
    if (markerOwnerRef.current !== id) return;
    markerOwnerRef.current = null;
    delete document.documentElement.dataset.astridPageTransition;
    delete document.documentElement.dataset.astridPageTransitionStyle;
  }, []);

  const invalidate = useCallback(() => {
    operationRef.current += 1;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      clearMarker(pending.id);
      pending.transition?.skipTransition?.();
    }
  }, [clearMarker]);

  const run = useCallback((commit: () => void, page?: 'home' | 'vision', presentation: 'shared' | 'crossfade' = 'shared') => {
    invalidate();
    const id = operationRef.current;
    const pending = { id, commit, committed: false, transition: undefined as PublicViewTransition | undefined };
    pendingRef.current = pending;
    const apply = () => {
      if (!mountedRef.current || operationRef.current !== id || pending.committed) return;
      pending.committed = true;
      flushSync(commit);
    };
    const doc = document as TransitionDocument;
    const inputs = environmentRef.current;
    if (!inputs.visible || inputs.reducedMotion || (!page && inputs.phone) || !doc.startViewTransition) {
      apply();
      pendingRef.current = null;
      return;
    }
    if (page) {
      markerOwnerRef.current = id;
      document.documentElement.dataset.astridPageTransition = page;
      document.documentElement.dataset.astridPageTransitionStyle = presentation;
    }
    const finish = () => {
      // A rejected/skipped transition must still apply the current navigation exactly once.
      apply();
      clearMarker(id);
      if (pendingRef.current?.id === id) pendingRef.current = null;
    };
    try {
      pending.transition = doc.startViewTransition(apply);
      void pending.transition.finished.then(finish, finish);
    } catch {
      finish();
    }
  }, [clearMarker, invalidate]);

  useEffect(() => {
    if (environment.visible && !environment.reducedMotion) return;
    const pending = pendingRef.current;
    if (!pending) return;
    invalidate();
    if (!pending.committed && mountedRef.current) {
      pending.committed = true;
      pending.commit();
    }
  }, [environment.visible, environment.reducedMotion, invalidate]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidate();
    };
  }, [invalidate]);
  return { run, invalidate };
}
