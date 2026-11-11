import { useCallback, useEffect, useState } from 'react';
import { EDITOR_TOUR_GALLERY_ACT, useEditorTour } from '@/shared/state/editorTourStore';
import { useEditorTourPaneLockHold } from '@/shared/state/paneLockHolds';
import { EditorTourGenerationsPane } from './EditorTourGenerationsPane';

/**
 * Owns the tour Generations pane's mounting. It mounts from act 2's land (closed, so the stills are decoded before the
 * slide) and unmounts once it has slid out again and the tour is past it.
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
  const atLand = act === EDITOR_TOUR_GALLERY_ACT && beat === 'land';
  // Set once the pane has been open and cleared when it reports it has slid out; it stays mounted for that slide.
  const [closing, setClosing] = useState(false);
  useEffect(() => { if (open) setClosing(true); }, [open]);
  const onClosed = useCallback(() => setClosing(false), []);
  if (!open && !awaited && !atLand && !closing) return null;
  return <EditorTourGenerationsPane open={open} animate={!reducedMotion} onClosed={onClosed} />;
}
