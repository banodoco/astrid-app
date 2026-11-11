import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { TOUR_MOVE_EASE, TOUR_MOVE_MS } from '../runner/useSettledRects';
import { Images } from 'lucide-react';
import { GenerationsPaneControls } from '@/features/gallery/components/GenerationsPane/components/GenerationsPaneControls';
import { GenerationsPaneFrame } from '@/features/gallery/components/GenerationsPane/components/GenerationsPaneFrame';
import { resolvePaneDisplay, usePaneGeometry } from '@/features/gallery/components/GenerationsPane/lib/paneGeometry';
import { computePaneLayout } from '@/features/gallery/components/GenerationsPane/lib/paneGridLayout';
import { PaneControlTab } from '@/shared/components/PaneControlTab';
import { TimeStamp } from '@/shared/components/TimeStamp';
import { usePaneInteractionLifecycle } from '@/shared/components/panes/usePaneInteractionLifecycle';
import { TooltipProvider } from '@/shared/components/ui/tooltip';
import type { GeneratedImageWithMetadata } from '@/shared/components/MediaGallery/types';
import { ImageContent } from '@/shared/components/MediaGalleryItem/components/ImageContent';
import {
  MediaGalleryTileFrame,
  resolveAspectRatioPadding,
} from '@/shared/components/MediaGalleryItem/components/MediaGalleryTileFrame';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';
import { usePaneControlsHosted } from '@/shared/state/paneControlsHost';
import { preferredGenerationsHeight, usePanesStore } from '@/shared/state/panesStore';
import { EDITOR_TOUR_ANCHOR_ATTRIBUTE, EDITOR_TOUR_ANCHORS } from '../anchors';
import { buildTourGalleryItems, EDITOR_TOUR_GALLERY_RATIO } from './tourGalleryItems';

interface EditorTourGenerationsPaneProps {
  /** Slid in. Going false slides it out and then calls `onClosed`. */
  open: boolean;
  /** Slide, with the tour's own move's duration and easing; false jumps straight to the new state. */
  animate: boolean;
  /** The pane has finished sliding out (or was closed without animation). */
  onClosed?: () => void;
  /** Lay the tiles out in this many columns instead of the real pane's geometry (to compare the two by eye). */
  columns?: number;
  /**
   * Whether the resting-rect anchor is there for the tour's spotlight to measure. Defaults to `open`; the tour puts it
   * there as soon as it is heading for the gallery, before the pane opens, because the spotlight decides its move first
   * and the pane then slides with it.
   */
  anchored?: boolean;
}

/** A touch of margin past the 300ms slide, for a `transitionend` that never comes (a hidden tab). */
const CLOSE_FALLBACK_MS = 700;
const NO_OP = () => undefined;

const NO_SHOTS: never[] = [];

/** A tile of the real gallery: its frame and image content, selected, with the timestamp the real tile shows. */
function TourGalleryTile({ image, index }: { image: GeneratedImageWithMetadata; index: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const progressiveRef = useRef<HTMLImageElement | null>(null);
  return (
    <div>
      <MediaGalleryTileFrame
        data-gallery-item-id={image.id}
        isSelected
        isMobile={false}
        aspectRatioPadding={resolveAspectRatioPadding(image, EDITOR_TOUR_GALLERY_RATIO)}
        minHeight="120px"
        media={(
          <ImageContent
            image={image}
            index={index}
            actualSrc={image.url}
            imageLoaded={loaded}
            imageLoadError={failed}
            progressiveEnabled={false}
            isThumbShowing={false}
            isFullLoaded
            progressiveRef={progressiveRef}
            isMobile={false}
            onOpenLightbox={NO_OP}
            onImageLoad={() => setLoaded(true)}
            onImageError={() => setFailed(true)}
            onRetry={() => setFailed(false)}
            setImageLoading={NO_OP}
          />
        )}
      >
        <div className="absolute inset-0 z-10 pointer-events-none [&>*]:pointer-events-auto">
          <TimeStamp createdAt={image.createdAt} position="top-right" showOnHover={false} hideOnHover />
        </div>
      </MediaGalleryTileFrame>
    </div>
  );
}

/**
 * The first-run tour's Generations pane: the real pane's frame, controls, tab, tile frame and image content,
 * assembled from props over the four bundled stills. The real pane cannot run in the tour's host (it needs the
 * Runtime's queries and the Project and Shots contexts), and locking it would save the user's pane settings, so
 * this never touches `panesStore` writes or anything persisted.
 *
 * Mount it a beat before it opens so the four images are decoded by the time it slides in.
 */
export function EditorTourGenerationsPane({ open, animate, onClosed, columns, anchored }: EditorTourGenerationsPaneProps) {
  const touch = usePaneControlsHosted();
  const tasksPaneWidth = usePanesStore((state) => state.tasksPaneWidth);
  const generationsPaneCap = usePanesStore((state) => state.generationsPaneHeight);
  // The Tasks pane's reserved width, as BrowserTourEditor computes it: the chat is a sheet or drawer on touch layouts.
  const reserve = touch ? 0 : tasksPaneWidth;
  const [items] = useState(() => buildTourGalleryItems());

  const { galleryContainerRef, geometry: realGeometry, isMobile, measured } = usePaneGeometry(
    EDITOR_TOUR_GALLERY_RATIO,
    false,
    generationsPaneCap,
  );
  const geometry = useMemo(
    () => (columns ? { ...realGeometry, baseCols: Math.max(1, Math.floor(columns)) } : realGeometry),
    [realGeometry, columns],
  );
  // The real pane sizes its page for a full grid, which at a forced column count would shrink the tiles to the cap and
  // change the count; a forced count sizes for the four tiles that are there.
  const sizedFor = columns ? items.length : geometry.baseCols * geometry.maxRows;
  const stage1 = useMemo(
    () => computePaneLayout({ ...geometry, itemCount: sizedFor }),
    [geometry, sizedFor],
  );
  const cols = measured ? stage1.cols : geometry.baseCols;
  const layout = resolvePaneDisplay(geometry, stage1, cols, items.length);
  const paneHeight = preferredGenerationsHeight(generationsPaneCap, Math.round(layout.paneHeight));

  // Slide state. `slid` is the transform; `closing` spans the slide out.
  const [slid, setSlid] = useState(() => open && !animate);
  const [closing, setClosing] = useState(false);
  const wasOpenRef = useRef(open && !animate);
  const closingRef = useRef(false);
  // The slide shares the tour move's duration and easing, so the pane and the cutout moving onto it arrive together.
  // Set on the element itself: the frame's own classes give the real pane's 300 ms.
  const frameRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.style.transitionDuration = animate ? `${TOUR_MOVE_MS}ms` : '';
    frame.style.transitionTimingFunction = animate ? TOUR_MOVE_EASE : '';
  }, [animate]);
  /** The pane has been on screen, closed, for a frame: a slide can start from where it is at once. */
  const paintedClosedRef = useRef(false);
  const fallbackRef = useRef<number | undefined>(undefined);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  const finishClose = useCallback(() => {
    if (!closingRef.current) return;
    closingRef.current = false;
    window.clearTimeout(fallbackRef.current);
    setClosing(false);
    onClosedRef.current?.();
  }, []);

  useLayoutEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      closingRef.current = false;
      window.clearTimeout(fallbackRef.current);
      setClosing(false);
      if (!animate) {
        setSlid(true);
        return undefined;
      }
      // Already painted closed (it mounts a step early): slide now, before this frame paints, so the pane sets off on the
      // same frame as the spotlight that is moving onto it.
      if (paintedClosedRef.current) {
        setSlid(true);
        return undefined;
      }
      // Mounted open: one frame at the closed position first, so the slide has somewhere to start from.
      let second = 0;
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setSlid(true)); });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }
    setSlid(false);
    if (!wasOpenRef.current) return undefined;
    wasOpenRef.current = false;
    closingRef.current = true;
    if (!animate) {
      finishClose();
      return undefined;
    }
    setClosing(true);
    fallbackRef.current = window.setTimeout(finishClose, CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(fallbackRef.current);
  }, [open, animate, finishClose]);

  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { paintedClosedRef.current = true; }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, []);

  // The controls dim while the pane is arriving, as the real ones do.
  const { isInteractionDisabled } = usePaneInteractionLifecycle({ isOpen: slid, disableInteractionsDuringOpen: true });

  const searchInputRef = useRef<HTMLInputElement>(null!);
  const shotFilterContentRef = useRef<HTMLDivElement>(null!);
  const mediaTypeContentRef = useRef<HTMLDivElement>(null);

  const containerStyle: CSSProperties = {
    position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: UI_Z_LAYERS.EDITOR_TOUR_GALLERY,
  };
  const tabVisible = slid || closing;

  return (
    <TooltipProvider>
      {/* One zero-size box: the pane, its tab and the anchor all hang off it, so nothing here is a screen-sized layer. */}
      <div data-testid="editor-tour-generations" style={containerStyle} {...{ inert: '' }}>
        <GenerationsPaneFrame
          data-testid="editor-tour-generations-pane"
          height={paneHeight}
          left={0}
          right={reserve}
          transformClass={slid ? 'translate-y-0' : 'translate-y-full'}
          ref={frameRef}
          className={animate ? undefined : 'transition-none'}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'transform') finishClose();
          }}
        >
          <div className="flex flex-col h-full min-h-0 pointer-events-none">
            <GenerationsPaneControls
              filters={{
                shots: NO_SHOTS,
                selectedShotFilter: 'all',
                onSelectedShotFilterChange: NO_OP,
                excludePositioned: false,
                onExcludePositionedChange: NO_OP,
                isMobile,
                shotFilterContentRef,
                mediaTypeFilterContentRef: mediaTypeContentRef,
                shotFilterOpen: false,
                onShotFilterOpenChange: NO_OP,
                mediaTypeFilter: 'all',
                onMediaTypeFilterChange: NO_OP,
                mediaTypeFilterOpen: false,
                onMediaTypeFilterOpenChange: NO_OP,
                searchTerm: '',
                onSearchTermChange: NO_OP,
                isSearchOpen: false,
                onSearchOpenChange: NO_OP,
                searchInputRef,
                starredOnly: false,
                onStarredOnlyChange: NO_OP,
                currentShotId: null,
                isSpecialFilterSelected: false,
              }}
              pagination={{
                totalCount: items.length,
                totalIsExact: true,
                perPage: layout.itemsPerPage,
                page: 1,
                onPageChange: NO_OP,
              }}
              interaction={{ isInteractionDisabled: animate && isInteractionDisabled }}
            />
            <div
              ref={galleryContainerRef}
              className="flex-grow px-1 sm:px-3 pt-2 pb-2 overflow-y-auto overscroll-contain flex flex-col"
            >
              {/* The wrapper is a flex item that stretches; the surface inside it centres at the grid's own width. */}
              <div>
                <div className="relative" style={{ width: layout.gridWidth, marginInline: 'auto' }}>
                  <div>
                    <div
                      className="grid gap-2 sm:gap-4 mb-0"
                      style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}
                    >
                      {items.map((image, index) => <TourGalleryTile key={image.id} image={image} index={index} />)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </GenerationsPaneFrame>

        {/* The tab only exists on desktop: touch editors open the gallery from their own bottom bar, so the real
            tab steps aside there too (PaneControlTab returns null while the page hosts the pane controls). */}
        {!touch && (
          <div style={{ visibility: tabVisible ? 'visible' : 'hidden' }}>
            <PaneControlTab
              position={{ side: 'bottom', paneDimension: paneHeight, horizontalOffset: -reserve }}
              state={{ isLocked: slid, isOpen: slid }}
              handlers={{
                toggleLock: NO_OP,
                openPane: NO_OP,
                handlePaneEnter: NO_OP,
                handlePaneLeave: NO_OP,
                customOpenAction: NO_OP,
              }}
              display={{
                customIcon: <Images className="h-4 w-4" />,
                paneTooltip: 'Open Gallery',
                allowMobileLock: true,
                shortcutHint: '⌥S',
              }}
            />
          </div>
        )}

        {/* What the spotlight measures. Not the sliding pane (its rect changes every frame while it arrives): a
            still, invisible box at the rect the pane comes to rest at, so the light settles there at once. */}
        {(anchored ?? open) && (
          <div
            {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.generationsPane }}
            data-testid="editor-tour-generations-anchor"
            aria-hidden="true"
            style={{
              position: 'fixed', left: 0, bottom: 0, right: reserve, height: paneHeight,
              opacity: 0, pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
