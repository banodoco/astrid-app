import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsModal } from './useSettingsModal';
import { dispatchAppEvent } from '@/shared/lib/typedEvents';

describe('useSettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens settings modal with explicit tab arguments', () => {
    const { result } = renderHook(() => useSettingsModal());

    act(() => {
      result.current.handleOpenSettings('extensions');
    });

    expect(result.current.isSettingsModalOpen).toBe(true);
    expect(result.current.settingsInitialTab).toBe('extensions');
  });

  it('responds to openSettings custom event', () => {
    const { result } = renderHook(() => useSettingsModal());

    act(() => {
      dispatchAppEvent('openSettings', { tab: 'extensions' });
    });

    expect(result.current.isSettingsModalOpen).toBe(true);
    expect(result.current.settingsInitialTab).toBe('extensions');
  });

  it('opens Settings Updates from the stable query deep link', () => {
    window.history.replaceState({ key: 'router-state' }, '', '/tools/video-editor?project=film&settings=updates&timeline=cut#preview');
    const { result } = renderHook(() => useSettingsModal());
    expect(result.current.isSettingsModalOpen).toBe(true);
    expect(result.current.settingsInitialTab).toBe('updates');
    act(() => result.current.setIsSettingsModalOpen(false));
    expect(result.current.isSettingsModalOpen).toBe(false);
    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe('/tools/video-editor?project=film&timeline=cut#preview');
    expect(window.history.state).toEqual({ key: 'router-state' });
    window.history.replaceState({}, '', '/tools/video-editor');
  });

  it('leaves unrelated settings query values alone on close', () => {
    window.history.replaceState({}, '', '/tools/video-editor?settings=other');
    const { result } = renderHook(() => useSettingsModal());
    act(() => result.current.handleOpenSettings());
    act(() => result.current.setIsSettingsModalOpen(false));
    expect(window.location.search).toBe('?settings=other');
    window.history.replaceState({}, '', '/tools/video-editor');
  });

  it('clears an updates link opened while the app is already mounted', () => {
    window.history.replaceState({}, '', '/tools/video-editor?project=film');
    const { result } = renderHook(() => useSettingsModal());
    act(() => {
      window.history.replaceState(window.history.state, '', '/tools/video-editor?project=film&settings=updates');
      dispatchAppEvent('openSettings', { tab: 'updates' });
    });
    expect(result.current.isSettingsModalOpen).toBe(true);
    act(() => result.current.setIsSettingsModalOpen(false));
    expect(window.location.search).toBe('?project=film');
    window.history.replaceState({}, '', '/tools/video-editor');
  });
});
