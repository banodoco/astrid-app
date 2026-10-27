import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import {
  formatAstridExecutorDiagnostic,
  useRenderState,
} from '@/tools/video-editor/hooks/useRenderState';
import { createProcessResultAttachRecord } from '@/tools/video-editor/runtime/composition/processResultAttach';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types';
import type { ExtensionRuntime } from '@/tools/video-editor/runtime/extensionSurface';
import {
  EffectRegistryProvider,
  useEffectRegistryContext,
} from '@/tools/video-editor/effects/registry/EffectRegistryContext';
import type {
  EffectRegistry,
  EffectRegistryRecord,
  EffectRegistrySnapshot,
} from '@/tools/video-editor/effects/registry';
import {
  VideoEditorRuntimeContext,
  type VideoEditorRuntimeContextValue,
} from '@/tools/video-editor/contexts/VideoEditorRuntimeContext';
import { createDiagnosticCollection } from '@astrid/editor-sdk';

const mocks = vi.hoisted(() => ({
  startClientRender: vi.fn(),
  downloadRenderedFile: vi.fn().mockResolvedValue(undefined),
  toastError: vi.fn(),
}));

vi.mock('@/tools/video-editor/lib/render-download.ts', () => ({ downloadRenderedFile: mocks.downloadRenderedFile }));
vi.mock('@/shared/components/ui/toast.tsx', () => ({ toast: { error: mocks.toastError } }));

const renderRouterMocks = vi.hoisted(() => ({
  buildRenderTimelinePayload: vi.fn(),
  enqueueAstridRuntimeRenderTimeline: vi.fn(),
  cancelAstridRenderTask: vi.fn(),
  decideRenderRoute: vi.fn((timeline: ResolvedTimelineConfig | null | undefined) => {
    const clip = timeline?.clips?.[0];
    if (clip?.generation?.sequence_lane === 'remotion_module' && !clip?.generation?.artifact_id) {
      return {
        route: 'preview-only',
        hasThemedClip: false,
        hasMediaClip: false,
        reason: 'remotion_module_missing_artifact',
      };
    }

    if (clip?.clipType === 'generated-module') {
      return {
        route: 'worker-astrid-runtime',
        hasThemedClip: false,
        hasMediaClip: false,
        reason: 'generated_remotion_module',
      };
    }

    return {
      route: 'browser-remotion',
      hasThemedClip: false,
      hasMediaClip: true,
      reason: 'pure_native_clips',
    };
  }),
}));

vi.mock('@/tools/video-editor/hooks/useClientRender', () => ({
  useClientRender: () => mocks.startClientRender,
}));

vi.mock('@/tools/video-editor/lib/renderRouter', () => ({
  buildRenderTimelinePayload: renderRouterMocks.buildRenderTimelinePayload,
  enqueueAstridRuntimeRenderTimeline: renderRouterMocks.enqueueAstridRuntimeRenderTimeline,
  cancelAstridRenderTask: renderRouterMocks.cancelAstridRenderTask,
  decideRenderRoute: renderRouterMocks.decideRenderRoute,
}));

const guardMocks = vi.hoisted(() => ({
  collectBuiltInKnownIds: vi.fn(),
  collectExtensionDeclaredIds: vi.fn(),
  hasTimelineShaderMetadata: vi.fn(),
  scanExportConfig: vi.fn(),
}));

const exportMocks = vi.hoisted(() => ({
  executeCompileOnlyOutput: vi.fn(),
}));

vi.mock('@/tools/video-editor/runtime/exportGuard', () => ({
  collectBuiltInKnownIds: guardMocks.collectBuiltInKnownIds,
  collectExtensionDeclaredIds: guardMocks.collectExtensionDeclaredIds,
  hasTimelineShaderMetadata: guardMocks.hasTimelineShaderMetadata,
  scanExportConfig: guardMocks.scanExportConfig,
}));

vi.mock('@/tools/video-editor/runtime/outputFormatRegistry', async () => {
  const actual = await vi.importActual('@/tools/video-editor/runtime/outputFormatRegistry');
  return {
    ...actual,
    executeCompileOnlyOutput: exportMocks.executeCompileOnlyOutput,
  };
});

const buildConfig = (clip: ResolvedTimelineConfig['clips'][number]): ResolvedTimelineConfig => ({
  output: {
    resolution: '1920x1080',
    fps: 30,
    file: 'out.mp4',
  },
  tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
  clips: [clip],
  registry: {},
});

function renderTaskDetail(
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
  result?: Record<string, unknown>,
) {
  return {
    task_id: 'render-task-1',
    run_id: 'run-render-1',
    project_id: 'demo-project',
    state: status,
    version: 2,
    capability_id: 'rendering.timeline_visualize',
    capability_digest: `sha256:${'a'.repeat(64)}`,
    schema_version: '1',
    input_object_ids: [],
    spec: {
      spec: {
        family: 'render_export',
        params: { timeline_ref: 'timeline-1' },
        output_policy: { create_generation: false },
      },
    },
    idempotency_key: 'astrid.render:test',
    created_at: '2026-08-22T12:00:00Z',
    updated_at: '2026-08-22T12:00:01Z',
    attempt_id: null,
    runtime_epoch: 7,
    ...(status === 'succeeded'
      ? {
          result: {
            outputs: [{ name: 'render', digest: `sha256:${'b'.repeat(64)}`, media_type: 'video/mp4', size: 123 }],
          },
        }
      : result === undefined ? {} : { result }),
  };
}

function makeProcessAttachRecord() {
  return createProcessResultAttachRecord({
    processDescriptor: {
      id: 'proc.descriptor',
      extensionId: 'ext.process',
      processId: 'dataset-process',
      label: 'Dataset Process',
      description: 'Produces attached refs.',
      protocol: 'stdio-jsonrpc',
      availableRoutes: ['browser-export'],
      operations: [
        {
          id: 'exportDataset',
          label: 'Export Dataset',
          routes: ['browser-export'],
          outputKinds: ['material', 'artifact'],
          requiredCapabilities: ['browser-export'],
          determinism: 'process-dependent',
        },
      ],
      requiredBy: [{ source: 'extension', extensionId: 'ext.process', contributionId: 'proc.descriptor' }],
      capabilities: { defaultRoute: 'browser-export', determinism: 'process-dependent', capabilityRequirements: [] },
      blockers: [],
      nextActions: [],
      spec: {
        id: 'dataset-process',
        label: 'Dataset Process',
        version: { semver: '1.0.0', declaredBy: 'ext.process', contributionId: 'proc.descriptor' },
      },
    } as any,
    attachedAt: '2026-07-04T22:30:00.000Z',
    result: {
      requestId: 'request-1',
      processId: 'dataset-process',
      operationId: 'exportDataset',
      status: 'completed',
      returnedMaterials: [{
        id: 'mat-attached',
        mediaKind: 'video',
        locator: { kind: 'provider', uri: 'provider://materials/mat-attached' },
        determinism: 'process-dependent',
        replacementPolicy: 'materialize-on-export',
        producerExtensionId: 'ext.shader',
        provenance: {
          contributionId: 'ext.shader.clip',
          shaderId: 'shader.preview.clip',
        },
      }],
      artifacts: [{
        id: 'artifact-1',
        route: 'browser-export',
        determinism: 'process-dependent',
        mediaKind: 'video',
        locator: { kind: 'provider', uri: 'provider://artifacts/artifact-1' },
        consumedMaterialRefs: [],
        findings: [],
      }],
      diagnostics: [],
      logs: [],
      availableActions: [],
    } as any,
  });
}

function emptyExtensionRuntime(): ExtensionRuntime {
  const config = {
    slots: {},
    dialogHost: { dialogs: [] },
    registry: { panels: [], inspectorSections: [] },
    overlays: [],
    assetParsers: [],
    outputFormats: [],
    processes: [],
    searchProviders: [],
    metadataFacets: [],
    assetDetailSections: [],
    effects: [],
    transitions: [],
    shaders: [],
    agentTools: [],
  } as ExtensionRuntime['config'];

  return {
    config,
    extensions: [],
    diagnostics: [],
    inactiveReserved: [],
    knownRenderIds: new Set(),
    contributionIndex: {},
    compositionGraph: {
      nodes: [{ id: 'timeline-postprocess', kind: 'timeline-postprocess', detail: { scope: 'postprocess' } }],
      edges: [],
      referenceStates: [],
      diagnostics: [],
    },
    settingsDefaults: {},
    assetParsers: config.assetParsers,
    outputFormats: config.outputFormats,
    processes: config.processes,
    searchProviders: config.searchProviders,
    metadataFacets: config.metadataFacets,
    assetDetailSections: config.assetDetailSections,
    effects: config.effects,
    transitions: config.transitions,
    shaders: config.shaders,
    agentTools: config.agentTools,
    requirements: [],
    packageStateInventory: [],
  };
}

function makeExtensionRuntime(overrides?: Partial<ExtensionRuntime>): ExtensionRuntime {
  const config = (overrides?.config ?? {
    slots: {},
    dialogHost: { dialogs: [] },
    registry: { panels: [], inspectorSections: [] },
    overlays: [],
    assetParsers: [],
    outputFormats: [],
    processes: [],
    searchProviders: [],
    metadataFacets: [],
    assetDetailSections: [],
    effects: [],
    transitions: [],
    shaders: [],
    agentTools: [],
  }) as ExtensionRuntime['config'];

  return {
    config,
    extensions: [],
    diagnostics: [],
    inactiveReserved: [],
    knownRenderIds: new Set(),
    contributionIndex: {},
    compositionGraph: {
      nodes: [{ id: 'timeline-postprocess', kind: 'timeline-postprocess', detail: { scope: 'postprocess' } }],
      edges: [],
      referenceStates: [],
      diagnostics: [],
    },
    settingsDefaults: {},
    assetParsers: overrides?.assetParsers ?? config.assetParsers,
    outputFormats: overrides?.outputFormats ?? config.outputFormats,
    processes: overrides?.processes ?? config.processes,
    searchProviders: overrides?.searchProviders ?? config.searchProviders,
    metadataFacets: overrides?.metadataFacets ?? config.metadataFacets,
    assetDetailSections: overrides?.assetDetailSections ?? config.assetDetailSections,
    effects: overrides?.effects ?? config.effects,
    transitions: overrides?.transitions ?? config.transitions,
    shaders: overrides?.shaders ?? config.shaders,
    agentTools: overrides?.agentTools ?? config.agentTools,
    requirements: [],
    packageStateInventory: [],
    ...overrides,
  };
}

function makeTimelineWithEffect(effectId: string): ResolvedTimelineConfig {
  return buildConfig({
    id: 'clip-with-effect',
    clipType: 'media',
    track: 'V1',
    at: 0,
    hold: 1,
    continuous: {
      type: effectId,
      params: {},
    },
  } as ResolvedTimelineConfig['clips'][number]);
}

function makeEffectRecord(
  effectId: string,
  capabilityStatus: 'supported' | 'blocked' = 'supported',
): EffectRegistryRecord {
  return {
    effectId,
    contributionId: `contrib.${effectId}`,
    component: ({ children }) => children,
    provenance: 'trusted-loader',
    ownerExtensionId: 'provider-ext',
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
          status: capabilityStatus,
          determinism: 'deterministic',
          ...(capabilityStatus === 'blocked'
            ? {
                blockerReason: 'route-unsupported',
                message: `Effect "${effectId}" cannot browser-export.`,
              }
            : {}),
        },
      ],
    },
  };
}

let capturedRegistry: EffectRegistry | null = null;

function CaptureRegistry({ children }: { children: ReactNode }) {
  capturedRegistry = useEffectRegistryContext().registry;
  return <>{children}</>;
}

function RegistryWrapper({ children }: { children: ReactNode }) {
  return (
    <EffectRegistryProvider>
      <CaptureRegistry>{children}</CaptureRegistry>
    </EffectRegistryProvider>
  );
}

function nonEmptyExtensionRuntime(): ExtensionRuntime {
  return makeExtensionRuntime({
    extensions: [
      {
        manifest: {
          id: 'provider-ext' as any,
          version: '1.0.0',
          contributions: [],
        },
      } as any,
    ],
  });
}

function cleanGuardResult() {
  return {
    diagnostics: [],
    findings: [],
    blockers: [],
    unknownClipTypes: [],
    unknownEffects: [],
    unknownTransitions: [],
    inactiveExtensionIds: {
      effectIds: new Set(),
      transitionIds: new Set(),
      clipTypeIds: new Set(),
    },
    hasBlockingErrors: false,
  };
}

function installSnapshotAwareGuardMock() {
  guardMocks.collectBuiltInKnownIds.mockReturnValue({
    clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
    effectTypes: new Set(),
    transitionTypes: new Set(),
  });
  guardMocks.collectExtensionDeclaredIds.mockReturnValue({
    effectIds: new Set(),
    transitionIds: new Set(),
    clipTypeIds: new Set(),
  });
  guardMocks.scanExportConfig.mockImplementation((
    config: ResolvedTimelineConfig | null,
    _builtIn: unknown,
    _extIds: unknown,
    snapshot?: EffectRegistrySnapshot,
  ) => {
    const effectId = (config?.clips[0]?.continuous as { type?: string } | undefined)?.type;
    const record = effectId ? snapshot?.get(effectId) : undefined;

    if (!effectId || !record) {
      return {
        ...cleanGuardResult(),
        diagnostics: [
          {
            severity: 'error',
            code: 'export/unknown-effect-type',
            message: `Continuous effect "${effectId ?? 'unknown'}" is not recognised. Ensure the required extension or registry is installed.`,
            detail: { clipId: 'clip-with-effect', effectType: effectId },
          },
        ],
        unknownEffects: effectId ? [effectId] : [],
        hasBlockingErrors: true,
      };
    }

    const browserExport = record.renderability.capabilities.find((capability) => capability.route === 'browser-export');
    if (browserExport?.status !== 'supported') {
      return {
        ...cleanGuardResult(),
        diagnostics: [
          {
            severity: 'error',
            code: 'export/unrenderable-effect',
            message: browserExport?.message ?? `Continuous effect "${effectId}" is registered but does not support browser export.`,
            detail: {
              clipId: 'clip-with-effect',
              effectType: effectId,
              renderRoute: 'browser-export',
            },
          },
        ],
        hasBlockingErrors: true,
      };
    }

    return cleanGuardResult();
  });
}

// ---------------------------------------------------------------------------
// Pre-existing routing tests (with no extensionRuntime — guard skipped)
// ---------------------------------------------------------------------------

describe('useRenderState render routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startClientRender.mockResolvedValue(undefined);
    renderRouterMocks.buildRenderTimelinePayload.mockReturnValue({
      payload: {
        timeline_id: 'timeline-1',
        timeline: {},
        assets: {},
        theme_id: '2rp',
        output_filename: 'out.mp4',
        project_id: 'demo-project',
        correlation_id: 'render-correlation',
      },
    });
    renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mockResolvedValue({
      status: 'queued',
      task_id: 'render-task-1',
      message: 'queued',
    });
    renderRouterMocks.cancelAstridRenderTask.mockResolvedValue(undefined);
    guardMocks.collectBuiltInKnownIds.mockReturnValue({
      clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
      effectTypes: new Set(['fade', 'slide-up']),
      transitionTypes: new Set(['crossfade']),
    });
    guardMocks.collectExtensionDeclaredIds.mockReturnValue({
      effectIds: new Set(),
      transitionIds: new Set(),
      clipTypeIds: new Set(),
    });
    guardMocks.scanExportConfig.mockReturnValue({
      diagnostics: [],
      unknownClipTypes: [],
      unknownEffects: [],
      unknownTransitions: [],
      inactiveExtensionIds: {
        effectIds: new Set(),
        transitionIds: new Set(),
        clipTypeIds: new Set(),
      },
      hasBlockingErrors: false,
    });
  });

  it('invokes the client renderer only for client-route timelines', async () => {
    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'clip-native',
        clipType: 'media',
        track: 'V1',
        at: 0,
        hold: 1,
      }),
      null,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    expect(result.current.renderStatus).toBe('idle');
  });

  it('admits the render and exposes the advisory seam report returned with its task', async () => {
    const seamReport = {
      version: 1 as const,
      fps: 30,
      guardFrames: 2,
      boundaries: [{
        frame: 30,
        timeSeconds: 1,
        participants: [{ownerId: 'b', clipId: 'b', path: ['clip', 'b'], behavior: 'source-change' as const}],
        structuralIssues: [],
        unacknowledgedRisk: true,
        requiresIntent: true,
      }],
      opaqueElements: [],
      structuralIssues: [],
      cues: [],
      warningCount: 1,
      blocked: true,
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(renderTaskDetail('queued')), { status: 200 })));
    renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mockResolvedValueOnce({
      status: 'queued',
      task_id: 'render-task-1',
      message: 'queued',
      seamReport,
    });
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/astrid' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({children}: {children: ReactNode}) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const {result, unmount} = renderHook(() => useRenderState(
      {...buildConfig({id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1}),
        app: {visualSeamContract: {mode: 'enforced'}}},
      null,
      undefined,
      undefined,
      vi.fn(async () => 7),
    ), {wrapper});

    await act(async () => { await result.current.startRender(); });

    expect(result.current.renderStatus).toBe('rendering');
    expect(result.current.visualSeamReport).toEqual(seamReport);
    expect(renderRouterMocks.enqueueAstridRuntimeRenderTimeline).toHaveBeenCalledOnce();

    unmount();
    vi.unstubAllGlobals();
  });

  it('disables seam acknowledgement when the timeline changes after the failed render', async () => {
    const seamReport = {
      version: 1 as const,
      fps: 30,
      guardFrames: 2,
      boundaries: [{
        frame: 30,
        timeSeconds: 1,
        participants: [{ownerId: 'b', clipId: 'b', path: ['clip', 'b'], behavior: 'motion-start' as const,
          cue: {frame: 30, id: 'move', kind: 'motion-start' as const, path: ['clip', 'b']}}],
        structuralIssues: [],
        unacknowledgedRisk: true,
        requiresIntent: true,
      }],
      opaqueElements: [],
      structuralIssues: [],
      cues: [{frame: 30, id: 'move', kind: 'motion-start' as const, path: ['clip', 'b']}],
      warningCount: 1,
      blocked: true,
    };
    renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mockResolvedValueOnce({
      status: 'error',
      message: 'Astrid render admission failed: blocked by a Runtime validation error',
      seamReport,
    });
    const runtimeValue = {
      project: {projectId: 'demo-project'},
      timelineId: 'timeline-1',
      provider: {apiBaseUrl: '/api/astrid'},
      telemetry: {warn: vi.fn()},
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({children}: {children: ReactNode}) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const originalConfig = buildConfig({id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1});
    const changedConfig = {...originalConfig, clips: [...originalConfig.clips, {id: 'later', clipType: 'media', track: 'V1', at: 1, hold: 1}]};
    const persist = vi.fn(async () => undefined);
    const {result, rerender} = renderHook(({config}) => useRenderState(config, null, undefined, undefined,
      vi.fn(async () => 7), persist), {
      initialProps: {config: originalConfig},
      wrapper,
    });

    await act(async () => { await result.current.startRender(); });
    rerender({config: changedConfig});

    expect(result.current.visualSeamReport).toEqual(seamReport);
    expect(result.current.canAcknowledgeVisualCues).toBe(false);
    await act(async () => { await result.current.acknowledgeVisualCuesAsSynchronized(); });
    expect(persist).not.toHaveBeenCalled();
  });

  it('uses an injected exporter instead of the client renderer when one is supplied', async () => {
    const exporter = {
      render: vi.fn(async () => ({
        id: 'job-1',
        subscribe(listener: (progress: { phase: string; progress?: number; resultUrl?: string | null; log?: string }) => void) {
          listener({
            phase: 'complete',
            progress: 1,
            resultUrl: 'blob:https://example.com/rendered',
            log: 'done',
          });
          return () => undefined;
        },
      })),
    };

    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'clip-native',
        clipType: 'media',
        track: 'V1',
        at: 0,
        hold: 1,
      }),
      {
        fps: 30,
        durationInFrames: 30,
        compositionWidth: 1920,
        compositionHeight: 1080,
      },
      exporter,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    expect(exporter.render).toHaveBeenCalledTimes(1);
    expect(mocks.startClientRender).not.toHaveBeenCalled();
    expect(result.current.renderStatus).toBe('done');
    expect(result.current.renderResultUrl).toBe('blob:https://example.com/rendered');
    expect(result.current.renderResultFilename).toBe('out.mp4');
  });

  it('downloads each new completion once across repeated events, StrictMode and remounts', async () => {
    const listeners: Array<(progress: { phase: string; resultUrl?: string }) => void> = [];
    const exporter = { render: vi.fn(async () => ({ id: 'job', subscribe(listener: typeof listeners[number]) {
      listeners.push(listener); return () => undefined;
    } })) };
    const hook = () => useRenderState(buildConfig({ id: 'clip', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 }, exporter);
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const view = renderHook(hook, { wrapper });
    expect(mocks.downloadRenderedFile).not.toHaveBeenCalled();
    await act(async () => { await view.result.current.startRender(); });
    await act(async () => { listeners[0]({ phase: 'complete', resultUrl: 'blob:first' }); });
    view.rerender();
    await act(async () => { listeners[0]({ phase: 'complete', resultUrl: 'blob:first' }); });
    expect(mocks.downloadRenderedFile).toHaveBeenCalledTimes(1);
    await act(async () => { await view.result.current.startRender(); });
    await act(async () => { listeners[0]({ phase: 'complete', resultUrl: 'blob:first' }); });
    expect(mocks.downloadRenderedFile).toHaveBeenCalledTimes(1);
    await act(async () => { listeners[1]({ phase: 'complete', resultUrl: 'blob:second' }); });
    expect(mocks.downloadRenderedFile).toHaveBeenCalledTimes(2);
    expect(mocks.downloadRenderedFile).toHaveBeenLastCalledWith('blob:second', 'out.mp4');
    view.unmount();
    renderHook(hook, { wrapper });
    expect(mocks.downloadRenderedFile).toHaveBeenCalledTimes(2);
  });

  it('keeps a completed render available when its automatic download fails', async () => {
    mocks.downloadRenderedFile.mockRejectedValueOnce(new Error('network unavailable'));
    const exporter = { render: vi.fn(async () => ({ id: 'job', subscribe(listener: (value: { phase: string; resultUrl: string }) => void) {
      listener({ phase: 'complete', resultUrl: 'blob:retry' }); return () => undefined;
    } })) };
    const { result } = renderHook(() => useRenderState(buildConfig({ id: 'clip', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 }, exporter));
    await act(async () => { await result.current.startRender(); });
    expect(result.current.renderStatus).toBe('done');
    expect(result.current.renderResultUrl).toBe('blob:retry');
    expect(mocks.toastError).toHaveBeenCalledWith('network unavailable', expect.objectContaining({ description: expect.stringContaining('retry Download') }));
  });

  it('blocks malformed remotion_module metadata without invoking the client renderer', async () => {
    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'clip-module-bad',
        clipType: 'media',
        track: 'V1',
        at: 0,
        hold: 1,
        generation: {
          sequence_lane: 'remotion_module',
        },
      }),
      null,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    expect(mocks.startClientRender).not.toHaveBeenCalled();
    expect(result.current.renderStatus).toBe('error');
    expect(result.current.renderLog).toContain('Render blocked');
    expect(result.current.renderLog).toContain('remotion_module_missing_artifact');
  });

  it('surfaces worker-unavailable state for valid remotion_module routes without client fallback', async () => {
    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'clip-module-good',
        clipType: 'generated-module',
        track: 'V1',
        at: 0,
        hold: 1,
        generation: {
          sequence_lane: 'remotion_module',
          artifact_id: 'artifact-1',
        },
      }),
      null,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    expect(mocks.startClientRender).not.toHaveBeenCalled();
    expect(result.current.renderStatus).toBe('error');
    expect(result.current.renderLog).toContain('Worker render unavailable');
    expect(result.current.renderLog).toContain('generated_remotion_module');
  });

  it('shows the Runtime waiting_reason when an expired lease requeues the render task', async () => {
    vi.useFakeTimers();
    // Exact Runtime body for a task whose worker died and whose lease expired
    // (Runtime tests/test_runtime_lease_expiry_reads.py): state queued,
    // waiting_reason waiting_for_worker, previous attempt_id and lease_fence kept.
    const requeued = {
      ...renderTaskDetail('queued'),
      attempt_id: '0a1d9743f21348cd910c6f6e2bbc4db0',
      waiting_reason: 'waiting_for_worker',
      lease_fence: 1,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(
      fetchMock.mock.calls.length === 1 ? renderTaskDetail('running') : requeued,
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/astrid' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const { result, unmount } = renderHook(() => useRenderState(
      buildConfig({ id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 },
      undefined,
      undefined,
      vi.fn(async () => 7),
    ), { wrapper });

    await act(async () => { await result.current.startRender(); });
    expect(result.current.renderLog).toBe('Astrid is rendering the timeline.');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.renderStatus).toBe('rendering');
    expect(result.current.renderLog).toContain('waiting for a worker');
    expect(result.current.renderLog).not.toBe('Render queued in Astrid.');
    expect(result.current.renderProgress?.phase).toBe('queued');

    unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('admits a scoped render, polls on the declared 2s cadence, and exposes the R9 media URL', async () => {
    vi.useFakeTimers();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    let reads = 0;
    const fetchMock = vi.fn(async () => {
      reads += 1;
      return new Response(JSON.stringify(renderTaskDetail(reads === 1 ? 'queued' : 'succeeded')), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/runtime' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const flushPendingSave = vi.fn(async () => 7);
    const { result, unmount } = renderHook(() => useRenderState(
      buildConfig({ id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 },
      undefined,
      undefined,
      flushPendingSave,
    ), { wrapper });

    await act(async () => { await result.current.startRender(); });
    expect(flushPendingSave).toHaveBeenCalledTimes(1);
    expect(renderRouterMocks.enqueueAstridRuntimeRenderTimeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destination: 'download' }),
    );
    expect(renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[0][1]).not.toHaveProperty('expectedVersion');
    // The provider is the Runtime's (`/api/runtime`); the Astrid-API client must still use `/api/astrid`.
    const admissionOptions = renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[0][1] as {
      client: { transport: { baseUrl: string } };
    };
    expect(admissionOptions.client.transport.baseUrl).toBe('/api/astrid');
    expect(result.current.renderStatus).toBe('rendering');
    expect(result.current.activeRenderTaskId).toBe('render-task-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.renderStatus).toBe('done');
    expect(result.current.renderProgress?.percent).toBe(100);
    expect(result.current.renderResultUrl).toBe(`/api/astrid/v1/objects/sha256%3A${'b'.repeat(64)}`);
    // The real completion owns one CORS download; controls only present the result.
    expect(mocks.downloadRenderedFile).toHaveBeenCalledWith(`/api/astrid/v1/objects/sha256%3A${'b'.repeat(64)}`, 'out.mp4');
    expect(mocks.downloadRenderedFile).toHaveBeenCalledTimes(1);
    expect(result.current.renderResultFilename).toBe('out.mp4');
    expect(result.current.renderResultInfo).toMatchObject({ revision: 7 });
    expect(typeof result.current.renderResultInfo?.completedAt).toBe('number');
    expect(mocks.startClientRender).not.toHaveBeenCalled();

    unmount();
    anchorClick.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('consumes bounded detail diagnostics for running progress and failed executor output', async () => {
    vi.useFakeTimers();
    let detail = renderTaskDetail('running');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/astrid' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const { result, unmount } = renderHook(() => useRenderState(
      buildConfig({ id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 },
      undefined,
      undefined,
      async () => 7,
    ), { wrapper });

    await act(async () => { await result.current.startRender(); });
    expect(result.current.renderProgress).toMatchObject({ current: 0, total: 30, percent: 0, phase: 'running' });

    detail = renderTaskDetail('failed', {
      error: {
        code: 'render_export_failed',
        reason: 'child_exit',
        type: 'executor',
        message: 'ffmpeg exited with code 7',
        retryable: false,
      },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.renderStatus).toBe('error');
    expect(result.current.renderLog).toContain('Astrid render failed: ffmpeg exited with code 7');
    expect(result.current.renderLog).toContain('code=render_export_failed');
    expect(result.current.renderLog).not.toContain('Open task details');

    unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('consumes Runtime heartbeat progress from the neutral task read model', async () => {
    vi.useFakeTimers();
    const detail = renderTaskDetail('running');
    detail.progress = { phase: 'render', percent: 42 };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/astrid' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const { result, unmount } = renderHook(() => useRenderState(
      buildConfig({ id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 },
      undefined,
      undefined,
      async () => 7,
    ), { wrapper });

    await act(async () => { await result.current.startRender(); });
    expect(result.current.renderProgress).toMatchObject({ current: 12.6, total: 30, percent: 42, phase: 'render' });

    unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses a new operation identity after terminal failure and retains it for admission retry', async () => {
    expect(formatAstridExecutorDiagnostic({
      attempts: [],
      result: {
        error: {
          message: 'scratch free space 1 is below required floor 2',
          retryable: false,
        },
      },
    })).toContain('scratch free space 1 is below required floor 2');

    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(renderTaskDetail('failed')), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderRouterMocks.enqueueAstridRuntimeRenderTimeline
      .mockResolvedValueOnce({ status: 'error', message: 'temporary admission failure' })
      .mockResolvedValue({ status: 'queued', task_id: 'render-task-1', message: 'queued' });
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/astrid' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const { result, unmount } = renderHook(() => useRenderState(
      buildConfig({ id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 },
      undefined,
      undefined,
      async () => 7,
    ), { wrapper });

    await act(async () => { await result.current.startRender(); });
    const firstOperationId = renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[0][1].operationId;
    expect(firstOperationId).toEqual(expect.any(String));
    expect(result.current.renderStatus).toBe('error');

    await act(async () => { await result.current.startRender(); });
    const secondOperationId = renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[1][1].operationId;
    expect(secondOperationId).toBe(firstOperationId);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.renderStatus).toBe('error');

    await act(async () => { await result.current.startRender(); });
    const thirdOperationId = renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[2][1].operationId;
    expect(thirdOperationId).not.toBe(firstOperationId);

    unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('redacts bridge-controlled credentials, access keys, and local paths without losing error context', () => {
    const accessKey = 'AKIAIOSFODNN7EXAMPLE';
    const bearer = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret-value';
    const quotedBearer = 'quoted-bearer-secret';
    const token = 'render-token-value';
    const password = 'local-password';
    const diagnostic = formatAstridExecutorDiagnostic({
      attempts: [{
        diagnostics: {
          progress: {},
          error: {
            code: 'render_export_failed',
            reason: 'child_exit',
            type: 'executor',
            message: [
              'ffmpeg failed while opening https://alice:password@example.test/render',
              `Authorization: Bearer ${bearer}`,
              `Authorization: "Bearer ${quotedBearer}"`,
              `token=${token}`,
              `password=${password}`,
              accessKey,
              'input=/Users/alice/project/output.mp4',
              'cache=/tmp/astrid-render/frame-001.png',
              'staging=C:\\Users\\alice\\AppData\\Local\\Temp\\render.mp4',
              'staging-forward=C:/Users/alice/AppData/Local/Temp/render.mp4',
            ].join(' '),
            retryable: false,
          },
        },
      }],
    } as Parameters<typeof formatAstridExecutorDiagnostic>[0]);

    expect(diagnostic).toContain('ffmpeg failed while opening');
    expect(diagnostic).toContain('code=render_export_failed');
    expect(diagnostic).toContain('reason=child_exit');
    expect(diagnostic).toContain('type=executor');
    expect(diagnostic).toContain('retryable=false');
    expect(diagnostic).toContain('https://[REDACTED]@example.test/render');
    expect(diagnostic).toContain('Authorization: Bearer [REDACTED]');
    expect(diagnostic).toContain('token=[REDACTED]');
    expect(diagnostic).toContain('password=[REDACTED]');
    expect(diagnostic).toContain('[REDACTED_AWS_KEY]');
    expect(diagnostic).toContain('input=[REDACTED_PATH]');
    expect(diagnostic).not.toContain('alice:password');
    expect(diagnostic).not.toContain(bearer);
    expect(diagnostic).not.toContain(quotedBearer);
    expect(diagnostic).not.toContain(token);
    expect(diagnostic).not.toContain(password);
    expect(diagnostic).not.toContain(accessKey);
    expect(diagnostic).not.toContain('/Users/alice/project');
    expect(diagnostic).not.toContain('/tmp/astrid-render');
    expect(diagnostic).not.toContain('C:\\Users\\alice');
    expect(diagnostic).not.toContain('C:/Users/alice');
    expect(diagnostic.length).toBeLessThanOrEqual(4_000);
  });

  it('does not let a late cancel completion erase a newer render intent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(renderTaskDetail('queued')), { status: 200 })));
    let resolveCancel!: () => void;
    const cancelPending = new Promise<void>((resolve) => { resolveCancel = resolve; });
    renderRouterMocks.cancelAstridRenderTask.mockReturnValueOnce(cancelPending);
    renderRouterMocks.enqueueAstridRuntimeRenderTimeline
      .mockResolvedValueOnce({ status: 'queued', task_id: 'render-task-1', message: 'queued' })
      .mockResolvedValueOnce({ status: 'queued', task_id: 'render-task-2', message: 'queued' });
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/astrid' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const { result, unmount } = renderHook(() => useRenderState(
      buildConfig({ id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 },
      undefined,
      undefined,
      async () => 7,
    ), { wrapper });

    await act(async () => { await result.current.startRender(); });
    const firstOperationId = renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[0][1].operationId;
    let cancellation!: Promise<void>;
    await act(async () => {
      cancellation = result.current.cancelRender();
      await Promise.resolve();
    });
    expect(renderRouterMocks.cancelAstridRenderTask).toHaveBeenCalledWith(expect.anything(), 'render-task-1');

    await act(async () => { await result.current.startRender(); });
    const secondOperationId = renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[1][1].operationId;
    expect(secondOperationId).not.toBe(firstOperationId);
    expect(result.current.activeRenderTaskId).toBe('render-task-2');
    expect(result.current.renderStatus).toBe('rendering');

    resolveCancel();
    await act(async () => { await cancellation; });
    expect(result.current.activeRenderTaskId).toBe('render-task-2');
    expect(result.current.renderStatus).toBe('rendering');

    unmount();
    vi.unstubAllGlobals();
  });

  it('cancels an active scoped render through the common fenced task helper', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(renderTaskDetail('queued')), { status: 200 })));
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/astrid' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const { result, unmount } = renderHook(() => useRenderState(
      buildConfig({ id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      undefined,
      undefined,
      async () => 8,
    ), { wrapper });

    await act(async () => { await result.current.startRender(); });
    const firstOperationId = renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[0][1].operationId;
    await act(async () => { await result.current.cancelRender(); });
    expect(renderRouterMocks.cancelAstridRenderTask).toHaveBeenCalledWith(expect.anything(), 'render-task-1');
    expect(result.current.renderStatus).toBe('idle');
    expect(result.current.activeRenderTaskId).toBeNull();
    expect(result.current.renderLog).toBe('Render cancelled.');

    await act(async () => { await result.current.startRender(); });
    const secondOperationId = renderRouterMocks.enqueueAstridRuntimeRenderTimeline.mock.calls[1][1].operationId;
    expect(secondOperationId).not.toBe(firstOperationId);

    unmount();
    vi.unstubAllGlobals();
  });

  it('does not admit a scoped render when the durable save barrier fails', async () => {
    const runtimeValue = {
      project: { projectId: 'demo-project' },
      timelineId: 'timeline-1',
      provider: { apiBaseUrl: '/api/astrid' },
      telemetry: { warn: vi.fn() },
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'clip-native', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      undefined,
      undefined,
      async () => { throw new Error('CAS conflict'); },
    ), { wrapper });

    await act(async () => { await result.current.startRender(); });

    expect(renderRouterMocks.enqueueAstridRuntimeRenderTimeline).not.toHaveBeenCalled();
    expect(result.current.renderStatus).toBe('error');
    expect(result.current.renderLog).toContain('CAS conflict');
  });
});

// ---------------------------------------------------------------------------
// Export guard tests
// ---------------------------------------------------------------------------

describe('useRenderState export guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startClientRender.mockResolvedValue(undefined);
  });

  describe('empty-runtime fast path', () => {
    it('skips guard work when extensionRuntime is undefined', async () => {
      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        undefined, // no extensionRuntime
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard was never invoked
      expect(guardMocks.collectBuiltInKnownIds).not.toHaveBeenCalled();
      expect(guardMocks.collectExtensionDeclaredIds).not.toHaveBeenCalled();
      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
      // Native routing preserved
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
      expect(result.current.renderStatus).toBe('idle');
    });

    it('skips guard work when extensionRuntime is empty (no extensions, no inactive reserved)', async () => {
      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        emptyExtensionRuntime(),
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard was never invoked
      expect(guardMocks.collectBuiltInKnownIds).not.toHaveBeenCalled();
      expect(guardMocks.collectExtensionDeclaredIds).not.toHaveBeenCalled();
      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
      // Native routing preserved
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    });

    it('does not let timeline shader preview metadata bypass export readiness', async () => {
      const message = 'Shader "shader.preview.clip" cannot export because no shader materializer produced RenderMaterial for clip "c1".';
      guardMocks.hasTimelineShaderMetadata.mockReturnValueOnce(true);
      guardMocks.scanExportConfig.mockReturnValue({
        ...cleanGuardResult(),
        diagnostics: [
          {
            severity: 'error',
            code: 'export/unrenderable-shader',
            message,
            extensionId: 'ext.shader',
            contributionId: 'ext.shader.clip',
            detail: {
              clipId: 'c1',
              shaderId: 'shader.preview.clip',
              shaderScope: 'clip',
              renderRoute: 'browser-export',
            },
          },
        ],
        blockers: [
          {
            id: 'export.shader.clip.c1.shader.preview.clip.browser-export.missing-materializer',
            severity: 'error',
            route: 'browser-export',
            reason: 'missing-material',
            message,
            clipId: 'c1',
            extensionId: 'ext.shader',
            contributionId: 'ext.shader.clip',
            detail: {
              shaderId: 'shader.preview.clip',
              shaderScope: 'clip',
            },
          },
        ],
        hasBlockingErrors: true,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
          app: {
            shader: {
              scope: 'clip',
              extensionId: 'ext.shader',
              contributionId: 'ext.shader.clip',
              shaderId: 'shader.preview.clip',
            },
          },
        }),
        null,
        null,
        emptyExtensionRuntime(),
      ));

      await act(async () => {
        await result.current.startRender();
      });

      expect(guardMocks.scanExportConfig).toHaveBeenCalledTimes(1);
      expect(result.current.renderStatus).toBe('error');
      expect(result.current.renderLog).toContain(message);
      expect(mocks.startClientRender).not.toHaveBeenCalled();
    });

    it('skips guard work when resolvedConfig is null even with extensions', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });

      const { result } = renderHook(() => useRenderState(
        null, // no config
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard was never invoked (null config = nothing to scan)
      expect(guardMocks.collectBuiltInKnownIds).not.toHaveBeenCalled();
      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
    });

    it('skips guard work when resolvedConfig has zero clips even with extensions', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });

      const emptyConfig: ResolvedTimelineConfig = {
        output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
        tracks: [],
        clips: [],
        registry: {},
      };

      const { result } = renderHook(() => useRenderState(
        emptyConfig,
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
    });
  });

  describe('export guard — blocking errors', () => {
    it('blocks render when export guard finds blocking errors (truly unknown clip type)', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });

      // Setup guard to return a blocking error
      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [
          {
            severity: 'error',
            code: 'export/unknown-clip-type',
            message: 'Clip type "alien-format" is not recognised.',
            detail: { clipId: 'c1', clipType: 'alien-format' },
          },
        ],
        unknownClipTypes: ['alien-format'],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: true,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Render was blocked
      expect(result.current.renderStatus).toBe('error');
      expect(result.current.renderLog).toContain('Export guard');
      expect(result.current.renderLog).toContain('alien-format');
      // Native routing was preserved — client render was NOT invoked
      expect(mocks.startClientRender).not.toHaveBeenCalled();
    });

    it('blocks exporter render too when guard finds blocking errors', async () => {
      const exporter = {
        render: vi.fn(),
      };

      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });

      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [
          {
            severity: 'error',
            code: 'export/unknown-effect-type',
            message: 'Entrance effect "crazy-spin" is not recognised.',
            detail: { clipId: 'c1', effectType: 'crazy-spin' },
          },
        ],
        unknownClipTypes: [],
        unknownEffects: ['crazy-spin'],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: true,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        exporter as any,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      expect(result.current.renderStatus).toBe('error');
      expect(result.current.renderLog).toContain('Export guard');
      expect(exporter.render).not.toHaveBeenCalled();
    });

    it('blocks with concise structured diagnostics in render log', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });

      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [
          {
            severity: 'error',
            code: 'export/unknown-clip-type',
            message: 'Clip type "alien-format" is not recognised.',
            detail: { clipId: 'c1', clipType: 'alien-format' },
          },
          {
            severity: 'warning',
            code: 'export/unknown-transition-type',
            message: 'Transition "star-wipe" is declared by an inactive extension.',
            detail: { clipId: 'c2', transitionType: 'star-wipe' },
          },
          {
            severity: 'error',
            code: 'export/unknown-effect-type',
            message: 'Continuous effect "hyperspace" is not recognised.',
            detail: { clipId: 'c3', effectType: 'hyperspace' },
          },
        ],
        unknownClipTypes: ['alien-format'],
        unknownEffects: ['hyperspace'],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(['star-wipe']),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: true,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      expect(result.current.renderStatus).toBe('error');
      const log = result.current.renderLog;
      // Summary line
      expect(log).toContain('Export guard: 3 issue(s) — 2 error(s), 1 warning(s)');
      // Error diagnostics shown first
      expect(log).toContain('[export/unknown-clip-type]');
      expect(log).toContain('[export/unknown-effect-type]');
      // Warning still shown
      expect(log).toContain('[export/unknown-transition-type]');
    });

    it('publishes export and planner diagnostics to the provider collection during guard execution', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });
      const collection = createDiagnosticCollection();
      const runtimeValue = {
        diagnosticCollection: collection,
      } as unknown as VideoEditorRuntimeContextValue;
      const wrapper = ({ children }: { children: ReactNode }) => (
        <VideoEditorRuntimeContext.Provider value={runtimeValue}>
          {children}
        </VideoEditorRuntimeContext.Provider>
      );

      guardMocks.scanExportConfig.mockReturnValue({
        ...cleanGuardResult(),
        diagnostics: [
          {
            severity: 'error',
            code: 'export/unknown-effect-type',
            message: 'Continuous effect "hyperspace" is not recognised.',
            detail: { clipId: 'c1', effectType: 'hyperspace' },
          },
        ],
        blockers: [
          {
            id: 'export.effect.c1.continuous.hyperspace.missing',
            severity: 'error',
            route: 'browser-export',
            reason: 'missing-contribution',
            message: 'Continuous effect "hyperspace" is not recognised.',
            clipId: 'c1',
            detail: { effectType: 'hyperspace', slot: 'continuous' },
          },
        ],
        hasBlockingErrors: true,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ), { wrapper });

      await act(async () => {
        await result.current.startRender();
      });

      const diagnostics = collection.getSnapshot();
      expect(diagnostics.some((diagnostic) => diagnostic.detail?.source === 'export-guard')).toBe(true);
      expect(diagnostics.some((diagnostic) => diagnostic.detail?.source === 'render-planner')).toBe(true);
    });

    it('uses planner blockers as the canonical render readiness decision', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });

      guardMocks.scanExportConfig.mockReturnValue({
        ...cleanGuardResult(),
        diagnostics: [],
        blockers: [
          {
            id: 'planner.compat.effect.browser-export.missing',
            severity: 'error',
            route: 'browser-export',
            reason: 'missing-contribution',
            message: 'Planner says the effect contribution is missing.',
          },
        ],
        hasBlockingErrors: false,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      expect(result.current.renderStatus).toBe('error');
      expect(mocks.startClientRender).not.toHaveBeenCalled();
    });
  });

  describe('export guard — warnings only (preserve native routing)', () => {
    it('allows render when only extension-declared (inactive) warnings are present', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [
                {
                  id: 'contrib.future' as any,
                  kind: 'transition' as any,
                  transitionId: 'future-transition',
                },
              ],
            },
          } as any,
        ],
      });

      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [
          {
            severity: 'warning',
            code: 'export/unknown-transition-type',
            message: 'Transition "future-transition" is declared by an inactive extension and may not be available at export time.',
            detail: { clipId: 'c1', transitionType: 'future-transition' },
          },
        ],
        unknownClipTypes: [],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(['future-transition']),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: false,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Native routing preserved — client render invoked
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
      // But diagnostics are still emitted in the render log
      expect(result.current.renderLog).toContain('Export guard');
      expect(result.current.renderLog).toContain('future-transition');
      expect(result.current.renderLog).toContain('warning');
    });

    it('allows render when guard finds no issues at all', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });

      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [],
        unknownClipTypes: [],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: false,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
      expect(result.current.renderLog).toContain('Export guard: no issues found.');
    });
  });

  describe('export guard — native routing preservation', () => {
    it('preserves existing preview-only block when guard passes', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'test-ext' as any,
              version: '1.0.0',
              contributions: [],
            },
          } as any,
        ],
      });

      // Guard passes — no blocking errors
      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [],
        unknownClipTypes: [],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: false,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'clip-module-bad',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
          generation: {
            sequence_lane: 'remotion_module',
          },
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard passed but preview-only blocked it — native routing preserved
      expect(result.current.renderStatus).toBe('error');
      expect(result.current.renderLog).toContain('Render blocked');
      expect(result.current.renderLog).toContain('remotion_module_missing_artifact');
      // But guard log was set first (then overwritten by the route block)
      // The route block's log takes precedence
      expect(mocks.startClientRender).not.toHaveBeenCalled();
    });

    it('passes extension contributions to collectExtensionDeclaredIds', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'ext-a' as any,
              version: '1.0.0',
              contributions: [
                { id: 'c1' as any, kind: 'effect' as any, effectId: 'my-effect' },
                { id: 'c2' as any, kind: 'transition' as any, transitionId: 'my-transition' },
              ],
            },
          } as any,
        ],
      });

      guardMocks.collectExtensionDeclaredIds.mockReturnValue({
        effectIds: new Set(['my-effect']),
        transitionIds: new Set(['my-transition']),
        clipTypeIds: new Set(),
      });

      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [],
        unknownClipTypes: [],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: false,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // collectExtensionDeclaredIds was called with the contributions
      expect(guardMocks.collectExtensionDeclaredIds).toHaveBeenCalledTimes(1);
      const callArg = guardMocks.collectExtensionDeclaredIds.mock.calls[0][0];
      expect(callArg).toHaveLength(2);
      expect(callArg[0].effectId).toBe('my-effect');
      expect(callArg[1].transitionId).toBe('my-transition');

      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    });
  });

  describe('export guard — pure-native no-extension routing parity', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.startClientRender.mockResolvedValue(undefined);
      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [],
        unknownClipTypes: [],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: false,
      });
      guardMocks.collectBuiltInKnownIds.mockReturnValue({
        clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
        effectTypes: new Set(['fade', 'slide-up']),
        transitionTypes: new Set(['crossfade']),
      });
      guardMocks.collectExtensionDeclaredIds.mockReturnValue({
        effectIds: new Set(),
        transitionIds: new Set(),
        clipTypeIds: new Set(),
      });
    });

    it('routes pure-native media clip through client renderer with no extension runtime (identical to pre-extension behavior)', async () => {
      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'clip-native',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        undefined, // no extensionRuntime
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard skipped, client renderer invoked — same as pre-extension
      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
      expect(result.current.renderStatus).toBe('idle');
    });

    it('routes pure-native media clip through client renderer with empty extension runtime (same as no extensions)', async () => {
      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'clip-native',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        emptyExtensionRuntime(),
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard skipped because runtime is empty, client renderer invoked
      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
      expect(result.current.renderStatus).toBe('idle');
    });

    it('routes pure-native clip through injected exporter with no extension runtime', async () => {
      const exporter = {
        render: vi.fn(async () => ({
          id: 'job-1',
          subscribe(listener: (progress: { phase: string; progress?: number; resultUrl?: string | null; log?: string }) => void) {
            listener({
              phase: 'complete',
              progress: 1,
              resultUrl: 'blob:https://example.com/rendered',
              log: 'done',
            });
            return () => undefined;
          },
        })),
      };

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'clip-native',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        {
          fps: 30,
          durationInFrames: 30,
          compositionWidth: 1920,
          compositionHeight: 1080,
        },
        exporter,
        undefined, // no extensionRuntime
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard skipped, exporter used (not client renderer)
      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
      expect(exporter.render).toHaveBeenCalledTimes(1);
      expect(mocks.startClientRender).not.toHaveBeenCalled();
      expect(result.current.renderStatus).toBe('done');
      expect(result.current.renderResultUrl).toBe('blob:https://example.com/rendered');
    });

    it('routes pure-native clip through injected exporter with empty extension runtime (same as no extensions)', async () => {
      const exporter = {
        render: vi.fn(async () => ({
          id: 'job-1',
          subscribe(listener: (progress: { phase: string; progress?: number; resultUrl?: string | null; log?: string }) => void) {
            listener({
              phase: 'complete',
              progress: 1,
              resultUrl: 'blob:https://example.com/rendered',
              log: 'done',
            });
            return () => undefined;
          },
        })),
      };

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'clip-native',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        {
          fps: 30,
          durationInFrames: 30,
          compositionWidth: 1920,
          compositionHeight: 1080,
        },
        exporter,
        emptyExtensionRuntime(),
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard skipped (empty runtime), exporter used — same routing as no extensions
      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
      expect(exporter.render).toHaveBeenCalledTimes(1);
      expect(mocks.startClientRender).not.toHaveBeenCalled();
      expect(result.current.renderStatus).toBe('done');
      expect(result.current.renderResultUrl).toBe('blob:https://example.com/rendered');
    });

    it('preserves preview-only routing with no extension runtime (identical to pre-extension behavior)', async () => {
      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'clip-module-bad',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
          generation: {
            sequence_lane: 'remotion_module',
          },
        }),
        null,
        null,
        undefined, // no extensionRuntime
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard skipped, preview-only block preserved
      expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
      expect(mocks.startClientRender).not.toHaveBeenCalled();
      expect(result.current.renderStatus).toBe('error');
      expect(result.current.renderLog).toContain('Render blocked');
      expect(result.current.renderLog).toContain('remotion_module_missing_artifact');
    });
  });

  describe('export guard — project requirement diagnostics', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.startClientRender.mockResolvedValue(undefined);
    });

    it('activates guard when extensions are present and emits no-error log for known native IDs', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'project-ext' as any,
              version: '1.0.0',
              contributions: [
                { id: 'c-bridged' as any, kind: 'slot', slot: 'toolbar' },
              ],
            },
          } as any,
        ],
      });

      // Setup guard to return clean (all native IDs known)
      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [],
        unknownClipTypes: [],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: false,
      });
      guardMocks.collectBuiltInKnownIds.mockReturnValue({
        clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
        effectTypes: new Set(['fade', 'slide-up']),
        transitionTypes: new Set(['crossfade']),
      });
      guardMocks.collectExtensionDeclaredIds.mockReturnValue({
        effectIds: new Set(),
        transitionIds: new Set(),
        clipTypeIds: new Set(),
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      expect(result.current.renderStatus).toBe('idle');
      expect(result.current.renderLog).toContain('Export guard: no issues found.');
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    });

    it('emits blocking errors when project uses IDs not declared by any extension', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'project-ext' as any,
              version: '1.0.0',
              contributions: [
                { id: 'c-bridged' as any, kind: 'slot', slot: 'toolbar' },
              ],
            },
          } as any,
        ],
      });

      guardMocks.collectBuiltInKnownIds.mockReturnValue({
        clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
        effectTypes: new Set(['fade', 'slide-up']),
        transitionTypes: new Set(['crossfade']),
      });
      guardMocks.collectExtensionDeclaredIds.mockReturnValue({
        effectIds: new Set(),
        transitionIds: new Set(),
        clipTypeIds: new Set(),
      });
      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [
          {
            severity: 'error',
            code: 'export/unknown-effect-type',
            message: 'Entrance effect "missing-effect" is not recognised. Ensure the required extension or registry is installed.',
            detail: { clipId: 'c1', effectType: 'missing-effect' },
          },
        ],
        unknownClipTypes: [],
        unknownEffects: ['missing-effect'],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: true,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Blocked because the effect is not declared by any extension and not built-in
      expect(result.current.renderStatus).toBe('error');
      expect(result.current.renderLog).toContain('Export guard');
      expect(result.current.renderLog).toContain('missing-effect');
      expect(mocks.startClientRender).not.toHaveBeenCalled();
    });

    it('preserves routing when project uses IDs declared by inactive extension contributions (warnings only)', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'future-ext' as any,
              version: '1.0.0',
              contributions: [
                { id: 'c-future-effect' as any, kind: 'effect' as any, effectId: 'future-effect' },
              ],
            },
          } as any,
        ],
      });

      guardMocks.collectBuiltInKnownIds.mockReturnValue({
        clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
        effectTypes: new Set(['fade', 'slide-up']),
        transitionTypes: new Set(['crossfade']),
      });
      guardMocks.collectExtensionDeclaredIds.mockReturnValue({
        effectIds: new Set(['future-effect']),
        transitionIds: new Set(),
        clipTypeIds: new Set(),
      });
      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [
          {
            severity: 'warning',
            code: 'export/unknown-effect-type',
            message: 'Entrance effect "future-effect" is declared by an inactive extension and may not be available at export time.',
            detail: { clipId: 'c1', effectType: 'future-effect' },
          },
        ],
        unknownClipTypes: [],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(['future-effect']),
          transitionIds: new Set(),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: false,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Not blocked — warning only, routing preserved
      expect(result.current.renderStatus).toBe('idle');
      expect(result.current.renderLog).toContain('Export guard');
      expect(result.current.renderLog).toContain('future-effect');
      expect(result.current.renderLog).toContain('warning');
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    });

    it('scans config for project requirements when multiple extensions contribute IDs', async () => {
      const extRuntime = makeExtensionRuntime({
        extensions: [
          {
            manifest: {
              id: 'ext-fx' as any,
              version: '1.0.0',
              contributions: [
                { id: 'c-fx1' as any, kind: 'effect' as any, effectId: 'custom-fx' },
              ],
            },
          } as any,
          {
            manifest: {
              id: 'ext-trans' as any,
              version: '1.0.0',
              contributions: [
                { id: 'c-tr1' as any, kind: 'transition' as any, transitionId: 'custom-transition' },
              ],
            },
          } as any,
        ],
      });

      guardMocks.collectBuiltInKnownIds.mockReturnValue({
        clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
        effectTypes: new Set(['fade', 'slide-up']),
        transitionTypes: new Set(['crossfade']),
      });
      guardMocks.collectExtensionDeclaredIds.mockReturnValue({
        effectIds: new Set(['custom-fx']),
        transitionIds: new Set(['custom-transition']),
        clipTypeIds: new Set(),
      });
      guardMocks.scanExportConfig.mockReturnValue({
        diagnostics: [
          {
            severity: 'warning',
            code: 'export/unknown-effect-type',
            message: 'Entrance effect "custom-fx" is declared by an inactive extension and may not be available at export time.',
            detail: { clipId: 'c1', effectType: 'custom-fx' },
          },
          {
            severity: 'warning',
            code: 'export/unknown-transition-type',
            message: 'Transition "custom-transition" is declared by an inactive extension and may not be available at export time.',
            detail: { clipId: 'c1', transitionType: 'custom-transition' },
          },
        ],
        unknownClipTypes: [],
        unknownEffects: [],
        unknownTransitions: [],
        inactiveExtensionIds: {
          effectIds: new Set(['custom-fx']),
          transitionIds: new Set(['custom-transition']),
          clipTypeIds: new Set(),
        },
        hasBlockingErrors: false,
      });

      const { result } = renderHook(() => useRenderState(
        buildConfig({
          id: 'c1',
          clipType: 'media',
          track: 'V1',
          at: 0,
          hold: 1,
        }),
        null,
        null,
        extRuntime,
      ));

      await act(async () => {
        await result.current.startRender();
      });

      // Guard invoked (extensions present), warnings emitted, routing preserved
      expect(guardMocks.scanExportConfig).toHaveBeenCalledTimes(1);
      expect(result.current.renderStatus).toBe('idle');
      expect(result.current.renderLog).toContain('Export guard');
      expect(result.current.renderLog).toContain('custom-fx');
      expect(result.current.renderLog).toContain('custom-transition');
      expect(result.current.renderLog).toContain('warning');
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    });
  });

  describe('export guard — provider registry snapshots', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      capturedRegistry = null;
      mocks.startClientRender.mockResolvedValue(undefined);
      installSnapshotAwareGuardMock();
    });

    it('passes the current provider snapshot into readiness checks and blocks missing effect IDs', async () => {
      const { result } = renderHook(() => useRenderState(
        makeTimelineWithEffect('missing-provider-effect'),
        null,
        null,
        nonEmptyExtensionRuntime(),
      ), { wrapper: RegistryWrapper });

      await act(async () => {
        await result.current.startRender();
      });

      expect(guardMocks.scanExportConfig).toHaveBeenCalledTimes(1);
      const snapshot = guardMocks.scanExportConfig.mock.calls[0][3] as EffectRegistrySnapshot;
      expect(snapshot.records).toHaveLength(0);
      expect(snapshot.has('missing-provider-effect')).toBe(false);
      expect(result.current.renderStatus).toBe('error');
      expect(result.current.renderLog).toContain('missing-provider-effect');
      expect(mocks.startClientRender).not.toHaveBeenCalled();
    });

    it('blocks provider records that are registered but cannot browser-export', async () => {
      const { result } = renderHook(() => useRenderState(
        makeTimelineWithEffect('preview-only-provider-effect'),
        null,
        null,
        nonEmptyExtensionRuntime(),
      ), { wrapper: RegistryWrapper });

      act(() => {
        capturedRegistry!.register(makeEffectRecord('preview-only-provider-effect', 'blocked'));
      });

      await act(async () => {
        await result.current.startRender();
      });

      expect(guardMocks.scanExportConfig).toHaveBeenCalledTimes(1);
      const snapshot = guardMocks.scanExportConfig.mock.calls[0][3] as EffectRegistrySnapshot;
      expect(snapshot.get('preview-only-provider-effect')?.renderability.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            route: 'browser-export',
            status: 'blocked',
          }),
        ]),
      );
      expect(result.current.renderStatus).toBe('error');
      expect(result.current.renderLog).toContain('cannot browser-export');
      expect(mocks.startClientRender).not.toHaveBeenCalled();
    });

    it('recomputes readiness from updated provider snapshots', async () => {
      const { result } = renderHook(() => useRenderState(
        makeTimelineWithEffect('late-provider-effect'),
        null,
        null,
        nonEmptyExtensionRuntime(),
      ), { wrapper: RegistryWrapper });

      await act(async () => {
        await result.current.startRender();
      });

      expect(result.current.renderLog).toContain('late-provider-effect');
      expect(mocks.startClientRender).not.toHaveBeenCalled();

      act(() => {
        capturedRegistry!.register(makeEffectRecord('late-provider-effect', 'supported'));
      });

      await act(async () => {
        await result.current.startRender();
      });

      expect(guardMocks.scanExportConfig).toHaveBeenCalledTimes(2);
      const firstSnapshot = guardMocks.scanExportConfig.mock.calls[0][3] as EffectRegistrySnapshot;
      const secondSnapshot = guardMocks.scanExportConfig.mock.calls[1][3] as EffectRegistrySnapshot;
      expect(firstSnapshot.records).toHaveLength(0);
      expect(secondSnapshot.has('late-provider-effect')).toBe(true);
      expect(secondSnapshot.records).toHaveLength(1);
      expect(result.current.renderLog).toContain('Export guard: no issues found.');
      expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    });
  });

// ---------------------------------------------------------------------------
// Export behavior — compile-only formats invoke registry, render-dependent
// formats are rejected, and existing Render behavior is unchanged
// ---------------------------------------------------------------------------

describe('useRenderState — M6 export behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startClientRender.mockResolvedValue(undefined);
    guardMocks.collectBuiltInKnownIds.mockReturnValue({
      clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
      effectTypes: new Set(['fade', 'slide-up']),
      transitionTypes: new Set(['crossfade']),
    });
    guardMocks.collectExtensionDeclaredIds.mockReturnValue({
      effectIds: new Set(),
      transitionIds: new Set(),
      clipTypeIds: new Set(),
    });
    guardMocks.scanExportConfig.mockReturnValue({
      diagnostics: [],
      unknownClipTypes: [],
      unknownEffects: [],
      unknownTransitions: [],
      inactiveExtensionIds: {
        effectIds: new Set(),
        transitionIds: new Set(),
        clipTypeIds: new Set(),
      },
      hasBlockingErrors: false,
    });
    exportMocks.executeCompileOnlyOutput.mockReset();
  });

  it('denies render execution before route selection for a read-only public host', async () => {
    const runtimeValue = {renderExportEnabled: false} as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({children}: {children: ReactNode}) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const {result} = renderHook(() => useRenderState(
      buildConfig({id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1}),
      null,
      null,
      makeExtensionRuntime(),
    ), {wrapper});

    await act(async () => { await result.current.startRender(); });

    expect(result.current.renderStatus).toBe('error');
    expect(result.current.renderLog).toBe('Render is unavailable in this read-only preview.');
    expect(renderRouterMocks.decideRenderRoute).not.toHaveBeenCalled();
    expect(renderRouterMocks.enqueueAstridRuntimeRenderTimeline).not.toHaveBeenCalled();
    expect(mocks.startClientRender).not.toHaveBeenCalled();
  });

  it('denies compile-only export before evaluating output formats for a read-only public host', async () => {
    const runtimeValue = {renderExportEnabled: false} as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({children}: {children: ReactNode}) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>{children}</VideoEditorRuntimeContext.Provider>
    );
    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: {dialogs: []},
        registry: {panels: [], inspectorSections: []},
        outputFormats: [
          {id: 'fmt-json', extensionId: 'ext-a', label: 'Metadata JSON', requiresRender: false, outputExtension: 'json', outputMimeType: 'application/json', disabled: false},
        ],
      } as any,
    });
    const {result} = renderHook(() => useRenderState(
      buildConfig({id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1}),
      null,
      null,
      extRuntime,
    ), {wrapper});

    await act(async () => { await result.current.startExport('fmt-json', new Map([['fmt-json', {}]])); });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toBe('Export is unavailable in this read-only preview.');
    expect(exportMocks.executeCompileOnlyOutput).not.toHaveBeenCalled();
    expect(guardMocks.scanExportConfig).not.toHaveBeenCalled();
  });

  // ---- exportFormats categorization ---------------------------------------

  it('categorizes output formats into compile-only and render-dependent from extension runtime config', () => {
    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-meta-json', extensionId: 'ext-a', label: 'Metadata JSON', requiresRender: false, outputExtension: 'json', disabled: false },
          { id: 'fmt-csv', extensionId: 'ext-a', label: 'CSV Export', requiresRender: false, outputExtension: 'csv', disabled: false },
          { id: 'fmt-mp4', extensionId: 'ext-b', label: 'MP4 Video', requiresRender: true, outputExtension: 'mp4', disabled: false },
          { id: 'fmt-disabled', extensionId: 'ext-b', label: 'Disabled Format', requiresRender: false, outputExtension: 'bin', disabled: true, disabledReason: 'Not yet implemented' },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    expect(result.current.exportFormats.compileOnly).toHaveLength(2);
    expect(result.current.exportFormats.compileOnly.map((f) => f.id)).toEqual(['fmt-meta-json', 'fmt-csv']);
    expect(result.current.exportFormats.renderDependent).toHaveLength(2);
    expect(result.current.exportFormats.renderDependent.map((f) => f.id)).toEqual(['fmt-mp4', 'fmt-disabled']);
  });

  it('returns empty arrays when no output formats are registered', () => {
    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    expect(result.current.exportFormats.compileOnly).toHaveLength(0);
    expect(result.current.exportFormats.renderDependent).toHaveLength(0);
  });

  it('returns empty arrays when extension runtime is undefined', () => {
    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      undefined,
    ));

    expect(result.current.exportFormats.compileOnly).toHaveLength(0);
    expect(result.current.exportFormats.renderDependent).toHaveLength(0);
  });

  // ---- startExport — compile-only invocation --------------------------------

  it('invokes executeCompileOnlyOutput for a valid compile-only format with timeline and assets', async () => {
    exportMocks.executeCompileOnlyOutput.mockResolvedValue({
      artifact: { id: 'artifact-1', determinism: 'deterministic', diagnostics: [] },
      data: new Uint8Array([1, 2, 3]),
      hasBlockingErrors: false,
    });

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'Metadata JSON', requiresRender: false, outputExtension: 'json', outputMimeType: 'application/json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map([['fmt-json', {}]]));
    });

    expect(exportMocks.executeCompileOnlyOutput).toHaveBeenCalledTimes(1);
    const callArgs = exportMocks.executeCompileOnlyOutput.mock.calls[0];
    expect(callArgs[1].formatId).toBe('fmt-json');
    expect(callArgs[1].extensionId).toBe('ext-a');
    expect(callArgs[1].timeline).toBeDefined();
    expect(callArgs[1].assets).toBeDefined();
    expect(result.current.exportStatus).toBe('done');
    expect(result.current.exportResultUrl).toBeTruthy();
    expect(result.current.exportResultFilename).toBe('export.json');
  });

  it('sets exportStatus to done and produces a downloadable blob on success', async () => {
    exportMocks.executeCompileOnlyOutput.mockResolvedValue({
      artifact: { id: 'artifact-1', determinism: 'deterministic', diagnostics: [] },
      data: new Uint8Array([7, 8, 9]),
      hasBlockingErrors: false,
    });

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-csv', extensionId: 'ext-a', label: 'CSV', requiresRender: false, outputExtension: 'csv', outputMimeType: 'text/csv', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-csv', new Map([['fmt-csv', {}]]));
    });

    expect(result.current.exportStatus).toBe('done');
    expect(result.current.exportResultFilename).toBe('export.csv');
    expect(result.current.exportResultUrl).toMatch(/^blob:/);
    expect(result.current.exportLog).toContain('Export complete');
  });

  it('sets exportStatus to error when compile-only registry is empty', async () => {
    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map()); // empty Map = no handlers registered
    });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toContain('no compile-only output handlers registered');
    expect(exportMocks.executeCompileOnlyOutput).not.toHaveBeenCalled();
  });

  it('sets exportStatus to error when resolvedConfig is null', async () => {
    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      null, // no config
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map());
    });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toContain('no timeline configuration');
    expect(exportMocks.executeCompileOnlyOutput).not.toHaveBeenCalled();
  });

  // ---- startExport — render-dependent rejection ----------------------------

  it('rejects render-dependent format from the planner route result and does not invoke executeCompileOnlyOutput', async () => {
    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-mp4', extensionId: 'ext-b', label: 'MP4 Video', requiresRender: true, outputExtension: 'mp4', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-mp4', new Map());
    });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toContain('not available on browser-export');
    expect(result.current.exportLog).toContain('MP4 Video');
    expect(exportMocks.executeCompileOnlyOutput).not.toHaveBeenCalled();
  });

  it('rejects disabled output formats from planner diagnostics when disabledReason is provided', async () => {
    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-future', extensionId: 'ext-b', label: 'Future Format', requiresRender: true, outputExtension: 'fut', disabled: true, disabledReason: 'Needs real-time encoder integration' },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-future', new Map());
    });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toContain('Needs real-time encoder integration');
    expect(exportMocks.executeCompileOnlyOutput).not.toHaveBeenCalled();
  });

  it('rejects unknown format ID with planner missing-contribution error', async () => {
    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('non-existent-format', new Map());
    });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toContain('not registered');
    expect(exportMocks.executeCompileOnlyOutput).not.toHaveBeenCalled();
  });

  // ---- startExport — exceptions from output registry -----------------------

  it('sets exportStatus to error when executeCompileOnlyOutput returns null', async () => {
    exportMocks.executeCompileOnlyOutput.mockResolvedValue(null);

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map([['fmt-json', {}]]));
    });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toContain('not available in the compile-only registry');
  });

  it('sets exportStatus to error when executeCompileOnlyOutput throws', async () => {
    exportMocks.executeCompileOnlyOutput.mockRejectedValue(new Error('Handler crashed'));

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map([['fmt-json', {}]]));
    });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toContain('Handler crashed');
  });

  // ---- startExport — export state transitions ------------------------------

  it('transitions through exporting → done during compile-only export', async () => {
    exportMocks.executeCompileOnlyOutput.mockResolvedValue({
      artifact: { id: 'artifact-1', determinism: 'deterministic', diagnostics: [] },
      data: new Uint8Array([1, 2, 3]),
      hasBlockingErrors: false,
    });

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map([['fmt-json', {}]]));
    });

    // After export completes, status should be 'done'
    expect(result.current.exportStatus).toBe('done');
    expect(result.current.exportLog).toContain('Export complete');
    expect(result.current.exportResultUrl).toMatch(/^blob:/);
    expect(result.current.exportResultFilename).toBe('export.json');
  });

  it('transitions through exporting → error on handler exception', async () => {
    exportMocks.executeCompileOnlyOutput.mockRejectedValue(new Error('Boom'));

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map([['fmt-json', {}]]));
    });

    expect(result.current.exportStatus).toBe('error');
    expect(result.current.exportLog).toContain('Export failed');
    expect(result.current.exportLog).toContain('Boom');
  });

  // ---- startExport — diagnostics in result ---------------------------------

  it('includes diagnostic count in export log when result has diagnostics', async () => {
    exportMocks.executeCompileOnlyOutput.mockResolvedValue({
      artifact: {
        id: 'artifact-1',
        determinism: 'deterministic',
        diagnostics: [
          { severity: 'warning', code: 'fmt/warning', message: 'Some warning' },
          { severity: 'info', code: 'fmt/info', message: 'Some info' },
        ],
      },
      data: new Uint8Array([1]),
      hasBlockingErrors: false,
    });

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map([['fmt-json', {}]]));
    });

    expect(result.current.exportStatus).toBe('done');
    expect(result.current.exportLog).toContain('[2 diagnostic(s)]');
  });

  it('includes blocking errors note in export log when hasBlockingErrors is true', async () => {
    exportMocks.executeCompileOnlyOutput.mockResolvedValue({
      artifact: {
        id: 'artifact-1',
        determinism: 'deterministic',
        diagnostics: [
          { severity: 'error', code: 'fmt/error', message: 'Blocking error' },
        ],
      },
      data: new Uint8Array([1]),
      hasBlockingErrors: true,
    });

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startExport('fmt-json', new Map([['fmt-json', {}]]));
    });

    expect(result.current.exportStatus).toBe('done');
    expect(result.current.exportLog).toContain('with blocking errors');
  });

  // ---- Render behavior unchanged when export formats are present -----------

  it('preserves existing render routing when compile-only export formats are registered', async () => {
    const extRuntime = makeExtensionRuntime({
      extensions: [
        {
          manifest: {
            id: 'test-ext' as any,
            version: '1.0.0',
            contributions: [],
          },
        } as any,
      ],
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    // Render still invokes guard and routes normally
    expect(guardMocks.scanExportConfig).toHaveBeenCalledTimes(1);
    expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    expect(result.current.renderStatus).toBe('idle');
  });

  it('preserves existing exporter-based render routing when compile-only formats are registered', async () => {
    const exporter = {
      render: vi.fn(async () => ({
        id: 'job-1',
        subscribe(listener: (progress: { phase: string; progress?: number; resultUrl?: string | null; log?: string }) => void) {
          listener({
            phase: 'complete',
            progress: 1,
            resultUrl: 'blob:https://example.com/rendered',
            log: 'done',
          });
          return () => undefined;
        },
      })),
    };

    const extRuntime = makeExtensionRuntime({
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      { fps: 30, durationInFrames: 30, compositionWidth: 1920, compositionHeight: 1080 },
      exporter,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    expect(exporter.render).toHaveBeenCalledTimes(1);
    expect(mocks.startClientRender).not.toHaveBeenCalled();
    expect(result.current.renderStatus).toBe('done');
    expect(result.current.renderResultUrl).toBe('blob:https://example.com/rendered');
  });

  it('preserves render block when export guard finds blocking errors even with compile-only formats present', async () => {
    const extRuntime = makeExtensionRuntime({
      extensions: [
        {
          manifest: {
            id: 'test-ext' as any,
            version: '1.0.0',
            contributions: [],
          },
        } as any,
      ],
      config: {
        slots: {},
        dialogHost: { dialogs: [] },
        registry: { panels: [], inspectorSections: [] },
        outputFormats: [
          { id: 'fmt-json', extensionId: 'ext-a', label: 'JSON', requiresRender: false, outputExtension: 'json', disabled: false },
        ],
      } as any,
    });

    guardMocks.scanExportConfig.mockReturnValue({
      diagnostics: [
        {
          severity: 'error',
          code: 'export/unknown-clip-type',
          message: 'Clip type alien-format is not recognised.',
          detail: { clipId: 'c1', clipType: 'alien-format' },
        },
      ],
      unknownClipTypes: ['alien-format'],
      unknownEffects: [],
      unknownTransitions: [],
      inactiveExtensionIds: { effectIds: new Set(), transitionIds: new Set(), clipTypeIds: new Set() },
      hasBlockingErrors: true,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({ id: 'c1', clipType: 'media', track: 'V1', at: 0, hold: 1 }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    // Render was blocked by guard despite having export formats
    expect(result.current.renderStatus).toBe('error');
    expect(result.current.renderLog).toContain('Export guard');
    expect(result.current.renderLog).toContain('alien-format');
    expect(mocks.startClientRender).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Export guard — clip-type registry snapshot integration
// ---------------------------------------------------------------------------

describe('useRenderState export guard — clip-type registry snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startClientRender.mockResolvedValue(undefined);
    guardMocks.collectBuiltInKnownIds.mockReturnValue({
      clipTypes: new Set(['media', 'text', 'hold', 'effect-layer']),
      effectTypes: new Set(),
      transitionTypes: new Set(),
    });
    guardMocks.collectExtensionDeclaredIds.mockReturnValue({
      effectIds: new Set(),
      transitionIds: new Set(),
      clipTypeIds: new Set(),
    });
  });

  it('passes clipTypeRegistrySnapshot to scanExportConfig when guard runs', async () => {
    const extRuntime = makeExtensionRuntime({
      extensions: [
        {
          manifest: {
            id: 'test-ext' as any,
            version: '1.0.0',
            contributions: [],
          },
        } as any,
      ],
    });

    guardMocks.scanExportConfig.mockReturnValue({
      ...cleanGuardResult(),
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'c1',
        clipType: 'media',
        track: 'V1',
        at: 0,
        hold: 1,
      }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    expect(guardMocks.scanExportConfig).toHaveBeenCalledTimes(1);
    const callArgs = guardMocks.scanExportConfig.mock.calls[0];
    expect(callArgs).toHaveLength(9);
    expect(callArgs[5]).toBeDefined();
    expect(callArgs[7]).toBeUndefined();
  });

  it('passes provider-held process attach evidence into export and router planning call sites', async () => {
    const extRuntime = makeExtensionRuntime({
      extensions: [
        {
          manifest: {
            id: 'test-ext' as any,
            version: '1.0.0',
            contributions: [],
          },
        } as any,
      ],
      processes: [
        {
          id: 'proc.descriptor',
          extensionId: 'ext.process',
          processId: 'dataset-process',
          label: 'Dataset Process',
          protocol: 'stdio-jsonrpc',
          availableRoutes: ['browser-export'],
          operations: [],
          requiredBy: [],
          blockers: [],
          nextActions: [],
          capabilities: { defaultRoute: 'browser-export', determinism: 'process-dependent', capabilityRequirements: [] },
          spec: { id: 'dataset-process', label: 'Dataset Process' },
        },
      ] as any,
    });
    const attachRecord = makeProcessAttachRecord();
    const runtimeValue = {
      processStatuses: [{ processId: 'dataset-process', state: 'ready' }],
      processResultAttachRecords: [attachRecord],
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>
        {children}
      </VideoEditorRuntimeContext.Provider>
    );

    guardMocks.scanExportConfig.mockReturnValue({
      ...cleanGuardResult(),
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'c1',
        clipType: 'generated-module',
        track: 'V1',
        at: 0,
        hold: 1,
      }),
      null,
      null,
      extRuntime,
    ), { wrapper });

    await act(async () => {
      await result.current.startRender();
    });

    expect(guardMocks.scanExportConfig).toHaveBeenCalledTimes(1);
    expect(guardMocks.scanExportConfig.mock.calls[0]?.[7]).toEqual([attachRecord]);

    expect(renderRouterMocks.decideRenderRoute).toHaveBeenCalledTimes(1);
    expect(renderRouterMocks.decideRenderRoute.mock.calls[0]?.[2]).toMatchObject({
      // The normalized runtime graph is edge-less because no timeline has
      // been projected into it; it must not masquerade as timeline authority.
      compositionGraph: undefined,
      processes: extRuntime.processes,
      processStatuses: runtimeValue.processStatuses,
      processResultAttachRecords: [attachRecord],
    });
  });

  it('includes clipType details in render log for blocking clip-type errors', async () => {
    const extRuntime = makeExtensionRuntime({
      extensions: [
        {
          manifest: {
            id: 'test-ext' as any,
            version: '1.0.0',
            contributions: [],
          },
        } as any,
      ],
    });

    guardMocks.scanExportConfig.mockReturnValue({
      ...cleanGuardResult(),
      diagnostics: [
        {
          severity: 'error',
          code: 'export/unrenderable-clip-type',
          message: 'Clip type "stale-clip-type" is registered but inactive and cannot be used for export or preview.',
          extensionId: 'ext.stale',
          contributionId: 'test:clipType:stale-clip-type',
          detail: {
            clipId: 'c1',
            clipType: 'stale-clip-type',
            clipTypeStatus: 'inactive',
            provenance: 'bundled-extension',
          },
        },
      ],
      hasBlockingErrors: true,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'c1',
        clipType: 'media',
        track: 'V1',
        at: 0,
        hold: 1,
      }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    expect(result.current.renderStatus).toBe('error');
    expect(result.current.renderLog).toContain('Export guard');
    expect(result.current.renderLog).toContain('stale-clip-type');
    expect(result.current.renderLog).toContain('export/unrenderable-clip-type');
    expect(result.current.renderLog).toContain('inactive');
    expect(mocks.startClientRender).not.toHaveBeenCalled();
  });

  it('includes clipType details in render log for warning diagnostics', async () => {
    const extRuntime = makeExtensionRuntime({
      extensions: [
        {
          manifest: {
            id: 'test-ext' as any,
            version: '1.0.0',
            contributions: [],
          },
        } as any,
      ],
    });

    guardMocks.scanExportConfig.mockReturnValue({
      ...cleanGuardResult(),
      diagnostics: [
        {
          severity: 'warning',
          code: 'export/unknown-clip-type',
          message: 'Clip type "future-clip" is declared by an inactive extension and may not be available at export time.',
          detail: { clipId: 'c1', clipType: 'future-clip' },
        },
      ],
      hasBlockingErrors: false,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'c1',
        clipType: 'media',
        track: 'V1',
        at: 0,
        hold: 1,
      }),
      null,
      null,
      extRuntime,
    ));

    await act(async () => {
      await result.current.startRender();
    });

    // Warning only — native routing preserved
    expect(mocks.startClientRender).toHaveBeenCalledTimes(1);
    expect(result.current.renderLog).toContain('Export guard');
    expect(result.current.renderLog).toContain('future-clip');
    expect(result.current.renderLog).toContain('warning');
  });

  it('publishes clip-type diagnostics to the provider collection', async () => {
    const extRuntime = makeExtensionRuntime({
      extensions: [
        {
          manifest: {
            id: 'test-ext' as any,
            version: '1.0.0',
            contributions: [],
          },
        } as any,
      ],
    });
    const collection = createDiagnosticCollection();
    const runtimeValue = {
      diagnosticCollection: collection,
    } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VideoEditorRuntimeContext.Provider value={runtimeValue}>
        {children}
      </VideoEditorRuntimeContext.Provider>
    );

    guardMocks.scanExportConfig.mockReturnValue({
      ...cleanGuardResult(),
      diagnostics: [
        {
          severity: 'error',
          code: 'export/unrenderable-clip-type',
          message: 'Clip type "stale-clip-type" is registered but inactive.',
          extensionId: 'ext.stale',
          contributionId: 'test:clipType:stale-clip-type',
          detail: { clipId: 'c1', clipType: 'stale-clip-type', clipTypeStatus: 'inactive' },
        },
      ],
      blockers: [
        {
          id: 'export.clipType.c1.stale-clip-type.inactive.browser-export',
          severity: 'error',
          route: 'browser-export',
          reason: 'inactive-extension',
          message: 'Clip type "stale-clip-type" on route "browser-export" is registered but inactive.',
          clipId: 'c1',
          detail: { clipType: 'stale-clip-type' },
        },
      ],
      hasBlockingErrors: true,
    });

    const { result } = renderHook(() => useRenderState(
      buildConfig({
        id: 'c1',
        clipType: 'media',
        track: 'V1',
        at: 0,
        hold: 1,
      }),
      null,
      null,
      extRuntime,
    ), { wrapper });

    await act(async () => {
      await result.current.startRender();
    });

    const diagnostics = collection.getSnapshot();
    expect(diagnostics.some((diagnostic) => diagnostic.detail?.source === 'export-guard')).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.detail?.source === 'render-planner')).toBe(true);
  });
});
});
