import type { VideoEditorInstanceScope } from '../browser/scopedServices.ts';
import { createContext, useContext } from 'react';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';
import type {
  VideoEditorAssetResolver,
  VideoEditorExporter,
  VideoEditorHostContext,
} from '@/tools/video-editor/lib/browser-runtime.ts';
import type {
  VideoEditorAgentChatHost,
  VideoEditorAuthHost,
  VideoEditorMediaLightboxHost,
  VideoEditorProjectHost,
  VideoEditorShotsHost,
  VideoEditorTelemetryHost,
  VideoEditorToastHost,
} from '@/tools/video-editor/runtime/ports.ts';
import type {
  VideoEditorExtensionRuntimeConfig,
  ExtensionRuntime,
} from '@/tools/video-editor/runtime/extensionSurface.ts';
import type { CommandRegistry } from '@/tools/video-editor/runtime/commandRegistry.ts';
import type { AgentToolRegistry } from '@/tools/video-editor/runtime/agentToolRegistry.ts';
import type { DiagnosticCollection } from '@astrid/editor-sdk';
import type { TimelineViewStoreApi } from '@/tools/video-editor/lib/timeline-view-store.ts';
import type { LiveDataRegistry } from '@/tools/video-editor/runtime/liveDataRegistry.ts';
import type { LivePermissionService } from '@/tools/video-editor/runtime/livePermissions.ts';
import type { ExtensionStateRepository } from '@/tools/video-editor/runtime/extensionStateRepository';
import type { ExtensionSettingsNotificationRegistry } from '@/tools/video-editor/runtime/extensionSettingsNotification';
import type { ProcessManager } from '@/tools/video-editor/runtime/processes/ProcessManager.ts';
import type { ProcessStatus } from '@/sdk/video/families/processes';
import type { ProcessResultAttachRecord } from '@/tools/video-editor/runtime/composition/processResultAttach.ts';
import type { HostOwnedExtensionOperationalEmitter } from '@/tools/video-editor/runtime/extensionReleaseControls.ts';
import type { TimelineEditability } from '@/tools/video-editor/lib/timeline-editability.ts';
import type { AstridElementHost } from '@/tools/video-editor/runtime/astrid-element-host.ts';

export interface VideoEditorRuntimeContextValue {
  /** Internal per-assembly chrome and host selection ownership. */
  shellRootRef?: { current: HTMLElement | null };
  agentSelectionOwner?: symbol;
  /** Captured public Tool identity; independent full/dialog hosts supply it. */
  instanceScope?: Readonly<VideoEditorInstanceScope>;
  astridElementHost: AstridElementHost;
  provider: DataProvider;
  assetResolver: VideoEditorAssetResolver;
  auth: VideoEditorAuthHost;
  project: VideoEditorProjectHost;
  shots: VideoEditorShotsHost;
  mediaLightbox: VideoEditorMediaLightboxHost;
  agentChat: VideoEditorAgentChatHost;
  toast: VideoEditorToastHost;
  telemetry: VideoEditorTelemetryHost;
  /** Internal host-only source emitter; never exposed through extension SDK context. */
  operationalEmitter?: HostOwnedExtensionOperationalEmitter;
  timelineId: string;
  userId: string | null;
  timelineName?: string | null;
  exporter?: VideoEditorExporter | null;
  hostContext?: VideoEditorHostContext | null;
  /** Host capability for starting renders and compile-only exports. Omitted
   *  keeps the established behavior; read-only public previews set false. */
  renderExportEnabled?: boolean;
  extensions: VideoEditorExtensionRuntimeConfig;
  extensionRuntime?: ExtensionRuntime;
  /** Provider-scoped command registry (commands, keybindings, context menus). */
  commandRegistry?: CommandRegistry;
  /** Provider-scoped agent tool registry for host-mediated, proposal-backed agent tools. */
  agentToolRegistry?: AgentToolRegistry;
  liveSceneOperationPort?: import('../runtime/liveSceneOperationPort').LiveSceneOperationPort;
  /** Provider-scoped live data registry for source lifecycle, channels, samples, and bake. */
  liveDataRegistry?: LiveDataRegistry;
  /** Provider-scoped live permission service for browser-gated permission probes/requests. */
  livePermissionService?: LivePermissionService;
  /** Provider-scoped diagnostics surfaced by status and diagnostic panels. */
  diagnosticCollection?: DiagnosticCollection;
  /** Extension state repository for enable/disable persistence. */
  extensionStateRepository?: ExtensionStateRepository | null;
  /** Trigger extension re-resolution after persistence writes. */
  triggerExtensionRefresh?: () => void;
  /** Host-visible settings notification registry for manager/runtime coherence. */
  settingsNotificationRegistry?: ExtensionSettingsNotificationRegistry;
  /** Recovery key facade backed by ExtensionLifecycleHost.
   *  Returns the current monotonic recovery key for an extension, or "0"
   *  for unknown/disposed extension IDs. */
  getRecoveryKey?: (extensionId: string) => string;
  /** Increment the recovery key for an extension and return the new key.
   *  This is the programmatic retry signal for ContributionErrorBoundary.
   *  No-op for unknown/disposed extension IDs (returns "0"). */
  incrementRecoveryKey?: (extensionId: string) => string;
  /** Provider-scoped process manager for trusted local processes.
   *  Created by default from declared process specs; hosts may override. */
  processManager?: ProcessManager;
  /** Read-only snapshot of all process statuses from the process manager. */
  processStatuses?: readonly ProcessStatus[];
  /** Host-session scoped attach records for process result provenance.
   *  Memory only — not persisted into project data or timeline internals. */
  processResultAttachRecords?: readonly ProcessResultAttachRecord[];
  /** Record a process result attach record for the current editor session. */
  recordProcessResultAttach?: (record: ProcessResultAttachRecord) => void;
  /** Provider-owned timeline-overlay feature flag. Explicitly defaults
   *  to false; hosts opt in by supplying `true`. No provider inspects a query
   *  string, and no environment enables it yet. */
  timelineOverlaysEnabled?: boolean;
  /** Provider-owned TimelineViewStore for `ctx.creative.timelineView`.
   *  The canvas publishes layout/playback state into it regardless of the
   *  overlay flag; extensions read it renderer-independently. */
  timelineViewStore?: TimelineViewStoreApi;
  /** Host-owned runtime lock/read-only state; never serialized in timeline data. */
  timelineEditability?: TimelineEditability;
  /** Presentation only: the host permits edits but the save owner has no handoff.
   * Admission always uses timelineEditability, including during this hold. */
  timelineSaveReadinessHeld?: boolean;
}

export const VideoEditorRuntimeContext = createContext<VideoEditorRuntimeContextValue | null>(null);

export function VideoEditorRuntimeProvider({
  value,
  children,
}: {
  value: VideoEditorRuntimeContextValue;
  children: React.ReactNode;
}) {
  return (
    <VideoEditorRuntimeContext.Provider value={value}>
      {children}
    </VideoEditorRuntimeContext.Provider>
  );
}

export function useVideoEditorRuntime(): VideoEditorRuntimeContextValue {
  const context = useContext(VideoEditorRuntimeContext);
  if (!context) {
    throw new Error('useVideoEditorRuntime must be used within VideoEditorRuntimeProvider');
  }

  return context;
}

export function useOptionalVideoEditorRuntime(): VideoEditorRuntimeContextValue | null {
  return useContext(VideoEditorRuntimeContext);
}
