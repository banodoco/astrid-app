import React from 'react';
import type { GeneratedImageWithMetadata } from '../../MediaGallery/types';
import { parseRatio } from '@/shared/lib/media/aspectRatios';

const MIN_PADDING = 60;
const MAX_PADDING = 200;

function clampPadding(value: number): number {
  return Math.min(Math.max(value, MIN_PADDING), MAX_PADDING);
}

export function extractResolutionFromMetadata(image: GeneratedImageWithMetadata): { width?: number; height?: number } {
  let width = image.metadata?.width;
  let height = image.metadata?.height;

  if (width && height) {
    return { width, height };
  }

  const resolution = image.metadata?.originalParams?.orchestrator_details?.resolution;
  if (resolution && typeof resolution === 'string' && resolution.includes('x')) {
    const [parsedWidth, parsedHeight] = resolution.split('x').map(Number);
    if (!isNaN(parsedWidth) && !isNaN(parsedHeight)) {
      width = parsedWidth;
      height = parsedHeight;
    }
  }

  return { width, height };
}

export function resolveAspectRatioPadding(
  image: GeneratedImageWithMetadata,
  projectAspectRatio?: string,
): string {
  if (projectAspectRatio) {
    const ratio = parseRatio(projectAspectRatio);
    if (!isNaN(ratio)) {
      const calculatedPadding = (1 / ratio) * 100;
      return `${clampPadding(calculatedPadding)}%`;
    }
  }

  const { width, height } = extractResolutionFromMetadata(image);
  if (width && height) {
    return `${clampPadding((height / width) * 100)}%`;
  }

  return '100%';
}

/** The selected look of a gallery tile: a sky outline drawn inside its border. */
export const MEDIA_GALLERY_TILE_SELECTED_CLASS = 'outline outline-2 outline-sky-400 -outline-offset-2 ';

export function mediaGalleryTileClassName({
  isSelected,
  isDragging,
  isMobile,
}: {
  isSelected: boolean;
  isDragging: boolean;
  isMobile: boolean;
}): string {
  return `border rounded-lg overflow-hidden hover:shadow-md transition-[opacity,transform] duration-200 relative group bg-card ${
    isSelected ? MEDIA_GALLERY_TILE_SELECTED_CLASS : ''
  }${
    isDragging ? 'opacity-50 scale-75' : ''
  } ${!isMobile ? 'cursor-grab active:cursor-grabbing' : ''}`;
}

interface MediaGalleryTileFrameProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> {
  isSelected?: boolean;
  isDragging?: boolean;
  isMobile?: boolean;
  /** CSS `padding-bottom` of the image box (see `resolveAspectRatioPadding`). */
  aspectRatioPadding: string;
  minHeight: string;
  /** The image/video/audio element(s), placed inside the image box. */
  media: React.ReactNode;
  'data-gallery-item-id'?: string;
  draggable?: boolean;
}

/**
 * The outer frame of one gallery tile: border, selected outline, and the aspect-ratio image box with its
 * minimum height. Everything else (overlay controls, drag and pointer handlers) is the caller's. Pure props,
 * so surfaces without the gallery's contexts (the first-run tour's pane) draw the same tile.
 */
export const MediaGalleryTileFrame: React.FC<MediaGalleryTileFrameProps> = ({
  isSelected = false,
  isDragging = false,
  isMobile = false,
  aspectRatioPadding,
  minHeight,
  media,
  children,
  ...wrapperProps
}) => (
  <div {...wrapperProps} className={mediaGalleryTileClassName({ isSelected, isDragging, isMobile })}>
    {/* Image layer */}
    <div
      style={{
        paddingBottom: aspectRatioPadding,
        minHeight: minHeight
      }}
      className="relative bg-muted/50"
    >
      {media}
    </div>
    {children}
  </div>
);
