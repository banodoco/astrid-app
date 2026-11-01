import { PARITY_HEIGHT, PARITY_WIDTH, readFrameMarker } from './media';

export const ORIGINAL_640 = Object.freeze({ width: PARITY_WIDTH, height: PARITY_HEIGHT,
  viewport: Object.freeze({ width: 1600, height: 1000 }) });
/** Explicit theme-canvas control for a genuine 640x360 native profile. */
export const EXPLICIT_CANVAS_640 = Object.freeze({ width: PARITY_WIDTH, height: PARITY_HEIGHT,
  viewport: Object.freeze({ width: 1600, height: 1000 }),
  themeCanvas: Object.freeze({ width: PARITY_WIDTH, height: PARITY_HEIGHT, fps: 30 }) });
export const NORMAL_PROFILE_NATIVE1920 = Object.freeze({ width: 1920, height: 1080,
  viewport: Object.freeze({ width: 2000, height: 1200 }) });
export type ParityCanvas = typeof ORIGINAL_640 | typeof EXPLICIT_CANVAS_640 | typeof NORMAL_PROFILE_NATIVE1920;

/** Read readiness cells directly in native RGB; compared pictures are never resized. */
export function readCanvasFrameMarker(bytes: Uint8Array, canvas: ParityCanvas = ORIGINAL_640): number | null {
  if (canvas.width === PARITY_WIDTH && canvas.height === PARITY_HEIGHT) return readFrameMarker(bytes);
  if (bytes.length !== canvas.width * canvas.height * 3) return null;
  const sample = (x: number, y: number) => {
    const offset = ((y * canvas.height / PARITY_HEIGHT) * canvas.width + x * canvas.width / PARITY_WIDTH) * 3;
    return Array.from(bytes.slice(offset, offset + 3));
  };
  if (!sample(250, 24).every(value => value > 220)) return null;
  let frame = 0;
  for (let bit = 0; bit < 6; bit++) {
    const rgb = sample(24 + bit * 40, 24);
    if (rgb.every(value => value > 220)) frame |= 1 << bit;
    else if (!rgb.every(value => value < 35)) return null;
  }
  return frame;
}
