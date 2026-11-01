import { useMemo } from 'react';
import { useGenerationController } from './useGenerationController';
import type { Shot } from '@/domains/generation/types';
import type { QueryClient } from '@tanstack/react-query';
import type { useShotEditorMediaAndOutputControllers } from './useShotEditorMediaAndOutputControllers';

type GenerationControllerInput = Parameters<typeof useGenerationController>[0];
type JoinSettings = GenerationControllerInput['join'];
type MotionSettings = GenerationControllerInput['motion'];
type RuntimeSettings = GenerationControllerInput['runtime'];
type PromptSettings = GenerationControllerInput['prompt'];

type JoinWorkflow = ReturnType<typeof useShotEditorMediaAndOutputControllers>['editing']['joinWorkflow'];
type MediaEditing = ReturnType<typeof useShotEditorMediaAndOutputControllers>['editing']['mediaEditing'];

interface PromptSettingsSlice {
  prompt: PromptSettings['prompt'];
  setPrompt: PromptSettings['onPromptChange'];
  enhancePrompt: PromptSettings['enhancePrompt'];
  textBeforePrompts: PromptSettings['textBeforePrompts'];
  textAfterPrompts: PromptSettings['textAfterPrompts'];
  negativePrompt: PromptSettings['negativePrompt'];
}

interface MotionSettingsSlice {
  amountOfMotion: MotionSettings['amountOfMotion'];
  motionMode: MotionSettings['motionMode'];
  turboMode: MotionSettings['turboMode'];
  smoothContinuations: MotionSettings['smoothContinuations'];
}

interface FrameSettingsSlice {
  batchVideoFrames: MotionSettings['batchVideoFrames'];
  batchVideoSteps: MotionSettings['batchVideoSteps'];
  setSteps: RuntimeSettings['setSteps'];
}

interface ModelSettingsSlice {
  selectedModel: MotionSettings['selectedModel'];
  guidanceScale: MotionSettings['guidanceScale'];
  ltxHdResolution: MotionSettings['ltxHdResolution'];
}

interface PhaseConfigSettingsSlice {
  phaseConfig: MotionSettings['phaseConfig'];
  selectedPhasePresetId: MotionSettings['selectedPhasePresetId'];
  generationTypeMode: MotionSettings['generationTypeMode'];
}

interface GenerationModeSettingsSlice {
  generationMode: GenerationControllerInput['core']['generationMode'];
}

interface SteerableMotionSettingsSlice {
  steerableMotionSettings: MotionSettings['steerableMotionSettings'];
  setSteerableMotionSettings: RuntimeSettings['setSteerableMotionSettings'];
}

interface RuntimeSettingsSlice {
  accelerated: RuntimeSettings['accelerated'];
  randomSeed: MotionSettings['randomSeed'];
  isShotUISettingsLoading: RuntimeSettings['isShotUISettingsLoading'];
  settingsLoadingFromContext: RuntimeSettings['settingsLoadingFromContext'];
  canonicalPersistence: RuntimeSettings['canonicalPersistence'];
  updateShotUISettings: RuntimeSettings['updateShotUISettings'];
  setShowStepsNotification: RuntimeSettings['setShowStepsNotification'];
}

interface UseGenerationControllerInputModelParams {
  core: {
    projectId: string;
    selectedProjectId: string;
    selectedShotId: string;
    selectedShot: Shot | null;
    queryClient: QueryClient;
    onShotImagesUpdate: () => void;
    effectiveAspectRatio?: string;
  };
  promptSettings: PromptSettingsSlice;
  motionSettings: MotionSettingsSlice;
  frameSettings: FrameSettingsSlice;
  modelSettings: ModelSettingsSlice;
  phaseConfigSettings: PhaseConfigSettingsSlice;
  generationModeSettings: GenerationModeSettingsSlice;
  steerableMotionSettings: SteerableMotionSettingsSlice;
  loraManager: {
    selectedLoras: MotionSettings['selectedLoras'];
  };
  mediaEditing: Pick<MediaEditing, 'travelGuidance' | 'structureGuidance' | 'structureVideos'>;
  selectedOutputId: MotionSettings['selectedOutputId'];
  joinWorkflow: JoinSettings | JoinWorkflow;
  runtime: RuntimeSettingsSlice;
}

export function useGenerationControllerInputModel({
  core,
  promptSettings,
  motionSettings,
  frameSettings,
  modelSettings,
  phaseConfigSettings,
  generationModeSettings,
  steerableMotionSettings,
  loraManager,
  mediaEditing,
  selectedOutputId,
  joinWorkflow,
  runtime,
}: UseGenerationControllerInputModelParams): GenerationControllerInput {
  return useMemo(() => ({
    core: {
      projectId: core.projectId,
      selectedProjectId: core.selectedProjectId,
      selectedShotId: core.selectedShotId,
      selectedShot: core.selectedShot,
      queryClient: core.queryClient,
      onShotImagesUpdate: core.onShotImagesUpdate,
      effectiveAspectRatio: core.effectiveAspectRatio,
      generationMode: generationModeSettings.generationMode,
    },
    prompt: {
      prompt: promptSettings.prompt,
      onPromptChange: promptSettings.setPrompt,
      enhancePrompt: promptSettings.enhancePrompt,
      textBeforePrompts: promptSettings.textBeforePrompts,
      textAfterPrompts: promptSettings.textAfterPrompts,
      negativePrompt: promptSettings.negativePrompt,
    },
    motion: {
      amountOfMotion: motionSettings.amountOfMotion,
      motionMode: motionSettings.motionMode,
      advancedMode: motionSettings.motionMode === 'advanced',
      phaseConfig: phaseConfigSettings.phaseConfig,
      selectedPhasePresetId: phaseConfigSettings.selectedPhasePresetId,
      selectedModel: modelSettings.selectedModel,
      guidanceScale: modelSettings.guidanceScale,
      ltxHdResolution: modelSettings.ltxHdResolution,
      steerableMotionSettings: steerableMotionSettings.steerableMotionSettings,
      randomSeed: runtime.randomSeed,
      turboMode: motionSettings.turboMode,
      generationTypeMode: phaseConfigSettings.generationTypeMode,
      smoothContinuations: motionSettings.smoothContinuations,
      batchVideoFrames: frameSettings.batchVideoFrames,
      batchVideoSteps: frameSettings.batchVideoSteps,
      selectedLoras: loraManager.selectedLoras,
      travelGuidance: mediaEditing.travelGuidance,
      structureGuidance: mediaEditing.structureGuidance,
      structureVideos: mediaEditing.structureVideos,
      selectedOutputId,
    },
    join: joinWorkflow,
    runtime: {
      accelerated: runtime.accelerated,
      isShotUISettingsLoading: runtime.isShotUISettingsLoading,
      settingsLoadingFromContext: runtime.settingsLoadingFromContext,
      canonicalPersistence: runtime.canonicalPersistence,
      updateShotUISettings: runtime.updateShotUISettings,
      setSteerableMotionSettings: steerableMotionSettings.setSteerableMotionSettings,
      setSteps: frameSettings.setSteps,
      setShowStepsNotification: runtime.setShowStepsNotification,
    },
  }), [
    core.projectId,
    core.selectedProjectId,
    core.selectedShotId,
    core.selectedShot,
    core.queryClient,
    core.onShotImagesUpdate,
    core.effectiveAspectRatio,
    generationModeSettings.generationMode,
    promptSettings.prompt,
    promptSettings.setPrompt,
    promptSettings.enhancePrompt,
    promptSettings.textBeforePrompts,
    promptSettings.textAfterPrompts,
    promptSettings.negativePrompt,
    motionSettings.amountOfMotion,
    motionSettings.motionMode,
    motionSettings.turboMode,
    motionSettings.smoothContinuations,
    modelSettings.selectedModel,
    modelSettings.guidanceScale,
    phaseConfigSettings.phaseConfig,
    phaseConfigSettings.selectedPhasePresetId,
    phaseConfigSettings.generationTypeMode,
    steerableMotionSettings.steerableMotionSettings,
    steerableMotionSettings.setSteerableMotionSettings,
    frameSettings.batchVideoFrames,
    frameSettings.batchVideoSteps,
    frameSettings.setSteps,
    loraManager.selectedLoras,
    mediaEditing.travelGuidance,
    mediaEditing.structureGuidance,
    mediaEditing.structureVideos,
    selectedOutputId,
    joinWorkflow,
    runtime.accelerated,
    runtime.randomSeed,
    runtime.isShotUISettingsLoading,
    runtime.settingsLoadingFromContext,
    runtime.canonicalPersistence,
    runtime.updateShotUISettings,
    runtime.setShowStepsNotification,
  ]);
}
