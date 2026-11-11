/**
 * The tour's own moving picture: one plain muted inline `<video>` for the whole run, layered over the editor's preview by
 * `EditorTourTimelineDriver`. Nothing here depends on the editor's player, WebCodecs, an AudioContext or a decoder
 * library: the browser's media element is the only thing that has to work, and when it does not (autoplay refused, no
 * data in time) the caller keeps its poster and moves on.
 *
 * Starting it is as permissive as the platforms allow:
 * - `muted` + `playsinline` and no audio track in the file, so `play()` needs no user gesture where muted autoplay is allowed;
 * - no `autoplay` attribute: it would start the clip when data arrives instead of on its beat, and WebKit pauses
 *   attribute-autoplayed videos whenever they are not visible;
 * - `prime()` is called inside every tap and key press of the tour, so the element's first `play()` is gesture-initiated
 *   (which is what a browser that refuses muted autoplay, such as iOS in Low Power Mode, asks for), and a start that was
 *   refused is retried on the next press.
 */

export type TourVideoStart = 'playing' | 'rejected' | 'timeout';

export interface TourVideoEngine {
  readonly element: HTMLVideoElement;
  /** Points the element at `url` (a no-op when it already is) and lets the browser buffer it. */
  load(url: string, preload?: 'auto' | 'metadata'): void;
  /** Call inside a user gesture. Never restarts or interrupts a picture that is showing. */
  prime(): void;
  /**
   * Plays from the start. Resolves when a frame of the playing video has been presented, when `play()` is refused, or
   * after `deadlineMs`; a late first frame still flips `presenting`.
   */
  start(deadlineMs: number): Promise<TourVideoStart>;
  /** Pauses where it is and stops asking to play. */
  hold(): void;
  /** Whether the current source has presented a frame while playing since it was last started or loaded. */
  presenting(): boolean;
  subscribe(listener: () => void): () => void;
  /** Called with the media time while it plays (at most every `TIME_REPORT_MS`) and once when it ends. */
  onTime: ((seconds: number) => void) | null;
  dispose(): void;
}

const TIME_REPORT_MS = 100;

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function createTourVideoEngine(): TourVideoEngine {
  const video = document.createElement('video') as FrameCallbackVideo;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  // Attributes too: WebKit reads its inline and muted autoplay policy from them.
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('disableremoteplayback', '');
  video.setAttribute('aria-hidden', 'true');
  video.disablePictureInPicture = true;
  video.controls = false;
  video.tabIndex = -1;
  video.preload = 'auto';
  video.dataset.editorTourVideo = '';
  video.className = 'absolute inset-0 h-full w-full object-contain';

  const listeners = new Set<() => void>();
  let presenting = false;
  let wanted = false;
  let primedSrc: string | null = null;
  let disposed = false;
  let frameHandle: number | null = null;
  let lastReport = 0;
  let pendingStart: ((result: TourVideoStart) => void) | null = null;

  const setPresenting = (next: boolean) => {
    if (presenting === next) return;
    presenting = next;
    listeners.forEach((listener) => listener());
  };
  const settleStart = (result: TourVideoStart) => {
    const settle = pendingStart;
    pendingStart = null;
    settle?.(result);
  };
  const sawFrame = (seconds: number) => {
    if (disposed || !wanted || video.paused || video.seeking) return;
    setPresenting(true);
    settleStart('playing');
    const now = performance.now();
    if (now - lastReport >= TIME_REPORT_MS) {
      lastReport = now;
      engine.onTime?.(seconds);
    }
  };
  // A presented frame is the proof. Where the browser cannot report one, advancing media time is.
  const watchFrames = () => {
    if (frameHandle !== null || !video.requestVideoFrameCallback) return;
    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      frameHandle = null;
      if (disposed || !wanted) return;
      sawFrame(metadata.mediaTime);
      frameHandle = video.requestVideoFrameCallback!(onFrame);
    };
    frameHandle = video.requestVideoFrameCallback(onFrame);
  };
  const onTimeUpdate = () => { if (video.currentTime > 0) sawFrame(video.currentTime); };
  const onEnded = () => { if (wanted) engine.onTime?.(video.duration || video.currentTime); };
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('ended', onEnded);

  const play = (): Promise<void> => {
    try {
      return video.play() ?? Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const engine: TourVideoEngine = {
    element: video,
    onTime: null,
    load(url, preload = 'auto') {
      if (disposed || video.getAttribute('src') === url) return;
      wanted = false;
      primedSrc = null;
      settleStart('timeout');
      setPresenting(false);
      video.preload = preload;
      video.src = url;
      video.load();
    },
    prime() {
      if (disposed || !video.getAttribute('src')) return;
      if (wanted) {
        // A start the browser refused (or that has not begun): this press may be what it was waiting for.
        if (video.paused && !video.ended) void play().catch(() => undefined);
        return;
      }
      if (!video.paused || primedSrc === video.getAttribute('src')) return;
      primedSrc = video.getAttribute('src');
      void play().then(() => {
        if (wanted || disposed) return;
        video.pause();
        if (video.currentTime > 0) video.currentTime = 0;
      }, () => undefined);
    },
    start(deadlineMs) {
      if (disposed) return Promise.resolve('rejected');
      settleStart('timeout');
      wanted = true;
      primedSrc = video.getAttribute('src');
      setPresenting(false);
      lastReport = 0;
      try {
        if (video.ended || video.currentTime > 0.05) video.currentTime = 0;
      } catch { /* not seekable yet: it starts at 0 anyway */ }
      return new Promise<TourVideoStart>((resolve) => {
        const timer = setTimeout(() => settleStart('timeout'), deadlineMs);
        pendingStart = (result) => { clearTimeout(timer); resolve(result); };
        watchFrames();
        void play().catch(() => settleStart('rejected'));
      });
    },
    hold() {
      wanted = false;
      settleStart('timeout');
      if (!video.paused) video.pause();
    },
    presenting: () => presenting,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      wanted = false;
      settleStart('timeout');
      if (frameHandle !== null) video.cancelVideoFrameCallback?.(frameHandle);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
      listeners.clear();
      engine.onTime = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    },
  };
  return engine;
}
