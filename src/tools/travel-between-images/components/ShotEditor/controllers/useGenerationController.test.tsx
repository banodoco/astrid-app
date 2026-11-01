// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenerationController } from './useGenerationController';

const mocks = vi.hoisted(() => ({
  useSteerableMotionHandlers: vi.fn(),
  useGenerateBatch: vi.fn(),
}));

vi.mock('../hooks/actions/useSteerableMotionHandlers', () => ({
  useSteerableMotionHandlers: mocks.useSteerableMotionHandlers,
}));

vi.mock('../hooks/actions/useGenerateBatch', () => ({
  useGenerateBatch: mocks.useGenerateBatch,
}));

describe('useGenerationController', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.useSteerableMotionHandlers.mockReturnValue({
      handleRandomSeedChange: vi.fn(),
      handleAcceleratedChange: vi.fn(),
      handleStepsChange: vi.fn(),
    });

    mocks.useGenerateBatch.mockReturnValue({
      handleGenerateBatch: vi.fn(),
      isSteerableMotionEnqueuing: true,
      steerableMotionJustQueued: false,
      isGenerationDisabled: true,
    });
  });

  function buildArgs() {
    return {
      core: {
        projectId: 'project-1',
        selectedProjectId: 'project-1',
        selectedShotId: 'shot-1',
        selectedShot: { id: 'shot-1', name: 'Shot 1' } as never,
        queryClient: { invalidateQueries: vi.fn() } as never,
        onShotImagesUpdate: vi.fn(),
        effectiveAspectRatio: '16:9',
        generationMode: 'join' as const,
      },
      prompt: {
        prompt: 'Base prompt',
        onPromptChange: vi.fn(),
        enhancePrompt: true,
        textBeforePrompts: 'Before',
        textAfterPrompts: 'After',
        negativePrompt: 'Negative',
      },
      motion: {
        amountOfMotion: 55,
        motionMode: 'advanced' as const,
        advancedMode: true,
        phaseConfig: { num_phases: 3 } as never,
        selectedPhasePresetId: 'preset-1',
        steerableMotionSettings: { model_name: 'wan', num_inference_steps: 8, seed: 123 },
        randomSeed: false,
        turboMode: true,
        generationTypeMode: 'vace' as const,
        smoothContinuations: true,
        batchVideoFrames: 77,
        selectedLoras: [{ id: 'lora-1', path: '/lora-1', strength: 0.5 }],
        structureGuidance: { mode: 'flow' } as never,
        structureVideos: [{ id: 'structure-1' }] as never,
        selectedOutputId: 'parent-1',
      },
      join: {
        stitchAfterGenerate: true,
        joinContextFrames: 12,
        joinGapFrames: 4,
        joinReplaceMode: true,
        joinKeepBridgingImages: false,
        joinPrompt: 'Join prompt',
        joinNegativePrompt: 'Join negative',
        joinEnhancePrompt: false,
        joinModel: 'wan-join',
        joinNumInferenceSteps: 6,
        joinGuidanceScale: 4,
        joinSeed: 789,
        joinRandomSeed: true,
        joinMotionMode: 'basic' as const,
        joinPhaseConfig: { num_phases: 2 } as never,
        joinSelectedPhasePresetId: 'join-preset',
        joinSelectedLoras: [
          { id: 'join-lora-1', path: '/join-lora-1', strength: 0.9, name: 'Join LoRA' },
        ],
        joinPriority: 2,
        joinUseInputVideoResolution: true,
        joinUseInputVideoFps: true,
        joinNoisedInputVideo: 0.35,
        joinLoopFirstClip: true,
        joinSettings: {
          updateField: vi.fn(),
        },
      },
      runtime: {
        accelerated: false,
        isShotUISettingsLoading: false,
        settingsLoadingFromContext: false,
        canonicalPersistence: false,
        updateShotUISettings: vi.fn(),
        setSteerableMotionSettings: vi.fn(),
        setSteps: vi.fn(),
        setShowStepsNotification: vi.fn(),
      },
    };
  }

  it('builds the batch generation request and exposes the downstream handlers', () => {
    const args = buildArgs();

    const { result } = renderHook(() => useGenerationController(args));

    expect(mocks.useSteerableMotionHandlers).toHaveBeenCalledWith(
      expect.objectContaining({
        accelerated: false,
        randomSeed: false,
        turboMode: true,
        selectedShotId: 'shot-1',
      }),
    );
    expect(mocks.useGenerateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        core: expect.objectContaining({
          projectId: 'project-1',
          selectedShotId: 'shot-1',
          generationMode: 'join',
        }),
        request: expect.objectContaining({
          prompt: expect.objectContaining({
            basePrompt: 'Base prompt',
            negativePrompt: 'Negative',
          }),
          motion: expect.objectContaining({
            amountOfMotion: 55,
            motionMode: 'advanced',
            selectedPhasePresetId: 'preset-1',
          }),
          model: expect.objectContaining({
            generationTypeMode: 'vace',
            smoothContinuations: true,
            turboMode: true,
          }),
          batchVideoFrames: 77,
          selectedLoras: [{ id: 'lora-1', path: '/lora-1', strength: 0.5 }],
          selectedOutputId: 'parent-1',
          stitchAfterGenerate: expect.objectContaining({
            contextFrameCount: 12,
            gapFrames: 4,
            selectedLoras: [{ path: '/join-lora-1', strength: 0.9 }],
            loopFirstClip: true,
          }),
        }),
      }),
    );

    result.current.handleBatchVideoPromptChange('Updated prompt');

    expect(args.prompt.onPromptChange).toHaveBeenCalledWith('Updated prompt');
    expect(result.current.handleGenerateBatch).toBe(
      mocks.useGenerateBatch.mock.results[0].value.handleGenerateBatch,
    );
    expect(result.current.handleRandomSeedChange).toBe(
      mocks.useSteerableMotionHandlers.mock.results[0].value.handleRandomSeedChange,
    );
  });

  it('auto-enables stitch-after-generate when smooth continuations is toggled on', () => {
    const args = buildArgs();
    args.motion.smoothContinuations = false;

    const { rerender } = renderHook(
      (currentArgs) => useGenerationController(currentArgs),
      { initialProps: args },
    );

    expect(args.join.joinSettings.updateField).not.toHaveBeenCalled();

    rerender({
      ...args,
      motion: {
        ...args.motion,
        smoothContinuations: true,
      },
    });

    expect(args.join.joinSettings.updateField).toHaveBeenCalledWith('stitchAfterGenerate', true);

    rerender({
      ...args,
      motion: {
        ...args.motion,
        smoothContinuations: true,
      },
    });

    expect(args.join.joinSettings.updateField).toHaveBeenCalledTimes(1);
  });
});
