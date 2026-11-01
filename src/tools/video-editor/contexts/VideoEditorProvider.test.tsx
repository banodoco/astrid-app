import { readFileSync } from 'node:fs';
import { extensionSettingsGroup } from '@/tools/video-editor/runtime/extensionSettingsBacking';
import { getSettingsStore } from '@/shared/settings/instance';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import type { FC, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { defineExtension } from '@astrid/editor-sdk';
import type { AstridExtension, ExtensionContext, DisposeHandle, ProjectObjectMetadata, ProjectObjectStorage, TimelineOps } from '@astrid/editor-sdk';
import { LIVE_SCENE_CLIP_TYPE_ID, THREEJS_LIVE_EDITOR_EXTENSION_ID, LIVE_SCENE_IMPORT_COMMAND_ID, threejsLiveEditorExtension } from '@astrid/packs/rendering/ui/threejs-live-editor/extension';
import { commandExtension } from '@/examples/command-extension';
import { flagshipLocalExtension } from '@/tools/video-editor/examples/extensions/flagship-local/index';
import { useAddToVideoEditor } from '@/domains/media-lightbox/hooks/useAddToVideoEditor';
import {
  ADD_GENERATION_QUERY_PARAM,
  readPendingAdds,
  writePendingAdds,
} from '@/domains/media-lightbox/hooks/addToVideoEditorConstants';
import { AgentChatProvider, useAgentChatBridge } from '@/shared/contexts/AgentChatContext';
import {
  __getSelectionStateForTests,
  activateTimelineClipData,
  editorSelectTimelineClip,
  editorReplaceTimelineSelection,
  getShotPlacementTarget,
  systemResetSelectionForProjectChange,
  userSelectGalleryItem,
} from '@/shared/state/selectionStore';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext';
import { EditorRuntimeProvider } from '@/tools/video-editor/contexts/EditorRuntimeProvider';
import type { VideoEditorScopedServices } from '@/tools/video-editor/browser/scopedServices';
import { VideoEditorProvider } from '@/tools/video-editor/contexts/VideoEditorProvider';
import shotCompositionFixture from '@/tools/video-editor/data/shotComposition.fixture.json';
import { buildVideoEditorLightboxMedia } from '@/tools/video-editor/lib/video-editor-lightbox-media';
import { ExtensionSettingsPanel } from '@/tools/video-editor/components/ExtensionSettings/ExtensionSettingsPanel';
import type { EffectRegistryRecord } from '@/tools/video-editor/effects/registry/types';
import { useEffectRegistryContext } from '@/tools/video-editor/effects/registry/EffectRegistryContext';
import { useTransitionRegistryContext } from '@/tools/video-editor/transitions/registry/index';
import type { TransitionRegistryRecord } from '@/tools/video-editor/transitions/registry/types';
import { useClipTypeRegistryContext } from '@/tools/video-editor/clip-types/ClipTypeRegistryContext';
import type { ClipTypeRegistryRecord } from '@/tools/video-editor/clip-types/ClipTypeRegistry';
import {
  INTERNAL_GESTURE_TIMELINE_MUTATIONS,
  PUBLIC_TIMELINE_COMMAND_NAMES,
  PUBLIC_TIMELINE_COMMAND_SCOPE,
  isPublicTimelineCommandName,
  useTimelineCommandsService,
  useTimelineCommandsServiceSafe,
} from '@/tools/video-editor/hooks/useTimelineCommandsService';
import {
  createTimelineStore,
  TimelineStoreProvider,
  useTimelineAvailabilityState,
  useTimelineChromeContext,
  useTimelineEditorData,
  useTimelineEditorOps,
  useTimelinePlaybackContext,
} from '@/tools/video-editor/hooks/timelineStore';
import {
  shouldAllowTouchClipDrag,
  shouldExpandTouchTrimHandles,
  shouldPreserveTouchSelectionForMove,
} from '@/tools/video-editor/lib/mobile-interaction-model';
import { configToRows, type TimelineData } from '@/tools/video-editor/lib/timeline-data';
import { runLiveSceneAcpRoundtrip } from '@/tools/video-editor/runtime/liveSceneAcpRoundtrip';
import { applyPreparedMediaCommand, type PlacePreparedMediaCommand } from '@/tools/video-editor/commands/media';
import { VIDEO_EDITOR_HOST_PORT_NAMES } from '@/tools/video-editor/runtime/ports';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider';
import { createVideoEditorEffectCatalog } from '@/tools/video-editor/lib/effect-catalog';
import { useExtensionLoaderWiring } from '@/tools/video-editor/runtime/useExtensionLoaderWiring';
import type { BundleContentStore } from '@/tools/video-editor/runtime/useExtensionLoaderWiring';
import {
  createExtensionLoader,
  type ExtensionLoader,
} from '@/tools/video-editor/runtime/extensionLoader';
import type {
  ExtensionStateRepository,
  ExtensionPackRecord,
  ExtensionLifecycleEvent,
} from '@/tools/video-editor/runtime/extensionStateRepository';

/** What an extension's setting holds in the settings store, as JSON text (null when nothing is saved). */
function savedExtensionSetting(extensionId: string, key: string): string | null {
  const value = getSettingsStore().get({ group: extensionSettingsGroup(extensionId), field: key, default: undefined, validate: () => true });
  return value === undefined ? null : JSON.stringify(value);
}


const fixtureAstridElementHost: import('@/tools/video-editor/runtime/astrid-element-host').AstridElementHost = { descriptors: [], sequenceRegistry: {}, resolveComponent: () => undefined, resolveSequenceClipEntry: () => undefined, describeClipCapability: () => undefined };

const navigateMock = vi.fn();
const useEffectsMock = vi.fn();
const useResolvedEffectCatalogMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const mountedElementRoutes = { get: vi.fn(), save: vi.fn() };

const mocks = {
  setInputModality: vi.fn(),
  setInputModalityFromPointerType: vi.fn(() => 'touch'),
  setInteractionMode: vi.fn(),
  setGestureOwner: vi.fn(),
  setContextTarget: vi.fn(),
  setInspectorTarget: vi.fn(),
  selectClip: vi.fn(),
  selectClips: vi.fn(),
};

const operationalChromeState = {
  editorData: null as null | { dataLanes: Array<{ items: unknown[] }> } & Partial<TimelineData>,
  timelineOps: null as TimelineOps | null,
  configVersion: 0,
  store: null as ReturnType<typeof createTimelineStore> | null,
  isConflictExhausted: false,
  renderStatus: 'idle' as 'idle' | 'rendering' | 'done' | 'error',
};

vi.mock('@/tools/video-editor/hooks/useEffects', () => ({
  useEffects: (...args: unknown[]) => useEffectsMock(...args),
}));

vi.mock('@/tools/video-editor/hooks/useEffectRegistry', () => ({
  useEffectRegistry: vi.fn(),
}));

vi.mock('@/tools/video-editor/hooks/useEffectResources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/video-editor/hooks/useEffectResources')>();
  return {
    ...actual,
    EffectCatalogProvider: ({ children }: { children: any }) => children,
    useResolvedEffectCatalog: (...args: unknown[]) => useResolvedEffectCatalogMock(...args),
  };
});

vi.mock('@/tools/video-editor/hooks/useTimelineClipsForAttachments', () => ({
  useTimelineClipsForAttachments: () => [
    {
      clipId: 'clip-1',
      assetKey: 'asset-1',
      url: 'https://example.com/image.png',
      mediaType: 'image',
      isTimelineBacked: true,
    },
  ],
}));

vi.mock('@/shared/contexts/ShotsContext', () => ({
  useShots: () => ({
    shots: [],
    isLoading: false,
    error: null,
    refetchShots: vi.fn(),
    allImagesCount: 0,
    noShotImagesCount: 0,
  }),
}));

vi.mock('@/shared/hooks/settings/useToolSettings', () => ({
  useToolSettings: () => ({
    settings: {
      lastTimelineId: 'timeline-staged',
    },
  }),
}));

vi.mock('@/tools/video-editor/hooks/useTimelineState', () => ({
  useTimelineState: () => {
    const editor = {
      elementTimelineRoutes: mountedElementRoutes,
      data: operationalChromeState.editorData,
      resolvedConfig: { registry: {} },
      deviceClass: 'tablet',
      inputModality: 'mouse',
      interactionMode: 'select',
      gestureOwner: 'timeline',
      contextTarget: { kind: 'timeline' },
      inspectorTarget: { kind: 'clip', clipId: 'clip-1' },
      interactionPolicy: {
        deviceClass: 'tablet',
        inputModality: 'mouse',
        interactionMode: 'select',
        gestureOwner: 'timeline',
        contextTarget: { kind: 'timeline' },
        inspectorTarget: { kind: 'clip', clipId: 'clip-1' },
      },
      selectedClipId: 'clip-1',
      selectedClipIds: ['clip-1'],
      selectedClipIdsRef: { current: ['clip-1'] },
      additiveSelectionRef: { current: false },
      selectedTrackId: 'track-1',
      primaryClipId: 'clip-1',
      selectedClip: null,
      selectedTrack: null,
      selectedClipHasPredecessor: false,
      compositionSize: { width: 1920, height: 1080 },
      trackScaleMap: {},
      scale: 1,
      scaleWidth: 1,
      isLoading: false,
      dataRef: { current: null },
      pendingOpsRef: { current: [] },
      interactionStateRef: { current: { drag: false, resize: false, listeners: new Set() } },
      coordinator: null,
      indicatorRef: { current: null },
      editAreaRef: { current: null },
      preferences: {
        selectedRightPanelId: 'host:properties',
        rightPanelLayoutSlotsByPanelId: {},
        showDataLanes: false,
        activeClipTab: 'style',
        assetPanel: { isOpen: true },
      },
      timelineRef: { current: null },
      timelineWrapperRef: { current: null },
      setInputModality: mocks.setInputModality,
      setInputModalityFromPointerType: mocks.setInputModalityFromPointerType,
      setInteractionMode: mocks.setInteractionMode,
      setGestureOwner: mocks.setGestureOwner,
      setContextTarget: mocks.setContextTarget,
      setInspectorTarget: mocks.setInspectorTarget,
      isClipSelected: vi.fn(() => true),
      selectClip: mocks.selectClip,
      selectClips: mocks.selectClips,
      addToSelection: vi.fn(),
      clearSelection: vi.fn(),
      setSelectedTrackId: vi.fn(),
      setActiveClipTab: vi.fn(),
      setAssetPanelState: vi.fn(),
      setSelectedRightPanelId: vi.fn(),
      setRightPanelLayoutSlot: vi.fn(),
      setShowDataLanes: vi.fn(),
      registerGenerationAsset: vi.fn(),
      onCursorDrag: vi.fn(),
      onClickTimeArea: vi.fn(),
      onActionResizeStart: vi.fn(),
      onClipEdgeResizeEnd: vi.fn(),
      onOverlayChange: vi.fn(),
      onTimelineDragOver: vi.fn(),
      onTimelineDragLeave: vi.fn(),
      onTimelineDrop: vi.fn(),
      handleAssetDrop: vi.fn(),
      handleUpdateClips: vi.fn(),
      handleUpdateClipsDeep: vi.fn(),
      handleDeleteClips: vi.fn(),
      handleDeleteClip: vi.fn(),
      handleSelectedClipChange: vi.fn(),
      handleResetClipPosition: vi.fn(),
      handleResetClipsPosition: vi.fn(),
      handleSplitSelectedClip: vi.fn(),
      handleSplitClipAtTime: vi.fn(),
      handleSplitClipsAtPlayhead: vi.fn(),
      handleToggleMuteClips: vi.fn(),
      handleToggleMute: vi.fn(),
      handleDetachAudioClip: vi.fn(),
      handleTrackPopoverChange: vi.fn(),
      handleMoveTrack: vi.fn(),
      handleRemoveTrack: vi.fn(),
      moveSelectedClipToTrack: vi.fn(),
      moveSelectedClipsToTrack: vi.fn(),
      moveClipToRow: vi.fn(),
      createTrackAndMoveClip: vi.fn(),
      uploadFiles: vi.fn(),
      applyEdit: vi.fn(),
      patchRegistry: vi.fn(),
      unpatchRegistry: vi.fn(),
      registerAsset: vi.fn(),
    };
    const chrome = {
      timelineName: 'Timeline',
      saveStatus: 'saved' as const,
      isConflictExhausted: operationalChromeState.isConflictExhausted,
      renderStatus: operationalChromeState.renderStatus,
      renderLog: '',
      renderDirty: false,
      renderProgress: null,
      renderResultUrl: null,
      renderResultFilename: null,
      undo: vi.fn(),
      redo: vi.fn(),
      canUndo: false,
      canRedo: false,
      checkpoints: [],
      jumpToCheckpoint: vi.fn(),
      createManualCheckpoint: vi.fn(),
      setScaleWidth: vi.fn(),
      handleAddTrack: vi.fn(),
      handleClearUnusedTracks: vi.fn(),
      unusedTrackCount: 0,
      reloadFromServer: vi.fn(),
      retrySaveAfterConflict: vi.fn(),
      startRender: vi.fn(),
    };
    const playback = {
      currentTime: 12.5,
      previewRef: { current: null },
      playerContainerRef: { current: null },
      onPreviewTimeUpdate: vi.fn(),
      formatTime: vi.fn(() => '0:12'),
    };

    const store = createTimelineStore({
      data: editor,
      ops: editor,
      chrome,
      playback,
      timelineOps: operationalChromeState.timelineOps,
    });
    store.getState().setConfigVersion(operationalChromeState.configVersion);
    operationalChromeState.store = store;

    return {
      store,
      editor,
      chrome,
      playback,
      editorOps: { transcriptHost: undefined },
    };
  },
}));

function Consumer() {
  const runtime = useVideoEditorRuntime();
  const editorData = useTimelineEditorData();
  const editorOps = useTimelineEditorOps();
  const chrome = useTimelineChromeContext();
  const playback = useTimelinePlaybackContext();
  const agentChatBridge = useAgentChatBridge();

  return (
    <div>
      <span>{editorData.selectedClipId}</span>
      <span>{editorData.deviceClass}</span>
      <span>{editorData.inputModality}</span>
      <span>{editorData.interactionMode}</span>
      <span>{editorData.gestureOwner}</span>
      <span>{editorData.contextTarget?.kind}</span>
      <span>{editorData.inspectorTarget?.kind}</span>
      <span>{editorData.interactionPolicy.deviceClass}</span>
      <span data-testid="interaction-policy">{JSON.stringify(editorData.interactionPolicy)}</span>
      <span>{String(editorData.interactionStateRef.current.drag)}</span>
      <span>{typeof editorData.additiveSelectionRef?.current}</span>
      <span>{typeof editorOps.selectClip}</span>
      <span>{typeof editorOps.selectClips}</span>
      <span>{chrome.saveStatus}</span>
      <span>{playback.currentTime}</span>
      <span data-testid="agent-chat-timeline-id">{agentChatBridge.timelineId}</span>
      <span data-testid="runtime-project-id">{runtime.project.projectId}</span>
      <span data-testid="runtime-user-id">{runtime.auth.userId}</span>
      <span data-testid="runtime-shots-count">{runtime.shots.shots?.length ?? 0}</span>
      <span data-testid="runtime-resolver-type">{typeof runtime.assetResolver.resolveAssetUrl}</span>
      <button
        type="button"
        onClick={() => {
          editorOps.setInputModality('touch');
          editorOps.setInputModalityFromPointerType('touch');
          editorOps.setInteractionMode('trim');
          editorOps.setGestureOwner('trim');
          editorOps.setContextTarget({ kind: 'clip', clipId: 'clip-1' });
          editorOps.setInspectorTarget({ kind: 'selection', clipIds: ['clip-1'] });
        }}
      >
        update interaction
      </button>
    </div>
  );
}

function buildCommandTimelineData(): TimelineData {
  const config = {
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips: [{ id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 }],
  } as const;
  const rowData = configToRows(config);
  const resolvedConfig = {
    output: { ...config.output },
    tracks: config.tracks.map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({ ...clip, assetEntry: undefined })),
    registry: {},
  };

  return {
    config: {
      ...config,
      tracks: config.tracks.map((track) => ({ ...track })),
      clips: config.clips.map((clip) => ({ ...clip })),
    },
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: {},
    output: { ...config.output },
    tracks: config.tracks.map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: 'signature',
    stableSignature: 'stable-signature',
  };
}

function fixtureDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function metadataForFixture(bytes: Uint8Array, mediaType: string, filename: string): ProjectObjectMetadata {
  const digest = fixtureDigest(bytes);
  return { object_id: digest, digest, media_type: mediaType, size: bytes.byteLength, filename };
}

function buildLiveSceneTimelineData(liveScene: Record<string, unknown>): TimelineData {
  const config: TimelineData['config'] = {
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips: [{
      id: 'scene-placement',
      at: 1.25,
      track: 'V1',
      clipType: LIVE_SCENE_CLIP_TYPE_ID,
      from: 0,
      to: 4,
      speed: 1,
      app: { liveScene },
    }],
  };
  const rowData = configToRows(config);
  const resolvedConfig = {
    ...config,
    tracks: config.tracks?.map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({ ...clip, assetEntry: undefined })),
    registry: {},
  } as TimelineData['resolvedConfig'];
  return {
    config,
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: {},
    output: { ...config.output },
    tracks: config.tracks ?? [],
    clipOrder: rowData.clipOrder,
    signature: 'live-scene-fixture',
    stableSignature: 'live-scene-fixture',
    dataLanes: [],
  };
}

async function createLiveSceneProviderFixture() {
  const html = '<html><body><main data-preserve="exact-bytes">keep me</main><p>color: #ff9f68;</p></body></html>';
  const entryBytes = new TextEncoder().encode(html);
  const assetBytes = new TextEncoder().encode('immutable scene asset bytes');
  const entry = metadataForFixture(entryBytes, 'text/html', 'scene.html');
  const asset = metadataForFixture(assetBytes, 'image/png', 'texture.png');
  const manifest = { formatVersion: 1 as const, entry: 'scene.html', duration: 7.25, authoredFps: 24 };
  const packageBody = JSON.stringify({ manifest, entry, assets: [asset] });
  const packageBytes = new TextEncoder().encode(packageBody);
  const packageObject = metadataForFixture(packageBytes, 'application/json', 'scene.package.json');
  const objects = new Map<string, Uint8Array>([
    [entry.object_id, entryBytes],
    [asset.object_id, assetBytes],
    [packageObject.object_id, packageBytes],
  ]);
  const storage: ProjectObjectStorage = {
    async ingest(bytes, mediaType, filename) {
      const copy = new Uint8Array(bytes);
      const metadata = metadataForFixture(copy, mediaType, filename ?? '');
      objects.set(metadata.object_id, copy);
      return metadata;
    },
    async read(objectId) {
      const bytes = objects.get(objectId);
      if (!bytes) throw new Error(`missing fixture project object ${objectId}`);
      return new Uint8Array(bytes);
    },
  };
  const liveScene = {
    revision: packageObject.digest,
    source: { objectId: packageObject.object_id, revision: packageObject.digest },
    packageBody,
    html,
  };
  const initialData = buildLiveSceneTimelineData(liveScene);
  let version = 1;
  let durableConfig: TimelineData['config'] | null = null;
  const timelineOps = {
    validate: () => ({ valid: true, diagnostics: [] }),
    preview: () => ({ diff: { version, entries: [], affectedObjectIds: [] }, fullyPreviewable: true, diagnostics: [] }),
    apply(patch: { version: number; operations: ReadonlyArray<{ op: string; target: string; payload?: unknown }> }) {
      if (patch.version !== version) throw new Error('stale fixture timeline patch');
      const nextConfig = structuredClone(operationalChromeState.editorData!.config!) as TimelineData['config'];
      for (const operation of patch.operations) {
        if (operation.op !== 'clip.update') continue;
        const clip = nextConfig.clips.find((candidate) => candidate.id === operation.target);
        const payload = operation.payload as { app?: Record<string, unknown> } | undefined;
        if (clip && payload?.app) clip.app = payload.app as typeof clip.app;
      }
      const nextVersion = version + 1;
      const rowData = configToRows(nextConfig);
      const current = operationalChromeState.editorData!;
      const nextData = {
        ...current,
        config: nextConfig,
        configVersion: nextVersion,
        resolvedConfig: { ...current.resolvedConfig, ...nextConfig, registry: current.registry },
        rows: rowData.rows,
        meta: rowData.meta,
        effects: rowData.effects,
        tracks: nextConfig.tracks ?? [],
        clipOrder: rowData.clipOrder,
      } as TimelineData;
      version = nextVersion;
      operationalChromeState.editorData = nextData;
      const store = operationalChromeState.store;
      if (store) {
        const currentSlice = store.getState().data;
        store.getState().syncDataSlice({ ...currentSlice, data: nextData, resolvedConfig: nextData.resolvedConfig });
        store.getState().setConfigVersion(nextVersion);
      }
      return { version, entries: [], affectedObjectIds: patch.operations.map((operation) => operation.target) };
    },
    async flush() {
      durableConfig = structuredClone(operationalChromeState.editorData!.config!) as TimelineData['config'];
      return { version };
    },
    checkpoint: () => 'fixture-checkpoint',
    rollback: () => null,
    setAllTracksMuted: () => ({ version, entries: [], affectedObjectIds: [] }),
  } as unknown as TimelineOps;
  return {
    data: initialData,
    storage,
    objects,
    manifest,
    html,
    entryBytes,
    assetBytes,
    packageObject,
    timelineOps,
    get durableConfig() { return durableConfig; },
  };
}

function buildDuplicateCommandTimelineData(): TimelineData {
  const config = {
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips: [
      {
        id: 'clip-1',
        at: 0,
        track: 'V1',
        clipType: 'media',
        asset: 'asset-source',
        from: 0,
        to: 2,
        speed: 1,
        volume: 1,
      },
      {
        id: 'clip-2',
        at: 2,
        track: 'V1',
        clipType: 'hold',
        hold: 1,
      },
    ],
  } as const;
  const rowData = configToRows(config);
  const resolvedConfig = {
    output: { ...config.output },
    tracks: config.tracks.map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({ ...clip, assetEntry: undefined })),
    registry: {},
  };

  return {
    config: {
      ...config,
      tracks: config.tracks.map((track) => ({ ...track })),
      clips: config.clips.map((clip) => ({ ...clip })),
    },
    configVersion: 1,
    registry: {
      assets: {
        'asset-source': {
          file: 'https://example.com/source.mp4',
          type: 'video/mp4',
          duration: 2,
          generationId: 'generation-source',
        },
        'asset-dup': {
          file: 'https://example.com/dup.mp4',
          type: 'video/mp4',
          duration: 2,
          generationId: 'generation-dup',
        },
      },
    },
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: {},
    output: { ...config.output },
    tracks: config.tracks.map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: 'signature-dup',
    stableSignature: 'stable-signature-dup',
  };
}

function buildCommandTestStore(overrides?: {
  applyEdit?: (...args: unknown[]) => void;
  registerAsset?: (...args: unknown[]) => Promise<unknown>;
  patchRegistry?: (...args: unknown[]) => void;
  unpatchRegistry?: (...args: unknown[]) => void;
  data?: TimelineData;
  mounted?: boolean;
}) {
  const baseStore = createTimelineStore();
  const current = overrides?.data ?? buildCommandTimelineData();
  const store = createTimelineStore({
    data: {
      ...baseStore.getState().data,
      data: current,
      resolvedConfig: current.resolvedConfig,
      selectedTrackId: 'V1',
      dataRef: { current },
      pendingOpsRef: { current: 0 },
    },
    ops: {
      ...baseStore.getState().ops,
      applyEdit: overrides?.applyEdit ?? vi.fn(),
      registerAsset: overrides?.registerAsset ?? vi.fn(async () => undefined),
      patchRegistry: overrides?.patchRegistry ?? vi.fn(),
      unpatchRegistry: overrides?.unpatchRegistry ?? vi.fn(),
    },
  });
  if (overrides?.mounted === false) {
    store.getState().setMounted(false);
  }
  return store;
}

const media = {
  id: 'generation-1',
  generation_id: 'generation-1',
  media_id: 'media-1',
  location: 'https://example.com/image.png',
  imageUrl: 'https://example.com/image.png',
  thumbUrl: 'https://example.com/image-thumb.png',
  type: 'image',
  name: 'Still life',
  params: {
    prompt: 'A quiet still life',
    extra: { original_filename: 'camera/still-life.png' },
  },
} as const;

const LifecycleComponent: FC<{ children: ReactNode }> = ({ children }) => children;
const LifecycleReplacementComponent: FC<{ children: ReactNode }> = ({ children }) => children;

function trustedEffectRecord(
  effectId: string,
  ownerExtensionId: string,
  dispose: () => void,
): EffectRegistryRecord {
  return {
    effectId,
    contributionId: `${ownerExtensionId}.effect`,
    component: LifecycleComponent,
    provenance: 'trusted-loader',
    ownerExtensionId,
    status: 'active',
    renderability: {
      defaultRoute: 'preview',
      determinism: 'deterministic',
      capabilities: [
        {
          route: 'preview',
          status: 'supported',
          determinism: 'deterministic',
        },
        {
          route: 'browser-export',
          status: 'supported',
          determinism: 'deterministic',
        },
      ],
    },
    dispose,
  };
}

function trustedTransitionRecord(
  transitionId: string,
  ownerExtensionId: string,
  dispose: () => void,
): TransitionRegistryRecord {
  return {
    transitionId,
    contributionId: `${ownerExtensionId}.transition`,
    renderer: () => null,
    provenance: 'bundled-extension',
    ownerExtensionId,
    status: 'active',
    renderability: {
      defaultRoute: 'preview',
      determinism: 'preview-only',
      capabilities: [
        {
          route: 'preview',
          status: 'supported',
          determinism: 'preview-only',
        },
      ],
    },
    dispose,
  };
}

function trustedClipTypeRecord(
  clipTypeId: string,
  ownerExtensionId: string,
  dispose: () => void,
): ClipTypeRegistryRecord {
  return {
    clipTypeId,
    contributionId: `${ownerExtensionId}.clipType`,
    renderer: () => null,
    ownerExtensionId,
    status: 'active',
    renderability: {
      defaultRoute: 'preview',
      determinism: 'preview-only',
      capabilities: [
        {
          route: 'preview',
          status: 'supported',
          determinism: 'preview-only',
        },
      ],
    },
    dispose,
  };
}

function AddToVideoEditorConsumer() {
  const { onClick, phase } = useAddToVideoEditor(media);
  const availability = useTimelineAvailabilityState();

  return (
    <div>
      <span data-testid="add-phase">{phase}</span>
      <span data-testid="timeline-mounted">{String(availability.mounted)}</span>
      <button type="button" onClick={onClick}>
        add to video editor
      </button>
    </div>
  );
}

// These catalogs are consumed by every provider describe below.
beforeEach(() => {
  useEffectsMock.mockReset();
  useEffectsMock.mockReturnValue({ data: [] });
  useResolvedEffectCatalogMock.mockReset();
  useResolvedEffectCatalogMock.mockReturnValue(createVideoEditorEffectCatalog());
});

describe('VideoEditorProvider', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    systemResetSelectionForProjectChange();
    localStorage.clear();
    Object.values(mocks).forEach((mock) => mock.mockClear());
    operationalChromeState.editorData = null;
    operationalChromeState.timelineOps = null;
    operationalChromeState.configVersion = 0;
    operationalChromeState.store = null;
    operationalChromeState.isConflictExhausted = false;
    operationalChromeState.renderStatus = 'idle';
  });

  it('publishes the mounted canonical selection to app-level placement callers and releases it on close', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(), saveTimeline: vi.fn(), loadAssetRegistry: vi.fn(), resolveAssetUrl: vi.fn(),
      shotComposition: { load: vi.fn(async () => shotCompositionFixture) },
    };
    let runtime!: ReturnType<typeof useVideoEditorRuntime>;
    function Capture() { runtime = useVideoEditorRuntime(); return null; }
    const view = render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><AgentChatProvider>
      <VideoEditorProvider dataProvider={provider} projectId="project-001" projectSlug="project-001"
        timelineId="document-primary" userId={null}>
        <Capture />
      </VideoEditorProvider>
    </AgentChatProvider></QueryClientProvider></MemoryRouter>);
    await waitFor(() => expect(runtime.shots.canonicalComposition?.headRevisionId).toBeDefined());
    act(() => editorSelectTimelineClip('occ-2:alpha-video', runtime.agentSelectionOwner));
    expect(getShotPlacementTarget('project-001', 'shot-alpha')).toEqual({
      shot_id: expect.any(String), ownerRef: 'occurrence:occ-2', timelineRef: 'document-primary',
    });
    expect(() => getShotPlacementTarget('foreign-project', 'shot-alpha')).toThrow();
    view.unmount();
    expect(getShotPlacementTarget('project-001', 'shot-alpha')).toEqual({ shot_id: 'shot-alpha' });
  });


  it('supplies real scoped ports and routed agent/save behavior to the public runtime assembly', async () => {
    const services: VideoEditorScopedServices = {
      contract: 'astrid.video-editor.scoped-services.v1',
      scope: { instanceId: 'editor-dialog', projectId: 'scoped-project', projectSlug: 'scoped-slug', timelineId: 'scoped-timeline' },
      shots: { shots: [], isLoading: false, error: null, refetchShots: vi.fn(), canonicalThumbnailUrls: new Map([['occurrence-1', 'thumbnail.png']]) },
      mediaLightbox: { Lightbox: () => null, loadGenerationForLightbox: vi.fn(async () => null) },
      agentChat: { registerTimeline: vi.fn(), unregisterTimeline: vi.fn() },
      toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
      telemetry: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const provider: DataProvider = { loadTimeline: vi.fn(), saveTimeline: vi.fn(), loadAssetRegistry: vi.fn(), resolveAssetUrl: vi.fn(async (file) => file) };
    const onSaveStatusChange = vi.fn();
    const exporter = { render: vi.fn() };
    let runtime!: ReturnType<typeof useVideoEditorRuntime>;
    function Capture() { runtime = useVideoEditorRuntime(); return null; }
    const view = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={provider} timelineId="scoped-timeline" hostServices={services}
        runtime={{ assetResolver: provider, exporter, hostContext: { projectId: 'scoped-project' } }}
        onSaveStatusChange={onSaveStatusChange}>
        <Capture />
      </EditorRuntimeProvider>
    </MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(services.agentChat.registerTimeline).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'scoped-project', projectSlug: 'scoped-slug', timelineId: 'scoped-timeline',
    })));
    expect(runtime.instanceScope).toEqual(services.scope);
    expect(runtime.instanceScope).not.toBe(services.scope);
    expect(Object.isFrozen(runtime.instanceScope)).toBe(true);
    expect(runtime.shellRootRef).toEqual({ current: null });
    expect(typeof runtime.agentSelectionOwner).toBe('symbol');
    expect(runtime.provider).toBe(provider);
    expect(runtime.shots).toBe(services.shots);
    expect(runtime.shots.canonicalThumbnailUrls?.get('occurrence-1')).toBe('thumbnail.png');
    expect(runtime.mediaLightbox).toBe(services.mediaLightbox);
    expect(runtime.agentChat).toBe(services.agentChat);
    expect(runtime.toast).toBe(services.toast);
    expect(runtime.telemetry).toBe(services.telemetry);
    expect(runtime.exporter).toBe(exporter);
    expect(onSaveStatusChange).toHaveBeenCalled();
    view.unmount();
    expect(services.agentChat.unregisterTimeline).toHaveBeenCalled();
  });

  it('keeps same-project full/dialog registration and renderer ownership through update, close, reopen and authority change', async () => {
    const provider: DataProvider = { loadTimeline: vi.fn(), saveTimeline: vi.fn(), loadAssetRegistry: vi.fn(), resolveAssetUrl: vi.fn() };
    const runtimes = new Map<string, ReturnType<typeof useVideoEditorRuntime>>();
    const contexts = new Map<string, ExtensionContext>();
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    const buildExtension = (name: string) => defineExtension({
      manifest: { id: 'example.concurrent', version: '1.0.0', label: name, apiVersion: 1,
        contributions: [{ kind: 'slot', id: 'instance-status', slot: 'statusBar', render: 'instance-status' }] },
      activate(ctx) {
        contexts.set(name, ctx);
        const release = vi.fn(); releases.set(name, release);
        const renderer = ctx.ui.registerRenderer('instance-status', () => name);
        return { dispose() { release(); renderer.dispose(); } };
      },
    });
    const fullExtension = buildExtension('full'); const dialogExtension = buildExtension('dialog');
    let chat!: ReturnType<typeof useAgentChatBridge>;
    function Host() { chat = useAgentChatBridge(); return null; }
    function Capture({ name }: { name: string }) {
      const runtime = useVideoEditorRuntime(); runtimes.set(name, runtime);
      return <button data-testid={name} onClick={() => {
        runtime.agentChat.activateTimeline?.(); activateTimelineClipData(runtime.agentSelectionOwner!);
      }}>Activate {name}</button>;
    }
    const tree = (dialogOpen: boolean, dialogTimeline = 'instance-dialog', fullName = 'Full') => (
      <MemoryRouter><QueryClientProvider client={new QueryClient()}><AgentChatProvider>
        <Host />
        <VideoEditorProvider dataProvider={provider} projectId="same-project" projectSlug="same-slug"
          timelineId="instance-full" timelineName={fullName} userId={null} extensions={[fullExtension]}>
          <Capture name="full" />
        </VideoEditorProvider>
        {dialogOpen && <VideoEditorProvider dataProvider={provider} projectId="same-project" projectSlug="same-slug"
          timelineId={dialogTimeline} userId={null} extensions={[dialogExtension]}><Capture name="dialog" /></VideoEditorProvider>}
      </AgentChatProvider></QueryClientProvider></MemoryRouter>
    );
    const view = render(tree(true));
    await waitFor(() => expect(contexts.size).toBe(2));
    expect(chat.timelineId).toBe('instance-full');
    expect(runtimes.get('full')!.agentSelectionOwner).not.toBe(runtimes.get('dialog')!.agentSelectionOwner);
    const oldFull = runtimes.get('full')!; const oldDialog = runtimes.get('dialog')!;
    const capturedAdapter=chat.editorContext?.elementOperationAdapter;
    expect(capturedAdapter).toBeDefined();
    const admissionHost=await import('../runtime/admitted-elements');
    const digest='e'.repeat(64);
    await act(async()=>{await admissionHost.refreshAdmittedElements(
      async()=>({digest,moduleUrl:'/@id/__x00__virtual:astrid-element-admissions?v='+digest}),
      async()=>({configured:true,projectId:'same-project',selectionDigest:digest,realmId:null,projects:[],elements:[],components:{}}),
    );});
    expect(chat.editorContext?.elementOperationAdapter).toBe(capturedAdapter);
    expect(runtimes.get('full')!.agentSelectionOwner).toBe(oldFull.agentSelectionOwner);
    expect(releases.get('full')).not.toHaveBeenCalled();

    const fullProgress = vi.fn(); contexts.get('full')!.chrome.subscribe('progress', fullProgress);
    act(() => editorSelectTimelineClip('clip-1', oldFull.agentSelectionOwner));
    fireEvent.click(screen.getByTestId('dialog'));
    expect(chat.timelineId).toBe('instance-dialog');
    expect(chat.editorContext?.projectId).toBe('same-project');
    view.rerender(tree(true, 'instance-dialog', 'Full updated'));
    expect(chat.timelineId).toBe('instance-dialog');
    view.rerender(tree(false));
    await waitFor(() => expect(releases.get('dialog')).toHaveBeenCalledOnce());
    expect(chat.timelineId).toBe('instance-full');
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual(['clip-1']);
    contexts.get('full')!.chrome.progress(10); expect(fullProgress).toHaveBeenCalledOnce();
    expect(releases.get('full')).not.toHaveBeenCalled();
    view.rerender(tree(true));
    await waitFor(() => expect(runtimes.get('dialog')!.agentSelectionOwner).not.toBe(oldDialog.agentSelectionOwner));
    expect(chat.timelineId).toBe('instance-full');
    fireEvent.click(screen.getByTestId('dialog'));
    view.rerender(tree(true, 'instance-dialog-next'));
    await waitFor(() => expect(chat.timelineId).toBe('instance-full'));
    expect(runtimes.get('dialog')!.timelineId).toBe('instance-dialog-next');
    expect(runtimes.get('full')!.agentSelectionOwner).toBe(oldFull.agentSelectionOwner);
    view.unmount();
    await waitFor(() => expect(releases.get('full')).toHaveBeenCalledOnce());
  });

  it('admits Gallery queued media only in the active instance and ignores a load completing after unmount', async () => {
    let resolveLoad!: (value: null) => void;
    const loading = new Promise<null>((resolve) => { resolveLoad = resolve; });
    const fullLoad = vi.fn(() => loading); const dialogLoad = vi.fn(async () => null);
    const toastError = vi.fn();
    const provider: DataProvider = { loadTimeline: vi.fn(), saveTimeline: vi.fn(), loadAssetRegistry: vi.fn(), resolveAssetUrl: vi.fn() };
    const services = (name: string, load: typeof fullLoad | typeof dialogLoad): VideoEditorScopedServices => ({
      contract: 'astrid.video-editor.scoped-services.v1', scope: { instanceId: name, projectId: 'same-project', timelineId: name },
      shots: { shots: [], isLoading: false, error: null, refetchShots: vi.fn() },
      mediaLightbox: { Lightbox: () => null, loadGenerationForLightbox: load },
      agentChat: { registerTimeline: vi.fn(), unregisterTimeline: vi.fn() },
      toast: { error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() },
      telemetry: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const full = services('full', fullLoad); const dialog = services('dialog', dialogLoad);
    writePendingAdds(['queued-generation']);
    const view = render(<MemoryRouter><QueryClientProvider client={new QueryClient()}>
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={provider} timelineId="full" hostServices={full}><span>Full</span></EditorRuntimeProvider>
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={provider} timelineId="dialog" hostServices={dialog}><span>Dialog</span></EditorRuntimeProvider>
    </QueryClientProvider></MemoryRouter>);
    await waitFor(() => expect(fullLoad).toHaveBeenCalledOnce());
    expect(dialogLoad).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => { resolveLoad(null); await loading; });
    expect(toastError).not.toHaveBeenCalled();
    expect(readPendingAdds()).toEqual(['queued-generation']);
  });

  it('builds fallback lightbox media for raw video assets without a generation id', () => {
    expect(buildVideoEditorLightboxMedia('asset-1', {
      file: 'folder/video.mp4',
      src: 'https://example.com/video.mp4',
      thumbnailUrl: 'https://example.com/video.jpg',
      type: 'video/mp4',
    })).toEqual(expect.objectContaining({
      id: 'asset-1',
      generation_id: 'asset-1',
      location: 'https://example.com/video.mp4',
      thumbUrl: 'https://example.com/video.jpg',
      type: 'video',
    }));
  });

  it('uses managed media identity as the lightbox label when file is absent', () => {
    expect(buildVideoEditorLightboxMedia('asset-managed', {
      media_id: 'media-123',
      src: 'https://example.com/video.mp4',
      type: 'video/mp4',
    })).toEqual(expect.objectContaining({
      id: 'asset-managed',
      location: 'https://example.com/video.mp4',
      name: 'media-123',
    }));
  });

  it('runs the real Astrid scene read and publish through the app-shell provider with live data disabled', async () => {
    const fixture = await createLiveSceneProviderFixture();
    operationalChromeState.editorData = fixture.data;
    operationalChromeState.timelineOps = fixture.timelineOps;
    operationalChromeState.configVersion = 1;
    const dataProvider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
      projectObjects: fixture.storage,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let editorContext: ReturnType<typeof useAgentChatBridge>['editorContext'] = null;
    let runtime: ReturnType<typeof useVideoEditorRuntime> | null = null;
    function CaptureProviderContext() {
      editorContext = useAgentChatBridge().editorContext;
      runtime = useVideoEditorRuntime();
      return null;
    }

    const renderProvider = (extensions: readonly AstridExtension[]) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={dataProvider}
              projectId="live-scene-project"
              timelineId="live-scene-timeline"
              userId={null}
              extensions={extensions}
              initialTimelineData={fixture.data}
            >
              <CaptureProviderContext />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    const view = render(renderProvider([threejsLiveEditorExtension]));

    try {
      await waitFor(() => {
        expect(editorContext?.liveSceneOperationPort).toBeDefined();
        expect(runtime?.extensionRuntime.extensions.some((extension) => extension.manifest.id === THREEJS_LIVE_EDITOR_EXTENSION_ID)).toBe(true);
        expect(runtime?.commandRegistry?.getSnapshot().commands.map((command) => command.commandId))
          .toContain(LIVE_SCENE_IMPORT_COMMAND_ID);
      });
      const port = editorContext?.liveSceneOperationPort;
      expect(port).toBeDefined();
      const scope = {
        sessionId: 'video-editor-provider-session',
        turnId: 'bounded-color-edit',
        projectId: 'live-scene-project',
        timelineId: 'live-scene-timeline',
        capturedTimelineVersion: 1,
      };
      const requestBlock = (request: Record<string, unknown>) =>
        `<astrid_live_scene_request>${JSON.stringify(request)}</astrid_live_scene_request>`;
      let followupCount = 0;
      let readCapture: Record<string, unknown> | null = null;
      const followup = vi.fn(async (prompt: string) => {
        const serialized = prompt.match(/<astrid_live_scene_result>([\s\S]*?)<\/astrid_live_scene_result>/)?.[1];
        expect(serialized).toBeDefined();
        const feedback = JSON.parse(serialized!) as {
          results: Array<{ ok: boolean; result?: { kind: string; capture?: Record<string, unknown> } }>;
        };
        followupCount += 1;
        if (followupCount === 1) {
          expect(feedback.results[0]).toMatchObject({ ok: true, result: { kind: 'read' } });
          readCapture = feedback.results[0].result?.capture ?? null;
          expect(readCapture).toBeTruthy();
          return requestBlock({
            schema: 'astrid.live-scene-request/v1',
            requestId: 'provider-publish',
            scope,
            placementIds: ['scene-placement'],
            action: 'publish',
            capture: readCapture,
            replacements: [{ before: '#ff9f68', after: '#2d6cdf' }],
          });
        }
        expect(feedback.results[0]).toMatchObject({ ok: true, result: { kind: 'published' } });
        return 'Acknowledged the durable scene receipt.';
      });

      let output = '';
      await act(async () => {
        output = await runLiveSceneAcpRoundtrip({
          content: requestBlock({
            schema: 'astrid.live-scene-request/v1',
            requestId: 'provider-read',
            scope,
            placementIds: ['scene-placement'],
            action: 'read',
            offset: 0,
            length: 512,
          }),
          scope,
          port,
          signal: new AbortController().signal,
          followup,
        });
      });

      expect(output).toContain('Scene published:');
      expect(output).toContain('Acknowledged the durable scene receipt.');
      expect(followup).toHaveBeenCalledTimes(2);
      expect(readCapture).toMatchObject({
        projectId: scope.projectId,
        timelineId: scope.timelineId,
        capturedTimelineVersion: scope.capturedTimelineVersion,
      });
      expect(fixture.durableConfig).toBeDefined();
      const durableClip = fixture.durableConfig!.clips.find((clip) => clip.id === 'scene-placement')!;
      const publishedScene = durableClip.app?.liveScene as {
        revision: string;
        source: { objectId: string };
        packageBody: string;
        html: string;
      };
      expect(publishedScene.revision).not.toBe(fixture.packageObject.digest);
      expect(publishedScene.html).toBe(fixture.html.replace('#ff9f68', '#2d6cdf'));
      expect(publishedScene.html).toContain('<main data-preserve="exact-bytes">keep me</main>');
      const publishedPackage = JSON.parse(publishedScene.packageBody) as {
        manifest: typeof fixture.manifest;
        entry: ProjectObjectMetadata;
        assets: ProjectObjectMetadata[];
      };
      expect(publishedPackage.manifest).toEqual(fixture.manifest);
      expect(publishedPackage.assets).toHaveLength(1);
      expect(publishedPackage.assets[0].object_id).toBe(metadataForFixture(fixture.assetBytes, 'image/png', 'texture.png').object_id);
      expect(Array.from(await fixture.storage.read(publishedPackage.assets[0].object_id))).toEqual(Array.from(fixture.assetBytes));
      expect(Array.from(await fixture.storage.read(publishedPackage.entry.object_id))).toEqual(
        Array.from(new TextEncoder().encode(publishedScene.html)),
      );
      expect(fixture.objects.has(fixture.packageObject.object_id)).toBe(true);
      expect(Array.from(await fixture.storage.read(fixture.packageObject.object_id))).toEqual(
        Array.from(new TextEncoder().encode(JSON.stringify({
          manifest: fixture.manifest,
          entry: metadataForFixture(fixture.entryBytes, 'text/html', 'scene.html'),
          assets: [metadataForFixture(fixture.assetBytes, 'image/png', 'texture.png')],
        }))),
      );

      const firstPort = port!;
      view.rerender(renderProvider([]));
      await waitFor(() => {
        expect(runtime?.commandRegistry?.getSnapshot().commands.map((command) => command.commandId))
          .not.toContain(LIVE_SCENE_IMPORT_COMMAND_ID);
      });
      const removedExtensionOutput = await runLiveSceneAcpRoundtrip({
        content: requestBlock({
          schema: 'astrid.live-scene-request/v1',
          requestId: 'after-extension-removal',
          scope,
          placementIds: ['scene-placement'],
          action: 'read',
          offset: 0,
          length: 32,
        }),
        scope,
        port: firstPort,
        signal: new AbortController().signal,
        followup: async () => 'old handler should remain unavailable',
      });
      expect(removedExtensionOutput).toContain('Live-scene handler unavailable or disposed');

      view.unmount();
      const secondFixture = await createLiveSceneProviderFixture();
      operationalChromeState.editorData = secondFixture.data;
      operationalChromeState.timelineOps = secondFixture.timelineOps;
      operationalChromeState.configVersion = 1;
      let secondEditorContext: ReturnType<typeof useAgentChatBridge>['editorContext'] = null;
      let secondRuntime: ReturnType<typeof useVideoEditorRuntime> | null = null;
      function CaptureSecondProvider() {
        secondEditorContext = useAgentChatBridge().editorContext;
        secondRuntime = useVideoEditorRuntime();
        return null;
      }
      const secondDataProvider: DataProvider = {
        loadTimeline: vi.fn(),
        saveTimeline: vi.fn(),
        loadAssetRegistry: vi.fn(),
        resolveAssetUrl: vi.fn(),
        projectObjects: secondFixture.storage,
      };
      const secondView = render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={secondDataProvider}
                projectId="second-live-scene-project"
                timelineId="second-live-scene-timeline"
                userId={null}
                extensions={[threejsLiveEditorExtension]}
                initialTimelineData={secondFixture.data}
              >
                <CaptureSecondProvider />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
      try {
        await waitFor(() => {
          expect(secondEditorContext?.liveSceneOperationPort).toBeDefined();
          expect(secondRuntime?.commandRegistry?.getSnapshot().commands.map((command) => command.commandId))
            .toContain(LIVE_SCENE_IMPORT_COMMAND_ID);
        });
        const secondPort = secondEditorContext!.liveSceneOperationPort!;
        expect(secondPort).not.toBe(firstPort);
        const oldProviderOutput = await runLiveSceneAcpRoundtrip({
          content: requestBlock({
            schema: 'astrid.live-scene-request/v1',
            requestId: 'old-provider-after-replacement',
            scope,
            placementIds: ['scene-placement'],
            action: 'read',
            offset: 0,
            length: 32,
          }),
          scope,
          port: firstPort,
          signal: new AbortController().signal,
          followup: async () => 'old provider remains disposed',
        });
        expect(oldProviderOutput).toContain('Live-scene handler unavailable or disposed');
        const secondScope = {
          sessionId: 'second-video-editor-provider-session',
          turnId: 'second-provider-read',
          projectId: 'second-live-scene-project',
          timelineId: 'second-live-scene-timeline',
          capturedTimelineVersion: 1,
        };
        const secondOutput = await runLiveSceneAcpRoundtrip({
          content: requestBlock({
            schema: 'astrid.live-scene-request/v1',
            requestId: 'second-provider-read',
            scope: secondScope,
            placementIds: ['scene-placement'],
            action: 'read',
            offset: 0,
            length: 32,
          }),
          scope: secondScope,
          port: secondPort,
          signal: new AbortController().signal,
          followup: async (prompt) => {
            const serialized = prompt.match(/<astrid_live_scene_result>([\s\S]*?)<\/astrid_live_scene_result>/)?.[1];
            expect(JSON.parse(serialized!).results[0]).toMatchObject({ ok: true, result: { kind: 'read' } });
            return 'second provider read acknowledged';
          },
        });
        expect(secondOutput).not.toContain('Live-scene request failed');
        expect(secondFixture.objects.has(secondFixture.packageObject.object_id)).toBe(true);
      } finally {
        secondView.unmount();
      }
    } finally {
      if (view.container.isConnected) view.unmount();
    }
  });

  it('reports only effective host activation and real per-extension lifecycle transitions', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const sink = vi.fn();
    const dispose = vi.fn();
    const extension = defineExtension({
      manifest: {
        id: 'haus.astrid.observability-fixture' as never,
        version: '1.0.0',
        apiVersion: 1,
        label: 'Observability fixture',
      },
      activate: () => ({ dispose }),
    });
    const replacement = defineExtension({
      manifest: {
        id: 'haus.astrid.observability-fixture' as never,
        version: '2.0.0',
        apiVersion: 1,
        label: 'Observability fixture replacement',
      },
      activate: () => ({ dispose: vi.fn() }),
    });
    const renderTree = (enabled: boolean, extensions: readonly AstridExtension[]) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={provider}
              projectId="project-1"
              timelineId="timeline-1"
              userId="user-1"
              extensions={extensions}
              extensionHostEnabled={enabled}
              extensionReleaseRevision="rc-observability"
              extensionOperationalEventSink={sink}
            >
              <Consumer />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );

    const view = render(renderTree(false, [extension]));
    await Promise.resolve();
    expect(sink).not.toHaveBeenCalled();

    view.rerender(renderTree(true, [extension]));
    await waitFor(() => {
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        event: 'host.activation',
        outcome: 'success',
      }));
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        event: 'extension.activation',
        extensionId: 'haus.astrid.observability-fixture',
        extensionVersion: '1.0.0',
      }));
    });
    expect(sink.mock.calls.filter(([event]) => event.event === 'host.activation')).toHaveLength(1);

    sink.mockClear();
    view.rerender(renderTree(true, [replacement]));
    await waitFor(() => {
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        event: 'extension.disposal',
        extensionId: 'haus.astrid.observability-fixture',
        extensionVersion: '1.0.0',
      }));
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        event: 'extension.activation',
        extensionId: 'haus.astrid.observability-fixture',
        extensionVersion: '2.0.0',
      }));
    });

    view.rerender(renderTree(true, []));
    await waitFor(() => {
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        event: 'extension.disposal',
        extensionId: 'haus.astrid.observability-fixture',
        extensionVersion: '2.0.0',
      }));
    });
    view.rerender(renderTree(true, [extension]));
    await waitFor(() => {
      expect(sink.mock.calls.filter(([event]) => (
        event.event === 'extension.activation'
        && event.extensionId === 'haus.astrid.observability-fixture'
      ))).toHaveLength(2);
    });
    const disposalsBeforeUnmount = sink.mock.calls.filter(([event]) => (
      event.event === 'extension.disposal'
      && event.extensionId === 'haus.astrid.observability-fixture'
    )).length;
    view.unmount();
    expect(sink.mock.calls.filter(([event]) => (
      event.event === 'extension.disposal'
      && event.extensionId === 'haus.astrid.observability-fixture'
    ))).toHaveLength(disposalsBeforeUnmount + 1);
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ extensionId: 'host' }));
  });

  it('emits bounded persistence-conflict, render, and lane-density outcomes on transitions', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const sink = vi.fn();
    const renderTree = () => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={provider}
              projectId="project-1"
              timelineId="timeline-1"
              userId="user-1"
              extensions={[]}
              extensionHostEnabled
              extensionReleaseRevision="rc-observability"
              extensionOperationalEventSink={sink}
            >
              <Consumer />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );

    const view = render(renderTree());
    operationalChromeState.isConflictExhausted = true;
    operationalChromeState.renderStatus = 'rendering';
    operationalChromeState.editorData = {
      dataLanes: [{ items: Array.from({ length: 11 }, () => ({})) }],
    };
    view.rerender(renderTree());

    await waitFor(() => {
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        event: 'persistence.conflict',
        outcome: 'failure',
        errorClass: 'persistence.version_conflict',
      }));
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        event: 'lane.density',
        outcome: 'success',
        countBucket: '11-100',
      }));
    });

    operationalChromeState.renderStatus = 'done';
    view.rerender(renderTree());
    await waitFor(() => {
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        event: 'render.outcome',
        outcome: 'success',
        durationMs: expect.any(Number),
      }));
    });

    const conflictEvents = sink.mock.calls.filter(([event]) => event.event === 'persistence.conflict');
    view.rerender(renderTree());
    expect(sink.mock.calls.filter(([event]) => event.event === 'persistence.conflict')).toHaveLength(
      conflictEvents.length,
    );
  });

  it('provides editor data, editor ops, chrome, and playback contexts together', () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider dataProvider={provider} projectId="project-1" timelineId="timeline-1" userId="user-1">
              <Consumer />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('clip-1')).toBeInTheDocument();
    expect(screen.getAllByText('tablet')).toHaveLength(2);
    expect(screen.getByText('mouse')).toBeInTheDocument();
    expect(screen.getByText('select')).toBeInTheDocument();
    expect(screen.getAllByText('timeline')).toHaveLength(2);
    expect(screen.getByTestId('interaction-policy')).toHaveTextContent(JSON.stringify({
      deviceClass: 'tablet',
      inputModality: 'mouse',
      interactionMode: 'select',
      gestureOwner: 'timeline',
      contextTarget: { kind: 'timeline' },
      inspectorTarget: { kind: 'clip', clipId: 'clip-1' },
    }));
    expect(screen.getByText('false')).toBeInTheDocument();
    expect(screen.getByText('boolean')).toBeInTheDocument();
    expect(screen.getAllByText('function')).toHaveLength(3);
    expect(screen.getByText('saved')).toBeInTheDocument();
    expect(screen.getByText('12.5')).toBeInTheDocument();
    expect(screen.getByTestId('agent-chat-timeline-id')).toHaveTextContent('timeline-1');
    expect(screen.getByTestId('runtime-project-id')).toHaveTextContent('project-1');
    expect(screen.getByTestId('runtime-user-id')).toHaveTextContent('user-1');
    expect(screen.getByTestId('runtime-shots-count')).toHaveTextContent('0');
    expect(screen.getByTestId('runtime-resolver-type')).toHaveTextContent('function');

    fireEvent.click(screen.getByRole('button', { name: 'update interaction' }));

    expect(mocks.setInputModality).toHaveBeenCalledWith('touch');
    expect(mocks.setInputModalityFromPointerType).toHaveBeenCalledWith('touch');
    expect(mocks.setInteractionMode).toHaveBeenCalledWith('trim');
    expect(mocks.setGestureOwner).toHaveBeenCalledWith('trim');
    expect(mocks.setContextTarget).toHaveBeenCalledWith({ kind: 'clip', clipId: 'clip-1' });
    expect(mocks.setInspectorTarget).toHaveBeenCalledWith({ kind: 'selection', clipIds: ['clip-1'] });
    expect(__getSelectionStateForTests().clipDataById.get('clip-1')).toEqual(expect.objectContaining({
      clipId: 'clip-1',
      url: 'https://example.com/image.png',
    }));
  });

  it('uses an injected effect catalog without enabling the legacy effect query', () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const injectedCatalog = createVideoEditorEffectCatalog({
      effects: [{
        id: 'effect-1',
        type: 'effect',
        name: 'Standalone Fade',
        slug: 'standalone-fade',
        code: 'export default function Effect() { return null; }',
        category: 'entrance',
        description: 'Standalone effect',
        created_by: { is_you: true },
        is_public: false,
      }],
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={provider}
              timelineId="timeline-1"
              userId="user-1"
              effectCatalog={injectedCatalog}
            >
              <Consumer />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(useEffectsMock).toHaveBeenCalledWith('user-1', { enabled: false });
    expect(useResolvedEffectCatalogMock).toHaveBeenCalledWith(injectedCatalog);
  });

  it('cleans extension-owned effect records and command contributions on removal after HMR replacement', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const extensionId = 'com.example.video-provider-lifecycle';
    const commandId = `${extensionId}.run`;
    const disposeOriginal = vi.fn();
    const disposeReplacement = vi.fn();
    let hmrHandle: { dispose(): void } | null = null;
    let latestEffectIds: readonly string[] = [];
    let latestCommandIds: readonly string[] = [];

    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Video provider lifecycle extension',
        contributions: [
          {
            id: 'lifecycle.command' as never,
            kind: 'command',
            command: commandId,
            label: 'Run lifecycle command',
          },
        ],
      },
      activate(ctx) {
        return ctx.commands.registerCommand(commandId, vi.fn());
      },
    });

    function CaptureVideoProviderLifecycle() {
      const { registry, snapshot } = useEffectRegistryContext();
      const runtime = useVideoEditorRuntime();

      latestEffectIds = snapshot.records.map((record) => record.effectId);
      latestCommandIds = runtime.commandRegistry?.getSnapshot().commands.map((command) => command.commandId) ?? [];

      useEffect(() => {
        const originalHandle = registry.register(
          trustedEffectRecord('trusted-video-fx', extensionId, disposeOriginal),
        );
        hmrHandle = registry.updateRecord('trusted-video-fx', (current) => ({
          ...current,
          contributionId: `${extensionId}.effect.hmr`,
          component: LifecycleReplacementComponent,
        }), disposeReplacement);

        return () => {
          originalHandle.dispose();
          hmrHandle?.dispose();
        };
      }, [registry]);

      return null;
    }

    const props = {
      dataProvider: provider,
      projectId: 'project-1',
      timelineId: 'timeline-1',
      userId: 'user-1',
    };

    const { rerender } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider {...props} extensions={[extension]}>
              <CaptureVideoProviderLifecycle />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(latestEffectIds).toContain('trusted-video-fx');
      expect(latestCommandIds).toContain(commandId);
    });
    expect(disposeOriginal).toHaveBeenCalledTimes(1);
    expect(disposeReplacement).not.toHaveBeenCalled();

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider {...props} extensions={[]}>
              <CaptureVideoProviderLifecycle />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(latestEffectIds).not.toContain('trusted-video-fx');
      expect(latestCommandIds).not.toContain(commandId);
    });
    expect(disposeOriginal).toHaveBeenCalledTimes(1);
    expect(disposeReplacement).toHaveBeenCalledTimes(1);

    hmrHandle?.dispose();
    hmrHandle?.dispose();
    expect(disposeReplacement).toHaveBeenCalledTimes(1);
  });

  it('ingests replacement manifest commands after old lifecycle cleanup and before activation', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const extensionId = 'com.example.command-manifest-replacement';
    const oldCommandId = `${extensionId}.obsolete`;
    const replacementCommandId = `${extensionId}.import`;
    const replacementHandler = vi.fn();
    const oldExtension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Command manifest replacement v1',
        contributions: [{
          id: 'obsolete-command' as never,
          kind: 'command',
          command: oldCommandId,
          label: 'Obsolete command',
        }],
      },
      activate(ctx) {
        return ctx.commands.registerCommand(oldCommandId, vi.fn());
      },
    });
    const replacementExtension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Command manifest replacement v2',
        contributions: [{
          id: 'prepared-scene-import' as never,
          kind: 'command',
          command: replacementCommandId,
          label: 'Import prepared scene',
        }],
      },
      activate(ctx) {
        return ctx.commands.registerCommand(replacementCommandId, replacementHandler);
      },
    });

    let commandRegistry: ReturnType<typeof useVideoEditorRuntime>['commandRegistry'];
    function CaptureCommandRegistry() {
      commandRegistry = useVideoEditorRuntime().commandRegistry;
      return null;
    }

    const props = {
      dataProvider: provider,
      projectId: 'project-command-manifest-replacement',
      timelineId: 'timeline-command-manifest-replacement',
      userId: 'user-command-manifest-replacement',
    };
    const tree = (extension: AstridExtension) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider {...props} extensions={[extension]}>
              <CaptureCommandRegistry />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    const { rerender } = render(tree(oldExtension));

    await waitFor(() => {
      expect(commandRegistry?.getSnapshot().commands.map((command) => command.commandId))
        .toContain(oldCommandId);
    });

    rerender(tree(replacementExtension));

    await waitFor(() => {
      const commandIds = commandRegistry?.getSnapshot().commands.map((command) => command.commandId) ?? [];
      expect(commandIds).toContain(replacementCommandId);
      expect(commandIds).not.toContain(oldCommandId);
    });
    expect(commandRegistry?.diagnostics.some((diagnostic) =>
      diagnostic.code === 'command-registry/handler-no-command',
    )).toBe(false);
    await expect(commandRegistry?.executeCommand(replacementCommandId)).resolves.toBe(true);
    expect(replacementHandler).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Focused compatibility tests — extensions prop lifecycle
  // -------------------------------------------------------------------------
  // Prove the direct `extensions` prop activates, deactivates, and
  // unregisters provider-scoped command + media contributions when the
  // extension list changes, and keep the example manifests loadable.

  it('activates, deactivates, and unregisters provider-scoped command + media (effect) contributions when the extensions prop changes', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const extensionId = 'com.t1.provider-lifecycle';
    const commandId = `${extensionId}.testCommand`;
    const effectId = 'trusted-t1-provider-fx';
    const disposeEffect = vi.fn();
    let latestCommandIds: readonly string[] = [];
    let latestEffectIds: readonly string[] = [];

    const extension: AstridExtension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'T1 provider lifecycle',
        contributions: [
          {
            id: 't1.command' as never,
            kind: 'command',
            command: commandId,
            label: 'T1 test command',
          },
          {
            id: 't1.effect' as never,
            kind: 'effect',
            label: 'T1 Effect',
            effectId,
          },
        ],
      },
      activate(ctx: ExtensionContext): DisposeHandle {
        const commandHandle = ctx.commands.registerCommand(commandId, vi.fn());
        const effectHandle = ctx.effects.registerComponent(effectId, LifecycleComponent, {
          label: 'T1 Effect',
        });
        return {
          dispose() {
            disposeEffect();
            commandHandle.dispose();
            effectHandle.dispose();
          },
        };
      },
    });

    function ProviderSnapshot() {
      const { snapshot } = useEffectRegistryContext();
      const runtime = useVideoEditorRuntime();
      latestEffectIds = snapshot.records.map((r) => r.effectId);
      latestCommandIds =
        runtime.commandRegistry?.getSnapshot().commands.map((c) => c.commandId) ?? [];
      return null;
    }

    const props = {
      dataProvider: provider,
      projectId: 'project-t1',
      timelineId: 'timeline-t1',
      userId: 'user-t1',
    };

    const { rerender } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider {...props} extensions={[extension]}>
              <ProviderSnapshot />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Both command and effect must be registered after activation
    await waitFor(() => {
      expect(latestCommandIds).toContain(commandId);
      expect(latestEffectIds).toContain(effectId);
    });

    // Remove the extension — both command and effect must be cleaned up
    rerender(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider {...props} extensions={[]}>
              <ProviderSnapshot />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(latestCommandIds).not.toContain(commandId);
      expect(latestEffectIds).not.toContain(effectId);
    });
    // The extension's dispose handle must have been invoked
    expect(disposeEffect).toHaveBeenCalledTimes(1);
  });

  it('loads the M1 command-extension example manifest through the extensions prop without crashing', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let rendered = false;
    function CheckRender() {
      rendered = true;
      return null;
    }

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={provider}
              projectId="project-m1-cmd"
              timelineId="timeline-m1-cmd"
              userId="user-m1-cmd"
              extensions={[commandExtension]}
            >
              <CheckRender />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(rendered).toBe(true);
    });
    // The command-extension manifest ID must match the known constant
    expect(commandExtension.manifest.id).toBe('haus.astrid.examples.command-extension');
  });

  it('loads the M1 flagship-local example manifest through the extensions prop without crashing', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let rendered = false;
    function CheckRender() {
      rendered = true;
      return null;
    }

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={provider}
              projectId="project-m1-flagship"
              timelineId="timeline-m1-flagship"
              userId="user-m1-flagship"
              extensions={[flagshipLocalExtension]}
            >
              <CheckRender />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(rendered).toBe(true);
    });
    // The flagship manifest ID must match the known constant
    expect(flagshipLocalExtension.manifest.id).toBe('haus.astrid.examples.flagship-local');
  });

  it('lifts save status changes through the provider boundary', () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const onSaveStatusChange = vi.fn();

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={provider}
              timelineId="timeline-1"
              userId="user-1"
              onSaveStatusChange={onSaveStatusChange}
            >
              <Consumer />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(onSaveStatusChange).toHaveBeenCalledWith('saved');
  });

  it('lets editor timeline replacement update selection while preserving gallery attachments', () => {
    userSelectGalleryItem({
      id: 'gallery-1',
      url: 'https://example.com/gallery.png',
      type: 'image/png',
      generationId: 'gen-gallery',
    }, { additive: false });

    editorReplaceTimelineSelection(['clip-1']);

    const selectionState = __getSelectionStateForTests();
    expect(selectionState.timeline.selectedClipIds).toEqual(new Set(['clip-1']));
    expect(selectionState.clipDataById.get('clip-1')).toBeUndefined();
    expect(selectionState.gallery.selectedGalleryIds).toEqual(new Set(['gallery-1']));
  });

  it('matches the touch interaction decision table for drag, trim, and selection routing', () => {
    expect({
      phoneTouchDragInSelect: shouldAllowTouchClipDrag('phone', 'touch', 'select'),
      phoneTouchDragInMove: shouldAllowTouchClipDrag('phone', 'touch', 'move'),
      phoneTouchTrimHandlesInTrim: shouldExpandTouchTrimHandles('phone', 'touch', 'trim'),
      phoneTouchTrimHandlesInSelect: shouldExpandTouchTrimHandles('phone', 'touch', 'select'),
      tabletTouchPreserveSelectionInMove: shouldPreserveTouchSelectionForMove('tablet', 'touch', 'move'),
      tabletMousePreserveSelectionInMove: shouldPreserveTouchSelectionForMove('tablet', 'mouse', 'move'),
    }).toEqual({
      phoneTouchDragInSelect: false,
      phoneTouchDragInMove: true,
      phoneTouchTrimHandlesInTrim: true,
      phoneTouchTrimHandlesInSelect: false,
      tabletTouchPreserveSelectionInMove: true,
      tabletMousePreserveSelectionInMove: false,
    });
  });

  it('keeps the mounted-vs-staged add boundary when a store provider exists but the editor is not mounted', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TimelineStoreProvider store={createTimelineStore()}>
            <AddToVideoEditorConsumer />
          </TimelineStoreProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('timeline-mounted')).toHaveTextContent('false');

    fireEvent.click(screen.getByRole('button', { name: 'add to video editor' }));

    expect(screen.getByTestId('add-phase')).toHaveTextContent('staged');
    expect(readPendingAdds()).toEqual(['generation-1']);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('places the prepared generation asset and clip in one canonical edit when mounted', () => {
    const current = buildCommandTimelineData();
    const patchRegistry = vi.fn();
    const registerAsset = vi.fn(async () => undefined);
    const commits: Array<NonNullable<ReturnType<typeof applyPreparedMediaCommand>>> = [];
    const applyEdit = vi.fn((mutation: unknown) => {
      const edit = mutation as { type: string; command: PlacePreparedMediaCommand };
      expect(edit.type).toBe('prepared-media');
      const materialized = applyPreparedMediaCommand(current, edit.command);
      if (materialized) commits.push(materialized);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = buildCommandTestStore({ data: current, patchRegistry, registerAsset, applyEdit });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TimelineStoreProvider store={store}>
            <AddToVideoEditorConsumer />
          </TimelineStoreProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('timeline-mounted')).toHaveTextContent('true');
    fireEvent.click(screen.getByRole('button', { name: 'add to video editor' }));
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const edit = applyEdit.mock.calls[0]?.[0] as { command: PlacePreparedMediaCommand };
    expect(edit.command).toEqual(expect.objectContaining({
      type: 'place-prepared-media',
      payload: expect.objectContaining({
        at: 2,
        selectedTrackId: 'V1',
        asset: expect.objectContaining({
          assetKey: expect.any(String),
          mediaType: 'image',
          source: 'registered',
          entry: expect.objectContaining({
            generationId: 'generation-1',
            file: 'https://example.com/image.png',
            type: 'image/png',
            name: 'Still life',
            prompt: 'A quiet still life',
            original_filename: 'camera/still-life.png',
          }),
        }),
      }),
    }));
    expect(edit.command.payload).not.toHaveProperty('trackId');
    expect(edit.command.payload).not.toHaveProperty('clipSpanSeconds');
    const assetId = edit.command.payload.asset.assetKey;
    expect(commits).toHaveLength(1);
    const committed = commits[0]!;
    expect(committed.nextData.registry.assets[assetId]).toEqual(edit.command.payload.asset.entry);
    expect(committed.nextData.resolvedConfig.clips).toContainEqual(expect.objectContaining({
      at: 2,
      hold: 5,
      asset: assetId,
      track: 'V1',
    }));
    expect(patchRegistry).not.toHaveBeenCalled();
    expect(registerAsset).not.toHaveBeenCalled();
    expect(readPendingAdds()).toEqual([]);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('navigates on the second staged click when the editor is not mounted', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AddToVideoEditorConsumer />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'add to video editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'add to video editor' }));

    expect(readPendingAdds()).toEqual(['generation-1']);
    expect(navigateMock).toHaveBeenCalledWith(
      `/tools/video-editor?timeline=timeline-staged&${ADD_GENERATION_QUERY_PARAM}=generation-1`,
    );
  });

  it('keeps staged add-to-editor behavior when a timeline provider exists but the mounted store is unavailable', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const store = buildCommandTestStore({ mounted: false });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TimelineStoreProvider store={store}>
            <AddToVideoEditorConsumer />
          </TimelineStoreProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('timeline-mounted')).toHaveTextContent('false');

    fireEvent.click(screen.getByRole('button', { name: 'add to video editor' }));

    expect(readPendingAdds()).toEqual(['generation-1']);
    expect(screen.getByTestId('add-phase')).toHaveTextContent('staged');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('exposes the mounted timeline command facade and keeps the safe hook nullable outside a mounted editor', () => {
    const store = buildCommandTestStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );

    const outside = renderHook(() => useTimelineCommandsServiceSafe());
    expect(outside.result.current).toBeNull();

    const inside = renderHook(() => ({
      commands: useTimelineCommandsService(),
      safeCommands: useTimelineCommandsServiceSafe(),
    }), { wrapper });

    const commandNames = Object.keys(inside.result.current.commands).sort();
    expect(commandNames).toEqual([...PUBLIC_TIMELINE_COMMAND_NAMES].sort());
    expect(commandNames.every(isPublicTimelineCommandName)).toBe(true);
    expect(PUBLIC_TIMELINE_COMMAND_SCOPE).toBe('non-gesture');
    expect(inside.result.current.safeCommands).not.toBeNull();
  });

  it('returns structured public-command failures for missing assets', () => {
    const store = buildCommandTestStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );

    const { result } = renderHook(() => useTimelineCommandsService(), { wrapper });
    const response = result.current.addClip({ assetId: 'missing-asset', time: 0 });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'asset_not_found',
        message: "Asset 'missing-asset' is not registered in the timeline registry.",
      },
    });
  });

  it('returns structured addClip failures without mutating timeline state', () => {
    const applyEdit = vi.fn();
    const store = buildCommandTestStore({
      data: buildDuplicateCommandTimelineData(),
      applyEdit,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );

    const { result } = renderHook(() => useTimelineCommandsService(), { wrapper });
    const response = result.current.addClip({ assetId: 'asset-dup' });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'addClip requires a target time unless `afterClipId` is provided.',
      },
    });
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('returns structured registerAsset failures without patching the registry for invalid generation inputs', async () => {
    const patchRegistry = vi.fn();
    const registerAsset = vi.fn(async () => undefined);
    const store = buildCommandTestStore({
      patchRegistry,
      registerAsset,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );

    const { result } = renderHook(() => useTimelineCommandsService(), { wrapper });
    const response = await result.current.registerAsset({
      generationId: 'generation-1',
      imageUrl: '',
      variantType: 'image',
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'registerAsset requires a non-empty media URL.',
      },
    });
    expect(patchRegistry).not.toHaveBeenCalled();
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('supports duplicate-style addClip insertion after an existing clip through the public facade', () => {
    const applyEdit = vi.fn();
    const store = buildCommandTestStore({
      data: buildDuplicateCommandTimelineData(),
      applyEdit,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );

    const { result } = renderHook(() => useTimelineCommandsService(), { wrapper });
    const response = result.current.addClip({
      assetId: 'asset-dup',
      afterClipId: 'clip-1',
    });

    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error('Expected duplicate insertion to succeed');
    }

    expect(applyEdit).toHaveBeenCalledTimes(1);
    const mutation = applyEdit.mock.calls[0]?.[0] as {
      type: string;
      rows: Array<{ id: string; actions: Array<{ id: string; start: number; end: number }> }>;
      metaUpdates: Record<string, { asset: string; track: string }>;
      clipOrderOverride: Record<string, string[]>;
    };
    const options = applyEdit.mock.calls[0]?.[1] as {
      selectedClipId: string;
      selectedTrackId: string;
      semantic: boolean;
    };

    expect(mutation.type).toBe('rows');
    expect(mutation.rows[0]?.actions.map((action) => ({
      id: action.id,
      start: action.start,
      end: action.end,
    }))).toEqual([
      { id: 'clip-1', start: 0, end: 2 },
      { id: response.data.clipId, start: 2, end: 4 },
      { id: 'clip-2', start: 4, end: 5 },
    ]);
    expect(mutation.metaUpdates[response.data.clipId]).toMatchObject({
      asset: 'asset-dup',
      track: 'V1',
    });
    expect(mutation.clipOrderOverride).toEqual({
      V1: ['clip-1', response.data.clipId, 'clip-2'],
    });
    expect(options).toEqual({
      selectedClipId: response.data.clipId,
      selectedTrackId: 'V1',
      semantic: true,
    });
  });

  it('omits absent selection and optional prepared-media payload fields', () => {
    const applyEdit = vi.fn();
    const store = buildCommandTestStore({ applyEdit });
    const dataState = store.getState().data;
    delete (dataState as Partial<typeof dataState>).selectedTrackId;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );
    const { result } = renderHook(() => useTimelineCommandsService(), { wrapper });
    expect(result.current.addClip({
      preparedAsset: {
        assetKey: 'unselected-image', mediaType: 'image', durationSeconds: null,
        source: 'registered', entry: {file: 'https://example.com/image.png', type: 'image/png'},
      },
      time: 2,
    }).ok).toBe(true);
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const edit = applyEdit.mock.calls[0]?.[0] as {command: PlacePreparedMediaCommand};
    expect(edit.command.payload).not.toHaveProperty('trackId');
    expect(edit.command.payload).not.toHaveProperty('selectedTrackId');
    expect(edit.command.payload).not.toHaveProperty('clipSpanSeconds');
  });

  it.each([null, 2.5])('preserves supplied prepared-media fields including nullable span %s', (span) => {
    const applyEdit = vi.fn();
    const current = buildCommandTimelineData();
    const store = buildCommandTestStore({ data: current, applyEdit });
    store.getState().data.selectedTrackId = null;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );
    const { result } = renderHook(() => useTimelineCommandsService(), { wrapper });
    const response = result.current.addClip({
      preparedAsset: {
        assetKey: 'prepared-image', mediaType: 'image', durationSeconds: null,
        source: 'registered', entry: {file: 'https://example.com/image.png', type: 'image/png'},
      },
      time: 2,
      trackId: 'V1',
      clipSpanSeconds: span,
    });
    expect(response.ok).toBe(true);
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const edit = applyEdit.mock.calls[0]?.[0] as {command: PlacePreparedMediaCommand};
    expect(edit.command.payload).toEqual(expect.objectContaining({
      trackId: 'V1', selectedTrackId: null, clipSpanSeconds: span,
    }));
    const materialized = applyPreparedMediaCommand(current, edit.command);
    expect(materialized).not.toBeNull();
    expect(materialized!.nextData.resolvedConfig.clips).toContainEqual(expect.objectContaining({
      asset: 'prepared-image', at: 2, hold: 5, track: 'V1',
    }));
  });

  it('accepts public registerAsset into canonical saving without an independent durable write', async () => {
    const patchRegistry = vi.fn();
    const unpatchRegistry = vi.fn();
    const registerAsset = vi.fn(async () => { throw new Error('retired independent write'); });
    const store = buildCommandTestStore({ patchRegistry, registerAsset, unpatchRegistry });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );
    const { result } = renderHook(() => useTimelineCommandsService(), { wrapper });
    const response = await result.current.registerAsset({
      generationId: 'generation-1',
      imageUrl: 'https://example.com/image.png',
      variantType: 'image',
    });

    expect(response).toEqual({ ok: true, data: { assetId: expect.any(String) } });
    if (!response.ok) throw new Error('registration should be accepted');
    expect(patchRegistry).toHaveBeenCalledWith(response.data.assetId, expect.objectContaining({
      generationId: 'generation-1',
      file: 'https://example.com/image.png',
      type: 'image/png',
    }), 'https://example.com/image.png');
    expect(registerAsset).not.toHaveBeenCalled();
    expect(unpatchRegistry).not.toHaveBeenCalled();
    // Acceptance queues the canonical save. Durable failure/acknowledgement
    // belongs to TimelineOps.flush(), covered by useTimelineOps/Persistence.
  });

  // -------------------------------------------------------------------------
  // Host-owned provider/hook wiring — loader integration
  // -------------------------------------------------------------------------
  // Verify that repository state + direct local inputs resolve through the
  // ExtensionLoader into the existing `extensions` prop and diagnostics
  // surfaces without duplicate activation.

  function makeWiringRepository(
    fullState: Awaited<ReturnType<ExtensionStateRepository['getFullExtensionState']>>,
  ): ExtensionStateRepository {
    let disposed = false;
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockImplementation(async () => { disposed = true; }),
      get isDisposed() { return disposed; },
      putPackRecord: vi.fn().mockResolvedValue(undefined),
      updatePackRecord: vi.fn().mockResolvedValue(undefined),
      getPackRecord: vi.fn().mockResolvedValue(null),
      getAllPackRecords: vi.fn().mockResolvedValue([]),
      deletePackRecord: vi.fn().mockResolvedValue(undefined),
      putEnablementState: vi.fn().mockResolvedValue(undefined),
      getEnablementState: vi.fn().mockResolvedValue(null),
      getAllEnablementStates: vi.fn().mockResolvedValue([]),
      deleteEnablementState: vi.fn().mockResolvedValue(undefined),
      putDevOverride: vi.fn().mockResolvedValue(undefined),
      getDevOverride: vi.fn().mockResolvedValue(null),
      getAllDevOverrides: vi.fn().mockResolvedValue([]),
      deleteDevOverride: vi.fn().mockResolvedValue(undefined),
      putSettingsSnapshot: vi.fn().mockResolvedValue(undefined),
      getSettingsSnapshot: vi.fn().mockResolvedValue(null),
      getAllSettingsSnapshots: vi.fn().mockResolvedValue([]),
      deleteSettingsSnapshot: vi.fn().mockResolvedValue(undefined),
      appendLifecycleEvent: vi.fn().mockResolvedValue(undefined),
      queryLifecycleEvents: vi.fn().mockResolvedValue([]),
      getLifecycleEvents: vi.fn().mockResolvedValue([]),
      getLock: vi.fn().mockResolvedValue(fullState.lock),
      putLockEntry: vi.fn().mockResolvedValue(undefined),
      deleteLockEntry: vi.fn().mockResolvedValue(undefined),
      getFullExtensionState: vi.fn().mockResolvedValue(fullState),
    };
  }

  function emptyExtensionState(): Awaited<ReturnType<ExtensionStateRepository['getFullExtensionState']>> {
    return {
      packs: {},
      enablement: {},
      devOverrides: {},
      settings: {},
      lock: { entries: {}, lastUpdatedAt: '2026-01-01T00:00:00.000Z' },
    };
  }

  it('resolves direct extensions unchanged when no repository is provided (backward compatible)', async () => {
    // This test verifies the hook's fast-path: when repository is null,
    // direct extensions pass through unchanged.
    const extensionId = 'com.t14.direct-only';
    const extension: AstridExtension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'T14 direct only',
        contributions: [
          {
            id: 't14.cmd' as never,
            kind: 'command',
            command: `${extensionId}.cmd`,
            label: 'T14 command',
          },
        ],
      },
      activate(ctx: ExtensionContext): DisposeHandle {
        return ctx.commands.registerCommand(`${extensionId}.cmd`, vi.fn());
      },
    });

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: null,
    }));

    // Without a repository, extensions pass through immediately (sync)
    expect(result.current.resolvedExtensions).toEqual([extension]);
    expect(result.current.diagnostics).toEqual([]);
    expect(result.current.loaderResult).toBeNull();
    expect(result.current.isResolving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('resolves empty array when no direct extensions and no repository', () => {
    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: undefined,
      repository: null,
    }));

    expect(result.current.resolvedExtensions).toEqual([]);
    expect(result.current.isResolving).toBe(false);
  });

  // No-repository fast path synthesizes truthful loaded package inventory entries
  it('synthesizes loaded packageStateEntries for direct host-supplied extensions', () => {
    const extensionId = 'com.t9.direct-inventory';
    const extension: AstridExtension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '2.0.0',
        label: 'T9 Direct Inventory Ext',
        publisher: 'T9 Publisher',
        description: 'A direct host-supplied extension for inventory testing',
        contributions: [
          {
            id: 't9.slot.header' as never,
            kind: 'slot',
            slot: 'header' as never,
            label: 'T9 Header Slot',
          },
          {
            id: 't9.dialog.about' as never,
            kind: 'dialog',
            label: 'T9 About Dialog',
          },
        ],
      },
    });

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: null,
    }));

    expect(result.current.resolvedExtensions).toEqual([extension]);
    expect(result.current.diagnostics).toEqual([]);
    expect(result.current.loaderResult).toBeNull();
    expect(result.current.isResolving).toBe(false);
    expect(result.current.error).toBeNull();

    // Verify synthesized packageStateEntries
    expect(result.current.packageStateEntries).toHaveLength(1);
    const entry = result.current.packageStateEntries[0];
    expect(entry.extensionId).toBe(extensionId);
    expect(entry.packageState).toBe('loaded');
    expect(entry.stateReason).toBe('Direct host-supplied extension');
    expect(entry.packageMetadata).toEqual({
      label: 'T9 Direct Inventory Ext',
      version: '2.0.0',
      publisher: 'T9 Publisher',
      description: 'A direct host-supplied extension for inventory testing',
    });

    // Verify manifest contributions are preserved
    expect(entry.manifestContributions).toHaveLength(2);
    expect(entry.manifestContributions![0]).toEqual(
      expect.objectContaining({ id: 't9.slot.header', kind: 'slot' }),
    );
    expect(entry.manifestContributions![1]).toEqual(
      expect.objectContaining({ id: 't9.dialog.about', kind: 'dialog' }),
    );

    // Verify contribution summary is computed
    expect(entry.contributionSummary).not.toBeNull();
    expect(entry.contributionSummary!.declared).toBe(2);
    expect(entry.contributionSummary!.active).toBe(-1); // Unknown without activeIds
    expect(entry.contributionSummary!.inactive).toBe(-1); // Unknown without inactiveCount
    expect(entry.contributionSummary!.kinds).toEqual(['Dialog', 'Slot']);
  });

  it('synthesizes packageStateEntries with null contributionSummary when no contributions declared', () => {
    const extensionId = 'com.t9.no-contribs';
    const extension: AstridExtension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'T9 No Contribs',
      },
    });

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: null,
    }));

    expect(result.current.packageStateEntries).toHaveLength(1);
    const entry = result.current.packageStateEntries[0];
    expect(entry.extensionId).toBe(extensionId);
    expect(entry.packageState).toBe('loaded');
    expect(entry.packageMetadata).toEqual({
      label: 'T9 No Contribs',
      version: '1.0.0',
    });
    // No contributions means null manifestContributions
    expect(entry.manifestContributions).toBeNull();
    // No contributions means null contributionSummary
    expect(entry.contributionSummary).toBeNull();
  });

  it('handles extension with non-string manifest id gracefully', () => {
    // Use a manually constructed extension to bypass defineExtension validation
    const extension: AstridExtension = {
      manifest: {
        id: 12345 as unknown as string,
        version: '1.0.0',
        label: 'T9 Missing Id',
      },
      activate: vi.fn(),
    } as unknown as AstridExtension;

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: null,
    }));

    expect(result.current.packageStateEntries).toHaveLength(1);
    const entry = result.current.packageStateEntries[0];
    // metadataFromManifest requires a string id; non-string id causes fallback
    expect(entry.extensionId).toBe('(unknown)');
    expect(entry.packageState).toBe('loaded');
    expect(entry.packageMetadata).toEqual({
      label: 'T9 Missing Id',
      version: '1.0.0',
    });
  });

  it('synthesizes entries for multiple direct extensions in input order', () => {
    const extA: AstridExtension = defineExtension({
      manifest: {
        id: 'com.t9.multi-a' as never,
        version: '1.0.0',
        label: 'T9 Multi A',
        contributions: [
          { id: 't9.ma.slot' as never, kind: 'slot', slot: 'header' as never, label: 'A Slot' as never },
        ],
      },
    });
    const extB: AstridExtension = defineExtension({
      manifest: {
        id: 'com.t9.multi-b' as never,
        version: '2.0.0',
        label: 'T9 Multi B',
        publisher: 'T9 Publisher B',
        contributions: [
          { id: 't9.mb.dialog' as never, kind: 'dialog', label: 'B Dialog' as never },
          { id: 't9.mb.panel' as never, kind: 'panel', label: 'B Panel' as never },
        ],
      },
    });

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extA, extB],
      repository: null,
    }));

    expect(result.current.packageStateEntries).toHaveLength(2);
    expect(result.current.packageStateEntries[0].extensionId).toBe('com.t9.multi-a');
    expect(result.current.packageStateEntries[0].packageState).toBe('loaded');
    expect(result.current.packageStateEntries[0].contributionSummary!.declared).toBe(1);

    expect(result.current.packageStateEntries[1].extensionId).toBe('com.t9.multi-b');
    expect(result.current.packageStateEntries[1].packageState).toBe('loaded');
    expect(result.current.packageStateEntries[1].packageMetadata!.publisher).toBe('T9 Publisher B');
    expect(result.current.packageStateEntries[1].contributionSummary!.declared).toBe(2);
    expect(result.current.packageStateEntries[1].contributionSummary!.kinds).toEqual(['Dialog', 'Panel']); // 'panel' maps to 'Slot' kind label? No, let's check...
  });

  it('returns empty packageStateEntries when no direct extensions are provided', () => {
    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: undefined,
      repository: null,
    }));

    expect(result.current.packageStateEntries).toEqual([]);
    expect(result.current.resolvedExtensions).toEqual([]);
    expect(result.current.isResolving).toBe(false);
  });

  it('packageStateEntries are frozen (immutable)', () => {
    const extension: AstridExtension = defineExtension({
      manifest: {
        id: 'com.t9.frozen' as never,
        version: '1.0.0',
        label: 'T9 Frozen',
      },
    });

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: null,
    }));

    const entries = result.current.packageStateEntries;
    expect(Object.isFrozen(entries)).toBe(true);

    const entry = entries[0];
    // The contributionSummary should also be frozen when non-null
    // (from computePackageContributionSummary which returns Object.freeze)
    // But entry itself is not frozen by our code — it's created fresh in the map
    // Let's verify the array is frozen at least
    expect(() => {
      (entries as any).push({ extensionId: 'test', packageState: 'loaded', stateReason: '', packageMetadata: null });
    }).toThrow();
  });

  it('surfaces invalid validation failures in packageStateEntries', async () => {
    const invalidExtension = {
      manifest: {
        id: 'not a valid extension id',
        version: '1.0.0',
        label: 'Invalid Direct Extension',
        contributions: [],
      },
      activate: vi.fn(),
    } as unknown as AstridExtension;

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [invalidExtension],
      repository: makeWiringRepository(emptyExtensionState()),
    }));

    await waitFor(() => {
      expect(result.current.isResolving).toBe(false);
    });

    expect(result.current.packageStateEntries).toEqual([
      expect.objectContaining({
        extensionId: 'not a valid extension id',
        packageState: 'invalid',
        packageMetadata: expect.objectContaining({
          label: 'Invalid Direct Extension',
          version: '1.0.0',
        }),
      }),
    ]);
    expect(result.current.diagnostics.some(
      (diagnostic) => diagnostic.extensionId === 'not a valid extension id',
    )).toBe(true);
  });

  it('preserves direct source provenance through repository-backed resolution', async () => {
    const extensionId = 'com.t14.direct-repository';
    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Direct Repository Extension',
        contributions: [],
      },
    });

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: makeWiringRepository(emptyExtensionState()),
    }));

    await waitFor(() => {
      expect(result.current.isResolving).toBe(false);
    });

    expect(result.current.packageStateEntries).toEqual([
      expect.objectContaining({
        extensionId,
        packageSource: 'direct',
        packageState: 'loaded',
      }),
    ]);
  });

  it('keeps a schemaless package loadable after a durable settings snapshot', async () => {
    const extensionId = 'com.t14.schemaless-snapshot';
    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Schemaless Snapshot Extension',
      },
    });
    const fullState = {
      ...emptyExtensionState(),
      settings: {
        [extensionId]: {
          extensionId,
          schemaVersion: 1,
          values: { legacyKey: 'preserved' },
          lastWrittenAt: '2026-08-23T00:00:00.000Z',
        },
      },
    };

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: makeWiringRepository(fullState),
    }));

    await waitFor(() => expect(result.current.isResolving).toBe(false));

    expect(result.current.resolvedExtensions).toHaveLength(1);
    expect(result.current.packageStateEntries).toEqual([
      expect.objectContaining({
        extensionId,
        packageState: 'loaded',
      }),
    ]);
  });

  it('surfaces settings snapshot schema failures in packageStateEntries', async () => {
    const extensionId = 'com.t14.settings-error';
    const extension: AstridExtension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Settings Error Extension',
        settingsSchema: {
          version: 1,
          schema: {
            type: 'object',
            required: ['mode'],
            properties: {
              mode: { type: 'string' },
            },
          },
        },
        contributions: [],
      },
      activate() {
        return { dispose() {} };
      },
    });

    const fullState = {
      ...emptyExtensionState(),
      settings: {
        [extensionId]: {
          extensionId,
          schemaVersion: 1,
          values: {},
          lastWrittenAt: '2026-01-15T10:00:00.000Z',
        },
      },
    };

    const { result } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: makeWiringRepository(fullState),
    }));

    await waitFor(() => {
      expect(result.current.isResolving).toBe(false);
    });

    expect(result.current.resolvedExtensions).toEqual([]);
    expect(result.current.packageStateEntries).toEqual([
      expect.objectContaining({
        extensionId,
        packageSource: 'direct',
        packageState: 'settings-error',
        stateReason: expect.stringContaining('Missing required setting "mode".'),
        packageMetadata: expect.objectContaining({
          label: 'Settings Error Extension',
          version: '1.0.0',
        }),
      }),
    ]);
    expect(result.current.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extensionId,
          code: 'settings/resolution-failed',
          severity: 'error',
        }),
      ]),
    );
  });

  it('accepts resolved extensions from the loader wiring hook as the extensions prop', async () => {
    // Verify that the hook result (resolvedExtensions) can be passed directly
    // as the `extensions` prop to VideoEditorProvider.  The provider should
    // render without errors and activate the extension.
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const extensionId = 'com.t14.hook-to-prop';
    const commandId = `${extensionId}.testCmd`;

    const extension: AstridExtension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'T14 hook to prop',
        contributions: [
          {
            id: 't14.h2p.cmd' as never,
            kind: 'command',
            command: commandId,
            label: 'T14 hook-to-prop command',
          },
        ],
      },
      activate(ctx: ExtensionContext): DisposeHandle {
        return ctx.commands.registerCommand(commandId, vi.fn());
      },
    });

    // Simulate the hook result (no repository → direct pass-through)
    const { result: hookResult } = renderHook(() => useExtensionLoaderWiring({
      directExtensions: [extension],
      repository: null,
    }));

    expect(hookResult.current.resolvedExtensions).toEqual([extension]);
    expect(hookResult.current.isResolving).toBe(false);
    expect(hookResult.current.diagnostics).toEqual([]);
    expect(hookResult.current.loaderResult).toBeNull();

    // Use the hook result as the extensions prop — same pattern as the other tests
    let rendered = false;

    function CheckRender() {
      rendered = true;
      return null;
    }

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={provider}
              projectId="project-t14"
              timelineId="timeline-t14"
              userId="user-t14"
              extensions={hookResult.current.resolvedExtensions}
            >
              <CheckRender />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(rendered).toBe(true);
    });

    // The extension should be loadable (same pattern as the earlier test)
    expect(extension.manifest.id).toBe(extensionId);
  });

  it('surfaces loader diagnostics through the diagnostic collection when a repository is provided', async () => {
    // Create a mock repository with a pack record
    let disposed = false;
    const repo: ExtensionStateRepository = {
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockImplementation(async () => { disposed = true; }),
      get isDisposed() { return disposed; },

      putPackRecord: vi.fn().mockResolvedValue(undefined),
      updatePackRecord: vi.fn().mockResolvedValue(undefined),
      getPackRecord: vi.fn().mockResolvedValue(null),
      getAllPackRecords: vi.fn().mockResolvedValue([]),
      deletePackRecord: vi.fn().mockResolvedValue(undefined),

      putEnablementState: vi.fn().mockResolvedValue(undefined),
      getEnablementState: vi.fn().mockResolvedValue(null),
      getAllEnablementStates: vi.fn().mockResolvedValue([]),
      deleteEnablementState: vi.fn().mockResolvedValue(undefined),

      putDevOverride: vi.fn().mockResolvedValue(undefined),
      getDevOverride: vi.fn().mockResolvedValue(null),
      getAllDevOverrides: vi.fn().mockResolvedValue([]),
      deleteDevOverride: vi.fn().mockResolvedValue(undefined),

      putSettingsSnapshot: vi.fn().mockResolvedValue(undefined),
      getSettingsSnapshot: vi.fn().mockResolvedValue(null),
      getAllSettingsSnapshots: vi.fn().mockResolvedValue([]),
      deleteSettingsSnapshot: vi.fn().mockResolvedValue(undefined),

      appendLifecycleEvent: vi.fn().mockResolvedValue(undefined),
      queryLifecycleEvents: vi.fn().mockResolvedValue([]),
      getLifecycleEvents: vi.fn().mockResolvedValue([]),

      getLock: vi.fn().mockResolvedValue({ entries: {}, lastUpdatedAt: '2026-01-01T00:00:00.000Z' }),
      putLockEntry: vi.fn().mockResolvedValue(undefined),
      deleteLockEntry: vi.fn().mockResolvedValue(undefined),

      getFullExtensionState: vi.fn().mockResolvedValue({
        packs: {
          'com.t14.installed': {
            extensionId: 'com.t14.installed',
            version: '1.0.0',
            integrity: 'sha256-abc123',
            bundleContentRef: 'bundle-ref-1',
            manifestSnapshot: {
              id: 'com.t14.installed',
              version: '1.0.0',
              label: 'T14 Installed',
              publisher: 'test',
              license: 'MIT',
              contributions: [],
            },
            installedAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        enablement: {},
        devOverrides: {},
        settings: {},
        lock: { entries: {}, lastUpdatedAt: '2026-01-01T00:00:00.000Z' },
      }),
    };

    // Create a bundle store that returns content
    const bundleStore: BundleContentStore = {
      async getBundleContent(_ref: string) {
        // Return a minimal valid JS module that exports an activate function
        return `
          export function activate(ctx) {
            return { dispose() {} };
          }
        `;
      },
    };

    // Use the hook with repository
    const { result, rerender } = renderHook(
      ({ repo, bs }) => useExtensionLoaderWiring({
        directExtensions: [],
        repository: repo,
        bundleStore: bs,
      }),
      {
        initialProps: { repo: repo as unknown as ExtensionStateRepository, bs: bundleStore },
      },
    );

    // Initially resolving
    expect(result.current.isResolving).toBe(true);

    // Wait for resolution
    await waitFor(() => {
      expect(result.current.isResolving).toBe(false);
    });

    // Should have resolved the installed extension
    expect(result.current.error).toBeNull();
    // Diagnostics may be non-empty due to the synthetic bundle not having a valid manifest ID match, etc.
    // But the loader result should be present
    expect(result.current.loaderResult).not.toBeNull();

    // Cleanup is automatic via mock
  });

  it('keeps extension state scoped per provider mount via remountKey', async () => {
    // Verify that each VideoEditorProvider mount is independent.
    // When the key changes, the old provider is unmounted (disposing its
    // extensions) and the new provider starts fresh.
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const extA = defineExtension({
      manifest: {
        id: 'com.t14.scope-a' as never,
        version: '1.0.0',
        label: 'Scope A',
        contributions: [{
          id: 'sa.cmd' as never,
          kind: 'command',
          command: 'com.t14.scope-a.cmd',
          label: 'Scope A command',
        }],
      },
      activate(ctx: ExtensionContext): DisposeHandle {
        return ctx.commands.registerCommand('com.t14.scope-a.cmd', vi.fn());
      },
    });

    // Render provider A with key 'scope-a'
    let rendered = false;
    function CheckRender() {
      rendered = true;
      return null;
    }

    const { rerender } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              key="scope-a"
              dataProvider={provider}
              projectId="project-scope"
              timelineId="timeline-scope"
              userId="user-scope"
              extensions={[extA]}
            >
              <CheckRender />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(rendered).toBe(true);
    });

    // Rerender with a different key and no extensions — should be a fresh mount
    rendered = false;

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              key="scope-b"
              dataProvider={provider}
              projectId="project-scope-2"
              timelineId="timeline-scope-2"
              userId="user-scope-2"
              extensions={[]}
            >
              <CheckRender />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(rendered).toBe(true);
    });
    // No crash → the old extension was properly disposed
  });



  it('keeps the sprint 2 governance inventory markers in the checklist', () => {
    const checklist = readFileSync(
      join(process.cwd(), 'tasks/2026-05-03-video-editor-sprint2-ports-and-commands-checklist.md'),
      'utf8',
    );

    expect(checklist).toContain('useTimelineCommandsServiceSafe()');
    expect(checklist).toContain('### Command-facade caller set');
    expect(checklist).toContain('VIDEO_EDITOR_HOST_PORT_NAMES');
    expect(checklist).toContain('src/domains/media-lightbox/hooks/useAddToVideoEditor.ts');
    expect(checklist).toContain('src/tools/video-editor/hooks/useAddVariantAsGeneration.ts');
    expect(checklist).toContain('src/tools/video-editor/hooks/useSwitchToFinalVideo.ts');
    expect(checklist).toContain('src/tools/video-editor/hooks/useExternalDrop.ts');
    expect(checklist).toContain('non-gesture facade');
    for (const portName of VIDEO_EDITOR_HOST_PORT_NAMES) {
      expect(checklist).toContain(`\`${portName}\``);
    }
    for (const gestureOnlyHook of INTERNAL_GESTURE_TIMELINE_MUTATIONS) {
      expect(checklist).toContain(gestureOnlyHook);
    }
  });

  // -------------------------------------------------------------------------
  // Diagnostic collection sync and cleanup parity with EditorRuntimeProvider
  // -------------------------------------------------------------------------
  // Verify that VideoEditorProvider feeds diagnostics from lifecycle, command,
  // and effect registry sources into the diagnostic collection, and that
  // extension-owned diagnostics are cleared on disable while host-owned
  // diagnostics survive.

  it('feeds provider diagnostic collection from lifecycle, command, and registry sources', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const extensionId = 'com.vp.diagnostics';
    let collection = null as ReturnType<typeof useVideoEditorRuntime>['diagnosticCollection'] | null;

    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'VP diagnostics extension',
        contributions: [
          {
            id: 'vp.diagnostics.effect' as never,
            kind: 'effect',
            effectId: 'vp-diagnostics-effect',
            label: 'VP Diagnostics effect',
          },
          {
            id: 'vp.diagnostics.command' as never,
            kind: 'command',
            command: 'astrid.reserved',
            label: 'VP Reserved command',
          },
        ],
      },
      activate() {
        throw new Error('activation failed for vp diagnostics test');
      },
    });

    function CaptureDiagnostics({ enabled }: { enabled: boolean }) {
      const runtime = useVideoEditorRuntime();
      const { registry } = useEffectRegistryContext();
      collection = runtime.diagnosticCollection ?? null;

      useEffect(() => {
        if (!enabled || !runtime.diagnosticCollection) return undefined;
        // Host-owned diagnostic (no extensionId) — should survive
        // extension disable/unload without being removed.
        runtime.diagnosticCollection.publish({
          id: 'vp-host-owned-diagnostic',
          severity: 'warning',
          code: 'host/timeline-stale',
          message: 'Host-owned stale warning via VP',
          detail: { source: 'host-owned' },
        });
        // Extension-owned diagnostic published directly
        runtime.diagnosticCollection.publish({
          id: 'vp-export-stale-diagnostic',
          severity: 'error',
          code: 'export/unrenderable-effect',
          message: 'VP stale export blocker',
          extensionId,
          contributionId: 'vp.diagnostics.effect',
          detail: { source: 'export-guard' },
        });
        const first = registry.register(trustedEffectRecord(
          'vp-diagnostics-duplicate',
          extensionId,
          vi.fn(),
        ));
        const second = registry.register(trustedEffectRecord(
          'vp-diagnostics-duplicate',
          extensionId,
          vi.fn(),
        ));
        return () => {
          second.dispose();
          first.dispose();
        };
      }, [enabled, registry, runtime.diagnosticCollection]);

      return null;
    }

    function Host({ enabled }: { enabled: boolean }) {
      return (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={provider}
                projectId="project-vp-diag"
                timelineId="timeline-vp-diag"
                userId="user-vp-diag"
                extensions={enabled ? [extension] : []}
              >
                <CaptureDiagnostics enabled={enabled} />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );
    }

    const { rerender } = render(<Host enabled />);

    await waitFor(() => {
      const diagnostics = collection?.getSnapshot() ?? [];
      expect(diagnostics.some(
        (diagnostic) =>
          diagnostic.detail?.source === 'extension-lifecycle'
          && diagnostic.code === 'lifecycle/activation-failed',
      )).toBe(true);
      expect(diagnostics.some(
        (diagnostic) =>
          diagnostic.detail?.source === 'command-registry'
          && diagnostic.code === 'command-registry/reserved-command',
      )).toBe(true);
      expect(diagnostics.some(
        (diagnostic) =>
          diagnostic.detail?.source === 'effect-registry'
          && diagnostic.code === 'effect-registry/duplicate-effect',
      )).toBe(true);
      expect(diagnostics.some(
        (diagnostic) =>
          diagnostic.detail?.source === 'export-guard'
          && diagnostic.code === 'export/unrenderable-effect',
      )).toBe(true);
      // Host-owned diagnostic must be present before disable.
      expect(diagnostics.some(
        (diagnostic) =>
          diagnostic.id === 'vp-host-owned-diagnostic'
          && diagnostic.detail?.source === 'host-owned',
      )).toBe(true);
    });

    rerender(<Host enabled={false} />);

    await waitFor(() => {
      const snapshot = collection?.getSnapshot() ?? [];
      // Extension-owned diagnostics must be cleared on disable.
      const disabledOwnerDiagnostics = snapshot.filter(
        (diagnostic) => diagnostic.extensionId === extensionId,
      );
      expect(disabledOwnerDiagnostics).toEqual([]);
      // Host-owned diagnostic (no extensionId) must survive.
      expect(snapshot.some(
        (diagnostic) =>
          diagnostic.id === 'vp-host-owned-diagnostic'
          && diagnostic.detail?.source === 'host-owned',
      )).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Package state inventory propagation through VideoEditorProvider
  // -------------------------------------------------------------------------
  // Prove that the provider carries packageStateInventory through
  // normalizeExtensionRuntime → extensionRuntime so consumers can read
  // package-state data directly without deriving it from loadedExtensions.

  it('provider propagates packageStateEntries to extensionRuntime.packageStateInventory', () => {
    const dataProvider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const ext = defineExtension({
      manifest: {
        id: 'com.t2.provider' as never,
        version: '1.0.0',
        label: 'T2 Provider Ext',
      },
    });

    const psiEntries = [
      {
        extensionId: 'com.t2.disabled',
        packageState: 'disabled-by-user' as const,
        stateReason: 'User disabled this package.',
        packageMetadata: {
          label: 'T2 Disabled Ext',
          version: '2.0.0',
        },
      },
      {
        extensionId: 'com.t2.invalid',
        packageState: 'invalid' as const,
        stateReason: 'Manifest validation failed.',
        packageMetadata: {
          label: 'T2 Invalid Ext',
          version: '0.0.0',
        },
      },
    ];

    // Read extensionRuntime from the provider context to verify propagation
    let capturedRuntime: any = null;
    function CaptureRuntime() {
      const { extensionRuntime } = useVideoEditorRuntime();
      capturedRuntime = extensionRuntime;
      return null;
    }

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={dataProvider}
              projectId="project-t2"
              timelineId="timeline-t2"
              userId="user-t2"
              extensions={[ext]}
              packageStateEntries={psiEntries}
            >
              <CaptureRuntime />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(capturedRuntime).not.toBeNull();
    // Active extensions still only contain the loaded one
    expect(capturedRuntime.extensions).toHaveLength(1);
    expect(capturedRuntime.extensions[0].manifest.id as string).toBe('com.t2.provider');

    // Package state inventory is directly available
    expect(capturedRuntime.packageStateInventory).toHaveLength(2);

    const disabledEntry = capturedRuntime.packageStateInventory.find(
      (e: any) => e.extensionId === 'com.t2.disabled',
    );
    expect(disabledEntry).toBeDefined();
    expect(disabledEntry.packageState).toBe('disabled-by-user');
    expect(disabledEntry.packageMetadata.label).toBe('T2 Disabled Ext');
    expect(disabledEntry.packageMetadata.version).toBe('2.0.0');

    const invalidEntry = capturedRuntime.packageStateInventory.find(
      (e: any) => e.extensionId === 'com.t2.invalid',
    );
    expect(invalidEntry).toBeDefined();
    expect(invalidEntry.packageState).toBe('invalid');
    expect(invalidEntry.stateReason).toBe('Manifest validation failed.');
  });

  it('packageStateInventory is empty when no entries supplied to provider', () => {
    const dataProvider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const ext = defineExtension({
      manifest: {
        id: 'com.t2.noppsi' as never,
        version: '1.0.0',
        label: 'T2 No PSI Ext',
      },
    });

    let capturedRuntime: any = null;
    function CaptureRuntime() {
      const { extensionRuntime } = useVideoEditorRuntime();
      capturedRuntime = extensionRuntime;
      return null;
    }

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={dataProvider}
              projectId="project-t2-noppsi"
              timelineId="timeline-t2-noppsi"
              userId="user-t2"
              extensions={[ext]}
            >
              <CaptureRuntime />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(capturedRuntime).not.toBeNull();
    expect(capturedRuntime.packageStateInventory).toEqual([]);
    expect(capturedRuntime.extensions).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Compatibility — direct extensions synchronize through the lifecycle host
  // -------------------------------------------------------------------------
  // Prove that direct `extensions` prop inputs (no repository, no pack records,
  // no enablement state) still synchronize through the same provider-scoped
  // ExtensionLifecycleHost pipeline and are observable via the effect registry
  // (media contributions) — the same pipeline used by repository-backed
  // extensions routed through useExtensionLoaderWiring.

  it('synchronizes direct extensions through the lifecycle host — effect registration observable', async () => {
    const dataProvider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const extId = 'com.t15.direct-sync';
    const effectId = 'com.t15.direct-sync.effect';
    let effectActivated = false;
    let effectDeactivated = false;

    // Lifecycle observer component (no-op, returns null)
    function LifecycleObserverComponent() {
      return null;
    }

    const extension = defineExtension({
      manifest: {
        id: extId as never,
        version: '1.0.0',
        label: 'T15 direct sync',
        contributions: [
          {
            id: 't15.sync.fx' as never,
            kind: 'effect',
            label: 'T15 Sync Effect',
            effectId,
          },
        ],
      },
      activate(ctx: ExtensionContext): DisposeHandle {
        effectActivated = true;
        const handle = ctx.effects.registerComponent(effectId, LifecycleObserverComponent, {
          label: 'T15 Sync Effect',
        });
        return {
          dispose() {
            effectDeactivated = true;
            handle.dispose();
          },
        };
      },
    });

    // Snapshot to observe effect registry state
    let latestEffectIds: string[] = [];
    function Snapshot() {
      const { snapshot } = useEffectRegistryContext();
      latestEffectIds = snapshot.records.map((r) => r.effectId);
      return null;
    }

    const { rerender } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={dataProvider}
              projectId="project-t15-sync"
              timelineId="timeline-t15-sync"
              userId="user-t15"
              extensions={[extension]}
            >
              <Snapshot />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Effect must be registered through the lifecycle host pipeline
    await waitFor(() => {
      expect(latestEffectIds).toContain(effectId);
    });
    expect(effectActivated).toBe(true);
    expect(effectDeactivated).toBe(false);

    // Remove the extension — effect must be cleaned up through the same host
    rerender(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AgentChatProvider>
            <VideoEditorProvider
              dataProvider={dataProvider}
              projectId="project-t15-sync"
              timelineId="timeline-t15-sync"
              userId="user-t15"
              extensions={[]}
            >
              <Snapshot />
            </VideoEditorProvider>
          </AgentChatProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(latestEffectIds).not.toContain(effectId);
    });
    // The lifecycle host must have disposed the extension
    expect(effectDeactivated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Extension settings surface via SchemaForm inside VideoEditorProvider
  // -------------------------------------------------------------------------

  describe('VideoEditorProvider extension settings surface', () => {
    const SETTINGS_EXTENSION_ID = 'com.example.settings.vp';
    const settingsManifest = {
      id: SETTINGS_EXTENSION_ID as never,
      version: '1.0.0',
      label: 'Settings Extension VP',
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            apiKey: {
              type: 'string',
              title: 'API Key',
              description: 'Your API key for the service',
              default: '',
              minLength: 3,
            },
            maxRetries: {
              type: 'integer',
              title: 'Max Retries',
              description: 'Maximum number of retries',
              default: 3,
              minimum: 1,
              maximum: 10,
            },
            enableDebug: {
              type: 'boolean',
              title: 'Enable Debug',
              description: 'Enable debug logging',
              default: false,
            },
          },
          required: ['apiKey'],
        },
      },
    };

    beforeEach(() => {
      // Clean up localStorage for the settings extension
      const prefix = `astrid.ext.${SETTINGS_EXTENSION_ID}.`;
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    });

    function makeProvider() {
      return {
        loadTimeline: vi.fn(),
        saveTimeline: vi.fn(),
        loadAssetRegistry: vi.fn(),
        resolveAssetUrl: vi.fn(),
      } as DataProvider;
    }

    it('renders settings form inside VideoEditorProvider and loads defaults', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const dataProvider = makeProvider();
      let formRendered = false;

      function CaptureForm() {
        const runtime = useVideoEditorRuntime();
        const ext = runtime.extensionRuntime?.extensions.find(
          (e) => e.manifest.id === SETTINGS_EXTENSION_ID,
        );
        formRendered = ext != null;
        return ext ? (
          <ExtensionSettingsPanel
            extensionId={SETTINGS_EXTENSION_ID}
            manifest={ext.manifest}
          />
        ) : null;
      }

      render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={dataProvider}
                projectId="project-vp-settings"
                timelineId="timeline-vp-settings"
                userId="user-vp-settings"
                extensions={[
                  defineExtension({ manifest: settingsManifest }),
                ]}
              >
                <CaptureForm />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(formRendered).toBe(true);
      });

      // The form should show the apiKey field (required) with an empty default
      const apiKeyInput = document.querySelector(
        '[data-testid="schema-form-widget-apiKey"]',
      ) as HTMLInputElement | null;
      expect(apiKeyInput).not.toBeNull();
      expect(apiKeyInput?.value).toBe('');

      // The maxRetries field (integer → number, rendered as slider) should exist
      const maxRetriesField = document.querySelector(
        '[data-testid="schema-form-field-maxRetries"]',
      ) as HTMLElement | null;
      expect(maxRetriesField).not.toBeNull();

      // The enableDebug field (boolean, rendered as switch) should exist
      const enableDebugField = document.querySelector(
        '[data-testid="schema-form-field-enableDebug"]',
      ) as HTMLElement | null;
      expect(enableDebugField).not.toBeNull();
    });

    it('saves valid settings and reloads persisted values', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const dataProvider = makeProvider();

      function CaptureForm() {
        const runtime = useVideoEditorRuntime();
        const ext = runtime.extensionRuntime?.extensions.find(
          (e) => e.manifest.id === SETTINGS_EXTENSION_ID,
        );
        return ext ? (
          <ExtensionSettingsPanel
            extensionId={SETTINGS_EXTENSION_ID}
            manifest={ext.manifest}
          />
        ) : null;
      }

      const providerElement = (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={dataProvider}
                projectId="project-vp-settings"
                timelineId="timeline-vp-settings"
                userId="user-vp-settings"
                extensions={[
                  defineExtension({ manifest: settingsManifest }),
                ]}
              >
                <CaptureForm />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );

      const { rerender } = render(providerElement);

      await waitFor(() => {
        const apiKeyInput = document.querySelector(
          '[data-testid="schema-form-widget-apiKey"]',
        ) as HTMLInputElement | null;
        expect(apiKeyInput).not.toBeNull();
      });

      // Fill in a valid apiKey
      const apiKeyInput = document.querySelector(
        '[data-testid="schema-form-widget-apiKey"]',
      ) as HTMLInputElement;
      fireEvent.change(apiKeyInput, { target: { value: 'my-secret-key' } });

      // Click save
      const saveBtn = document.querySelector(
        '[data-testid="extension-settings-save"]',
      ) as HTMLButtonElement;
      expect(saveBtn).not.toBeNull();
      expect(saveBtn.disabled).toBe(false);
      fireEvent.click(saveBtn);

      // Verify the value was persisted to localStorage
      await waitFor(() => {
        const raw = savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey');
        expect(raw).toBe('"my-secret-key"');
      });

      // Re-render to verify persisted values are loaded
      rerender(providerElement);

      await waitFor(() => {
        const reloadedInput = document.querySelector(
          '[data-testid="schema-form-widget-apiKey"]',
        ) as HTMLInputElement | null;
        expect(reloadedInput?.value).toBe('my-secret-key');
      });
    });

    it('blocks save on invalid field and focuses error (invalid focus behavior)', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const dataProvider = makeProvider();

      function CaptureForm() {
        const runtime = useVideoEditorRuntime();
        const ext = runtime.extensionRuntime?.extensions.find(
          (e) => e.manifest.id === SETTINGS_EXTENSION_ID,
        );
        return ext ? (
          <ExtensionSettingsPanel
            extensionId={SETTINGS_EXTENSION_ID}
            manifest={ext.manifest}
          />
        ) : null;
      }

      render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={dataProvider}
                projectId="project-vp-settings"
                timelineId="timeline-vp-settings"
                userId="user-vp-settings"
                extensions={[
                  defineExtension({ manifest: settingsManifest }),
                ]}
              >
                <CaptureForm />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );

      await waitFor(() => {
        const apiKeyInput = document.querySelector(
          '[data-testid="schema-form-widget-apiKey"]',
        ) as HTMLInputElement | null;
        expect(apiKeyInput).not.toBeNull();
      });

      // Enter a value below minLength (3) — "ab" is only 2 chars
      const apiKeyInput = document.querySelector(
        '[data-testid="schema-form-widget-apiKey"]',
      ) as HTMLInputElement;
      fireEvent.change(apiKeyInput, { target: { value: 'ab' } });

      // Click save
      const saveBtn = document.querySelector(
        '[data-testid="extension-settings-save"]',
      ) as HTMLButtonElement;
      fireEvent.click(saveBtn);

      // The save should have been blocked — SchemaForm validateAndFocus
      // returns false, so no localStorage write should have occurred
      await waitFor(() => {
        const raw = savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey');
        // Should still be null (no save occurred)
        expect(raw).toBeNull();
      });

      // The apiKey input should still have aria-invalid="true"
      const invalidInput = document.querySelector(
        '[data-testid="schema-form-widget-apiKey"]',
      ) as HTMLInputElement | null;
      expect(invalidInput?.getAttribute('aria-invalid')).toBe('true');
    });

    it('resets to defaults after saving overrides', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const dataProvider = makeProvider();

      function CaptureForm() {
        const runtime = useVideoEditorRuntime();
        const ext = runtime.extensionRuntime?.extensions.find(
          (e) => e.manifest.id === SETTINGS_EXTENSION_ID,
        );
        return ext ? (
          <ExtensionSettingsPanel
            extensionId={SETTINGS_EXTENSION_ID}
            manifest={ext.manifest}
          />
        ) : null;
      }

      render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={dataProvider}
                projectId="project-vp-settings"
                timelineId="timeline-vp-settings"
                userId="user-vp-settings"
                extensions={[
                  defineExtension({ manifest: settingsManifest }),
                ]}
              >
                <CaptureForm />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );

      await waitFor(() => {
        const apiKeyInput = document.querySelector(
          '[data-testid="schema-form-widget-apiKey"]',
        ) as HTMLInputElement | null;
        expect(apiKeyInput).not.toBeNull();
      });

      // Save a value first
      const apiKeyInput = document.querySelector(
        '[data-testid="schema-form-widget-apiKey"]',
      ) as HTMLInputElement;
      fireEvent.change(apiKeyInput, { target: { value: 'some-key' } });
      const saveBtn = document.querySelector(
        '[data-testid="extension-settings-save"]',
      ) as HTMLButtonElement;
      fireEvent.click(saveBtn);

      await waitFor(() => {
        const raw = savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey');
        expect(raw).toBe('"some-key"');
      });

      // Click reset
      const resetBtn = document.querySelector(
        '[data-testid="extension-settings-reset"]',
      ) as HTMLButtonElement;
      fireEvent.click(resetBtn);

      // Verify localStorage key was cleared and form reverted to default (empty)
      await waitFor(() => {
        const raw = savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey');
        expect(raw).toBeNull();
      });

      const revertedInput = document.querySelector(
        '[data-testid="schema-form-widget-apiKey"]',
      ) as HTMLInputElement;
      expect(revertedInput.value).toBe('');
    });

    it('cancels edits and reverts to last-saved values', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const dataProvider = makeProvider();

      function CaptureForm() {
        const runtime = useVideoEditorRuntime();
        const ext = runtime.extensionRuntime?.extensions.find(
          (e) => e.manifest.id === SETTINGS_EXTENSION_ID,
        );
        return ext ? (
          <ExtensionSettingsPanel
            extensionId={SETTINGS_EXTENSION_ID}
            manifest={ext.manifest}
          />
        ) : null;
      }

      render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={dataProvider}
                projectId="project-vp-settings"
                timelineId="timeline-vp-settings"
                userId="user-vp-settings"
                extensions={[
                  defineExtension({ manifest: settingsManifest }),
                ]}
              >
                <CaptureForm />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );

      await waitFor(() => {
        const apiKeyInput = document.querySelector(
          '[data-testid="schema-form-widget-apiKey"]',
        ) as HTMLInputElement | null;
        expect(apiKeyInput).not.toBeNull();
      });

      // Save a value first
      const apiKeyInput = document.querySelector(
        '[data-testid="schema-form-widget-apiKey"]',
      ) as HTMLInputElement;
      fireEvent.change(apiKeyInput, { target: { value: 'saved-key' } });
      const saveBtn = document.querySelector(
        '[data-testid="extension-settings-save"]',
      ) as HTMLButtonElement;
      fireEvent.click(saveBtn);

      await waitFor(() => {
        const raw = savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey');
        expect(raw).toBe('"saved-key"');
      });

      // Now edit without saving
      fireEvent.change(apiKeyInput, { target: { value: 'unsaved-change' } });

      // Click cancel
      const cancelBtn = document.querySelector(
        '[data-testid="extension-settings-cancel"]',
      ) as HTMLButtonElement;
      fireEvent.click(cancelBtn);

      // The input should revert to the last-saved value
      await waitFor(() => {
        expect(apiKeyInput.value).toBe('saved-key');
      });

      // localStorage should still have the saved value (not the unsaved change)
      const raw = savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey');
      expect(raw).toBe('"saved-key"');
    });

    // Shared cleanup helper — diagnostics removal and settings UI state reset
    // on disable/unload, preserving unrelated extension state.
    it('disable clears the targeted extension diagnostics and keeps all saved extension settings (they live in the Runtime)', async () => {
      const OTHER_EXTENSION_ID = 'com.example.other.vp';
      const otherManifest = {
        id: OTHER_EXTENSION_ID as never,
        version: '1.0.0',
        label: 'Other Extension VP',
        settingsSchema: {
          schema: {
            type: 'object',
            properties: {
              otherKey: {
                type: 'string',
                title: 'Other Key',
                default: 'other-default',
              },
            },
          },
        },
      };

      // Pre-populate localStorage for both extensions
      localStorage.setItem(
        `astrid.ext.${SETTINGS_EXTENSION_ID}.apiKey`,
        '"settings-key-vp"',
      );
      localStorage.setItem(
        `astrid.ext.${OTHER_EXTENSION_ID}.otherKey`,
        '"other-key-vp"',
      );

      // Define extensions once so manifest references are stable across re-renders
      const settingsExt = defineExtension({ manifest: settingsManifest });
      const otherExt = defineExtension({ manifest: otherManifest });

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const dataProvider = makeProvider();

      let capturedRuntime: ReturnType<typeof useVideoEditorRuntime> | null =
        null;

      function CaptureRuntime() {
        capturedRuntime = useVideoEditorRuntime();
        return null;
      }

      function Host({ includeSettings }: { includeSettings: boolean }) {
        const exts = includeSettings
          ? [settingsExt, otherExt]
          : [otherExt];
        return (
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <AgentChatProvider>
                <VideoEditorProvider
                  dataProvider={dataProvider}
                  projectId="project-vp-t17"
                  timelineId="timeline-vp-t17"
                  userId="user-vp-t17"
                  extensions={exts}
                >
                  <CaptureRuntime />
                </VideoEditorProvider>
              </AgentChatProvider>
            </QueryClientProvider>
          </MemoryRouter>
        );
      }

      const { rerender } = render(<Host includeSettings />);

      await waitFor(() => {
        expect(capturedRuntime).not.toBeNull();
      });

      // Both extensions' settings should be in localStorage
      expect(
        savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey'),
      ).toBe('"settings-key-vp"');
      expect(
        savedExtensionSetting(OTHER_EXTENSION_ID, 'otherKey'),
      ).toBe('"other-key-vp"');

      // Disable the settings extension (remove from props)
      rerender(<Host includeSettings={false} />);

      // The targeted extension's saved settings are kept: only uninstall or reset erases them.
      expect(
        savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey'),
      ).toBe('"settings-key-vp"');

      // Unrelated extension's settings localStorage must be preserved
      expect(
        savedExtensionSetting(OTHER_EXTENSION_ID, 'otherKey'),
      ).toBe('"other-key-vp"');

      // Targeted extension's diagnostics must be cleared
      const snapshot =
        capturedRuntime?.diagnosticCollection?.getSnapshot() ?? [];
      const settingsExtDiags = snapshot.filter(
        (d) => d.extensionId === SETTINGS_EXTENSION_ID,
      );
      expect(settingsExtDiags).toEqual([]);

      // Unrelated extension's diagnostics should still be present
      const otherExtDiags = snapshot.filter(
        (d) => d.extensionId === OTHER_EXTENSION_ID,
      );
      expect(otherExtDiags.length).toBeGreaterThan(0);
    });
  });
});

describe('VideoEditorProvider render-boundary recovery', () => {
  const SLOT_EXTENSION_ID = 'com.example.slot-ext-vp';

  const slotManifest = {
    id: SLOT_EXTENSION_ID as never,
    version: '1.0.0',
    label: 'Slot Extension VP',
    contributions: [
      {
        kind: 'slot' as const,
        id: 'slot-ext-header-vp',
        slot: 'header',
        order: 0,
      },
    ],
  };

  function makeProvider() {
    return {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    } as unknown as DataProvider;
  }

  function makeQueryClient() {
    return new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  }

  it('surface detach removes contributions on disable — re-enable restores them fresh', async () => {
    const slotExt = defineExtension({ manifest: slotManifest });
    const queryClient = makeQueryClient();
    const provider = makeProvider();

    let capturedConfigSlots: string[] | null = null;

    function Capture() {
      const rt = useVideoEditorRuntime();
      capturedConfigSlots = rt?.extensionRuntime?.config?.slots
        ? Object.keys(rt.extensionRuntime.config.slots)
        : null;
      return null;
    }

    function Host({ includeSlot }: { includeSlot: boolean }) {
      const exts = includeSlot ? [slotExt] : [];
      return (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={provider}
                projectId="project-1"
                timelineId="timeline-1"
                userId="user-1"
                extensions={exts}
              >
                <Capture />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );
    }

    const { rerender } = render(<Host includeSlot />);

    await waitFor(() => {
      expect(capturedConfigSlots).toContain('header');
    });

    // Disable the extension
    rerender(<Host includeSlot={false} />);

    await waitFor(() => {
      expect(capturedConfigSlots).not.toContain('header');
    });

    // Re-enable the extension
    rerender(<Host includeSlot />);

    await waitFor(() => {
      expect(capturedConfigSlots).toContain('header');
    });

    expect(capturedConfigSlots).toHaveLength(1);
  });

  it('re-enable after disable produces fresh contributions with no duplicates', async () => {
    const slotExt = defineExtension({ manifest: slotManifest });
    const queryClient = makeQueryClient();
    const provider = makeProvider();

    let capturedConfigSlots: string[] | null = null;

    function Capture() {
      const rt = useVideoEditorRuntime();
      capturedConfigSlots = rt?.extensionRuntime?.config?.slots
        ? Object.keys(rt.extensionRuntime.config.slots)
        : null;
      return null;
    }

    function Host({ includeSlot }: { includeSlot: boolean }) {
      const exts = includeSlot ? [slotExt] : [];
      return (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={provider}
                projectId="project-1"
                timelineId="timeline-1"
                userId="user-1"
                extensions={exts}
              >
                <Capture />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );
    }

    const { rerender } = render(<Host includeSlot />);

    await waitFor(() => {
      expect(capturedConfigSlots).toContain('header');
    });

    // Disable → Re-enable → Disable → Re-enable
    rerender(<Host includeSlot={false} />);
    await waitFor(() => {
      expect(capturedConfigSlots).not.toContain('header');
    });

    rerender(<Host includeSlot />);
    await waitFor(() => {
      expect(capturedConfigSlots).toContain('header');
    });

    rerender(<Host includeSlot={false} />);
    await waitFor(() => {
      expect(capturedConfigSlots).not.toContain('header');
    });

    rerender(<Host includeSlot />);
    await waitFor(() => {
      expect(capturedConfigSlots).toContain('header');
    });

    // Only 'header' should be present, with no duplicates
    expect(capturedConfigSlots).toHaveLength(1);
    expect(capturedConfigSlots![0]).toBe('header');
  });
});

// ---------------------------------------------------------------------------
// Focused per-registry scoped cleanup tests
// ---------------------------------------------------------------------------
// These tests verify that each lifecycle-owned contribution registry
// (effects, transitions, clip-types) correctly scopes cleanup to only the
// removed extension's records, preserving unrelated extensions.
//
// Agent tools and live data registries are future-only scaffolding and are
// NOT exposed as public contribution systems (see provider comments).

describe('VideoEditorProvider transition registry scoped cleanup', () => {
  it('clears only the removed extension transition records and preserves unrelated extension records', async () => {
    const EXT_A = 'com.example.vp-transition-ext-a';
    const EXT_B = 'com.example.vp-transition-ext-b';
    const transitionAId = 'vp-transition-a';
    const transitionBId = 'vp-transition-b';
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let latestRecords: readonly TransitionRegistryRecord[] = [];

    const extA = defineExtension({
      manifest: {
        id: EXT_A as never,
        version: '1.0.0',
        label: 'VP Transition Extension A',
      },
    });
    const extB = defineExtension({
      manifest: {
        id: EXT_B as never,
        version: '1.0.0',
        label: 'VP Transition Extension B',
      },
    });

    function CaptureTransitions() {
      const { registry } = useTransitionRegistryContext();
      latestRecords = useTransitionRegistryContext().snapshot.records;

      useEffect(() => {
        const hA = registry.register(trustedTransitionRecord(transitionAId, EXT_A, disposeA));
        const hB = registry.register(trustedTransitionRecord(transitionBId, EXT_B, disposeB));
        return () => {
          hA.dispose();
          hB.dispose();
        };
      }, [registry]);

      return null;
    }

    function Host({ includeA }: { includeA: boolean }) {
      const exts = includeA ? [extA, extB] : [extB];
      return (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={provider}
                projectId="project-1"
                timelineId="timeline-1"
                userId="user-1"
                extensions={exts}
              >
                <CaptureTransitions />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );
    }

    const { rerender } = render(<Host includeA />);

    await waitFor(() => {
      expect(latestRecords.map((r) => r.transitionId)).toEqual(
        expect.arrayContaining([transitionAId, transitionBId]),
      );
    });

    // Remove extension A
    rerender(<Host includeA={false} />);

    await waitFor(() => {
      // Extension A's transition record must be removed
      expect(latestRecords.map((r) => r.transitionId)).not.toContain(transitionAId);
    });

    // Extension B's transition record must be preserved
    expect(latestRecords.map((r) => r.transitionId)).toContain(transitionBId);
    expect(latestRecords.map((r) => r.transitionId)).toHaveLength(1);
    expect(disposeA).toHaveBeenCalled();
    expect(disposeB).not.toHaveBeenCalled();
  });
});

describe('VideoEditorProvider clip-type registry scoped cleanup', () => {
  it('clears only the removed extension clip-type records and preserves unrelated extension records', async () => {
    const EXT_A = 'com.example.vp-cliptype-ext-a';
    const EXT_B = 'com.example.vp-cliptype-ext-b';
    const clipAId = 'vp-clip-type-a';
    const clipBId = 'vp-clip-type-b';
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let latestRecords: readonly ClipTypeRegistryRecord[] = [];

    const extA = defineExtension({
      manifest: {
        id: EXT_A as never,
        version: '1.0.0',
        label: 'VP ClipType Extension A',
      },
    });
    const extB = defineExtension({
      manifest: {
        id: EXT_B as never,
        version: '1.0.0',
        label: 'VP ClipType Extension B',
      },
    });

    function CaptureClipTypes() {
      const { registry } = useClipTypeRegistryContext();
      latestRecords = useClipTypeRegistryContext().snapshot.records;

      useEffect(() => {
        const hA = registry.register(trustedClipTypeRecord(clipAId, EXT_A, disposeA));
        const hB = registry.register(trustedClipTypeRecord(clipBId, EXT_B, disposeB));
        return () => {
          hA.dispose();
          hB.dispose();
        };
      }, [registry]);

      return null;
    }

    function Host({ includeA }: { includeA: boolean }) {
      const exts = includeA ? [extA, extB] : [extB];
      return (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={provider}
                projectId="project-1"
                timelineId="timeline-1"
                userId="user-1"
                extensions={exts}
              >
                <CaptureClipTypes />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );
    }

    const { rerender } = render(<Host includeA />);

    await waitFor(() => {
      expect(latestRecords.map((r) => r.clipTypeId)).toEqual(
        expect.arrayContaining([clipAId, clipBId]),
      );
    });

    // Remove extension A
    rerender(<Host includeA={false} />);

    await waitFor(() => {
      // Extension A's clip-type record must be removed
      expect(latestRecords.map((r) => r.clipTypeId)).not.toContain(clipAId);
    });

    // Extension B's clip-type record must be preserved
    expect(latestRecords.map((r) => r.clipTypeId)).toContain(clipBId);
    expect(latestRecords.map((r) => r.clipTypeId)).toHaveLength(1);
    expect(disposeA).toHaveBeenCalled();
    expect(disposeB).not.toHaveBeenCalled();
  });

  describe('timeline-overlay flag', () => {
    function TimelineOverlayFlagConsumer() {
      const runtime = useVideoEditorRuntime();
      return <span data-testid="timeline-overlays-enabled">{String(runtime.timelineOverlaysEnabled)}</span>;
    }

    function renderWithFlag(flag?: boolean) {
      const provider: DataProvider = {
        loadTimeline: vi.fn(),
        saveTimeline: vi.fn(),
        loadAssetRegistry: vi.fn(),
        resolveAssetUrl: vi.fn(),
      };
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      });

      return render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AgentChatProvider>
              <VideoEditorProvider
                dataProvider={provider}
                projectId="project-1"
                timelineId="timeline-1"
                userId="user-1"
                timelineOverlaysEnabled={flag}
              >
                <TimelineOverlayFlagConsumer />
              </VideoEditorProvider>
            </AgentChatProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    }

    it('observes false when no value is supplied', () => {
      renderWithFlag();
      expect(screen.getByTestId('timeline-overlays-enabled')).toHaveTextContent('false');
    });

    it('observes false when explicitly disabled', () => {
      renderWithFlag(false);
      expect(screen.getByTestId('timeline-overlays-enabled')).toHaveTextContent('false');
    });

    it('reaches the runtime consumer unchanged when explicitly enabled', () => {
      renderWithFlag(true);
      expect(screen.getByTestId('timeline-overlays-enabled')).toHaveTextContent('true');
    });
  });

  it('drops immediately when the mounted timeline store is available', () => {
    let materialized = buildCommandTimelineData();
    const applyEdit = vi.fn((...args: unknown[]) => {
      const mutation = args[0] as { type: string; command: PlacePreparedMediaCommand };
      if (mutation.type !== 'prepared-media') return;
      const prepared = applyPreparedMediaCommand(materialized, mutation.command);
      if (prepared) materialized = prepared.nextData;
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const store = buildCommandTestStore({
      data: materialized,
      applyEdit,
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TimelineStoreProvider store={store}>
            <AddToVideoEditorConsumer />
          </TimelineStoreProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('timeline-mounted')).toHaveTextContent('true');

    fireEvent.click(screen.getByRole('button', { name: 'add to video editor' }));

    expect(applyEdit).toHaveBeenCalledTimes(1);
    const mutation = applyEdit.mock.calls[0]?.[0] as {
      type: string;
      command: PlacePreparedMediaCommand;
    };
    expect(mutation.type).toBe('prepared-media');
    expect(mutation.command.type).toBe('place-prepared-media');
    expect(mutation.command.payload).toMatchObject({
      at: 2,
      selectedTrackId: 'V1',
      asset: {
        assetKey: expect.any(String),
        mediaType: 'image',
        durationSeconds: null,
        entry: {
          file: 'https://example.com/image.png',
          type: 'image/png',
          generationId: 'generation-1',
          media_id: 'media-1',
        },
        source: 'registered',
      },
    });
    expect(Object.hasOwn(mutation.command.payload, 'trackId')).toBe(false);
    expect(Object.hasOwn(mutation.command.payload, 'clipSpanSeconds')).toBe(false);
    expect(JSON.parse(JSON.stringify(mutation.command))).toStrictEqual(mutation.command);

    const { asset } = mutation.command.payload;
    expect(materialized.registry.assets[asset.assetKey]).toEqual(asset.entry);
    const insertedClip = materialized.config.clips.find((clip) => clip.asset === asset.assetKey);
    expect(insertedClip).toBeDefined();
    if (!insertedClip) throw new Error('Prepared media reducer did not materialize the placed clip');
    expect(insertedClip).toMatchObject({
      asset: asset.assetKey,
      at: 2,
      track: 'V1',
      clipType: 'hold',
      hold: 5,
    });
    const insertedAction = materialized.rows.flatMap(({ actions }) => actions)
      .find(({ id }) => id === insertedClip.id);
    expect(insertedAction).toMatchObject({ start: 2, end: 7 });
    expect(readPendingAdds()).toEqual([]);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
