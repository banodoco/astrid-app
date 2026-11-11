import { describe, expect, it } from 'vitest';
import { tourFitScaleWidth } from './tourViewport.ts';

describe('tourFitScaleWidth', () => {
  it('keeps the default zoom on a desktop timeline that already shows 0-14 s', () => {
    expect(tourFitScaleWidth({ viewportWidth: 727, startLeft: 144, scaleWidth: 160 })).toBeNull();
  });

  it('zooms out just enough on a narrow timeline, never in', () => {
    const fitted = tourFitScaleWidth({ viewportWidth: 560, startLeft: 144, scaleWidth: 160 });
    expect(fitted).toBe(Math.floor(((560 - 144 - 16) / 14) * 5));
    // 14 s at that zoom plus the label column and margin fits the viewport.
    expect(144 + (14 * fitted!) / 5 + 16).toBeLessThanOrEqual(560);
    expect(tourFitScaleWidth({ viewportWidth: 560, startLeft: 144, scaleWidth: fitted! })).toBeNull();
    expect(tourFitScaleWidth({ viewportWidth: 3000, startLeft: 144, scaleWidth: 40 })).toBeNull();
  });

  it('stops at the editor minimum zoom and waits for a measured viewport', () => {
    expect(tourFitScaleWidth({ viewportWidth: 200, startLeft: 144, scaleWidth: 160 })).toBe(40);
    expect(tourFitScaleWidth({ viewportWidth: 0, startLeft: 144, scaleWidth: 160 })).toBeNull();
  });
});
