import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PublicAstridShell } from './PublicAstridShell.tsx';
import { PublicAstridVision } from './PublicAstridVision.tsx';
import { VISION_PATH } from './publicAstridLinks';
import { PUBLIC_ASTRID_SHARE_PAGES } from './publicAstridShare';
import { usePublicAstridEnvironment } from './publicAstridLifecycle';
import { readPublicAstridExperience, usePublicAstridNavigation, writePublicAstridExperience } from './publicAstridNavigation';
import type { PublicAstridExperience } from './publicAstridMotion';
import { usePublicAstridSkySession } from './usePublicAstridSkySession';
import { PublicAstridSkyPreview } from './PublicAstridSkyPreview.tsx';
import { parsePublicAstridSkyPreview } from './publicAstridSkyPreviewParam';
import './PublicAstridSite.css';

type PublicAstridPage = 'home' | 'vision';

function pageAtLocation(): PublicAstridPage {
  return window.location.pathname === VISION_PATH ? 'vision' : 'home';
}

/**
 * Home and Vision & Issues are two rooms of one page rather than two page loads, so moving between them is
 * a single View Transition: the brand glides between the hero and Vision's header, the BETA stamp opens
 * out into Vision's "Vision & Issues" label (and folds back into the stamp on the way home), and the rest
 * crossfades with the home page receding behind Vision. The sky is the same on both, so it holds still.
 * Home stays mounted while Vision is open, so coming back keeps App/Agent, the editor and the scroll
 * position exactly as they were.
 */
export function PublicAstridSite() {
  const [page, setPage] = useState<PublicAstridPage>(pageAtLocation);
  const [homeMounted, setHomeMounted] = useState(page === 'home');
  const [experience, setExperience] = useState(readPublicAstridExperience);
  const environment = usePublicAstridEnvironment();
  const skySession = usePublicAstridSkySession(undefined, environment);
  const [skyPreview] = useState(() => parsePublicAstridSkyPreview(window.location.search));
  const { run, invalidate } = usePublicAstridNavigation(environment);
  const pageRef = useRef(page);
  const pendingBackRef = useRef(false);
  const lastHistoryChangeRef = useRef(0);
  const homeUrlRef = useRef(page === 'home' ? window.location.href : '/');
  const homeScrollRef = useRef(0);

  // This room switch owns its scroll targets. Native history restoration
  // must not move the outgoing page before its transition snapshot.
  useLayoutEffect(() => {
    if (!('scrollRestoration' in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      if (window.history.scrollRestoration === 'manual') window.history.scrollRestoration = previous;
    };
  }, []);

  const show = useCallback((next: PublicAstridPage) => {
    const nextExperience = next === 'home' ? readPublicAstridExperience() : null;
    const outgoingScroll = window.scrollY;
    const incomingScroll = next === 'vision' ? 0 : homeScrollRef.current;
    // Off-screen heroes are not useful morphing anchors. Crossfade instead.
    const presentation = outgoingScroll > 72 || incomingScroll > 72 ? 'crossfade' : 'shared';
    const commit = () => {
      const previous = pageRef.current;
      if (previous === 'home' && next === 'vision') homeScrollRef.current = outgoingScroll;
      pageRef.current = next;
      document.title = PUBLIC_ASTRID_SHARE_PAGES[next].title;
      setPage(next);
      if (next === 'home') {
        setHomeMounted(true);
        setExperience(nextExperience!);
      }
      if (previous === next) return;
      // Focus the incoming room after React commits it, without changing its scroll target.
      pendingFocusRef.current = next;
    };
    run(commit, pageRef.current !== next ? next : undefined, presentation);
  }, [run]);
  const pendingFocusRef = useRef<PublicAstridPage | null>(null);

  // run() flushes React inside the update callback. Settle focus and scroll
  // in the layout phase, before paint and before the incoming snapshot.
  useLayoutEffect(() => {
    document.title = PUBLIC_ASTRID_SHARE_PAGES[page].title;
    if (!environment.visible || pendingFocusRef.current !== page) return;
    pendingFocusRef.current = null;
    const target = document.querySelector<HTMLElement>(page === 'vision' ? '.astrid-vision' : '.astrid-public-site');
    target?.focus({ preventScroll: true });
    window.scrollTo({ left: 0, top: page === 'vision' ? 0 : homeScrollRef.current, behavior: 'instant' });
  }, [page, environment.visible]);

  useEffect(() => {
    const onPopState = () => {
      pendingBackRef.current = false;
      lastHistoryChangeRef.current = 0;
      show(pageAtLocation());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [show]);

  const openVision = useCallback(() => {
    if (pageAtLocation() === 'vision' || pendingBackRef.current) return;
    homeUrlRef.current = window.location.href;
    window.history.pushState({ astridPage: 'vision' }, '', VISION_PATH);
    show('vision');
  }, [show]);

  const goHome = useCallback(() => {
    if (pendingBackRef.current) return;
    // Opened from home: step back through history, as the browser's Back button would.
    if ((window.history.state as { astridPage?: string } | null)?.astridPage === 'vision') {
      // Invalidate even if the deferred Vision commit has not changed the rendered page yet.
      invalidate();
      pendingBackRef.current = true;
      window.history.back();
      return;
    }
    window.history.pushState(null, '', homeUrlRef.current);
    show('home');
  }, [invalidate, show]);

  const changeExperience = useCallback((next: PublicAstridExperience) => {
    if (pageAtLocation() !== 'home' || pendingBackRef.current) return;
    const current = readPublicAstridExperience();
    if (current.audience !== next.audience) {
      const now = Date.now();
      writePublicAstridExperience(next, now - lastHistoryChangeRef.current < 350);
      lastHistoryChangeRef.current = now;
    }
    run(() => setExperience(next));
  }, [run]);

  return (
    <>
      {homeMounted && (
        // Set aside rather than display: none, which would restart the editor's entrance animations when
        // the page comes back (see [data-astrid-page-away] in PublicAstridSite.css). Inert while away.
        <div data-astrid-page-away={page !== 'home' || undefined} aria-hidden={page !== 'home' || undefined} {...(page !== 'home' ? { inert: '' } : {})}>
          <PublicAstridShell
            onOpenVision={openVision}
            lifecycle={page === 'home' ? 'active' : 'retained'}
            environment={environment}
            navigation={{ experience, onExperienceChange: changeExperience }}
            skySession={skySession}
          />
        </div>
      )}
      {page === 'vision' && <PublicAstridVision onGoHome={goHome} environment={environment} skySession={skySession} />}
      {skyPreview && <PublicAstridSkyPreview session={skySession} request={skyPreview} />}
    </>
  );
}
