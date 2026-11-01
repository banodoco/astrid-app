import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Page, TestInfo } from '@playwright/test';

const execAsync = promisify(execFile);

export const TAB_AUDIO_MIME = 'video/webm;codecs=vp8,opus';
export const TAB_AUDIO_TIMESLICE_MS = 100;
export const TAB_AUDIO_DURATION_MS = 2_000;

export type CaptureLifecycle = {
  events: string[];
  tracks: Array<{ kind: string; readyState: string }>;
  chunks: string[];
  observations: Array<{ label: string; media: unknown[]; contexts: unknown[] }>;
};

export type TabCaptureProbe = {
  streams: Array<Record<string, unknown>>;
  packets: Array<Record<string, unknown>>;
  format: Record<string, unknown>;
};

type Recorder = {
  state: string;
  start: (timeslice?: number) => void;
  stop: () => void;
  addEventListener?: (name: string, listener: (event?: unknown) => void, options?: { once?: boolean }) => void;
  removeEventListener?: (name: string, listener: (event?: unknown) => void) => void;
  ondataavailable?: (event: unknown) => void;
  onerror?: (event: unknown) => void;
  onabort?: (event: unknown) => void;
  onstop?: () => void;
};

type CaptureTrack = { kind: string; readyState: string; stop: () => void };
type CaptureStream = { getTracks: () => CaptureTrack[] };
type CaptureData = { arrayBuffer: () => Promise<ArrayBuffer> };
type CaptureDataEvent = { data?: unknown };
type CaptureBackend = {
  getDisplayMedia: (constraints: Record<string, unknown>) => Promise<CaptureStream>;
  MediaRecorder: new (stream: CaptureStream, options: { mimeType: string }) => Recorder;
  observe?: (label: string) => Promise<{ media: unknown[]; contexts: unknown[] }> | { media: unknown[]; contexts: unknown[] };
  warm: () => Promise<void>;
  ready: () => Promise<void>;
  play: () => Promise<void>;
  wait: (durationMs: number) => Promise<void>;
  stopPlayer: () => Promise<void>;
};

/**
 * The stream/recorder protocol is deliberately injectable so the ordering and
 * cleanup contract can be tested without a browser. The page backend below is
 * the only production-shaped caller; this helper never synthesizes media.
 */
export async function recordTabStream(
  options: { mimeType?: string; timesliceMs?: number; durationMs?: number } = {},
  injected?: CaptureBackend,
): Promise<CaptureLifecycle> {
  const mimeType = options.mimeType ?? TAB_AUDIO_MIME;
  const events: string[] = ['before-warm'];
  const observations: CaptureLifecycle['observations'] = [];
  const chunks: string[] = [];
  let stream: CaptureStream | undefined;
  let recorder: Recorder | undefined;
  let delivery = Promise.resolve();
  let primaryError: unknown;
  const backend = injected ?? createPageBackend();
  const observe = async (label: string) => {
    if (!backend.observe) return;
    observations.push({ label, ...(await backend.observe(label)) });
  };
  function createPageBackend(): CaptureBackend {
    const player = (window as Window & { __frameParityPlayer?: {
      play: () => Promise<void>; pause: () => void; isPlaying: () => boolean;
    } }).__frameParityPlayer;
    if (!player) throw new Error('Mounted actual Player ref is required before tab capture');
    const waitForPlaying = async () => {
      const deadline = Date.now() + 10_000;
      while (!player.isPlaying()) {
        if (Date.now() >= deadline) throw new Error('actual Player did not start playing');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const observePage = (label: string) => ({
      media: Array.from(document.querySelectorAll<HTMLMediaElement>('audio,video')).map(element => ({
        label, readyState: element.readyState, paused: element.paused, currentTime: element.currentTime,
        muted: element.muted, volume: element.volume,
      })),
      contexts: ((window as Window & { __tabMixAudioContexts?: AudioContext[] }).__tabMixAudioContexts ?? [])
        .map((context: AudioContext) => ({ state: context.state, currentTime: context.currentTime })),
    });
    return {
      getDisplayMedia: constraints => navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions) as Promise<CaptureStream>,
      MediaRecorder: window.MediaRecorder as unknown as CaptureBackend['MediaRecorder'],
      observe: observePage,
      warm: async () => {
        await player.play();
        await waitForPlaying();
        await new Promise(resolve => setTimeout(resolve, 250));
        player.pause();
      },
      ready: async () => {
        const deadline = Date.now() + 10_000;
        while (Array.from(document.querySelectorAll<HTMLMediaElement>('audio,video')).some(element => element.readyState < 2)) {
          if (Date.now() >= deadline) throw new Error('actual Player media did not become ready');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      },
      play: async () => { await player.play(); await waitForPlaying(); },
      wait: durationMs => new Promise(resolve => setTimeout(resolve, durationMs)),
      stopPlayer: async () => { player.pause(); },
    };
  }
  function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  async function eventDataToBase64(data: unknown): Promise<string> {
    if (!data) return '';
    if (data instanceof Uint8Array) return bytesToBase64(data);
    if (data instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(data));
    if (typeof data === 'object' && data !== null && 'arrayBuffer' in data
      && typeof (data as CaptureData).arrayBuffer === 'function') {
      return bytesToBase64(new Uint8Array(await (data as CaptureData).arrayBuffer()));
    }
    return '';
  }
  function listen(target: Recorder, name: string, listener: (event?: unknown) => void): void {
    if (target.addEventListener) target.addEventListener(name, listener);
    else if (name === 'dataavailable') target.ondataavailable = listener;
    else if (name === 'error') target.onerror = listener;
    else if (name === 'abort') target.onabort = listener;
    else if (name === 'stop') target.onstop = listener;
  }
  try {
    await observe('before-warm');
    stream = await backend.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true });
    const tracks = stream.getTracks().map(track => ({ kind: track.kind, readyState: track.readyState }));
    if (tracks.filter(track => track.kind === 'video').length !== 1
      || tracks.filter(track => track.kind === 'audio').length !== 1) {
      throw new Error(`whole-tab capture requires exactly one video and one audio track; got ${JSON.stringify(tracks)}`);
    }
    events.push('stream:ready');
    recorder = new backend.MediaRecorder(stream, { mimeType });
    listen(recorder, 'dataavailable', event => {
      delivery = delivery.then(async () => {
        const data = await eventDataToBase64((event as CaptureDataEvent | undefined)?.data);
        if (data) chunks.push(data);
      });
    });
    const recorderError = new Promise<never>((_, reject) => {
      const fail = (event?: unknown) => reject(event ?? new Error('MediaRecorder failure'));
      listen(recorder!, 'error', fail);
      listen(recorder!, 'abort', fail);
    });
    recorder.start(options.timesliceMs ?? TAB_AUDIO_TIMESLICE_MS);
    events.push('recorder:start');
    await backend.warm();
    events.push('warm');
    await observe('after-warm');
    await backend.ready();
    events.push('readiness');
    await observe('after-readiness');
    await backend.play();
    events.push('play');
    await observe('after-play');
    await Promise.race([backend.wait(options.durationMs ?? TAB_AUDIO_DURATION_MS), recorderError]);
    await backend.stopPlayer();
    const stopped = new Promise<void>((resolve, reject) => {
      listen(recorder!, 'stop', () => resolve());
      listen(recorder!, 'error', event => reject(event ?? new Error('MediaRecorder error while stopping')));
    });
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    await delivery;
    events.push('recorder:stop');
    return { events, tracks, chunks, observations };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* cleanup is best effort after the primary failure */ }
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* cleanup is best effort after the primary failure */ }
      }
      events.push('tracks:stop');
    }
    if (!primaryError) events.push('cleanup');
  }
}

export async function installTabAudioObservation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    Object.defineProperty(window, '__tabMixAudioContexts', { value: contexts, configurable: true });
    const NativeAudioContext = window.AudioContext;
    if (!NativeAudioContext) return;
    window.AudioContext = new Proxy(NativeAudioContext, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget) as AudioContext;
        contexts.push(context);
        return context;
      },
    });
  });
}

export function assertNativePts(probe: TabCaptureProbe): void {
  const video = probe.streams.filter(stream => stream.codec_type === 'video');
  const audio = probe.streams.filter(stream => stream.codec_type === 'audio');
  if (video.length !== 1 || audio.length !== 1) throw new Error(`expected one video and one audio stream, got ${video.length}/${audio.length}`);
  const streams = { video: video[0], audio: audio[0] };
  for (const [type, stream] of Object.entries(streams)) {
    if (typeof stream.time_base !== 'string' || !/^\d+\/[1-9]\d*$/.test(stream.time_base)) {
      throw new Error(`${type} stream is missing a native time base`);
    }
    const packets = probe.packets.filter(packet => Number(packet.stream_index) === Number(stream.index)
      || (packet.stream_index === undefined && packet.codec_type === type));
    if (packets.length === 0) throw new Error(`capture has no native ${type} packets`);
    const values = packets.map(packet => Number(packet.pts));
    if (values.some(value => !Number.isFinite(value))) throw new Error(`${type} packet is missing native pts`);
    const times = packets.map(packet => Number(packet.pts_time));
    if (times.some(value => !Number.isFinite(value))) throw new Error(`${type} packet is missing finite native pts_time`);
    if (values.some((value, index) => index > 0 && value < values[index - 1])) throw new Error(`${type} packet pts are not monotonic`);
    if (times.some((value, index) => index > 0 && value < times[index - 1])) throw new Error(`${type} packet pts_time is not monotonic`);
  }
}

export async function inspectTabCapture(path: string): Promise<TabCaptureProbe> {
  const { stdout } = await execAsync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_packets', '-show_format', '-of', 'json', path,
  ]);
  const parsed = JSON.parse(stdout) as Partial<TabCaptureProbe>;
  const probe = { streams: parsed.streams ?? [], packets: parsed.packets ?? [], format: parsed.format ?? {} };
  assertNativePts(probe);
  return probe;
}

export async function captureActualPlayerTab(page: Page, testInfo: TestInfo): Promise<{ path: string; lifecycle: CaptureLifecycle; probe: TabCaptureProbe }> {
  const lifecycle = await page.evaluate(recordTabStream, {
    mimeType: TAB_AUDIO_MIME, timesliceMs: TAB_AUDIO_TIMESLICE_MS, durationMs: TAB_AUDIO_DURATION_MS,
  });
  const path = testInfo.outputPath('viewing-parity/whole-tab.webm');
  await mkdir(testInfo.outputPath('viewing-parity'), { recursive: true });
  const bytes = Buffer.concat(lifecycle.chunks.map(chunk => Buffer.from(chunk, 'base64')));
  if (bytes.length === 0) throw new Error('actual Player tab capture produced no bytes');
  await writeFile(path, bytes);
  const probe = await inspectTabCapture(path);
  await writeFile(testInfo.outputPath('viewing-parity/tab-capture-lifecycle.json'), `${JSON.stringify({ lifecycle, probe }, null, 2)}\n`);
  await testInfo.attach('actual-player-whole-tab', { path, contentType: 'video/webm' });
  return { path, lifecycle, probe };
}
