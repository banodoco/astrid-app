import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNativePts, recordTabStream, TAB_AUDIO_MIME } from './tab-audio';

type MockListener = (event?: unknown) => void;
type MockStream = { getTracks: () => Array<{ kind: string; readyState: string }> };

class MockRecorder {
  state = 'inactive';
  private listeners = new Map<string, MockListener>();
  constructor(
    private readonly stream: MockStream,
    private readonly options: { mimeType: string },
    private readonly mode: 'normal' | 'error' | 'abort' | 'start-failure',
  ) {
    assert.equal(options.mimeType, TAB_AUDIO_MIME);
    assert.ok(stream.getTracks().length > 0);
  }

  addEventListener(name: string, listener: MockListener): void {
    this.listeners.set(name, listener);
  }

  start(): void {
    if (this.mode === 'start-failure') throw new Error('recorder start failed');
    this.state = 'recording';
    if (this.mode === 'error' || this.mode === 'abort') {
      this.listeners.get(this.mode)?.(new Error(`recorder ${this.mode}`));
      return;
    }
    queueMicrotask(() => this.listeners.get('dataavailable')?.({ data: { arrayBuffer: async () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]) } }));
  }

  stop(): void {
    this.state = 'inactive';
    queueMicrotask(() => this.listeners.get('stop')?.());
  }
}

function mockBackend(
  overrides: Partial<Record<'warm' | 'ready' | 'play' | 'wait' | 'stopPlayer', () => Promise<void>>> = {},
  kinds: string[] = ['video', 'audio'],
  recorderMode: 'normal' | 'error' | 'abort' | 'start-failure' = 'normal',
) {
  const tracks = [
    ...kinds.map(kind => ({ kind, readyState: 'live', stopped: false, stop: () => undefined })),
  ];
  const events: string[] = [];
  const stream = {
    getTracks: () => tracks,
  };
  class Recorder extends MockRecorder {
    constructor(stream: MockStream, options: { mimeType: string }) {
      super(stream, options, recorderMode);
    }
  }
  return {
    backend: {
      getDisplayMedia: async () => { events.push('getDisplayMedia'); return stream; },
      MediaRecorder: Recorder,
      warm: overrides.warm ?? (async () => { events.push('warm'); }),
      ready: overrides.ready ?? (async () => { events.push('ready'); }),
      play: overrides.play ?? (async () => { events.push('play'); }),
      wait: overrides.wait ?? (async () => { events.push('wait'); }),
      stopPlayer: overrides.stopPlayer ?? (async () => { events.push('stopPlayer'); }),
    },
    events,
    tracks,
  } as const;
}

test('stream mocks start the recorder before warm/readiness/play and retain mux bytes', async () => {
  const mock = mockBackend();
  const result = await recordTabStream({ durationMs: 1 }, mock.backend);
  assert.deepEqual(result.events, ['before-warm', 'stream:ready', 'recorder:start', 'warm', 'readiness', 'play', 'recorder:stop', 'tracks:stop', 'cleanup']);
  assert.deepEqual(mock.events, ['getDisplayMedia', 'warm', 'ready', 'play', 'wait', 'stopPlayer']);
  assert.deepEqual(result.chunks, ['GkXfow==']);
  assert.deepEqual(result.tracks, [{ kind: 'video', readyState: 'live' }, { kind: 'audio', readyState: 'live' }]);
  assert.equal(result.events.indexOf('recorder:start') < result.events.indexOf('warm'), true);
  assert.equal(result.events.indexOf('warm') < result.events.indexOf('readiness'), true);
  assert.equal(result.events.indexOf('readiness') < result.events.indexOf('play'), true);
});

test('stream failure still stops the recorder tracks without asserting physical audio mix', async () => {
  const mock = mockBackend({ warm: async () => { throw new Error('warm failed'); } });
  let stopped = 0;
  for (const track of mock.tracks) track.stop = () => { stopped++; };
  await assert.rejects(recordTabStream({}, mock.backend), /warm failed/);
  assert.equal(stopped, 2);
});

for (const mode of ['error', 'abort'] as const) {
  test(`recorder ${mode} rejects and stops every capture track`, async () => {
    const mock = mockBackend({ wait: async () => { await new Promise(resolve => setTimeout(resolve, 5)); } }, ['video', 'audio'], mode);
    let stopped = 0;
    for (const track of mock.tracks) track.stop = () => { stopped++; };
    await assert.rejects(recordTabStream({}, mock.backend), new RegExp(`recorder ${mode}`));
    assert.equal(stopped, 2);
  });
}

test('missing audio and wrong track cardinality reject with cleanup', async () => {
  for (const kinds of [['video'], ['video', 'audio', 'audio'], ['video', 'video', 'audio']]) {
    const mock = mockBackend({}, kinds);
    let stopped = 0;
    for (const track of mock.tracks) track.stop = () => { stopped++; };
    await assert.rejects(recordTabStream({}, mock.backend), /exactly one video and one audio track/);
    assert.equal(stopped, kinds.length);
  }
});

test('recorder start failure rejects and stops the acquired tracks', async () => {
  const mock = mockBackend({}, ['video', 'audio'], 'start-failure');
  let stopped = 0;
  for (const track of mock.tracks) track.stop = () => { stopped++; };
  await assert.rejects(recordTabStream({}, mock.backend), /recorder start failed/);
  assert.equal(stopped, 2);
});

test('native packet timestamps are required for one video and one audio stream', () => {
  assertNativePts({
    streams: [
      { index: 0, codec_type: 'video', time_base: '1/1000' },
      { index: 1, codec_type: 'audio', time_base: '1/48000' },
    ],
    packets: [
      { stream_index: 1, codec_type: 'audio', pts: '0', pts_time: '0' },
      { stream_index: 0, codec_type: 'video', pts: '42', pts_time: '0.042' },
      { stream_index: 1, codec_type: 'audio', pts: '960', pts_time: '0.020' },
      { stream_index: 0, codec_type: 'video', pts: '83', pts_time: '0.083' },
    ],
    format: {},
  });
  assert.throws(() => assertNativePts({
    streams: [
      { index: 0, codec_type: 'video', time_base: '1/1000' },
      { index: 1, codec_type: 'audio', time_base: '1/48000' },
    ],
    packets: [
      { stream_index: 0, codec_type: 'video', pts: '42', pts_time: '0.042' },
      { stream_index: 0, codec_type: 'video', pts: '41', pts_time: '0.041' },
      { stream_index: 1, codec_type: 'audio', pts: '0', pts_time: '0' },
    ],
    format: {},
  }), /video packet pts are not monotonic/);
});

test('native PTS refuses an empty audio stream or invalid native fields', () => {
  const streams = [
    { index: 0, codec_type: 'video', time_base: '1/1000' },
    { index: 1, codec_type: 'audio', time_base: '1/48000' },
  ];
  assert.throws(() => assertNativePts({ streams, packets: [
    { stream_index: 0, codec_type: 'video', pts: '0', pts_time: '0' },
  ], format: {} }), /no native audio packets/);
  assert.throws(() => assertNativePts({ streams, packets: [
    { stream_index: 0, codec_type: 'video', pts: '0', pts_time: '0' },
    { stream_index: 1, codec_type: 'audio', pts: '0', pts_time: 'NaN' },
  ], format: {} }), /finite native pts_time/);
  assert.throws(() => assertNativePts({ streams: [
    streams[0], { ...streams[1], time_base: '0/0' },
  ], packets: [
    { stream_index: 0, codec_type: 'video', pts: '0', pts_time: '0' },
    { stream_index: 1, codec_type: 'audio', pts: '0', pts_time: '0' },
  ], format: {} }), /missing a native time base/);
});
