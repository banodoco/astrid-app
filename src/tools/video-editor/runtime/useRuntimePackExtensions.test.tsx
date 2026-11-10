// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRuntimePackExtensions } from './useRuntimePackExtensions';
import * as packs from './useRuntimePackExtensions';

const repo = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
  putBundleContent: vi.fn(async () => {}),
  getPackRecord: vi.fn(async () => undefined),
  putPackRecord: vi.fn(async () => {}),
  updatePackRecord: vi.fn(async () => {}),
  getAllPackRecords: vi.fn(async () => []),
  deletePackRecord: vi.fn(async () => {}),
}));
vi.mock('./extensionStateRepositoryIndexedDB', () => ({ createIndexedDBExtensionStateRepository: () => repo }));
vi.mock('./useExtensionLoaderWiring', () => ({ useExtensionLoaderWiring: () => ({}) }));
vi.mock('@/integrations/runtime/connection', () => ({ runtimeApiBase: () => 'http://127.0.0.1:17340/api/runtime' }));

// The interval is short so several polls would show within the settle window.
const INTERVAL_MS = 20;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 120));
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // A Runtime that predates packs answers the inventory route with 404.
  fetchMock = vi.fn(async () => new Response('Not Found', { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useRuntimePackExtensions against a Runtime without packs (404 from the inventory route)', () => {
  it('stops polling after a 404 and does not report a transport error', async () => {
    const { result } = renderHook(() => useRuntimePackExtensions([], INTERVAL_MS, 'runtime-a'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(settle);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeFalsy();
  });

  it('does not poll again on focus after a 404', async () => {
    renderHook(() => useRuntimePackExtensions([], INTERVAL_MS, 'runtime-a'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await pause();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls once more when the Runtime identity changes, and stops again on another 404', async () => {
    const { rerender } = renderHook(({ runtimeKey }) => useRuntimePackExtensions([], INTERVAL_MS, runtimeKey), {
      initialProps: { runtimeKey: 'runtime-a' },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(settle);
    rerender({ runtimeKey: 'runtime-b' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(settle);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('runtimePackKey', () => {
  const schemaDigest = `sha256:${'a'.repeat(64)}`;
  const release11 = { isConnected: true, realmName: 'Astrid', schemaDigest, runtimeRelease: 11 };

  it('changes when the Runtime release changes, even though releases 11 and 12 share a schema digest', () => {
    expect(packs.runtimePackKey(release11)).not.toBe(packs.runtimePackKey({ ...release11, runtimeRelease: 12 }));
  });

  it('is the same for the same connection, so an unchanged Runtime does not re-poll', () => {
    expect(packs.runtimePackKey({ ...release11 })).toBe(packs.runtimePackKey(release11));
  });

  it('changes when the connection drops', () => {
    expect(packs.runtimePackKey({ ...release11, isConnected: false })).not.toBe(packs.runtimePackKey(release11));
  });
});
