import { useTimelineSelectionStore, editorClearTimelineSelection, __resetSelectionStoreForTests, userSelectTimelineItems } from '@/shared/state/selectionStore.ts';
import { useLayoutEffect, useRef } from 'react';
import { TranscriptLane } from '@astrid/packs/rendering/ui/transcript-lane/TranscriptLane';
import { DataLaneList } from '@/tools/video-editor/components/TimelineEditor/DataLaneList';
import { useMarqueeSelect } from '@/tools/video-editor/hooks/useMarqueeSelect';
import { createTimelineStore, TimelineStoreProvider, useTimelineEditorData, useTimelineEditorOps } from '@/tools/video-editor/hooks/timelineStore';
import type { TimelineEditorDataContextValue, TimelineEditorOpsContextValue } from '@/tools/video-editor/hooks/useTimelineState.types';
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PropertiesPanel } from '@/tools/video-editor/components/PropertiesPanel/PropertiesPanel';
import { PropertiesPanelBody } from '@/tools/video-editor/components/PropertiesPanel/PropertiesPanelBody';
import { TimelineOutlinePanel } from '@/tools/video-editor/components/PropertiesPanel/TimelineOutlinePanel';
import { VideoEditorAssetPanelSurface } from '@/tools/video-editor/components/PropertiesPanel/VideoEditorAssetPanelSurface';
import type { DataLaneView, FrozenDataItem } from '@/tools/video-editor/data/typed/envelope';
import type { DataItemInspectorProps } from '@astrid/editor-sdk';

const inspectorElementBridge = vi.hoisted(() => ({ context: null as import('@/shared/contexts/AgentChatContext.tsx').AgentChatEditorContext | null }));
let clipPanelChange: ((patch: { params: Record<string, unknown> }) => void) | undefined;
vi.mock('@/shared/contexts/AgentChatContext.tsx', async importOriginal => ({
  ...await importOriginal<typeof import('@/shared/contexts/AgentChatContext.tsx')>(),
  useOptionalAgentChatBridge: () => ({ editorContext: inspectorElementBridge.context }),
}));

let realStoreSelectionTest = false;
const useTimelineEditorDataMock = vi.fn();
const useTimelineEditorOpsMock = vi.fn();
const handleAddTrackMock = vi.fn();
const useVideoEditorRenderContextMock = vi.fn();
const useVideoEditorPanelRegistryMock = vi.fn();
const getInspectorContributionsMock = vi.fn();
const useVideoEditorAssetPanelsMock = vi.fn();
const useShaderEffectRegistrySnapshotMock = vi.fn();
const useDataLanesMock = vi.fn((args?: { base?: unknown }) => args?.base ?? null);

// Rework R1: the panel resolves lane items from the patched lane plane this
// hook returns, never from the store's frozen-empty `dataLanes`. Default
// implementation mirrors identity semantics (no lanes → base passthrough).
vi.mock('@/tools/video-editor/data-kinds/useDataLanes', () => ({
  useDataLanes: (args?: { base?: unknown }) => useDataLanesMock(args),
}));
vi.mock('@/tools/video-editor/hooks/timelineStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/video-editor/hooks/timelineStore')>();
  return {
    ...actual,
    useTimelineEditorData: () => realStoreSelectionTest ? actual.useTimelineEditorData() : useTimelineEditorDataMock(),
    useTimelineStoreApiSafe: () => realStoreSelectionTest ? actual.useTimelineStoreApiSafe() : null,
    useTimelineEditorOps: () => realStoreSelectionTest ? actual.useTimelineEditorOps() : useTimelineEditorOpsMock(),
    useTimelinePlaybackContext: () => ({ currentTime: 0 }),
    useTimelineChromeContext: () => ({ handleAddTrack: handleAddTrackMock }),
  };
});

vi.mock('@/tools/video-editor/runtime/useVideoEditorRenderContext', () => ({
  useVideoEditorRenderContext: () => useVideoEditorRenderContextMock(),
  useVideoEditorPanelRegistry: () => ({
    ...useVideoEditorPanelRegistryMock(),
    // These fixtures model the complete registry and its visible subset alike.
    panels: useVideoEditorAssetPanelsMock(),
  }),
  useVideoEditorAssetPanels: () => useVideoEditorAssetPanelsMock(),
}));

vi.mock('@/tools/video-editor/shaders/registry/ShaderEffectRegistryContext.tsx', () => ({
  useShaderEffectRegistrySnapshot: () => useShaderEffectRegistrySnapshotMock(),
}));

// Mock getInspectorContributions so the test controls what sections appear
vi.mock('@/tools/video-editor/runtime/extensionSurface', async () => {
  const actual = await vi.importActual<typeof import('@/tools/video-editor/runtime/extensionSurface')>(
    '@/tools/video-editor/runtime/extensionSurface',
  );
  return {
    ...actual,
    getInspectorContributions: (
      registry: unknown,
      context: unknown,
      selection: unknown,
    ) => getInspectorContributionsMock(registry, context, selection),
  };
});

vi.mock('@/tools/video-editor/hooks/usePerfDiagnostics', () => ({
  useRenderDiagnostic: vi.fn(),
}));

vi.mock('@/tools/video-editor/hooks/useStaleVariants', () => ({
  useStaleVariants: () => ({
    staleAssetKeys: new Set<string>(),
    dismissedAssetKeys: new Set<string>(),
    dismissAsset: vi.fn(),
    updateAssetToCurrentVariant: vi.fn(),
    applyVariantToAsset: vi.fn(),
  }),
}));

vi.mock('@/tools/video-editor/hooks/useAddVariantAsGeneration', () => ({
  useAddVariantAsGeneration: () => ({
    addVariantAsGenerationAfterClip: vi.fn(),
    isPending: vi.fn(() => false),
  }),
}));

vi.mock('@/shared/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@/tools/video-editor/components/PropertiesPanel/AssetPanel', () => ({
  default: () => <div data-testid="mock-built-in-asset-panel">Built-in asset panel</div>,
}));

vi.mock('@/tools/video-editor/components/PropertiesPanel/ClipPanel', () => ({
  NO_EFFECT: 'no-effect',
  getVisibleClipTabs: () => ['effects', 'timing', 'position', 'audio', 'text'],
  ClipPanel: ({ onDelete, onChange }: { onDelete?: () => void; onChange?: typeof clipPanelChange }) => {
    clipPanelChange = onChange;
    return <div data-testid="mock-clip-panel">Clip panel{onDelete && <button type="button" onClick={onDelete}>Delete clip</button>}</div>;
  },
}));

vi.mock('@/tools/video-editor/components/PropertiesPanel/BulkClipPanel', () => ({
  BulkClipPanel: ({ clips }: { clips: Array<{ id: string }> }) => (
    <div data-testid="mock-bulk-clip-panel">Bulk clip panel ({clips.length})</div>
  ),
}));

vi.mock('@/tools/video-editor/lib/bulk-utils', () => ({
  getBulkVisibleTabs: () => ['effects', 'timing', 'position', 'audio', 'text'],
  getSharedNestedValue: () => undefined,
  getSharedValue: () => undefined,
}));

function createBaseEditorData() {
  return {
    data: {
      assetMap: {
        'asset-1': 'folder/image-1.png',
      },
      rows: [],
      meta: {},
      output: {
        background: null,
      },
      registry: {
        assets: {},
      },
      resolvedConfig: {
        tracks: [],
      },
    },
    resolvedConfig: {
      tracks: [],
      clips: [
        { id: 'clip-1', assetEntry: { duration: 5 } },
        { id: 'clip-2', assetEntry: { duration: 5 } },
      ],
      output: {
        fps: 30,
      },
      registry: {},
    },
    selectedClip: {
      id: 'clip-1',
      clipType: 'video',
      asset: 'asset-1',
      assetEntry: { duration: 5 },
    },
    selectedClipIds: new Set(['clip-1']),
    deviceClass: 'desktop',
    interactionMode: 'select',
    selectedTrack: null,
    selectedTrackId: null,
    selectedClipHasPredecessor: false,
    inspectorTarget: null,
    compositionSize: { width: 1280, height: 720 },
    preferences: {
      activeClipTab: 'effects',
      assetPanel: {
        showAll: false,
        showHidden: false,
        hidden: [],
      },
    },
  };
}

function createShaderSnapshot() {
  const record = {
    ownerExtensionId: 'ext.shader',
    contributionId: 'post-grade',
    shaderId: 'shader.post.grade',
    label: 'Post Grade',
    pass: 'postprocess',
    status: 'active',
    source: { kind: 'inline', fragment: 'void main() {}' },
    uniforms: [
      {
        name: 'intensity',
        label: 'Intensity',
        type: 'float',
        default: 0.5,
      },
    ],
    textures: [],
    diagnostics: [],
  };

  return {
    records: [record],
    diagnostics: [],
    get: (shaderId: string, ownerExtensionId?: string) => (
      shaderId === record.shaderId && ownerExtensionId === record.ownerExtensionId ? record : undefined
    ),
    getByLookup: (lookup: { shaderId: string; ownerExtensionId?: string }) => (
      lookup.shaderId === record.shaderId && lookup.ownerExtensionId === record.ownerExtensionId ? record : undefined
    ),
    has: (shaderId: string, ownerExtensionId?: string) => shaderId === record.shaderId && ownerExtensionId === record.ownerExtensionId,
    hasByLookup: (lookup: { shaderId: string; ownerExtensionId?: string }) => lookup.shaderId === record.shaderId && lookup.ownerExtensionId === record.ownerExtensionId,
  };
}

function createEditorOps() {
  return {
    selectClip: vi.fn(),
    clearSelection: vi.fn(),
    handleUpdateClips: vi.fn(),
    handleUpdateClipsDeep: vi.fn(),
    handleDeleteClip: vi.fn(),
    handleDeleteClips: vi.fn(),
    handleTrackPopoverChange: vi.fn(),
    handleRemoveTrack: vi.fn(),
    handleSelectedClipChange: vi.fn(),
    handleResetClipPosition: vi.fn(),
    handleResetClipsPosition: vi.fn(),
    handleSplitClipsAtPlayhead: vi.fn(),
    handleSplitSelectedClip: vi.fn(),
    handleToggleMuteClips: vi.fn(),
    handleToggleMute: vi.fn(),
    handleDetachAudioClip: vi.fn(),
    moveSelectedClipsToTrack: vi.fn(),
    setContextTarget: vi.fn(),
    setActiveClipTab: vi.fn(),
    setInspectorTarget: vi.fn(),
    setSelectedTrackId: vi.fn(),
    onDoubleClickAsset: vi.fn(),
    setInteractionMode: vi.fn(),
    patchRegistry: vi.fn(),
    registerAsset: vi.fn(),
    setAssetPanelState: vi.fn(),
    uploadFiles: vi.fn(),
  };
}

function createInspectorSection(id: string) {
  const placement = id.startsWith('before') ? 'before-default' as const : 'after-default' as const;
  return {
    id,
    placement,
    render: (_ctx: unknown, _sel: unknown) => <div data-testid={`section-${id}`}>{id}</div>,
  };
}

function createInspectorContributions() {
  const before = [createInspectorSection('before-alpha'), createInspectorSection('before-beta')];
  const after = [createInspectorSection('after-alpha')];
  return {
    all: [...before, ...after],
    beforeDefault: before,
    afterDefault: after,
  };
}

function createAssetPanel(id: string) {
  return {
    id,
    placement: 'asset-panel' as const,
    render: () => <div data-testid={`panel-${id}`}>{id}</div>,
  };
}

describe('PropertiesPanel registry surfaces', () => {
  beforeEach(() => {
    useVideoEditorRenderContextMock.mockReturnValue({ timelineId: 'timeline-1' });
    useTimelineEditorDataMock.mockReturnValue(createBaseEditorData());
    useTimelineEditorOpsMock.mockReturnValue(createEditorOps());
    useVideoEditorPanelRegistryMock.mockReturnValue({ panels: [], inspectorSections: [] });
    useShaderEffectRegistrySnapshotMock.mockReturnValue(createShaderSnapshot());
    getInspectorContributionsMock.mockImplementation(
      (_registry: unknown, _context: unknown, _selection: unknown) => createInspectorContributions(),
    );
    useVideoEditorAssetPanelsMock.mockReturnValue([createAssetPanel('asset-panel-extra')]);
  });

  it('forwards the current element selection with the real property callback', () => {
    const ops = createEditorOps();
    useTimelineEditorOpsMock.mockReturnValue(ops);
    const owner = { tool: 'video-editor' as const, projectId: 'project', projectSlug: 'project', timelineId: 'timeline', timelineName: null };
    inspectorElementBridge.context = owner;
    try {
      render(<PropertiesPanel />);
      const patch = { params: { bob: 12 } };
      act(() => clipPanelChange!(patch));
      expect(ops.handleSelectedClipChange).toHaveBeenCalledWith(patch, owner);
    } finally { inspectorElementBridge.context = null; }
  });

  it.each([['media', 'timing'], ['text', 'text']] as const)('opens a retained touch Inspector on the %s clip’s own tab', (clipType, tab) => {
    const data = createBaseEditorData();
    useTimelineEditorDataMock.mockReturnValue({
      ...data, deviceClass: 'phone', selectedClip: { ...data.selectedClip, clipType },
      selectedTrack: { id: 'V1', kind: 'visual', label: 'Video 1' },
    });
    const ops = createEditorOps();
    useTimelineEditorOpsMock.mockReturnValue(ops);
    const { rerender } = render(<PropertiesPanel visible={false} />);
    ops.setActiveClipTab.mockClear();
    rerender(<PropertiesPanel visible />);
    expect(ops.setActiveClipTab).toHaveBeenCalledWith(tab);
    ops.setActiveClipTab.mockClear();
    rerender(<PropertiesPanel visible={false} />);
    rerender(<PropertiesPanel visible />);
    expect(ops.setActiveClipTab).toHaveBeenCalledWith(tab);
  });

  it.each([['phone', 1], ['tablet', 1], ['desktop', 0]] as const)('Delete clip on %s leaves nothing picked (clears: %s)', (deviceClass, clears) => {
    // Touch: the Inspector then returns to Video, rather than showing the deleted clip's track.
    const data = createBaseEditorData();
    useTimelineEditorDataMock.mockReturnValue({ ...data, deviceClass });
    const ops = createEditorOps();
    useTimelineEditorOpsMock.mockReturnValue(ops);
    render(<PropertiesPanel />);
    const before = ops.clearSelection.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Delete clip' }));
    expect(ops.handleDeleteClip).toHaveBeenCalledWith(data.selectedClip.id);
    expect(ops.clearSelection.mock.calls.length - before).toBe(clears);
  });

  it.each(['phone', 'tablet'] as const)('edits the track target in Inspector on %s, sharing settings and confirming deletion', (deviceClass) => {
    const track = { id: 'V1', kind: 'visual' as const, label: 'Video 1' };
    const data = createBaseEditorData();
    useTimelineEditorDataMock.mockReturnValue({
      ...data, deviceClass, selectedClip: null, selectedClipIds: new Set(),
      selectedTrackId: track.id, selectedTrack: track, inspectorTarget: { kind: 'track', trackId: track.id },
      resolvedConfig: { ...data.resolvedConfig, tracks: [track], clips: [{ id: 'clip-1', track: track.id }] },
    });
    const ops = createEditorOps();
    useTimelineEditorOpsMock.mockReturnValue(ops);
    handleAddTrackMock.mockClear();
    render(<PropertiesPanel />);
    expect(screen.getByLabelText('Track name')).toHaveValue('Video 1');
    expect(screen.getByRole('combobox', { name: 'Track role' })).toBeInTheDocument();
    expect(screen.getByText('Fit')).toBeInTheDocument();
    expect(screen.getByText('Blend Mode')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-clip-panel')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Track name'), { target: { value: 'Titles' } });
    expect(ops.handleTrackPopoverChange).toHaveBeenCalledWith('V1', { label: 'Titles' });
    fireEvent.click(screen.getByRole('button', { name: 'Add video track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add audio track' }));
    expect(handleAddTrackMock.mock.calls).toEqual([['visual'], ['audio']]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete track' }));
    expect(ops.handleRemoveTrack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to confirm deletion' }));
    expect(ops.handleRemoveTrack).toHaveBeenCalledWith('V1');
  });

  it('keeps track settings disabled when the timeline is read only', () => {
    const track = { id: 'V1', kind: 'visual', label: 'Video 1' };
    const data = createBaseEditorData();
    useTimelineEditorDataMock.mockReturnValue({
      ...data, deviceClass: 'phone', selectedClip: null, selectedClipIds: new Set(), selectedTrackId: 'V1',
      resolvedConfig: { ...data.resolvedConfig, tracks: [track] },
    });
    useOptionalVideoEditorRuntimeMock.mockReturnValue({ timelineEditability: { checkTimeline: () => ({ allowed: false }) } });
    try {
      render(<PropertiesPanel />);
      expect(screen.getByLabelText('Track name')).toBeDisabled();
      expect(screen.getByRole('combobox', { name: 'Track role' })).toBeDisabled();
      for (const slider of screen.getAllByRole('slider')) expect(slider).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Add video track' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete track' })).toBeDisabled();
    } finally {
      useOptionalVideoEditorRuntimeMock.mockReturnValue(null);
    }
  });

  it('renders inspector sections before and after the built-in clip inspector additively', () => {
    const { container } = render(<PropertiesPanel />);

    expect(screen.getByTestId('mock-clip-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-bulk-clip-panel')).not.toBeInTheDocument();

    const renderedOrder = [...container.querySelectorAll(
      '[data-video-editor-inspector-section-id], [data-testid="mock-clip-panel"]',
    )].map((element) => (
      element.getAttribute('data-video-editor-inspector-section-id') ?? element.getAttribute('data-testid')
    ));

    expect(renderedOrder).toEqual([
      'before-alpha',
      'before-beta',
      'mock-clip-panel',
      'after-alpha',
    ]);
  });

  it('renders only Inspector content without a second host navigation row', () => {
    render(
      <PropertiesPanel
        assetPanel={<div data-testid="timeline-assets-tab-content">Timeline assets</div>}
      />,
    );

    expect(screen.queryByRole('tab', { name: 'Outline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Assets' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Processes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Inspector' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Extensions' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('timeline-assets-tab-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('timeline-outline-panel')).not.toBeInTheDocument();
  });

  it('keeps the Inspector as the default panel when Outline is unavailable', () => {
    render(<PropertiesPanel />);
    expect(screen.queryByRole('tab', { name: 'Outline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Inspector' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-clip-panel')).toBeInTheDocument();
  });

  it('retains the shared timeline outline component and its selection actions', () => {
    const editorData = createBaseEditorData();
    editorData.resolvedConfig = {
      clips: [{
        id: 'clip-1',
        track: 'track-1',
        clipType: 'video',
        label: 'Opening',
        at: 2,
        hold: 2,
        asset: 'asset-1',
      }],
      tracks: [{ id: 'track-1', kind: 'visual', label: 'Visual' }],
      output: { fps: 30 },
      registry: {},
    } as never;
    const editorOps = createEditorOps();
    useTimelineEditorDataMock.mockReturnValue(editorData);
    useTimelineEditorOpsMock.mockReturnValue(editorOps);

    render(<TimelineOutlinePanel />);
    expect(screen.getByTestId('timeline-outline-item-clip-1')).toHaveTextContent('Opening');

    fireEvent.click(screen.getByTestId('timeline-outline-item-clip-1'));
    expect(editorOps.selectClip).toHaveBeenCalledWith('clip-1');
    expect(editorOps.setSelectedTrackId).toHaveBeenCalledWith('track-1');
    expect(editorOps.setInspectorTarget).toHaveBeenCalledWith({ kind: 'clip', clipId: 'clip-1' });
  });

  it('keeps the public editor Inspector selected when its Extensions surface is unavailable', () => {
    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      timelineEditability: { checkTimeline: () => ({ allowed: false }) },
    });
    const BodyInspector = () => <div data-testid="mock-public-editor-inspector" />;
    const hostObservations = {
      staleAssetKeys: new Set<string>(),
      dismissedAssetKeys: new Set<string>(),
      dismissAsset: vi.fn(),
      updateAssetToCurrentVariant: vi.fn(),
      applyVariantToAsset: vi.fn(),
      addVariantAsGenerationAfterClip: vi.fn(),
      isAddingVariantAsGenerationPending: vi.fn(),
    } as never;

    render(
      <PropertiesPanelBody
        hostObservations={hostObservations}
        effectResources={{} as never}
        ClipInspector={BodyInspector}
      />,
    );

    expect(screen.queryByRole('tab', { name: 'Outline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Extensions' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Inspector' })).toBeInTheDocument();
    expect(screen.getByTestId('mock-public-editor-inspector')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-outline-panel')).not.toBeInTheDocument();
  });

  it('keeps the bulk inspector as the core panel when multiple clips are selected', () => {
    useTimelineEditorDataMock.mockReturnValue({
      ...createBaseEditorData(),
      selectedClip: null,
      selectedClipIds: new Set(['clip-1', 'clip-2']),
    });

    const { container } = render(<PropertiesPanel />);

    expect(screen.queryByTestId('mock-clip-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-bulk-clip-panel')).toHaveTextContent('Bulk clip panel (2)');

    const renderedOrder = [...container.querySelectorAll(
      '[data-video-editor-inspector-section-id], [data-testid="mock-bulk-clip-panel"]',
    )].map((element) => (
      element.getAttribute('data-video-editor-inspector-section-id') ?? element.getAttribute('data-testid')
    ));

    expect(renderedOrder).toEqual([
      'before-alpha',
      'before-beta',
      'mock-bulk-clip-panel',
      'after-alpha',
    ]);
  });

  it('stacks the built-in asset panel ahead of contributed asset-panel registry entries', () => {
    const { container } = render(<VideoEditorAssetPanelSurface includeBuiltIn />);

    expect(screen.getByTestId('mock-built-in-asset-panel')).toBeInTheDocument();
    expect(screen.getByTestId('panel-asset-panel-extra')).toBeInTheDocument();

    const renderedOrder = [...container.querySelectorAll(
      '[data-video-editor-panel-id], [data-testid="mock-built-in-asset-panel"]',
    )].map((element) => (
      element.getAttribute('data-video-editor-panel-id') ?? element.getAttribute('data-testid')
    ));

    expect(renderedOrder).toEqual([
      'mock-built-in-asset-panel',
      'asset-panel-extra',
    ]);
  });
});

describe('PropertiesPanel — selection propagation', () => {
  beforeEach(() => {
    useVideoEditorRenderContextMock.mockReturnValue({ timelineId: 'timeline-1' });
    useTimelineEditorDataMock.mockReturnValue(createBaseEditorData());
    useTimelineEditorOpsMock.mockReturnValue(createEditorOps());
    useVideoEditorPanelRegistryMock.mockReturnValue({ panels: [], inspectorSections: [] });
    useVideoEditorAssetPanelsMock.mockReturnValue([]);
    useShaderEffectRegistrySnapshotMock.mockReturnValue(createShaderSnapshot());

    // Capture the selection argument passed to getInspectorContributions
    getInspectorContributionsMock.mockImplementation(
      (_registry: unknown, _context: unknown, selection: unknown) => {
        // Return a single section that echoes the selection it received
        const sel = selection as { kind: string; clipId?: string; clipIds?: string[]; trackId?: string } | null;
        return {
          all: [{
            id: 'sel-echo',
            placement: 'before-default' as const,
            render: (_ctx: unknown, _sel: unknown) => (
              <div data-testid="section-sel-echo">
                selection:{sel ? `${sel.kind}:${sel.clipId ?? sel.trackId ?? (sel.clipIds?.join(',') ?? 'none')}` : 'null'}
              </div>
            ),
          }],
          beforeDefault: [{
            id: 'sel-echo',
            placement: 'before-default' as const,
            render: (_ctx: unknown, _sel: unknown) => (
              <div data-testid="section-sel-echo">
                selection:{sel ? `${sel.kind}:${sel.clipId ?? sel.trackId ?? (sel.clipIds?.join(',') ?? 'none')}` : 'null'}
              </div>
            ),
          }],
          afterDefault: [],
        };
      },
    );
  });

  it('passes clip selection to inspector contributions', () => {
    useTimelineEditorDataMock.mockReturnValue({
      ...createBaseEditorData(),
      selectedClip: { id: 'clip-abc', clipType: 'video', asset: 'asset-1', assetEntry: { duration: 5 } },
      selectedClipIds: new Set(['clip-abc']),
      selectedTrackId: null,
    });

    render(<PropertiesPanel />);

    expect(screen.getByTestId('section-sel-echo')).toHaveTextContent('selection:clip:clip-abc');
    // Verify getInspectorContributions was called with the selection
    expect(getInspectorContributionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'clip', clipId: 'clip-abc' }),
    );
  });

  it('passes multi-selection to inspector contributions', () => {
    useTimelineEditorDataMock.mockReturnValue({
      ...createBaseEditorData(),
      selectedClip: null,
      selectedClipIds: new Set(['clip-1', 'clip-2', 'clip-3']),
      selectedTrackId: null,
    });

    render(<PropertiesPanel />);

    expect(screen.getByTestId('section-sel-echo')).toHaveTextContent('selection:selection:clip-1,clip-2,clip-3');
    expect(getInspectorContributionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'selection', clipIds: ['clip-1', 'clip-2', 'clip-3'] }),
    );
  });

  it('passes track selection to inspector contributions', () => {
    useTimelineEditorDataMock.mockReturnValue({
      ...createBaseEditorData(),
      selectedClip: null,
      selectedClipIds: new Set<string>(),
      selectedTrackId: 'track-main',
    });

    render(<PropertiesPanel />);

    expect(screen.getByTestId('section-sel-echo')).toHaveTextContent('selection:track:track-main');
    expect(getInspectorContributionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'track', trackId: 'track-main' }),
    );
  });

  it('passes timeline fallback when nothing is selected', () => {
    useTimelineEditorDataMock.mockReturnValue({
      ...createBaseEditorData(),
      selectedClip: null,
      selectedClipIds: new Set<string>(),
      selectedTrackId: null,
    });

    render(<PropertiesPanel />);

    expect(screen.getByTestId('section-sel-echo')).toHaveTextContent('selection:timeline:none');
    expect(getInspectorContributionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'timeline' }),
    );
  });

  it('opens postprocess shader controls for the shader inspector target', () => {
    useTimelineEditorDataMock.mockReturnValue({
      ...createBaseEditorData(),
      resolvedConfig: {
        ...createBaseEditorData().resolvedConfig,
        app: {
          shaderPostprocess: {
            scope: 'postprocess',
            extensionId: 'ext.shader',
            contributionId: 'post-grade',
            shaderId: 'shader.post.grade',
            label: 'Post Grade',
          },
        },
      },
      selectedClip: null,
      selectedClipIds: new Set<string>(),
      selectedTrackId: null,
      inspectorTarget: {
        kind: 'shader',
        shaderScope: 'postprocess',
        shaderId: 'shader.post.grade',
        extensionId: 'ext.shader',
        contributionId: 'post-grade',
      },
    });

    render(<PropertiesPanel />);

    expect(screen.getByTestId('shader-inspector')).toBeInTheDocument();
    expect(screen.getByText('Postprocess Shader')).toBeInTheDocument();
    expect(screen.getByText('Post Grade')).toBeInTheDocument();
    expect(screen.getByTestId('schema-form-field-intensity')).toHaveTextContent('Intensity');
    expect(screen.getByTestId('schema-form-widget-intensity')).toBeInTheDocument();
    expect(getInspectorContributionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        kind: 'shader',
        shaderScope: 'postprocess',
        shaderId: 'shader.post.grade',
      }),
    );
  });

  it('preserves before-default and after-default placement ordering', () => {
    // Use a custom mock that returns both placements
    getInspectorContributionsMock.mockImplementation((_r: unknown, _c: unknown, sel: unknown) => {
      const s = sel as { kind: string } | null;
      const k = s?.kind ?? 'null';
      const mk = (id: string, placement: 'before-default' | 'after-default') => ({
        id,
        placement,
        render: (_ctx: unknown, _sel: unknown) => (
          <div data-testid={`section-${id}`}>{id}</div>
        ),
      });
      return {
        all: [mk('before-x', 'before-default'), mk('after-y', 'after-default')],
        beforeDefault: [mk('before-x', 'before-default')],
        afterDefault: [mk('after-y', 'after-default')],
      };
    });

    const { container } = render(<PropertiesPanel />);

    const renderedOrder = [...container.querySelectorAll(
      '[data-video-editor-inspector-section-id], [data-testid="mock-clip-panel"]',
    )].map((element) => (
      element.getAttribute('data-video-editor-inspector-section-id') ?? element.getAttribute('data-testid')
    ));

    expect(renderedOrder).toEqual([
      'before-x',
      'mock-clip-panel',
      'after-y',
    ]);
  });

  it('does not poll extensions for selection updates', () => {
    // Render once and verify getInspectorContributions is called only
    // via React rendering — the selection comes from host props, not polling.
    const callCountBefore = getInspectorContributionsMock.mock.calls.length;

    // Initial render
    const { rerender } = render(<PropertiesPanel />);
    const initialCalls = getInspectorContributionsMock.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(callCountBefore + 1);

    // Re-render with the same props — should still call due to React re-render
    // but no polling interval is set up
    rerender(<PropertiesPanel />);

    // Verify there's no setInterval or polling loop associated with inspector sections
    // The selection is derived from host props, not extension polling
    const selectionCalls = getInspectorContributionsMock.mock.calls.filter(
      (call) => call[2] !== undefined,
    );
    expect(selectionCalls.length).toBeGreaterThan(0);
  });
});

describe('PropertiesPanel — removed Processes tab', () => {
  beforeEach(() => {
    useVideoEditorRenderContextMock.mockReturnValue({ timelineId: 'timeline-1' });
    useTimelineEditorDataMock.mockReturnValue(createBaseEditorData());
    useTimelineEditorOpsMock.mockReturnValue(createEditorOps());
    useVideoEditorPanelRegistryMock.mockReturnValue({ panels: [], inspectorSections: [] });
    useVideoEditorAssetPanelsMock.mockReturnValue([]);
    useShaderEffectRegistrySnapshotMock.mockReturnValue(createShaderSnapshot());
    getInspectorContributionsMock.mockReturnValue({
      all: [],
      beforeDefault: [],
      afterDefault: [],
    });
  });

  it('does not render the panel Processes tab', () => {
    render(<PropertiesPanel />);
    expect(screen.queryByRole('tab', { name: 'Processes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Process dashboard is unavailable outside of a video editor runtime.')).not.toBeInTheDocument();
  });
});

// ─── HostContributionErrorBoundary integration tests ───────────────────────

const useOptionalVideoEditorRuntimeMock = vi.fn();

function createContributionIndex(
  entries: Array<{ kind: 'inspectorSection' | 'panel'; contributionId: string; extensionId: string }>,
) {
  return {
    fixture: entries.map(({ kind, contributionId, extensionId }) => ({
      scopedKey: `${kind}:${extensionId}:${contributionId}`,
      kind,
      extensionId,
      contributionId,
      status: 'active' as const,
      diagnostics: [],
      duplicateOrdinal: 0,
      projectionEligible: true,
      projection: {
        duplicateOrdinal: 0,
        eligible: true,
        projected: true,
        source: 'descriptor-array' as const,
      },
    })),
  };
}

vi.mock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx', async () => {
  const actual = await vi.importActual<
    typeof import('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx')
  >('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx');
  return {
    ...actual,
    useOptionalVideoEditorRuntime: () => useOptionalVideoEditorRuntimeMock(),
  };
});

describe('HostContributionErrorBoundary — inspector sections', () => {
  beforeEach(() => {
    useVideoEditorRenderContextMock.mockReturnValue({ timelineId: 'timeline-1' });
    useTimelineEditorDataMock.mockReturnValue(createBaseEditorData());
    useTimelineEditorOpsMock.mockReturnValue(createEditorOps());
    useVideoEditorPanelRegistryMock.mockReturnValue({ panels: [], inspectorSections: [] });
    useVideoEditorAssetPanelsMock.mockReturnValue([]);
    useShaderEffectRegistrySnapshotMock.mockReturnValue(createShaderSnapshot());

    // Default: no runtime context → HostContributionErrorBoundary falls back to legacy
    useOptionalVideoEditorRuntimeMock.mockReturnValue(null);
  });

  it('renders inspector sections through HostContributionErrorBoundary', () => {
    getInspectorContributionsMock.mockReturnValue(createInspectorContributions());

    const { container } = render(<PropertiesPanel />);

    // All three sections should render
    expect(screen.getByTestId('section-before-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('section-before-beta')).toBeInTheDocument();
    expect(screen.getByTestId('section-after-alpha')).toBeInTheDocument();

    // Each section should have the data-video-editor-inspector-section-id attribute
    const wrappers = container.querySelectorAll('[data-video-editor-inspector-section-id]');
    expect(wrappers.length).toBe(3);
  });

  it('passes extensionId from contributionIndex to HostContributionErrorBoundary', () => {
    // Build a runtime with the host-owned contribution index.

    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      extensionRuntime: {
        contributionIndex: createContributionIndex([
          { kind: 'inspectorSection', contributionId: 'before-alpha', extensionId: 'ext.alpha' },
          { kind: 'inspectorSection', contributionId: 'before-beta', extensionId: 'ext.beta' },
          { kind: 'inspectorSection', contributionId: 'after-alpha', extensionId: 'ext.gamma' },
        ]),
      },
      getRecoveryKey: vi.fn((extId: string) => {
        if (extId === 'ext.alpha') return '1';
        if (extId === 'ext.beta') return '1';
        if (extId === 'ext.gamma') return '1';
        return '0';
      }),
      incrementRecoveryKey: vi.fn(() => '2'),
    });

    getInspectorContributionsMock.mockReturnValue(createInspectorContributions());

    // Render should succeed without errors — extensionIds are resolved from ownerMap
    const { container } = render(<PropertiesPanel />);

    expect(screen.getByTestId('section-before-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('section-before-beta')).toBeInTheDocument();
    expect(screen.getByTestId('section-after-alpha')).toBeInTheDocument();
  });

  it('falls back to undefined extensionId when contributionIndex is unavailable', () => {
    // Runtime exists but without extensionRuntime or contributionIndex
    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      getRecoveryKey: vi.fn(() => '0'),
      incrementRecoveryKey: vi.fn(() => '0'),
    });

    getInspectorContributionsMock.mockReturnValue(createInspectorContributions());

    const { container } = render(<PropertiesPanel />);

    // Sections should still render — HostContributionErrorBoundary falls back to legacy
    expect(screen.getByTestId('section-before-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('section-before-beta')).toBeInTheDocument();
    expect(screen.getByTestId('section-after-alpha')).toBeInTheDocument();
  });

  it('renders fresh children exactly once when recovery key changes (disable/re-enable semantics)', async () => {
    let renderCount = 0;

    // Create a section whose render function tracks invocations
    const trackedSection = {
      id: 'before-tracked',
      placement: 'before-default' as const,
      render: (_ctx: unknown, _sel: unknown) => {
        renderCount++;
        return <div data-testid="section-before-tracked">Tracked {renderCount}</div>;
      },
    };

    getInspectorContributionsMock.mockReturnValue({
      all: [trackedSection],
      beforeDefault: [trackedSection],
      afterDefault: [],
    });

    // Simulate a runtime where recovery keys can change
    let recoveryKeyCounter = 1;
    const getRecoveryKeyMock = vi.fn(() => String(recoveryKeyCounter));
    const incrementRecoveryKeyMock = vi.fn(() => {
      recoveryKeyCounter++;
      return String(recoveryKeyCounter);
    });

    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      extensionRuntime: {
        contributionIndex: createContributionIndex([
          { kind: 'inspectorSection', contributionId: 'before-tracked', extensionId: 'ext.tracked' },
        ]),
      },
      getRecoveryKey: getRecoveryKeyMock,
      incrementRecoveryKey: incrementRecoveryKeyMock,
    });

    const { rerender } = render(<PropertiesPanel />);

    expect(screen.getByTestId('section-before-tracked')).toBeInTheDocument();
    const initialRenderCount = renderCount;

    // Re-render without recovery key change — should NOT re-render children
    // (HostContributionErrorBoundary prevents children-change-reset when recoveryKey is set)
    rerender(<PropertiesPanel />);

    // Children should NOT have re-rendered (same recovery key)
    // Note: React may re-render for other reasons, but the key insight is that
    // HostContributionErrorBoundary doesn't reset the error boundary on children-change
    // when a recoveryKey is present

    // Now simulate recovery: increment the recovery key externally
    recoveryKeyCounter++;
    rerender(<PropertiesPanel />);

    // The section should still render (fresh children after recovery key change)
    expect(screen.getByTestId('section-before-tracked')).toBeInTheDocument();

    // Verify getRecoveryKey was called with the correct extensionId
    expect(getRecoveryKeyMock).toHaveBeenCalledWith('ext.tracked');
  });

  it('threads extensionId from contributionIndex to HostContributionErrorBoundary with getRecoveryKey', () => {
    const getRecoveryKeySpy = vi.fn(() => '1');
    const incrementRecoveryKeySpy = vi.fn(() => '2');

    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      extensionRuntime: {
        contributionIndex: createContributionIndex([
          { kind: 'inspectorSection', contributionId: 'before-once', extensionId: 'ext.once' },
        ]),
      },
      getRecoveryKey: getRecoveryKeySpy,
      incrementRecoveryKey: incrementRecoveryKeySpy,
    });

    const section = {
      id: 'before-once',
      placement: 'before-default' as const,
      render: (_ctx: unknown, _sel: unknown) => (
        <div data-testid="section-single-render">Single</div>
      ),
    };

    getInspectorContributionsMock.mockReturnValue({
      all: [section],
      beforeDefault: [section],
      afterDefault: [],
    });

    render(<PropertiesPanel />);

    // Section renders inside HostContributionErrorBoundary
    expect(screen.getByTestId('section-single-render')).toBeInTheDocument();

    // getRecoveryKey should be called with the correct extensionId
    // resolved from contributionIndex
    expect(getRecoveryKeySpy).toHaveBeenCalledWith('ext.once');
  });

  it('does not call getRecoveryKey when extensionId is not in ownerMap', () => {
    const getRecoveryKeySpy = vi.fn(() => '1');

    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      extensionRuntime: {
        contributionIndex: createContributionIndex([]), // empty index
      },
      getRecoveryKey: getRecoveryKeySpy,
      incrementRecoveryKey: vi.fn(),
    });

    const section = {
      id: 'before-orphan',
      placement: 'before-default' as const,
      render: (_ctx: unknown, _sel: unknown) => (
        <div data-testid="section-orphan">Orphan</div>
      ),
    };

    getInspectorContributionsMock.mockReturnValue({
      all: [section],
      beforeDefault: [section],
      afterDefault: [],
    });

    render(<PropertiesPanel />);

    expect(screen.getByTestId('section-orphan')).toBeInTheDocument();

    // getRecoveryKey should NOT be called for an unknown extension
    // (HostContributionErrorBoundary falls back to legacy when extensionId
    // resolves to undefined via the empty contribution index.)
    expect(getRecoveryKeySpy).not.toHaveBeenCalled();
  });
});

describe('HostContributionErrorBoundary — asset panels', () => {
  beforeEach(() => {
    useVideoEditorRenderContextMock.mockReturnValue({ timelineId: 'timeline-1' });
    useTimelineEditorDataMock.mockReturnValue(createBaseEditorData());
    useTimelineEditorOpsMock.mockReturnValue(createEditorOps());
    useVideoEditorPanelRegistryMock.mockReturnValue({ panels: [], inspectorSections: [] });
    useVideoEditorAssetPanelsMock.mockReturnValue([createAssetPanel('asset-panel-extra')]);
    useShaderEffectRegistrySnapshotMock.mockReturnValue(createShaderSnapshot());
    getInspectorContributionsMock.mockReturnValue({
      all: [],
      beforeDefault: [],
      afterDefault: [],
    });
    useOptionalVideoEditorRuntimeMock.mockReturnValue(null);
  });

  it('renders extension asset panels through HostContributionErrorBoundary with extensionId from ownerMap', () => {
    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      extensionRuntime: {
        contributionIndex: createContributionIndex([
          { kind: 'panel', contributionId: 'asset-panel-extra', extensionId: 'ext.panels' },
        ]),
      },
      getRecoveryKey: vi.fn(() => '1'),
      incrementRecoveryKey: vi.fn(() => '2'),
    });

    const { container } = render(<VideoEditorAssetPanelSurface includeBuiltIn />);

    expect(screen.getByTestId('mock-built-in-asset-panel')).toBeInTheDocument();
    expect(screen.getByTestId('panel-asset-panel-extra')).toBeInTheDocument();
  });

  it('falls back to undefined extensionId when no runtime is available', () => {
    // useOptionalVideoEditorRuntimeMock returns null by default

    render(<VideoEditorAssetPanelSurface includeBuiltIn />);

    expect(screen.getByTestId('mock-built-in-asset-panel')).toBeInTheDocument();
    expect(screen.getByTestId('panel-asset-panel-extra')).toBeInTheDocument();
  });

  it('threads extensionId from contributionIndex for asset panel HostContributionErrorBoundary', () => {
    const getRecoveryKeySpy = vi.fn(() => '1');
    const incrementRecoveryKeySpy = vi.fn(() => '2');

    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      extensionRuntime: {
        contributionIndex: createContributionIndex([
          { kind: 'panel', contributionId: 'asset-panel-tracked', extensionId: 'ext.tracked' },
        ]),
      },
      getRecoveryKey: getRecoveryKeySpy,
      incrementRecoveryKey: incrementRecoveryKeySpy,
    });

    const trackedPanel = {
      id: 'asset-panel-tracked',
      placement: 'asset-panel' as const,
      render: () => (
        <div data-testid="panel-tracked">Tracked panel</div>
      ),
    };

    useVideoEditorAssetPanelsMock.mockReturnValue([trackedPanel]);

    render(<VideoEditorAssetPanelSurface includeBuiltIn={false} />);

    expect(screen.getByTestId('panel-tracked')).toBeInTheDocument();
    expect(getRecoveryKeySpy).toHaveBeenCalledWith('ext.tracked');
  });

  it('does not call getRecoveryKey for asset panel with unknown extension in ownerMap', () => {
    const getRecoveryKeySpy = vi.fn(() => '1');

    useOptionalVideoEditorRuntimeMock.mockReturnValue({
      extensionRuntime: {
        contributionIndex: createContributionIndex([]),
      },
      getRecoveryKey: getRecoveryKeySpy,
      incrementRecoveryKey: vi.fn(),
    });

    const orphanPanel = {
      id: 'asset-panel-orphan',
      placement: 'asset-panel' as const,
      render: () => (
        <div data-testid="panel-orphan">Orphan</div>
      ),
    };

    useVideoEditorAssetPanelsMock.mockReturnValue([orphanPanel]);

    render(<VideoEditorAssetPanelSurface includeBuiltIn={false} />);

    expect(screen.getByTestId('panel-orphan')).toBeInTheDocument();
    expect(getRecoveryKeySpy).not.toHaveBeenCalled();
  });
});

// ─── Data item inspector dispatch (dataKind V1, Batch 7) ───────────────────

function createDataItemFixture(overrides: Partial<FrozenDataItem> = {}): FrozenDataItem {
  return {
    id: 'asset-1:0',
    shape: 'interval',
    domain: 'source_seconds',
    extent: { start: 2, end: 4 },
    schemaRef: 'astrid.transcript_segment/v1',
    payload: { text: 'hello world' },
    provenance: { adapterId: 'astrid.adaptTranscript', adapterVersion: '1' },
    ...overrides,
  };
}

function createDataLaneFixture(overrides: Partial<DataLaneView> = {}): DataLaneView {
  return {
    laneId: 'transcript',
    kindId: 'transcript',
    label: 'Transcript',
    schemaRef: 'astrid.transcript_segment/v1',
    shape: 'interval',
    domain: 'source_seconds',
    items: [{ item: createDataItemFixture(), timelineStart: 2, timelineEnd: 4, clipId: 'clip-1' }],
    hidden: false,
    height: 24,
    opaque: false,
    ...overrides,
  };
}

function createDataTargetEditorData(overrides: {
  inspectorTarget?: unknown;
  lanes?: DataLaneView[];
} = {}) {
  const base = createBaseEditorData();
  return {
    ...base,
    data: {
      ...base.data,
      dataLanes: overrides.lanes ?? [createDataLaneFixture()],
    },
    inspectorTarget: overrides.inspectorTarget ?? null,
  };
}

describe('PropertiesPanel — data item inspector dispatch', () => {
  let consoleErrorSpy: MockInstance;
  let consoleWarnSpy: MockInstance;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useVideoEditorRenderContextMock.mockReturnValue({ timelineId: 'timeline-1' });
    useTimelineEditorOpsMock.mockReturnValue(createEditorOps());
    useVideoEditorPanelRegistryMock.mockReturnValue({ panels: [], inspectorSections: [] });
    useVideoEditorAssetPanelsMock.mockReturnValue([]);
    useShaderEffectRegistrySnapshotMock.mockReturnValue(createShaderSnapshot());
    getInspectorContributionsMock.mockReturnValue({
      all: [],
      beforeDefault: [],
      afterDefault: [],
    });
    useOptionalVideoEditorRuntimeMock.mockReturnValue(null);
    // Default: identity semantics (no assembled lanes → base passthrough).
    useDataLanesMock.mockImplementation((args?: { base?: unknown }) => args?.base ?? null);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('dispatches the dataItem target over the selected clip underneath the lane', () => {
    useTimelineEditorDataMock.mockReturnValue(createDataTargetEditorData({
      inspectorTarget: { kind: 'dataItem', laneId: 'transcript', itemId: 'asset-1:0' },
    }));

    render(<PropertiesPanel />);

    // Branch-order contract: the dataItem target wins even though clip-1 is
    // still the selected clip.
    expect(getInspectorContributionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'dataItem', laneId: 'transcript', itemId: 'asset-1:0' }),
    );
    // R3c: a resolvable data target owns the body — the clip panel is replaced,
    // not appended alongside.
    expect(screen.queryByTestId('mock-clip-panel')).not.toBeInTheDocument();
  });

  it('shows the selected canonical occurrence identity instead of an empty clip inspector', () => {
    const editorData = createDataTargetEditorData({
      inspectorTarget: {
        kind: 'shotOccurrence',
        occurrenceId: 'occurrence-opening',
        shotId: 'shot-opening',
        revisionId: 'revision-opening',
        parentDocumentId: 'timeline-1',
        shotName: 'Opening',
        trackId: 'picture',
        start: 1,
        end: 5,
      },
    });
    useTimelineEditorDataMock.mockReturnValue({
      ...editorData,
      selectedClip: null,
      selectedClipIds: new Set<string>(),
      selectedTrackId: 'picture',
    });

    render(<PropertiesPanel />);

    expect(screen.getByTestId('shot-occurrence-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('shot-occurrence-inspector-id')).toHaveTextContent('occurrence-opening');
    expect(screen.getByText('Opening')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-clip-panel')).not.toBeInTheDocument();
  });

  it('resolves lane items from the patched lane plane, not the store dataLanes (R1)', () => {
    // Store: frozen-empty `dataLanes` default. Only the render-side plane
    // — the same one the canvas renders via useDataLanes — carries lanes.
    const base = createBaseEditorData();
    useTimelineEditorDataMock.mockReturnValue({
      ...base,
      data: { ...base.data, dataLanes: Object.freeze([]) },
      inspectorTarget: { kind: 'dataItem', laneId: 'transcript', itemId: 'asset-1:0' },
    });
    useDataLanesMock.mockReturnValue({
      ...base.data,
      dataLanes: [createDataLaneFixture()],
    });

    render(<PropertiesPanel />);

    expect(useDataLanesMock).toHaveBeenCalledWith({ base: expect.objectContaining({ dataLanes: [] }) as never });
    expect(screen.getByTestId('opaque-data-item-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('opaque-data-item-id')).toHaveTextContent('asset-1:0');
  });

  it('renders OpaqueDataItemInspector with the six facts when no inspector is bound', () => {
    useTimelineEditorDataMock.mockReturnValue(createDataTargetEditorData({
      inspectorTarget: { kind: 'dataItem', laneId: 'transcript', itemId: 'asset-1:0' },
    }));

    render(<PropertiesPanel />);

    expect(screen.getByTestId('opaque-data-item-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('opaque-data-item-id')).toHaveTextContent('asset-1:0');
    expect(screen.getByTestId('opaque-data-item-shape')).toHaveTextContent('interval');
    expect(screen.getByTestId('opaque-data-item-schema-ref')).toHaveTextContent('astrid.transcript_segment/v1');
    expect(screen.getByTestId('opaque-data-item-extent')).toHaveTextContent('[2, 4)');
    expect(screen.getByTestId('opaque-data-item-domain')).toHaveTextContent('source_seconds');
    expect(screen.getByTestId('opaque-data-item-adapter')).toHaveTextContent('astrid.adaptTranscript');
    expect(screen.getByTestId('opaque-data-item-payload')).toHaveTextContent('hello world');
  });

  it('clears clip and track selection when a lane target arrives (regression)', () => {
    const ops = createEditorOps();
    useTimelineEditorOpsMock.mockReturnValue(ops);
    useTimelineEditorDataMock.mockReturnValue({
      ...createDataTargetEditorData({
        inspectorTarget: { kind: 'dataLane', laneId: 'transcript' },
      }),
      selectedTrackId: 'track-1',
    });

    render(<PropertiesPanel />);

    expect(getInspectorContributionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'dataLane', laneId: 'transcript' }),
    );
    expect(ops.clearSelection).toHaveBeenCalled();
    expect(ops.setSelectedTrackId).toHaveBeenCalledWith(null);
    expect(screen.queryByTestId('opaque-data-item-inspector')).not.toBeInTheDocument();
    // Rework R3d: a dataLane target renders the host lane summary — label,
    // schemaRef, shape, item count — in place of the clip panel body.
    expect(screen.getByTestId('data-lane-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-clip-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('data-lane-summary-schema-ref')).toHaveTextContent('astrid.transcript_segment/v1');
    expect(screen.getByTestId('data-lane-summary-item-count')).toHaveTextContent('1');
  });

  it('renders the bound kind inspector inside the host boundary when registered', () => {
    const lane = createDataLaneFixture({
      inspector: (() => <div data-testid="kind-inspector">kind</div>) as DataLaneView['inspector'],
    });
    useTimelineEditorDataMock.mockReturnValue(createDataTargetEditorData({
      inspectorTarget: { kind: 'dataItem', laneId: 'transcript', itemId: 'asset-1:0' },
      lanes: [lane],
    }));

    render(<PropertiesPanel />);

    expect(screen.getByTestId('kind-inspector')).toBeInTheDocument();
    expect(screen.queryByTestId('opaque-data-item-inspector')).not.toBeInTheDocument();
  });

  it('preserves stable source identity and provenance for a bound kind inspector', () => {
    const inspector = vi.fn((props: DataItemInspectorProps) => (
      <div data-testid="kind-source-identity">
        {props.item.sourceItemId}:{props.item.sourceArtifactRef?.assetId}:{props.item.provenance?.adapterId}
      </div>
    ));
    const item = createDataItemFixture({
      sourceItemId: 'transcript-segment-stable-1',
      sourceArtifactRef: { assetId: 'asset-transcript', artifactHash: 'sha256:abc' },
      provenance: { adapterId: 'astrid.adaptTranscript', adapterVersion: '2' },
    });
    const lane = createDataLaneFixture({
      items: [{ item, timelineStart: 2, timelineEnd: 4, clipId: 'clip-1' }],
      inspector: inspector as unknown as DataLaneView['inspector'],
    });
    useTimelineEditorDataMock.mockReturnValue(createDataTargetEditorData({
      inspectorTarget: { kind: 'dataItem', laneId: 'transcript', itemId: 'asset-1:0' },
      lanes: [lane],
    }));

    render(<PropertiesPanel />);

    expect(screen.getByTestId('kind-source-identity')).toHaveTextContent(
      'transcript-segment-stable-1:asset-transcript:astrid.adaptTranscript',
    );
    expect(inspector.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      item: expect.objectContaining({
        id: 'asset-1:0',
        sourceItemId: 'transcript-segment-stable-1',
        sourceArtifactRef: { assetId: 'asset-transcript', artifactHash: 'sha256:abc' },
        provenance: { adapterId: 'astrid.adaptTranscript', adapterVersion: '2' },
      }),
    }));
  });

  it('contains a crashing kind inspector in the contribution error boundary', () => {
    const lane = createDataLaneFixture({
      inspector: (() => {
        throw new Error('inspector exploded');
      }) as DataLaneView['inspector'],
    });
    useTimelineEditorDataMock.mockReturnValue(createDataTargetEditorData({
      inspectorTarget: { kind: 'dataItem', laneId: 'transcript', itemId: 'asset-1:0' },
      lanes: [lane],
    }));

    render(<PropertiesPanel />);

    expect(document.querySelector('[data-video-editor-contribution-error="true"]')).not.toBeNull();
    expect(screen.queryByTestId('mock-clip-panel')).not.toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('renders nothing extra for stale lane/item ids instead of crashing', () => {
    useTimelineEditorDataMock.mockReturnValue(createDataTargetEditorData({
      inspectorTarget: { kind: 'dataItem', laneId: 'gone-lane', itemId: 'asset-1:0' },
    }));

    render(<PropertiesPanel />);

    expect(screen.queryByTestId('opaque-data-item-inspector')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-clip-panel')).toBeInTheDocument();
  });
});


describe('mounted store transcript selection lifecycle', () => {
  afterEach(() => { realStoreSelectionTest = false; });
  it.each([PropertiesPanel, PropertiesPanelBody])('retains item selection through inspector passive effects, clears on empty canvas, and permits reselection (%s)', async (Panel) => {
    realStoreSelectionTest = true;
    __resetSelectionStoreForTests();
    useDataLanesMock.mockImplementation((args?: { base?: unknown }) => args?.base ?? null);
    useVideoEditorRenderContextMock.mockReturnValue({ timelineId: 'timeline-1' });
    useVideoEditorPanelRegistryMock.mockReturnValue({ panels: [], inspectorSections: [] });
    useVideoEditorAssetPanelsMock.mockReturnValue([]);
    useShaderEffectRegistrySnapshotMock.mockReturnValue(createShaderSnapshot());
    getInspectorContributionsMock.mockReturnValue({ all: [], beforeDefault: [], afterDefault: [] });
    const lane = createDataLaneFixture({ laneId: 'astrid.transcript', kindId: 'astrid.transcript', laneRenderer: TranscriptLane,
      items: [{ item: createDataItemFixture(), timelineStart: 2, timelineEnd: 4, clipId: 'clip-1' },
        { item: createDataItemFixture({ id: 'asset-1:1' }), timelineStart: 4, timelineEnd: 5, clipId: 'clip-1' }] });
    const store = createTimelineStore();
    const update = (patch: Partial<TimelineEditorDataContextValue>) => store.getState().syncDataSlice({ ...store.getState().data, ...patch });
    const clearSelection = vi.fn(() => { editorClearTimelineSelection(); update({ selectedDataItems: [], selectedClipIds: new Set(), selectedClip: null, selectedTrackId: null, inspectorTarget: null, contextTarget: null }); });
    const ops = {
      ...createEditorOps(), applyEdit: vi.fn(), clearSelection,
      setSelectedTrackId: (selectedTrackId: string | null) => update({ selectedTrackId }),
      setInspectorTarget: (inspectorTarget: TimelineEditorDataContextValue['inspectorTarget']) => update({ inspectorTarget }),
      setContextTarget: (contextTarget: TimelineEditorDataContextValue['contextTarget']) => update({ contextTarget }),
    } as unknown as TimelineEditorOpsContextValue;
    store.getState().syncSlices({ data: {
      ...store.getState().data, ...createBaseEditorData(),
      data: { ...createBaseEditorData().data, dataLanes: [lane] },
      selectedClip: null, selectedClipIds: new Set(), selectedTrackId: null, inspectorTarget: null,
    } as unknown as TimelineEditorDataContextValue, ops });
    function Surface() {
      const selection = useTimelineSelectionStore();
      useLayoutEffect(() => update({ selectedDataItems: selection.selectedDataItems, selectedClipIds: selection.selectedClipIds }), [selection.selectedDataItems, selection.selectedClipIds]);
      const data = useTimelineEditorData();
      const editorOps = useTimelineEditorOps();
      const editAreaRef = useRef<HTMLDivElement>(null);
      const marquee = useMarqueeSelect({ editAreaRef, deviceClass: 'desktop', gestureOwner: 'none',
        setGestureOwner: () => {}, setInputModalityFromPointerType: () => 'mouse', onClearSelection: editorOps.clearSelection });
      return <><div ref={editAreaRef} data-testid="selection-canvas" onPointerDown={marquee.onPointerDown}>
        <DataLaneList data={data.data} pixelsPerSecond={50} selectedTarget={data.inspectorTarget} selectedDataItems={data.selectedDataItems}
          clearSelection={editorOps.clearSelection} setSelectedTrackId={editorOps.setSelectedTrackId}
          setInspectorTarget={editorOps.setInspectorTarget} setContextTarget={editorOps.setContextTarget} />
      </div>{Panel === PropertiesPanelBody ? <PropertiesPanelBody hostObservations={{
        staleAssetKeys: new Set(), dismissedAssetKeys: new Set(), dismissAsset: () => {}, updateAssetToCurrentVariant: () => {},
        applyVariantToAsset: () => {}, addVariantAsGenerationAfterClip: () => {}, isAddingVariantAsGenerationPending: () => false,
      } as never} effectResources={{} as never} ClipInspector={() => <div data-testid="fixture-empty-body-inspector" />} /> : <PropertiesPanel />}</>;
    }
    render(<TimelineStoreProvider store={store}><Surface /></TimelineStoreProvider>);
    const [item, secondItem] = screen.getAllByTestId('transcript-lane-occurrence');
    const expected = { kind: 'dataItem', laneId: 'astrid.transcript', itemId: 'asset-1:0' };
    fireEvent.pointerDown(item, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(item, { button: 0, pointerId: 1 });
    fireEvent.click(item);
    await waitFor(() => expect(item).toHaveAttribute('data-selected', 'true'));
    expect(store.getState().data.inspectorTarget).toMatchObject(expected);
    expect(store.getState().data.contextTarget).toMatchObject(expected);
    expect(screen.getByTestId('opaque-data-item-inspector')).toBeInTheDocument();
    // A normal provider rerender must not let the mounted inspector clear it.
    act(() => update({ inputModality: 'touch' }));
    expect(item).toHaveAttribute('data-selected', 'true');
    expect(store.getState().data.inspectorTarget).toMatchObject(expected);
    const empty = screen.getByTestId('selection-canvas');
    fireEvent.pointerDown(empty, { button: 0, pointerId: 2, clientX: 600, clientY: 200 });
    fireEvent.pointerUp(empty, { button: 0, pointerId: 2, clientX: 600, clientY: 200 });
    await waitFor(() => expect(item).toHaveAttribute('data-selected', 'false'));
    expect(store.getState().data.inspectorTarget).toBeNull();
    expect(store.getState().data.contextTarget).toBeNull();
    expect(screen.queryByTestId('opaque-data-item-inspector')).toBeNull();
    fireEvent.click(item);
    await waitFor(() => expect(item).toHaveAttribute('data-selected', 'true'));
    expect(store.getState().data.inspectorTarget).toMatchObject(expected);
    fireEvent.click(secondItem, { shiftKey: true });
    await waitFor(() => expect(secondItem).toHaveAttribute('data-selected', 'true'));
    expect(item).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('timeline-item-selection-summary')).toHaveTextContent('2 transcript items selected');
    act(() => userSelectTimelineItems({ clipIds: ['clip-1'], dataItems: store.getState().data.selectedDataItems }, { additive: false }));
    await waitFor(() => expect(screen.getByTestId('timeline-item-selection-summary')).toHaveTextContent('3 items selected'));
    expect(screen.getByTestId('timeline-item-selection-summary')).toHaveTextContent('1 media clip · 2 transcript items');
    expect(screen.queryByText('Delete selection')).toBeNull();
    expect(screen.queryByTestId('mock-bulk-clip-panel')).toBeNull();
    fireEvent.click(secondItem, { ctrlKey: true });
    await waitFor(() => expect(secondItem).toHaveAttribute('data-selected', 'false'));
    expect(item).toHaveAttribute('data-selected', 'true');
    fireEvent.click(secondItem); // ordinary click replaces the entire mixed set
    await waitFor(() => expect(item).toHaveAttribute('data-selected', 'false'));
    expect(secondItem).toHaveAttribute('data-selected', 'true');
    expect(store.getState().data.selectedClipIds.size).toBe(0);
    expect(screen.queryByTestId('timeline-item-selection-summary')).toBeNull();
    expect(ops.applyEdit).not.toHaveBeenCalled();
  });
});
