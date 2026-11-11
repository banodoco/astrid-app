import { SCALE_SECONDS } from '@/tools/video-editor/lib/coordinate-utils.ts';
import { clampTimelineScaleWidth } from '@/tools/video-editor/lib/timeline-scale.ts';
import { TOUR_SCENE_SECONDS } from './tourStages.ts';

/** Breathing room kept right of the 14 s mark, so the last clip's edge is never against the scrollbar. */
export const TOUR_VIEWPORT_RIGHT_MARGIN_PX = 16;

/**
 * The one framing the whole tour keeps: the timeline's left edge at 0 s with all 14 s in view. The tour never
 * scrolls or zooms again after this, so every spotlight on the timeline holds still while only the playhead moves.
 * Returns the zoom (`scaleWidth`, px per `SCALE_SECONDS`) that frames it when the current one does not,
 * or `null` when it already fits (the desktop default always does) or the viewport has not been measured yet.
 * It only ever zooms out.
 */
export function tourFitScaleWidth({ viewportWidth, startLeft, scaleWidth }: {
  viewportWidth: number;
  startLeft: number;
  scaleWidth: number;
}): number | null {
  if (!(viewportWidth > 0)) return null;
  const available = viewportWidth - startLeft - TOUR_VIEWPORT_RIGHT_MARGIN_PX;
  const fitted = clampTimelineScaleWidth(Math.floor((available / TOUR_SCENE_SECONDS) * SCALE_SECONDS));
  return fitted < scaleWidth ? fitted : null;
}
