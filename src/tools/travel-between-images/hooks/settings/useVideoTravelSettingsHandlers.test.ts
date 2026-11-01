import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVideoTravelSettingsHandlers } from './useVideoTravelSettingsHandlers';

describe('useVideoTravelSettingsHandlers native prompt intent', () => {
  it('captures the prompt before updating the local settings draft', () => {
    const updateField = vi.fn();
    const onSettingsIntent = vi.fn();
    const { result } = renderHook(() => useVideoTravelSettingsHandlers({
      shotSettingsRef: { current: { settings: {}, updateField } } as never,
      currentShotId: 'shot-1',
      selectedShot: null,
      updateShotMode: vi.fn(),
      onSettingsIntent,
    }));

    result.current.handleBatchVideoPromptChange('Prompt from the live editor');

    expect(onSettingsIntent).toHaveBeenCalledWith({ prompt: 'Prompt from the live editor' });
    expect(updateField).toHaveBeenCalledWith('prompt', 'Prompt from the live editor');
    expect(onSettingsIntent.mock.invocationCallOrder[0]).toBeLessThan(updateField.mock.invocationCallOrder[0]);
  });

  it('keeps a prompt draft when native capture refuses', () => {
    const updateField = vi.fn();
    const refusal = new Error('shot.set capture unavailable');
    const onSettingsIntent = vi.fn(() => { throw refusal; });
    const { result } = renderHook(() => useVideoTravelSettingsHandlers({
      shotSettingsRef: { current: { settings: {}, updateField } } as never,
      currentShotId: 'shot-1',
      selectedShot: null,
      updateShotMode: vi.fn(),
      onSettingsIntent,
    }));

    expect(() => result.current.handleBatchVideoPromptChange('Draft kept')).toThrow(refusal);
    expect(updateField).toHaveBeenCalledWith('prompt', 'Draft kept');
  });
});
