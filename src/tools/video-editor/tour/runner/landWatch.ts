import { useEffect, useRef, useState } from 'react';
import { useEditorTour, type EditorTourAct, type EditorTourBeat } from '@/shared/state/editorTourStore';

/**
 * Each act's result has the stage to itself before its explainer appears: the "watch". No card is shown meanwhile (the
 * owner tried a small counter bar there and found a card with nothing in it pointless); the explainer then fades in in place. The clock starts when the result
 * is actually being presented (`ready.timeline`: playback started on acts 1 and 3, the four-frame walk finished on act 2),
 * so a slow load never eats the hold. Act 2's walk is itself the watch, so its hold is only a breath.
 */
export const LAND_WATCH_HOLD_MS: Record<EditorTourAct, number> = { 1: 2000, 2: 300, 3: 3000 };
/**
 * The longest a watch lasts, from the moment the beat begins, whatever the result does: if it never reports that it is
 * playing, or reports it late, the explainer comes by then (a hold that starts late is cut short, never added on top).
 */
export const LAND_WATCH_CAP_MS = 9000;
/** A watch step's key is its explainer step's key plus this. */
export const WATCH_SUFFIX = ':watch';

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
  // One visit of the beat: leaving it (Back makes it `instant`, any other beat is not land) ends the visit, so landing
  // again later, forward, watches again.
  const visit = `${beatKey}:${eligible}`;
  const skipAtStart = useRef({ visit, skipAnimation });
  if (skipAtStart.current.visit !== visit) skipAtStart.current = { visit, skipAnimation };
  const skipped = skipAnimation !== skipAtStart.current.skipAnimation;

  useEffect(() => {
    if (!eligible) setReleased(null);
  }, [eligible]);

  const began = useRef({ visit, at: performance.now() });
  if (began.current.visit !== visit) began.current = { visit, at: performance.now() };

  useEffect(() => {
    if (!eligible) return undefined;
    if (skipped) {
      setReleased(beatKey);
      return undefined;
    }
    const capLeft = Math.max(0, LAND_WATCH_CAP_MS - (performance.now() - began.current.at));
    const timer = setTimeout(() => setReleased(beatKey), presented ? Math.min(LAND_WATCH_HOLD_MS[act], capLeft) : capLeft);
    return () => clearTimeout(timer);
  }, [eligible, presented, skipped, beatKey, act]);

  return eligible && released !== beatKey;
}
