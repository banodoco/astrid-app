import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const PARITY_FPS = 30;
export const PARITY_WIDTH = 640;
export const PARITY_HEIGHT = 360;
export const VIDEO_START_FRAME = 120;
export const VIDEO_FRAMES = 45;

export function mediaHash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

// Six black/white cells encode the exact source frame (least significant bit
// first), with a white sentinel so a blank canvas cannot read as frame 0.
// Broad luma bands only identify readiness; picture parity still uses
// the strict full screenshot/export RGB comparator without relaxed tolerance.
export function readFrameMarker(bytes: Uint8Array): number | null {
  const sentinel = (24 * PARITY_WIDTH + 250) * 3;
  if (bytes.length <= sentinel + 2 || !Array.from(bytes.slice(sentinel, sentinel + 3)).every(value => value > 220)) return null;
  let frame = 0;
  for (let bit = 0; bit < 6; bit++) {
    const offset = (24 * PARITY_WIDTH + 24 + bit * 40) * 3;
    const rgb = Array.from(bytes.slice(offset, offset + 3));
    if (rgb.length !== 3) return null;
    if (rgb.every(value => value > 220)) frame |= 1 << bit;
    else if (!rgb.every(value => value < 35)) return null;
  }
  return frame;
}

export async function generatePlayableVideo(directory: string) {
  const path = join(directory, 'frame-marked.webm');
  const markers = Array.from({ length: 6 }, (_, bit) =>
    `drawbox=x=${12 + bit * 40}:y=12:w=24:h=24:color=white:t=fill:enable='bitand(n,${1 << bit})'`);
  await exec('ffmpeg', [
    '-v', 'error', '-y', '-fflags', '+bitexact',
    '-f', 'lavfi', '-i', `testsrc2=size=${PARITY_WIDTH}x${PARITY_HEIGHT}:rate=${PARITY_FPS}:duration=1.5`,
    '-vf', ['drawbox=x=0:y=0:w=260:h=48:color=black:t=fill',
      'drawbox=x=244:y=12:w=12:h=24:color=white:t=fill', ...markers,
      "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='source frame %{n}':x=280:y=12:fontsize=24:fontcolor=white:box=1:boxcolor=black",
      // WebM timestamps have millisecond precision. Round starts down so the
      // nominal n/30 seek lies inside frame n, never just before its timestamp.
      'settb=1/1000', `setpts=floor(N*1000/${PARITY_FPS})`].join(','),
    '-an', '-c:v', 'libvpx', '-deadline', 'best', '-cpu-used', '0', '-crf', '4', '-b:v', '1M',
    '-enc_time_base', '1/1000', '-fps_mode', 'passthrough',
    '-bsf:v', `setts=duration=floor((N+1)*1000/${PARITY_FPS})-floor(N*1000/${PARITY_FPS})`,
    '-pix_fmt', 'yuv420p', '-threads', '1', '-flags:v', '+bitexact', '-fflags', '+bitexact', '-map_metadata', '-1', path,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-count_frames', '-show_entries', 'frame=pts_time', '-show_streams', '-show_format', '-of', 'json', path,
  ]);
  const metadata = JSON.parse(stdout) as {
    streams: Array<{ codec_name: string; width: number; height: number; r_frame_rate: string; time_base: string; nb_read_frames: string }>;
    format: { duration: string };
    frames: Array<{ pts_time: string }>;
  };
  const video = metadata.streams[0];
  if (metadata.streams.length !== 1 || video?.codec_name !== 'vp8'
    || video.width !== PARITY_WIDTH || video.height !== PARITY_HEIGHT
    || video.r_frame_rate !== `${PARITY_FPS}/1` || Number(video.nb_read_frames) !== VIDEO_FRAMES
    || video.time_base !== '1/1000' || Number(metadata.format.duration) !== 1.5
    || metadata.frames.length !== VIDEO_FRAMES
    || metadata.frames.some((frame, index) => Number(frame.pts_time) !== Math.floor(index * 1000 / PARITY_FPS) / 1000)) {
    throw new Error(`invalid playable parity source: ${stdout}`);
  }
  const bytes = await readFile(path);
  return { path, bytes, id: mediaHash(bytes), metadata };
}
