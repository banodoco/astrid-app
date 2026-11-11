import { useCallback, useEffect, useState } from 'react';
import { EDITOR_TOUR_GALLERY_ACT, useEditorTour } from '@/shared/state/editorTourStore';
import { useEditorTourPaneLockHold } from '@/shared/state/paneLockHolds';
import { EditorTourGenerationsPane } from './EditorTourGenerationsPane';

/**
 * Owns the tour Generations pane's mounting. It mounts from act 2's land (closed, so the stills are decoded before the
 * slide), slides up on the `gallery` beat, and unmounts once it has slid out again and the tour is past it.
 * "Open" follows the store's beat and the beat the card and spotlight show: those trail the store by a few frames, so
 * the pane stays until they have left `gallery`.
 */
export function TourGalleryLayer() {
  // The tour's chat is the Tasks pane and the user's Generations lock must not show around the tour's own.
  useEditorTourPaneLockHold();
  const act = useEditorTour((s) => s.act);
  const beat = useEditorTour((s) => s.beat);
  const shownBeat = useEditorTour((s) => s.shownBeat);
  const reducedMotion = useEditorTour((s) => s.reducedMotion);
  const instant = useEditorTour((s) => s.instant);
  const open = beat === 'gallery' || shownBeat === 'gallery';
  const atLand = act === EDITOR_TOUR_GALLERY_ACT && beat === 'land';
  // Set once the pane has been open and cleared when it reports it has slid out; it stays mounted for that slide.
  const [closing, setClosing] = useState(false);
  useEffect(() => { if (open) setClosing(true); }, [open]);
  const onClosed = useCallback(() => setClosing(false), []);
  if (!open && !atLand && !closing) return null;
  return <EditorTourGenerationsPane open={open} animate={!reducedMotion && !instant} onClosed={onClosed} />;
}
