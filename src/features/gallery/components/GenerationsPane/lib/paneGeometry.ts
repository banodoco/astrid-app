import { useMemo } from 'react';
import { useContainerWidth } from '@/shared/components/MediaGallery/hooks/useContainerWidth';
import { calculateGalleryLayout } from '@/shared/components/MediaGallery/utils';
import { useIsMobile } from '@/shared/hooks/mobile';
import {
  computePaneLayout,
  parseProjectRatio,
  type PaneLayout,
  type PaneLayoutInput,
} from './paneGridLayout';

/**
 * The Generations pane's geometry: how many columns and rows it shows, how tall it is. Imports no contexts, so
 * the first-run tour's own pane lays itself out exactly as the real one does.
 */

// Fallback rows for pane (smaller than full page galleries)
export const PANE_ROWS = 2;
export const PANE_ROWS_EXPANDED = 3;

// Pixels the gallery surface adds around its grid (see the container classes in GenerationsPaneGallery).
/** The controls bar above the grid: `py-2` (16px) around an `h-7` (28px) row. */
export const PANE_BAR_HEIGHT = 44;
/** The pane's `border-t`, counted in its border-box height. */
export const PANE_BORDER_HEIGHT = 1;
export const PANE_CHROME_HEIGHT = PANE_BAR_HEIGHT + PANE_BORDER_HEIGHT;
/**
 * Tile model of MediaGalleryItem: the image box has padding-bottom = clamp(100 / ratio, 60%, 200%) of the tile
 * width and min-height 120px, inside a 1px border top and bottom. Audio tiles use 160px instead.
 */
export const TILE_PADDING_MIN_PERCENT = 60;
export const TILE_PADDING_MAX_PERCENT = 200;
export const TILE_MIN_HEIGHT = 120;
export const TILE_BORDER_HEIGHT = 2;
/** Gallery container `pt-2`. */
export const PANE_GRID_TOP_PADDING = 8;
/** Gallery container `pb-2`. */
export const PANE_GRID_BOTTOM_PADDING = 8;
/** Breakpoint for the grid gap (`sm`). */
export const MOBILE_BREAKPOINT_PX = 640;
/** Grid gap: `gap-2` below the `sm` breakpoint, `sm:gap-4` from it. */
export const MOBILE_GRID_GAP = 8;
export const DESKTOP_GRID_GAP = 16;

export type PaneGeometry = Omit<PaneLayoutInput, 'itemCount'>;

export interface PaneDisplayLayout {
  cols: number;
  rows: number;
  /** Page size. Always cols * maxRows, so a page fills the grid exactly. */
  itemsPerPage: number;
  /** Grid width when the tiles were shrunk to fit the cap; undefined means the full container width. */
  gridWidth: number | undefined;
  /** Pane content height (controls bar, padding and grid) in px. */
  paneHeight: number;
}

/**
 * Stage 2 of the layout: rows follow the item count, columns and tile sizes stay those of stage 1.
 * Page size never depends on the item count, so only the rows change between pages of one set.
 */
export function resolvePaneDisplay(
  geometry: PaneGeometry,
  stage1: PaneLayout,
  cols: number,
  itemCount: number,
): PaneDisplayLayout {
  const itemsPerPage = cols * geometry.maxRows;
  const final = computePaneLayout({ ...geometry, baseCols: cols, itemCount });
  // Tiles were shrunk to fit the cap, so keep stage 1's tile size for the final row count.
  const imageHeight = stage1.constrained ? stage1.cellHeight : final.cellHeight;
  const rowHeight = Math.max(imageHeight, TILE_MIN_HEIGHT) + TILE_BORDER_HEIGHT;
  const gridHeight = final.rows * rowHeight + (final.rows - 1) * geometry.gap;
  return {
    cols,
    rows: final.rows,
    itemsPerPage,
    gridWidth: stage1.constrained ? stage1.gridWidth : undefined,
    paneHeight: geometry.chromeHeight + geometry.topPadding + geometry.bottomPadding + gridHeight,
  };
}

/** Width / height of a tile's image box, as MediaGalleryItem renders it (the padding is clamped). */
export function tileRatio(projectAspectRatio: string | undefined): number {
  const percent = 100 / parseProjectRatio(projectAspectRatio);
  const clamped = Math.min(Math.max(percent, TILE_PADDING_MIN_PERCENT), TILE_PADDING_MAX_PERCENT);
  return 100 / clamped;
}

export const usePaneGeometry = (
  projectAspectRatio: string | undefined,
  expandedRows: boolean,
  cap: number,
) => {
  const isMobile = useIsMobile();
  const [galleryContainerRef, containerWidth] = useContainerWidth();
  const maxRows = expandedRows ? PANE_ROWS_EXPANDED : PANE_ROWS;

  const geometry = useMemo((): PaneGeometry => {
    const narrow = window.innerWidth < MOBILE_BREAKPOINT_PX;
    return {
      // useContainerWidth reports the content box, so the gallery padding is already excluded.
      width: containerWidth,
      ratio: tileRatio(projectAspectRatio),
      gap: narrow ? MOBILE_GRID_GAP : DESKTOP_GRID_GAP,
      baseCols: calculateGalleryLayout(projectAspectRatio, isMobile, containerWidth, undefined, true).columns,
      maxRows,
      cap,
      chromeHeight: PANE_CHROME_HEIGHT,
      topPadding: PANE_GRID_TOP_PADDING,
      bottomPadding: PANE_GRID_BOTTOM_PADDING,
    };
  }, [projectAspectRatio, isMobile, containerWidth, maxRows, cap]);

  return {
    galleryContainerRef,
    geometry,
    isMobile,
    /** False until the container has been measured. */
    measured: containerWidth > 0,
  };
};

