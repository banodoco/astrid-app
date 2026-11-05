import { describe, expect, it } from 'vitest';
import { renderPublicAstridSky, skyLevelBounds, skyState } from '@/pages/Home/publicAstridSkyRender';
import { formatClockTime, skyFrame, skyRenderInput } from './TimeOfDayControl';

describe('the brightness clock', () => {
  it('reads times as people say them, midnight to midnight', () => {
    expect(formatClockTime(0)).toBe('12:00 am');
    expect(formatClockTime(8)).toBe('8:00 am');
    expect(formatClockTime(12.5)).toBe('12:30 pm');
    expect(formatClockTime(18.25)).toBe('6:15 pm');
    expect(formatClockTime(24)).toBe('12:00 am');
  });
});

describe('the brightness preview sky', () => {
  const times = { sunrise: 7, sunset: 19 };
  const { firstLight, fullDark } = skyLevelBounds(times);
  const at = (hours: number) => skyState(hours, times);
  // The preview's size in art pixels: about 240 by 100 CSS px at 4 px a pixel.
  const COLUMNS = 60;
  const ROWS = 25;

  /** Painted pixels of the sun or moon alone (no stars or clouds) in the top two thirds, above the hills. */
  function bodyPixelsInView(hours: number, environment = true): number {
    const input = { ...skyRenderInput(COLUMNS, ROWS, at(hours), environment, 'preview'), showEnvironment: false };
    const pixels = renderPublicAstridSky(input);
    let painted = 0;
    for (let y = 0; y < Math.floor(ROWS * 0.62); y += 1) {
      for (let x = 0; x < COLUMNS; x += 1) if (pixels[(y * COLUMNS + x) * 4 + 3] > 0) painted += 1;
    }
    return painted;
  }

  it('shows only the colour when the environment is left out: no sun by day, no moon by night', () => {
    expect(skyFrame(at(13), false, 'preview')).toMatchObject({ showSun: false, moon: 0 });
    expect(skyFrame(at(fullDark), false, 'preview')).toMatchObject({ showSun: false, moon: 0 });
    expect(skyFrame(at(13), false, 'background')).toMatchObject({ showSun: false, moon: 0 });
    const input = skyRenderInput(COLUMNS, ROWS, at(13), false, 'preview');
    expect(renderPublicAstridSky(input).some((value, index) => index % 4 === 3 && value > 0)).toBe(false);
  });

  it('shows the sun by day', () => {
    expect(skyFrame(at(13), true, 'preview')).toMatchObject({ showSun: true, moon: 0 });
    expect(bodyPixelsInView(13)).toBeGreaterThan(0);
  });

  it('shows the moon at full dark, the darkest level a person can choose, and through the night', () => {
    expect(skyFrame(at(fullDark), true, 'preview').moon).toBe(1);
    expect(bodyPixelsInView(fullDark)).toBeGreaterThan(20);
    expect(bodyPixelsInView(0)).toBeGreaterThan(20);
    expect(bodyPixelsInView(4)).toBeGreaterThan(20);
  });

  it('leaves the twilight between sun and moon empty, and lets the moon fade out by first light', () => {
    expect(skyFrame(at(times.sunset + 0.25), true, 'preview')).toMatchObject({ showSun: false, moon: 0 });
    expect(skyFrame(at(firstLight), true, 'preview').moon).toBe(0);
    const dusk = skyFrame(at(times.sunset + 1.2), true, 'preview').moon;
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
  });

  it('keeps the app background on the real moon track', () => {
    const night = at(0);
    const frame = skyFrame(night, true, 'background');
    expect(frame.moon).toBe(1);
    expect(frame.state.progress).toBe(night.progress);
  });
});
