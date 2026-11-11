import { useEffect, useRef, useState } from 'react';
import { useEditorTour, type EditorTourAct, type EditorTourBeat } from '@/shared/state/editorTourStore';

/**
 * Each act's result has the stage to itself before its explainer appears: the "watch". The clock starts when the result
 * is actually being presented (`ready.timeline`: playback started on acts 1 and 3, the four-frame walk finished on act 2),
 * so a slow load never eats the hold. Act 2's walk is itself the watch, so its hold is only a breath.
 */
export const LAND_WATCH_HOLD_MS: Record<EditorTourAct, number> = { 1: 2000, 2: 300, 3: 3000 };
/** If the result never reports that it is playing, the explainer comes anyway (its Next still waits for the timeline). */
export const LAND_WATCH_CAP_MS = 9000;
/**
 * What stands in for the card during the watch. True: its counter row alone ("1 of 3 · Back … Skip tour"), a quiet bar
 * where the card will be, which then unfolds into the explainer. False: nothing at all; the explainer fades in in place.
 */
export const LAND_WATCH_PILL = true;

/**
 * Whether a land beat is still in its watch. Never on Back (`instant`) or with reduced motion: the explainer is there at
 * once. Enter (the runner's skip, as for any unfinished animation) ends the watch immediately. No store beat of its own.
 */
export function useLandWatch(beatKey: string, act: EditorTourAct, beat: EditorTourBeat): boolean {
  const instant = useEditorTour((s) => s.instant);
  const reducedMotion = useEditorTour((s) => s.reducedMotion);
  const presented = useEditorTour((s) => s.ready.timeline);
  const skipAnimation = useEditorTour((s) => s.skipAnimation);
  const [released, setReleased] = useState<string | null>(null);
  const eligible = beat === 'land' && !instant && !reducedMotion;
  const skipAtStart = useRef({ beatKey, skipAnimation });
  if (skipAtStart.current.beatKey !== beatKey) skipAtStart.current = { beatKey, skipAnimation };
  const skipped = skipAnimation !== skipAtStart.current.skipAnimation;

  useEffect(() => {
    if (!eligible) return undefined;
    if (skipped) {
      setReleased(beatKey);
      return undefined;
    }
    const timer = setTimeout(() => setReleased(beatKey), presented ? LAND_WATCH_HOLD_MS[act] : LAND_WATCH_CAP_MS);
    return () => clearTimeout(timer);
  }, [eligible, presented, skipped, beatKey, act]);

  return eligible && released !== beatKey;
}
