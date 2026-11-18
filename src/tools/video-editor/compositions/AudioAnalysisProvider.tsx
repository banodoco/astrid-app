import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { continueRender, delayRender, useRemotionEnvironment } from 'remotion';
import type { ResolvedTimelineClip } from '@/tools/video-editor/types/index.ts';
import { getSanitizedMediaSrc } from '@/tools/video-editor/lib/config-utils.ts';
import { mediaFetchCredentials } from '@/shared/lib/media/mediaCrossOrigin.ts';
import { AUDIO_HALF_FFT_SIZE, type PackedAudioAnalysis } from './audio-analysis/audioAnalysis.protocol.ts';
import {
  acquireAudioAnalysis,
  buildAudioMixRequest,
  hasCachedAudioAnalysis,
  hasInFlightAudioAnalysis,
  internAudioMixRequest,
  type AudioAnalysisSubscription,
} from './audio-analysis/audioAnalysisClient.ts';

export type AudioAnalysisData = {
  amplitude: number;
  bass: number;
  mid: number;
  treble: number;
  isBeat: boolean;
  frequencyBins: number[];
};

export const SILENT_AUDIO_DATA: AudioAnalysisData = {
  amplitude: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  isBeat: false,
  frequencyBins: Array.from({ length: AUDIO_HALF_FFT_SIZE }, () => 0),
};

export type AudioAnalysisFrameSource = {
  length: number;
  getFrame: (frame: number) => AudioAnalysisData;
};

export const AudioAnalysisContext = createContext<AudioAnalysisFrameSource | null>(null);

/**
 * Lazy frame source over a packed analysis. `frequencyBins` is materialized
 * only for the requested frame and the most recent frame/value is cached so
 * multiple consumers during one render reuse it. Frames outside the packed
 * audio range return `SILENT_AUDIO_DATA`.
 */
export function createFrameSource(
  packed: PackedAudioAnalysis | null,
  totalDurationInFrames: number,
): AudioAnalysisFrameSource {
  const length = Math.max(1, totalDurationInFrames);

  if (!packed || packed.frameCount <= 0) {
    return {
      length,
      getFrame: () => SILENT_AUDIO_DATA,
    };
  }

  const { frameCount, binsPerFrame, amplitude, bass, mid, treble, beats, frequencyBins } = packed;
  let cachedFrame = -1;
  let cachedValue: AudioAnalysisData | null = null;

  return {
    length,
    getFrame: (frame: number) => {
      if (frame < 0 || frame >= frameCount) {
        return SILENT_AUDIO_DATA;
      }
      if (frame === cachedFrame && cachedValue) {
        return cachedValue;
      }

      cachedFrame = frame;
      const binOffset = frame * binsPerFrame;
      cachedValue = {
        amplitude: amplitude[frame] ?? 0,
        bass: bass[frame] ?? 0,
        mid: mid[frame] ?? 0,
        treble: treble[frame] ?? 0,
        isBeat: (beats[frame] ?? 0) !== 0,
        frequencyBins: Array.from(frequencyBins.subarray(binOffset, binOffset + binsPerFrame)),
      };
      return cachedValue;
    },
  };
}

const INTERACTIVE_DEBOUNCE_MS = 120;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const createSyntheticFrame = (frame: number, fps: number): AudioAnalysisData => {
  const seconds = frame / fps;
  const beatInterval = Math.max(1, Math.round(fps * 0.6));
  const beatWindow = Math.max(1, Math.round(fps * 0.12));
  const beatOffset = frame % beatInterval;
  const beatPulse = beatOffset < beatWindow ? 1 - beatOffset / beatWindow : 0;
  const bass = clamp01(0.35 + 0.25 * Math.sin(seconds * Math.PI * 2 * 1.1) + beatPulse * 0.45);
  const mid = clamp01(0.4 + 0.25 * Math.sin(seconds * Math.PI * 2 * 2.3 + 0.8));
  const treble = clamp01(0.45 + 0.2 * Math.sin(seconds * Math.PI * 2 * 5.2 + 1.4));
  const amplitude = clamp01(0.2 + bass * 0.35 + mid * 0.25 + treble * 0.2);

  return {
    amplitude,
    bass,
    mid,
    treble,
    isBeat: beatPulse > 0.9,
    frequencyBins: Array.from({ length: AUDIO_HALF_FFT_SIZE }, (_, index) => {
      const ratio = index / AUDIO_HALF_FFT_SIZE;
      const bassBand = Math.max(0, 1 - Math.abs(ratio - 0.04) / 0.05) * bass;
      const midBand = Math.max(0, 1 - Math.abs(ratio - 0.18) / 0.08) * mid;
      const trebleBand = Math.max(0, 1 - Math.abs(ratio - 0.62) / 0.12) * treble;
      return clamp01(Math.max(bassBand + beatPulse * 0.4, midBand, trebleBand));
    }),
  };
};

type AudioAnalysisProviderProps = {
  children: ReactNode;
  clips: ResolvedTimelineClip[];
  fps: number;
  totalDurationInFrames: number;
  enabled?: boolean;
};

export function AudioAnalysisProvider({
  children,
  clips,
  fps,
  totalDurationInFrames,
  enabled = true,
}: AudioAnalysisProviderProps) {
  return enabled
    ? <ActiveAudioAnalysisProvider clips={clips} fps={fps} totalDurationInFrames={totalDurationInFrames}>{children}</ActiveAudioAnalysisProvider>
    : <><WarmAudioCache clips={clips} fps={fps} />{children}</>;
}

const warmedAudioUrls = new Set<string>();

/** Test hook: forget warmed URLs so each test starts from a cold cache. */
export function resetWarmedAudioUrls(): void {
  warmedAudioUrls.clear();
}

function WarmAudioCache({ clips, fps }: { clips: ResolvedTimelineClip[]; fps: number }) {
  const environment = useRemotionEnvironment();
  const urlKey = useMemo(() => JSON.stringify([...new Set(
    buildAudioMixRequest(clips, fps).sources
      .map(getSanitizedMediaSrc)
      .filter((src): src is string => src !== null),
  )].sort()), [clips, fps]);

  // Stopgap: Plan 18 CC-9 moves this into the one object reader.
  // Each URL is warmed once per session. Adding a source fetches only that source, and the
  // in-flight warms are never aborted because the set grew.
  useEffect(() => {
    if (environment.isRendering || environment.isClientSideRendering) return;
    const urls = (JSON.parse(urlKey) as string[]).filter((url) => !warmedAudioUrls.has(url));
    if (urls.length === 0) return;
    urls.forEach((url) => warmedAudioUrls.add(url));
    let next = 0;
    const warm = async () => {
      while (next < urls.length) {
        const url = urls[next++];
        try {
          const response = await fetch(url, { credentials: mediaFetchCredentials(url, 'include'), priority: 'low' });
          if (!response.ok) throw new Error(`Audio warm failed with ${response.status}`);
          const reader = response.body?.getReader();
          if (reader) {
            while (!(await reader.read()).done) { /* Discard each chunk. */ }
          }
        } catch {
          // Cache warming is best effort. A failed URL is forgotten so a later pass retries it.
          warmedAudioUrls.delete(url);
        }
      }
    };
    for (let index = 0; index < Math.min(3, urls.length); index += 1) void warm();
  }, [urlKey, environment.isRendering, environment.isClientSideRendering]);

  return null;
}

function ActiveAudioAnalysisProvider({
  children,
  clips,
  fps,
  totalDurationInFrames,
}: Omit<AudioAnalysisProviderProps, 'enabled'>) {
  const handle = useState(() => delayRender('Audio analysis'))[0];
  const renderReleasedRef = useRef(false);
  const releaseRender = useCallback(() => {
    if (!renderReleasedRef.current) {
      renderReleasedRef.current = true;
      continueRender(handle);
    }
  }, [handle]);

  const candidateRequest = useMemo(() => buildAudioMixRequest(clips, fps), [clips, fps]);
  const stableRequest = useMemo(() => internAudioMixRequest(candidateRequest), [candidateRequest]);
  const [packed, setPacked] = useState<PackedAudioAnalysis | null>(null);
  const frameSource = useMemo(
    () => createFrameSource(packed, totalDurationInFrames),
    [packed, totalDurationInFrames],
  );

  const environment = useRemotionEnvironment();
  const startImmediately = environment.isRendering || environment.isClientSideRendering;

  // Unmount-only safety release. The analysis effect below must NOT call
  // `continueRender` on every dependency change — that could release Remotion
  // while a replacement analysis is still running.
  useEffect(() => {
    return () => {
      releaseRender();
    };
  }, [releaseRender]);

  useEffect(() => {
    if (stableRequest.spec.clips.length === 0) {
      setPacked(null);
      releaseRender();
      return;
    }

    let disposed = false;
    let subscription: AudioAnalysisSubscription | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const start = () => {
      if (disposed) {
        return;
      }
      // `internAudioMixRequest` preserves identity only while both the
      // semantic key and fetch sources match. A refreshed signed URL replaces
      // the interned request, so this stable dependency always carries the
      // current sources without retriggering for equivalent clip arrays.
      subscription = acquireAudioAnalysis(stableRequest);
      subscription.promise
        .then((result) => {
          // Preserve the previous result while a legitimately changed mix
          // recomputes; commit only when this effect is still current.
          if (!disposed) {
            setPacked(result);
          }
        })
        .catch((error: unknown) => {
          console.warn('Audio analysis failed, falling back to silent data.', error);
          if (!disposed) {
            setPacked(null);
          }
        })
        .finally(() => {
          if (!disposed) {
            releaseRender();
          }
        });
    };

    // Cache hits and in-flight shares start immediately; Remotion rendering
    // always starts immediately. Only uncached interactive-preview misses get
    // a short trailing debounce to coalesce load/save bursts.
    if (startImmediately || hasCachedAudioAnalysis(stableRequest) || hasInFlightAudioAnalysis(stableRequest)) {
      start();
    } else {
      timer = setTimeout(start, INTERACTIVE_DEBOUNCE_MS);
    }

    return () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      subscription?.release();
    };
  }, [stableRequest, releaseRender, startImmediately]);

  return (
    <AudioAnalysisContext.Provider value={frameSource}>
      {children}
    </AudioAnalysisContext.Provider>
  );
}

export function SyntheticAudioProvider({
  children,
  fps,
  durationInFrames,
}: {
  children: ReactNode;
  fps: number;
  durationInFrames: number;
}) {
  const frameSource = useMemo(() => {
    const length = Math.max(1, durationInFrames);
    const frames = Array.from({ length }, (_, frame) => createSyntheticFrame(frame, fps));
    return {
      length,
      getFrame: (frame: number) => frames[frame] ?? SILENT_AUDIO_DATA,
    } satisfies AudioAnalysisFrameSource;
  }, [durationInFrames, fps]);

  return (
    <AudioAnalysisContext.Provider value={frameSource}>
      {children}
    </AudioAnalysisContext.Provider>
  );
}

export const useAudioAnalysisContext = (): AudioAnalysisFrameSource | null => useContext(AudioAnalysisContext);
