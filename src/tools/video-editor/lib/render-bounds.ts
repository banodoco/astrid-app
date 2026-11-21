import { computeRenderBounds, getVisibleBoundsFromCrop, normalizeRenderCropValues, resolveClipPlacement } from '@banodoco/timeline-composition';

export { computeRenderBounds, getVisibleBoundsFromCrop, normalizeRenderCropValues };
export type RenderBounds = { x: number; y: number; width: number; height: number };
export type RenderCropValues = { cropTop: number; cropBottom: number; cropLeft: number; cropRight: number };
export type ViewportMediaLayout = { fullBounds: RenderBounds; visibleBounds: RenderBounds; renderBounds: RenderBounds; mediaBounds: RenderBounds; cropValues: RenderCropValues };
export const hasRenderableBounds = (bounds: RenderBounds): boolean => bounds.width > 0 && bounds.height > 0;

// Compatibility adapter for callers that use coordinates relative to the clipped viewport.
export const computeViewportMediaLayout = ({fullBounds, cropValues, compositionWidth, compositionHeight, intrinsicWidth, intrinsicHeight}: {
  fullBounds: RenderBounds; cropValues?: Partial<RenderCropValues>; compositionWidth: number; compositionHeight: number; intrinsicWidth?: number; intrinsicHeight?: number;
}): ViewportMediaLayout | null => {
  const visible = getVisibleBoundsFromCrop(fullBounds, cropValues);
  if (!hasRenderableBounds(computeRenderBounds(visible, compositionWidth, compositionHeight))) return null;
  if (!intrinsicWidth || !intrinsicHeight) throw new Error('Intrinsic media size is required');
  const placement = resolveClipPlacement({clip: {id: 'viewport', ...fullBounds, ...cropValues, fit: 'cover'}, track: {id: 'viewport'}, canvas: {width: compositionWidth, height: compositionHeight}, intrinsic: {width: intrinsicWidth, height: intrinsicHeight}});
  return {fullBounds: placement.local.full, visibleBounds: placement.local.visible, renderBounds: placement.local.clip,
    mediaBounds: {...placement.local.media, x: placement.local.media.x - placement.local.clip.x, y: placement.local.media.y - placement.local.clip.y}, cropValues: placement.crop};
};
