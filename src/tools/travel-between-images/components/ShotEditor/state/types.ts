export {
  type SteerableMotionSettings,
  DEFAULT_STEERABLE_MOTION_SETTINGS,
  type GenerationsPaneSettings,
} from '@/shared/types/steerableMotion';

/** Must be wrapped in VideoTravelSettingsProvider (settings come from context). */
interface ShotEditorCoreProps {
  selectedShotId: string;
  projectId: string;
  /** Optimistic shot data for newly created shots that aren't in the cache yet */
  optimisticShotData?: Partial<import('@/domains/generation/types').Shot>;
}

interface ShotEditorCallbackProps {
  onShotImagesUpdate: () => void;
  onBack: () => void;
}

export interface ShotEditorDimensionProps {
  dimensionSource?: 'project' | 'firstImage' | 'custom';
  onDimensionSourceChange?: (source: 'project' | 'firstImage' | 'custom') => void;
  customWidth?: number;
  onCustomWidthChange?: (width?: number) => void;
  customHeight?: number;
  onCustomHeightChange?: (height?: number) => void;
}

interface ShotEditorNavigationProps {
  onPreviousShot?: () => void;
  onNextShot?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onUpdateShotName?: (newName: string) => void;
  onBeforeNameEdit?: () => void;
}

interface ShotEditorCacheProps {
  getFinalVideoCount?: (shotId: string | null) => number | null;
  getHasStructureVideo?: (shotId: string | null) => boolean | null;
}

interface ShotEditorRefsProps {
  headerContainerRef?: (node: HTMLDivElement | null) => void;
  timelineSectionRef?: (node: HTMLDivElement | null) => void;
  ctaContainerRef?: (node: HTMLDivElement | null) => void;
  onSelectionChange?: (hasSelection: boolean) => void;
  getGenerationDataRef?: React.MutableRefObject<(() => {
    structureVideo: {
      path: string | null;
      type: 'canny' | 'depth' | null;
      treatment: 'adjust' | 'clip';
      motionStrength: number;
    };
    aspectRatio: string | null;
    loras: Array<{ id: string; path: string; strength: number; name: string }>;
  }) | null>;
  generateVideoRef?: React.MutableRefObject<((variantName?: string) => void | Promise<void>) | null>;
  nameClickRef?: React.MutableRefObject<(() => void) | null>;
}

interface ShotEditorUiProps {
  /** Disable actions that have no Astrid document-native equivalent. */
  readOnly?: boolean;
  /** Render only the document-native shell when a canonical shot editor owns the timeline. */
  canonicalOnly?: boolean;
  /** Whether the floating sticky header is visible (hide main header when true) */
  isSticky?: boolean;
  variantName?: string;
  onVariantNameChange?: (name: string) => void;
  isGeneratingVideo?: boolean;
  videoJustQueued?: boolean;
  /** Suppress query refetches during drag operations */
  onDragStateChange?: (isDragging: boolean) => void;
}

export type ShotEditorProps = ShotEditorCoreProps &
  ShotEditorCallbackProps &
  ShotEditorDimensionProps &
  ShotEditorNavigationProps &
  ShotEditorCacheProps &
  ShotEditorRefsProps &
  ShotEditorUiProps;

export interface ShotEditorState {
  isUploadingImage: boolean;
  uploadProgress: number;
  fileInputKey: number;
  deletingVideoId: string | null;
  pendingFramePositions: Map<string, number>;
  creatingTaskId: string | null;
  isSettingsModalOpen: boolean;
  isModeReady: boolean;
  settingsError: string | null;
  isEditingName: boolean;
  editingName: string;
  isTransitioningFromNameEdit: boolean;
  showStepsNotification: boolean;
  hasInitializedShot: string | null;
  hasInitializedUISettings: string | null;
  autoAdjustedAspectRatio: {
    previousAspectRatio: string | null;
    adjustedTo: string;
  } | null;
}

export type ShotEditorAction =
  | { type: 'SET_UPLOADING_IMAGE'; payload: boolean }
  | { type: 'SET_UPLOAD_PROGRESS'; payload: number }
  | { type: 'SET_FILE_INPUT_KEY'; payload: number }
  | { type: 'SET_DELETING_VIDEO_ID'; payload: string | null }
  | { type: 'SET_PENDING_FRAME_POSITIONS'; payload: Map<string, number> }
  | { type: 'SET_CREATING_TASK_ID'; payload: string | null }
  | { type: 'SET_SETTINGS_MODAL_OPEN'; payload: boolean }
  | { type: 'SET_MODE_READY'; payload: boolean }
  | { type: 'SET_SETTINGS_ERROR'; payload: string | null }
  | { type: 'SET_EDITING_NAME'; payload: boolean }
  | { type: 'SET_EDITING_NAME_VALUE'; payload: string }
  | { type: 'SET_TRANSITIONING_FROM_NAME_EDIT'; payload: boolean }
  | { type: 'SET_SHOW_STEPS_NOTIFICATION'; payload: boolean }
  | { type: 'SET_HAS_INITIALIZED_SHOT'; payload: string | null }
  | { type: 'SET_HAS_INITIALIZED_UI_SETTINGS'; payload: string | null }
  | {
    type: 'SET_AUTO_ADJUSTED_ASPECT_RATIO';
    payload: {
      previousAspectRatio: string | null;
      adjustedTo: string;
    } | null;
  };
