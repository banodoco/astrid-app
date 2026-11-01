import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { PlayerRef } from '@remotion/player';
import { readFrameMarker, VIDEO_START_FRAME } from './media';
import { promisify } from 'node:util';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { ORIGINAL_640, type ParityCanvas } from './canvas';
import { type RgbFrame } from './compare';
export { assertFrameWithinBound, compareRgbFrames, type FrameComparison, type RgbFrame } from './compare';

const execFileAsync = promisify(execFile);
const PREVIEW_SURFACE = '[data-testid="video-editor-preview-surface"]';
const PLAYER_COMPOSITION = `${PREVIEW_SURFACE} .__remotion-player`;

const RGB_BYTES_PER_PIXEL = 3;
const DECODE_BUFFER_OVERHEAD = 1024;
const MAX_DECODE_BYTES = 256 * 1024 * 1024;

async function ffprobeDimensions(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path,
  ]);
  const stream = (JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0];
  if (!stream?.width || !stream.height) throw new Error(`could not read image dimensions for ${path}`);
  return { width: stream.width, height: stream.height };
}

async function decodeRgb(path: string, args: string[]): Promise<RgbFrame> {
  const dimensions = await ffprobeDimensions(path);
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
    || dimensions.width < 1 || dimensions.height < 1) {
    throw new Error(`invalid decoded frame dimensions for ${path}: ${dimensions.width}x${dimensions.height}`);
  }
  const frameBytes = dimensions.width * dimensions.height * RGB_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(frameBytes) || frameBytes > MAX_DECODE_BYTES) {
    throw new Error(`decoded frame exceeds ${MAX_DECODE_BYTES} byte limit for ${path}: ${dimensions.width}x${dimensions.height}`);
  }
  const { stdout } = await execFileAsync('ffmpeg', [
    '-v', 'error', '-i', path, ...args, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: frameBytes + DECODE_BUFFER_OVERHEAD });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  expect(bytes).toHaveLength(frameBytes);
  return { ...dimensions, bytes };
}

export async function decodeExportFrame(exportPath: string, frame: number): Promise<RgbFrame> {
  return decodeRgb(exportPath, ['-map', '0:v:0', '-an', '-vf', `select=eq(n\\,${frame})`]);
}

export async function decodePlayerCapture(path: string): Promise<RgbFrame> {
  return decodeRgb(path, []);
}

declare global {
  interface Window { __frameParityPlayer: PlayerRef }
}

export async function seekPlayerFrame(page: Page, frame: number): Promise<void> {
  // Reuse the audio harness's test-only React-ref inspection. These are methods
  // on the mounted actual Player; no product debug API or ruler assumptions.
  await page.evaluate((requested) => {
    type Hook = { memoizedState?: { current?: PlayerRef }; next?: Hook };
    type Fiber = { return?: Fiber; memoizedState?: Hook };
    const label = document.querySelector('[data-testid="preview-revision-label"]');
    if (!label) throw new Error('Missing actual Player preview');
    const key = Object.keys(label).find(key => key.startsWith('__reactFiber$'));
    let fiber = key ? (label as unknown as Record<string, Fiber>)[key] : undefined;
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 100; index++, hook = hook.next) {
        const ref = hook.memoizedState?.current;
        if (ref && typeof ref.seekTo === 'function' && typeof ref.setVolume === 'function') {
          window.__frameParityPlayer = ref;
          ref.pause();
          ref.seekTo(requested);
          return;
        }
      }
    }
    throw new Error('Mounted Remotion PlayerRef not found');
  }, frame);
  await expect.poll(() => page.evaluate(() => ({
    frame: window.__frameParityPlayer.getCurrentFrame(),
    playing: window.__frameParityPlayer.isPlaying(),
  })), { timeout: 10_000 }).toEqual({ frame, playing: false });
}

async function waitForRequestedMedia(page: Page, frame: number, canvas: ParityCanvas): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.locator(PLAYER_COMPOSITION).evaluate((element) =>
    Array.from(element.querySelectorAll('img')).every(image => image.complete && image.naturalWidth > 0),
  ), { timeout: 10_000, message: `frame ${frame}: image decode readiness` }).toBe(true);
  if (frame >= VIDEO_START_FRAME) {
    // A prior onVideoFrame/ready attribute is insufficient after a seek. Poll
    // the real managed decoder's canvas (or native fallback) for the exact six
    // bit source-frame marker. Bound: 10 seconds, then fail; never use this
    // source readback as the Player/export screenshot comparator.
    await expect.poll(async () => {
      const bytes = await page.locator(PLAYER_COMPOSITION).evaluate((element, dimensions) => {
        const media = Array.from(element.querySelectorAll('canvas, video')).find(node => {
          const box = node.getBoundingClientRect();
          return box.width === dimensions.width && box.height === dimensions.height && getComputedStyle(node).visibility !== 'hidden';
        }) as HTMLCanvasElement | HTMLVideoElement | undefined;
        if (!media) return [];
        if (media instanceof HTMLVideoElement && (media.readyState < 2 || media.seeking)) return [];
        const probe = document.createElement('canvas');
        probe.width = 640;
        probe.height = 360;
        const context = probe.getContext('2d');
        if (!context) throw new Error('Cannot inspect decoded media marker');
        context.drawImage(media, 0, 0);
        return Array.from(context.getImageData(0, 0, 640, 48).data);
      }, canvas);
      // Canvas readback is RGBA; marker inspection uses the RGB source domain.
      const rgb = new Uint8Array(bytes.length / 4 * 3);
      for (let i = 0; i < bytes.length / 4; i++) rgb.set(bytes.slice(i * 4, i * 4 + 3), i * 3);
      return readFrameMarker(rgb);
    }, { timeout: 10_000, message: `frame ${frame}: managed media must decode source frame ${frame - VIDEO_START_FRAME}` })
      .toBe(frame - VIDEO_START_FRAME);
  }
  await expect(page.getByTestId('preview-loading-placeholder')).toHaveCount(0);
  await expect(page.getByTestId('preview-first-frame-cover')).toHaveCSS('opacity', '0');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.__frameParityPlayer.getCurrentFrame())).toBe(frame);
  await expect(page.getByTestId('preview-media-error')).toHaveCount(0);
}

/** Capture only the native composition viewport after exact Player/media seek. */
export async function capturePlayerFrame(page: Page, frame: number, testInfo: TestInfo, name: string, canvas: ParityCanvas = ORIGINAL_640): Promise<RgbFrame> {
  // Render completion opens a modal above the mounted Player. A locator
  // screenshot includes that modal/backdrop even when the Player is ready.
  const resultDialog = page.getByRole('dialog', { name: 'Rendered film', exact: true });
  if (await resultDialog.isVisible()) {
    await resultDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await resultDialog.waitFor({ state: 'detached' });
  }
  await page.locator('[data-dialog-backdrop]').waitFor({ state: 'detached' });
  await seekPlayerFrame(page, frame);
  const composition = page.locator(PLAYER_COMPOSITION).first();
  await expect(composition).toBeVisible();
  // The production Player fits itself to the editor panel. Constrain only the
  // test host to the composition's native box. A fixed, raised host escapes
  // the editor panel's overflow clipping and sibling chrome; sizing alone can
  // capture those siblings over an otherwise ready decoded frame.
  await page.evaluate((dimensions) => {
    const host = window.__frameParityPlayer.getContainerNode();
    if (!host) throw new Error('Mounted Player has no container');
    host.dataset.frameParityNativeHost = 'true';
    if (document.getElementById('frame-parity-native-size')) return;
    const style = document.createElement('style');
    style.id = 'frame-parity-native-size';
    style.textContent = `[data-frame-parity-native-host="true"] {
      position: fixed !important; left: 32px !important; top: 32px !important;
      z-index: 2147483647 !important;
      width: ${dimensions.width}px !important; height: ${dimensions.height}px !important;
      min-width: ${dimensions.width}px !important; min-height: ${dimensions.height}px !important;
      flex: 0 0 ${dimensions.width}px !important;
    }`;
    document.head.appendChild(style);
  }, canvas);
  await expect.poll(async () => {
    const box = await composition.boundingBox();
    return box ? [box.width, box.height] : null;
  }, { timeout: 5_000 }).toEqual([canvas.width, canvas.height]);

  expect(await page.evaluate(() => window.__frameParityPlayer.getScale())).toBe(1);
  await waitForRequestedMedia(page, frame, canvas);
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
  const output = playerCapturePath(testInfo, frame, name);
  await mkdir(testInfo.outputPath('viewing-parity'), { recursive: true });
  await composition.screenshot({ path: output, animations: 'disabled' });
  const decoded = await decodePlayerCapture(output);
  expect(decoded.width).toBe(canvas.width);
  expect(decoded.height).toBe(canvas.height);
  return decoded;
}

export function playerCapturePath(testInfo: TestInfo, frame: number, name: string): string {
  return testInfo.outputPath(`viewing-parity/player-frame-${String(frame).padStart(3, '0')}-${name}.png`);
}
