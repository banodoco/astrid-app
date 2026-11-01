import React, { useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { Label } from '@/shared/components/ui/primitives/label';
import { Settings, Pencil } from 'lucide-react';
import { HoverScrubVideo } from '@/shared/components/media/HoverScrubVideo';
import { PhaseConfigVertical } from '@/shared/components/PhaseConfigSelectorModal';
import { PhaseConfig } from '@/shared/types/phaseConfig';
import { MotionPresetSectionHeader } from './MotionPresetSectionHeader';
import type { MotionPresetSelectorProps, MotionMode, PresetMetadata } from './types';

// Re-export BuiltinPreset type (used externally for preset definitions)

/**
 * Shared component for Basic/Advanced motion settings with preset selection.
 * 
 * Features:
 * - Basic mode: the built-in preset chip plus Custom, and optional custom content (e.g., LoRAs)
 * - Advanced mode: Full PhaseConfigVertical editor
 * - Persists selections via callbacks
 * 
 * @example
 * ```tsx
 * <MotionPresetSelector
 *   builtinPreset={BUILTIN_JOIN_CLIPS_PRESET}
 *   selectedPhasePresetId={selectedPhasePresetId}
 *   phaseConfig={phaseConfig}
 *   motionMode={motionMode}
 *   onPresetSelect={handlePresetSelect}
 *   onPresetRemove={handlePresetRemove}
 *   onModeChange={handleModeChange}
 *   onPhaseConfigChange={handlePhaseConfigChange}
 *   renderBasicModeContent={() => (
 *     <LoraManager ... />
 *   )}
 * />
 * ```
 */
export const MotionPresetSelector: React.FC<MotionPresetSelectorProps> = ({
  // Core config
  builtinPreset,

  // State
  selectedPhasePresetId,
  phaseConfig,
  motionMode,
  
  // Callbacks
  onPresetSelect,
  onPresetRemove,
  onModeChange,
  onPhaseConfigChange,
  onRestoreDefaults,
  
  // Advanced mode props
  randomSeed = true,
  onRandomSeedChange,
  
  // Optional behavior
  advancedDisabled = false,
  advancedDisabledReason,
  presetTooltip = 'Select a motion preset to control generation settings.\nUse "Custom" to configure your own settings in Advanced mode.',
  renderBasicModeContent,
  labelSuffix,
}) => {
  // Defensive: some callsites may pass non-functions (e.g. via `any`).
  // Avoid crashing the entire UI; treat invalid callbacks as no-ops.
  const safeOnModeChange = useCallback((mode: MotionMode) => {
    if (typeof onModeChange === 'function') {
      onModeChange(mode);
    }
  }, [onModeChange]);
  const safeOnPresetRemove = useCallback(() => {
    if (typeof onPresetRemove === 'function') {
      onPresetRemove();
    }
  }, [onPresetRemove]);
  const safeOnPresetSelect = useCallback((id: string, config: PhaseConfig, metadata?: PresetMetadata) => {
    if (typeof onPresetSelect === 'function') {
      onPresetSelect(id, config, metadata);
    }
  }, [onPresetSelect]);
  const safeOnPhaseConfigChange = useCallback((config: PhaseConfig) => {
    if (typeof onPhaseConfigChange === 'function') {
      onPhaseConfigChange(config);
    }
  }, [onPhaseConfigChange]);

  // Normalize possibly-missing/invalid mode values coming from persisted settings.
  // This prevents the Tabs from ending up with "no selection".
  const normalizedMotionMode: MotionMode =
    advancedDisabled ? 'basic' : (motionMode === 'advanced' ? 'advanced' : 'basic');

  // Custom mode = no preset selected
  const isCustomConfig = !selectedPhasePresetId;

  // Handle motion mode change
  const handleModeChange = useCallback((newMode: string) => {
    if (newMode === normalizedMotionMode) return;
    if (advancedDisabled && newMode === 'advanced') return;
    safeOnModeChange(newMode as MotionMode);
  }, [normalizedMotionMode, advancedDisabled, safeOnModeChange]);

  // Handle editing a preset (load its config and switch to advanced)
  const handleEditPreset = useCallback((presetPhaseConfig: PhaseConfig | undefined) => {
    if (presetPhaseConfig) {
      safeOnPhaseConfigChange(presetPhaseConfig);
    }
    safeOnPresetRemove();
    safeOnModeChange('advanced');
  }, [safeOnPhaseConfigChange, safeOnPresetRemove, safeOnModeChange]);

  // Handle preset selection from the chip
  const handlePresetSelect = useCallback(() => {
    safeOnPresetSelect(builtinPreset.id, builtinPreset.metadata.phaseConfig, builtinPreset.metadata);
  }, [builtinPreset, safeOnPresetSelect]);

  // Handle switching to custom/advanced mode
  const handleCustomClick = useCallback(() => {
    safeOnPresetRemove();
    safeOnModeChange('advanced');
  }, [safeOnPresetRemove, safeOnModeChange]);

  const builtinSampleVideo = builtinPreset.metadata.sample_generations?.find((g) => g.type === 'video');

  // Handle restore defaults for phase config
  const handleRestorePhaseConfigDefaults = useCallback(() => {
    safeOnPhaseConfigChange(builtinPreset.metadata.phaseConfig);
    safeOnPresetSelect(builtinPreset.id, builtinPreset.metadata.phaseConfig, builtinPreset.metadata);
  }, [builtinPreset, safeOnPhaseConfigChange, safeOnPresetSelect]);

  return (
    <div className="space-y-4">
      <Tabs value={normalizedMotionMode} onValueChange={handleModeChange}>
        <div className="flex items-center gap-3 mb-3">
          <Label className="text-sm font-medium">Mode:</Label>
          {labelSuffix}
          <TabsList className="grid w-40 grid-cols-2">
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger
              value="advanced"
              disabled={advancedDisabled}
              title={advancedDisabled ? advancedDisabledReason : undefined}
            >
              Advanced
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Basic Mode: Preset Selector + Optional Custom Content */}
        <TabsContent value="basic" className="mt-0 space-y-4">
          {/* Preset Selection Section */}
          <div className="space-y-3">
            <MotionPresetSectionHeader
              tooltipContent={presetTooltip}
              tooltipContentClassName="whitespace-pre-line"
            />

            <div className="grid grid-cols-3 gap-2 items-stretch">
              {/* Built-in preset */}
              <div className="relative group h-full">
                <button
                  onClick={handlePresetSelect}
                  className={`
                    w-full h-full flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors
                    ${!isCustomConfig && selectedPhasePresetId === builtinPreset.id
                      ? 'bg-primary/20 border-primary text-primary ring-2 ring-primary/30'
                      : 'bg-muted border-primary/30 hover:border-primary/50 hover:bg-muted/80'
                    }
                  `}
                >
                  {builtinSampleVideo && (
                    <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0">
                      <HoverScrubVideo
                        src={builtinSampleVideo.url}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                  <div className="flex min-w-0 flex-col justify-center items-start text-left flex-1">
                    <span className="text-sm font-medium leading-tight">
                      {builtinPreset.metadata.name || 'Preset'}{' '}
                      <span className="font-normal text-muted-foreground">(default)</span>
                    </span>
                  </div>
                </button>
                {/* Edit button - appears on hover */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditPreset(builtinPreset.metadata.phaseConfig);
                  }}
                  className="absolute top-1 right-1 p-1 rounded bg-muted/80 border border-border opacity-0 group-hover:opacity-100 hover:bg-primary hover:text-primary-foreground transition-all"
                  title="Edit in Advanced mode"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>

              {/* Custom chip - explicitly goes to advanced mode */}
              <button
                onClick={handleCustomClick}
                className={`
                  relative group flex items-center justify-center gap-2 px-3 py-2 rounded-lg border transition-colors
                  ${isCustomConfig
                    ? 'bg-primary/20 border-primary text-primary ring-2 ring-primary/30'
                    : 'bg-muted/50 border-border hover:border-primary/50 hover:bg-muted'
                  }
                `}
              >
                <Settings className="h-4 w-4" />
                <span className="text-sm font-medium">Custom</span>
              </button>
            </div>
          </div>

          {/* Optional custom content for Basic mode (e.g., LoRA manager) */}
          {renderBasicModeContent && (
            <div className="pt-4 border-t">
              {renderBasicModeContent()}
            </div>
          )}
        </TabsContent>

        {/* Advanced Mode: Phase Configuration */}
        <TabsContent value="advanced" className="mt-0">
          {phaseConfig ? (
            <PhaseConfigVertical
              phaseConfig={phaseConfig}
              onPhaseConfigChange={onPhaseConfigChange}
              randomSeed={randomSeed}
              onRandomSeedChange={onRandomSeedChange || (() => {})}
              onRestoreDefaults={onRestoreDefaults || handleRestorePhaseConfigDefaults}
            />
          ) : (
            <div className="text-sm text-muted-foreground p-4 border rounded-lg bg-muted/30">
              No phase configuration available. Switch to Basic mode to select a preset.
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
};
