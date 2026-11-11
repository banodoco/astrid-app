import { useEffect, useRef, useState } from 'react';
import { markEditorTourReady, useEditorTour } from '@/shared/state/editorTourStore';

/** The card's rise, its visual's one pass and the strip filling in (the longest delay plus its animation). */
export const TOUR_CARD_ENTRANCE_MS = 1500;

/**
 * Plays the card's entrance (`entranceMs` long) once per `key`, then settles: everything rests in its end state (a video may
 * finish playing and hold its last frame) and, when `reportsReady`, the card marks itself ready. A `skipAnimation` bump settles it at
 * once; reduced motion, and arriving by Back (`instant`), start settled (Back still plays a video). While the card is still
 * travelling (`arrived` false) the entrance has not started: its clock starts as the card comes to rest.
 */
export function useTourCardEntrance(
  key: string,
  reportsReady: boolean,
  entranceMs: number = TOUR_CARD_ENTRANCE_MS,
  arrived = true,
): { settled: boolean; reducedMotion: boolean } {
  const reducedMotion = useEditorTour((state) => state.reducedMotion);
  const instant = useEditorTour((state) => state.instant);
  const skipAnimation = useEditorTour((state) => state.skipAnimation);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const skipAtStart = useRef(skipAnimation);
  const still = reducedMotion || instant;
  const settled = still || settledKey === key;

  useEffect(() => {
    skipAtStart.current = skipAnimation;
    // A skip bump must not restart the entrance; it only settles it (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!arrived) return;
    const timer = window.setTimeout(() => setSettledKey(key), entranceMs);
    return () => window.clearTimeout(timer);
  }, [key, arrived, entranceMs]);

  useEffect(() => {
    if (skipAnimation !== skipAtStart.current) setSettledKey(key);
  }, [skipAnimation, key]);

  useEffect(() => {
    if (settled && reportsReady) markEditorTourReady('card');
  }, [settled, reportsReady, key]);

  return { settled, reducedMotion };
}
