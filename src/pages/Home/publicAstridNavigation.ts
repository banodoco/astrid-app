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

// A page's expensive visual work can wait until the navigation that mounted it
// has settled. Invalidation also releases the waiter; the loop follows a newer
// transition if one starts before that waiter resumes.
const pendingPageTransitions = new Set<Promise<void>>();
export function hasPendingPublicAstridPageTransition() {
  return pendingPageTransitions.size > 0;
}
export async function waitForPublicAstridPageTransitions() {
  while (pendingPageTransitions.size) await Promise.all([...pendingPageTransitions]);
}
function holdPageTransition() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  pendingPageTransitions.add(promise);
  return () => { pendingPageTransitions.delete(promise); resolve(); };
}

/** The badge has no counterpart in the scrolled header. Map its destination
 * offset through the wordmark's captured box so both travel as one lockup,
 * without inserting a duplicate badge or changing either page's layout. */
function prepareBrandBeta(origin: DOMRect, minkOrigin: DOMRect) {
  const home = document.querySelector('.astrid-public-site[data-astrid-lifecycle="active"]');
  const word = home?.querySelector('.astrid-brand-name')?.getBoundingClientRect();
  const beta = home?.querySelector('.astrid-beta')?.getBoundingClientRect();
  const mink = home?.querySelector<HTMLElement>('.astrid-brand-mink:not(.astrid-brand-mink-glint)');
  const minkBox = mink?.getBoundingClientRect();
  const minkStyle = mink ? getComputedStyle(mink) : null;
  const minkWidth = Number.parseFloat(minkStyle?.width ?? '');
  const minkHeight = Number.parseFloat(minkStyle?.height ?? '');
  if (!word || !beta || !minkBox || !origin.width || !origin.height || !word.width || !word.height ||
      !beta.width || !beta.height || !minkOrigin.width || !minkOrigin.height ||
      !Number.isFinite(minkWidth) || minkWidth <= 0 || !Number.isFinite(minkHeight) || minkHeight <= 0) return;
  const sx = origin.width / word.width;
  const sy = origin.height / word.height;
  const x = origin.x + (beta.x - word.x) * sx;
  const y = origin.y + (beta.y - word.y) * sy;
  const root = document.documentElement;
  root.style.setProperty('--astrid-brand-beta-from', `translate(${x}px, ${y}px) scale(${sx}, ${sy})`);
  root.style.setProperty('--astrid-brand-beta-to', `translate(${beta.x}px, ${beta.y}px) scale(1, 1)`);
  // Use the same authored geometry path for both captures. Mixing a
  // size-changing morph with a transform-only badge can drift between frames.
  root.style.setProperty('--astrid-brand-word-from', `translate(${origin.x}px, ${origin.y}px) scale(${sx}, ${sy})`);
  root.style.setProperty('--astrid-brand-word-to', `translate(${word.x}px, ${word.y}px) scale(1, 1)`);
  root.style.setProperty('--astrid-brand-word-to-width', `${word.width}px`);
  root.style.setProperty('--astrid-brand-word-to-height', `${word.height}px`);
  // The mink's native group morph can advance on a different WebKit clock.
  // Keep its capture at the destination's untransformed size and map its
  // visible bounds with the same transform-only mechanism as the text.
  root.style.setProperty('--astrid-brand-mink-from', `translate(${minkOrigin.x}px, ${minkOrigin.y}px) scale(${minkOrigin.width / minkWidth}, ${minkOrigin.height / minkHeight})`);
  root.style.setProperty('--astrid-brand-mink-to', `translate(${minkBox.x}px, ${minkBox.y}px) scale(${minkBox.width / minkWidth}, ${minkBox.height / minkHeight})`);
  root.style.setProperty('--astrid-brand-mink-width', `${minkWidth}px`);
  root.style.setProperty('--astrid-brand-mink-height', `${minkHeight}px`);
  root.dataset.astridBrandBetaFollow = '';
}

/** Page and audience callbacks share this owner at Site; standalone Home has its own adapter. */
export function usePublicAstridNavigation(environment: PublicAstridEnvironment) {
  const environmentRef = useRef(environment);
  environmentRef.current = environment;
  const operationRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingRef = useRef<{ id: number; commit: () => void; transition?: PublicViewTransition; release?: () => void; committed: boolean } | null>(null);
  const markerOwnerRef = useRef<number | null>(null);

  const clearMarker = useCallback((id: number) => {
    if (markerOwnerRef.current !== id) return;
    markerOwnerRef.current = null;
    delete document.documentElement.dataset.astridPageTransition;
    delete document.documentElement.dataset.astridPageTransitionStyle;
    delete document.documentElement.dataset.astridBrandBetaFollow;
    document.documentElement.style.removeProperty('--astrid-brand-beta-from');
    document.documentElement.style.removeProperty('--astrid-brand-beta-to');
    for (const property of ['from', 'to', 'to-width', 'to-height']) {
      document.documentElement.style.removeProperty(`--astrid-brand-word-${property}`);
    }
    for (const property of ['from', 'to', 'width', 'height']) {
      document.documentElement.style.removeProperty(`--astrid-brand-mink-${property}`);
    }
  }, []);

  const invalidate = useCallback(() => {
    operationRef.current += 1;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      clearMarker(pending.id);
      pending.release?.();
      pending.transition?.skipTransition?.();
    }
  }, [clearMarker]);

  const run = useCallback((commit: () => void, page?: 'home' | 'vision', presentation: 'shared' | 'brand' | 'crossfade' = 'shared') => {
    invalidate();
    const id = operationRef.current;
    let wordmarkOrigin: DOMRect | null = null;
    let minkOrigin: DOMRect | null = null;
    const pending = { id, commit, committed: false, transition: undefined as PublicViewTransition | undefined, release: undefined as (() => void) | undefined };
    pendingRef.current = pending;
    const apply = () => {
      if (!mountedRef.current || operationRef.current !== id || pending.committed) return;
      pending.committed = true;
      flushSync(commit);
      if (markerOwnerRef.current === id && wordmarkOrigin && minkOrigin) prepareBrandBeta(wordmarkOrigin, minkOrigin);
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
      if (page === 'home' && presentation === 'brand') {
        // The marker gives the hidden wordmark its nonzero capture box.
        wordmarkOrigin = document.querySelector('.astrid-vision-brand-name')?.getBoundingClientRect() ?? null;
        minkOrigin = document.querySelector('.astrid-vision-brand img')?.getBoundingClientRect() ?? null;
      }
    }
    const finish = () => {
      // A rejected/skipped transition must still apply the current navigation exactly once.
      apply();
      clearMarker(id);
      pending.release?.();
      if (pendingRef.current?.id === id) pendingRef.current = null;
    };
    try {
      if (page) pending.release = holdPageTransition();
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
