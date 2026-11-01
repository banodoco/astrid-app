import { memo, useCallback, useMemo, useRef } from 'react';
import AssetPanel from '@/tools/video-editor/components/PropertiesPanel/AssetPanel.tsx';
import {
  useTimelineEditorData,
  useTimelineEditorOps,
  useTimelineStoreApiSafe,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import {
  useVideoEditorAssetPanels,
  useVideoEditorPanelRegistry,
} from '@/tools/video-editor/runtime/useVideoEditorRenderContext.ts';
import { useOptionalVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import type { ContributionErrorInfo } from '@/tools/video-editor/runtime/ContributionErrorBoundary.tsx';
import { findContributionOwnerId } from '@/tools/video-editor/runtime/extensionSurface.ts';
import { ExtensionPanelHost, getPanelKey } from '@/tools/video-editor/runtime/ExtensionPanelHost';
import { bindTranscriptPanelVideo } from '@/tools/video-editor/lib/transcript-panel-binding.ts';
import { playedAssetRegistry, playedShotComposition } from '@/tools/video-editor/lib/timeline-shot-summaries.ts';
import type { PanelRenderProps, PanelVideoAdapter } from '@astrid/editor-sdk';
import { useOptionalClipTypeRegistryContext } from '@/tools/video-editor/clip-types/ClipTypeRegistryContext.tsx';
import { createPanelClipDragSource } from '@/tools/video-editor/lib/panel-clip-drag.ts';
import { TimelineFramePreview, usePanelFramePreview } from '../PreviewPanel/TimelineFramePreview.tsx';
import { useVideoEditorPreviewComposition } from '../PreviewPanel/useVideoEditorPreviewComposition.ts';

export interface VideoEditorAssetPanelSurfaceProps {
  includeBuiltIn?: boolean;
  /** Controlled visibility seam; selection UI/preferences belong to the shell. */
  activePanelKey?: string | null;
  video?: PanelVideoAdapter;
  settingsByPanelKey?: Readonly<Record<string, PanelRenderProps['settings']>>;
  /** Controlled full-screen seam: the one panel shown full screen. */
  fullscreenPanelKey?: string | null;
  /** Supplying this offers `fullscreen` to panels. */
  onFullscreenPanelKeyChange?: (key: string | null) => void;
}

function VideoEditorAssetPanelSurfaceComponent({
  includeBuiltIn = true,
  activePanelKey,
  video,
  settingsByPanelKey,
  fullscreenPanelKey,
  onFullscreenPanelKeyChange,
}: VideoEditorAssetPanelSurfaceProps) {
  const runtime = useOptionalVideoEditorRuntime();
  const store = useTimelineStoreApiSafe();
  const view = runtime?.timelineViewStore;
  const { data, preferences, resolvedConfig } = useTimelineEditorData();
  const previewComposition = useVideoEditorPreviewComposition(resolvedConfig);
  const framePreview = usePanelFramePreview();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const latestRuntime = useRef(runtime);
  latestRuntime.current = runtime;
  const { setAssetPanelState, uploadFiles, transcriptHost } = useTimelineEditorOps();
  const panelVideo = useMemo(() => {
    // Rebuild the adapter when the host instance is replaced; TranscriptPanel
    // reruns project-source lookups when its adapter identity changes.
    void transcriptHost;
    const base = video ?? (store && view ? {
      view,
      seek: (seconds: number) => { store.getState().ops.onClickTimeArea(seconds); },
    } : undefined);
    return base && store ? bindTranscriptPanelVideo(store, {
      ...base,
      preview: base.preview ?? framePreview.preview,
      select: base.select ?? ((clipIds: readonly string[]) => { store.getState().ops.selectClips([...clipIds]); }),
    }, () => playedAssetRegistry(
      playedShotComposition(latestRuntime.current?.userId, latestRuntime.current?.shots),
      store.getState().data.data?.resolvedConfig,
    )) : base;
  }, [video, store, view, framePreview.preview, transcriptHost]);
  const clipTypeRegistry = useOptionalClipTypeRegistryContext()?.registry;
  // Each extension's panels get a drag source bound to that extension: it can only offer clip types
  // the extension owns, and only where the editor has a timeline to drop on.
  const bindVideo = useCallback((adapter: PanelVideoAdapter, extensionId: string): PanelVideoAdapter => (
    clipTypeRegistry && store
      ? { ...adapter, dragSource: createPanelClipDragSource(extensionId, { ownerOf: (clipType) => clipTypeRegistry.resolve(clipType)?.ownerExtensionId }) }
      : adapter
  ), [clipTypeRegistry, store]);
  const contributionIndex = runtime?.extensionRuntime?.contributionIndex;
  const assetPanels = useVideoEditorAssetPanels();
  const panelRegistry = useVideoEditorPanelRegistry();
  const panels = panelRegistry.panels
    .filter((panel) => typeof panel.render === 'function')
    .map((panel) => ({
      ...panel,
      extensionId: panel.extensionId ?? findContributionOwnerId(contributionIndex, 'panel', panel.id),
    }));
  const visiblePanelKeys = new Set(assetPanels
    .map((panel) => getPanelKey({
      ...panel,
      extensionId: panel.extensionId ?? findContributionOwnerId(contributionIndex, 'panel', panel.id),
    }))
    .filter((key) => activePanelKey === undefined || key === activePanelKey));

  const builtInPanel = includeBuiltIn && data ? (
    <div className="rounded-xl border border-border bg-card/80 p-3">
      <AssetPanel
        assetMap={data.assetMap}
        rows={data.rows}
        meta={data.meta}
        backgroundAsset={data.output.background ?? undefined}
        showAll={preferences.assetPanel.showAll}
        showHidden={preferences.assetPanel.showHidden}
        hidden={preferences.assetPanel.hidden}
        setPanelState={setAssetPanelState}
        onUploadFiles={uploadFiles}
        registry={data.registry.assets}
      />
    </div>
  ) : null;

  if (!builtInPanel && panels.length === 0) {
    return null;
  }

  const handleContributionError = (info: ContributionErrorInfo) => {
    if (typeof console !== 'undefined') {
      console.warn(
        '[VideoEditorAssetPanelSurface] Panel error captured by boundary:',
        info,
      );
    }
  };

  return (
    <div ref={surfaceRef} className="flex h-full min-h-0 flex-col">
      {builtInPanel}
      <ExtensionPanelHost panels={panels} visiblePanelKeys={visiblePanelKeys} video={panelVideo} bindVideo={bindVideo} settingsByPanelKey={settingsByPanelKey} fullscreenPanelKey={fullscreenPanelKey} onFullscreenPanelKeyChange={onFullscreenPanelKeyChange} onError={handleContributionError} />
      <TimelineFramePreview config={previewComposition.config} request={framePreview.request} bounds={surfaceRef} />
    </div>
  );
}

export const VideoEditorAssetPanelSurface = memo(VideoEditorAssetPanelSurfaceComponent);
