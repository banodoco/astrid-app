import type { AstridElementHost } from '@/tools/video-editor/runtime/astrid-element-host.ts';
import { extensionSettingsGroup } from '@/tools/video-editor/runtime/extensionSettingsBacking';
import { getSettingsStore } from '@/shared/settings/instance';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import type { FC, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineExtension } from '@astrid/editor-sdk';
import type { Diagnostic, ExtensionContext, ExtensionContribution, ExtensionSettingsService } from '@astrid/editor-sdk';
import type { DataProvider, ExtensionPersistenceService } from '@/tools/video-editor/data/DataProvider.ts';
import type { TimelineHostServiceHooks } from '@/tools/video-editor/runtime/timelineHostServiceHooks.ts';
import type { EffectRegistryRecord } from '@/tools/video-editor/effects/registry/types.ts';
import { useEffectRegistryContext } from '@/tools/video-editor/effects/registry/EffectRegistryContext.tsx';
import { useTransitionRegistryContext } from '@/tools/video-editor/transitions/registry/index.ts';
import type { TransitionRegistryRecord } from '@/tools/video-editor/transitions/registry/types.ts';
import { useShaderEffectRegistryContext } from '@/tools/video-editor/shaders/registry/index.ts';
import type { ShaderEffectRegistryRecord } from '@/tools/video-editor/shaders/registry/types.ts';
import { useClipTypeRegistryContext } from '@/tools/video-editor/clip-types/ClipTypeRegistryContext.tsx';
import type { ClipTypeRegistryRecord } from '@/tools/video-editor/clip-types/ClipTypeRegistry.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { EditorRuntimeProvider } from '@/tools/video-editor/contexts/EditorRuntimeProvider.tsx';
import { useEditorRuntimeAssembly } from '@/tools/video-editor/contexts/editorRuntimeAssembly';
import type { LiveDataRegistry } from '@/tools/video-editor/runtime/liveDataRegistry.ts';
import type { LivePermissionService } from '@/tools/video-editor/runtime/livePermissions.ts';
import type {
  ExtensionSettingsSnapshot,
  ExtensionStateRepository,
} from '@/tools/video-editor/runtime/extensionStateRepository.ts';
import { ExtensionSettingsPanel } from '@/tools/video-editor/components/ExtensionSettings/ExtensionSettingsPanel';
import {
  createProposalRuntime,
  createProposalPersistenceBridge,
  type ProposalPersistenceProvider,
} from '@/tools/video-editor/lib/proposal-runtime';
import { useTimelineState } from '@/tools/video-editor/hooks/useTimelineState';
import { PUBLIC_ASTRID_READ_ONLY_EDITABILITY } from '@/pages/Home/PublicAstridEditorProvider.tsx';
import { PUBLIC_ASTRID_ELEMENT_HOST } from '@/pages/Home/astrid-public-host.tsx';
import type { ProcessManager } from '@/tools/video-editor/runtime/processes/ProcessManager.ts';
import { useDataKindRegistryContext } from '@/tools/video-editor/data-kinds/DataKindRegistryContext';

/** What an extension's setting holds in the settings store, as JSON text (null when nothing is saved). */
function savedExtensionSetting(extensionId: string, key: string): string | null {
  const value = getSettingsStore().get({ group: extensionSettingsGroup(extensionId), field: key, default: undefined, validate: () => true });
  return value === undefined ? null : JSON.stringify(value);
}


const fixtureAstridElementHost: AstridElementHost = {
  descriptors: [],
  sequenceRegistry: {},
  resolveComponent: () => undefined,
  resolveSequenceClipEntry: () => undefined,
  describeClipCapability: () => undefined,
};

const mocks = vi.hoisted(() => {
  const syncSlices = vi.fn();
  const setMounted = vi.fn();
  const timelineData = {
    clips: [],
    tracks: [],
    registry: {},
    config: {},
  };
  return {
    syncSlices,
    setMounted,
    timelineData,
    useEffectRegistry: vi.fn(),
    emptyEffectCatalog: {
      data: { entrance: [], exit: [], continuous: [] },
      effects: [],
      entrance: [],
      exit: [],
      continuous: [],
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(async () => undefined),
      canCreateEffect: false,
      canUpdateEffect: false,
      canDeleteEffect: false,
    },
    emptySequenceCatalog: {
      components: [],
      byClipType: {},
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(async () => undefined),
      canCreateComponent: false,
      canUpdateComponent: false,
      canDeleteComponent: false,
    },
    timelineStore: {
      getState: () => ({
        data: { data: timelineData },
        timelineOps: null,
        syncSlices,
        setMounted,
      }),
    },
    // Non-store members of UseTimelineStateResult that useEditorRuntimeSync
    // reads (editorOps is required; transcriptHost inside it is optional).
    timelineStateRest: {
      editor: {},
      chrome: {},
      editorOps: {},
    },
  };
});

vi.mock('@/tools/video-editor/hooks/useEffects.ts', () => ({
  useEffects: () => ({ data: [] }),
}));

vi.mock('@/tools/video-editor/hooks/useEffectRegistry.ts', () => ({
  useEffectRegistry: (...args: unknown[]) => mocks.useEffectRegistry(...args),
}));

vi.mock('@/tools/video-editor/hooks/useEffectResources.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/video-editor/hooks/useEffectResources.ts')>();
  return {
    ...actual,
    useResolvedEffectCatalog: () => mocks.emptyEffectCatalog,
  };
});

vi.mock('@/tools/video-editor/hooks/useSequenceResources.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/video-editor/hooks/useSequenceResources.ts')>();
  return {
    ...actual,
    useResolvedSequenceComponentCatalog: () => mocks.emptySequenceCatalog,
  };
});

vi.mock('@/tools/video-editor/hooks/useTimelineState.ts', () => ({
  useTimelineState: vi.fn(() => ({ store: mocks.timelineStore, ...mocks.timelineStateRest })),
}));

vi.mock('@/tools/video-editor/lib/proposal-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/video-editor/lib/proposal-runtime')>();
  return {
    ...actual,
    createProposalRuntime: vi.fn((...args: Parameters<typeof actual.createProposalRuntime>) =>
      actual.createProposalRuntime(...args),
    ),
    createProposalPersistenceBridge: vi.fn((...args: Parameters<typeof actual.createProposalPersistenceBridge>) =>
      actual.createProposalPersistenceBridge(...args),
    ),
  };
});

const Component: FC<{ children: ReactNode }> = ({ children }) => children;
const ReplacementComponent: FC<{ children: ReactNode }> = ({ children }) => children;
const SHADER_SOURCE = Object.freeze({
  kind: 'inline' as const,
  fragment: 'void main() { gl_FragColor = vec4(1.0); }',
});

interface TrustedLocalEffectPack {
  readonly extensionId: string;
  readonly records: readonly EffectRegistryRecord[];
}

function effectRecord(
  effectId: string,
  ownerExtensionId: string,
  dispose: () => void,
): EffectRegistryRecord {
  return {
    effectId,
    contributionId: `${ownerExtensionId}.effect`,
    component: Component,
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

function shaderRecord(
  shaderId: string,
  ownerExtensionId: string,
  diagnostics: readonly Diagnostic[],
  dispose: () => void,
): ShaderEffectRegistryRecord {
  return {
    shaderId,
    contributionId: `${ownerExtensionId}.shader`,
    label: shaderId,
    source: SHADER_SOURCE,
    pass: 'postprocess',
    provenance: 'trusted-loader',
    ownerExtensionId,
    status: 'error',
    diagnostics,
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

function transitionRecord(
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

function clipTypeRecord(
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

function TrustedLocalEffectPackLoader({ packs }: { packs: readonly TrustedLocalEffectPack[] }) {
  const { registry } = useEffectRegistryContext();

  useEffect(() => {
    const handles = packs.flatMap((pack) =>
      pack.records.map((record) =>
        registry.register({
          ...record,
          ownerExtensionId: pack.extensionId,
          provenance: 'trusted-loader',
        }),
      ),
    );

    return () => {
      for (const handle of handles) {
        handle.dispose();
      }
    };
  }, [packs, registry]);

  return null;
}

interface RuntimeSettingsWrite {
  readonly snapshot: ExtensionSettingsSnapshot;
  resolve(): void;
  reject(error: unknown): void;
}

function makeDeferredRuntimeSettingsRepository() {
  const writes: RuntimeSettingsWrite[] = [];
  const snapshots = new Map<string, ExtensionSettingsSnapshot>();

  const repository = {
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    isDisposed: false,
    putSettingsSnapshot: vi.fn((snapshot: ExtensionSettingsSnapshot) => new Promise<void>((resolve, reject) => {
      writes.push({
        snapshot,
        resolve() {
          snapshots.set(snapshot.extensionId, snapshot);
          resolve();
        },
        reject,
      });
    })),
    getSettingsSnapshot: vi.fn(async (extensionId: string) => snapshots.get(extensionId) ?? null),
    getAllSettingsSnapshots: vi.fn(async () => Array.from(snapshots.values())),
    deleteSettingsSnapshot: vi.fn(async (extensionId: string) => {
      snapshots.delete(extensionId);
    }),
  } as Partial<ExtensionStateRepository> as ExtensionStateRepository;

  return { repository, writes };
}

function cleanupRuntimeSettingsLocalStorage(extensionId: string): void {
  const prefix = `astrid.ext.${extensionId}.`;
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
}

describe('EditorRuntimeProvider timeline services', () => {
  it('forwards its host-owned services into the shared timeline state hook', () => {
    const timelineServices = {
      useAssetManagement: vi.fn(),
      useFinalVideoMap: vi.fn(),
    } as unknown as TimelineHostServiceHooks;
    vi.mocked(useTimelineState).mockClear();

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-services"
        timelineServices={timelineServices}
      >
        <div>Timeline services test</div>
      </EditorRuntimeProvider>,
    );

    expect(useTimelineState).toHaveBeenCalledWith(timelineServices, undefined);
  });
});

describe('EditorRuntimeProvider effect registry lifecycle', () => {
  it('activates and cleans up shader registrations without changing effect or transition registration', async () => {
    const extensionId = 'com.example.shader-runtime';
    const effectId = 'shader-runtime-effect';
    const transitionId = 'shader-runtime-transition';
    const shaderId = 'shader.runtime.grade';
    let latestEffectRecords: readonly EffectRegistryRecord[] = [];
    let latestTransitionRecords: readonly TransitionRegistryRecord[] = [];
    let latestShaderRecords: readonly ShaderEffectRegistryRecord[] = [];

    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Shader runtime extension',
        contributions: [
          {
            id: 'shader-runtime.effect' as never,
            kind: 'effect',
            effectId,
            label: 'Runtime Effect',
          },
          {
            id: 'shader-runtime.transition' as never,
            kind: 'transition',
            transitionId,
            label: 'Runtime Transition',
          },
          {
            id: 'shader-runtime.shader' as never,
            kind: 'shader',
            shaderId,
            label: 'Runtime Shader',
            pass: 'postprocess',
            source: SHADER_SOURCE,
          },
        ],
      },
      activate(ctx) {
        const effectHandle = ctx.effects.registerComponent(effectId, Component);
        const transitionHandle = ctx.transitions.registerRenderer(transitionId, () => null);
        const shaderHandle = ctx.shaders.registerShader(shaderId, SHADER_SOURCE);

        return {
          dispose() {
            shaderHandle.dispose();
            transitionHandle.dispose();
            effectHandle.dispose();
          },
        };
      },
    });

    function CaptureRegistries() {
      latestEffectRecords = useEffectRegistryContext().snapshot.records;
      latestTransitionRecords = useTransitionRegistryContext().snapshot.records;
      latestShaderRecords = useShaderEffectRegistryContext().snapshot.records;
      return null;
    }

    function Host({ enabled }: { enabled: boolean }) {
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={{} as DataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={enabled ? [extension] : []}
        >
          <CaptureRegistries />
        </EditorRuntimeProvider>
      );
    }

    const { rerender } = render(<Host enabled />);

    await waitFor(() => {
      expect(latestEffectRecords.map((record) => record.effectId)).toContain(effectId);
      expect(latestTransitionRecords.map((record) => record.transitionId)).toContain(transitionId);
      expect(latestShaderRecords.map((record) => record.shaderId)).toContain(shaderId);
    });

    expect(latestEffectRecords.map((record) => record.effectId)).not.toContain(shaderId);
    expect(latestShaderRecords[0]).toMatchObject({
      shaderId,
      ownerExtensionId: extensionId,
      contributionId: 'shader-runtime.shader',
      provenance: 'bundled-extension',
      status: 'active',
    });
    expect(latestShaderRecords[0].renderability.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: 'preview', status: 'supported' }),
        expect.objectContaining({ route: 'browser-export', status: 'blocked' }),
        expect.objectContaining({ route: 'worker-export', status: 'blocked' }),
      ]),
    );

    rerender(<Host enabled={false} />);

    await waitFor(() => {
      expect(latestEffectRecords.map((record) => record.effectId)).not.toContain(effectId);
      expect(latestTransitionRecords.map((record) => record.transitionId)).not.toContain(transitionId);
      expect(latestShaderRecords.map((record) => record.shaderId)).not.toContain(shaderId);
    });
  });

  it('preserves working registrations on failed replacement and commits declarations before new handlers', async () => {
    const id = 'com.test.live-replacement';
    const command = `${id}.ping`;
    const first = vi.fn();
    const second = vi.fn();
    let runtime!: ReturnType<typeof useVideoEditorRuntime>;
    let registry!: ReturnType<typeof useEffectRegistryContext>['registry'];
    function Capture() { runtime = useVideoEditorRuntime(); registry = useEffectRegistryContext().registry; return null; }
    const First = () => null;
    const Second = () => null;
    const extension = (component: typeof First, handler: typeof first, fail = false) => defineExtension({
      manifest: { id: id as never, version: '1.0.0', label: 'Live replacement', contributions: [
        { id: 'effect' as never, kind: 'effect', effectId: 'live-replacement' },
        { id: 'ping' as never, kind: 'command', command, label: 'Ping' },
      ] },
      activate(ctx) {
        ctx.effects.registerComponent('live-replacement', component);
        ctx.commands.registerCommand(command, handler);
        if (fail) throw new Error('candidate activation failed');
      },
    });
    const dataProvider = {} as DataProvider;
    const tree = (extensions: AstridExtension[]) => <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
      dataProvider={dataProvider} timelineId="replacement" extensions={extensions}><Capture /></EditorRuntimeProvider>;
    const view = render(tree([extension(First, first)]));
    await waitFor(() => expect(registry.resolve('live-replacement')?.component).toBe(First));
    expect(await runtime.commandRegistry!.executeCommand(command)).toBe(true);
    view.rerender(tree([extension(Second, second, true)]));
    await act(async () => {});
    expect(registry.resolve('live-replacement')?.component).toBe(First);
    expect(await runtime.commandRegistry!.executeCommand(command)).toBe(true);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
    view.rerender(tree([extension(Second, second)]));
    await waitFor(() => expect(registry.resolve('live-replacement')?.component).toBe(Second));
    expect(await runtime.commandRegistry!.executeCommand(command)).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    view.rerender(tree([]));
    await waitFor(() => expect(registry.resolve('live-replacement')).toBeUndefined());
    expect(await runtime.commandRegistry!.executeCommand(command)).toBe(false);
  });

  it('cleans extension-owned effect records and command contributions on removal after HMR replacement', async () => {
    const extensionId = 'com.example.lifecycle';
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
        label: 'Lifecycle extension',
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

    function CaptureLifecycle() {
      const { registry, snapshot } = useEffectRegistryContext();
      const runtime = useVideoEditorRuntime();

      latestEffectIds = snapshot.records.map((record) => record.effectId);
      latestCommandIds = runtime.commandRegistry?.getSnapshot().commands.map((command) => command.commandId) ?? [];

      useEffect(() => {
        const originalHandle = registry.register(
          effectRecord('trusted-fx', extensionId, disposeOriginal),
        );
        hmrHandle = registry.updateRecord('trusted-fx', (current) => ({
          ...current,
          contributionId: `${extensionId}.effect.hmr`,
          component: ReplacementComponent,
        }), disposeReplacement);

        return () => {
          originalHandle.dispose();
          hmrHandle?.dispose();
        };
      }, [registry]);

      return null;
    }

    const props = {
      dataProvider: {} as DataProvider,
      timelineId: 'timeline-1',
      userId: 'user-1',
      extensions: [extension],
    };

    const { rerender } = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props}>
        <CaptureLifecycle />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(latestEffectIds).toContain('trusted-fx');
      expect(latestCommandIds).toContain(commandId);
    });
    expect(disposeOriginal).toHaveBeenCalledTimes(1);
    expect(disposeReplacement).not.toHaveBeenCalled();

    rerender(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props} extensions={[]}>
        <CaptureLifecycle />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(latestEffectIds).not.toContain('trusted-fx');
      expect(latestCommandIds).not.toContain(commandId);
    });
    expect(disposeOriginal).toHaveBeenCalledTimes(1);
    expect(disposeReplacement).toHaveBeenCalledTimes(1);

    hmrHandle?.dispose();
    hmrHandle?.dispose();
    expect(disposeReplacement).toHaveBeenCalledTimes(1);
  });

  it('enables and disables trusted local effect packs without public component contribution support', async () => {
    const extensionId = 'local.trusted.pack';
    const effectId = 'trusted-local-wipe';
    const disposeEffect = vi.fn();
    let latestEffectRecords: readonly EffectRegistryRecord[] = [];

    const effectContribution: ExtensionContribution = {
      id: 'trusted-local-wipe.contribution' as never,
      kind: 'effect',
      effectId,
      label: 'Trusted local wipe',
    };
    expect(effectContribution).not.toHaveProperty('component');

    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Trusted local pack',
        contributions: [effectContribution],
      },
    });

    const localPack: TrustedLocalEffectPack = {
      extensionId,
      records: [
        {
          ...effectRecord(effectId, extensionId, disposeEffect),
          contributionId: effectContribution.id,
        },
      ],
    };
    const enabledPacks = [localPack];
    const disabledPacks: readonly TrustedLocalEffectPack[] = [];

    function CaptureEffects() {
      const { snapshot } = useEffectRegistryContext();
      latestEffectRecords = snapshot.records;
      return null;
    }

    function Host({ enabled }: { enabled: boolean }) {
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={{} as DataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={enabled ? [extension] : []}
        >
          <TrustedLocalEffectPackLoader packs={enabled ? enabledPacks : disabledPacks} />
          <CaptureEffects />
        </EditorRuntimeProvider>
      );
    }

    const { rerender } = render(<Host enabled />);

    await waitFor(() => {
      expect(latestEffectRecords.map((record) => record.effectId)).toContain(effectId);
    });
    const loadedRecord = latestEffectRecords.find((record) => record.effectId === effectId);
    expect(loadedRecord?.ownerExtensionId).toBe(extensionId);
    expect(loadedRecord?.provenance).toBe('trusted-loader');
    expect(loadedRecord?.component).toBe(Component);
    expect(disposeEffect).not.toHaveBeenCalled();

    rerender(<Host enabled={false} />);

    await waitFor(() => {
      expect(latestEffectRecords.map((record) => record.effectId)).not.toContain(effectId);
    });
    expect(disposeEffect).toHaveBeenCalledTimes(1);
  });

  it('feeds provider diagnostic collection from lifecycle, command, and registry sources', async () => {
    const extensionId = 'com.example.diagnostics';
    const shaderId = 'diagnostics.shader';
    let collection = null as ReturnType<typeof useVideoEditorRuntime>['diagnosticCollection'] | null;

    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Diagnostics extension',
        contributions: [
          {
            id: 'diagnostics.effect' as never,
            kind: 'effect',
            effectId: 'diagnostics-effect',
            label: 'Diagnostics effect',
          },
          {
            id: 'diagnostics.command' as never,
            kind: 'command',
            command: 'astrid.reserved',
            label: 'Reserved command',
          },
        ],
      },
      activate() {
        throw new Error('activation failed for diagnostics test');
      },
    });

    function CaptureDiagnostics({ enabled }: { enabled: boolean }) {
      const runtime = useVideoEditorRuntime();
      const { registry } = useEffectRegistryContext();
      const { registry: shaderRegistry } = useShaderEffectRegistryContext();
      collection = runtime.diagnosticCollection ?? null;

      useEffect(() => {
        if (!enabled || !runtime.diagnosticCollection) return undefined;
        // Host-owned diagnostic (no extensionId) — should survive
        // extension disable/unload without being removed.
        runtime.diagnosticCollection.publish({
          id: 'host-owned-diagnostic',
          severity: 'warning',
          code: 'host/timeline-stale',
          message: 'Host-owned stale warning',
          detail: { source: 'host-owned' },
        });
        runtime.diagnosticCollection.publish({
          id: 'export-stale-diagnostic',
          severity: 'error',
          code: 'export/unrenderable-effect',
          message: 'Stale export blocker',
          extensionId,
          contributionId: 'diagnostics.effect',
          detail: { source: 'export-guard' },
        });
        runtime.diagnosticCollection.publish({
          id: 'planner-stale-diagnostic',
          severity: 'error',
          code: 'planner/browser-export/route-unsupported',
          message: 'Stale planner blocker',
          extensionId,
          contributionId: 'diagnostics.effect',
          detail: { source: 'render-planner' },
        });
        const first = registry.register(effectRecord('diagnostics-duplicate', extensionId, vi.fn()));
        const second = registry.register(effectRecord('diagnostics-duplicate', extensionId, vi.fn()));
        const shader = shaderRegistry.register(shaderRecord(
          shaderId,
          extensionId,
          [{
            id: 'diagnostics-shader-compile-error',
            severity: 'error',
            code: 'shader/compile-error',
            message: 'Shader compile failed',
            sourceRange: {
              startLine: 4,
              startCol: 9,
              endLine: 4,
              endCol: 17,
            },
            detail: { source: 'fragment', phase: 'fragment' },
          }],
          vi.fn(),
        ));
        return () => {
          shader.dispose();
          first.dispose();
          second.dispose();
        };
      }, [enabled, registry, runtime.diagnosticCollection, shaderRegistry]);

      return null;
    }

    // This toggle changes extensions inside one authority scope. A new provider
    // object intentionally replaces that scope, so retain this fixture identity.
    const stableDataProvider = {} as DataProvider;

    function Host({ enabled }: { enabled: boolean }) {
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={stableDataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={enabled ? [extension] : []}
        >
          <CaptureDiagnostics enabled={enabled} />
        </EditorRuntimeProvider>
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
          diagnostic.detail?.source === 'shader-effect-registry'
          && diagnostic.code === 'shader/compile-error'
          && diagnostic.extensionId === extensionId
          && diagnostic.contributionId === `${extensionId}.shader`
          && diagnostic.detail?.shaderId === shaderId
          && diagnostic.detail?.diagnosticSource === 'fragment'
          && diagnostic.sourceRange?.startLine === 4
          && diagnostic.sourceRange?.startCol === 9,
      )).toBe(true);
      expect(diagnostics.some(
        (diagnostic) =>
          diagnostic.detail?.source === 'export-guard'
          && diagnostic.code === 'export/unrenderable-effect',
      )).toBe(true);
      expect(diagnostics.some(
        (diagnostic) =>
          diagnostic.detail?.source === 'render-planner'
          && diagnostic.code === 'planner/browser-export/route-unsupported',
      )).toBe(true);
      // Host-owned diagnostic must be present before disable.
      expect(diagnostics.some(
        (diagnostic) =>
          diagnostic.id === 'host-owned-diagnostic'
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
          diagnostic.id === 'host-owned-diagnostic'
          && diagnostic.detail?.source === 'host-owned',
      )).toBe(true);
    });
  });
});


describe('EditorRuntimeProvider live data registry lifecycle', () => {
  it('instantiates liveDataRegistry and livePermissionService on mount and disposes on unmount', async () => {
    let capturedRegistry: LiveDataRegistry | null = null;
    let capturedPermissionService: LivePermissionService | null = null;

    function CaptureLiveServices() {
      const runtime = useVideoEditorRuntime();
      capturedRegistry = runtime.liveDataRegistry ?? null;
      capturedPermissionService = runtime.livePermissionService ?? null;
      return null;
    }

    const props = {
      dataProvider: {} as DataProvider,
      timelineId: 'timeline-1',
      userId: 'user-1',
      extensions: [],
    };

    const { unmount } = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props}>
        <CaptureLiveServices />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(capturedRegistry).not.toBeNull();
      expect(capturedPermissionService).not.toBeNull();
    });

    // Verify registry is not disposed while mounted
    expect(capturedRegistry?.isDisposed).toBe(false);
    expect(capturedPermissionService?.isDisposed).toBe(false);

    // Unmount should dispose both
    unmount();

    await waitFor(() => {
      expect(capturedRegistry?.isDisposed).toBe(true);
      expect(capturedPermissionService?.isDisposed).toBe(true);
    });
  });

  it('exposes sessions through ctx.creative.sessions for extensions', async () => {
    let capturedSessions: unknown = null;
    const extensionId = 'com.example.live-sessions';

    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Live sessions extension',
      },
      activate(ctx) {
        capturedSessions = ctx.creative.sessions;
        return { dispose() {} };
      },
    });

    function CaptureContext() {
      return null;
    }

    const props = {
      dataProvider: {} as DataProvider,
      timelineId: 'timeline-1',
      userId: 'user-1',
      extensions: [extension],
    };

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props}>
        <CaptureContext />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(capturedSessions).not.toBeNull();
    });

    // Verify the sessions object has the expected LiveSessionsService methods
    expect(typeof (capturedSessions as any)?.registerSource).toBe('function');
    expect(typeof (capturedSessions as any)?.listSources).toBe('function');
    expect(typeof (capturedSessions as any)?.openChannel).toBe('function');
    expect(typeof (capturedSessions as any)?.pushSample).toBe('function');
    expect(typeof (capturedSessions as any)?.getDiagnostics).toBe('function');
  });

  it('disposes active live sources on provider unmount', async () => {
    let capturedRegistry: LiveDataRegistry | null = null;
    const extensionId = 'com.example.live-dispose';

    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Live dispose extension',
      },
      activate(ctx) {
        const sessions = ctx.creative.sessions;
        // Register a live source through the sessions API
        sessions.registerSource({
          id: 'test-source-1',
          kind: 'generated',
          label: 'Test Source',
        });
        return { dispose() {} };
      },
    });

    function CaptureRegistry() {
      const runtime = useVideoEditorRuntime();
      capturedRegistry = runtime.liveDataRegistry ?? null;
      return null;
    }

    const props = {
      dataProvider: {} as DataProvider,
      timelineId: 'timeline-1',
      userId: 'user-1',
      extensions: [extension],
    };

    const { unmount } = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props}>
        <CaptureRegistry />
      </EditorRuntimeProvider>,
    );

    // Wait for the source to be registered
    await waitFor(() => {
      const sources = capturedRegistry?.listSources() ?? [];
      expect(sources.length).toBe(1);
      expect(sources[0].id).toBe('test-source-1');
    });

    // Unmount the provider — should dispose the source
    unmount();

    // After unmount, the registry should be disposed and sources cleared
    await waitFor(() => expect(capturedRegistry?.isDisposed).toBe(true));
    // Tombstone should exist after disposal
    const snapshot = (capturedRegistry as any)?.getSnapshot?.();
    expect(snapshot?.tombstones?.some(
      (t: any) => t.id === 'test-source-1' && t.extensionId === extensionId,
    )).toBe(true);
  });

  it('orphan-disposes extension-owned live sources on extension removal without mutating persisted bindings', async () => {
    let capturedRegistry: LiveDataRegistry | null = null;
    const extensionId = 'com.example.live-orphan';
    const sourceId = 'test-source-orphan';
    const persistedLiveBindings = [
      {
        bindingId: 'binding-1',
        sourceId,
        targetClipId: 'clip-1',
      },
    ];
    (mocks.timelineData.config as Record<string, unknown>).liveBindings = persistedLiveBindings;
    const persistedBefore = JSON.stringify(persistedLiveBindings);

    const extension = defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: 'Live orphan extension',
      },
      activate(ctx) {
        ctx.creative.sessions.registerSource({
          id: sourceId,
          kind: 'generated',
          label: 'Orphan Source',
        });
        return { dispose() {} };
      },
    });

    function CaptureRegistry() {
      const runtime = useVideoEditorRuntime();
      capturedRegistry = runtime.liveDataRegistry ?? null;
      return null;
    }

    const props = {
      dataProvider: {} as DataProvider,
      timelineId: 'timeline-1',
      userId: 'user-1',
    };

    const { rerender } = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props} extensions={[extension]}>
        <CaptureRegistry />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(capturedRegistry?.listSources().map((source) => source.id)).toContain(sourceId);
    });

    (capturedRegistry as any)._addBinding({
      bindingId: 'binding-1',
      sourceId,
      targetClipId: 'clip-1',
      status: 'resolved',
    });

    rerender(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props} extensions={[]}>
        <CaptureRegistry />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(capturedRegistry?.listSources()).toEqual([]);
      expect(capturedRegistry?.getSnapshot().tombstones.some(
        (tombstone: any) =>
          tombstone.id === sourceId && tombstone.extensionId === extensionId,
      )).toBe(true);
    });

    expect(capturedRegistry?.resolveBinding('binding-1').status).toBe('orphaned');
    expect(capturedRegistry?.getBindingMetadata().orphanedCount).toBe(1);
    expect(JSON.stringify((mocks.timelineData.config as Record<string, unknown>).liveBindings)).toBe(persistedBefore);

    rerender(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props} extensions={[extension]}>
        <CaptureRegistry />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(capturedRegistry?.resolveBinding('binding-1').status).toBe('orphaned');
      expect(capturedRegistry?.getDiagnostics().some(
        (diagnostic) =>
          diagnostic.code === 'live/duplicate-source' && diagnostic.sourceId === sourceId,
      )).toBe(true);
    });
  });

  it('syncs live registry diagnostics to diagnosticCollection', async () => {
    let capturedCollection: ReturnType<typeof useVideoEditorRuntime>['diagnosticCollection'] = null;
    const sourceId = 'diagnostic-live-source';
    const extension = defineExtension({
      manifest: {
        id: 'com.example.live-diagnostic' as never,
        version: '1.0.0',
        label: 'Live diagnostic extension',
      },
      activate(ctx) {
        ctx.creative.sessions.registerSource({
          id: sourceId,
          kind: 'generated',
          label: 'Diagnostic Source',
        });
        return { dispose() {} };
      },
    });

    function CaptureDiagnostics() {
      const runtime = useVideoEditorRuntime();
      capturedCollection = runtime.diagnosticCollection ?? null;
      return null;
    }

    const props = {
      dataProvider: {} as DataProvider,
      timelineId: 'timeline-1',
      userId: 'user-1',
      extensions: [extension],
    };

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} {...props}>
        <CaptureDiagnostics />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(capturedCollection).not.toBeNull();
    });

    await waitFor(() => {
      const liveDiagnostics = capturedCollection?.getSnapshot().filter(
        (d) => d.detail?.source === 'live-registry',
      ) ?? [];
      expect(liveDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'live/source-registered'
          && diagnostic.detail?.sourceId === sourceId,
      )).toBe(true);
      expect(liveDiagnostics.every((diagnostic) => diagnostic.extensionId === undefined)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Repository-backed runtime settings write-through
// ---------------------------------------------------------------------------

describe('EditorRuntimeProvider project-object capability', () => {
  it('passes only the active provider object port to extension creative context', async () => {
    const projectObjects = {
      ingest: vi.fn(),
      read: vi.fn(),
    };
    let captured: unknown;
    const extension = defineExtension({
      manifest: {
        id: 'com.example.project-objects',
        version: '1.0.0',
        label: 'Project objects',
        apiVersion: 1,
      },
      activate(ctx) {
        captured = ctx.creative.projectObjects;
        return { dispose() {} };
      },
    });

    const { unmount } = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{ projectObjects } as unknown as DataProvider}
        timelineId="timeline-project-objects"
        userId="user-project-objects"
        extensions={[extension]}
      >
        <div />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => expect(captured).toBe(projectObjects));
    expect(captured).not.toHaveProperty('client');
    unmount();
  });

  it('leaves project objects unavailable when the provider omits the port', async () => {
    let captured: unknown = 'not-captured';
    const extension = defineExtension({
      manifest: {
        id: 'com.example.project-objects-unavailable',
        version: '1.0.0',
        label: 'Project objects unavailable',
        apiVersion: 1,
      },
      activate(ctx) {
        captured = ctx.creative.projectObjects;
        return { dispose() {} };
      },
    });

    const { unmount } = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-project-objects-unavailable"
        userId="user-project-objects"
        extensions={[extension]}
      >
        <div />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => expect(captured).toBeUndefined());
    unmount();
  });
});

describe('EditorRuntimeProvider repository-backed runtime settings', () => {
  const EXTENSION_ID = 'com.example.runtime-settings';

  function makeSettingsExtension(capture: (settings: ExtensionSettingsService) => void) {
    return defineExtension({
      manifest: {
        id: EXTENSION_ID as never,
        version: '1.0.0',
        label: 'Runtime settings extension',
        settingsSchemaVersion: 3,
        settingsDefaults: {
          theme: 'system',
        },
      },
      activate(ctx) {
        capture(ctx.services.settings);
        return { dispose() {} };
      },
    });
  }

  beforeEach(() => {
    cleanupRuntimeSettingsLocalStorage(EXTENSION_ID);
  });

  afterEach(() => {
    cleanupRuntimeSettingsLocalStorage(EXTENSION_ID);
  });

  it('persists set and delete before disposal and notifies only after provider writes resolve', async () => {
    const { repository, writes } = makeDeferredRuntimeSettingsRepository();
    let settings: ExtensionSettingsService | null = null;
    let subscriptionReady = false;
    let notifications = 0;

    function CaptureSettingsNotifications() {
      const runtime = useVideoEditorRuntime();
      useEffect(() => {
        const registry = runtime.settingsNotificationRegistry;
        if (!registry) return undefined;
        const handle = registry.subscribeToExtension(EXTENSION_ID, () => {
          notifications += 1;
        });
        subscriptionReady = true;
        return () => handle.dispose();
      }, [runtime.settingsNotificationRegistry]);
      return null;
    }

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[makeSettingsExtension((svc) => { settings = svc; })]}
        extensionStateRepository={repository}
      >
        <CaptureSettingsNotifications />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(settings).not.toBeNull();
      expect(subscriptionReady).toBe(true);
    });

    settings!.set('theme', 'dark');

    expect(repository.putSettingsSnapshot).toHaveBeenCalledTimes(1);
    expect(writes[0].snapshot.extensionId).toBe(EXTENSION_ID);
    expect(writes[0].snapshot.schemaVersion).toBe(3);
    expect(writes[0].snapshot.values).toMatchObject({ theme: 'dark' });
    expect(notifications).toBe(0);

    writes[0].resolve();

    await waitFor(() => {
      expect(notifications).toBe(1);
    });

    settings!.delete('theme');

    await waitFor(() => {
      expect(repository.putSettingsSnapshot).toHaveBeenCalledTimes(2);
    });
    expect(writes[1].snapshot.values).not.toHaveProperty('theme');
    expect(notifications).toBe(1);

    writes[1].resolve();

    await waitFor(() => {
      expect(notifications).toBe(2);
    });
  });

  it('serializes rapid runtime mutations so the replayed provider snapshot is latest-wins', async () => {
    const { repository, writes } = makeDeferredRuntimeSettingsRepository();
    let settings: ExtensionSettingsService | null = null;
    let subscriptionReady = false;
    let notifications = 0;

    function CaptureSettingsNotifications() {
      const runtime = useVideoEditorRuntime();
      useEffect(() => {
        const registry = runtime.settingsNotificationRegistry;
        if (!registry) return undefined;
        const handle = registry.subscribeToExtension(EXTENSION_ID, () => {
          notifications += 1;
        });
        subscriptionReady = true;
        return () => handle.dispose();
      }, [runtime.settingsNotificationRegistry]);
      return null;
    }

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[makeSettingsExtension((svc) => { settings = svc; })]}
        extensionStateRepository={repository}
      >
        <CaptureSettingsNotifications />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(settings).not.toBeNull();
      expect(subscriptionReady).toBe(true);
    });

    settings!.set('a', 'first');
    settings!.set('b', 'second');
    settings!.delete('a');

    expect(repository.putSettingsSnapshot).toHaveBeenCalledTimes(1);
    expect(writes[0].snapshot.values).toMatchObject({ a: 'first' });
    expect(notifications).toBe(0);

    writes[0].resolve();

    await waitFor(() => {
      expect(repository.putSettingsSnapshot).toHaveBeenCalledTimes(2);
    });
    expect(writes[1].snapshot.values).toMatchObject({ b: 'second' });
    expect(writes[1].snapshot.values).not.toHaveProperty('a');

    writes[1].resolve();

    await waitFor(() => {
      expect(notifications).toBe(2);
    });
  });

  it('publishes sanitized provider diagnostics when runtime settings persistence rejects', async () => {
    const { repository, writes } = makeDeferredRuntimeSettingsRepository();
    let settings: ExtensionSettingsService | null = null;
    let collection: ReturnType<typeof useVideoEditorRuntime>['diagnosticCollection'] = null;

    function CaptureDiagnostics() {
      const runtime = useVideoEditorRuntime();
      collection = runtime.diagnosticCollection ?? null;
      return null;
    }

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[makeSettingsExtension((svc) => { settings = svc; })]}
        extensionStateRepository={repository}
      >
        <CaptureDiagnostics />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(settings).not.toBeNull();
      expect(collection).not.toBeNull();
    });

    settings!.set('safeKey', 'secret-value');
    writes[0].reject(new Error('token secret-value leaked from backend'));

    await waitFor(() => {
      const diagnostics = collection?.getSnapshot() ?? [];
      expect(diagnostics.some((diagnostic) =>
        diagnostic.code === 'extension.settings.persistence_failed'
        && diagnostic.extensionId === EXTENSION_ID
        && diagnostic.source === 'provider'
        && diagnostic.detail?.source === 'settings-persistence'
        && diagnostic.detail?.operation === 'set'
        && diagnostic.detail?.key === 'safeKey'
        && diagnostic.detail?.revision === 1
        && typeof diagnostic.detail?.message === 'string'
        && !diagnostic.message.includes('secret-value')
        && !diagnostic.detail.message.includes('secret-value'),
      )).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Extension settings surface via SchemaForm inside EditorRuntimeProvider
// ---------------------------------------------------------------------------

describe('EditorRuntimeProvider extension settings surface', () => {
  const SETTINGS_EXTENSION_ID = 'com.example.settings';
  const settingsManifest = {
    id: SETTINGS_EXTENSION_ID as never,
    version: '1.0.0',
    label: 'Settings Extension',
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

  it('renders settings form inside EditorRuntimeProvider and loads defaults', async () => {
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
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[
          defineExtension({ manifest: settingsManifest }),
        ]}
      >
        <CaptureForm />
      </EditorRuntimeProvider>,
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

    const { rerender } = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[
          defineExtension({ manifest: settingsManifest }),
        ]}
      >
        <CaptureForm />
      </EditorRuntimeProvider>,
    );

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
    rerender(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[
          defineExtension({ manifest: settingsManifest }),
        ]}
      >
        <CaptureForm />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      const reloadedInput = document.querySelector(
        '[data-testid="schema-form-widget-apiKey"]',
      ) as HTMLInputElement | null;
      expect(reloadedInput?.value).toBe('my-secret-key');
    });
  });

  it('blocks save on invalid field and focuses error (invalid focus behavior)', async () => {
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
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[
          defineExtension({ manifest: settingsManifest }),
        ]}
      >
        <CaptureForm />
      </EditorRuntimeProvider>,
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
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[
          defineExtension({ manifest: settingsManifest }),
        ]}
      >
        <CaptureForm />
      </EditorRuntimeProvider>,
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
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[
          defineExtension({ manifest: settingsManifest }),
        ]}
      >
        <CaptureForm />
      </EditorRuntimeProvider>,
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
    const OTHER_EXTENSION_ID = 'com.example.other';
    const otherManifest = {
      id: OTHER_EXTENSION_ID as never,
      version: '1.0.0',
      label: 'Other Extension',
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

    // Pre-populate localStorage for both extensions to simulate saved settings
    localStorage.setItem(
      `astrid.ext.${SETTINGS_EXTENSION_ID}.apiKey`,
      '"settings-key"',
    );
    localStorage.setItem(
      `astrid.ext.${OTHER_EXTENSION_ID}.otherKey`,
      '"other-key"',
    );

    // Define extensions once so manifest references are stable across re-renders
    const settingsExt = defineExtension({ manifest: settingsManifest });
    const otherExt = defineExtension({ manifest: otherManifest });

    let capturedRuntime: ReturnType<typeof useVideoEditorRuntime> | null = null;

    function CaptureRuntime() {
      capturedRuntime = useVideoEditorRuntime();
      return null;
    }

    // This toggle changes extensions inside one authority scope. A new provider
    // object intentionally replaces that scope, so retain this fixture identity.
    const stableDataProvider = {} as DataProvider;

    function Host({ includeSettings }: { includeSettings: boolean }) {
      const exts = includeSettings
        ? [settingsExt, otherExt]
        : [otherExt];
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={stableDataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={exts}
        >
          <CaptureRuntime />
        </EditorRuntimeProvider>
      );
    }

    const { rerender } = render(<Host includeSettings />);

    await waitFor(() => {
      expect(capturedRuntime).not.toBeNull();
    });

    // Both extensions' settings should be in localStorage
    expect(
      savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey'),
    ).toBe('"settings-key"');
    expect(
      savedExtensionSetting(OTHER_EXTENSION_ID, 'otherKey'),
    ).toBe('"other-key"');

    // Disable the settings extension (remove from props)
    rerender(<Host includeSettings={false} />);

    // The targeted extension's saved settings are kept: only uninstall or reset erases them.
    expect(
      savedExtensionSetting(SETTINGS_EXTENSION_ID, 'apiKey'),
    ).toBe('"settings-key"');

    // Unrelated extension's settings localStorage must be preserved
    expect(
      savedExtensionSetting(OTHER_EXTENSION_ID, 'otherKey'),
    ).toBe('"other-key"');

    // Targeted extension's diagnostics must be cleared
    const snapshot = capturedRuntime?.diagnosticCollection?.getSnapshot() ?? [];
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

describe('EditorRuntimeProvider render-boundary recovery', () => {
  const SLOT_EXTENSION_ID = 'com.example.slot-ext';

  const slotManifest = {
    id: SLOT_EXTENSION_ID as never,
    version: '1.0.0',
    label: 'Slot Extension',
    contributions: [
      {
        kind: 'slot' as const,
        id: 'slot-ext-header',
        slot: 'header',
        order: 0,
      },
    ],
  };

  it('surface detach removes contributions on disable — re-enable restores them fresh', async () => {
    const slotExt = defineExtension({ manifest: slotManifest });

    let capturedConfigSlots: string[] | null = null;
    let capturedRuntime: ReturnType<typeof useVideoEditorRuntime> | null = null;

    function Capture() {
      capturedRuntime = useVideoEditorRuntime();
      capturedConfigSlots = capturedRuntime?.extensionRuntime?.config?.slots
        ? Object.keys(capturedRuntime.extensionRuntime.config.slots)
        : null;
      return null;
    }

    function Host({ includeSlot }: { includeSlot: boolean }) {
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={{} as DataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={includeSlot ? [slotExt] : []}
        >
          <Capture />
        </EditorRuntimeProvider>
      );
    }

    const { rerender } = render(<Host includeSlot />);

    await waitFor(() => {
      expect(capturedRuntime).not.toBeNull();
    });

    // Slot 'header' should be in the config while the extension is loaded
    expect(capturedConfigSlots).toContain('header');

    // Disable the extension (remove from extensions list)
    rerender(<Host includeSlot={false} />);

    await waitFor(() => {
      // After disable, the slot should be gone from the config
      expect(capturedConfigSlots).not.toContain('header');
    });

    // Re-enable the extension
    rerender(<Host includeSlot />);

    await waitFor(() => {
      // After re-enable, the slot should be back — fresh surface mount
      expect(capturedConfigSlots).toContain('header');
    });

    // Verify diagnostics are clean after re-enable (no stale error state)
    const snapshot = capturedRuntime?.diagnosticCollection?.getSnapshot() ?? [];
    const slotDiags = snapshot.filter(
      (d) => d.extensionId === SLOT_EXTENSION_ID && d.severity === 'error',
    );
    expect(slotDiags).toEqual([]);
  });

  it('re-enable after disable produces fresh contributions with no duplicates', async () => {
    const slotExt = defineExtension({ manifest: slotManifest });

    let capturedConfigSlots: string[] | null = null;

    function Capture() {
      const rt = useVideoEditorRuntime();
      capturedConfigSlots = rt?.extensionRuntime?.config?.slots
        ? Object.keys(rt.extensionRuntime.config.slots)
        : null;
      return null;
    }

    function Host({ includeSlot }: { includeSlot: boolean }) {
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={{} as DataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={includeSlot ? [slotExt] : []}
        >
          <Capture />
        </EditorRuntimeProvider>
      );
    }

    const { rerender } = render(<Host includeSlot />);

    await waitFor(() => {
      expect(capturedConfigSlots).toContain('header');
    });

    // First disable
    rerender(<Host includeSlot={false} />);
    await waitFor(() => {
      expect(capturedConfigSlots).not.toContain('header');
    });

    // Re-enable
    rerender(<Host includeSlot />);
    await waitFor(() => {
      expect(capturedConfigSlots).toContain('header');
    });

    // Disable again
    rerender(<Host includeSlot={false} />);
    await waitFor(() => {
      expect(capturedConfigSlots).not.toContain('header');
    });

    // Re-enable again — should still get exactly one slot contribution
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
// (effects, transitions, shaders, clip-types) correctly scopes cleanup to
// only the removed extension's records, preserving unrelated extensions.
//
// Agent tools and live data registries are future-only scaffolding and are
// NOT exposed as public contribution systems (see provider comments).

describe('EditorRuntimeProvider transition registry scoped cleanup', () => {
  it('clears only the removed extension transition records and preserves unrelated extension records', async () => {
    const EXT_A = 'com.example.transition-ext-a';
    const EXT_B = 'com.example.transition-ext-b';
    const transitionAId = 'transition-a';
    const transitionBId = 'transition-b';
    const disposeA = vi.fn();
    const disposeB = vi.fn();

    let latestRecords: readonly TransitionRegistryRecord[] = [];

    const extA = defineExtension({
      manifest: {
        id: EXT_A as never,
        version: '1.0.0',
        label: 'Transition Extension A',
      },
    });
    const extB = defineExtension({
      manifest: {
        id: EXT_B as never,
        version: '1.0.0',
        label: 'Transition Extension B',
      },
    });

    function CaptureTransitions() {
      const { registry } = useTransitionRegistryContext();
      latestRecords = useTransitionRegistryContext().snapshot.records;

      useEffect(() => {
        const hA = registry.register(transitionRecord(transitionAId, EXT_A, disposeA));
        const hB = registry.register(transitionRecord(transitionBId, EXT_B, disposeB));
        return () => {
          hA.dispose();
          hB.dispose();
        };
      }, [registry]);

      return null;
    }

    // This toggle changes extensions inside one authority scope. A new provider
    // object intentionally replaces that scope, so retain this fixture identity.
    const stableDataProvider = {} as DataProvider;

    function Host({ includeA }: { includeA: boolean }) {
      const exts = includeA ? [extA, extB] : [extB];
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={stableDataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={exts}
        >
          <CaptureTransitions />
        </EditorRuntimeProvider>
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

describe('EditorRuntimeProvider shader registry scoped cleanup', () => {
  it('clears only the removed extension shader records and preserves unrelated extension records', async () => {
    const EXT_A = 'com.example.shader-ext-a';
    const EXT_B = 'com.example.shader-ext-b';
    const shaderAId = 'shader.ext.a.grade';
    const shaderBId = 'shader.ext.b.blur';
    const disposeA = vi.fn();
    const disposeB = vi.fn();

    let latestRecords: readonly ShaderEffectRegistryRecord[] = [];

    const extA = defineExtension({
      manifest: {
        id: EXT_A as never,
        version: '1.0.0',
        label: 'Shader Extension A',
      },
    });
    const extB = defineExtension({
      manifest: {
        id: EXT_B as never,
        version: '1.0.0',
        label: 'Shader Extension B',
      },
    });

    function CaptureShaders() {
      const { registry } = useShaderEffectRegistryContext();
      latestRecords = useShaderEffectRegistryContext().snapshot.records;

      useEffect(() => {
        const hA = registry.register(shaderRecord(shaderAId, EXT_A, [], disposeA));
        const hB = registry.register(shaderRecord(shaderBId, EXT_B, [], disposeB));
        return () => {
          hA.dispose();
          hB.dispose();
        };
      }, [registry]);

      return null;
    }

    // This toggle changes extensions inside one authority scope. A new provider
    // object intentionally replaces that scope, so retain this fixture identity.
    const stableDataProvider = {} as DataProvider;

    function Host({ includeA }: { includeA: boolean }) {
      const exts = includeA ? [extA, extB] : [extB];
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={stableDataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={exts}
        >
          <CaptureShaders />
        </EditorRuntimeProvider>
      );
    }

    const { rerender } = render(<Host includeA />);

    await waitFor(() => {
      expect(latestRecords.map((r) => r.shaderId)).toEqual(
        expect.arrayContaining([shaderAId, shaderBId]),
      );
    });

    // Remove extension A
    rerender(<Host includeA={false} />);

    await waitFor(() => {
      // Extension A's shader record must be removed
      expect(latestRecords.map((r) => r.shaderId)).not.toContain(shaderAId);
    });

    // Extension B's shader record must be preserved
    expect(latestRecords.map((r) => r.shaderId)).toContain(shaderBId);
    expect(latestRecords.map((r) => r.shaderId)).toHaveLength(1);
    expect(disposeA).toHaveBeenCalled();
    expect(disposeB).not.toHaveBeenCalled();
  });
});

describe('EditorRuntimeProvider clip-type registry scoped cleanup', () => {
  it('clears only the removed extension clip-type records and preserves unrelated extension records', async () => {
    const EXT_A = 'com.example.cliptype-ext-a';
    const EXT_B = 'com.example.cliptype-ext-b';
    const clipAId = 'clip-type-a';
    const clipBId = 'clip-type-b';
    const disposeA = vi.fn();
    const disposeB = vi.fn();

    let latestRecords: readonly ClipTypeRegistryRecord[] = [];

    const extA = defineExtension({
      manifest: {
        id: EXT_A as never,
        version: '1.0.0',
        label: 'ClipType Extension A',
      },
    });
    const extB = defineExtension({
      manifest: {
        id: EXT_B as never,
        version: '1.0.0',
        label: 'ClipType Extension B',
      },
    });

    function CaptureClipTypes() {
      const { registry } = useClipTypeRegistryContext();
      latestRecords = useClipTypeRegistryContext().snapshot.records;

      useEffect(() => {
        const hA = registry.register(clipTypeRecord(clipAId, EXT_A, disposeA));
        const hB = registry.register(clipTypeRecord(clipBId, EXT_B, disposeB));
        return () => {
          hA.dispose();
          hB.dispose();
        };
      }, [registry]);

      return null;
    }

    // This toggle changes extensions inside one authority scope. A new provider
    // object intentionally replaces that scope, so retain this fixture identity.
    const stableDataProvider = {} as DataProvider;

    function Host({ includeA }: { includeA: boolean }) {
      const exts = includeA ? [extA, extB] : [extB];
      return (
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={stableDataProvider}
          timelineId="timeline-1"
          userId="user-1"
          extensions={exts}
        >
          <CaptureClipTypes />
        </EditorRuntimeProvider>
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
});

// ---------------------------------------------------------------------------
// Proposal persistence provider lifecycle (fail-to-pass)
// ---------------------------------------------------------------------------

describe('M1: proposal persistence provider lifecycle', () => {
  /**
   * Create a minimal mock TimelineOps that satisfies the interface.
   * The real createProposalRuntime requires validate/preview/apply methods.
   */
  function makeMockTimelineOps() {
    return {
      validate: vi.fn().mockReturnValue({ valid: true, diagnostics: [] }),
      preview: vi.fn().mockReturnValue({
        diff: { version: 1, entries: [], affectedObjectIds: [] },
        fullyPreviewable: true,
        diagnostics: [],
      }),
      apply: vi.fn().mockReturnValue({ version: 1, entries: [], affectedObjectIds: [] }),
      checkpoint: vi.fn().mockReturnValue('ckpt-1'),
      rollback: vi.fn().mockReturnValue(null),
      setAllTracksMuted: vi.fn().mockReturnValue({ version: 1, entries: [], affectedObjectIds: [] }),
      flush: async () => { throw new Error('Durable persistence is unavailable in this test host.'); },
    };
  }

  /**
   * Create a mock ExtensionPersistenceService whose initialize/dispose are
   * vi.fn() spies and whose capabilities.proposals is true so the bridge is
   * created.  All proposal CRUD methods resolve to empty/no-op results.
   */
  function makeMockPersistenceService(overrides?: { initialize?: () => Promise<void> }) {
    const initialize = overrides?.initialize ?? vi.fn().mockResolvedValue(undefined);
    return {
      scope: { userId: 'user-1', timelineId: 'timeline-1' },
      capabilities: { state: false, settings: false, proposals: true },
      initialize,
      dispose: vi.fn().mockResolvedValue(undefined),
      isDisposed: false,
      stateRepository: undefined,
      // Proposal CRUD — stub implementations that the bridge will call
      createProposal: vi.fn().mockResolvedValue({ id: 'p-1' }),
      updateProposalStatus: vi.fn().mockResolvedValue(undefined),
      queryProposals: vi.fn().mockResolvedValue([]),
    } satisfies ExtensionPersistenceService;
  }

  it('calls initialize() on the persistence service before exposing proposalRuntime', async () => {
    const persistenceService = makeMockPersistenceService();
    const mockOps = makeMockTimelineOps();

    // Override useTimelineState so timelineOps is non-null — this is the
    // gate that allows proposalRuntime creation in EditorRuntimeProviderInner.
    vi.mocked(useTimelineState).mockReturnValue({
      ...mocks.timelineStateRest,
      store: {
        getState: () => ({
          data: { data: mocks.timelineData },
          timelineOps: mockOps as any,
          syncSlices: mocks.syncSlices,
          setMounted: mocks.setMounted,
        }),
      },
    } as any);

    // Build a DataProvider whose createExtensionPersistenceService returns
    // the service mock.
    const dataProvider = {
      createExtensionPersistenceService: vi.fn().mockReturnValue(persistenceService),
    } as unknown as DataProvider;

    // Clear any previous syncSlices calls from module mocks.
    mocks.syncSlices.mockClear();

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={dataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[]}
      >
        <div data-testid="child" />
      </EditorRuntimeProvider>,
    );

    // After render, the service factory must have been called.
    expect(dataProvider.createExtensionPersistenceService).toHaveBeenCalled();

    // initialize() must have been called on the service.
    // (FAIL-TO-PASS: currently initialize is never called. This is the fix target.)
    expect(persistenceService.initialize).toHaveBeenCalled();

    // Wait for initialization to settle, then verify proposalRuntime was
    // exposed via syncSlices AFTER initialization.
    await waitFor(() => {
      expect(persistenceService.initialize).toHaveBeenCalled();
    });

    // Verify syncSlices carried a proposalRuntime.
    const syncCalls = mocks.syncSlices.mock.calls.filter(
      (call: any[]) => call[0] && 'proposalRuntime' in call[0] && call[0].proposalRuntime != null,
    );
    expect(syncCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not expose proposalRuntime when persistence initialization fails', async () => {
    const initError = new Error('Persistence backend unavailable');
    const persistenceService = makeMockPersistenceService({
      initialize: vi.fn().mockRejectedValue(initError),
    });
    const mockOps = makeMockTimelineOps();

    vi.mocked(useTimelineState).mockReturnValue({
      ...mocks.timelineStateRest,
      store: {
        getState: () => ({
          data: { data: mocks.timelineData },
          timelineOps: mockOps as any,
          syncSlices: mocks.syncSlices,
          setMounted: mocks.setMounted,
        }),
      },
    } as any);

    const dataProvider = {
      createExtensionPersistenceService: vi.fn().mockReturnValue(persistenceService),
    } as unknown as DataProvider;

    mocks.syncSlices.mockClear();

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={dataProvider}
        timelineId="timeline-1"
        userId="user-1"
        extensions={[]}
      >
        <div data-testid="child" />
      </EditorRuntimeProvider>,
    );

    // initialize must have been attempted.
    expect(persistenceService.initialize).toHaveBeenCalled();

    // When initialization fails, syncSlices MUST NOT carry a non-null
    // proposalRuntime.  (FAIL-TO-PASS: currently the runtime is exposed
    // unconditionally in the render body, without waiting for initialize.)
    // This should hold.
    await waitFor(() => {
      expect(persistenceService.initialize).toHaveBeenCalled();
    });

    const runtimeSyncs = mocks.syncSlices.mock.calls.filter(
      (call: any[]) => call[0] && 'proposalRuntime' in call[0] && call[0].proposalRuntime != null,
    );
    // In the corrected implementation, a failed initialize must not
    // expose a persistence-backed proposalRuntime.
    expect(runtimeSyncs.length).toBe(0);
  });

  it('throws a clear initialization error when uninitialized proposal persistence is used', async () => {
    // Build a real CachedExtensionPersistenceService via InMemoryDataProvider
    // but skip calling initialize(). Then wrap it in the bridge and assert
    // that any data-access method throws.
    const { InMemoryDataProvider } = await import(
      '@/tools/video-editor/testing/InMemoryDataProvider'
    );

    const provider = new InMemoryDataProvider();
    const diagnostics: any[] = [];
    const service = provider.createExtensionPersistenceService(
      { userId: 'user-1', timelineId: 'timeline-1' },
      diagnostics,
    );

    // Deliberately skip service.initialize() — the service is uninitialized.

    const bridge = createProposalPersistenceBridge(service);

    // Any persistence operation must reject with the initialization error.
    await expect(bridge.loadAllProposals()).rejects.toThrow(
      'Repository not initialized',
    );

    await expect(
      bridge.createProposal({
        source: 'test',
        state: 'pending',
        baseVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        patch: {},
      }),
    ).rejects.toThrow('Repository not initialized');

    await expect(
      bridge.updateProposalStatus('p-1', 'accepted'),
    ).rejects.toThrow('Repository not initialized');
  });

  it('allows proposal persistence after successful initialization', async () => {
    // Verify the happy path: after initialize() succeeds, the bridge works.
    const { InMemoryDataProvider } = await import(
      '@/tools/video-editor/testing/InMemoryDataProvider'
    );

    const provider = new InMemoryDataProvider();
    const diagnostics: any[] = [];
    const service = provider.createExtensionPersistenceService(
      { userId: 'user-1', timelineId: 'timeline-1' },
      diagnostics,
    );

    // Properly initialize the service first.
    await service.initialize();

    const bridge = createProposalPersistenceBridge(service);

    // loadAllProposals should succeed (return empty array for fresh state).
    const proposals = await bridge.loadAllProposals();
    expect(proposals).toEqual([]);

    // createProposal should succeed.
    const id = await bridge.createProposal({
      source: 'test-ext',
      state: 'pending',
      baseVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      patch: { version: 1, operations: [] },
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    // After creation, loadAllProposals should return the persisted proposal.
    const reloaded = await bridge.loadAllProposals();
    expect(reloaded.length).toBe(1);
    expect(reloaded[0].id).toBe(id);

    // updateProposalStatus should succeed.
    await expect(
      bridge.updateProposalStatus(id, 'accepted', { reason: 'approved' }),
    ).resolves.toBeUndefined();

    // Cleanup.
    await service.dispose();
  });

  it('scopes persistence to userId/timelineId/provider changes, disposing old service and creating fresh', async () => {
    // This test verifies the scope rework: when scope (userId, timelineId, or
    // dataProvider) changes, the old persistence service is disposed, the
    // bridge is cleared, and a new service is created + initialized for the
    // new scope.
    const disposeFirst = vi.fn().mockResolvedValue(undefined);
    const disposeSecond = vi.fn().mockResolvedValue(undefined);

    const firstService = makeMockPersistenceService();
    firstService.dispose = disposeFirst;

    const secondService = makeMockPersistenceService();
    secondService.dispose = disposeSecond;

    const mockOps = makeMockTimelineOps();
    vi.mocked(useTimelineState).mockReturnValue({
      ...mocks.timelineStateRest,
      store: {
        getState: () => ({
          data: { data: mocks.timelineData },
          timelineOps: mockOps as any,
          syncSlices: mocks.syncSlices,
          setMounted: mocks.setMounted,
        }),
      },
    } as any);

    mocks.syncSlices.mockClear();

    // createExtensionPersistenceService returns different services based on userId.
    const factory = vi
      .fn()
      .mockReturnValueOnce(firstService)
      .mockReturnValueOnce(secondService);

    const dataProvider = {
      createExtensionPersistenceService: factory,
    } as unknown as DataProvider;

    // Render with scope A.
    const { rerender } = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={dataProvider}
        timelineId="timeline-A"
        userId="user-A"
        extensions={[]}
      >
        <div data-testid="child" />
      </EditorRuntimeProvider>,
    );

    // First service created and initialized.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(firstService.initialize).toHaveBeenCalledTimes(1);
    expect(disposeFirst).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(firstService.initialize).toHaveBeenCalled();
    });

    // Rerender with scope B (different userId + timelineId).
    rerender(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={dataProvider}
        timelineId="timeline-B"
        userId="user-B"
        extensions={[]}
      >
        <div data-testid="child" />
      </EditorRuntimeProvider>,
    );

    // Old service must have been disposed.
    await waitFor(() => {
      expect(disposeFirst).toHaveBeenCalledTimes(1);
    });

    // New service created for scope B.
    expect(factory).toHaveBeenCalledTimes(2);
    expect(secondService.initialize).toHaveBeenCalledTimes(1);

    // Verify the factory was called with the NEW scope params.
    const secondCallArgs = factory.mock.calls[1];
    expect(secondCallArgs[0]).toEqual({ userId: 'user-B', timelineId: 'timeline-B' });

    await waitFor(() => {
      expect(secondService.initialize).toHaveBeenCalled();
    });
  });
});

describe('EditorRuntimeProvider timeline-overlay flag', () => {
  function TimelineOverlayFlagConsumer() {
    const runtime = useVideoEditorRuntime();
    return <span data-testid="timeline-overlays-enabled">{String(runtime.timelineOverlaysEnabled)}</span>;
  }

  it('observes false when no value is supplied', () => {
    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={{} as DataProvider} timelineId="timeline-1" userId="user-1">
        <TimelineOverlayFlagConsumer />
      </EditorRuntimeProvider>,
    );
    expect(screen.getByTestId('timeline-overlays-enabled')).toHaveTextContent('false');
  });

  it('observes false when explicitly disabled', () => {
    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={{} as DataProvider} timelineId="timeline-1" userId="user-1" timelineOverlaysEnabled={false}>
        <TimelineOverlayFlagConsumer />
      </EditorRuntimeProvider>,
    );
    expect(screen.getByTestId('timeline-overlays-enabled')).toHaveTextContent('false');
  });

  it('reaches the runtime consumer unchanged when explicitly enabled', () => {
    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={{} as DataProvider} timelineId="timeline-1" userId="user-1" timelineOverlaysEnabled>
        <TimelineOverlayFlagConsumer />
      </EditorRuntimeProvider>,
    );
    expect(screen.getByTestId('timeline-overlays-enabled')).toHaveTextContent('true');
  });
});

describe('EditorRuntimeProvider browse-only assembly', () => {
  it('omits supplied extensions and every mutation, live, persistence, process, and export service', async () => {
    const activate = vi.fn();
    const extension = defineExtension({
      manifest: {
        id: 'com.example.must-not-activate' as never,
        version: '1.0.0',
        label: 'Must not activate',
        contributions: [],
      },
      activate,
    });
    const createExtensionPersistenceService = vi.fn();
    const dataProvider = { createExtensionPersistenceService } as unknown as DataProvider;
    const getAllSettingsSnapshots = vi.fn(async () => []);
    const extensionStateRepository = {
      isDisposed: false,
      getAllSettingsSnapshots,
    } as unknown as ExtensionStateRepository;
    const processManager = {
      listStatuses: vi.fn(() => []),
      dispose: vi.fn(async () => undefined),
    } as unknown as ProcessManager;
    const triggerExtensionRefresh = vi.fn();
    let runtime: ReturnType<typeof useVideoEditorRuntime> | null = null;

    function CaptureRuntime() {
      runtime = useVideoEditorRuntime();
      return <div data-testid="browse-only-runtime" />;
    }

    vi.mocked(createProposalRuntime).mockClear();
    vi.mocked(createProposalPersistenceBridge).mockClear();
    mocks.syncSlices.mockClear();

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={dataProvider}
        timelineId="timeline-read-only"
        userId="public-user"
        extensions={[extension]}
        extensionStateRepository={extensionStateRepository}
        triggerExtensionRefresh={triggerExtensionRefresh}
        processManager={processManager}
        enableMutationServices={false}
        enableLiveServices={false}
        enableRenderExport={false}
      >
        <CaptureRuntime />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => expect(runtime).not.toBeNull());

    // Keep this diagnostic serializable: a failing spy assertion formats its
    // captured ExtensionContext, whose creative.assets getter intentionally
    // throws until its adapter is implemented and can hide the actual activation regression.
    expect(activate.mock.calls.length).toBe(0);
    expect(runtime!.extensionRuntime?.extensions ?? []).toHaveLength(0);
    expect(runtime!.commandRegistry).toBeUndefined();
    expect(runtime!.agentToolRegistry).toBeUndefined();
    expect(runtime!.processManager).toBeUndefined();
    expect(runtime!.processStatuses).toBeUndefined();
    expect(runtime!.recordProcessResultAttach).toBeUndefined();
    expect(runtime!.liveDataRegistry).toBeUndefined();
    expect(runtime!.livePermissionService).toBeUndefined();
    expect(runtime!.extensionStateRepository).toBeNull();
    expect(runtime!.renderExportEnabled).toBe(false);
    expect(runtime!.provider.createExtensionPersistenceService).toBe(createExtensionPersistenceService);
    expect(createExtensionPersistenceService).not.toHaveBeenCalled();
    expect(getAllSettingsSnapshots).not.toHaveBeenCalled();
    expect(processManager.listStatuses).not.toHaveBeenCalled();
    expect(processManager.dispose).not.toHaveBeenCalled();
    expect(runtime!.triggerExtensionRefresh).toBeUndefined();
    expect(createProposalRuntime).not.toHaveBeenCalled();
    expect(createProposalPersistenceBridge).not.toHaveBeenCalled();
    expect(mocks.syncSlices.mock.calls.some(
      ([slice]) => slice?.proposalRuntime != null,
    )).toBe(false);
  });

  it('carries public host identity, timeline editability, and export denial through the real provider', async () => {
    const createExtensionPersistenceService = vi.fn();
    const dataProvider = { createExtensionPersistenceService } as unknown as DataProvider;
    const getAllSettingsSnapshots = vi.fn(async () => []);
    const extensionStateRepository = {
      isDisposed: false,
      getAllSettingsSnapshots,
    } as unknown as ExtensionStateRepository;
    const processManager = {
      listStatuses: vi.fn(() => []),
      dispose: vi.fn(async () => undefined),
    } as unknown as ProcessManager;
    let runtime: ReturnType<typeof useVideoEditorRuntime> | null = null;
    function CaptureRuntime() {
      runtime = useVideoEditorRuntime();
      return null;
    }

    const props = {
      dataProvider,
      timelineId: 'public-proof-timeline',
      userId: 'public-user',
      astridElementHost: PUBLIC_ASTRID_ELEMENT_HOST,
      timelineEditability: PUBLIC_ASTRID_READ_ONLY_EDITABILITY,
      extensionStateRepository,
      processManager,
      enableMutationServices: false,
      enableLiveServices: false,
      enableRenderExport: false,
    } as const;
    const { rerender } = render(
      <EditorRuntimeProvider {...props}>
        <CaptureRuntime />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => expect(runtime).not.toBeNull());
    expect(runtime!.astridElementHost).toBe(PUBLIC_ASTRID_ELEMENT_HOST);
    expect(runtime!.timelineEditability).toBe(PUBLIC_ASTRID_READ_ONLY_EDITABILITY);
    expect(runtime!.renderExportEnabled).toBe(false);
    expect(runtime!.astridElementHost.descriptors).toHaveLength(12);
    expect(runtime!.provider).toBe(dataProvider);
    expect(runtime!.extensionStateRepository).toBeNull();
    expect(runtime!.processManager).toBeUndefined();
    expect(createExtensionPersistenceService).not.toHaveBeenCalled();
    expect(getAllSettingsSnapshots).not.toHaveBeenCalled();
    expect(processManager.listStatuses).not.toHaveBeenCalled();
    expect(processManager.dispose).not.toHaveBeenCalled();

    // A disabled provider remains disabled when its parent rerenders.
    rerender(
      <EditorRuntimeProvider {...props} timelineName="Public preview">
        <CaptureRuntime />
      </EditorRuntimeProvider>,
    );
    expect(createExtensionPersistenceService).not.toHaveBeenCalled();
    expect(getAllSettingsSnapshots).not.toHaveBeenCalled();
    expect(processManager.listStatuses).not.toHaveBeenCalled();
  });

  it('keeps live services enabled by default when mutation services are independently disabled', async () => {
    let runtime: ReturnType<typeof useVideoEditorRuntime> | null = null;
    function CaptureRuntime() {
      runtime = useVideoEditorRuntime();
      return null;
    }

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="mutation-disabled-live-enabled"
        enableMutationServices={false}
      >
        <CaptureRuntime />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => expect(runtime).not.toBeNull());
    expect(runtime!.liveDataRegistry).toBeDefined();
    expect(runtime!.livePermissionService).toBeDefined();
    expect(runtime!.commandRegistry).toBeUndefined();
    expect(runtime!.agentToolRegistry).toBeUndefined();
    expect(runtime!.renderExportEnabled).toBe(true);
  });

  it('keeps extension activation and persistence enabled by default when live services are independently disabled', async () => {
    const activate = vi.fn();
    const extension = defineExtension({
      manifest: {
        id: 'com.example.live-disabled-mutation-enabled' as never,
        version: '1.0.0',
        label: 'Mutation remains enabled',
        contributions: [],
      },
      activate,
    });
    const persistenceService = {
      scope: { userId: 'user-1', timelineId: 'live-disabled-timeline' },
      capabilities: { state: false, settings: false, proposals: false },
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      isDisposed: false,
    } as unknown as ExtensionPersistenceService;
    const createExtensionPersistenceService = vi.fn(() => persistenceService);
    const dataProvider = { createExtensionPersistenceService } as unknown as DataProvider;
    let runtime: ReturnType<typeof useVideoEditorRuntime> | null = null;
    function CaptureRuntime() {
      runtime = useVideoEditorRuntime();
      return null;
    }

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={dataProvider}
        timelineId="live-disabled-timeline"
        userId="user-1"
        extensions={[extension]}
        enableLiveServices={false}
      >
        <CaptureRuntime />
      </EditorRuntimeProvider>,
    );

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(createExtensionPersistenceService).toHaveBeenCalledTimes(1);
    expect(persistenceService.initialize).toHaveBeenCalledTimes(1);
    expect(runtime!.commandRegistry).toBeDefined();
    expect(runtime!.extensionRuntime?.extensions).toHaveLength(1);
    expect(runtime!.liveDataRegistry).toBeUndefined();
    expect(runtime!.livePermissionService).toBeUndefined();
  });
});


describe('EditorRuntimeProvider effect replay and Fast Refresh', () => {
  const sceneId = 'haus.astrid.liveScene';

  it('keeps the real scene renderer, import command, and sibling services usable after StrictMode replay, selection and disable/re-enable', async () => {
    const { threejsLiveEditorExtension, LIVE_SCENE_IMPORT_COMMAND_ID } = await import('@astrid/packs/rendering/ui/threejs-live-editor/extension');
    let latestRuntime!: ReturnType<typeof useVideoEditorRuntime>;
    let clips!: ReturnType<typeof useClipTypeRegistryContext>;
    const persistence = {
      capabilities: { proposals: false, state: false, settings: false },
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExtensionPersistenceService;
    const dataProvider = { createExtensionPersistenceService: vi.fn(() => persistence) } as unknown as DataProvider;
    function Capture() {
      latestRuntime = useVideoEditorRuntime();
      clips = useClipTypeRegistryContext();
      return null;
    }
    const node = (enabled = true) => <StrictMode><EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={dataProvider} timelineId="replay-scene" extensions={enabled ? [threejsLiveEditorExtension] : []}><Capture /></EditorRuntimeProvider></StrictMode>;
    const view = render(node());
    await act(async () => {});
    const firstClips = clips.registry;
    const firstLive = latestRuntime.liveDataRegistry!;
    const firstPermissions = latestRuntime.livePermissionService!;
    const firstView = latestRuntime.timelineViewStore!;
    const firstCommands = latestRuntime.commandRegistry!;
    const disposedClips = vi.spyOn(firstClips, 'dispose');
    const disposedLive = vi.spyOn(firstLive, 'dispose');
    expect(firstClips.resolve(sceneId)?.status).toBe('active');
    expect(firstCommands.getSnapshot().commands.filter(command => command.commandId === LIVE_SCENE_IMPORT_COMMAND_ID)).toHaveLength(1);
    expect(persistence.initialize).toHaveBeenCalledTimes(1);
    expect(persistence.dispose).not.toHaveBeenCalled();
    expect(firstLive.isDisposed).toBe(false);
    expect(firstPermissions.isDisposed).toBe(false);
    const notify = vi.fn();
    const subscription = firstView.subscribe(notify);
    act(() => firstView.publish({ selection: { selectedClipIds: new Set(['scene']), hasSelection: true } }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(firstView.getSnapshot().selection.selectedClipIds.has('scene')).toBe(true);
    view.rerender(node());
    expect(clips.registry).toBe(firstClips);
    expect(clips.snapshot.get(sceneId)?.status).toBe('active');
    expect(latestRuntime.timelineViewStore).toBe(firstView);
    view.rerender(node(false));
    expect(firstClips.resolve(sceneId)).toBeUndefined();
    expect(firstCommands.getSnapshot().commands.find(command => command.commandId === LIVE_SCENE_IMPORT_COMMAND_ID)).toBeUndefined();
    view.rerender(node());
    await act(async () => {});
    expect(firstClips.resolve(sceneId)?.status).toBe('active');
    expect(firstCommands.getSnapshot().commands.filter(command => command.commandId === LIVE_SCENE_IMPORT_COMMAND_ID)).toHaveLength(1);
    // Execute the actual command through the registry; cancel the native picker.
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () { this.dispatchEvent(new Event('cancel')); });
    await act(async () => { expect(await firstCommands.executeCommand(LIVE_SCENE_IMPORT_COMMAND_ID)).toBe(true); });
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    view.unmount();
    await act(async () => {});
    expect(firstClips.resolve(sceneId)).toBeUndefined();
    expect(firstCommands.getSnapshot().commands).toHaveLength(0);
    expect(disposedClips).toHaveBeenCalledTimes(1);
    expect(disposedLive).toHaveBeenCalledTimes(1);
    expect(firstPermissions.isDisposed).toBe(true);
    expect(persistence.dispose).toHaveBeenCalledTimes(1);
    subscription.dispose();
    // A true remount creates distinct owners; the old finalizer cannot remove them.
    render(<EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={{} as DataProvider} timelineId="replay-scene" extensions={[threejsLiveEditorExtension]}><Capture /></EditorRuntimeProvider>);
    await act(async () => {});
    expect(clips.registry).not.toBe(firstClips);
    expect(clips.registry.resolve(sceneId)?.status).toBe('active');
    expect(latestRuntime.liveDataRegistry).not.toBe(firstLive);
  });

  it('retains extension-owned live sources and the assembly data-kind binding without double activation during replay', async () => {
    let runtime!: ReturnType<typeof useVideoEditorRuntime>;
    let dataKinds!: ReturnType<typeof useDataKindRegistryContext>;
    const release = vi.fn();
    const activate = vi.fn((ctx: ExtensionContext) => {
      ctx.creative.sessions.registerSource({ id: 'replay-source', kind: 'generated', label: 'Replay source' });
      const lane = ctx.dataKinds.register('replay_kind', () => null);
      return { dispose() { release(); lane.dispose(); } };
    });
    const extension = defineExtension({
      manifest: { id: 'com.example.replay-siblings', version: '1.0.0', label: 'Replay siblings', contributions: [
        { id: 'replay-data', kind: 'dataKind', kindId: 'replay_kind', schemaRef: 'replay/v1', shape: 'interval', domain: 'source_seconds' },
        { id: 'replay-process', kind: 'process', spec: { id: 'replay-process-spec', label: 'Replay process', spawn: { command: 'not-executed' }, protocol: 'stdio-jsonrpc' } },
      ] }, activate,
    });
    function Capture() { runtime = useVideoEditorRuntime(); dataKinds = useDataKindRegistryContext(); return null; }
    const view = render(<StrictMode><EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={{} as DataProvider} timelineId="replay-siblings" extensions={[extension]}><Capture /></EditorRuntimeProvider></StrictMode>);
    await act(async () => {});
    expect(activate).toHaveBeenCalledTimes(1);
    expect(runtime.liveDataRegistry!.getSource('replay-source')?.id).toBe('replay-source');
    expect(dataKinds.snapshot.has('replay_kind')).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(runtime.processManager!.listStatuses()).toHaveLength(1);
    const disposeManager = vi.spyOn(runtime.processManager!, 'dispose');
    const registry = runtime.liveDataRegistry!;
    view.unmount();
    await act(async () => {});
    expect(release).toHaveBeenCalledTimes(1);
    expect(disposeManager).toHaveBeenCalledTimes(1);
    expect(registry.isDisposed).toBe(true);
    expect(registry.listSources()).toHaveLength(0);
    expect(dataKinds.registry.resolve('replay_kind')).toBeUndefined();
  });

  it('runs the extra host finalizer once after owned resource disposal, while keeping replay alive', async () => {
    let assembly!: ReturnType<typeof useEditorRuntimeAssembly>;
    const onUnmount = vi.fn(() => {
      expect(assembly.liveDataRegistryRef.current?.isDisposed).toBe(true);
      expect(assembly.commandRegistryRef.current?.diagnostics.some(diagnostic => diagnostic.code === 'command-registry/disposed')).toBe(true);
    });
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const view = renderHook(() => {
      assembly = useEditorRuntimeAssembly({ extensions: [], commandRegistryCallbacks: {}, enableLiveData: true, onUnmount });
      return assembly;
    }, { wrapper });
    await act(async () => {});
    expect(onUnmount).not.toHaveBeenCalled();
    expect(assembly.liveDataRegistryRef.current?.isDisposed).toBe(false);
    view.unmount();
    await act(async () => {});
    expect(onUnmount).toHaveBeenCalledTimes(1);
  });

  it('retains provider refs and real scene registration after an actual Fast Refresh family update', async () => {
    const { registerExportsForReactRefresh, validateRefreshBoundaryAndEnqueueUpdate } = await import('@test-react-refresh');
    const { threejsLiveEditorExtension, LIVE_SCENE_IMPORT_COMMAND_ID } = await import('@astrid/packs/rendering/ui/threejs-live-editor/extension');
    let latestRuntime!: ReturnType<typeof useVideoEditorRuntime>;
    let registry!: ReturnType<typeof useClipTypeRegistryContext>['registry'];
    function Capture() { latestRuntime = useVideoEditorRuntime(); registry = useClipTypeRegistryContext().registry; return null; }
    const persistence = {
      capabilities: { proposals: false, state: false, settings: false },
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExtensionPersistenceService;
    const dataProvider = { createExtensionPersistenceService: vi.fn(() => persistence) } as unknown as DataProvider;
    const family = 'editor-runtime-replay-regression';
    registerExportsForReactRefresh(family, { EditorRuntimeProvider });
    const view = render(<EditorRuntimeProvider astridElementHost={fixtureAstridElementHost} dataProvider={dataProvider} timelineId="refresh-scene" extensions={[threejsLiveEditorExtension]}><Capture /></EditorRuntimeProvider>);
    const before = registry;
    const live = latestRuntime.liveDataRegistry;
    const permission = latestRuntime.livePermissionService;
    const timelineView = latestRuntime.timelineViewStore;
    const warning = vi.spyOn(console, 'warn');
    function RefreshedEditorRuntimeProvider(props: Parameters<typeof EditorRuntimeProvider>[0]) { return EditorRuntimeProvider(props); }
    registerExportsForReactRefresh(family, { EditorRuntimeProvider: RefreshedEditorRuntimeProvider });
    await act(async () => {
      expect(validateRefreshBoundaryAndEnqueueUpdate(family, { EditorRuntimeProvider }, { EditorRuntimeProvider: RefreshedEditorRuntimeProvider })).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    expect(registry).toBe(before);
    expect(registry.resolve(sceneId)?.status).toBe('active');
    expect(latestRuntime.liveDataRegistry).toBe(live);
    expect(live?.isDisposed).toBe(false);
    expect(latestRuntime.livePermissionService).toBe(permission);
    expect(permission?.isDisposed).toBe(false);
    expect(latestRuntime.timelineViewStore).toBe(timelineView);
    expect(latestRuntime.commandRegistry!.getSnapshot().commands.filter(command => command.commandId === LIVE_SCENE_IMPORT_COMMAND_ID)).toHaveLength(1);
    expect(persistence.initialize).toHaveBeenCalledTimes(1);
    expect(persistence.dispose).not.toHaveBeenCalled();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () { this.dispatchEvent(new Event('cancel')); });
    await act(async () => { expect(await latestRuntime.commandRegistry!.executeCommand(LIVE_SCENE_IMPORT_COMMAND_ID)).toBe(true); });
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    expect(warning.mock.calls.some(args => String(args[0]).includes('called after dispose'))).toBe(false);
    warning.mockRestore();
    view.unmount();
    await act(async () => {});
    expect(before.resolve(sceneId)).toBeUndefined();
    expect(live?.isDisposed).toBe(true);
    expect(persistence.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('EditorRuntimeProvider settings snapshot gate', () => {
  const TRANSCRIPT_ID = 'transcript';
  const THREEJS_ID = 'haus.astrid.threejs-live-editor';
  const GATE_IDS = [TRANSCRIPT_ID, THREEJS_ID];

  function cleanGateLocalStorage(): void {
    for (const id of GATE_IDS) {
      const prefix = `astrid.ext.${id}.`;
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) keysToRemove.push(key);
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    }
  }

  function gateSnapshot(extensionId: string): ExtensionSettingsSnapshot {
    return {
      extensionId,
      schemaVersion: 2,
      values: { channels: ['left', 'right'], enableDebug: true },
      lastWrittenAt: '2026-10-20T00:00:00.000Z',
    };
  }

  function makeGateRepository(read: () => Promise<ExtensionSettingsSnapshot[]>) {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      isDisposed: false,
      putSettingsSnapshot: vi.fn(async () => undefined),
      getSettingsSnapshot: vi.fn(async () => null),
      getAllSettingsSnapshots: vi.fn(read),
      deleteSettingsSnapshot: vi.fn(async () => undefined),
    } as Partial<ExtensionStateRepository> as ExtensionStateRepository;
  }

  function makeGateExtension(
    extensionId: string,
    activations: string[],
    captured: Record<string, ExtensionSettingsService>,
  ) {
    return defineExtension({
      manifest: {
        id: extensionId as never,
        version: '1.0.0',
        label: extensionId,
        settingsSchemaVersion: 2,
        settingsDefaults: { theme: 'system' },
      },
      activate(ctx) {
        activations.push(extensionId);
        captured[extensionId] = ctx.services.settings;
        return { dispose() {} };
      },
    });
  }

  const sorted = (ids: string[]) => [...ids].sort();

  beforeEach(() => {
    cleanGateLocalStorage();
  });

  afterEach(() => {
    cleanGateLocalStorage();
  });

  it('activates extensions only after stored snapshots load, and honours them as initial settings', async () => {
    let resolveRead!: (snapshots: ExtensionSettingsSnapshot[]) => void;
    const repository = makeGateRepository(() => new Promise((resolve) => { resolveRead = resolve; }));
    const activations: string[] = [];
    const captured: Record<string, ExtensionSettingsService> = {};
    const extensions = [
      makeGateExtension(TRANSCRIPT_ID, activations, captured),
      makeGateExtension(THREEJS_ID, activations, captured),
    ];

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="gate-normal"
        userId="user-1"
        extensions={extensions}
        extensionStateRepository={repository}
      >
        <div>gate child</div>
      </EditorRuntimeProvider>,
    );

    await act(async () => { await Promise.resolve(); });
    expect(repository.getAllSettingsSnapshots).toHaveBeenCalledTimes(1);
    expect(activations).toEqual([]);

    await act(async () => {
      resolveRead([gateSnapshot(TRANSCRIPT_ID), gateSnapshot(THREEJS_ID)]);
    });

    await waitFor(() => {
      expect(sorted(activations)).toEqual(sorted([TRANSCRIPT_ID, THREEJS_ID]));
    });
    expect(captured[TRANSCRIPT_ID].get('channels')).toEqual(['left', 'right']);
    expect(captured[TRANSCRIPT_ID].get('enableDebug')).toBe(true);
    expect(captured[THREEJS_ID].get('channels')).toEqual(['left', 'right']);
    expect(captured[THREEJS_ID].get('enableDebug')).toBe(true);
    expect(captured[TRANSCRIPT_ID].get('theme')).toBe('system');
    expect(repository.putSettingsSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the editor children rendered and activates nothing while the read is pending', async () => {
    const repository = makeGateRepository(() => new Promise(() => {}));
    const activations: string[] = [];
    const captured: Record<string, ExtensionSettingsService> = {};
    const extensions = [makeGateExtension(TRANSCRIPT_ID, activations, captured)];

    const view = render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="gate-pending"
        userId="user-1"
        extensions={extensions}
        extensionStateRepository={repository}
      >
        <div>gate child</div>
      </EditorRuntimeProvider>,
    );

    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('gate child')).toBeTruthy();
    expect(repository.getAllSettingsSnapshots).toHaveBeenCalledTimes(1);
    expect(activations).toEqual([]);
    view.unmount();
  });

  it('activates without clobbering when the snapshot read rejects, and settings still work locally', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repository = makeGateRepository(() => Promise.reject(new Error('read failed')));
    const activations: string[] = [];
    const captured: Record<string, ExtensionSettingsService> = {};
    const extensions = [
      makeGateExtension(TRANSCRIPT_ID, activations, captured),
      makeGateExtension(THREEJS_ID, activations, captured),
    ];

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="gate-reject"
        userId="user-1"
        extensions={extensions}
        extensionStateRepository={repository}
      >
        <div>gate child</div>
      </EditorRuntimeProvider>,
    );

    await waitFor(() => {
      expect(sorted(activations)).toEqual(sorted([TRANSCRIPT_ID, THREEJS_ID]));
    });
    expect(captured[TRANSCRIPT_ID].get('channels')).toBeUndefined();
    expect(captured[TRANSCRIPT_ID].get('theme')).toBe('system');

    act(() => {
      captured[TRANSCRIPT_ID].set('theme', 'dark');
    });
    expect(captured[TRANSCRIPT_ID].get('theme')).toBe('dark');

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(repository.putSettingsSnapshot).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((args) => String(args[0]).includes('Stored settings unavailable'))).toBe(true);
    warn.mockRestore();
  });

  it('stops waiting after the bound, activates without a repository write, and ignores a late read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      let resolveRead!: (snapshots: ExtensionSettingsSnapshot[]) => void;
      const repository = makeGateRepository(() => new Promise((resolve) => { resolveRead = resolve; }));
      const activations: string[] = [];
      const captured: Record<string, ExtensionSettingsService> = {};
      const extensions = [makeGateExtension(TRANSCRIPT_ID, activations, captured)];

      const view = render(
        <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
          dataProvider={{} as DataProvider}
          timelineId="gate-timeout"
          userId="user-1"
          extensions={extensions}
          extensionStateRepository={repository}
        >
          <div>gate child</div>
        </EditorRuntimeProvider>,
      );

      await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
      expect(activations).toEqual([]);

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(activations).toEqual([TRANSCRIPT_ID]);
      expect(repository.putSettingsSnapshot).not.toHaveBeenCalled();

      await act(async () => {
        resolveRead([gateSnapshot(TRANSCRIPT_ID)]);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(activations).toEqual([TRANSCRIPT_ID]);
      expect(captured[TRANSCRIPT_ID].get('channels')).toBeUndefined();
      expect(repository.putSettingsSnapshot).not.toHaveBeenCalled();

      view.unmount();
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('activates immediately when no repository is bound', async () => {
    const activations: string[] = [];
    const captured: Record<string, ExtensionSettingsService> = {};
    const extensions = [
      makeGateExtension(TRANSCRIPT_ID, activations, captured),
      makeGateExtension(THREEJS_ID, activations, captured),
    ];

    render(
      <EditorRuntimeProvider astridElementHost={fixtureAstridElementHost}
        dataProvider={{} as DataProvider}
        timelineId="gate-no-repo"
        userId="user-1"
        extensions={extensions}
      >
        <div>gate child</div>
      </EditorRuntimeProvider>,
    );

    await act(async () => {});
    expect(sorted(activations)).toEqual(sorted([TRANSCRIPT_ID, THREEJS_ID]));
    expect(captured[TRANSCRIPT_ID].get('theme')).toBe('system');
    act(() => {
      captured[TRANSCRIPT_ID].set('theme', 'light');
    });
    expect(captured[TRANSCRIPT_ID].get('theme')).toBe('light');
  });
});
