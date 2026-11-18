import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const remotionMocks = vi.hoisted(() => ({
  delayRender: vi.fn(() => 101),
  continueRender: vi.fn(),
  cancelRender: vi.fn(),
}));

const remotionState = vi.hoisted(() => ({
  environment: {
    isRendering: false,
    isClientSideRendering: false,
    isServerRendering: false,
    isHeadless: false,
    isPreview: false,
  },
}));

vi.mock('remotion', () => ({
  delayRender: remotionMocks.delayRender,
  continueRender: remotionMocks.continueRender,
  cancelRender: remotionMocks.cancelRender,
  useRemotionEnvironment: vi.fn(() => remotionState.environment),
}));

import {
  AudioAnalysisProvider,
  createFrameSource,
  resetWarmedAudioUrls,
  SILENT_AUDIO_DATA,
  useAudioAnalysisContext,
} from '@/tools/video-editor/compositions/AudioAnalysisProvider';
import {
  buildAudioMixRequest,
  resetAudioAnalysisCaches,
  setAudioAnalysisWorkerFactory,
} from '@/tools/video-editor/compositions/audio-analysis/audioAnalysisClient';
import {
  handleWorkerMessage,
} from '@/tools/video-editor/compositions/audio-analysis/audioAnalysis.worker';
import type {
  AudioAnalysisCancelMessage,
  AudioAnalysisWorkerLike,
  AudioAnalysisWorkerReply,
  AudioAnalysisWorkerRequest,
  PackedAudioAnalysis,
} from '@/tools/video-editor/compositions/audio-analysis/audioAnalysis.protocol';
import type { ResolvedTimelineClip } from '@/tools/video-editor/types';

type MockAudioBuffer = AudioBuffer;

function createMockAudioBuffer(
  samples: Float32Array,
  sampleRate = 44_100,
): MockAudioBuffer {
  return {
    length: samples.length,
    duration: samples.length / sampleRate,
    numberOfChannels: 1,
    sampleRate,
    getChannelData: () => samples,
  } as unknown as MockAudioBuffer;
}

function createFrameSineSamples({
  fps,
  frameAmplitudes,
  frequency = 100,
  sampleRate = 44_100,
}: {
  fps: number;
  frameAmplitudes: number[];
  frequency?: number;
  sampleRate?: number;
}): Float32Array {
  const samplesPerFrame = Math.floor(sampleRate / fps);
  const samples = new Float32Array(samplesPerFrame * frameAmplitudes.length);

  frameAmplitudes.forEach((amplitude, frameIndex) => {
    const frameOffset = frameIndex * samplesPerFrame;
    for (let index = 0; index < samplesPerFrame; index += 1) {
      const time = index / sampleRate;
      samples[frameOffset + index] = amplitude * Math.sin(2 * Math.PI * frequency * time);
    }
  });

  return samples;
}

class MockOfflineAudioContext {
  static decodedBuffer: MockAudioBuffer;
  static renderedBuffers: MockAudioBuffer[] = [];
  static renderIndex = 0;

  destination = {};

  createBufferSource() {
    return {
      buffer: null as AudioBuffer | null,
      playbackRate: { value: 1 },
      connect: vi.fn(),
      start: vi.fn(),
    };
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect: vi.fn(),
    };
  }

  async decodeAudioData(_buffer: ArrayBuffer) {
    return MockOfflineAudioContext.decodedBuffer;
  }

  async startRendering() {
    const buffers = MockOfflineAudioContext.renderedBuffers;
    const index = MockOfflineAudioContext.renderIndex;
    if (index < buffers.length) {
      MockOfflineAudioContext.renderIndex += 1;
    }
    return buffers[Math.min(index, buffers.length - 1)] ?? MockOfflineAudioContext.decodedBuffer;
  }
}

function computeWorkerReplySync(message: AudioAnalysisWorkerRequest): AudioAnalysisWorkerReply {
  let captured: AudioAnalysisWorkerReply | null = null;
  handleWorkerMessage(message, (reply) => {
    captured = reply;
  });
  if (!captured) {
    throw new Error('worker produced no reply');
  }
  return captured;
}

class FakeAudioAnalysisWorker implements AudioAnalysisWorkerLike {
  onmessage: ((event: MessageEvent<AudioAnalysisWorkerReply>) => void) | null = null;

  posted: AudioAnalysisWorkerRequest[] = [];

  autoDeliver = true;

  failWith: string | null = null;

  private replies: AudioAnalysisWorkerReply[] = [];

  postMessage(message: AudioAnalysisWorkerRequest, _transfer?: Transferable[]): void {
    this.posted.push(message);
    if (message.type === 'cancel') {
      return;
    }
    const reply = this.failWith
      ? { type: 'error' as const, id: message.id, message: this.failWith }
      : computeWorkerReplySync(message);
    this.replies.push(reply);
    if (this.autoDeliver) {
      setTimeout(() => {
        this.onmessage?.({ data: reply } as MessageEvent<AudioAnalysisWorkerReply>);
      }, 0);
    }
  }

  terminate(): void {}

  deliver(id: number): void {
    const index = this.replies.findIndex((reply) => reply.id === id);
    if (index >= 0) {
      const [reply] = this.replies.splice(index, 1);
      this.onmessage?.({ data: reply } as MessageEvent<AudioAnalysisWorkerReply>);
    }
  }

  analyzePosts(): number {
    return this.posted.filter((message) => message.type === 'analyze').length;
  }

  cancelIds(): number[] {
    return this.posted
      .filter((message): message is AudioAnalysisCancelMessage => message.type === 'cancel')
      .map((message) => message.id);
  }
}

function AnalysisSummary({ testId = 'analysis' }: { testId?: string }) {
  const analysis = useAudioAnalysisContext();
  const length = analysis?.length ?? 0;
  const first = analysis?.getFrame(0) ?? null;
  const second = analysis?.getFrame(1) ?? null;
  const beatFrames = Array.from(
    { length },
    (_, index) => (analysis?.getFrame(index).isBeat ? index : -1),
  ).filter((index) => index >= 0);
  const summary = {
    length,
    first: first
      ? {
        amplitude: first.amplitude,
        bass: first.bass,
        treble: first.treble,
        isBeat: first.isBeat,
      }
      : null,
    second: second
      ? {
        amplitude: second.amplitude,
        bass: second.bass,
        treble: second.treble,
        isBeat: second.isBeat,
      }
      : null,
    beatFrames,
  };

  return <pre data-testid={testId}>{JSON.stringify(summary)}</pre>;
}

function parseSummary(testId = 'analysis') {
  return JSON.parse(screen.getByTestId(testId).textContent ?? '{}') as {
    length: number;
    first: { amplitude: number; bass: number; treble: number; isBeat: boolean } | null;
    second: { amplitude: number; bass: number; treble: number; isBeat: boolean } | null;
    beatFrames: number[];
  };
}

function createAudioClip(overrides: Partial<ResolvedTimelineClip> = {}): ResolvedTimelineClip {
  return {
    id: 'audio-clip',
    at: 0,
    track: 'A1',
    asset: 'asset-1',
    from: 0,
    to: 1.2,
    speed: 1,
    volume: 1,
    assetEntry: {
      file: 'audio.wav',
      src: 'https://example.com/audio.wav',
      duration: 1.2,
      type: 'audio/wav',
    },
    ...overrides,
  };
}

const createVisualClip = (id: string, at: number): ResolvedTimelineClip => ({
  id,
  at,
  track: 'V1',
  clipType: 'hold',
  hold: 2,
});

const FPS = 10;
const AMPLITUDES = [0, 0.1, 1, 0.1, 0.1, 0.1, 1, 0.1, 0.1, 0.1, 1, 0.1];

function createRenderedFixtureBuffer(): MockAudioBuffer {
  return createMockAudioBuffer(createFrameSineSamples({
    fps: FPS,
    frameAmplitudes: AMPLITUDES,
  }));
}

const flushAsync = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

/** Flush microtasks AND 0ms timers (chunk-copy yields, fake worker delivery). */
const flushWithFakeTimers = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) {
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
  }
};

const analyzeJobIds = (worker: FakeAudioAnalysisWorker | null): number[] => {
  if (!worker) {
    return [];
  }
  return worker.posted
    .filter((message): message is Extract<AudioAnalysisWorkerRequest, { type: 'analyze' }> => (
      message.type === 'analyze'
    ))
    .map((message) => message.id);
};

const stubAudioEnvironment = (): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })));
  vi.stubGlobal('OfflineAudioContext', MockOfflineAudioContext);
};

let fakeWorker: FakeAudioAnalysisWorker | null = null;
let workerFailWith: string | null = null;
let workerAutoDeliver = true;

describe('AudioAnalysisProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeWorker = null;
    workerFailWith = null;
    workerAutoDeliver = true;
    remotionState.environment = {
      isRendering: false,
      isClientSideRendering: false,
      isServerRendering: false,
      isHeadless: false,
      isPreview: false,
    };
    setAudioAnalysisWorkerFactory(() => {
      const created = new FakeAudioAnalysisWorker();
      created.failWith = workerFailWith;
      created.autoDeliver = workerAutoDeliver;
      fakeWorker = created;
      return created;
    });
    resetAudioAnalysisCaches();
    resetWarmedAudioUrls();
    MockOfflineAudioContext.renderedBuffers = [];
    MockOfflineAudioContext.renderIndex = 0;
    stubAudioEnvironment();
  });

  afterEach(() => {
    setAudioAnalysisWorkerFactory(null);
    resetAudioAnalysisCaches();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('warms each unique preview audio URL once, streaming at most three at a time', async () => {
    const pending: Array<{ url: string; body: ReadableStreamDefaultController<Uint8Array> }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(body) {
        pending.push({ url, body });
      },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const urls = ['https://example.com/one.wav', 'https://example.com/two.wav', 'https://example.com/three.wav', 'https://example.com/four.wav'];
    const clips = [...urls, urls[0]].map((url, index) => createAudioClip({
      id: `clip-${index}`,
      assetEntry: { ...createAudioClip().assetEntry!, src: ` ${url} ` },
    }));

    const view = render(
      <AudioAnalysisProvider clips={clips} fps={FPS} totalDurationInFrames={3} enabled={false}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.every(([, init]) => init.credentials === 'include' && init.priority === 'low')).toBe(true);
    pending[0].body.enqueue(new Uint8Array(8));
    pending[0].body.close();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    pending.slice(1).forEach(({ body }) => body.close());
    await waitFor(() => expect(new Set(fetchMock.mock.calls.map(([url]) => url))).toEqual(new Set(urls)));

    view.rerender(
      <AudioAnalysisProvider clips={[...clips]} fps={FPS} totalDurationInFrames={3} enabled={false}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('warms hosted Runtime media without browser credentials or a credentialed CORS response', async () => {
    const url = 'http://127.0.0.1:17340/api/astrid/v1/objects/sha256:abc';
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(8)));
    vi.stubGlobal('fetch', fetchMock);
    render(<AudioAnalysisProvider clips={[createAudioClip({ assetEntry: { ...createAudioClip().assetEntry!, src: url } })]} fps={FPS} totalDurationInFrames={3} enabled={false}><AnalysisSummary /></AudioAnalysisProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', priority: 'low' }));
  });

  it('does not add a warm fetch when analysis already fetches the audio', async () => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();
    render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={3}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await waitFor(() => expect(fakeWorker?.analyzePosts()).toBe(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://example.com/audio.wav');
  });

  it.each(['isRendering', 'isClientSideRendering'] as const)('does not warm audio during %s', (mode) => {
    remotionState.environment = { ...remotionState.environment, [mode]: true };
    render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={3} enabled={false}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('warms a newly added source once without re-fetching or aborting the sources already warmed', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start() {} })));
    vi.stubGlobal('fetch', fetchMock);
    const source = (src: string) => createAudioClip({ assetEntry: { ...createAudioClip().assetEntry!, src } });
    const [a, b, c] = ['https://example.com/a.wav', 'https://example.com/b.wav', 'https://example.com/c.wav'];
    const view = render(
      <AudioAnalysisProvider clips={[source(a), source(b)]} fps={FPS} totalDurationInFrames={3} enabled={false}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.rerender(
      <AudioAnalysisProvider clips={[source(a), source(b), source(c)]} fps={FPS} totalDurationInFrames={3} enabled={false}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([a, b, c]);

    view.rerender(
      <AudioAnalysisProvider clips={[source(c), source(b), source(a)]} fps={FPS} totalDurationInFrames={3} enabled={false}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('forgets a failed warm so the next pass retries it', async () => {
    const flaky = 'https://example.com/flaky.wav';
    const other = 'https://example.com/other.wav';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(new Uint8Array(8)));
    vi.stubGlobal('fetch', fetchMock);
    const source = (src: string) => createAudioClip({ assetEntry: { ...createAudioClip().assetEntry!, src } });
    const view = render(
      <AudioAnalysisProvider clips={[source(flaky)]} fps={FPS} totalDurationInFrames={3} enabled={false}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushAsync();
    view.rerender(
      <AudioAnalysisProvider clips={[source(flaky), source(other)]} fps={FPS} totalDurationInFrames={3} enabled={false}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([flaky, flaky, other]);
  });

  it('provides silent data and continues render immediately when there are no clips', async () => {
    render(
      <AudioAnalysisProvider clips={[]} fps={30} totalDurationInFrames={3}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    const summary = parseSummary();

    expect(summary.length).toBe(3);
    expect(summary.first).toEqual({
      amplitude: 0,
      bass: 0,
      treble: 0,
      isBeat: false,
    });
    expect(remotionMocks.delayRender).toHaveBeenCalledWith('Audio analysis');
    expect(remotionMocks.continueRender).toHaveBeenCalledWith(101);
    expect(remotionMocks.cancelRender).not.toHaveBeenCalled();
    expect(fakeWorker?.analyzePosts() ?? 0).toBe(0);
  });

  it('analyzes a rendered audio buffer into frame-indexed data with beat detection', async () => {
    const renderedBuffer = createRenderedFixtureBuffer();
    MockOfflineAudioContext.decodedBuffer = renderedBuffer;

    render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      const summary = parseSummary();
      expect(summary.second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });

    const summary = parseSummary();
    expect(summary.length).toBe(AMPLITUDES.length);
    expect(summary.first?.amplitude ?? 1).toBeLessThan(0.01);
    expect(summary.second?.bass ?? 0).toBeGreaterThan(summary.second?.treble ?? 0);
    expect(summary.beatFrames.length).toBeGreaterThan(0);
    expect(summary.beatFrames).toContain(2);
    expect(fakeWorker?.analyzePosts()).toBe(1);
    expect(remotionMocks.continueRender).toHaveBeenCalledWith(101);
    expect(remotionMocks.cancelRender).not.toHaveBeenCalled();
  });

  it('continues render on unmount while analysis is still pending and never cancels render', async () => {
    remotionState.environment = {
      ...remotionState.environment,
      isRendering: true,
    };
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();
    workerAutoDeliver = false;

    const view = render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={3}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => expect(fakeWorker?.analyzePosts()).toBe(1));
    const jobId = analyzeJobIds(fakeWorker)[0];

    view.unmount();

    expect(remotionMocks.continueRender).toHaveBeenCalledWith(101);
    expect(remotionMocks.cancelRender).not.toHaveBeenCalled();
    expect(fakeWorker?.cancelIds()).toContain(jobId);
  });

  it('produces exactly one analysis request for fresh equal clip arrays', async () => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const view = render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(1);
    });
    await waitFor(() => {
      expect(parseSummary().second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });

    const before = parseSummary();
    view.rerender(
      <AudioAnalysisProvider
        clips={[{ ...createAudioClip(), label: 'same-content-fresh-object' }]}
        fps={FPS}
        totalDurationInFrames={AMPLITUDES.length}
      >
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await flushAsync();

    expect(fakeWorker?.analyzePosts()).toBe(1);
    expect(parseSummary()).toEqual(before);
  });

  it('adds zero requests for visual edits and save-ack rerenders', async () => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const clips = [createAudioClip(), createVisualClip('v1', 0)];
    const view = render(
      <AudioAnalysisProvider clips={clips} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(1);
    });

    // Visual clip moved (fresh arrays, fresh clip objects).
    view.rerender(
      <AudioAnalysisProvider
        clips={[clips[0], createVisualClip('v1', 1.5)]}
        fps={FPS}
        totalDurationInFrames={AMPLITUDES.length}
      >
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await flushAsync();
    expect(fakeWorker?.analyzePosts()).toBe(1);

    // Save acknowledgement: identical semantic content, brand-new array.
    view.rerender(
      <AudioAnalysisProvider
        clips={[{ ...createAudioClip(), label: 'ack' }, createVisualClip('v1', 1.5)]}
        fps={FPS}
        totalDurationInFrames={AMPLITUDES.length}
      >
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await flushAsync();
    expect(fakeWorker?.analyzePosts()).toBe(1);
  });

  it.each([
    ['asset revision', (clip: ResolvedTimelineClip) => ({
      ...clip,
      assetEntry: { ...clip.assetEntry!, content_sha256: 'rev-2' },
    })],
    ['declared duration', (clip: ResolvedTimelineClip) => ({
      ...clip,
      assetEntry: { ...clip.assetEntry!, duration: 1.5 },
    })],
    ['at', (clip: ResolvedTimelineClip) => ({ ...clip, at: 0.5 })],
    ['from', (clip: ResolvedTimelineClip) => ({ ...clip, from: 0.2 })],
    ['to', (clip: ResolvedTimelineClip) => ({ ...clip, to: 0.8 })],
    ['speed', (clip: ResolvedTimelineClip) => ({ ...clip, speed: 2 })],
    ['volume', (clip: ResolvedTimelineClip) => ({ ...clip, volume: 0.5 })],
  ])('invalidates exactly once when %s changes', async (_name, mutate) => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const view = render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(1);
    });

    view.rerender(
      <AudioAnalysisProvider clips={[mutate(createAudioClip())]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(2);
    });
    await flushAsync();
    expect(fakeWorker?.analyzePosts()).toBe(2);
  });

  it('invalidates exactly once when fps changes', async () => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const view = render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(1);
    });

    view.rerender(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={12} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(2);
    });
    await flushAsync();
    expect(fakeWorker?.analyzePosts()).toBe(2);
  });

  it('does not rerun analysis when totalDurationInFrames changes; exposed tail frames are silent', async () => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const view = render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(parseSummary().second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });

    view.rerender(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={20}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    await flushAsync();

    expect(fakeWorker?.analyzePosts()).toBe(1);
    const summary = parseSummary();
    expect(summary.length).toBe(20);
    expect(summary.second?.amplitude ?? 0).toBeGreaterThan(0.05);
  });

  it('shares one in-flight request for equal keys and later hits the completed cache', async () => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const view = render(
      <>
        <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
          <AnalysisSummary testId="analysis-a" />
        </AudioAnalysisProvider>
        <AudioAnalysisProvider
          clips={[{ ...createAudioClip(), label: 'second-instance' }]}
          fps={FPS}
          totalDurationInFrames={AMPLITUDES.length}
        >
          <AnalysisSummary testId="analysis-b" />
        </AudioAnalysisProvider>
      </>,
    );

    await waitFor(() => {
      expect(parseSummary('analysis-a').second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });
    await waitFor(() => {
      expect(parseSummary('analysis-b').second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });
    expect(fakeWorker?.analyzePosts()).toBe(1);

    view.unmount();

    render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary testId="analysis-c" />
      </AudioAnalysisProvider>,
    );
    await waitFor(() => {
      expect(parseSummary('analysis-c').second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });
    expect(fakeWorker?.analyzePosts()).toBe(1);
  });

  it('evicts failed requests so a retry can succeed', async () => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();
    workerFailWith = 'boom';

    const first = render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary testId="analysis-first" />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(1);
    });
    await waitFor(() => {
      expect(parseSummary('analysis-first').first?.amplitude ?? 1).toBe(0);
    });
    expect(remotionMocks.continueRender).toHaveBeenCalledWith(101);

    first.unmount();
    if (fakeWorker) {
      fakeWorker.failWith = null;
    }

    render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary testId="analysis-retry" />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(parseSummary('analysis-retry').second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });
    expect(fakeWorker?.analyzePosts()).toBe(2);
  });

  it('retries with refreshed asset URLs after a failed fetch for the same semantic key', async () => {
    const deadSrc = 'https://example.com/audio.wav?expired=1';
    const refreshedSrc = 'https://example.com/audio.wav?sig=refreshed';
    const deadClip = createAudioClip({
      assetEntry: {
        file: 'audio.wav',
        src: deadSrc,
        duration: 1.2,
        type: 'audio/wav',
        content_sha256: 'sha-retry-url',
      },
    });
    const refreshedClip = createAudioClip({
      assetEntry: {
        ...deadClip.assetEntry!,
        src: refreshedSrc,
      },
    });
    const fetchMock = vi.fn(async (url: string) => (
      url === deadSrc
        ? new Response(null, { status: 403 })
        : new Response(new ArrayBuffer(8), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const first = render(
      <AudioAnalysisProvider clips={[deadClip]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary testId="analysis-dead" />
      </AudioAnalysisProvider>,
    );

    // The dead signed URL fails the fetch; the failed decode is evicted.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(deadSrc);
    });
    await flushAsync();
    first.unmount();

    // Same semantic key (sha identity), refreshed URL: the provider passes the
    // fresh candidate request, so the retry fetches the new URL and analyzes.
    render(
      <AudioAnalysisProvider clips={[refreshedClip]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary testId="analysis-refreshed" />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(parseSummary('analysis-refreshed').second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, deadSrc);
    expect(fetchMock).toHaveBeenNthCalledWith(2, refreshedSrc);
    expect(fakeWorker?.analyzePosts()).toBe(1);
  });

  it('retries with a refreshed asset URL on rerender WITHOUT unmount for the same semantic key', async () => {
    const deadSrc = 'https://example.com/audio.wav?expired=rerender';
    const refreshedSrc = 'https://example.com/audio.wav?sig=rerender-refreshed';
    const deadClip = createAudioClip({
      assetEntry: {
        file: 'audio.wav',
        src: deadSrc,
        duration: 1.2,
        type: 'audio/wav',
        content_sha256: 'sha-rerender-url',
      },
    });
    const refreshedClip = createAudioClip({
      assetEntry: {
        ...deadClip.assetEntry!,
        src: refreshedSrc,
      },
    });
    const fetchMock = vi.fn(async (url: string) => (
      url === deadSrc
        ? new Response(null, { status: 403 })
        : new Response(new ArrayBuffer(8), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    // The identity is content_sha256, so the URL refresh keeps the semantic key.
    expect(buildAudioMixRequest([deadClip], FPS).key).toBe(buildAudioMixRequest([refreshedClip], FPS).key);

    const view = render(
      <AudioAnalysisProvider clips={[deadClip]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary testId="analysis-dead-mounted" />
      </AudioAnalysisProvider>,
    );

    // The dead signed URL fails the fetch; the mounted provider stays silent.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(deadSrc);
    });
    await flushAsync();
    expect(parseSummary('analysis-dead-mounted').second?.amplitude ?? 1).toBe(0);

    // SAME mounted provider, refreshed src for the SAME content_sha256/key:
    // change only the src in the asset entry, keep everything else identical.
    view.rerender(
      <AudioAnalysisProvider clips={[refreshedClip]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary testId="analysis-dead-mounted" />
      </AudioAnalysisProvider>,
    );

    // The interned request identity must change so the effect re-runs with the
    // refreshed URL — no remount involved.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(refreshedSrc);
    });
    await waitFor(() => {
      expect(parseSummary('analysis-dead-mounted').second?.amplitude ?? 0).toBeGreaterThan(0.05);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, deadSrc);
    expect(fetchMock).toHaveBeenNthCalledWith(2, refreshedSrc);
    // Same semantic key throughout: exactly one worker job for the shared key.
    expect(fakeWorker?.analyzePosts()).toBe(1);

    // A further rerender with identical sources keeps the interned identity
    // stable: no fetch, no re-analysis (completed cache is keyed by the same
    // semantic key).
    view.rerender(
      <AudioAnalysisProvider clips={[{ ...refreshedClip }]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary testId="analysis-dead-mounted" />
      </AudioAnalysisProvider>,
    );
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fakeWorker?.analyzePosts()).toBe(1);
  });

  it('never lets a stale cancelled reply replace current data', async () => {
    remotionState.environment = {
      ...remotionState.environment,
      isRendering: true,
    };
    const loudBuffer = createMockAudioBuffer(createFrameSineSamples({
      fps: FPS,
      frameAmplitudes: [0, 1, 1, 1],
    }));
    const quietBuffer = createMockAudioBuffer(createFrameSineSamples({
      fps: FPS,
      frameAmplitudes: [0, 0.25, 0.25, 0.25],
    }));
    MockOfflineAudioContext.decodedBuffer = loudBuffer;
    MockOfflineAudioContext.renderedBuffers = [loudBuffer, quietBuffer];
    if (fakeWorker) {
      fakeWorker.autoDeliver = false;
    }

    const loudClip = createAudioClip();
    const quietClip = createAudioClip({ at: 0.5 });

    const view = render(
      <AudioAnalysisProvider clips={[loudClip]} fps={FPS} totalDurationInFrames={4}>
        <AnalysisSummary testId="analysis-current" />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(1);
    });
    const [loudJobId] = analyzeJobIds(fakeWorker);

    view.rerender(
      <AudioAnalysisProvider clips={[quietClip]} fps={FPS} totalDurationInFrames={4}>
        <AnalysisSummary testId="analysis-current" />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(2);
    });
    expect(fakeWorker?.cancelIds()).toContain(loudJobId);

    const quietJobId = analyzeJobIds(fakeWorker)[1];
    fakeWorker?.deliver(quietJobId);
    await flushAsync();

    const afterQuiet = parseSummary('analysis-current');
    expect(afterQuiet.second?.amplitude ?? 1).toBeLessThan(0.3);

    fakeWorker?.deliver(loudJobId);
    await flushAsync();

    const afterStale = parseSummary('analysis-current');
    expect(afterStale).toEqual(afterQuiet);
  });

  it('returns silence and releases render when the worker fails', async () => {
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();
    workerFailWith = 'worker crashed';

    render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await waitFor(() => {
      expect(fakeWorker?.analyzePosts()).toBe(1);
    });
    await waitFor(() => {
      expect(parseSummary().second?.amplitude ?? 1).toBe(0);
    });

    const summary = parseSummary();
    expect(summary.length).toBe(AMPLITUDES.length);
    expect(summary.beatFrames).toEqual([]);
    expect(remotionMocks.continueRender).toHaveBeenCalledWith(101);
    expect(remotionMocks.cancelRender).not.toHaveBeenCalled();
  });

  it('debounces only uncached interactive-preview requests (trailing)', async () => {
    vi.useFakeTimers();
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const view = render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    view.rerender(
      <AudioAnalysisProvider clips={[createAudioClip({ at: 0.3 })]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );
    view.rerender(
      <AudioAnalysisProvider clips={[createAudioClip({ at: 0.6 })]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await act(async () => {
      vi.advanceTimersByTime(119);
    });
    expect(fakeWorker?.analyzePosts() ?? 0).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flushWithFakeTimers();

    expect(fakeWorker?.analyzePosts()).toBe(1);
  });

  it('does not reset the debounce for a fresh equal clip array', async () => {
    vi.useFakeTimers();
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    const view = render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await act(async () => {
      vi.advanceTimersByTime(119);
    });

    // A save acknowledgement can supply a fresh array with equivalent audio.
    // It must not move the already scheduled trailing edge.
    view.rerender(
      <AudioAnalysisProvider clips={[{ ...createAudioClip(), label: 'equal-fresh-array' }]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flushWithFakeTimers();

    expect(fakeWorker?.analyzePosts()).toBe(1);
  });

  it('starts immediately without debounce in Remotion rendering mode', async () => {
    vi.useFakeTimers();
    remotionState.environment = {
      ...remotionState.environment,
      isRendering: true,
    };
    MockOfflineAudioContext.decodedBuffer = createRenderedFixtureBuffer();

    render(
      <AudioAnalysisProvider clips={[createAudioClip()]} fps={FPS} totalDurationInFrames={AMPLITUDES.length}>
        <AnalysisSummary />
      </AudioAnalysisProvider>,
    );

    await flushWithFakeTimers();

    expect(fakeWorker?.analyzePosts()).toBe(1);
  });

  describe('createFrameSource', () => {
    function createTestPacked(frameCount: number, binsPerFrame: number): PackedAudioAnalysis {
      const frequencyBins = new Float32Array(frameCount * binsPerFrame);
      for (let frame = 0; frame < frameCount; frame += 1) {
        for (let bin = 0; bin < binsPerFrame; bin += 1) {
          frequencyBins[frame * binsPerFrame + bin] = (frame + 1) * 0.1 + bin * 0.01;
        }
      }
      return {
        frameCount,
        binsPerFrame,
        amplitude: new Float32Array([0.1, 0.2]),
        bass: new Float32Array([0.3, 0.4]),
        mid: new Float32Array([0.5, 0.6]),
        treble: new Float32Array([0.7, 0.8]),
        beats: new Uint8Array([0, 1]),
        frequencyBins,
      };
    }

    it('returns silent data outside the packed range', () => {
      const source = createFrameSource(createTestPacked(2, 2), 5);

      expect(source.length).toBe(5);
      expect(source.getFrame(2)).toBe(SILENT_AUDIO_DATA);
      expect(source.getFrame(-1)).toBe(SILENT_AUDIO_DATA);
    });

    it('caches the most recently requested frame', () => {
      const source = createFrameSource(createTestPacked(2, 2), 5);

      const first = source.getFrame(0);
      const second = source.getFrame(0);
      expect(second).toBe(first);

      const other = source.getFrame(1);
      expect(other).not.toBe(first);
    });

    it('materializes frequency bins only for the requested frame', () => {
      const source = createFrameSource(createTestPacked(2, 2), 5);

      const frame0 = source.getFrame(0);
      expect(frame0.frequencyBins[0]).toBeCloseTo(0.1, 5);
      expect(frame0.frequencyBins[1]).toBeCloseTo(0.11, 5);
      expect(frame0.amplitude).toBeCloseTo(0.1, 5);
      expect(frame0.isBeat).toBe(false);

      const frame1 = source.getFrame(1);
      expect(frame1.frequencyBins[0]).toBeCloseTo(0.2, 5);
      expect(frame1.frequencyBins[1]).toBeCloseTo(0.21, 5);
      expect(frame1.amplitude).toBeCloseTo(0.2, 5);
      expect(frame1.isBeat).toBe(true);
    });
  });
});
