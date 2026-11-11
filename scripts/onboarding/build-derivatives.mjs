#!/usr/bin/env node
/**
 * node scripts/onboarding/build-derivatives.mjs [--check]
 *
 * Builds the tour's playback derivatives from the release's original files and records them in both manifests
 * (`public/astrid/onboarding/<version>/manifest.json` and `src/tools/video-editor/tour/asset-manifest.json`).
 * The originals are never touched; every derivative is a new immutable file named by its SHA-256 with a
 * `derivedFrom` entry naming its source. Needs `ffmpeg` (libx264, libwebp) on PATH.
 *
 * Why they exist: the tour presents its picture with a plain muted <video>/<img>, not the editor's decoder.
 *   - videos: H.264 Main, yuv420p limited range, no audio track, `moov` first (faststart), a keyframe every 48 frames.
 *     `*540` is what phones play; `guide720` / `video768` keep the source size for larger screens.
 *     The H3 clip is cut to the 14 s the timeline shows.
 *   - `*Display`: the picture at source size as WebP (posters, the four stills in the preview).
 *   - `*Thumb`: 320 px WebP for timeline clip thumbnails, card visuals and gallery tiles.
 * x264 output is not bit-identical across encoder builds: a re-run with another ffmpeg makes new files (new hashes).
 * `--check` only verifies that every recorded derivative exists with its recorded size and digest.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SOURCE_MANIFEST = resolve('src/tools/video-editor/tour/asset-manifest.json');
const manifest = JSON.parse(readFileSync(SOURCE_MANIFEST, 'utf8'));
const releaseDir = resolve('public/astrid/onboarding', manifest.version);
const original = (name) => join(releaseDir, manifest.assets[name].filename);

const x264 = (input, { width, height, crf, inRange, seconds }) => [
  '-i', input, '-an', ...(seconds ? ['-t', String(seconds)] : []),
  '-vf', `scale=${width}:${height}:flags=lanczos:in_range=${inRange}:out_range=tv,format=yuv420p`,
  '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'slow', '-crf', String(crf),
  '-g', '48', '-keyint_min', '24', '-sc_threshold', '0', '-bf', '2',
  '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-movflags', '+faststart', '-f', 'mp4',
];
const webp = (input, { width, quality, firstFrame }) => [
  '-i', input, ...(firstFrame ? ['-frames:v', '1'] : []),
  ...(width ? ['-vf', `scale=${width}:-2:flags=lanczos`] : []),
  '-c:v', 'libwebp', '-quality', String(quality), '-compression_level', '6', '-f', 'webp',
];

/** name -> { from, ext, mediaType, args, meta } */
const DERIVATIVES = {
  // The Three.js guide is full-range (yuvj420p); players expect limited range.
  guide540: { from: 'guide', ext: 'mp4', mediaType: 'video/mp4', args: (i) => x264(i, { width: 960, height: 540, crf: 24, inRange: 'full' }), meta: { width: 960, height: 540, durationSeconds: 14, fps: 30 } },
  guide720: { from: 'guide', ext: 'mp4', mediaType: 'video/mp4', args: (i) => x264(i, { width: 1280, height: 720, crf: 23, inRange: 'full' }), meta: { width: 1280, height: 720, durationSeconds: 14, fps: 30 } },
  video540: { from: 'video', ext: 'mp4', mediaType: 'video/mp4', args: (i) => x264(i, { width: 960, height: 548, crf: 25, inRange: 'tv', seconds: 14 }), meta: { width: 960, height: 548, durationSeconds: 14, fps: 24 } },
  video768: { from: 'video', ext: 'mp4', mediaType: 'video/mp4', args: (i) => x264(i, { width: 1344, height: 768, crf: 24, inRange: 'tv', seconds: 14 }), meta: { width: 1344, height: 768, durationSeconds: 14, fps: 24 } },
  videoPoster: { from: 'video', ext: 'webp', mediaType: 'image/webp', args: (i) => webp(i, { quality: 86, firstFrame: true }), meta: { width: 1344, height: 768 } },
  videoThumb: { from: 'video', ext: 'webp', mediaType: 'image/webp', args: (i) => webp(i, { width: 320, quality: 76, firstFrame: true }), meta: { width: 320, height: 182 } },
  frame1Display: { from: 'frame1', ext: 'webp', mediaType: 'image/webp', args: (i) => webp(i, { quality: 86 }), meta: { width: 1280, height: 720 } },
  frame1Thumb: { from: 'frame1', ext: 'webp', mediaType: 'image/webp', args: (i) => webp(i, { width: 320, quality: 76 }), meta: { width: 320, height: 180 } },
  ...Object.fromEntries([1, 2, 3, 4].flatMap((n) => [
    [`still${n}Display`, { from: `still${n}`, ext: 'webp', mediaType: 'image/webp', args: (i) => webp(i, { quality: 86 }), meta: { width: 1376, height: 768 } }],
    [`still${n}Thumb`, { from: `still${n}`, ext: 'webp', mediaType: 'image/webp', args: (i) => webp(i, { width: 320, quality: 76 }), meta: { width: 320, height: 178 } }],
  ])),
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (process.argv.includes('--check')) {
  for (const [name, asset] of Object.entries(manifest.assets)) {
    if (!asset.derivedFrom) continue;
    const bytes = readFileSync(join(releaseDir, asset.filename));
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw new Error(`${name}: recorded size/digest do not match ${asset.filename}`);
    if (!manifest.assets[asset.derivedFrom] || manifest.assets[asset.derivedFrom].derivedFrom) throw new Error(`${name}: derivedFrom must name an original`);
  }
  console.log('derivatives match the manifest');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'tour-derivatives-'));
try {
  for (const [name, spec] of Object.entries(DERIVATIVES)) {
    const recorded = manifest.assets[name];
    if (recorded && existsSync(join(releaseDir, recorded.filename))) { console.log(`${name}: kept ${recorded.filename}`); continue; }
    const tmp = join(work, `${name}.${spec.ext}`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...spec.args(original(spec.from)), tmp], { stdio: ['ignore', 'inherit', 'inherit'] });
    const bytes = readFileSync(tmp);
    const digest = sha256(bytes);
    const filename = `${digest}.${spec.ext}`;
    copyFileSync(tmp, join(releaseDir, filename));
    manifest.assets[name] = { filename, sha256: digest, size: bytes.length, mediaType: spec.mediaType, ...spec.meta, derivedFrom: spec.from };
    console.log(`${name}: ${filename} ${(bytes.length / 1024).toFixed(0)} KB (from ${spec.from}, ${(manifest.assets[spec.from].size / 1024).toFixed(0)} KB)`);
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(SOURCE_MANIFEST, text);
  writeFileSync(join(releaseDir, 'manifest.json'), text);
} finally {
  rmSync(work, { recursive: true, force: true });
}
