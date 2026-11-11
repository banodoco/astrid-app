import { useEffect, useRef, useState } from 'react';
import { useEditorTour } from '@/shared/state/editorTourStore.ts';
import { EDITOR_TOUR_MEDIA } from '../tourMedia.ts';

/** Resolves in the next idle moment (or soon after, where there is no idle callback). */
export function tourIdle(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 1500 });
    else setTimeout(resolve, 16);
  });
}

const display = (slot: { displayUrl?: string; url: string }) => slot.displayUrl ?? slot.url;

/**
 * The pictures the tour's preview layer shows next, in the order it needs them: the guide's first frame (step 1's poster)
 * from the start; the four stills once step 1 has landed; the H3 clip's first frame (step 3's poster) from step 2.
 * These are the small display derivatives (about 0.6 MB in all), never the originals.
 */
export function tourWarmupPictures(act: number, landed: boolean): string[] {
  const poster = display(EDITOR_TOUR_MEDIA.guide);
  if (act === 1 && !landed) return [poster];
  const stills = EDITOR_TOUR_MEDIA.stills.map(display);
  return act === 1 ? [poster, ...stills] : [poster, ...stills, display(EDITOR_TOUR_MEDIA.video)];
}

/**
 * Yields a paint, then fetches and decodes the next pictures one per idle moment, so no decode lands on a card move or a
 * chat frame, and keeps them alive for this run. Returns whether warming has begun (the caller starts buffering its
 * video then, not before first paint). Video buffering is the picture engine's job (`tourPicture.ts`).
 */
export function useTourMediaWarmup(): boolean {
  const act = useEditorTour(state => state.act);
  const landed = useEditorTour(state => state.beat === 'land' || state.beat === 'gallery');
  const [started, setStarted] = useState(false);
  const images = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    const warmed = images.current;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setStarted(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      warmed.forEach(image => image.removeAttribute('src'));
      warmed.clear();
    };
  }, []);

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    void (async () => {
      for (const url of tourWarmupPictures(act, landed)) {
        if (cancelled) return;
        if (images.current.has(url)) continue;
        const image = new Image();
        images.current.set(url, image);
        image.decoding = 'async';
        image.src = url;
        // A failed image must not prevent later media warming.
        await image.decode?.().catch(() => undefined);
        await tourIdle();
      }
    })();
    return () => { cancelled = true; };
  }, [act, landed, started]);
  return started;
}
