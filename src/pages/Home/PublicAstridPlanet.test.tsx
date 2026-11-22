// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const engineModule = vi.hoisted(() => ({
  loads: vi.fn(),
  init: vi.fn(),
  dispose: vi.fn(),
  resolve: undefined as undefined | ((module: unknown) => void),
}));

vi.mock('./planet/planetEngine', () => {
  engineModule.loads();
  return new Promise((resolve) => {
    engineModule.resolve = resolve;
  });
});

import { PublicAstridPlanet } from './PublicAstridPlanet';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  engineModule.resolve = undefined;
});

describe('PublicAstridPlanet engine boundary', () => {
  it('keeps still mode unloaded, ignores late imports after unmount, and disposes StrictMode mounts', async () => {
    const still = render(<PublicAstridPlanet live={false} />);
    expect(still.container.querySelector('canvas')).toBeNull();
    expect(engineModule.loads).not.toHaveBeenCalled();
    still.unmount();

    const late = render(<PublicAstridPlanet live />);
    await waitFor(() => expect(engineModule.loads).toHaveBeenCalledTimes(1));
    late.unmount();
    await act(async () => {
      engineModule.resolve?.({ initPlanetEngine: engineModule.init });
    });
    expect(engineModule.init).not.toHaveBeenCalled();

    engineModule.init.mockReturnValue({ dispose: engineModule.dispose });
    const live = render(<StrictMode><PublicAstridPlanet live /></StrictMode>);
    await waitFor(() => expect(engineModule.init).toHaveBeenCalledTimes(1));
    expect(engineModule.init.mock.calls[0]?.[0]).toBe(live.container.querySelector('canvas'));
    expect(engineModule.init.mock.calls[0]?.[2]).toEqual({ fixedPose: false });
    live.unmount();
    expect(engineModule.dispose).toHaveBeenCalledTimes(1);

    const fixed = render(<PublicAstridPlanet live fixedPose />);
    await waitFor(() => expect(engineModule.init).toHaveBeenCalledTimes(2));
    expect(engineModule.init.mock.calls[1]?.[2]).toEqual({ fixedPose: true });
    fixed.unmount();
    expect(engineModule.dispose).toHaveBeenCalledTimes(2);
  });
});
