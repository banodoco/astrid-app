import { useEffect, useRef, useState } from 'react';
import { useEditorTour } from '@/shared/state/editorTourStore.ts';
import { EDITOR_TOUR_MEDIA, tourSaveData } from '../tourMedia.ts';

/** Resolves in the next idle moment (or soon after, where there is no idle callback). */
function idle(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 1500 });
    else setTimeout(resolve, 16);
  });
}

/** Yield a paint before warming. Keep decoded images and a buffering video alive for this run. */
export function useTourMediaWarmup(): boolean {
  const act = useEditorTour(state => state.act);
  const [started, setStarted] = useState(false);
  const images = useRef(new Map<string, HTMLImageElement>());
  const video = useRef<HTMLVideoElement>();
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setStarted(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      images.current.forEach(image => image.removeAttribute('src'));
      images.current.clear();
      if (video.current) {
        video.current.pause();
        video.current.removeAttribute('src');
        video.current.load();
        video.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    const saveData = tourSaveData();
    // The next land needs the guide frame, then its clip (act 1) or the four stills and the H3 clip (acts 2-3). Each step
    // waits for an idle moment, so decoding and buffering never land on a card move or a chat frame.
    const slots = saveData
      ? act === 1 ? [EDITOR_TOUR_MEDIA.frames[0]] : act === 2 ? EDITOR_TOUR_MEDIA.stills : [EDITOR_TOUR_MEDIA.stills[0]]
      : act === 1 ? [EDITOR_TOUR_MEDIA.frames[0], ...EDITOR_TOUR_MEDIA.stills, EDITOR_TOUR_MEDIA.frames[1]]
        : [...EDITOR_TOUR_MEDIA.stills, ...EDITOR_TOUR_MEDIA.frames];
    const clipUrl = act === 1 ? EDITOR_TOUR_MEDIA.guide.url : EDITOR_TOUR_MEDIA.video.url;
    const bufferVideo = () => {
      if (saveData && act === 1) return;
      const preload = saveData && act < 3 ? 'metadata' : 'auto';
      if (video.current?.preload === preload && video.current.getAttribute('src') === clipUrl) return;
      const element = video.current ?? document.createElement('video');
      element.muted = true;
      element.playsInline = true;
      element.crossOrigin = 'anonymous';
      element.preload = preload;
      if (element.getAttribute('src') !== clipUrl) element.src = clipUrl;
      video.current = element;
      element.load();
    };
    void (async () => {
      for (const { url } of slots) {
        if (cancelled) return;
        if (!images.current.has(url)) {
          const image = new Image();
          images.current.set(url, image);
          image.crossOrigin = 'anonymous';
          image.src = url;
          // A failed image must not prevent later media warming.
          await image.decode?.().catch(() => undefined);
        }
        if (!cancelled) bufferVideo();
        await idle();
      }
    })();
    return () => { cancelled = true; };
  }, [act, started]);
  return started;
}
