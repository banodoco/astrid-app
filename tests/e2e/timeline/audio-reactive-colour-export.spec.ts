import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AUDIO_REACTIVE_OFFSET_START_FRAME } from '../../../src/test/fakeRuntimeSeed.mjs';
import {
  FAKE_RUNTIME_ORIGIN,
  browserEvidencePath,
  editorUrl,
  fakeRuntimeAuthHeaders,
  readFakeRuntimeComposition,
  resetFakeRuntimeBaseline,
  forceBlobLinkDownload,
} from './support';

const execFileAsync = promisify(execFile);
const TIMELINE_SLUG = 'audio-reactive-colour-timeline';
const OFFSET_TIMELINE_SLUG = 'audio-reactive-colour-offset-timeline';
const EDITOR_URL = editorUrl({ timeline: TIMELINE_SLUG, params: { localBrowserRender: '1' } });
const OFFSET_EDITOR_URL = editorUrl({ timeline: OFFSET_TIMELINE_SLUG, params: { localBrowserRender: '1' } });
const FRAME_COUNT = 18;
const FPS = 30;
const COLOR_TOLERANCE = 10;
const OFFSET_CLIP_START_FRAME = AUDIO_REACTIVE_OFFSET_START_FRAME;
const OFFSET_FRAME_COUNT = FRAME_COUNT + OFFSET_CLIP_START_FRAME;

type ProbeStream = {
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_read_frames?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
};

type Composition = Awaited<ReturnType<typeof readFakeRuntimeComposition>>;

/**
 * The persisted head composition of a seeded timeline, read from the Runtime (not through the editor).
 * A composition without its config, registry and clips is an incomplete fixture: refuse to start a
 * browser export against it.
 */
async function requireCanonicalComposition(
  expectedTimelineId: string,
  purpose: string,
): Promise<Composition> {
  const composition = await readFakeRuntimeComposition(expectedTimelineId);
  for (const part of ['config', 'registry'] as const) {
    expect(
      composition[part] !== null && typeof composition[part] === 'object' && !Array.isArray(composition[part]),
      `${purpose}: canonical ${part} is absent from the head composition of ${expectedTimelineId}; refusing to start a browser export against an incomplete fixture.`,
    ).toBe(true);
  }
  expect(
    Array.isArray(composition.payload.clips),
    `${purpose}: the head composition of ${expectedTimelineId} carries no clips[]`,
  ).toBe(true);
  return composition;
}

/** A write to the timeline: `POST .../timelines/<id>/composition-revisions` (rendering must never make one). */
const isCompositionPublish = (method: string, pathname: string): boolean => (
  method === 'POST' && /\/timelines\/[^/]+\/composition-revisions$/.test(pathname)
);

function expectedRgb(
  frame: number,
  clipStartFrame = 0,
  initialRgb: readonly [number, number, number] = [0, 0, 0],
): readonly [number, number, number] {
  const clipRelativeFrame = frame - clipStartFrame;
  if (clipRelativeFrame < 0) return [0, 0, 0];
  if (clipRelativeFrame < 2) return initialRgb;
  if (clipRelativeFrame < 4) return [0x20, 0x30, 0x40];
  return [0x40, 0x50, 0x60];
}

async function ffprobeJson(outputPath: string, args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    ...args,
    '-of', 'json',
    outputPath,
  ]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function decodeCenterPixels(
  outputPath: string,
  frameCount = FRAME_COUNT,
): Promise<Array<readonly [number, number, number]>> {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-v', 'error',
    '-i', outputPath,
    '-map', '0:v:0',
    '-an',
    '-vf', 'crop=8:8:316:176,format=rgb24',
    '-frames:v', String(frameCount),
    '-f', 'rawvideo',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const pixelsPerFrame = 8 * 8;
  expect(bytes).toHaveLength(frameCount * pixelsPerFrame * 3);
  return Array.from({ length: frameCount }, (_, frame) => {
    const values = [[], [], []] as [number[], number[], number[]];
    const frameOffset = frame * pixelsPerFrame * 3;
    for (let pixel = 0; pixel < pixelsPerFrame; pixel += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        values[channel].push(bytes[frameOffset + (pixel * 3) + channel] ?? -1);
      }
    }
    return values.map((channel) => {
      channel.sort((left, right) => left - right);
      return channel[Math.floor(channel.length / 2)] ?? -1;
    }) as readonly [number, number, number];
  });
}

function withinExpectedColor(
  pixel: readonly number[],
  frame: number,
  clipStartFrame = 0,
  initialRgb: readonly [number, number, number] = [0, 0, 0],
): boolean {
  const expected = expectedRgb(frame, clipStartFrame, initialRgb);
  return pixel.length === 3 && pixel.every((channel, index) => (
    Math.abs(channel - expected[index]) <= COLOR_TOLERANCE
  ));
}

async function assertDecodedFixture(
  outputPath: string,
  {
    frameCount = FRAME_COUNT,
    clipStartFrame = 0,
    initialRgb = [0, 0, 0] as readonly [number, number, number],
    audioDurationMax = 0.75,
  } = {},
): Promise<Array<readonly [number, number, number]>> {
  const streamProbe = await ffprobeJson(outputPath, [
    '-count_frames',
    '-show_entries',
    'stream=codec_name,codec_type,width,height,r_frame_rate,nb_read_frames,duration,sample_rate,channels',
  ]);
  const streams = (streamProbe.streams ?? []) as ProbeStream[];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  expect(video).toMatchObject({
    codec_name: 'h264',
    width: 640,
    height: 360,
    r_frame_rate: '30/1',
    nb_read_frames: String(frameCount),
  });
  expect(audio?.codec_name).toBe('aac');
  expect(audio?.sample_rate).toBe('44100');
  expect(audio?.channels).toBe(2);
  // ffprobe reports the final frame PTS as stream duration for this valid
  // CFR stream; packet end is the actual composition boundary (frameCount / FPS).
  const videoPacketsProbe = await ffprobeJson(outputPath, [
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,duration_time',
  ]);
  const videoPackets = (videoPacketsProbe.packets ?? []) as Array<{ pts_time?: string; duration_time?: string }>;
  const lastPacket = videoPackets.at(-1);
  const packetEnd = Number(lastPacket?.pts_time) + Number(lastPacket?.duration_time);
  expect(videoPackets).toHaveLength(frameCount);
  expect(packetEnd).toBeCloseTo(frameCount / FPS, 5);
  expect(Number(audio?.duration)).toBeGreaterThan(0.5);
  expect(Number(audio?.duration)).toBeLessThan(audioDurationMax);

  const { stdout: audioRaw } = await execFileAsync('ffmpeg', [
    '-v', 'error',
    '-i', outputPath,
    '-map', '0:a:0',
    '-vn',
    '-ac', '2',
    '-ar', '44100',
    '-f', 's16le',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  const audioBytes = Buffer.isBuffer(audioRaw) ? audioRaw : Buffer.from(audioRaw);
  const samples = new Int16Array(audioBytes.buffer, audioBytes.byteOffset, Math.floor(audioBytes.byteLength / 2));
  const rms = Math.sqrt([...samples].reduce((sum, sample) => sum + (sample * sample), 0) / Math.max(1, samples.length));
  expect(rms).toBeGreaterThan(1);
  if (clipStartFrame > 0) {
    const rmsWindow = (startSeconds: number, endSeconds: number): number => {
      const start = Math.max(0, Math.floor(startSeconds * 44_100) * 2);
      const end = Math.min(samples.length, Math.ceil(endSeconds * 44_100) * 2);
      const window = samples.slice(start, end);
      return Math.sqrt([...window].reduce((sum, sample) => sum + (sample * sample), 0) / Math.max(1, window.length));
    };
    // The audio clip shares the six-frame offset. Assert silence in the
    // leading gap and energy in both interior windows, rather than merely
    // proving that some audio exists somewhere in the container.
    expect(rmsWindow(0.05, 0.15)).toBeLessThan(10);
    expect(rmsWindow(0.30, 0.40)).toBeGreaterThan(100);
    expect(rmsWindow(0.60, 0.70)).toBeGreaterThan(100);
  }

  const pixels = await decodeCenterPixels(outputPath, frameCount);
  expect(pixels).toHaveLength(frameCount);
  for (const [frame, pixel] of pixels.entries()) {
    expect(
      withinExpectedColor(pixel, frame, clipStartFrame, initialRgb),
      `frame ${frame}: expected RGB ${expectedRgb(frame, clipStartFrame, initialRgb).join(',')}, decoded median RGB ${pixel.join(',')}`,
    ).toBe(true);
  }
  // Explicit boundary checks catch a one-frame shift even if the color
  // tolerance above is later widened for a different browser encoder.
  expect(withinExpectedColor(pixels[1] ?? [], 1, clipStartFrame)).toBe(true);
  expect(withinExpectedColor(pixels[2] ?? [], 2, clipStartFrame)).toBe(true);
  expect(withinExpectedColor(pixels[3] ?? [], 3, clipStartFrame)).toBe(true);
  expect(withinExpectedColor(pixels[4] ?? [], 4, clipStartFrame)).toBe(true);
  return pixels;
}

test.describe('audio-reactive-colour browser export proof', () => {
  test.use({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });

  test.beforeEach(async ({ page }) => {
    await forceBlobLinkDownload(page);
  });

  test('loads and plays the managed source_audio asset after a user gesture', async ({ page }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const sourceRequests: Array<{ method: string; status: number; url: string }> = [];
    let sourceAudioDigest = '\0unset';
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
      if (decodeURIComponent(response.url()).includes(sourceAudioDigest)) {
        sourceRequests.push({ method: response.request().method(), status: response.status(), url: response.url() });
      }
    });

    expect(await resetFakeRuntimeBaseline()).toBeNull();
    // The managed source audio is a content-addressed Runtime object: the registry entry names its digest
    // and the editor reads the bytes from `/v1/objects/<digest>` (through the Vite proxy).
    const { registry } = await requireCanonicalComposition(TIMELINE_SLUG, 'audio-reactive source audio');
    const sourceDigest = registry.assets.source_audio.media_id as string;
    sourceAudioDigest = sourceDigest;
    expect(sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const sourceUrl = `${FAKE_RUNTIME_ORIGIN}/v1/objects/${encodeURIComponent(sourceDigest)}`;
    const authHeaders = fakeRuntimeAuthHeaders();
    const head = await page.request.fetch(sourceUrl, { method: 'HEAD', headers: authHeaders });
    expect(head.status()).toBe(200);
    expect(head.headers()['accept-ranges']).toBe('bytes');
    expect(head.headers()['content-type']).toContain('audio/wav');
    expect(Number(head.headers()['content-length'])).toBeGreaterThan(100);
    const range = await page.request.get(sourceUrl, { headers: { ...authHeaders, Range: 'bytes=0-127' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toMatch(/^bytes 0-127\//);
    expect((await range.body())).toHaveLength(128);

    await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // The element playing the managed source audio: the one whose src names the registry digest.
    const sourceAudioState = () => page.locator('audio').evaluateAll((elements, digest) => {
      const audio = (elements as HTMLAudioElement[]).find((element) => decodeURIComponent(element.src).includes(digest));
      return audio
        ? {
          readyState: audio.readyState,
          duration: audio.duration,
          currentTime: audio.currentTime,
          paused: audio.paused,
          errored: audio.error !== null,
        }
        : null;
    }, sourceDigest);
    await expect.poll(async () => {
      const state = await sourceAudioState();
      return Boolean(state && state.readyState >= 2 && Number.isFinite(state.duration) && !state.errored);
      // A cold Vite module graph (the first page of a run) needs about a minute before the editor mounts.
    }, { timeout: 90_000 }).toBe(true);
    const before = await sourceAudioState();
    expect(before).not.toBeNull();
    expect(before?.readyState).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(before?.duration)).toBe(true);
    expect(before?.duration).toBeGreaterThan(0.5);

    const playButton = page.getByRole('button', { name: 'Play', exact: true }).first();
    await expect(playButton).toBeVisible({ timeout: 15_000 });
    await playButton.click();
    await expect.poll(async () => {
      const state = await sourceAudioState();
      return Boolean(state && state.readyState >= 2 && !state.errored && state.paused === false);
    }, { timeout: 15_000 }).toBe(true);
    const playingAt = (await sourceAudioState())?.currentTime ?? -1;
    await expect.poll(async () => (await sourceAudioState())?.currentTime ?? -1, { timeout: 5_000 }).toBeGreaterThan(playingAt);
    expect(sourceRequests.some((request) => request.status === 200)).toBe(true);
    expect(sourceRequests.some((request) => request.status === 206)).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((message) => !/Failed to load resource.*404/i.test(message))).toEqual([]);
  });

  test('renders the pinned Astrid marker fixture with exact decoded frame boundaries', { tag: '@chrome-h264' }, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const forbiddenRequests: string[] = [];
    const saveRequests: string[] = [];
    const notFoundResponses: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('request', (request) => {
      const url = request.url();
      if (/(supabase\.co|127\.0\.0\.1:54321|localhost:54321|\/auth\/v1\/|\/rest\/v1\/|\/functions\/v1\/)/.test(url)) {
        forbiddenRequests.push(url);
      }
      if (isCompositionPublish(request.method(), new URL(url).pathname)) {
        saveRequests.push(url);
      }
    });
    page.on('response', (response) => {
      if (response.status() === 404) notFoundResponses.push(response.url());
    });

    expect(await resetFakeRuntimeBaseline()).toBeNull();
    const before = await requireCanonicalComposition(
      TIMELINE_SLUG,
      'audio-reactive marker export',
    );
    expect(before.config.output).toMatchObject({ resolution: '640x360', fps: FPS });
    expect(before.config.clips).toHaveLength(2);

    await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const renderer = page.getByTestId('audio-reactive-colour-renderer');
    await expect(renderer).toBeVisible({ timeout: 30_000 });
    await expect(renderer).toHaveAttribute('data-frame', '0');
    await expect(renderer).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await page.screenshot({
      path: browserEvidencePath(testInfo, 'audio-reactive-colour/preview-frame-0.png'),
      fullPage: true,
    });

    const renderButton = page.getByRole('button', { name: /^Render(?: \d+%)?$/ });
    await expect(renderButton).toBeEnabled();
    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await renderButton.click();
    const downloadLink = page.getByRole('button', { name: 'Download', exact: true });
    const renderBlocker = page.locator('[data-video-editor-render-blocker="true"]');
    await expect.poll(async () => {
      if (await downloadLink.isVisible()) return 'done';
      if (await renderBlocker.isVisible()) return `error:${(await renderBlocker.textContent())?.trim() ?? '<empty>'}`;
      return 'pending';
    }, { timeout: 120_000, message: 'browser render did not complete' }).toBe('done');

    // A finished render opens the "Rendered film" player modally, with the explicit Download inside it.
    const renderedFilm = page.getByRole('dialog', { name: 'Rendered film' });
    await expect(renderedFilm).toBeVisible();
    await expect(renderedFilm.getByTestId('timeline-render-player')).toBeVisible();
    await expect(renderedFilm.getByRole('button', { name: 'Download', exact: true })).toBeVisible();

    // Completion starts a normal browser download without opening a save picker.
    const download = await downloadPromise;
    const outputPath = browserEvidencePath(testInfo, 'audio-reactive-colour/browser-render.mp4');
    await download.saveAs(outputPath);
    expect((await stat(outputPath)).size).toBeGreaterThan(1_000);
    expect((await readFile(outputPath)).subarray(4, 8).toString('ascii')).toBe('ftyp');

    await assertDecodedFixture(outputPath);

    // Download remains a normal browser-managed retry/copy action.
    const manualDownloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadLink.click();
    expect((await manualDownloadPromise).suggestedFilename()).toBe(download.suggestedFilename());

    // Rendering is client-only and must not write the timeline. Repeat it to
    // prove idempotency and to catch accidental Runtime persistence coupling.
    // The player is modal: the Render button is reachable again only after the user closes it.
    // The Download button holds no URL; the player beside it plays the same render result, so its src tells one render from the next.
    const firstFilmSource = await renderedFilm.getByTestId('timeline-render-player').getAttribute('src');
    expect(firstFilmSource).toMatch(/^blob:/);
    await renderedFilm.getByRole('button', { name: 'Close' }).click();
    await expect(renderedFilm).toBeHidden();
    await expect(renderButton).toBeEnabled();
    const secondDownloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await renderButton.click();
    await expect(renderButton).toBeDisabled({ timeout: 5_000 });
    await expect(renderedFilm).toBeVisible({ timeout: 120_000 });
    await expect(downloadLink).toBeVisible();
    await expect(renderedFilm.getByTestId('timeline-render-player')).not.toHaveAttribute('src', firstFilmSource!);
    const secondDownload = await secondDownloadPromise;
    const secondOutputPath = browserEvidencePath(testInfo, 'audio-reactive-colour/browser-render-repeat.mp4');
    await secondDownload.saveAs(secondOutputPath);
    expect((await stat(secondOutputPath)).size).toBeGreaterThan(1_000);
    expect((await readFile(secondOutputPath)).subarray(4, 8).toString('ascii')).toBe('ftyp');
    await assertDecodedFixture(secondOutputPath);
    const after = await readFakeRuntimeComposition(TIMELINE_SLUG);
    expect(after.headRevisionId).toBe(before.headRevisionId);
    expect(after.config).toEqual(before.config);
    expect(after.registry).toEqual(before.registry);
    expect(saveRequests).toEqual([]);

    expect(forbiddenRequests).toEqual([]);
    expect(notFoundResponses).toEqual([]);
    expect(pageErrors).toEqual([]);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !/Failed to load resource.*404/i.test(message));
    expect(unexpectedConsoleErrors).toEqual([]);
  });

  test('keeps marker frames clip-relative when the colour clip starts after a global gap', { tag: '@chrome-h264' }, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const forbiddenRequests: string[] = [];
    const saveRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('request', (request) => {
      const url = request.url();
      if (/(supabase\.co|127\.0\.0\.1:54321|localhost:54321|\/auth\/v1\/|\/rest\/v1\/|\/functions\/v1\/)/.test(url)) {
        forbiddenRequests.push(url);
      }
      if (isCompositionPublish(request.method(), new URL(url).pathname)) {
        saveRequests.push(url);
      }
    });

    expect(await resetFakeRuntimeBaseline()).toBeNull();
    const before = await requireCanonicalComposition(
      OFFSET_TIMELINE_SLUG,
      'offset audio-reactive marker export',
    );
    const beforeClips = before.config.clips as Array<{ at: number; params?: { events?: Array<{ frame: number }> } }>;
    expect(before.config.output).toMatchObject({ resolution: '640x360', fps: FPS });
    expect(beforeClips).toHaveLength(2);
    expect(beforeClips.map((clip) => clip.at)).toEqual([OFFSET_CLIP_START_FRAME / FPS, OFFSET_CLIP_START_FRAME / FPS]);
    expect(beforeClips[0]?.params?.events?.map((event) => event.frame)).toEqual([2, 4]);

    await page.goto(OFFSET_EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await expect(page.getByTestId('video-editor-preview-surface')).toBeVisible({ timeout: 30_000 });
    // The clip-relative renderer is correctly absent before its global start;
    // the composed preview surface itself remains the declared black background.
    await expect(page.getByTestId('audio-reactive-colour-renderer')).toHaveCount(0);
    await page.screenshot({
      path: browserEvidencePath(testInfo, 'audio-reactive-colour/offset-preview-before-clip.png'),
      fullPage: true,
    });

    const renderButton = page.getByRole('button', { name: /^Render(?: \d+%)?$/ });
    await expect(renderButton).toBeEnabled();
    await renderButton.click();
    const downloadLink = page.getByRole('button', { name: 'Download', exact: true });
    const renderBlocker = page.locator('[data-video-editor-render-blocker="true"]');
    await expect.poll(async () => {
      if (await downloadLink.isVisible()) return 'done';
      if (await renderBlocker.isVisible()) return `error:${(await renderBlocker.textContent())?.trim() ?? '<empty>'}`;
      return 'pending';
    }, { timeout: 120_000, message: 'offset browser render did not complete' }).toBe('done');

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadLink.click();
    const download = await downloadPromise;
    const outputPath = browserEvidencePath(testInfo, 'audio-reactive-colour/browser-render-offset.mp4');
    await download.saveAs(outputPath);
    expect((await stat(outputPath)).size).toBeGreaterThan(1_000);
    expect((await readFile(outputPath)).subarray(4, 8).toString('ascii')).toBe('ftyp');

    const pixels = await assertDecodedFixture(outputPath, {
      frameCount: OFFSET_FRAME_COUNT,
      clipStartFrame: OFFSET_CLIP_START_FRAME,
      initialRgb: [0x10, 0x20, 0x30],
      audioDurationMax: 0.9,
    });
    // The first marker is global frame 8 (6-frame offset + relative frame 2),
    // and the second is global frame 10. The preceding gap and clip-relative
    // lead-in must remain black, catching an absolute-frame implementation.
    for (let frame = 0; frame < OFFSET_CLIP_START_FRAME + 2; frame += 1) {
      expect(withinExpectedColor(pixels[frame] ?? [], frame, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30]), `pre-clip frame ${frame}`).toBe(true);
    }
    expect(withinExpectedColor(pixels[OFFSET_CLIP_START_FRAME + 2] ?? [], OFFSET_CLIP_START_FRAME + 2, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30])).toBe(true);
    expect(withinExpectedColor(pixels[OFFSET_CLIP_START_FRAME + 4] ?? [], OFFSET_CLIP_START_FRAME + 4, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30])).toBe(true);
    expect(withinExpectedColor(pixels[5] ?? [], 5, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30])).toBe(true);
    expect(withinExpectedColor(pixels[6] ?? [], 6, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30])).toBe(true);
    expect(withinExpectedColor(pixels[7] ?? [], 7, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30])).toBe(true);
    expect(withinExpectedColor(pixels[8] ?? [], 8, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30])).toBe(true);
    expect(withinExpectedColor(pixels[9] ?? [], 9, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30])).toBe(true);
    expect(withinExpectedColor(pixels[10] ?? [], 10, OFFSET_CLIP_START_FRAME, [0x10, 0x20, 0x30])).toBe(true);

    const after = await readFakeRuntimeComposition(OFFSET_TIMELINE_SLUG);
    expect(after.headRevisionId).toBe(before.headRevisionId);
    expect(after.config).toEqual(before.config);
    expect(after.registry).toEqual(before.registry);
    expect(saveRequests).toEqual([]);
    expect(forbiddenRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !/Failed to load resource.*404/i.test(message));
    expect(unexpectedConsoleErrors).toEqual([]);
  });
});
