/**
 * useSteerableMotionHandlers - Steerable motion settings handlers
 *
 * Extracted from ShotEditor to reduce component size.
 * Handles:
 * - Accelerated mode changes
 * - Random seed changes
 * - Steps changes with recommendations
 * - Model selection based on turbo mode
 */

import { useCallback, useRef, useEffect } from 'react';
import { DEFAULT_STEERABLE_MOTION_SETTINGS } from '../../state/types';
import {
  MODEL_DEFAULTS,
  getModelSpec,
  type SelectedModel,
} from '@/tools/travel-between-images/settings';

interface UseSteerableMotionHandlersOptions {
  // Settings values
  accelerated: boolean;
  randomSeed: boolean;
  turboMode: boolean;
  selectedModel: SelectedModel;
  steerableMotionSettings?: {
    model_name?: string;
    seed?: number;
    debug?: boolean;
  };
  // Settings loading state
  isShotUISettingsLoading: boolean;
  settingsLoadingFromContext: boolean;
  canonicalPersistence: boolean;
  // Setters
  updateShotUISettings: (scope: 'shot' | 'project', settings: Record<string, unknown>) => void;
  setSteerableMotionSettings: (settings: Partial<{ model_name: string; seed: number; negative_prompt: string; debug: boolean }>) => void;
  setSteps: (steps: number) => void;
  setShowStepsNotification: (show: boolean) => void;
  // Shot ID for change detection
  selectedShotId?: string;
}

interface UseSteerableMotionHandlersReturn {
  handleRandomSeedChange: (value: boolean) => void;
  handleAcceleratedChange: (value: boolean) => void;
  handleStepsChange: (steps: number) => void;
}

export function useSteerableMotionHandlers({
  accelerated,
  turboMode,
  selectedModel,
  steerableMotionSettings,
  isShotUISettingsLoading,
  settingsLoadingFromContext,
  canonicalPersistence,
  updateShotUISettings,
  setSteerableMotionSettings,
  setSteps,
  setShowStepsNotification,
  selectedShotId,
}: UseSteerableMotionHandlersOptions): UseSteerableMotionHandlersReturn {
  // Ref for stable callback
  const steerableMotionSettingsSetterRef = useRef(setSteerableMotionSettings);
  steerableMotionSettingsSetterRef.current = setSteerableMotionSettings;

  // Always use 6 steps for the hardcoded model
  const getRecommendedSteps = useCallback((model: SelectedModel) => (MODEL_DEFAULTS[model] ?? MODEL_DEFAULTS['wan-2.2']).steps, []);

  const hasInitializedStepsRef = useRef(false);

  useEffect(() => {
    if (isShotUISettingsLoading || settingsLoadingFromContext) {
      return;
    }

    if (!hasInitializedStepsRef.current) {
      hasInitializedStepsRef.current = true;
    }
  }, [isShotUISettingsLoading, settingsLoadingFromContext]);

  // Reset initialization flag when shot changes
  useEffect(() => {
    hasInitializedStepsRef.current = false;
  }, [selectedShotId]);

  // Set model based on turbo mode
  useEffect(() => {
    // Canonical popup settings are a projection; avoid turning a mount-time
    // derived model name into an unrelated authored edit.
    if (canonicalPersistence) {
      return;
    }

    if (!getModelSpec(selectedModel).ui.turboMode) {
      return;
    }

    const currentModelName = steerableMotionSettings?.model_name;
    const targetModel = turboMode ? 'vace_14B_fake_cocktail_2_2' : MODEL_DEFAULTS['wan-2.2'].modelName;
    if (currentModelName !== targetModel) {
      setSteerableMotionSettings({ model_name: targetModel });
    }
  }, [canonicalPersistence, selectedModel, turboMode, steerableMotionSettings?.model_name, setSteerableMotionSettings]);

  // Setters
  const setAccelerated = useCallback((value: boolean) => {
    updateShotUISettings('shot', { acceleratedMode: value });
  }, [updateShotUISettings]);

  const setRandomSeed = useCallback((value: boolean) => {
    updateShotUISettings('shot', { randomSeed: value });
  }, [updateShotUISettings]);

  // Handle random seed changes
  const handleRandomSeedChange = useCallback((value: boolean) => {
    setRandomSeed(value);
    if (value) {
      const newSeed = Math.floor(Math.random() * 1000000);
      steerableMotionSettingsSetterRef.current({ seed: newSeed });
    } else {
      steerableMotionSettingsSetterRef.current({ seed: DEFAULT_STEERABLE_MOTION_SETTINGS.seed });
    }
  }, [setRandomSeed]);

  // Handle accelerated mode changes
  const handleAcceleratedChange = useCallback((value: boolean) => {
    setAccelerated(value);
    setShowStepsNotification(false);
  }, [setAccelerated, setShowStepsNotification]);

  // Handle manual steps change
  const handleStepsChange = useCallback((steps: number) => {
    setSteps(steps);

    const recommendedSteps = getRecommendedSteps(selectedModel);
    if (steps !== recommendedSteps) {
      setShowStepsNotification(true);
      setTimeout(() => setShowStepsNotification(false), 5000);
    } else {
      setShowStepsNotification(false);
    }
  }, [getRecommendedSteps, selectedModel, setSteps, setShowStepsNotification]);

  return {
    handleRandomSeedChange,
    handleAcceleratedChange,
    handleStepsChange,
  };
}
