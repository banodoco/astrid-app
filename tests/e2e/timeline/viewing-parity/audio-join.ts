import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeMixedBuffer } from '../../../../src/tools/video-editor/compositions/audio-analysis/audioAnalysis.pipeline.ts';

const exec = promisify(execFile);
export const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_BLOCK_SECONDS = 0.02;
const AUDIO_ACTIVITY_RMS = 0.004;
const AUDIO_SPECTRUM_SECONDS = 0.1;
const AUDIO_SPECTRUM_FREQUENCIES = [440, 660, 880];
const AUDIO_SPECTRUM_MIN_AMPLITUDE = 0.04;
const AUDIO_MAX_PHASE_STEP = 0.1;
const AUDIO_ANALYSIS_FPS = 50;

export type NativeAudioProbe = {
  streams: Array<Record<string, unknown>>;
  packets: Array<Record<string, unknown>>;
  format: Record<string, unknown>;
};

export type DecodedNativeAudio = {
  path: string;
  probe: NativeAudioProbe;
  pcm: Int16Array;
  sampleCount: number;
};

async function decodePcm(path: string, streamIndex: number): Promise<Buffer> {
  const { stdout } = await exec('ffmpeg', [
    '-v', 'error', '-nostdin', '-i', path, '-map', `0:${streamIndex}`,
    '-f', 's16le', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function decodeNativeAudio(path: string, label: string): Promise<DecodedNativeAudio> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_streams', '-show_packets', '-show_format', '-of', 'json', path,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const probe = JSON.parse(stdout) as NativeAudioProbe;
  const audio = probe.streams.filter(stream => stream.codec_type === 'audio');
  if (audio.length !== 1) throw new Error(`${label} must contain exactly one audio stream`);
  const stream = audio[0];
  if (stream.sample_rate !== String(AUDIO_SAMPLE_RATE) || stream.channels !== 2) {
    throw new Error(`${label} must be native ${AUDIO_SAMPLE_RATE}Hz stereo; got ${stream.sample_rate}Hz/${stream.channels}ch`);
  }
  if (typeof stream.index !== 'number') throw new Error(`${label} audio stream has no index`);
  const raw = await decodePcm(path, stream.index);
  if (raw.length === 0 || raw.length % 4 !== 0) {
    throw new Error(`${label} decoded PCM must contain complete stereo int16 sample frames`);
  }
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  return { path, probe, pcm, sampleCount: raw.length / 4 };
}

function rms(pcm: Int16Array, start: number, end: number, channel: number): number {
  const first = Math.max(0, Math.floor(start * AUDIO_SAMPLE_RATE));
  const last = Math.min(pcm.length / 2, Math.floor(end * AUDIO_SAMPLE_RATE));
  if (last <= first) throw new Error(`audio comparison window is outside decoded PCM: ${start}-${end}s`);
  let sum = 0;
  for (let sample = first; sample < last; sample++) sum += (pcm[sample * 2 + channel] / 32768) ** 2;
  return Math.sqrt(sum / (last - first));
}

function spectrum(pcm: Int16Array, start: number, end: number, frequency: number, channel: number) {
  const first = Math.max(0, Math.floor(start * AUDIO_SAMPLE_RATE));
  const last = Math.min(pcm.length / 2, Math.floor(end * AUDIO_SAMPLE_RATE));
  if (last <= first) throw new Error(`audio spectrum window is outside decoded PCM: ${start}-${end}s`);
  let sine = 0;
  let cosine = 0;
  for (let sample = first; sample < last; sample++) {
    const phase = 2 * Math.PI * frequency * sample / AUDIO_SAMPLE_RATE;
    const value = pcm[sample * 2 + channel] / 32768;
    sine += value * Math.sin(phase);
    cosine += value * Math.cos(phase);
  }
  const scale = 2 / (last - first);
  return {
    amplitude: Math.hypot(sine, cosine) * scale,
    phase: Math.atan2(sine, cosine),
  };
}

function phaseDistance(left: number, right: number): number {
  const wrapped = Math.abs(left - right) % (2 * Math.PI);
  return wrapped > Math.PI ? 2 * Math.PI - wrapped : wrapped;
}

function analyzePcm(pcm: Int16Array, start: number, frameCount: number) {
  const first = Math.floor(start * AUDIO_SAMPLE_RATE);
  const sampleCount = frameCount * AUDIO_SAMPLE_RATE / AUDIO_ANALYSIS_FPS;
  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample++) {
    left[sample] = (pcm[(first + sample) * 2] ?? 0) / 32768;
    right[sample] = (pcm[(first + sample) * 2 + 1] ?? 0) / 32768;
  }
  return analyzeMixedBuffer([left, right], AUDIO_SAMPLE_RATE, AUDIO_ANALYSIS_FPS, frameCount);
}

function dominantBin(analysis: ReturnType<typeof analyzePcm>, startFrame: number, endFrame: number): number {
  let bestBin = 0;
  let bestMagnitude = -1;
  for (let bin = 0; bin < analysis.binsPerFrame; bin++) {
    let magnitude = 0;
    for (let frame = startFrame; frame < endFrame; frame++) {
      magnitude += analysis.frequencyBins[frame * analysis.binsPerFrame + bin] ?? 0;
    }
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestBin = bin;
    }
  }
  return bestBin;
}

function nearestKnownFrequency(bin: number, binsPerFrame: number): number {
  const frequency = bin * AUDIO_SAMPLE_RATE / (binsPerFrame * 2);
  return AUDIO_SPECTRUM_FREQUENCIES.reduce((best, candidate) =>
    Math.abs(candidate - frequency) < Math.abs(best - frequency) ? candidate : best);
}

function requireUnchangedGain(actual: number, reference: number) {
  const db = 20 * Math.log10(actual / reference);
  if (!Number.isFinite(actual) || actual <= 0 || !Number.isFinite(reference) || reference <= 0 || Math.abs(db) > 0.5) {
    throw new Error(`captured output gain mismatch: ${db.toFixed(3)} dB`);
  }
}

function audibleOnset(pcm: Int16Array): number {
  const blocks = Math.floor((pcm.length / 2) / (AUDIO_SAMPLE_RATE * AUDIO_BLOCK_SECONDS));
  for (let block = 0; block < blocks; block++) {
    const start = block * AUDIO_BLOCK_SECONDS;
    if (rms(pcm, start, start + AUDIO_BLOCK_SECONDS, 0) > AUDIO_ACTIVITY_RMS) return start;
  }
  throw new Error('audio comparison input is silent');
}

export type AudioJoinResult = {
  sharedOffsetSeconds: number;
  captureWindow: { start: number; end: number };
  exportWindow: { start: number; end: number };
  blocksCompared: number;
  spectrumWindowsCompared: number;
  dominantFrequencies: number[];
  channels: Array<{ captureRms: number; exportRms: number; gainDifferenceDb: number }>;
};

/**
 * Compare the same mixed Player output against the same normal MP4 export.
 * Onset is used once to establish one stream-wide capture offset; no clip or
 * channel is independently shifted, resampled, padded, or filtered.
 */
export function compareNativeAudio(capture: Pick<DecodedNativeAudio, 'pcm'>,
  exported: Pick<DecodedNativeAudio, 'pcm'>): AudioJoinResult {
  const captureOnset = audibleOnset(capture.pcm);
  const exportOnset = audibleOnset(exported.pcm);
  const sharedOffsetSeconds = captureOnset - exportOnset;
  const captureDuration = capture.pcm.length / 2 / AUDIO_SAMPLE_RATE - captureOnset;
  const exportDuration = exported.pcm.length / 2 / AUDIO_SAMPLE_RATE - exportOnset;
  const duration = Math.min(captureDuration, exportDuration);
  if (duration < AUDIO_SPECTRUM_SECONDS) throw new Error('audio comparison inputs do not overlap for a complete mix');
  const captureWindow = { start: captureOnset, end: captureOnset + duration };
  const exportWindow = {
    start: captureWindow.start - sharedOffsetSeconds,
    end: captureWindow.end - sharedOffsetSeconds,
  };

  const blocksCompared = Math.floor(duration / AUDIO_BLOCK_SECONDS);
  const captureAnalysis = analyzePcm(capture.pcm, captureWindow.start, blocksCompared);
  const exportAnalysis = analyzePcm(exported.pcm, exportWindow.start, blocksCompared);
  for (let block = 0; block < blocksCompared; block++) {
    const captureStart = captureWindow.start + block * AUDIO_BLOCK_SECONDS;
    const exportStart = exportWindow.start + block * AUDIO_BLOCK_SECONDS;
    const captureActive = rms(capture.pcm, captureStart, captureStart + AUDIO_BLOCK_SECONDS, 0) > AUDIO_ACTIVITY_RMS;
    const exportActive = rms(exported.pcm, exportStart, exportStart + AUDIO_BLOCK_SECONDS, 0) > AUDIO_ACTIVITY_RMS;
    if (captureActive !== exportActive) {
      throw new Error(`audio timing/envelope mismatch in block ${block}`);
    }
    if (captureActive && block > 0) {
      const captureBin = dominantBin(captureAnalysis, block, block + 1);
      const exportBin = dominantBin(exportAnalysis, block, block + 1);
      if (captureBin !== exportBin) {
        throw new Error(`audio frequency mismatch in block ${block}: capture bin ${captureBin}, export bin ${exportBin}`);
      }
      for (const channel of [0, 1]) {
        const captureBlockRms = rms(capture.pcm, captureStart, captureStart + AUDIO_BLOCK_SECONDS, channel);
        const exportBlockRms = rms(exported.pcm, exportStart, exportStart + AUDIO_BLOCK_SECONDS, channel);
        requireUnchangedGain(captureBlockRms, exportBlockRms);
      }
    }
  }

  const spectrumWindowsCompared = Math.floor(duration / AUDIO_SPECTRUM_SECONDS);
  const dominantFrequencies: number[] = [];
  let previousCapturePhase: number | undefined;
  let previousExportPhase: number | undefined;
  for (let window = 0; window < spectrumWindowsCompared; window++) {
    const captureStart = captureWindow.start + AUDIO_BLOCK_SECONDS + window * AUDIO_SPECTRUM_SECONDS;
    const exportStart = exportWindow.start + AUDIO_BLOCK_SECONDS + window * AUDIO_SPECTRUM_SECONDS;
    const captureActive = rms(capture.pcm, captureStart, captureStart + AUDIO_SPECTRUM_SECONDS, 0) > AUDIO_ACTIVITY_RMS;
    const exportActive = rms(exported.pcm, exportStart, exportStart + AUDIO_SPECTRUM_SECONDS, 0) > AUDIO_ACTIVITY_RMS;
    if (captureActive !== exportActive) throw new Error(`audio timing/envelope mismatch in spectrum window ${window}`);
    if (!captureActive) continue;
    const captureFrequency = nearestKnownFrequency(
      dominantBin(captureAnalysis, 1 + window * 5, 1 + (window + 1) * 5),
      captureAnalysis.binsPerFrame,
    );
    const exportFrequency = nearestKnownFrequency(
      dominantBin(exportAnalysis, 1 + window * 5, 1 + (window + 1) * 5),
      exportAnalysis.binsPerFrame,
    );
    const captureMeasurement = { frequency: captureFrequency, ...spectrum(capture.pcm, captureStart, captureStart + AUDIO_SPECTRUM_SECONDS, captureFrequency, 0) };
    const exportMeasurement = { frequency: exportFrequency, ...spectrum(exported.pcm, exportStart, exportStart + AUDIO_SPECTRUM_SECONDS, exportFrequency, 0) };
    if (captureMeasurement.amplitude < AUDIO_SPECTRUM_MIN_AMPLITUDE || exportMeasurement.amplitude < AUDIO_SPECTRUM_MIN_AMPLITUDE) {
      throw new Error(`audio frequency amplitude is below ${AUDIO_SPECTRUM_MIN_AMPLITUDE} in window ${window}`);
    }
    if (captureMeasurement.frequency !== exportMeasurement.frequency) {
      throw new Error(`audio frequency mismatch in window ${window}: capture ${captureMeasurement.frequency}Hz, export ${exportMeasurement.frequency}Hz`);
    }
    if (previousCapturePhase !== undefined && phaseDistance(captureMeasurement.phase, previousCapturePhase) > AUDIO_MAX_PHASE_STEP) {
      throw new Error(`audio capture phase discontinuity in window ${window}`);
    }
    if (previousExportPhase !== undefined && phaseDistance(exportMeasurement.phase, previousExportPhase) > AUDIO_MAX_PHASE_STEP) {
      throw new Error(`audio export phase discontinuity in window ${window}`);
    }
    previousCapturePhase = captureMeasurement.phase;
    previousExportPhase = exportMeasurement.phase;
    dominantFrequencies.push(captureMeasurement.frequency);
  }

  const summaryDuration = spectrumWindowsCompared * AUDIO_SPECTRUM_SECONDS;
  const channels = [0, 1].map(channel => {
    const captureStart = captureWindow.start + AUDIO_BLOCK_SECONDS;
    const exportStart = exportWindow.start + AUDIO_BLOCK_SECONDS;
    const captureRms = rms(capture.pcm, captureStart, captureStart + summaryDuration, channel);
    const exportRms = rms(exported.pcm, exportStart, exportStart + summaryDuration, channel);
    if (captureRms <= AUDIO_ACTIVITY_RMS || exportRms <= AUDIO_ACTIVITY_RMS) {
      throw new Error(`audio comparison mix is below ${AUDIO_ACTIVITY_RMS} RMS on channel ${channel}`);
    }
    requireUnchangedGain(captureRms, exportRms);
    return { captureRms, exportRms, gainDifferenceDb: 20 * Math.log10(captureRms / exportRms) };
  });
  return {
    sharedOffsetSeconds,
    captureWindow,
    exportWindow,
    blocksCompared,
    spectrumWindowsCompared,
    dominantFrequencies,
    channels,
  };
}
