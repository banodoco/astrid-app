import { useEffect, useRef, useState } from 'react';
import { hasPendingPublicAstridPageTransition, waitForPublicAstridPageTransitions } from '../publicAstridNavigation';
import planetStill from './planet-still.png';

type EngineModule = typeof import('./planetEngine');
const loadPlanetEngine = () => import('./planetEngine');

/** Own a separate canvas and defer the live scene until the page can paint. */
export function PublicAstridPlanet({ live, contentReady = true, fixedPose = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('planet-test-pose') === 'fixed', loadEngine = loadPlanetEngine }: { live: boolean; contentReady?: boolean; fixedPose?: boolean; loadEngine?: () => Promise<EngineModule> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    setRendered(false);
    if (!live || !contentReady) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let active = true;
    let frame = 0;
    let resolveFrame: ((active: boolean) => void) | undefined;
    let dispose: (() => void) | undefined;
    let cancelWait!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancelWait = resolve; });
    const nextFrame = () => new Promise<boolean>((resolve) => {
      resolveFrame = resolve;
      frame = requestAnimationFrame(() => { resolveFrame = undefined; resolve(active); });
    });
    const waitForPaint = async () => {
      do {
        await Promise.race([waitForPublicAstridPageTransitions(), cancelled]);
        if (!active || !await nextFrame() || !await nextFrame()) return false;
      } while (hasPendingPublicAstridPageTransition());
      return active;
    };
    void (async () => {
      if (!await waitForPaint()) return;
      const { initPlanetEngine } = await loadEngine();
      // Import can finish after unmount or while a newer transition is active.
      if (!active || !await waitForPaint()) return;
      const engine = initPlanetEngine(canvas, { onReady: () => { if (active) setRendered(true); } }, { fixedPose });
      if (engine) dispose = () => engine.dispose();
    })().catch((error: unknown) => {
      if (active) console.error('Unable to start the Astrid planet.', error);
    });

    return () => {
      active = false;
      cancelWait();
      cancelAnimationFrame(frame);
      resolveFrame?.(false);
      dispose?.();
    };
  }, [live, contentReady, fixedPose, loadEngine]);

  return (
    <div className="astrid-vision-juggler astrid-vision-planet" aria-hidden="true" data-live={live || undefined}>
      {(!rendered || !live || !contentReady) && <img className="astrid-vision-planet-canvas" src={planetStill} alt="" />}
      {live && <canvas ref={canvasRef} className="astrid-vision-planet-canvas" />}
    </div>
  );
}
