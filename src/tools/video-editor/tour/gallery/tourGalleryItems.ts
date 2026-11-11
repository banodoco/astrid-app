import type { GeneratedImageWithMetadata } from '@/shared/components/MediaGallery/types';
import { EDITOR_TOUR_MEDIA } from '../tourMedia';

/** The demo project's aspect ratio, which sets the gallery tiles' shape exactly as a real project's does. */
export const EDITOR_TOUR_GALLERY_RATIO = '16:9';

/** The four stills' names, as the timeline's frame markers call them (tour/timeline/tourStages.ts, TOUR_ANCHORS). */
export const EDITOR_TOUR_GALLERY_LABELS = ['Start frame', 'Mountain frame', 'Descent frame', 'Town frame'] as const;

/**
 * The four bundled stills as gallery items. The URLs are the public
 * bundled files: nothing here needs a Runtime, a project or a generation.
 */
export function buildTourGalleryItems(now: Date = new Date()): GeneratedImageWithMetadata[] {
  const createdAt = now.toISOString();
  return EDITOR_TOUR_MEDIA.stills.map((still, index) => ({
    id: `tour-still-${index + 1}`,
    url: still.url,
    thumbUrl: still.url,
    // The tile's <img> alt text is the prompt.
    prompt: EDITOR_TOUR_GALLERY_LABELS[index],
    type: 'image/png',
    contentType: 'image/png',
    createdAt,
    metadata: { width: still.width, height: still.height },
  }));
}
