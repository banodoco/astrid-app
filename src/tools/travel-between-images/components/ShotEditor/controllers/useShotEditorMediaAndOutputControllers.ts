import { useEditingController } from './useEditingController';
import { useOutputController } from './useOutputController';
import type { ShotEditorState } from '../state/types';
import type { ShotEditorActions } from '../state/useShotEditorState';
import type { GenerationRow, Shot } from '@/domains/generation/types';
import type { SelectedModel } from '@/tools/travel-between-images/settings';

interface UseShotEditorMediaAndOutputControllersParams {
  selectedProjectId: string;
  selectedShotId: string;
  selectedShot: Shot | null;
  projectId: string;
  timelineImages: GenerationRow[];
  effectiveAspectRatio?: string;
  swapButtonRef: React.RefObject<HTMLButtonElement>;
  onUpdateShotName?: (name: string) => void;
  onBeforeNameEdit?: () => void;
  state: Pick<ShotEditorState, 'isEditingName' | 'editingName'>;
  actions: ShotEditorActions;
  generationTypeMode: 'i2v' | 'vace';
  setGenerationTypeMode: (mode: 'i2v' | 'vace') => void;
  selectedModel: SelectedModel;
}

export function useShotEditorMediaAndOutputControllers({
  selectedProjectId,
  selectedShotId,
  selectedShot,
  projectId,
  timelineImages,
  effectiveAspectRatio,
  swapButtonRef,
  onUpdateShotName,
  onBeforeNameEdit,
  state,
  actions,
  generationTypeMode,
  setGenerationTypeMode,
  selectedModel,
}: UseShotEditorMediaAndOutputControllersParams) {
  const output = useOutputController({
    selectedProjectId,
    selectedShotId,
    selectedShot,
    timelineImages,
  });

  const editing = useEditingController({
    core: {
      selectedShotId,
      projectId,
      selectedProjectId,
      selectedShot,
      effectiveAspectRatio,
      swapButtonRef,
    },
    nameEditing: {
      onUpdateShotName,
      onBeforeNameEdit,
      state,
      actions,
    },
    generationType: {
      generationTypeMode,
      setGenerationTypeMode,
      selectedModel,
    },
    joinInputs: {
      joinSegmentSlots: output.joinSegmentSlots,
      joinSelectedParent: output.joinSelectedParent,
    },
  });

  return {
    output,
    editing,
  };
}
