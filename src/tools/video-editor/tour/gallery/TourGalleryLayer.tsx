import { useCallback, useEffect, useState } from 'react';
import { EDITOR_TOUR_GALLERY_ACT, useEditorTour } from '@/shared/state/editorTourStore';
import { useEditorTourPaneLockHold } from '@/shared/state/paneLockHolds';
import { tourIdle } from '../timeline/useTourMediaWarmup';
import { TOUR_MOVE_MS } from '../runner/useSettledRects';
import { EditorTourGenerationsPane } from './EditorTourGenerationsPane';

/** How long after act 2's result has taken the stage the pane is mounted behind it: the move there, and a breath. */
export const TOUR_GALLERY_MOUNT_AFTER_MS = TOUR_MOVE_MS + 240;

/**
 * Owns the tour Generations pane's mounting. It mounts during act 2's land (closed, so the stills are decoded before the
 * slide), a moment after the highlight has moved to the result and in an idle moment: never inside the Send press, where
 * mounting it (the real pane's controls and four tiles) held up everything the press sets off. It unmounts once it has
 * slid out again and the tour is past it.
 * "Open" is the step the card and spotlight SHOW, not the store's beat: the runner commits a step a moment after the
 * store moves (the old card leaves, the targets hold still), and the pane slides in on the very frame the highlight sets
 * off for it, and out on the frame the highlight leaves, with the same duration and easing: one motion, both ways.
 */
export function TourGalleryLayer() {
  // The tour's chat is the Tasks pane and the user's Generations lock must not show around the tour's own.
  useEditorTourPaneLockHold();
  const act = useEditorTour((s) => s.act);
  const beat = useEditorTour((s) => s.beat);
  const shownBeat = useEditorTour((s) => s.shownBeat);
  const reducedMotion = useEditorTour((s) => s.reducedMotion);
  const open = shownBeat === 'gallery';
  // The store is on (or heading back to) the gallery and the highlight has not set off yet: mounted, still closed.
  const awaited = beat === 'gallery';
  // Around the gallery: act 2's land and the gallery itself. Once the pane has been warmed (or opened) it stays mounted
  // at the land, so Back from the gallery leaves it there, closed.
  const around = act === EDITOR_TOUR_GALLERY_ACT && (beat === 'land' || beat === 'gallery');
  const atLand = act === EDITOR_TOUR_GALLERY_ACT && beat === 'land';
  const resultShown = atLand && shownBeat === 'land';
  const [warmed, setWarmed] = useState(false);
  useEffect(() => {
    if (!around) setWarmed(false);
    else if (open) setWarmed(true);
  }, [around, open]);
  useEffect(() => {
    if (!resultShown) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => void tourIdle().then(() => { if (!cancelled) setWarmed(true); }), TOUR_GALLERY_MOUNT_AFTER_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [resultShown]);
  // Set once the pane has been open and cleared when it reports it has slid out; it stays mounted for that slide.
  const [closing, setClosing] = useState(false);
  useEffect(() => { if (open) setClosing(true); }, [open]);
  const onClosed = useCallback(() => setClosing(false), []);
  if (!open && !awaited && !(atLand && warmed) && !closing) return null;
  return <EditorTourGenerationsPane open={open} anchored={open || awaited} animate={!reducedMotion} onClosed={onClosed} />;
}
