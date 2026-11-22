// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ init: vi.fn(), dispose: vi.fn() }));
import { PublicAstridPlanet } from './PublicAstridPlanet';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PublicAstridPlanet engine boundary', () => {
  it('does not initialize still mode and disposes each live instance', async () => {
    engine.init.mockReturnValue({ dispose: engine.dispose });
    const loadEngine = vi.fn(async () => ({ initPlanetEngine: engine.init }));
    const still = render(<PublicAstridPlanet live={false} loadEngine={loadEngine} />);
    expect(still.container.querySelector('canvas')).toBeNull();
    expect(loadEngine).not.toHaveBeenCalled();
    expect(engine.init).not.toHaveBeenCalled();
    still.unmount();

    const live = render(<StrictMode><PublicAstridPlanet live loadEngine={loadEngine} /></StrictMode>);
    await waitFor(() => expect(engine.init).toHaveBeenCalledTimes(1));
    expect(engine.init.mock.calls[0]?.[0]).toBe(live.container.querySelector('canvas'));
    expect(engine.init.mock.calls[0]?.[2]).toEqual({ fixedPose: false });
    live.unmount();
    expect(engine.dispose).toHaveBeenCalledTimes(1);

    const fixed = render(<PublicAstridPlanet live fixedPose loadEngine={loadEngine} />);
    await waitFor(() => expect(engine.init).toHaveBeenCalledTimes(2));
    expect(engine.init.mock.calls[1]?.[2]).toEqual({ fixedPose: true });
    fixed.unmount();
    expect(engine.dispose).toHaveBeenCalledTimes(2);
  });
});
