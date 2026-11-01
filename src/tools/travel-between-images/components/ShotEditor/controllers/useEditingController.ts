import type React from 'react';
import type { Shot } from '@/domains/generation/types';
import type { SelectedModel } from '@/tools/travel-between-images/settings';
import { useAudio } from '../hooks/video/useAudio';
import { useJoinSegmentsHandler } from '../hooks/actions/useJoinSegmentsHandler';
import { useJoinSegmentsSetup } from '../hooks/actions/useJoinSegmentsSetup';
import { useNameEditing } from '../hooks/editor-state/useNameEditing';
import { useStructureVideo } from '../hooks/video/useStructureVideo';
import { useStructureVideoHandlers } from '../hooks/video/useStructureVideoHandlers';

interface EditingControllerCore {
  selectedShotId: string;
  projectId: string | null;
  selectedProjectId: string | null;
  selectedShot: Shot | null;
  effectiveAspectRatio: string | undefined;
  swapButtonRef: React.RefObject<HTMLButtonElement>;
}

interface EditingControllerNameState {
  onUpdateShotName?: (newName: string) => void;
  onBeforeNameEdit?: () => void;
  state: {
    isEditingName: boolean;
    editingName: string;
  };
  actions: ReturnType<typeof import('../state/useShotEditorState').useShotEditorState>['actions'];
}

interface EditingControllerGenerationType {
  generationTypeMode: 'i2v' | 'vace';
  setGenerationTypeMode: (mode: 'i2v' | 'vace') => void;
  selectedModel: SelectedModel;
}

interface EditingControllerJoinInputs {
  joinSegmentSlots: ReturnType<typeof import('@/shared/hooks/segments').useSegmentOutputsForShot>['segmentSlots'];
  joinSelectedParent: ReturnType<typeof import('@/shared/hooks/segments').useSegmentOutputsForShot>['selectedParent'];
}

interface UseEditingControllerParams {
  core: EditingControllerCore;
  nameEditing: EditingControllerNameState;
  generationType: EditingControllerGenerationType;
  joinInputs: EditingControllerJoinInputs;
}

export function useEditingController({
  core,
  nameEditing,
  generationType,
  joinInputs,
}: UseEditingControllerParams) {
  // Structure video management
  const {
    travelGuidance,
    travelGuidanceByModel,
    structureGuidance,
    structureVideoPath,
    structureVideoMetadata,
    structureVideoTreatment,
    structureVideoMotionStrength,
    structureVideoType,
    structureVideoResourceId,
    structureVideoUni3cEndPercent,
    structureVideoDefaultsByModel,
    isLoading: isStructureVideoSettingsLoading,
    structureVideos,
    addStructureVideo,
    updateStructureVideo,
    removeStructureVideo,
    clearAllStructureVideos,
    setStructureVideos,
    updateStructureGuidanceControls,
  } = useStructureVideo({
    projectId: core.projectId ?? '',
    shotId: core.selectedShot?.id,
    selectedModel: generationType.selectedModel,
  });

  const {
    handleUni3cEndPercentChange,
    handleStructureVideoMotionStrengthChange,
    handleStructureTypeChangeFromMotionControl,
    handleStructureVideoInputChange,
  } = useStructureVideoHandlers({
    structureVideos,
    setStructureVideos,
    updateStructureGuidanceControls,
    structureVideoPath,
    structureVideoType,
    structureVideoUni3cEndPercent,
    generationTypeMode: generationType.generationTypeMode,
    setGenerationTypeMode: generationType.setGenerationTypeMode,
  });

  // Audio management
  const {
    audioUrl,
    audioMetadata,
    handleAudioChange,
    isLoading: isAudioSettingsLoading,
  } = useAudio({
    projectId: core.projectId ?? '',
    shotId: core.selectedShot?.id,
  });

  // Name editing
  const {
    handleNameClick,
    handleNameSave,
    handleNameCancel,
    handleNameKeyDown,
  } = useNameEditing({
    selectedShot: core.selectedShot ?? undefined,
    state: nameEditing.state,
    actions: {
      ...nameEditing.actions,
      setEditingName: nameEditing.actions.setEditingName,
      setEditingNameValue: nameEditing.actions.setEditingNameValue,
    },
    onUpdateShotName: nameEditing.onUpdateShotName,
    onBeforeNameEdit: nameEditing.onBeforeNameEdit,
  });

  // Join segments setup
  const joinSetup = useJoinSegmentsSetup({
    selectedShotId: core.selectedShotId,
    projectId: core.projectId ?? '',
    swapButtonRef: core.swapButtonRef,
  });

  const {
    joinSettingsForHook,
    joinLoraManager,
  } = joinSetup;

  // Join segments handler
  const {
    isJoiningClips,
    joinClipsSuccess,
    joinValidationData,
    handleJoinSegments,
    handleRestoreJoinDefaults,
  } = useJoinSegmentsHandler({
    projectId: core.projectId ?? undefined,
    selectedProjectId: core.selectedProjectId ?? undefined,
    selectedShotId: core.selectedShotId,
    effectiveAspectRatio: core.effectiveAspectRatio,
    audioUrl,
    joinSegmentSlots: joinInputs.joinSegmentSlots,
    joinSelectedParent: joinInputs.joinSelectedParent,
    joinLoraManager,
    joinSettings: joinSettingsForHook,
  });

  const mediaEditing = {
    // Structure video + handlers
    travelGuidance,
    travelGuidanceByModel,
    structureGuidance,
    structureVideoPath,
    structureVideoMetadata,
    structureVideoTreatment,
    structureVideoMotionStrength,
    structureVideoType,
    structureVideoResourceId,
    structureVideoUni3cEndPercent,
    structureVideoDefaultsByModel,
    isStructureVideoSettingsLoading,
    structureVideos,
    addStructureVideo,
    updateStructureVideo,
    removeStructureVideo,
    clearAllStructureVideos,
    setStructureVideos,
    updateStructureGuidanceControls,
    handleUni3cEndPercentChange,
    handleStructureVideoMotionStrengthChange,
    handleStructureTypeChangeFromMotionControl,
    handleStructureVideoInputChange,

    // Audio
    audioUrl,
    audioMetadata,
    handleAudioChange,
    isAudioSettingsLoading,

    // Name editing
    handleNameClick,
    handleNameSave,
    handleNameCancel,
    handleNameKeyDown,
  };

  const joinWorkflow = {
    ...joinSetup,
    isJoiningClips,
    joinClipsSuccess,
    joinValidationData,
    handleJoinSegments,
    handleRestoreJoinDefaults,
  };

  return {
    mediaEditing,
    joinWorkflow,
  };
}
