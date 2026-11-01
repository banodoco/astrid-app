import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIO_SAMPLE_RATE, compareNativeAudio } from './audio-join';

function tone(start: number, gain = 1, frequency = 440, fadeOutAt?: number): Int16Array {
  const pcm = new Int16Array(AUDIO_SAMPLE_RATE * 1.5 * 2);
  for (let frame = Math.floor(start * AUDIO_SAMPLE_RATE); frame < pcm.length / 2; frame++) {
    const elapsed = frame / AUDIO_SAMPLE_RATE - start;
    const envelope = fadeOutAt === undefined ? 1 : Math.max(0, Math.min(1, (fadeOutAt - elapsed) / 0.2));
    const value = Math.round(Math.sin(2 * Math.PI * frequency * frame / AUDIO_SAMPLE_RATE) * 12_000 * gain * envelope);
    pcm[frame * 2] = value;
    pcm[frame * 2 + 1] = value;
  }
  return pcm;
}

test('same-export audio join compares both native stereo channels with one shared offset', () => {
  const result = compareNativeAudio({ pcm: tone(0.1) }, { pcm: tone(0.25) });
  assert.ok(Math.abs(result.sharedOffsetSeconds + 0.14) < 0.001);
  assert.ok(Math.abs(result.channels[0].gainDifferenceDb) < 0.01);
  assert.ok(Math.abs(result.channels[1].gainDifferenceDb) < 0.01);
  assert.ok(result.blocksCompared > 60);
  assert.ok(result.spectrumWindowsCompared > 10);
  assert.deepEqual(result.dominantFrequencies, Array(result.spectrumWindowsCompared).fill(440));
});

test('same-export audio join rejects a wrong-frequency export after a positive baseline', () => {
  assert.doesNotThrow(() => compareNativeAudio({ pcm: tone(0.1) }, { pcm: tone(0.25) }));
  assert.throws(
    () => compareNativeAudio({ pcm: tone(0.1) }, { pcm: tone(0.25, 1, 880) }),
    /audio frequency mismatch/,
  );
});

test('same-export audio join catches a bounded capture-gain mismatch', () => {
  assert.doesNotThrow(() => compareNativeAudio({ pcm: tone(0.1) }, { pcm: tone(0.25) }));
  assert.throws(
    () => compareNativeAudio({ pcm: tone(0.1, 0.5) }, { pcm: tone(0.25) }),
    /captured output gain mismatch: -6\./,
  );
});

test('same-export audio join rejects a shifted envelope after a positive faded baseline', () => {
  assert.doesNotThrow(() => compareNativeAudio({ pcm: tone(0.1, 1, 440, 1.1) }, { pcm: tone(0.1, 1, 440, 1.1) }));
  assert.throws(
    () => compareNativeAudio({ pcm: tone(0.1, 1, 440, 0.8) }, { pcm: tone(0.1, 1, 440, 1.1) }),
    /audio timing\/envelope mismatch|captured output gain mismatch/,
  );
});
