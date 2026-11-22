import { useEffect, useRef } from 'react';
import planetStill from './planet-still.png';

/**
 * Owns the planet renderer's canvas and keeps the engine outside the route's
 * initial module graph. A still presentation can keep the same stage without
 * requesting Three or the engine chunk.
 */
type EngineModule = typeof import('./planetEngine');
const loadPlanetEngine = () => import('./planetEngine');

export function PublicAstridPlanet({ live, fixedPose = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('planet-test-pose') === 'fixed', loadEngine = loadPlanetEngine }: { live: boolean; fixedPose?: boolean; loadEngine?: () => Promise<EngineModule> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eligible = live;

  useEffect(() => {
    if (!eligible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let active = true;
    let dispose: (() => void) | undefined;

    void loadEngine().then(({ initPlanetEngine }) => {
      // StrictMode and route visibility can clean up while the chunk is loading.
      if (!active) return;
      const engine = initPlanetEngine(canvas, { onReady: () => {} }, { fixedPose });
      if (engine) dispose = () => engine.dispose();
    }).catch((error: unknown) => {
      // Keep the page usable if WebGL or the lazy chunk is unavailable.
      if (active) console.error('Unable to start the Astrid planet.', error);
    });

    return () => {
      active = false;
      dispose?.();
      dispose = undefined;
    };
  }, [eligible, fixedPose, loadEngine]);

  return (
    <div className="astrid-vision-juggler astrid-vision-planet" aria-hidden="true" data-live={eligible || undefined}>
      {eligible ? <canvas ref={canvasRef} className="astrid-vision-planet-canvas" /> : <img className="astrid-vision-planet-canvas" src={planetStill} alt="" />}
    </div>
  );
}
