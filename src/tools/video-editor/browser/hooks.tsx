import type { VideoEditorInstanceScope } from './scopedServices.ts';
import { shallow } from 'zustand/shallow';
import type { AssetRegistryEntry, AssetRegistry, TimelineConfig, ResolvedTimelineConfig } from '@/tools/video-editor/index.ts';
import {
  applySequenceDraftToTimeline,
  type ApplySequenceDraftToTimelineOptions,
  type ApplySequenceDraftToTimelineResult,
  type ValidatedSequenceDraft,
} from '@/tools/video-editor/sequence.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import {
  useTimelineChromeSelector,
  useTimelineDataSelector,
  useTimelineOpsSelector,
  useTimelinePlaybackSelector,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import type {
  VideoEditorAssetResolver,
  VideoEditorExporter,
  VideoEditorHostContext,
} from '@/tools/video-editor/lib/browser-runtime.ts';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';

export type VideoEditorSaveStatus = 'loading' | 'saved' | 'saving' | 'dirty' | 'retrying' | 'error';
export type VideoEditorRenderStatus = 'idle' | 'rendering' | 'done' | 'error';

export interface VideoEditorHost {
  scope: Readonly<VideoEditorInstanceScope> | null;
  timelineId: string;
  timelineName: string | null;
  userId: string | null;
  provider: DataProvider;
  assetResolver: VideoEditorAssetResolver | null;
  exporter: VideoEditorExporter | null;
  hostContext: VideoEditorHostContext | null;
  resolveAssetUrl: (file: string) => Promise<string>;
}

export interface VideoEditorTimelineState {
  timelineId: string;
  timelineName: string | null;
  userId: string | null;
  isLoading: boolean;
  configVersion: number | null;
  config: TimelineConfig | null;
  resolvedConfig: ResolvedTimelineConfig | null;
  registry: AssetRegistry | null;
  selectedClipId: string | null;
  selectedClipIds: string[];
  selectedTrackId: string | null;
  currentTime: number;
  saveStatus: VideoEditorSaveStatus;
  renderStatus: VideoEditorRenderStatus;
  canUndo: boolean;
  canRedo: boolean;
}

export interface VideoEditorReplaceTimelineConfigOptions {
  selectedClipId?: string | null;
  selectedTrackId?: string | null;
  semantic?: boolean;
}

export interface VideoEditorCommands {
  selectClip: (clipId: string) => void;
  replaceSelection: (clipIds: Iterable<string>) => void;
  addToSelection: (clipIds: Iterable<string>) => void;
  clearSelection: () => void;
  setSelectedTrackId: (trackId: string | null) => void;
  seek: (time: number) => void;
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  undo: () => void;
  redo: () => void;
  reloadFromServer: () => Promise<void>;
  startRender: () => Promise<void>;
  registerAsset: (assetId: string, entry: AssetRegistryEntry) => Promise<void>;
  replaceTimelineConfig: (
    nextConfig: TimelineConfig,
    options?: VideoEditorReplaceTimelineConfigOptions,
  ) => boolean;
  updateTimelineConfig: (
    updater: (currentConfig: TimelineConfig) => TimelineConfig,
    options?: VideoEditorReplaceTimelineConfigOptions,
  ) => boolean;
  applySequenceDraft: (
    draft: ValidatedSequenceDraft,
    options?: ApplySequenceDraftToTimelineOptions,
  ) => Promise<ApplySequenceDraftToTimelineResult>;
}

function resolveCommandConfig(
  config: TimelineConfig,
  current: import('@/tools/video-editor/lib/timeline-data.ts').TimelineData,
): ResolvedTimelineConfig {
  const registry = current.resolvedConfig.registry;
  return {
    output: config.output,
    tracks: config.tracks ?? [],
    clips: config.clips.map((clip) => ({
      ...clip,
      assetEntry: clip.asset ? registry[clip.asset] : undefined,
    })),
    registry,
    ...(config.theme !== undefined ? { theme: config.theme } : {}),
    ...(config.theme_overrides !== undefined ? { theme_overrides: config.theme_overrides } : {}),
    ...(config.generation_defaults !== undefined ? { generation_defaults: config.generation_defaults } : {}),
    ...(config.app !== undefined ? { app: config.app } : {}),
  };
}

/**
 * @publicContract
 * Browser-only runtime services that back the standalone editor shell.
 */
export function useVideoEditorHost(): VideoEditorHost {
  const runtime = useVideoEditorRuntime();

  return {
    scope: runtime.instanceScope ?? null,
    timelineId: runtime.timelineId,
    timelineName: runtime.timelineName ?? null,
    userId: runtime.userId,
    provider: runtime.provider,
    assetResolver: runtime.assetResolver ?? null,
    exporter: runtime.exporter ?? null,
    hostContext: runtime.hostContext ?? null,
    resolveAssetUrl: async (file: string) => {
      if (runtime.assetResolver) {
        return await runtime.assetResolver.resolveAssetUrl(file);
      }

      return await runtime.provider.resolveAssetUrl(file);
    },
  };
}

/**
 * @publicContract
 * Supported read-only timeline view for custom browser shells and panels.
 */
export function useVideoEditorTimeline(): VideoEditorTimelineState {
  const runtime = useVideoEditorRuntime();
  const data = useTimelineDataSelector((state) => ({
    isLoading: state.isLoading,
    configVersion: state.data?.configVersion ?? null,
    config: state.data?.config ?? null,
    resolvedConfig: state.data?.resolvedConfig ?? null,
    registry: state.data?.registry ?? null,
    selectedClipId: state.selectedClipId,
    selectedClipIds: [...state.selectedClipIds],
    selectedTrackId: state.selectedTrackId,
  }), shallow);
  const chrome = useTimelineChromeSelector((state) => ({
    saveStatus: state.saveStatus as VideoEditorSaveStatus,
    renderStatus: state.renderStatus as VideoEditorRenderStatus,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
  }), shallow);
  const currentTime = useTimelinePlaybackSelector((state) => state.currentTime);

  return {
    timelineId: runtime.timelineId,
    timelineName: runtime.timelineName ?? null,
    userId: runtime.userId,
    currentTime,
    ...data,
    ...chrome,
  };
}

/**
 * @publicContract
 * Supported browser command facade for selection, playback, config edits,
 * and trusted sequence insertion without internal imports.
 */
export function useVideoEditorCommands(): VideoEditorCommands {
  const runtime = useVideoEditorRuntime();
  const data = useTimelineDataSelector((state) => ({
    current: state.data,
    selectedClipId: state.selectedClipId,
    selectedClipIds: [...state.selectedClipIds],
    selectedTrackId: state.selectedTrackId,
  }), shallow);
  const ops = useTimelineOpsSelector((state) => ({
    selectClip: state.selectClip,
    selectClips: state.selectClips,
    addToSelection: state.addToSelection,
    clearSelection: state.clearSelection,
    setSelectedTrackId: state.setSelectedTrackId,
    applyEdit: state.applyEdit,
    registerAsset: state.registerAsset,
  }), shallow);
  const chrome = useTimelineChromeSelector((state) => ({
    undo: state.undo,
    redo: state.redo,
    reloadFromServer: state.reloadFromServer,
    startRender: state.startRender,
  }), shallow);
  const previewRef = useTimelinePlaybackSelector((state) => state.previewRef);
  const currentTime = useTimelinePlaybackSelector((state) => state.currentTime);

  const replaceTimelineConfig: VideoEditorCommands['replaceTimelineConfig'] = (nextConfig, options) => {
    if (!data.current) {
      return false;
    }

    ops.applyEdit(
      { type: 'config', resolvedConfig: resolveCommandConfig(nextConfig, data.current) },
      {
        selectedClipId: options?.selectedClipId ?? data.selectedClipId,
        selectedTrackId: options?.selectedTrackId ?? data.selectedTrackId,
        semantic: options?.semantic,
      },
    );
    return true;
  };

  return {
    selectClip: (clipId) => {
      ops.selectClip(clipId);
    },
    replaceSelection: (clipIds) => {
      ops.selectClips([...clipIds]);
    },
    addToSelection: (clipIds) => {
      ops.addToSelection([...clipIds]);
    },
    clearSelection: () => {
      ops.clearSelection();
    },
    setSelectedTrackId: (trackId) => {
      ops.setSelectedTrackId(trackId);
    },
    seek: (time) => {
      previewRef.current?.seek(Math.max(0, time));
    },
    play: () => {
      previewRef.current?.play();
    },
    pause: () => {
      previewRef.current?.pause();
    },
    togglePlayPause: () => {
      previewRef.current?.togglePlayPause();
    },
    undo: chrome.undo,
    redo: chrome.redo,
    reloadFromServer: chrome.reloadFromServer,
    startRender: chrome.startRender,
    registerAsset: async (assetId, entry) => {
      await ops.registerAsset(assetId, entry);
    },
    replaceTimelineConfig,
    updateTimelineConfig: (updater, options) => {
      if (!data.current) {
        return false;
      }

      const nextConfig = updater(data.current.config);
      return replaceTimelineConfig(nextConfig, options);
    },
    applySequenceDraft: async (draft, options) => {
      if (!data.current) {
        throw new Error('useVideoEditorCommands.applySequenceDraft requires a loaded timeline.');
      }

      const sequenceOptions = options?.mode === 'replace'
        ? {
            mode: 'replace' as const,
            selectedClipId: options.selectedClipId ?? data.selectedClipId ?? undefined,
            selectedClipIds: options.selectedClipIds ?? data.selectedClipIds,
          }
        : {
            mode: 'insert' as const,
            at: options?.at ?? currentTime,
            selectedClipId: data.selectedClipId ?? undefined,
            selectedClipIds: data.selectedClipIds,
            selectedTrackId: options?.selectedTrackId ?? data.selectedTrackId,
          };
      const result = await applySequenceDraftToTimeline(
        data.current.config,
        data.current.registry,
        draft,
        sequenceOptions,
      );

      if (result.ok) {
        ops.applyEdit(
          { type: 'config', resolvedConfig: resolveCommandConfig(result.config, data.current) },
          {
            selectedClipId: result.clipId,
            selectedTrackId: result.selectedTrackId ?? data.selectedTrackId,
            semantic: true,
          },
        );
      }

      return result;
    },
  };
}
