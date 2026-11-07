import { onExtensionContextCommit } from '../runtime/extensionActivationTransaction';
/**
 * Shared runtime assembly for the video editor's two host providers:
 * `VideoEditorProvider` (Astrid App shell) and `EditorRuntimeProvider`
 * (embed/browser host). Internal host-only wiring — not part of the
 * supported public SDK surface.
 *
 * The assembly is split in three pieces, matching how each provider
 * consumes it:
 *
 *  - `useEditorRuntimeAssembly` — outer half (above `VideoEditorRuntimeProvider`):
 *    per-mount registries (command, agent tool, renderer, optional live
 *    data), the extension lifecycle host, the diagnostic collection, and
 *    the process manager with its attach-record/status plumbing.
 *  - `useEditorRuntimeSync` — inner half (below `VideoEditorRuntimeProvider`):
 *    the timeline state/store, timeline reader, proposal runtime, agent
 *    tool invocation service, effect/sequence catalogs, and the extension
 *    synchronize effect that builds per-extension contexts.
 *  - `EditorRuntimeScaffold` — the registry-provider JSX tree plus the
 *    per-registry lifecycle bridges (effect/transition/shader/clip-type).
 *
 * Genuine host differences remain explicit parameters: the command-registry
 * feedback channel (toasts vs. console), live data + shader registries and
 * settings persistence (embed host only), the proposal-persistence strategy
 * (app shell resolves the bridge synchronously and retries creation from
 * effects; the embed host gates on an async fail-closed `initialize()`),
 * and extra host-owned unmount disposal. Everything else is owned here once.
 */
import { useOwnedResourceDisposal } from '@/tools/video-editor/hooks/useOwnedResourceDisposal';
import { subscribeToDataKindProjectionCleanup } from './dataKindProjectionCleanup.ts';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { createTimelineReader } from '@/tools/video-editor/lib/timeline-reader.ts';
import type { PreparedShotComposition } from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import { createEditorAssetSurface } from '@/tools/video-editor/runtime/editorAssetSurface.ts';
import { playedAssetRegistry } from '@/tools/video-editor/lib/timeline-shot-summaries.ts';
import {
  createTimelineViewStore,
  type TimelineViewStoreApi,
} from '@/tools/video-editor/lib/timeline-view-store.ts';
import {
  createProposalRuntime,
  type ProposalPersistenceProvider,
} from '@/tools/video-editor/lib/proposal-runtime.ts';
import { useEffectRegistry } from '@/tools/video-editor/hooks/useEffectRegistry.ts';
import {
  EffectRegistryProvider,
  useEffectRegistryContext,
} from '@/tools/video-editor/effects/registry/EffectRegistryContext.tsx';
import {
  EffectCatalogProvider,
  useResolvedEffectCatalog,
  type VideoEditorEffectCatalog,
} from '@/tools/video-editor/hooks/useEffectResources.ts';
import {
  SequenceComponentCatalogProvider,
  useResolvedSequenceComponentCatalog,
  type VideoEditorSequenceComponentCatalog,
} from '@/tools/video-editor/hooks/useSequenceResources.ts';
import { SequenceComponentRegistryProvider } from '@/tools/video-editor/sequences/SequenceComponentRegistryContext.tsx';
import { TimelineStoreProvider, usePublishTimelineReader } from '@/tools/video-editor/hooks/timelineStore.ts';
import { useTimelineState } from '@/tools/video-editor/hooks/useTimelineState.ts';
import { PUBLIC_TIMELINE_SERVICE_HOOKS, type TimelineHostServiceHooks } from '@/tools/video-editor/runtime/timelineHostServiceHooks.ts';
import type { UseTimelineStateResult } from '@/tools/video-editor/hooks/useTimelineState.types.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import {
  normalizeExtensionRuntime,
  type ExtensionRuntime,
  type PackageStateInventoryEntry,
  type VideoEditorExtensionRuntimeConfig,
} from '@/tools/video-editor/runtime/extensionSurface.ts';
import {
  createExtensionDiagnosticsService,
  createExtensionLifecycleHost,
  type ExtensionLifecycleHost,
} from '@/tools/video-editor/runtime/extensionLifecycle.ts';
import {
  createDiagnosticCollection,
  type AstridExtension,
  type CommandContribution,
  type KeybindingContribution,
  type ContextMenuItemContribution,
  type ExtensionCommandService,
  type DiagnosticCollection,
  type CreativeContext,
  type AgentToolContribution,
  type AgentToolRegistrationService,
  type AgentToolHandler,
  type ShaderRegistrationService,
  type CreateExtensionSettingsServiceOptions,
  type DataKindRegistrationService,
  type SettingsPersistenceError,
  type ProcessSpawnConfig,
  type ProjectObjectStorage,
} from '@astrid/editor-sdk';
import { createExtensionContext } from '@/tools/video-editor/runtime/extensionContextFactory';
import { LiveSceneOperationPort } from '@/tools/video-editor/runtime/liveSceneOperationPort';
import { createRendererRegistry } from '@/tools/video-editor/runtime/extensionRendererRegistry';
import {
  createExtensionUiService,
  resolveRegisteredRenderers,
} from '@/tools/video-editor/runtime/extensionRenderSurface';
import {
  createCommandRegistry,
  type CommandRegistry,
  type CommandRegistryCallbacks,
} from '@/tools/video-editor/runtime/commandRegistry.ts';
import { createEffectRegistrationService } from '@/tools/video-editor/runtime/effectRegistrationService.ts';
import type { EffectRegistry } from '@/tools/video-editor/effects/registry/types.ts';
import { createTransitionRegistrationService } from '@/tools/video-editor/runtime/transitionRegistrationService.ts';
import type { TransitionRegistry } from '@/tools/video-editor/transitions/registry/types.ts';
import { createShaderRegistrationService } from '@/tools/video-editor/runtime/shaderRegistrationService.ts';
import type { ShaderEffectRegistry } from '@/tools/video-editor/shaders/registry/types.ts';
import { createClipTypeRegistrationService } from '@/tools/video-editor/runtime/clipTypeRegistrationService.ts';
import type { ClipTypeRegistry } from '@/tools/video-editor/clip-types/ClipTypeRegistry.ts';
import { createDataKindRegistrationService } from '@/tools/video-editor/runtime/dataKindRegistrationService.ts';
import {
  createDataKindRegistry,
  type DataKindRegistry,
} from '@/tools/video-editor/data-kinds/DataKindRegistry.ts';
import {
  DataKindRegistryProvider,
  useDataKindRegistryContext,
} from '@/tools/video-editor/data-kinds/DataKindRegistryContext.tsx';
import {
  createAgentToolRegistry,
  type AgentToolRegistry,
} from '@/tools/video-editor/runtime/agentToolRegistry.ts';
import {
  createAgentToolInvocationService,
  type AgentToolInvocationService,
} from '@/tools/video-editor/runtime/agentToolInvocationService.ts';
import type { ProcessStatus } from '@/sdk/video/families/processes';
import {
  removeExtensionDiagnosticsFromCollection,
  syncExtensionDiagnosticsToCollection,
  syncLiveDiagnosticsToCollection,
} from '@/tools/video-editor/runtime/diagnosticCollectionSync.ts';
import {
  createLiveDataRegistry,
  type LiveDataRegistry,
} from '@/tools/video-editor/runtime/liveDataRegistry.ts';
import {
  createProcessManager,
  type ProcessManager,
} from '@/tools/video-editor/runtime/processes/ProcessManager.ts';
import type { ProcessResultAttachRecord } from '@/tools/video-editor/runtime/composition/processResultAttach.ts';
import type {
  ExtensionSettingsSnapshot,
  ExtensionStateRepository,
} from '@/tools/video-editor/runtime/extensionStateRepository';
import type { ExtensionSettingsNotificationRegistry } from '@/tools/video-editor/runtime/extensionSettingsNotification';
import {
  TransitionRegistryProvider,
  useTransitionRegistryContext,
} from '@/tools/video-editor/transitions/registry/index.ts';
import {
  ClipTypeRegistryProvider,
  useClipTypeRegistryContext,
} from '@/tools/video-editor/clip-types/index.ts';
import {
  ShaderEffectRegistryProvider,
  useShaderEffectRegistryContext,
} from '@/tools/video-editor/shaders/registry/index.ts';

type RendererRegistry = ReturnType<typeof createRendererRegistry>;

// ---------------------------------------------------------------------------
// Live sessions + settings persistence helpers (embed-host subsystems, owned
// here because the shared synchronize effect wires them when present)
// ---------------------------------------------------------------------------

function createExtensionLiveSessions(
  registry: LiveDataRegistry,
  extensionId: string,
): CreativeContext['sessions'] {
  return {
    registerSource(source) {
      return registry.registerSourceWithOwner(source, extensionId);
    },
    getSource(sourceId) {
      return registry.getSource(sourceId);
    },
    listSources() {
      return registry.listSources();
    },
    openChannel(sourceId, kind, metadata) {
      return registry.openChannel(sourceId, kind, metadata);
    },
    closeChannel(channelId) {
      registry.closeChannel(channelId);
    },
    getChannelMetadata(channelId) {
      return registry.getChannelMetadata(channelId);
    },
    pushSample(channelId, frame) {
      registry.pushSample(channelId, frame);
    },
    subscribeSamples(channelId, listener) {
      return registry.subscribeSamples(channelId, listener);
    },
    bake(selection) {
      return registry.bake(selection);
    },
    removeLiveBindings(sourceId) {
      registry.removeLiveBindings(sourceId);
    },
    resolveBinding(bindingId) {
      return registry.resolveBinding(bindingId);
    },
    getBindingMetadata() {
      return registry.getBindingMetadata();
    },
    applySteeringDecision(decision) {
      registry.applySteeringDecision(decision);
    },
    getDiagnostics(sourceId) {
      return registry.getDiagnostics(sourceId);
    },
  };
}

function publishSettingsPersistenceDiagnostic(
  diagnosticCollection: DiagnosticCollection | null | undefined,
  event: SettingsPersistenceError,
): void {
  diagnosticCollection?.publish({
    id: `settings-persistence:${event.extensionId}:${event.revision}`,
    extensionId: event.extensionId,
    severity: 'warning',
    code: 'extension.settings.persistence_failed',
    message: `Failed to persist extension settings: ${event.message}`,
    source: 'provider',
    detail: {
      source: 'settings-persistence',
      operation: event.operation,
      revision: event.revision,
      message: event.message,
      ...(event.key !== undefined ? { key: event.key } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Outer half: per-mount registries, lifecycle host, process manager
// ---------------------------------------------------------------------------

export interface UseEditorRuntimeAssemblyOptions {
  extensions?: readonly AstridExtension[];
  documents?: import('@/sdk/context.ts').ProjectDocumentSurface;
  loadAssetProfile?: (assetKey: string) => Promise<import('@/tools/video-editor/data/AssetResolver.ts').AssetProfile | null>;
  /** Package-state inventory entries propagated from the loader. */
  packageStateEntries?: readonly PackageStateInventoryEntry[];
  /** Host-provided process manager override. When absent, a default
   *  ProcessManager is created from the extension runtime's declared process
   *  specs. */
  hostProcessManager?: ProcessManager;
  /** Suppress extension activation and their mutation-capable host services. */
  enableMutationServices?: boolean;
  /** Host feedback channel for command-registry violations (app shell:
   *  toasts; embed host: console). Applied once on mount. */
  commandRegistryCallbacks: CommandRegistryCallbacks;
  /** Create a per-mount live data registry, thread it into the
   *  lifecycle host + agent tool registry, and dispose it on unmount
   *  (embed host only). Read on first render. */
  enableLiveData?: boolean;
  /** Render the shader registry provider + lifecycle bridge in the
   *  scaffold (embed host only). */
  enableShaderRegistry?: boolean;
  /** Extra host-owned disposal run on unmount, after the lifecycle host and
   *  the assembly-owned live data registry are disposed. */
  onUnmount?: () => void;
}

export interface EditorRuntimeAssembly {
  documents?: import('@/sdk/context.ts').ProjectDocumentSurface;
  loadAssetProfile?: (assetKey: string) => Promise<import('@/tools/video-editor/data/AssetResolver.ts').AssetProfile | null>;
  shellRootRef: MutableRefObject<HTMLElement | null>;
  agentSelectionOwner: symbol;
  extensionRuntime: ExtensionRuntime;
  /** Extensions config with registered slot renderers resolved (reactive). */
  resolvedExtensionsConfig: VideoEditorExtensionRuntimeConfig;
  lifecycleHostRef: MutableRefObject<ExtensionLifecycleHost | null>;
  commandRegistryRef: MutableRefObject<CommandRegistry | null>;
  effectRegistryRef: MutableRefObject<EffectRegistry | null>;
  transitionRegistryRef: MutableRefObject<TransitionRegistry | null>;
  shaderRegistryRef: MutableRefObject<ShaderEffectRegistry | null>;
  clipTypeRegistryRef: MutableRefObject<ClipTypeRegistry | null>;
  /** dataKind V1: assembly-owned data-kind registry (single bind path). */
  dataKindRegistryRef: MutableRefObject<DataKindRegistry | null>;
  agentToolRegistryRef: MutableRefObject<AgentToolRegistry | null>;
  liveSceneOperationPort: LiveSceneOperationPort;
  rendererRegistryRef: MutableRefObject<RendererRegistry>;
  liveDataRegistryRef: MutableRefObject<LiveDataRegistry | null>;
  diagnosticCollectionRef: MutableRefObject<DiagnosticCollection | null>;
  /** Provider-owned TimelineViewStore (one per mount) for `ctx.creative.timelineView`. */
  timelineViewStoreRef: MutableRefObject<TimelineViewStoreApi | null>;
  processManagerRef: MutableRefObject<ProcessManager | null>;
  /** Read-only snapshot of process statuses (reactive on attach records). */
  processStatuses: readonly ProcessStatus[] | undefined;
  /** Host-session scoped process result attach records (memory only). */
  processResultAttachRecords: readonly ProcessResultAttachRecord[];
  recordProcessResultAttach: (record: ProcessResultAttachRecord) => void;
  /** Recovery key facade backed by ExtensionLifecycleHost. */
  getRecoveryKey: (extensionId: string) => string;
  incrementRecoveryKey: (extensionId: string) => string;
  /** Whether the scaffold renders the shader registry layer. */
  shaderRegistryEnabled: boolean;
}

export function useEditorRuntimeAssembly({
  extensions,
  documents,
  loadAssetProfile,
  packageStateEntries,
  hostProcessManager,
  enableMutationServices = true,
  commandRegistryCallbacks,
  enableLiveData = false,
  enableShaderRegistry = false,
  onUnmount,
}: UseEditorRuntimeAssemblyOptions): EditorRuntimeAssembly {
  const shellRootRef = useRef<HTMLElement | null>(null);
  const [agentSelectionOwner] = useState(() => Symbol('video-editor-instance'));

  // ---- extension normalization ---------------------------------------------
  const extensionRuntime = useMemo<ExtensionRuntime>(
    () => normalizeExtensionRuntime(
      enableMutationServices ? extensions ?? [] : [],
      enableMutationServices ? packageStateEntries : undefined,
    ),
    [enableMutationServices, extensions, packageStateEntries],
  );

  // ---- live data registry (one per provider mount; embed host only) ----
  const liveDataRegistryRef = useRef<LiveDataRegistry | null>(null);
  if (enableLiveData && !liveDataRegistryRef.current) {
    liveDataRegistryRef.current = createLiveDataRegistry();
  }

  // ---- extension lifecycle host --------------------------------------------
  const lifecycleHostRef = useRef<ExtensionLifecycleHost | null>(null);
  if (!lifecycleHostRef.current) {
    lifecycleHostRef.current = createExtensionLifecycleHost(
      liveDataRegistryRef.current ?? undefined,
    );
  }

  // ---- command registry (one per provider mount) -----------------------
  const commandRegistryRef = useRef<CommandRegistry | null>(null);
  if (enableMutationServices && !commandRegistryRef.current) {
    commandRegistryRef.current = createCommandRegistry();
  } else if (!enableMutationServices) {
    commandRegistryRef.current = null;
  }

  // ---- dataKind V1: data-kind registry (one per provider mount) ------------
  const dataKindRegistryRef = useRef<DataKindRegistry | null>(null);
  if (!dataKindRegistryRef.current) {
    dataKindRegistryRef.current = createDataKindRegistry();
  }

  // ---- registry refs (registries are created by their
  //      providers in the scaffold, exposed via context, and stored here for
  //      the synchronize effect) ---------------------------------------------
  const effectRegistryRef = useRef<EffectRegistry | null>(null);
  const transitionRegistryRef = useRef<TransitionRegistry | null>(null);
  const shaderRegistryRef = useRef<ShaderEffectRegistry | null>(null);
  const clipTypeRegistryRef = useRef<ClipTypeRegistry | null>(null);

  const rendererRegistryRef = useRef(createRendererRegistry());
  const [rendererRegistrySnapshot, setRendererRegistrySnapshot] = useState(
    () => rendererRegistryRef.current.getSnapshot(),
  );

  // ---- agent tool registry (one per provider mount) -------------------
  const agentToolRegistryRef = useRef<AgentToolRegistry | null>(null);
  const [liveSceneOperationPort] = useState(() => new LiveSceneOperationPort());
  useEffect(() => {
    liveSceneOperationPort.setAvailable(enableMutationServices);
    return () => liveSceneOperationPort.setAvailable(false);
  }, [enableMutationServices, liveSceneOperationPort]);
  if (enableMutationServices && !agentToolRegistryRef.current) {
    agentToolRegistryRef.current = liveDataRegistryRef.current
      ? createAgentToolRegistry({ liveDataRegistry: liveDataRegistryRef.current })
      : createAgentToolRegistry();
  } else if (!enableMutationServices) {
    agentToolRegistryRef.current = null;
  }

  const diagnosticCollectionRef = useRef<DiagnosticCollection | null>(null);
  if (!diagnosticCollectionRef.current) {
    diagnosticCollectionRef.current = createDiagnosticCollection();
  }

  // ---- TimelineViewStore (one per provider mount) --------------------------
  // The provider-owned, renderer-independent timeline observation primitive
  // exposed as `ctx.creative.timelineView`. The canvas publishes layout and
  // playback state into it regardless of whether the overlay host is
  // enabled; extensions read it from commands/keybindings without a mounted
  // renderer. Kept in a ref (never recreated) so both the creative context
  // and the canvas share one identity per provider.
  const timelineViewStoreRef = useRef<TimelineViewStoreApi | null>(null);
  if (!timelineViewStoreRef.current) {
    timelineViewStoreRef.current = createTimelineViewStore();
  }

  useEffect(() => {
    const registry = rendererRegistryRef.current;
    const handle = registry.subscribe(setRendererRegistrySnapshot);
    setRendererRegistrySnapshot(registry.getSnapshot());
    return () => handle.dispose();
  }, []);

  // ---- Process manager (host override or default from declared specs) --
  const processManagerRef = useRef<ProcessManager | null>(null);
  if (!enableMutationServices) {
    processManagerRef.current = null;
  } else if (hostProcessManager) {
    processManagerRef.current = hostProcessManager;
  } else if (!processManagerRef.current) {
    const declaredProcessSpecs = extensionRuntime.processes.map((d) => d.spec);
    processManagerRef.current = declaredProcessSpecs.length > 0
      ? createProcessManager({ processes: declaredProcessSpecs })
      : null;
  }

  // ---- Host-session scoped process result attach records (memory only) -
  const [processResultAttachRecords, setProcessResultAttachRecords] = useState<
    readonly ProcessResultAttachRecord[]
  >([]);
  const recordProcessResultAttach = useCallback(
    (record: ProcessResultAttachRecord) => {
      setProcessResultAttachRecords((prev) => [...prev, record]);
    },
    [],
  );

  // ---- Derived process statuses snapshot (reactive) ----
  const processManager = processManagerRef.current;
  const processStatuses = useMemo<readonly ProcessStatus[] | undefined>(() => {
    if (!processManager) return undefined;
    // Recompute when attach records change to pick up status changes after execute.
    void processResultAttachRecords;
    return processManager.listStatuses();
  }, [processManager, processResultAttachRecords]);

  // Dispose process manager on unmount (only when provider-owned)
  useOwnedResourceDisposal(
    hostProcessManager ? null : processManagerRef.current,
    (manager) => { void manager?.dispose(); },
  );

  // Wire registry callbacks to the host feedback channel (applied once on
  // mount, matching the previous per-provider `[]`-dep effects).
  const commandRegistryCallbacksRef = useRef(commandRegistryCallbacks);
  commandRegistryCallbacksRef.current = commandRegistryCallbacks;
  useEffect(() => {
    const registry = commandRegistryRef.current;
    if (!registry) return;
    registry.setCallbacks(commandRegistryCallbacksRef.current);
  }, [enableMutationServices]);

  // Keep lifecycle registrations and provider resources together through React
  // replay. A real unmount finalizes the captured owner after replay ends.
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;
  const [ownedResources] = useState(() => ({
    host: lifecycleHostRef.current,
    dataKinds: dataKindRegistryRef.current,
    timelineView: timelineViewStoreRef.current,
    renderers: rendererRegistryRef.current,
  }));
  useOwnedResourceDisposal(ownedResources, (owned) => {
    const extensionIds = [...(owned.host?.lifecycles.keys() ?? [])];
    owned.host?.disposeAll();
    // React has already unsubscribed the scaffold's owner-cleanup bridges.
    // Finish the host-only cleanup they normally perform on extension removal.
    for (const extensionId of extensionIds) {
      owned.renderers.unregisterAll(extensionId);
      // Closing an editor releases resources, never durable user settings.
    }
    owned.dataKinds?.dispose();
    owned.timelineView?.dispose();
  });

  useOwnedResourceDisposal(liveDataRegistryRef.current, (registry) => registry?.dispose());
  useOwnedResourceDisposal(commandRegistryRef.current, (registry) => registry?.dispose());
  useOwnedResourceDisposal(agentToolRegistryRef.current, (registry) => registry?.dispose());
  // Keep the host's extra finalizer after all assembly-owned resource cleanup.
  useOwnedResourceDisposal(onUnmountRef, (callback) => callback.current?.());

  const previousResolvedConfig = useRef<VideoEditorExtensionRuntimeConfig>();
  const resolvedExtensionsConfig = useMemo(
    () => resolveRegisteredRenderers(extensionRuntime, rendererRegistrySnapshot, previousResolvedConfig.current),
    [extensionRuntime, rendererRegistrySnapshot],
  );
  useLayoutEffect(() => {
    previousResolvedConfig.current = resolvedExtensionsConfig;
  }, [resolvedExtensionsConfig]);

  const getRecoveryKey = useCallback(
    (extensionId: string) =>
      lifecycleHostRef.current?.getRecoveryKey(extensionId) ?? '0',
    [],
  );
  const incrementRecoveryKey = useCallback(
    (extensionId: string) =>
      lifecycleHostRef.current?.incrementRecoveryKey(extensionId) ?? '0',
    [],
  );

  return {
    documents,
    loadAssetProfile,
    shellRootRef,
    agentSelectionOwner,
    extensionRuntime,
    resolvedExtensionsConfig,
    lifecycleHostRef,
    commandRegistryRef,
    effectRegistryRef,
    transitionRegistryRef,
    shaderRegistryRef,
    clipTypeRegistryRef,
    dataKindRegistryRef,
    agentToolRegistryRef,
    liveSceneOperationPort,
    rendererRegistryRef,
    liveDataRegistryRef,
    diagnosticCollectionRef,
    timelineViewStoreRef,
    processManagerRef,
    processStatuses,
    processResultAttachRecords,
    recordProcessResultAttach,
    getRecoveryKey,
    incrementRecoveryKey,
    shaderRegistryEnabled: enableShaderRegistry,
  };
}

// ---------------------------------------------------------------------------
// Inner half: timeline state, proposal runtime, extension synchronization
// ---------------------------------------------------------------------------

export interface UseEditorRuntimeSyncOptions {
  assembly: EditorRuntimeAssembly;
  /** Timeline project scope for the reader (app shell: host project id;
   *  embed host: null). */
  projectId: string | null;
  /** Timeline identifier for the reader's document scope. */
  timelineId: string | null;
  /** Active provider's optional project-bound immutable object port. */
  projectObjects?: ProjectObjectStorage;
  /** User the effect/sequence catalogs and legacy effects query resolve
   *  against. */
  /** Host-specific gating for the legacy effects query (the embed host also
   *  requires a user id). */
  effectsQueryEnabled: boolean;
  effectsQueryData?: Array<{ slug: string; code: string }>;
  timelineServices?: TimelineHostServiceHooks;
  effectCatalog?: VideoEditorEffectCatalog | null;
  sequenceComponentCatalog?: VideoEditorSequenceComponentCatalog | null;
  /**
   * Proposal persistence bridge.
   * - `undefined`: not ready yet — ProposalRuntime creation stays gated
   *   (the embed host's fail-closed `initialize()` contract).
   * - `null`: no persistence — ProposalRuntime is created without it.
   */
  proposalPersistenceProvider: ProposalPersistenceProvider | null | undefined;
  /** Suppress creation and attachment of mutation-backed services. */
  enableMutationServices?: boolean;
  /**
   * App-shell strategy: additionally retry ProposalRuntime / agent tool
   * invocation service creation from post-commit effects (the embed host
   * creates them from renders only). Must be constant for a mount.
   */
  eagerProposalRetry?: boolean;
  /** repository-backed extension settings persistence (embed host only). */
  settings?: {
    repository: ExtensionStateRepository | null | undefined;
    snapshotsRef: MutableRefObject<Record<string, ExtensionSettingsSnapshot> | null>;
    /** False while stored snapshots are still loading; extensions wait so their first write cannot replace them. */
    snapshotsReady?: boolean;
    /** True when the read failed or timed out: no repository is bound, so the unread snapshot is never overwritten. */
    snapshotsUnavailable?: boolean;
    notificationRegistryRef: MutableRefObject<ExtensionSettingsNotificationRegistry | null>;
  };
  /** Synchronously seed a host-owned timeline projection before provider I/O. */
  initialTimelineData?: TimelineData;
  /** Live getter for the shot composition the timeline plays; feeds the
   *  reader's `shots` so extensions can read what each placed shot contains. */
  shotComposition?: () => PreparedShotComposition | null;
}

export interface EditorRuntimeSync {
  store: UseTimelineStateResult['store'];
  editor: UseTimelineStateResult['editor'];
  transcriptHost?: import('../lib/transcript-panel-host.ts').TranscriptPanelHost;
  chrome: UseTimelineStateResult['chrome'];
  activeExtensionIds: ReadonlySet<string>;
  effectsQueryData: Array<{ slug: string; code: string }> | undefined;
  effectResources: VideoEditorEffectCatalog;
  sequenceComponentResources: VideoEditorSequenceComponentCatalog;
}
export function useEditorRuntimeSync({
  assembly,
  projectId,
  timelineId,
  projectObjects,
  effectsQueryData,
  timelineServices = PUBLIC_TIMELINE_SERVICE_HOOKS,
  effectCatalog,
  sequenceComponentCatalog,
  proposalPersistenceProvider,
  enableMutationServices = true,
  eagerProposalRetry = false,
  settings,
  initialTimelineData,
  shotComposition,
}: UseEditorRuntimeSyncOptions): EditorRuntimeSync {
  const {
    documents,
    loadAssetProfile,
    extensionRuntime,
    lifecycleHostRef,
    commandRegistryRef,
    effectRegistryRef,
    transitionRegistryRef,
    shaderRegistryRef,
    clipTypeRegistryRef,
    dataKindRegistryRef,
    agentToolRegistryRef,
    rendererRegistryRef,
    liveDataRegistryRef,
    timelineViewStoreRef,
  } = assembly;
  const settingsRepository = enableMutationServices ? settings?.repository ?? null : null;
  const settingsSnapshotsRef = enableMutationServices ? settings?.snapshotsRef : undefined;
  const settingsSnapshotsReady = settings?.snapshotsReady ?? true;
  const settingsSnapshotsUnavailable = settings?.snapshotsUnavailable ?? false;
  const settingsNotificationRegistryRef = enableMutationServices
    ? settings?.notificationRegistryRef
    : undefined;

  const effectResources = useResolvedEffectCatalog(effectCatalog);
  const sequenceComponentResources = useResolvedSequenceComponentCatalog(sequenceComponentCatalog);

  const { store, editor, chrome, editorOps } = useTimelineState(timelineServices, initialTimelineData);
  const diagnosticCollection = useVideoEditorRuntime().diagnosticCollection;
  const activeExtensionIds = useMemo(
    () => new Set(extensionRuntime.extensions.map((ext) => ext.manifest.id as string)),
    [extensionRuntime.extensions],
  );
  const priorExtensionsRef = useRef(extensionRuntime.extensions);
  useEffect(() => {
    const previousExtensions = priorExtensionsRef.current;
    const currentExtensions = extensionRuntime.extensions;
    priorExtensionsRef.current = currentExtensions;
    const host = lifecycleHostRef.current;
    if (!host) return;
    const projectionHandle = subscribeToDataKindProjectionCleanup(
      host,
      store.getState().dataKindItemsHost,
      previousExtensions,
      currentExtensions,
    );
    const pendingWorkHandle = host.onLifecycleDisposed((extensionId) => {
      store.getState().pendingWorkRegistry?.clear(extensionId);
    });
    return () => { projectionHandle.dispose(); pendingWorkHandle.dispose(); };
  }, [extensionRuntime.extensions, lifecycleHostRef, store]);

  // ---- live creative context for extensions ----------------------------
  // Create stable TimelineReader from the data ref (always reads latest data).
  // The canonical version comes from the store's ack-tracked field (outside
  // the data object), so snapshot().baseVersion reflects receipt-only acks
  // without those acks ever committing a new data object.
  const timelineReader = useMemo(
    () =>
      createTimelineReader({
        data: () => {
          const data = store.getState().data.data;
          if (!data) {
            throw new Error('Timeline data is not ready.');
          }
          return data;
        },
        subscribeData: (listener) => {
          let previous = store.getState().data.data;
          return store.subscribe(() => {
            const next = store.getState().data.data;
            if (next !== previous) {
              previous = next;
              listener();
            }
          });
        },
        configVersion: () => store.getState().configVersion,
        projectId,
        timelineId,
        extensionRequirements: extensionRuntime.requirements,
        shotComposition,
      }),
    [store, projectId, timelineId, extensionRuntime.requirements, shotComposition],
  );
  usePublishTimelineReader(store, timelineReader);
  assembly.liveSceneOperationPort.setReader(timelineReader);

  // One ProposalRuntime per provider mount, stable for the provider lifetime.
  // Creation is gated on the persistence bridge being resolved (the app shell
  // resolves it synchronously; the embed host keeps it `undefined` until its
  // fail-closed initialize() succeeds).
  const proposalRuntimeRef = useRef<ReturnType<typeof createProposalRuntime> | null>(null);
  if (!enableMutationServices) {
    proposalRuntimeRef.current = null;
  } else if (!proposalRuntimeRef.current && proposalPersistenceProvider !== undefined) {
    const ops = store.getState().timelineOps;
    if (ops) {
      proposalRuntimeRef.current = createProposalRuntime({
        timelineOps: ops,
        reader: timelineReader,
        persistenceProvider: proposalPersistenceProvider ?? undefined,
      });
      store.getState().syncSlices({ proposalRuntime: proposalRuntimeRef.current });
    }
  }

  // App-shell strategy: when timelineOps first becomes available after
  // commit, create the ProposalRuntime if not yet created.
  useEffect(() => {
    if (!enableMutationServices || !eagerProposalRetry) return;
    if (proposalRuntimeRef.current) return;
    const ops = store.getState().timelineOps;
    if (ops) {
      proposalRuntimeRef.current = createProposalRuntime({
        timelineOps: ops,
        reader: timelineReader,
        persistenceProvider: proposalPersistenceProvider ?? undefined,
      });
    }
  }, [enableMutationServices, eagerProposalRetry, proposalPersistenceProvider, store, timelineReader]);

  // Sync proposalRuntime to the store so host-owned UI (ProposalPanel) can
  // access it.
  useEffect(() => {
    // `timelineReader` is an intentional dependency: it changes on the same
    // renders that can (re)create the proposal runtime above, so the sync
    // re-runs after those creations.
    void timelineReader;
    const pr = proposalRuntimeRef.current;
    if (pr) {
      store.getState().syncSlices({ proposalRuntime: pr });
    } else if (!enableMutationServices) {
      store.getState().syncSlices({ proposalRuntime: null });
    }
  }, [enableMutationServices, store, timelineReader]);

  // ---- Agent tool invocation service (registry + ProposalRuntime) -----
  const agentToolInvocationServiceRef = useRef<AgentToolInvocationService | null>(null);
  if (!enableMutationServices) {
    agentToolInvocationServiceRef.current = null;
  } else if (!agentToolInvocationServiceRef.current) {
    const registry = agentToolRegistryRef.current;
    const pr = proposalRuntimeRef.current;
    if (registry && pr) {
      agentToolInvocationServiceRef.current = createAgentToolInvocationService({
        registry,
        proposalRuntime: pr,
      });
    }
  }

  // App-shell strategy: keep the invocation service in sync when
  // proposalRuntime becomes available from an effect.
  useEffect(() => {
    if (!enableMutationServices || !eagerProposalRetry) return;
    // `timelineReader` is an intentional dependency: it tracks the renders on
    // which the proposal runtime may have been created.
    void timelineReader;
    if (agentToolInvocationServiceRef.current) return;
    const registry = agentToolRegistryRef.current;
    const pr = proposalRuntimeRef.current;
    if (registry && pr) {
      agentToolInvocationServiceRef.current = createAgentToolInvocationService({
        registry,
        proposalRuntime: pr,
      });
    }
  }, [agentToolRegistryRef, enableMutationServices, eagerProposalRetry, timelineReader]);

  // Sync extensions with live creative context.
  const liveCreativeOverrides = useMemo<Partial<CreativeContext>>(() => {
    const ops = store.getState().timelineOps ?? undefined;
    const proposals = proposalRuntimeRef.current ?? undefined;
    return {
      timeline: ops as unknown as CreativeContext['timeline'],
      reader: timelineReader,
      ...(documents ? { documents } : {}),
      assets: createEditorAssetSurface(
        () => store.getState().data.data,
        loadAssetProfile,
        () => playedAssetRegistry(shotComposition?.() ?? null, store.getState().data.data?.resolvedConfig),
      ),
      proposals: proposals as unknown as CreativeContext['proposals'],
      timelineView: timelineViewStoreRef.current as unknown as CreativeContext['timelineView'],
      projectObjects,
    };
  }, [documents, loadAssetProfile, projectObjects, shotComposition, timelineReader, timelineViewStoreRef, store]);

  useEffect(() => {
    const host = lifecycleHostRef.current;
    const registry = commandRegistryRef.current;
    if (!host) return;
    if (settingsRepository && !settingsSnapshotsReady) return;

    host.synchronize(
      extensionRuntime.extensions,
      (ext) => {
        const extId = ext.manifest.id as string;

        // Declarations are part of the registration commit. Failed staged
        // activation leaves the old revision's declarations and handlers intact.
        const ingestContributions = () => {
          if (registry) {
            for (const contrib of ext.manifest.contributions ?? []) {
              switch (contrib.kind) {
                case 'command':
                  registry.ingestCommandContribution(extId, contrib as CommandContribution);
                  break;
                case 'keybinding':
                  registry.ingestKeybindingContribution(extId, contrib as KeybindingContribution);
                  break;
                case 'contextMenuItem':
                  registry.ingestContextMenuItemContribution(extId, contrib as ContextMenuItemContribution);
                  break;
                case 'agentTool':
                  agentToolRegistryRef.current?.ingestAgentToolContribution(extId, contrib as AgentToolContribution);
                  break;
              }
            }
          }

        };

        const effectRegistry = effectRegistryRef.current;
        const transitionRegistry = transitionRegistryRef.current;
        const shaderRegistry = shaderRegistryRef.current;
        const clipTypeRegistry = clipTypeRegistryRef.current;
        const dataKindRegistry = dataKindRegistryRef.current;
        const agentToolRegistry = agentToolRegistryRef.current;
        const diagnosticsService =
          host.lifecycles.get(extId)?.diagnosticsService ??
          createExtensionDiagnosticsService(extId);
        // Create per-extension commands service backed by the shared registry
        const commandsService: ExtensionCommandService | undefined = registry
          ? {
              registerCommand(commandId, handler, options) {
                return registry.registerCommand(extId, commandId, handler, options);
              },
            }
          : undefined;
        // Create per-extension effects service backed by the shared EffectRegistry.
        // The lifecycle host creates per-extension diagnostics services during
        // synchronize() before calling contextFactory, so we can obtain the
        // correct one from the host.
        const effectsService = effectRegistry
          ? createEffectRegistrationService({
              extension: ext,
              effectRegistry,
              diagnosticsService,
            })
          : undefined;
        // Create per-extension transitions service backed by the shared TransitionRegistry.
        const transitionsService = transitionRegistry
          ? createTransitionRegistrationService({
              extension: ext,
              transitionRegistry,
              diagnosticsService,
            })
          : undefined;
        const shadersService: ShaderRegistrationService | undefined = shaderRegistry
          ? createShaderRegistrationService({
              extension: ext,
              shaderRegistry,
              diagnosticsService,
            })
          : undefined;
        // Create per-extension clipTypes service backed by the shared ClipTypeRegistry.
        const clipTypesService = clipTypeRegistry
          ? createClipTypeRegistrationService({
              extension: ext,
              clipTypeRegistry,
              diagnosticsService,
            })
          : undefined;
        // dataKind V1: per-extension dataKinds service backed by the shared
        // DataKindRegistry (single bind path for typed-data lanes).
        const dataKindsService: DataKindRegistrationService | undefined = dataKindRegistry
          ? createDataKindRegistrationService({
              extension: ext,
              dataKindRegistry,
              diagnosticsService,
              itemsHost: store.getState().dataKindItemsHost,
            })
          : undefined;
        // Create per-extension agent tools service backed by the shared AgentToolRegistry.
        const agentToolsService: AgentToolRegistrationService | undefined = agentToolRegistry
          ? {
              registerTool(toolId: string, handler: AgentToolHandler) {
                return agentToolRegistry.registerTool(extId, toolId, handler);
              },
              async invokeProcess(_toolId: string, _config: ProcessSpawnConfig) {
                return {
                  family: 'process' as const,
                  diagnostics: [{
                    severity: 'info' as const,
                    code: 'agent-tool/process-not-available',
                    message: `Process invocation is not available until M12.`,
                  }],
                };
              },
            }
          : undefined;
        const liveRegistry = liveDataRegistryRef.current;
        const creativeOverrides = {
          ...liveCreativeOverrides,
          ...(liveRegistry ? { sessions: createExtensionLiveSessions(liveRegistry, extId) } : {}),
          pendingWork: {
            report: (state: import('@/sdk/context.ts').ExtensionPendingWorkState) =>
              store.getState().pendingWorkRegistry?.report(extId, state),
          },
        };
        // Build settings service options when repository is available
        const settingsOptions: CreateExtensionSettingsServiceOptions | undefined =
          settingsRepository && !settingsRepository.isDisposed && !settingsSnapshotsUnavailable
            ? {
                repository: settingsRepository,
                initialSnapshot:
                  settingsSnapshotsRef?.current?.[extId] ??
                  undefined,
                onPersistenceSuccess(event) {
                  const notifyReg = settingsNotificationRegistryRef?.current;
                  if (notifyReg && !notifyReg.isDisposed && event.extensionId === extId) {
                    notifyReg.notifySettingsChanged(extId);
                  }
                },
                onPersistenceError(event) {
                  if (event.extensionId === extId) {
                    publishSettingsPersistenceDiagnostic(diagnosticCollection, event);
                  }
                },
              }
            : undefined;

        const ctx = createExtensionContext(
          ext,
          creativeOverrides,
          commandsService,
          effectsService,
          transitionsService,
          clipTypesService,
          agentToolsService,
          shadersService,
          settingsOptions,
          createExtensionUiService({
            extension: ext,
            diagnosticsService,
            rendererRegistry: rendererRegistryRef.current,
          }),
          dataKindsService,
          assembly.liveSceneOperationPort.registration(extId),
          () => assembly.shellRootRef.current,
        );

        // Register the settings service for explicit local-only listeners.
        // Manager-visible reload notifications are published from the
        // post-persist success callback above.
        const notifyReg = settingsNotificationRegistryRef?.current;
        onExtensionContextCommit(ctx, () => {
          ingestContributions();
          if (notifyReg && !notifyReg.isDisposed) {
            notifyReg.registerService(extId, ctx.services.settings);
          }
        });
        return ctx;
      },
    );
    syncExtensionDiagnosticsToCollection(diagnosticCollection, 'extension-lifecycle', [
      ...extensionRuntime.diagnostics,
      ...host.diagnostics,
    ], { activeExtensionIds });
  }, [
    activeExtensionIds,
    assembly.liveSceneOperationPort,
    assembly.shellRootRef,
    agentToolRegistryRef,
    clipTypeRegistryRef,
    commandRegistryRef,
    dataKindRegistryRef,
    diagnosticCollection,
    effectRegistryRef,
    extensionRuntime,
    lifecycleHostRef,
    liveCreativeOverrides,
    liveDataRegistryRef,
    rendererRegistryRef,
    settingsNotificationRegistryRef,
    settingsRepository,
    store,
    settingsSnapshotsRef,
    settingsSnapshotsReady,
    settingsSnapshotsUnavailable,
    shaderRegistryRef,
    transitionRegistryRef,
    enableMutationServices,
  ]);

  // Sync live registry diagnostics into the provider diagnostic collection
  // (no-op when the assembly has no live data registry).
  useEffect(() => {
    const registry = liveDataRegistryRef.current;
    if (!registry || !diagnosticCollection) return;
    const sync = () => {
      syncLiveDiagnosticsToCollection(diagnosticCollection, registry.getDiagnostics());
    };
    sync();
    const handle = registry.subscribe(sync);
    return () => handle.dispose();
  }, [diagnosticCollection, liveDataRegistryRef]);

  return {
    store,
    transcriptHost:editorOps.transcriptHost,
    editor,
    chrome,
    activeExtensionIds,
    effectsQueryData,
    effectResources,
    sequenceComponentResources,
  };
}

// ---------------------------------------------------------------------------
// Registry lifecycle bridges (rendered inside their registry providers)
// ---------------------------------------------------------------------------

function RuntimeEffectRegistryLifecycle({
  effectsQueryData,
  effectResources,
  lifecycleHostRef,
  commandRegistryRef,
  effectRegistryRef,
  agentToolRegistryRef,
  rendererRegistryRef,
  activeExtensionIds,
}: {
  effectsQueryData: Array<{ slug: string; code: string }> | undefined;
  effectResources: VideoEditorEffectCatalog['effects'];
  lifecycleHostRef: MutableRefObject<ExtensionLifecycleHost | null>;
  commandRegistryRef: MutableRefObject<CommandRegistry | null>;
  effectRegistryRef: MutableRefObject<EffectRegistry | null>;
  agentToolRegistryRef: MutableRefObject<AgentToolRegistry | null>;
  rendererRegistryRef: MutableRefObject<RendererRegistry>;
  activeExtensionIds: ReadonlySet<string>;
}) {
  const { registry: effectRegistry, snapshot: effectRegistrySnapshot } = useEffectRegistryContext();
  // Expose the effect registry to the outer synchronize effect via ref.
  // Set during render so the parent's useEffect can read it after commit.
  effectRegistryRef.current = effectRegistry;
  const diagnosticCollection = useVideoEditorRuntime().diagnosticCollection;

  useEffectRegistry(
    effectsQueryData?.map((effect) => ({
      slug: effect.slug,
      code: effect.code,
    })),
    effectResources,
  );

  useEffect(() => {
    const host = lifecycleHostRef.current;
    const commandRegistry = commandRegistryRef.current;
    const agentToolRegistry = agentToolRegistryRef.current;
    if (!host) return;
    // Contribution cleanup per-family:
    // - command, effect, diagnostics, settings: production lifecycle-owned
    // - agentTool: future-only scaffolding, not yet a public contribution system
    const handle = host.onLifecycleDisposed((extensionId: string) => {
      commandRegistry?.unregisterAll(extensionId);
      rendererRegistryRef.current.unregisterAll(extensionId);
      effectRegistry.unregisterOwner(extensionId);
      agentToolRegistry?.unregisterAll(extensionId);
      removeExtensionDiagnosticsFromCollection(diagnosticCollection, extensionId);
    });
    return () => handle.dispose();
  }, [commandRegistryRef, diagnosticCollection, effectRegistry, lifecycleHostRef, agentToolRegistryRef, rendererRegistryRef]);

  useEffect(() => {
    syncExtensionDiagnosticsToCollection(
      diagnosticCollection,
      'effect-registry',
      effectRegistrySnapshot.diagnostics,
      { activeExtensionIds },
    );
  }, [activeExtensionIds, diagnosticCollection, effectRegistrySnapshot]);

  useEffect(() => {
    const registry = commandRegistryRef.current;
    if (!registry) return;
    const sync = () => {
      syncExtensionDiagnosticsToCollection(
        diagnosticCollection,
        'command-registry',
        registry.diagnostics,
        { activeExtensionIds },
      );
    };
    sync();
    const handle = registry.subscribe(sync);
    return () => handle.dispose();
  }, [activeExtensionIds, commandRegistryRef, diagnosticCollection]);

  return null;
}

function RuntimeTransitionRegistryLifecycle({
  lifecycleHostRef,
  commandRegistryRef,
  transitionRegistryRef,
  activeExtensionIds,
}: {
  lifecycleHostRef: MutableRefObject<ExtensionLifecycleHost | null>;
  commandRegistryRef: MutableRefObject<CommandRegistry | null>;
  transitionRegistryRef: MutableRefObject<TransitionRegistry | null>;
  activeExtensionIds: ReadonlySet<string>;
}) {
  const { registry: transitionRegistry, snapshot: transitionRegistrySnapshot } = useTransitionRegistryContext();
  // Expose the transition registry to the outer synchronize effect via ref.
  transitionRegistryRef.current = transitionRegistry;
  const diagnosticCollection = useVideoEditorRuntime().diagnosticCollection;

  useEffect(() => {
    const host = lifecycleHostRef.current;
    const commandRegistry = commandRegistryRef.current;
    if (!host) return;
    const handle = host.onLifecycleDisposed((extensionId: string) => {
      commandRegistry?.unregisterAll(extensionId);
      transitionRegistry.unregisterOwner(extensionId);
      removeExtensionDiagnosticsFromCollection(diagnosticCollection, extensionId);
    });
    return () => handle.dispose();
  }, [commandRegistryRef, diagnosticCollection, transitionRegistry, lifecycleHostRef]);

  useEffect(() => {
    syncExtensionDiagnosticsToCollection(
      diagnosticCollection,
      'transition-registry',
      transitionRegistrySnapshot.diagnostics,
      { activeExtensionIds },
    );
  }, [activeExtensionIds, diagnosticCollection, transitionRegistrySnapshot]);

  return null;
}

function RuntimeShaderRegistryLifecycle({
  lifecycleHostRef,
  shaderRegistryRef,
  activeExtensionIds,
}: {
  lifecycleHostRef: MutableRefObject<ExtensionLifecycleHost | null>;
  shaderRegistryRef: MutableRefObject<ShaderEffectRegistry | null>;
  activeExtensionIds: ReadonlySet<string>;
}) {
  const { registry: shaderRegistry, snapshot: shaderRegistrySnapshot } = useShaderEffectRegistryContext();
  shaderRegistryRef.current = shaderRegistry;
  const diagnosticCollection = useVideoEditorRuntime().diagnosticCollection;

  useEffect(() => {
    const host = lifecycleHostRef.current;
    if (!host) return;
    const handle = host.onLifecycleDisposed((extensionId: string) => {
      shaderRegistry.unregisterOwner(extensionId);
      removeExtensionDiagnosticsFromCollection(diagnosticCollection, extensionId);
    });
    return () => handle.dispose();
  }, [diagnosticCollection, shaderRegistry, lifecycleHostRef]);

  useEffect(() => {
    const shaderDiagnostics = [
      ...shaderRegistrySnapshot.diagnostics,
      ...shaderRegistrySnapshot.records.flatMap((record) =>
        (record.diagnostics ?? []).map((diagnostic) => ({
          ...diagnostic,
          extensionId: diagnostic.extensionId ?? record.ownerExtensionId,
          contributionId: diagnostic.contributionId ?? record.contributionId,
          detail: {
            shaderId: record.shaderId,
            ...(diagnostic.detail ?? {}),
          },
        })),
      ),
    ];

    syncExtensionDiagnosticsToCollection(
      diagnosticCollection,
      'shader-effect-registry',
      shaderDiagnostics,
      { activeExtensionIds },
    );
  }, [activeExtensionIds, diagnosticCollection, shaderRegistrySnapshot]);

  return null;
}

function RuntimeClipTypeRegistryLifecycle({
  lifecycleHostRef,
  commandRegistryRef,
  clipTypeRegistryRef,
  activeExtensionIds,
}: {
  lifecycleHostRef: MutableRefObject<ExtensionLifecycleHost | null>;
  commandRegistryRef: MutableRefObject<CommandRegistry | null>;
  clipTypeRegistryRef: MutableRefObject<ClipTypeRegistry | null>;
  activeExtensionIds: ReadonlySet<string>;
}) {
  const { registry: clipTypeRegistry, snapshot: clipTypeRegistrySnapshot } = useClipTypeRegistryContext();
  // Expose the clip-type registry to the outer synchronize effect via ref.
  clipTypeRegistryRef.current = clipTypeRegistry;
  const diagnosticCollection = useVideoEditorRuntime().diagnosticCollection;

  useEffect(() => {
    const host = lifecycleHostRef.current;
    const commandRegistry = commandRegistryRef.current;
    if (!host) return;
    const handle = host.onLifecycleDisposed((extensionId: string) => {
      commandRegistry?.unregisterAll(extensionId);
      clipTypeRegistry.unregisterOwner(extensionId);
      removeExtensionDiagnosticsFromCollection(diagnosticCollection, extensionId);
    });
    return () => handle.dispose();
  }, [commandRegistryRef, diagnosticCollection, clipTypeRegistry, lifecycleHostRef]);

  useEffect(() => {
    syncExtensionDiagnosticsToCollection(
      diagnosticCollection,
      'clip-type-registry',
      clipTypeRegistrySnapshot.diagnostics,
      { activeExtensionIds },
    );
  }, [activeExtensionIds, diagnosticCollection, clipTypeRegistrySnapshot]);

  return null;
}

/**
 * dataKind V1 (Wave-3 ruling): bridges the assembly-owned data-kind registry
 * into the provider context so there is exactly ONE registry instance per
 * editor mount — `ctx.dataKinds.register(...)` (wired from
 * `dataKindRegistryRef` in the synchronize effect) and
 * `useDataKindRegistrySnapshot()` consumers (`useDataLanes` → DataLaneList)
 * observe the same records. Mirrors RuntimeClipTypeRegistryLifecycle.
 */
function RuntimeDataKindRegistryLifecycle({
  lifecycleHostRef,
  dataKindRegistryRef,
  activeExtensionIds,
}: {
  lifecycleHostRef: MutableRefObject<ExtensionLifecycleHost | null>;
  dataKindRegistryRef: MutableRefObject<DataKindRegistry | null>;
  activeExtensionIds: ReadonlySet<string>;
}) {
  const { registry: dataKindRegistry, snapshot: dataKindRegistrySnapshot } = useDataKindRegistryContext();
  // Expose the provider-exposed registry to the outer synchronize effect via
  // ref. With the bridged provider this is the assembly's own instance; the
  // assignment keeps the ref↔context identity invariant unconditional.
  dataKindRegistryRef.current = dataKindRegistry;
  const diagnosticCollection = useVideoEditorRuntime().diagnosticCollection;

  useEffect(() => {
    const host = lifecycleHostRef.current;
    if (!host) return;
    const handle = host.onLifecycleDisposed((extensionId: string) => {
      dataKindRegistry.unregisterOwner(extensionId);
      removeExtensionDiagnosticsFromCollection(diagnosticCollection, extensionId);
    });
    return () => handle.dispose();
  }, [diagnosticCollection, dataKindRegistry, lifecycleHostRef]);

  useEffect(() => {
    syncExtensionDiagnosticsToCollection(
      diagnosticCollection,
      'data-kind-registry',
      dataKindRegistrySnapshot.diagnostics,
      { activeExtensionIds },
    );
  }, [activeExtensionIds, diagnosticCollection, dataKindRegistrySnapshot]);

  return null;
}

// ---------------------------------------------------------------------------
// Scaffold: registry providers + lifecycle bridges + catalog/store providers
// ---------------------------------------------------------------------------

export function EditorRuntimeScaffold({
  assembly,
  sync,
  children,
}: {
  assembly: EditorRuntimeAssembly;
  sync: EditorRuntimeSync;
  children: ReactNode;
}) {
  const inner = (
    <EffectCatalogProvider value={sync.effectResources}>
      <RuntimeEffectRegistryLifecycle
        effectsQueryData={sync.effectsQueryData}
        effectResources={sync.effectResources.effects}
        lifecycleHostRef={assembly.lifecycleHostRef}
        commandRegistryRef={assembly.commandRegistryRef}
        effectRegistryRef={assembly.effectRegistryRef}
        agentToolRegistryRef={assembly.agentToolRegistryRef}
        rendererRegistryRef={assembly.rendererRegistryRef}
        activeExtensionIds={sync.activeExtensionIds}
      />
      <RuntimeTransitionRegistryLifecycle
        lifecycleHostRef={assembly.lifecycleHostRef}
        commandRegistryRef={assembly.commandRegistryRef}
        transitionRegistryRef={assembly.transitionRegistryRef}
        activeExtensionIds={sync.activeExtensionIds}
      />
      {assembly.shaderRegistryEnabled ? (
        <RuntimeShaderRegistryLifecycle
          lifecycleHostRef={assembly.lifecycleHostRef}
          shaderRegistryRef={assembly.shaderRegistryRef}
          activeExtensionIds={sync.activeExtensionIds}
        />
      ) : null}
      <RuntimeClipTypeRegistryLifecycle
        lifecycleHostRef={assembly.lifecycleHostRef}
        commandRegistryRef={assembly.commandRegistryRef}
        clipTypeRegistryRef={assembly.clipTypeRegistryRef}
        activeExtensionIds={sync.activeExtensionIds}
      />
      <RuntimeDataKindRegistryLifecycle
        lifecycleHostRef={assembly.lifecycleHostRef}
        dataKindRegistryRef={assembly.dataKindRegistryRef}
        activeExtensionIds={sync.activeExtensionIds}
      />
      <SequenceComponentCatalogProvider value={sync.sequenceComponentResources}>
        <SequenceComponentRegistryProvider components={sync.sequenceComponentResources.components}>
          <TimelineStoreProvider store={sync.store}>
            {children}
          </TimelineStoreProvider>
        </SequenceComponentRegistryProvider>
      </SequenceComponentCatalogProvider>
    </EffectCatalogProvider>
  );

  // dataKind V1: the provider exposes the ASSEMBLY-OWNED registry instance
  // (Wave-3 ruling) — one registry per editor mount, shared by ctx.dataKinds
  // writes and useDataLanes reads. Disposal stays with the assembly.
  const withDataKinds = (
    <DataKindRegistryProvider registry={assembly.dataKindRegistryRef.current ?? undefined}>
      {inner}
    </DataKindRegistryProvider>
  );

  const withClipTypes = <ClipTypeRegistryProvider>{withDataKinds}</ClipTypeRegistryProvider>;

  return (
    <EffectRegistryProvider>
      <TransitionRegistryProvider>
        {assembly.shaderRegistryEnabled ? (
          <ShaderEffectRegistryProvider>{withClipTypes}</ShaderEffectRegistryProvider>
        ) : (
          withClipTypes
        )}
      </TransitionRegistryProvider>
    </EffectRegistryProvider>
  );
}
