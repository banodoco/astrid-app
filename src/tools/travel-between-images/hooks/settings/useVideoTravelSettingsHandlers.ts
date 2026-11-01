/**
 * Settings Handlers Hook for VideoTravelToolPage
 * 
 * Extracted from VideoTravelToolPage.tsx to reduce component size and improve maintainability.
 * Contains all callbacks that update shot settings via shotSettingsRef.
 * 
 * Dependencies:
 * - shotSettingsRef: Ref to the shot settings object (from useShotSettings)
 * - currentShotId: Current shot ID for guards
 * - selectedShot: Currently selected shot (for generation mode cache updates)
 * - updateShotMode: Function to optimistically update generation mode cache
 * 
 * @see VideoTravelToolPage.tsx - Main page component that uses this hook
 * @see useShotSettings.ts - Settings management hook
 */

import { useCallback, useMemo, useRef, MutableRefObject } from 'react';
import { Shot } from '@/domains/generation/types';
import {
  VideoTravelSettings,
  PhaseConfig,
  DEFAULT_PHASE_CONFIG,
  DEFAULT_VACE_PHASE_CONFIG,
  MODEL_DEFAULTS,
  clampFrameCountToPolicy,
  coerceSelectedModel,
  getModelSpec,
  type SelectedModel,
} from '../../settings';
import { BUILTIN_DEFAULT_I2V_ID, BUILTIN_DEFAULT_VACE_ID } from '../../components/MotionControl.constants';
import { SteerableMotionSettings, DEFAULT_STEERABLE_MOTION_SETTINGS } from '../../components/ShotEditor/state/types';
import { buildBasicModeGenerationRequest as buildBasicModePhaseConfig } from '../../components/ShotEditor/services/generateVideo/modelPhase';
import { UseShotSettingsReturn } from './useShotSettings';
import type { PresetMetadata } from '@/shared/types/presetMetadata';
import type { ActiveLora } from '@/domains/lora/types/lora';
import type { ShotSetSettingsValues } from '@/tools/video-editor/commands/shotSetGesture.ts';

interface UseVideoTravelSettingsHandlersParams {
  /** Ref to the shot settings - used to access current settings without triggering re-renders */
  shotSettingsRef: MutableRefObject<UseShotSettingsReturn>;
  /** Current shot ID - used for guards in mode change handlers */
  currentShotId: string | null;
  /** Currently selected shot - used for generation mode cache updates */
  selectedShot: Shot | null;
  /** Function to optimistically update the generation mode cache */
  updateShotMode: (shotId: string, mode: 'batch' | 'timeline' | 'by-pair') => void;
  /** Capture the prompt before the local settings draft changes. */
  onSettingsIntent?: (settings: Pick<ShotSetSettingsValues, 'prompt'>) => void;
}

export interface VideoTravelSettingsHandlers {
  // Video control mode
  handleVideoControlModeChange: (mode: 'individual' | 'batch') => void;

  // Pair configs
  handlePairConfigChange: (pairId: string, field: 'prompt' | 'frames' | 'context', value: string | number) => void;

  // Batch video settings
  handleBatchVideoPromptChange: (prompt: string) => void;
  handleNegativePromptChange: (prompt: string) => void;
  handleBatchVideoFramesChange: (frames: number) => void;
  handleBatchVideoStepsChange: (steps: number) => void;
  handleGuidanceScaleChange: (guidanceScale: number) => void;

  // Text prompts
  handleTextBeforePromptsChange: (text: string) => void;
  handleTextAfterPromptsChange: (text: string) => void;
  
  // Save triggers
  handleBlurSave: () => void;
  
  // Generation settings
  handleEnhancePromptChange: (enhance: boolean) => void;
  handleTurboModeChange: (turbo: boolean) => void;
  handleSmoothContinuationsChange: (smooth: boolean) => void;
  
  // Motion settings
  handleAmountOfMotionChange: (motion: number) => void;
  handleMotionModeChange: (mode: 'basic' | 'advanced') => void;
  handleGenerationTypeModeChange: (mode: 'i2v' | 'vace') => void;
  handleSteerableMotionSettingsChange: (settings: Partial<SteerableMotionSettings>) => void;
  handleSelectedModelChange: (model: SelectedModel) => void;
  
  // Phase config
  handlePhaseConfigChange: (config: PhaseConfig) => void;
  handlePhasePresetSelect: (presetId: string, config: PhaseConfig, presetMetadata?: PresetMetadata) => void;
  handlePhasePresetRemove: () => void;
  handleRestoreDefaults: () => void;
  
  // Generation mode (batch vs timeline)
  handleGenerationModeChange: (mode: 'batch' | 'timeline' | 'by-pair') => void;
  
  // LoRAs
  handleSelectedLorasChange: (loras: ActiveLora[]) => void;
  
  // No-op callback for disabled handlers
  noOpCallback: () => void;
}

/**
 * Hook that provides all settings handler callbacks for VideoTravelToolPage.
 * 
 * All handlers use refs to access current values without triggering callback recreation.
 * This is critical for performance - preventing infinite re-render loops.
 */
export const useVideoTravelSettingsHandlers = ({
  shotSettingsRef,
  currentShotId,
  selectedShot,
  updateShotMode,
  onSettingsIntent,
}: UseVideoTravelSettingsHandlersParams): VideoTravelSettingsHandlers => {
  
  // Use refs to avoid recreating callbacks when these values change
  const selectedShotRef = useRef(selectedShot);
  selectedShotRef.current = selectedShot;
  const updateShotModeRef = useRef(updateShotMode);
  updateShotModeRef.current = updateShotMode;
  
  // =============================================================================
  // NO-OP CALLBACK
  // =============================================================================
  const noOpCallback = useCallback(() => {}, []);

  const mapSelectedLorasForPhaseConfig = useCallback((loras: ActiveLora[] = []) => (
    loras.map(({ path, strength, lowNoisePath, isMultiStage }) => ({
      path,
      strength,
      lowNoisePath,
      isMultiStage,
    }))
  ), []);
  
  // =============================================================================
  // VIDEO CONTROL MODE
  // =============================================================================
  const handleVideoControlModeChange = useCallback((mode: 'individual' | 'batch') => {
    shotSettingsRef.current.updateField('videoControlMode', mode);
  }, [shotSettingsRef]);

  // =============================================================================
  // PAIR CONFIGS
  // =============================================================================
  const handlePairConfigChange = useCallback((pairId: string, field: 'prompt' | 'frames' | 'context', value: string | number) => {
    const currentPairConfigs = shotSettingsRef.current.settings?.pairConfigs || [];
    const updated = currentPairConfigs.map(p => p.id === pairId ? { ...p, [field]: value } : p);
    shotSettingsRef.current.updateField('pairConfigs', updated);
  }, [shotSettingsRef]);

  // =============================================================================
  // BATCH VIDEO SETTINGS
  // =============================================================================
  const handleBatchVideoPromptChange = useCallback((prompt: string) => {
    try {
      onSettingsIntent?.({ prompt });
    } catch (error) {
      // Keep the user's draft visible when native capture refuses; persistence
      // will surface the same refusal instead of snapshotting the form.
      shotSettingsRef.current.updateField('prompt', prompt);
      throw error;
    }
    shotSettingsRef.current.updateField('prompt', prompt);
  }, [onSettingsIntent, shotSettingsRef]);

  const handleNegativePromptChange = useCallback((prompt: string) => {
    shotSettingsRef.current.updateField('negativePrompt', prompt);
  }, [shotSettingsRef]);

  const handleBatchVideoFramesChange = useCallback((frames: number) => {
    const current = shotSettingsRef.current.settings;
    const model = coerceSelectedModel(current.selectedModel);
    const existing = current.modelSettingsByModel?.[model];
    const clampedFrames = clampFrameCountToPolicy(frames, getModelSpec(model), {
      smoothContinuations: current.smoothContinuations ?? false,
      requestedExecutionMode: current.generationTypeMode ?? 'i2v',
    });
    shotSettingsRef.current.updateFields({
      batchVideoFrames: clampedFrames,
      modelSettingsByModel: {
        ...(current.modelSettingsByModel ?? {}),
        [model]: { ...existing, batchVideoFrames: clampedFrames },
      },
    });
  }, [shotSettingsRef]);

  const handleBatchVideoStepsChange = useCallback((steps: number) => {
    const current = shotSettingsRef.current.settings;
    const model = coerceSelectedModel(current.selectedModel);
    const existing = current.modelSettingsByModel?.[model];
    shotSettingsRef.current.updateFields({
      batchVideoSteps: steps,
      modelSettingsByModel: {
        ...(current.modelSettingsByModel ?? {}),
        [model]: { ...existing, batchVideoSteps: steps },
      },
    });
  }, [shotSettingsRef]);

  const handleGuidanceScaleChange = useCallback((guidanceScale: number) => {
    shotSettingsRef.current.updateField('guidanceScale', guidanceScale);
  }, [shotSettingsRef]);

  // =============================================================================
  // TEXT PROMPTS
  // =============================================================================
  const handleTextBeforePromptsChange = useCallback((text: string) => {
    shotSettingsRef.current.updateField('textBeforePrompts', text);
  }, [shotSettingsRef]);
  
  const handleTextAfterPromptsChange = useCallback((text: string) => {
    shotSettingsRef.current.updateField('textAfterPrompts', text);
  }, [shotSettingsRef]);
  
  // =============================================================================
  // SAVE TRIGGERS
  // =============================================================================
  const handleBlurSave = useCallback(() => {
    shotSettingsRef.current.saveImmediate();
  }, [shotSettingsRef]);

  // =============================================================================
  // GENERATION SETTINGS
  // =============================================================================
  const handleEnhancePromptChange = useCallback((enhance: boolean) => {
    shotSettingsRef.current.updateField('enhancePrompt', enhance);
  }, [shotSettingsRef]);

  const handleTurboModeChange = useCallback((turbo: boolean) => {
    // When enabling turbo mode, automatically disable advanced mode but keep preset
    if (turbo && shotSettingsRef.current.settings?.advancedMode) {
      shotSettingsRef.current.updateFields({
        turboMode: turbo,
        advancedMode: false,
        motionMode: 'basic'
      });
    } else {
      shotSettingsRef.current.updateField('turboMode', turbo);
    }
  }, [shotSettingsRef]);

  const handleSmoothContinuationsChange = useCallback((smooth: boolean) => {
    const current = shotSettingsRef.current.settings;
    const model = coerceSelectedModel(current.selectedModel);
    const existing = current.modelSettingsByModel?.[model];
    const clampedFrames = clampFrameCountToPolicy(
      current.batchVideoFrames ?? existing?.batchVideoFrames ?? MODEL_DEFAULTS[model].frames,
      getModelSpec(model),
      {
        smoothContinuations: smooth,
        requestedExecutionMode: current.generationTypeMode ?? 'i2v',
      },
    );

    shotSettingsRef.current.updateFields({
      smoothContinuations: smooth,
      batchVideoFrames: clampedFrames,
      modelSettingsByModel: {
        ...(current.modelSettingsByModel ?? {}),
        [model]: { ...existing, batchVideoFrames: clampedFrames },
      },
    });
  }, [shotSettingsRef]);

  // =============================================================================
  // PHASE CONFIG SYNC
  // Keep the phase config in sync based on basic mode settings.
  // Used by multiple handlers to ensure Advanced mode shows correct defaults:
  // - I2V vs VACE mode (2 vs 3 phases, different models)
  // - Amount of motion (motion LoRA strength)
  // - User-selected LoRAs (added to all phases)
  //
  // Rebuilds only in Basic mode so Advanced customizations are preserved.
  // =============================================================================
  const rebuildPhaseConfig = useCallback((options?: {
    generationTypeMode?: 'i2v' | 'vace';
    amountOfMotion?: number;
    selectedLoras?: Array<{
      path: string;
      strength: number;
      lowNoisePath?: string;
      isMultiStage?: boolean;
    }>;
  }) => {
    const currentSettings = shotSettingsRef.current.settings;

    // Only rebuild when in Basic mode.
    const isBasicMode = currentSettings?.motionMode === 'basic' || !currentSettings?.motionMode;
    if (!isBasicMode) return;

    const motion = options?.amountOfMotion ?? currentSettings?.amountOfMotion ?? 50;
    const loras = options?.selectedLoras ?? mapSelectedLorasForPhaseConfig(currentSettings?.loras || []);
    const useVaceModel = (options?.generationTypeMode ?? currentSettings?.generationTypeMode ?? 'i2v') === 'vace';

    const basicConfig = buildBasicModePhaseConfig(motion, loras, useVaceModel);
    shotSettingsRef.current.updateField('phaseConfig', basicConfig.phaseConfig);
  }, [shotSettingsRef, mapSelectedLorasForPhaseConfig]);

  // =============================================================================
  // MOTION SETTINGS
  // =============================================================================
  const handleAmountOfMotionChange = useCallback((motion: number) => {
    shotSettingsRef.current.updateField('amountOfMotion', motion);
    rebuildPhaseConfig({ amountOfMotion: motion });
  }, [shotSettingsRef, rebuildPhaseConfig]);

  const handleMotionModeChange = useCallback((mode: 'basic' | 'advanced') => {
    // CRITICAL: Guard against calls when no shot is selected
    // This can happen during component unmount/remount cycles when Tabs triggers onValueChange
    // Use currentShotId (same source as useShotSettings) not selectedShot which can be out of sync
    if (!currentShotId) {
      return;
    }
    
    // Prevent switching to advanced mode when turbo mode is on
    if (mode === 'advanced' && shotSettingsRef.current.settings?.turboMode) {
      return;
    }
    
    // When switching to advanced mode, initialize phaseConfig from basic mode settings
    if (mode === 'advanced') {
      const currentPhaseConfig = shotSettingsRef.current.settings?.phaseConfig;
      if (!currentPhaseConfig) {
        // Build phase config from current basic mode settings
        const currentSettings = shotSettingsRef.current.settings;
        const currentMotion = currentSettings?.amountOfMotion ?? 50;
        const currentLoras = mapSelectedLorasForPhaseConfig(currentSettings?.loras || []);
        const useVace = currentSettings?.generationTypeMode === 'vace';

        const basicConfig = buildBasicModePhaseConfig(currentMotion, currentLoras, useVace);

        shotSettingsRef.current.updateFields({
          motionMode: mode,
          advancedMode: true,
          phaseConfig: basicConfig.phaseConfig
        });
      } else {
        shotSettingsRef.current.updateFields({
          motionMode: mode,
          advancedMode: true
        });
      }
    } else {
      // Basic mode - disable advanced mode and reset to defaults
      // Always reset to default config when switching from Advanced to Basic
      const currentSettings = shotSettingsRef.current.settings;
      const isVaceMode = currentSettings?.generationTypeMode === 'vace';
      const defaultPresetId = isVaceMode ? BUILTIN_DEFAULT_VACE_ID : BUILTIN_DEFAULT_I2V_ID;
      const defaultConfig = isVaceMode ? DEFAULT_VACE_PHASE_CONFIG : DEFAULT_PHASE_CONFIG;

      shotSettingsRef.current.updateFields({
        motionMode: mode,
        advancedMode: false,
        selectedPhasePresetId: defaultPresetId,
        phaseConfig: defaultConfig
      });
    }
  }, [currentShotId, shotSettingsRef, mapSelectedLorasForPhaseConfig]);

  const handleGenerationTypeModeChange = useCallback((mode: 'i2v' | 'vace') => {
    const currentSettings = shotSettingsRef.current.settings;
    const model = coerceSelectedModel(currentSettings.selectedModel);
    const existing = currentSettings.modelSettingsByModel?.[model];
    const clampedFrames = clampFrameCountToPolicy(
      currentSettings.batchVideoFrames ?? existing?.batchVideoFrames ?? getModelSpec(model).defaultFrames,
      getModelSpec(model),
      {
        smoothContinuations: currentSettings.smoothContinuations ?? false,
        requestedExecutionMode: mode,
      },
    );

    // Update generation type mode AND the preset ID to match
    // This keeps things consistent (preset ID should match the mode's default)
    const isBasicMode = currentSettings?.motionMode === 'basic' || !currentSettings?.motionMode;
    const currentMotion = currentSettings?.amountOfMotion ?? 50;
    const currentLoras = mapSelectedLorasForPhaseConfig(currentSettings?.loras || []);
    const basicConfig = buildBasicModePhaseConfig(currentMotion, currentLoras, mode === 'vace');

    if (isBasicMode) {
      // In basic mode: update mode, preset ID, and phase config atomically.
      const defaultPresetId = mode === 'vace' ? BUILTIN_DEFAULT_VACE_ID : BUILTIN_DEFAULT_I2V_ID;
      shotSettingsRef.current.updateFields({
        generationTypeMode: mode,
        selectedPhasePresetId: defaultPresetId,
        phaseConfig: basicConfig.phaseConfig,
        batchVideoFrames: clampedFrames,
        modelSettingsByModel: {
          ...(currentSettings.modelSettingsByModel ?? {}),
          [model]: { ...existing, batchVideoFrames: clampedFrames },
        },
      });
    } else {
      // In advanced mode, mode switches still replace the phase structure to match the builtin config.
      shotSettingsRef.current.updateFields({
        generationTypeMode: mode,
        selectedPhasePresetId: null,
        phaseConfig: basicConfig.phaseConfig,
        batchVideoFrames: clampedFrames,
        modelSettingsByModel: {
          ...(currentSettings.modelSettingsByModel ?? {}),
          [model]: { ...existing, batchVideoFrames: clampedFrames },
        },
      });
    }
  }, [shotSettingsRef, mapSelectedLorasForPhaseConfig]);

  const handleSteerableMotionSettingsChange = useCallback((settings: Partial<SteerableMotionSettings>) => {
    // FIX: Use ref to get current value and avoid callback recreation
    // Ensure required fields are always present by seeding with defaults
    const currentSettings: SteerableMotionSettings = {
      ...DEFAULT_STEERABLE_MOTION_SETTINGS,
      ...(shotSettingsRef.current.settings?.steerableMotionSettings ?? {}),
    };
    shotSettingsRef.current.updateFields({
      steerableMotionSettings: {
        ...currentSettings,
        ...settings
      }
    });
  }, [shotSettingsRef]);

  const handleSelectedModelChange = useCallback((_model: SelectedModel) => {
    // Implemented in the provider because switching models needs coordinated
    // updates across fields plus per-model substate persistence.
  }, []);

  // =============================================================================
  // PHASE CONFIG
  // =============================================================================
  const handlePhaseConfigChange = useCallback((config: PhaseConfig) => {
    // Auto-set model_switch_phase to 1 when num_phases is 2
    const adjustedConfig = config.num_phases === 2 
      ? { ...config, model_switch_phase: 1 }
      : config;
    
    // Clear preset reference when user manually edits config - the config no longer matches the preset
    shotSettingsRef.current.updateFields({
      phaseConfig: adjustedConfig,
      selectedPhasePresetId: null
    });
  }, [shotSettingsRef]);

  const handlePhasePresetSelect = useCallback((presetId: string, config: PhaseConfig, presetMetadata?: PresetMetadata) => {
    
    // DEEP CLONE: Create completely new config to prevent shared references
    // This ensures modifying LoRA strengths in one phase doesn't affect other phases
    const deepClonedConfig: PhaseConfig = {
      ...config,
      steps_per_phase: [...config.steps_per_phase],
      phases: config.phases.map(phase => ({
        ...phase,
        loras: phase.loras.map(lora => ({ ...lora })) // Deep clone each LoRA
      }))
    };
    
    // Update preset ID, phase config, and generation type mode (if preset specifies one)
    const updates: Partial<VideoTravelSettings> = {
      selectedPhasePresetId: presetId,
      phaseConfig: deepClonedConfig
    };
    
    // Also apply the preset's generation type mode if it has one
    const presetGenerationTypeMode = presetMetadata?.generationTypeMode;
    if (presetGenerationTypeMode === 'i2v' || presetGenerationTypeMode === 'vace') {
      updates.generationTypeMode = presetGenerationTypeMode;
    }
    
    shotSettingsRef.current.updateFields(updates);
  }, [shotSettingsRef]);

  const handlePhasePresetRemove = useCallback(() => {
    
    // Clear preset ID but keep the current config
    shotSettingsRef.current.updateField('selectedPhasePresetId', null);
  }, [shotSettingsRef]);

  // Handler for restoring defaults in Advanced mode - respects current I2V/VACE mode
  const handleRestoreDefaults = useCallback(() => {
    const currentSettings = shotSettingsRef.current.settings;
    const isVaceMode = currentSettings?.generationTypeMode === 'vace';
    const defaultPresetId = isVaceMode ? BUILTIN_DEFAULT_VACE_ID : BUILTIN_DEFAULT_I2V_ID;
    const currentMotion = currentSettings?.amountOfMotion ?? 50;
    const currentLoras = mapSelectedLorasForPhaseConfig(currentSettings?.loras || []);
    const basicConfig = buildBasicModePhaseConfig(currentMotion, currentLoras, isVaceMode);

    shotSettingsRef.current.updateFields({
      selectedPhasePresetId: defaultPresetId,
      phaseConfig: basicConfig.phaseConfig,
    });
  }, [shotSettingsRef, mapSelectedLorasForPhaseConfig]);

  // =============================================================================
  // GENERATION MODE (batch vs timeline)
  // =============================================================================
  const handleGenerationModeChange = useCallback((mode: 'batch' | 'timeline' | 'by-pair') => {
    
    // Optimistically update the cache for THIS shot immediately
    if (selectedShotRef.current?.id) {
      updateShotModeRef.current(selectedShotRef.current.id, mode);
    }

    // Update the actual settings (will save to DB asynchronously)
    shotSettingsRef.current.updateField('generationMode', mode);
  }, [shotSettingsRef]);

  // =============================================================================
  // LORAS
  // =============================================================================
  const handleSelectedLorasChange = useCallback((lorasToSet: ActiveLora[]) => {
    shotSettingsRef.current.updateField('loras', lorasToSet);
    rebuildPhaseConfig({
      selectedLoras: mapSelectedLorasForPhaseConfig(lorasToSet || []),
    });
  }, [shotSettingsRef, rebuildPhaseConfig, mapSelectedLorasForPhaseConfig]);

  // Memoize return to prevent object recreation on every render.
  // This object is used as a dependency in VideoTravelSettingsProvider's context useMemo.
  // Without memoization, the context value changes every render → all consumers re-render.
  return useMemo(() => ({
    noOpCallback,
    handleVideoControlModeChange,
    handlePairConfigChange,
    handleBatchVideoPromptChange,
    handleNegativePromptChange,
    handleBatchVideoFramesChange,
    handleBatchVideoStepsChange,
    handleGuidanceScaleChange,
    handleTextBeforePromptsChange,
    handleTextAfterPromptsChange,
    handleBlurSave,
    handleEnhancePromptChange,
    handleTurboModeChange,
    handleSmoothContinuationsChange,
    handleAmountOfMotionChange,
    handleMotionModeChange,
    handleGenerationTypeModeChange,
    handleSteerableMotionSettingsChange,
    handleSelectedModelChange,
    handlePhaseConfigChange,
    handlePhasePresetSelect,
    handlePhasePresetRemove,
    handleRestoreDefaults,
    handleGenerationModeChange,
    handleSelectedLorasChange,
  }), [
    noOpCallback,
    handleVideoControlModeChange,
    handlePairConfigChange,
    handleBatchVideoPromptChange,
    handleNegativePromptChange,
    handleBatchVideoFramesChange,
    handleBatchVideoStepsChange,
    handleGuidanceScaleChange,
    handleTextBeforePromptsChange,
    handleTextAfterPromptsChange,
    handleBlurSave,
    handleEnhancePromptChange,
    handleTurboModeChange,
    handleSmoothContinuationsChange,
    handleAmountOfMotionChange,
    handleMotionModeChange,
    handleGenerationTypeModeChange,
    handleSteerableMotionSettingsChange,
    handleSelectedModelChange,
    handlePhaseConfigChange,
    handlePhasePresetSelect,
    handlePhasePresetRemove,
    handleRestoreDefaults,
    handleGenerationModeChange,
    handleSelectedLorasChange,
  ]);
};
