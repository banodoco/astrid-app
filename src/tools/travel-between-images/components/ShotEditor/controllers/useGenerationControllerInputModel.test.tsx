// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./useGenerationController', () => ({
  useGenerationController: vi.fn(),
}));

import { useGenerationControllerInputModel } from './useGenerationControllerInputModel';

describe('useGenerationControllerInputModel', () => {
  function buildProps() {
    return {
      core: {
        projectId: 'project-1',
        selectedProjectId: 'project-1',
        selectedShotId: 'shot-1',
        selectedShot: { id: 'shot-1' } as never,
        queryClient: { invalidateQueries: vi.fn() } as never,
        onShotImagesUpdate: vi.fn(),
        effectiveAspectRatio: '16:9',
      },
      promptSettings: {
        prompt: 'Prompt',
        setPrompt: vi.fn(),
        enhancePrompt: true,
        textBeforePrompts: 'Before',
        textAfterPrompts: 'After',
        negativePrompt: 'Negative',
      },
      motionSettings: {
        amountOfMotion: 42,
        motionMode: 'advanced' as const,
        turboMode: false,
        smoothContinuations: true,
      },
      frameSettings: {
        batchVideoFrames: 61,
        batchVideoSteps: 8,
        setSteps: vi.fn(),
      },
      modelSettings: {
        selectedModel: 'ltx-2.3' as const,
        guidanceScale: 3,
      },
      phaseConfigSettings: {
        phaseConfig: { num_phases: 2 } as never,
        selectedPhasePresetId: 'preset-1',
        generationTypeMode: 'vace' as const,
      },
      generationModeSettings: {
        generationMode: 'timeline' as const,
      },
      steerableMotionSettings: {
        steerableMotionSettings: { model_name: 'wan', num_inference_steps: 8, seed: 321 },
        setSteerableMotionSettings: vi.fn(),
      },
      loraManager: {
        selectedLoras: [{ id: 'lora-1', path: '/lora-1', strength: 0.8 }],
      },
      mediaEditing: {
        structureGuidance: { mode: 'flow' } as never,
        structureVideos: [{ id: 'structure-1' }] as never,
      },
      selectedOutputId: 'parent-1',
      joinWorkflow: { stitchAfterGenerate: true, joinPrompt: 'Join prompt' } as never,
      runtime: {
        accelerated: true,
        randomSeed: false,
        isShotUISettingsLoading: false,
        settingsLoadingFromContext: true,
        canonicalPersistence: false,
        updateShotUISettings: vi.fn(),
        setShowStepsNotification: vi.fn(),
      },
    };
  }

  it('maps the grouped shot editor slices into the generation controller input shape', () => {
    const props = buildProps();

    const { result, rerender } = renderHook(
      (currentProps) => useGenerationControllerInputModel(currentProps),
      { initialProps: props },
    );

    expect(result.current.core).toMatchObject({
      projectId: 'project-1',
      selectedShotId: 'shot-1',
      generationMode: 'timeline',
    });
    expect(result.current.prompt).toMatchObject({
      prompt: 'Prompt',
      textBeforePrompts: 'Before',
      textAfterPrompts: 'After',
    });
    expect(result.current.motion).toMatchObject({
      amountOfMotion: 42,
      motionMode: 'advanced',
      advancedMode: true,
      selectedModel: 'ltx-2.3',
      guidanceScale: 3,
      batchVideoSteps: 8,
      generationTypeMode: 'vace',
      randomSeed: false,
      smoothContinuations: true,
      selectedOutputId: 'parent-1',
    });
    expect(result.current.join).toBe(props.joinWorkflow);
    expect(result.current.runtime).toMatchObject({
      accelerated: true,
      settingsLoadingFromContext: true,
      setSteps: props.frameSettings.setSteps,
      setSteerableMotionSettings: props.steerableMotionSettings.setSteerableMotionSettings,
    });

    const firstValue = result.current;
    rerender(props);
    expect(result.current).toBe(firstValue);

    rerender({
      ...props,
      motionSettings: {
        ...props.motionSettings,
        motionMode: 'basic',
      },
    });

    expect(result.current).not.toBe(firstValue);
    expect(result.current.motion.advancedMode).toBe(false);
  });
});
