import { useRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { RUNTIME_CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { EmptyWorkspaceGuidance } from '@/shared/components/RuntimeConnection/EmptyWorkspaceGuidance.tsx';
import { WorkspaceDiscoveryPending } from '@/shared/components/RuntimeConnection/WorkspaceDiscoveryPending.tsx';
import { useNativeEditorRecovery } from '../hooks/useNativeEditorRecovery.ts';
import { assertNativeEditorConnection } from "@/integrations/astrid/nativeEditorConnection.ts";
import type { ExtensionPendingWorkState } from "@/sdk/context.ts";
import {
  useRuntimeEditorDiscovery,
  chooseRuntimeTimeline,
} from "../hooks/useRuntimeEditorDiscovery.ts";
// Layer map & invariants: docs/structure_detail/tool_video_editor.md
/**
 * Internal Astrid App route adapter for the in-app video editor page.
 * Not part of the supported public SDK surface.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
} from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { useLocation, useSearchParams } from "react-router-dom";
import { useHomeNavigation } from "@/shared/hooks/useHomeNavigation.ts";
import { isHomeToolPathActive } from "@/shared/lib/tooling/homeNavigation.ts";
import { Button } from "@/shared/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/shared/components/ui/card.tsx";
import { useOptionalAgentChatRegistry } from "@/shared/contexts/AgentChatContext.tsx";
import { useOptionalGlobalHeaderSlot } from "@/shared/contexts/ToolPageHeaderContext.tsx";
import { toast } from "@/shared/components/ui/toast.tsx";
import { useTimelineChromeContextSafe } from "@/tools/video-editor/hooks/timelineStore.ts";
import { exportTimelineArchive, importTimelineArchive } from "@/tools/video-editor/lib/timeline-transfer.ts";
import type { DataProvider } from "@/tools/video-editor/data/DataProvider.ts";
import { VideoEditorProvider } from "@/tools/video-editor/contexts/VideoEditorProvider.tsx";
import { devLocalExtensions } from "@/tools/video-editor/dev/localExtensions.ts";
import {
  TRANSCRIPT_LANE_FIXTURE_PARAM,
  withTranscriptFixture,
} from "@/tools/video-editor/dev/transcript-lane/fixtureProvider.ts";
import {
  getSnapshot as getBuiltInDisabledSnapshot,
  subscribe as subscribeBuiltInDisabled,
} from "@/tools/video-editor/runtime/builtInExtensionEnablement.ts";
import { useExtensionLoaderWiring } from "@/tools/video-editor/runtime/useExtensionLoaderWiring";
import { AstridVideoEditorShell } from "@/tools/video-editor/components/AstridVideoEditorShell.tsx";
import {
  ProjectTimelinePicker,
} from "@/shared/components/ProjectTimelineSelectors.tsx";
import { ProjectHeaderControls } from "@/shared/components/ProjectHeaderControls.tsx";
import { ProjectHeaderActions } from "@/shared/components/ProjectHeaderActions.tsx";
import {
  AstridRuntimeClient,
  RuntimeUnavailableError,
  type RuntimeConnectorError,
} from "@/integrations/runtime/client.ts";
import {
  createCanonicalTimeline,
  ensureProjectHasTimeline,
} from "@/integrations/runtime/createDefaultTimeline.ts";
import { ApiError } from "@/integrations/runtime/generated.ts";
import { generateUUID } from "@/shared/lib/taskCreation/ids.ts";
import { AppHeader } from "@/shared/components/AppHeader.tsx";
import { runtimeOrigin } from "@/integrations/runtime/connection.ts";
import { RuntimeConnectorRecoveryBanner } from "@/shared/components/RuntimeConnection/RuntimeConnectorRecoveryBanner.tsx";
import { RuntimeDataProvider } from "@/integrations/runtime/dataProvider.ts";
import type { SaveStatus } from "@/tools/video-editor/hooks/useTimelinePersistence.ts";
import { publishLocalTestExtensionDiagnostics } from "@/app/localTestRuntime.ts";
import {
  selectReviewedExtensions,
} from "@/tools/video-editor/runtime/extensionReleaseControls.ts";
import { useEditorTour, useEditorTourRunning } from "@/shared/state/editorTourStore.ts";
import { useEditorTourHost } from "@/tools/video-editor/tour/runner/useEditorTourHost.ts";
import { EditorTourSlot } from "@/tools/video-editor/tour/timeline/editorTourSlot.tsx";
import { EditorTourTimelineDriver } from "@/tools/video-editor/tour/timeline/EditorTourTimelineDriver.tsx";
import { createEditorTourDataProvider } from "@/tools/video-editor/tour/timeline/tourDataProvider.ts";
import { tourHeaderProps } from "@/tools/video-editor/tour/timeline/tourHeaderProps.ts";

type ProviderSelection = {
  dataProvider: DataProvider;
  projectId: string | null;
  projectSlug: string | null;
  timelineId: string;
  timelineName: string | null;
  userId: string | null;
  remountKey: string;
  runtimeReconnect?: () => Promise<void>;
};

/** Keep existing browser resume preferences; values are now canonical IDs. */
export const LAST_OPENED_PROJECT_STORAGE_KEY =
  "astrid:lastOpenedLocalProjectSlug";

/** Root class that turns off Chrome's horizontal overscroll swipe-back while the editor is mounted (see index.css). */
export const VIDEO_EDITOR_SWIPE_LOCK_CLASS = "video-editor-swipe-lock";

function TimelineTransferSaveBridge({ target }: { target: MutableRefObject<(() => Promise<unknown>) | null> }) {
  const chrome = useTimelineChromeContextSafe();
  target.current = chrome?.flushPendingSave ?? null;
  return null;
}

// Progress toasts stay until the transfer finishes (duration 0); results use the app's usual lengths.
function transferToast() {
  const fail = (message: string, id?: unknown, description?: string) =>
    toast.error(message, { ...(typeof id === 'string' ? { id } : {}), ...(description ? { description } : {}), duration: 8_000 });
  return {
    loading: (message: string) => toast(message, { duration: 0 }),
    update: (id: unknown, message: string) => { if (typeof id === 'string') toast(message, { id, duration: 0 }); },
    success: (message: string, id?: unknown, description?: string) => toast.success(message, { ...(typeof id === 'string' ? { id } : {}), ...(description ? { description } : {}), duration: 5_000 }),
    warning: (message: string, id?: unknown, description?: string) => toast.warning(message, { ...(typeof id === 'string' ? { id } : {}), ...(description ? { description } : {}), duration: 0 }),
    error: fail,
  };
}

type EditorProject = {
  slug: string;
  name: string;
  created_at?: string;
  project_id?: string;
  metadata?: Record<string, unknown>;
};

function mostRecentlyCreatedProject(
  projects: EditorProject[],
): EditorProject | null {
  return (
    projects
      .map((project) => ({
        project,
        createdAt: project.created_at
          ? Date.parse(project.created_at)
          : Number.NaN,
      }))
      .sort(
        (left, right) =>
          (Number.isFinite(right.createdAt) ? right.createdAt : -Infinity) -
          (Number.isFinite(left.createdAt) ? left.createdAt : -Infinity) ||
          left.project.slug.localeCompare(right.project.slug),
      )[0]?.project ?? null
  );
}

function useVideoEditorProviderSelection({
  projectId, projectSlug, timelineId, timelineName, onRuntimeError,
}: {
  projectId: string | null;
  projectSlug: string | null;
  timelineId: string | null;
  timelineName: string | null;
  onRuntimeError: (error: RuntimeConnectorError) => void;
}): ProviderSelection | null {
  // Only a document identity change replaces the stateful provider. Display
  // metadata and connection recovery must leave pending reads and drafts mounted.
  const connection = useMemo(() => {
    if (!projectId || !timelineId) return null;
    const dataProvider = new RuntimeDataProvider({ projectId, onRuntimeError });
    return { dataProvider, runtimeReconnect: () => dataProvider.reconnect() };
  }, [projectId, timelineId, onRuntimeError]);
  return useMemo(() => connection && projectId && timelineId ? {
    ...connection, projectId, projectSlug, timelineId, timelineName,
    userId: null,
    remountKey: `runtime:${projectId}:${timelineId}`,
  } : null, [connection, projectId, projectSlug, timelineId, timelineName]);
}

/**
 * The editor tour's selection: an in-memory demo timeline in local mode (`projectId: null`), so
 * nothing queries, saves or registers against the user's project. Each run gets its own key.
 */
function useEditorTourSelection(): ProviderSelection | null {
  const running = useEditorTourRunning();
  const runId = useEditorTour((state) => state.runId);
  const { timelineId, timelineName } = tourHeaderProps();
  return useMemo(() => running ? {
    dataProvider: createEditorTourDataProvider(),
    projectId: null,
    projectSlug: null,
    timelineId,
    timelineName,
    userId: null,
    remountKey: `tour:${runId}`,
  } : null, [running, runId, timelineId, timelineName]);
}

export default function VideoEditorPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // ---- Reviewed extension bundle + smoke wiring ----------------------------
  // Production defaults closed and can only be enabled by the deployment-owned
  // runtime document loaded before React mounts. DEV defaults open for authoring. URL or browser
  // storage cannot override the production rollout contract.
  //
  // Built-in enablement is an external store (`builtInExtensionEnablement.ts`),
  // shared by DEV and production so the ExtensionManager toggle applies in both:
  // subscribing via useSyncExternalStore makes the disabled-ID snapshot part of
  // this component's render inputs, so a toggle in the ExtensionManager updates
  // the direct-extension memo below without a searchParams change or a loader
  // refresh key. The snapshot is a stable cached Set — unchanged reads never
  // re-render the page, and disabling an extension drops it from the list, which
  // tears its runtime lifecycle down (the lifecycle host disposes on removal).
  const builtInDisabledIds = useSyncExternalStore(
    subscribeBuiltInDisabled,
    getBuiltInDisabledSnapshot,
    getBuiltInDisabledSnapshot,
  );

  const smokeDirectExtensions = useMemo(() => {
    // The routed native editor uses the same admitted catalog for every backend.
    // Arbitrary scratchpad manifests remain usable in DEV. Production alone
    // applies the frozen reviewed inventory. The built-in enablement filter
    // applies in both builds.
    const admittedExtensions = (
      import.meta.env.DEV
        ? devLocalExtensions
        : selectReviewedExtensions(devLocalExtensions)
    ).filter((extension) => !builtInDisabledIds.has(extension.manifest.id as string));
    const direct = [...admittedExtensions];
    return direct.length > 0 ? direct : undefined;
  }, [builtInDisabledIds]);

  // Extensions contribute overlays in every build.
  const timelineOverlaysEnabled =
    (smokeDirectExtensions ?? []).some((ext) =>
      ext.manifest.contributions?.some(
        (contribution) => contribution.kind === "timelineOverlay",
      ),
    );

  // ---- extension loader wiring (host-owned) --------------------------
  // Resolves direct-local extensions + optional repository state through the
  // ExtensionLoader pipeline.  When no repository is provided, direct-local
  // extensions pass through unchanged (backward compatible).
  const {
    resolvedExtensions,
    diagnostics: loaderDiagnostics,
  } = useExtensionLoaderWiring({
    directExtensions: smokeDirectExtensions,
    repository: null,
    bundleStore: null,
  });
  useEffect(() => {
    publishLocalTestExtensionDiagnostics("loader", loaderDiagnostics);
  }, [loaderDiagnostics]);
  const { pathname } = useLocation();
  const { targetPath } = useHomeNavigation();
  const globalHeaderSlot = useOptionalGlobalHeaderSlot();
  const hasGlobalHeader = globalHeaderSlot.hasProvider;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(VIDEO_EDITOR_SWIPE_LOCK_CLASS);
    return () => root.classList.remove(VIDEO_EDITOR_SWIPE_LOCK_CLASS);
  }, []);

  const projectId = searchParams.get("project")?.trim() || null;
  const timelineId = searchParams.get("timeline")?.trim() || null;
  const isHomeTool = isHomeToolPathActive(pathname, targetPath);
  const [selectorsOpen, setSelectorsOpen] = useState(false);
  const runtimeDiscovery = useRuntimeEditorDiscovery({
    enabled: true, projectId, open: selectorsOpen,
  });
  const projects = runtimeDiscovery.projectsQuery.data;
  const timelines = runtimeDiscovery.timelinesQuery.data;
  const selectedProject = runtimeDiscovery.project;
  const selectedTimeline = timelines?.find(t => t.timeline_id === timelineId) ?? null;
  const discoveryError = runtimeDiscovery.projectsQuery.error ?? runtimeDiscovery.timelinesQuery.error;
  const canSelectRuntimeProject = !!selectedProject && !discoveryError;

  useEffect(() => {
    if (projectId || !projects || runtimeDiscovery.projectsQuery.error) return;
    let previous: string | null = null;
    try { previous = window.localStorage.getItem(LAST_OPENED_PROJECT_STORAGE_KEY); } catch { /* Storage is optional. */ }
    const project = projects.find(p => p.project_id === previous)
      ?? projects.find(p => p.slug === previous)
      ?? mostRecentlyCreatedProject(projects);
    if (!project?.project_id) return;
    setSearchParams(current => {
      if (current.has("project")) return current;
      const next = new URLSearchParams(current);
      next.set("project", project.project_id!);
      return next;
    }, { replace: true });
  }, [projectId, projects, runtimeDiscovery.projectsQuery.error, setSearchParams]);

  useEffect(() => {
    if (!selectedProject) return;
    try { window.localStorage.setItem(LAST_OPENED_PROJECT_STORAGE_KEY, selectedProject.project_id); } catch { /* Storage is optional. */ }
  }, [selectedProject]);

  // Chat, the gallery and the editor all use the same canonical project,
  // including projects which have not created their first timeline yet.
  const agentChatRegistry = useOptionalAgentChatRegistry();
  const chatProjectId = selectedProject?.project_id ?? null;
  const chatProjectSlug = selectedProject?.slug ?? null;
  const chatProjectName = selectedProject?.name ?? null;
  useEffect(() => {
    if (!agentChatRegistry) return;
    agentChatRegistry.registerProject({
      timelineId: null,
      editorContext: chatProjectId ? {
        tool: "video-editor", projectId: chatProjectId, projectSlug: chatProjectSlug, projectName: chatProjectName,
        timelineId: null, timelineName: null,
        deepLink: typeof globalThis.location?.href === "string" ? globalThis.location.href : null,
      } : null,
    });
    return agentChatRegistry.unregisterProject;
  }, [agentChatRegistry, chatProjectId, chatProjectName, chatProjectSlug]);

  const [mountedSaveStatus, setMountedSaveStatus] =
    useState<SaveStatus>("saved");
  const flushTimelineSaveRef = useRef<(() => Promise<unknown>) | null>(null);
  const [settingPrimaryTimelineId, setSettingPrimaryTimelineId] = useState<
    string | null
  >(null);
  const [runtimeConnectorError, setRuntimeConnectorError] =
    useState<RuntimeConnectorError | null>(null);
  const [runtimeRetrying, setRuntimeRetrying] = useState(false);
  const [nativeRecoveryError, setNativeRecoveryError] = useState<string | null>(
    null,
  );
  const [creatingFirstTimeline, setCreatingFirstTimeline] = useState(false);
  const [firstTimelineError, setFirstTimelineError] = useState<string | null>(
    null,
  );
  const timelineSelectionRef = useRef({
    projectId: projectId,
    timelineId: timelineId,
  });
  timelineSelectionRef.current = {
    projectId: projectId,
    timelineId: timelineId,
  };
  const attemptedFirstTimelineProjects = useRef(new Set<string>());
  const pendingAdditionalTimeline = useRef<{
    projectId: string;
    timelineId: string;
    name: string;
  } | null>(null);
  const projectsPending = !projects && !runtimeDiscovery.projectsQuery.error;
  const timelinesPending = !!selectedProject && !timelines && !runtimeDiscovery.timelinesQuery.error;
  const projectMissing = !!projectId && !!projects && !selectedProject;
  const timelineMissing = !!timelineId && !!timelines && !selectedTimeline;
  // Resolve both identities before mounting a document. Cached discovery data
  // stays available during connection failures, preserving an already mounted
  // editor, but an unverified or cross-project URL must never open a provider.
  const selectionVerified = !!selectedProject && !!selectedTimeline;
  const workspaceSettling = !runtimeDiscovery.projectsQuery.error && !runtimeDiscovery.timelinesQuery.error
    && (projectsPending || timelinesPending || (!projectId && !timelineId && (projects?.length ?? 0) > 0)
      || (!!selectedProject && !timelineId && (timelines?.some(t => !t.is_shot) ?? false)));
  const connectorScope = JSON.stringify([projectId, timelineId]);
  const currentConnectorScope = useRef(connectorScope);
  currentConnectorScope.current = connectorScope;
  const reportNativeFailure = useRef<() => void>(() => undefined);
  const onRuntimeError = useCallback((error: RuntimeConnectorError) => {
    if (currentConnectorScope.current !== connectorScope) return;
    setRuntimeConnectorError(error);
    setRuntimeRetrying(false);
    reportNativeFailure.current();
  }, [connectorScope]);
  const userProviderSelection = useVideoEditorProviderSelection({
    projectId: selectionVerified ? projectId : null,
    projectSlug: selectedProject?.slug ?? projectId,
    timelineId: selectionVerified ? timelineId : null,
    timelineName: selectedTimeline?.name?.trim() || selectedTimeline?.slug || "Untitled timeline",
    onRuntimeError,
  });

  const tourSelection = useEditorTourSelection();
  const tourHeader = tourSelection ? tourHeaderProps() : null;
  const lastSelectedRuntimeProject = useRef<string | null>(null);
  useEffect(() => {
    if (!canSelectRuntimeProject || !projectId || tourSelection || lastSelectedRuntimeProject.current === projectId) return;
    const timeout = window.setTimeout(() => {
      if (lastSelectedRuntimeProject.current === projectId) return;
      lastSelectedRuntimeProject.current = projectId;
      void new AstridRuntimeClient().selectProject(projectId, "workspace").catch(() => {
        if (lastSelectedRuntimeProject.current === projectId) lastSelectedRuntimeProject.current = null;
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [projectId, canSelectRuntimeProject, selectorsOpen, tourSelection]);
  // Register explicit replays; first-run welcome already finished before this editor opens.
  useEditorTourHost();
  const providerSelection = tourSelection ?? userProviderSelection;

  // dataKind V1 golden path (groken round 4): DEV-only fixture provider so the
  // transcript-lane example paints on any project with a media clip. Opt-in
  // via `?transcriptLaneFixture=1`; production builds drop the branch.
  const pageDataProvider = useMemo(() => {
    if (!providerSelection) return null;
    if (tourSelection || !import.meta.env.DEV) return providerSelection.dataProvider;
    const fixtureMode =
      import.meta.env.MODE === "test"
        ? new URLSearchParams(window.location.search).get(
            TRANSCRIPT_LANE_FIXTURE_PARAM,
          )
        : null;
    return fixtureMode !== null
      ? withTranscriptFixture(providerSelection.dataProvider, {
          dense: fixtureMode === "dense",
          renderMatrix: fixtureMode === "render-matrix",
        })
      : providerSelection.dataProvider;
  }, [providerSelection, tourSelection]);

  const nativeRecovery = useNativeEditorRecovery({
    enabled: !!userProviderSelection,
    scope: connectorScope,
    onRecovered: () => {
      setRuntimeConnectorError(null);
      setNativeRecoveryError(null);
      setRuntimeRetrying(false);
    },
  });
  reportNativeFailure.current = nativeRecovery.reportFailure;

  useEffect(() => {
    setRuntimeConnectorError(null);
    setNativeRecoveryError(null);
    setRuntimeRetrying(false);
  }, [providerSelection?.remountKey]);

  const handleRuntimeRetry = useCallback(async () => {
    if (runtimeRetrying || nativeRecovery.retrying) {
      return;
    }
    const attempt = nativeRecovery.beginManualAttempt();
    setRuntimeRetrying(true);
    try {
      await assertNativeEditorConnection();
      if (providerSelection?.runtimeReconnect)
        await providerSelection.runtimeReconnect();
      await runtimeDiscovery.reconnect();
      nativeRecovery.completeRecovery(attempt);
    } catch (error) {
      if (currentConnectorScope.current !== attempt.scope) return;
      nativeRecovery.reportFailure();
      setNativeRecoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeRetrying(false);
    }
  }, [providerSelection, runtimeRetrying, runtimeDiscovery, nativeRecovery]);

  useEffect(() => {
    setMountedSaveStatus("saved");
  }, [providerSelection?.remountKey]);

  const [extensionPendingWork, setExtensionPendingWork] = useState<{
    scope: string;
    state: ExtensionPendingWorkState;
  } | null>(null);
  const scope = providerSelection?.remountKey ?? "";
  const onPendingWorkChange = useCallback(
    (state: ExtensionPendingWorkState) =>
      setExtensionPendingWork((previous) =>
        previous?.scope === scope &&
        JSON.stringify(previous.state) === JSON.stringify(state)
          ? previous
          : { scope, state },
      ),
    [scope],
  );
  const extensionWork =
    extensionPendingWork?.scope === scope ? extensionPendingWork.state : null;
  const extensionWriting = extensionWork?.writing ?? false;
  const extensionUnsaved = extensionWork?.unsaved ?? false;
  const isSwitchBlockedBySave =
    mountedSaveStatus === "saving" ||
    mountedSaveStatus === "retrying" ||
    extensionWriting;
  const confirmEditorRemount = useCallback(() => {
    if (!providerSelection) {
      return true;
    }
    // A save round-trip is in flight or a transport retry is scheduled —
    // switching would abandon it and lose the edit. Block like `saving`.
    if (
      mountedSaveStatus === "saving" ||
      mountedSaveStatus === "retrying" ||
      extensionWriting
    ) {
      return false;
    }
    if (
      extensionUnsaved &&
      !window.confirm(
        "You have an unsaved project transcript draft or conflict. Your draft will remain available for this source. Switch editors?",
      )
    )
      return false;
    if (mountedSaveStatus === "dirty") {
      return window.confirm(
        "You have unsaved timeline changes. Switch editors and discard them?",
      );
    }
    if (mountedSaveStatus === "error") {
      return window.confirm(
        "The last timeline save failed. Switch editors anyway?",
      );
    }
    return true;
  }, [mountedSaveStatus, providerSelection, extensionWriting, extensionUnsaved]);

  const confirmRemountRef = useRef(confirmEditorRemount);
  confirmRemountRef.current = confirmEditorRemount;
  useEffect(() => setFirstTimelineError(null), [projectId]);

  const handleSelectProject = useCallback((id: string) => {
    if (id === projectId || !projects?.some(p => p.project_id === id) || !confirmEditorRemount()) return;
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set("project", id);
      next.delete("timeline");
      return next;
    });
  }, [projectId, projects, confirmEditorRemount, setSearchParams]);
  const handleSelectTimeline = useCallback((id: string) => {
    if (id === timelineId || !timelines?.some(t => t.timeline_id === id) || !confirmEditorRemount()) return;
    setSearchParams(current => {
      if (current.get("project") !== projectId) return current;
      const next = new URLSearchParams(current);
      next.set("timeline", id);
      return next;
    });
  }, [timelineId, timelines, projectId, confirmEditorRemount, setSearchParams]);

  const handleCreateFirstTimeline = useCallback(async () => {
    if (!selectedProject || !projectId || creatingFirstTimeline || isSwitchBlockedBySave) {
      return;
    }
    setCreatingFirstTimeline(true);
    setFirstTimelineError(null);
    try {
      const timelineRef = await ensureProjectHasTimeline(
        projectId,
        new AstridRuntimeClient(),
      );
      await Promise.all([
        runtimeDiscovery.projectsQuery.refetch(),
        runtimeDiscovery.timelinesQuery.refetch(),
      ]);
      if (
        timelineSelectionRef.current.projectId === projectId &&
        !timelineSelectionRef.current.timelineId
      ) {
        setSearchParams(current => {
          if (current.get("project") !== projectId || current.has("timeline")) return current;
          const next = new URLSearchParams(current); next.set("timeline", timelineRef); return next;
        }, { replace: true });
      }
      toast.success("Timeline ready");
    } catch (error) {
      const safeDetail =
        error instanceof ApiError
          ? `${error.status} ${error.code}: ${error.message.replace(/[\r\n]+/g, " ").slice(0, 120)}`
          : error instanceof RuntimeUnavailableError
            ? `${error.status ?? "unavailable"} ${error.causeCode ?? error.code}`
            : error instanceof Error
              ? error.name
              : "unknown error";
      if (timelineSelectionRef.current.projectId === projectId) setFirstTimelineError(safeDetail);
      toast.error("Could not create the first timeline. You can retry here.");
    } finally {
      setCreatingFirstTimeline(false);
    }
  }, [
    creatingFirstTimeline,
    runtimeDiscovery.projectsQuery,
    runtimeDiscovery.timelinesQuery,
    setSearchParams,
    projectId,
    selectedProject,
    isSwitchBlockedBySave,
  ]);

  // Only authoritative empty project results trigger setup. Bound attempts per
  // mounted project prevent failed creation from becoming a background loop.
  useEffect(() => {
    if (
      !projectId ||
      timelineId ||
      runtimeDiscovery.timelinesQuery.isLoading ||
      runtimeDiscovery.timelinesQuery.isFetching ||
      runtimeDiscovery.timelinesQuery.error ||
      runtimeDiscovery.timelinesQuery.data?.length !== 0 ||
      creatingFirstTimeline ||
      attemptedFirstTimelineProjects.current.has(projectId)
    )
      return;
    attemptedFirstTimelineProjects.current.add(projectId);
    void handleCreateFirstTimeline();
  }, [
    projectId,
    timelineId,
    runtimeDiscovery.timelinesQuery.data,
    runtimeDiscovery.timelinesQuery.isLoading,
    runtimeDiscovery.timelinesQuery.isFetching,
    runtimeDiscovery.timelinesQuery.error,
    creatingFirstTimeline,
    handleCreateFirstTimeline,
  ]);

  const handleCreateAdditionalTimeline = useCallback(async () => {
    if (!selectedProject || !projectId || creatingFirstTimeline || isSwitchBlockedBySave) {
      return;
    }
    setCreatingFirstTimeline(true);
    setFirstTimelineError(null);
    const startingTimelineId = timelineId;
    const knownTimelines = runtimeDiscovery.timelinesQuery.data ?? [];
    const timelineCount = knownTimelines.filter(
      (timeline) => !timeline.is_shot,
    ).length;
    const pending =
      pendingAdditionalTimeline.current?.projectId === projectId
        ? pendingAdditionalTimeline.current
        : {
            projectId: projectId,
            timelineId: generateUUID(),
            name: `Timeline ${timelineCount + 1}`,
          };
    pendingAdditionalTimeline.current = pending;
    try {
      const timelineRef = await createCanonicalTimeline(
        projectId,
        {
          name: pending.name,
          timelineId: pending.timelineId,
          idempotencyKey: `astrid-timeline-create-${projectId}-${pending.timelineId}`,
        },
        new AstridRuntimeClient(),
      );
      await runtimeDiscovery.timelinesQuery.refetch();
      pendingAdditionalTimeline.current = null;
      if (timelineSelectionRef.current.projectId === projectId && timelineSelectionRef.current.timelineId === startingTimelineId && confirmRemountRef.current()) {
        setSearchParams(current => {
          if (current.get("project") !== projectId) return current;
          const next = new URLSearchParams(current); next.set("timeline", timelineRef); return next;
        }, { replace: true });
      }
      toast.success("Timeline ready");
    } catch (error) {
      const safeDetail =
        error instanceof ApiError
          ? `${error.status} ${error.code}: ${error.message.replace(/[\r\n]+/g, " ").slice(0, 120)}`
          : error instanceof RuntimeUnavailableError
            ? `${error.status ?? "unavailable"} ${error.causeCode ?? error.code}`
            : error instanceof Error
              ? error.name
              : "unknown error";
      if (timelineSelectionRef.current.projectId === projectId) setFirstTimelineError(safeDetail);
      toast.error(`Could not create timeline (${safeDetail}). Retry here.`);
    } finally {
      setCreatingFirstTimeline(false);
    }
  }, [
    creatingFirstTimeline,
    runtimeDiscovery.timelinesQuery,
    setSearchParams,
    projectId,
    timelineId,
    selectedProject,
    isSwitchBlockedBySave,
  ]);

  const handleSetPrimaryTimeline = useCallback(
    async (primaryTimelineId: string) => {
      if (!providerSelection?.dataProvider.setPrimaryTimeline || !timelines?.some(t => t.timeline_id === primaryTimelineId) || isSwitchBlockedBySave || settingPrimaryTimelineId !== null) {
        return;
      }
      const startingTimelineId = timelineId;
      setSettingPrimaryTimelineId(primaryTimelineId);
      try {
        await providerSelection.dataProvider.setPrimaryTimeline(primaryTimelineId);
        await Promise.all([
          runtimeDiscovery.projectsQuery.refetch(),
          runtimeDiscovery.timelinesQuery.refetch(),
        ]);
        if (timelineSelectionRef.current.projectId === projectId && timelineSelectionRef.current.timelineId === startingTimelineId && confirmRemountRef.current()) {
          setSearchParams(current => {
            if (current.get("project") !== projectId) return current;
            const next = new URLSearchParams(current); next.set("timeline", primaryTimelineId); return next;
          }, { replace: true });
        }
        toast.success("Primary timeline updated");
      } catch (error) {
        console.error("[video-editor] Failed to set primary timeline", error);
        toast.error("Failed to set the primary timeline");
      } finally {
        setSettingPrimaryTimelineId(null);
      }
    },
    [
      runtimeDiscovery.projectsQuery,
      runtimeDiscovery.timelinesQuery,
      providerSelection,
      timelines,
      isSwitchBlockedBySave,
      settingPrimaryTimelineId,
      projectId,
      timelineId,
      setSearchParams,
    ],
  );

  // Only an absent timeline is auto-selected. Explicit unknown or cross-project
  // selections remain errors instead of opening a different document.
  useEffect(() => {
    if (!selectedProject || timelineId || !timelines || runtimeDiscovery.timelinesQuery.error) return;
    const timeline = chooseRuntimeTimeline(selectedProject, timelines);
    if (!timeline) return;
    setSearchParams(current => {
      if (current.get("project") !== projectId || current.has("timeline")) return current;
      const next = new URLSearchParams(current); next.set("timeline", timeline.timeline_id); return next;
    }, { replace: true });
  }, [selectedProject, timelineId, timelines, runtimeDiscovery.timelinesQuery.error, projectId, setSearchParams]);

  const runtimePickerProps = {
    projects: (runtimeDiscovery.projectsQuery.data ?? []).map((p) => ({
      id: p.project_id,
      name: p.name || "Untitled project",
      detail: p.slug,
    })),
    timelines: (runtimeDiscovery.timelinesQuery.data ?? [])
      .map((t, index) => {
        const name =
          t.name?.trim() ||
          t.slug ||
          (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(t.timeline_id)
            ? t.timeline_id
            : "Untitled timeline");
        const editAt = runtimeDiscovery.timelineEditQueries?.[index]?.data;
        const date = editAt ? new Date(editAt) : null;
        const validDate = date && Number.isFinite(date.getTime()) ? date : null;
        return {
          id: t.timeline_id,
          name,
          isPrimary: t.is_default,
          detail: validDate
            ? `edited ${formatDistanceToNowStrict(validDate, { addSuffix: true })}`
            : undefined,
          editTime: validDate?.getTime() ?? null,
        };
      })
      .filter((row, index) => {
        const timeline = runtimeDiscovery.timelinesQuery.data?.[index];
        return !!timeline && (!timeline.is_shot || timeline.timeline_id === timelineId);
      })
      .sort((a, b) => {
        if (a.editTime === null && b.editTime !== null) return 1;
        if (a.editTime !== null && b.editTime === null) return -1;
        if (a.editTime !== null && b.editTime !== null && a.editTime !== b.editTime)
          return b.editTime - a.editTime;
        return a.name.localeCompare(b.name);
      })
      .map(({ editTime: _editTime, ...row }) => row),
    projectId: tourHeader ? tourHeader.projectId : projectId,
    timelineId: tourHeader ? tourHeader.timelineId : timelineId,
    // The tour is not a project of the user's: its header names win and the pickers stay shut.
    projectName: tourHeader ? tourHeader.projectName : selectedProject?.name,
    timelineName: tourHeader ? tourHeader.timelineName : selectedTimeline?.name?.trim() || selectedTimeline?.slug,
    projectsLoading:
      runtimeDiscovery.projectsQuery.isLoading,
    // The timeline list waits on the project list; a timeline named by the URL
    // is still loading until then, never "unavailable".
    timelinesLoading:
      (!!timelineId && runtimeDiscovery.projectsQuery.isLoading) ||
      (!!selectedProject && runtimeDiscovery.timelinesQuery.isLoading),
    projectsError: runtimeDiscovery.projectsQuery.error?.message,
    timelinesError: runtimeDiscovery.timelinesQuery.error?.message,
    onSelectProject: handleSelectProject,
    onSelectTimeline: handleSelectTimeline,
    onRenameTimeline: async (timelineId: string, name: string) => {
      if (!selectedProject || !timelines?.some(t => t.timeline_id === timelineId)) {
        throw new Error("This timeline is no longer available in the selected project.");
      }
      await new AstridRuntimeClient().renameTimeline(selectedProject.project_id, timelineId, name);
      await runtimeDiscovery.timelinesQuery.refetch();
    },
    onExportTimeline: (timelineId: string, timelineName: string, saveAs = false) => {
      const flushPendingSave = flushTimelineSaveRef.current;
      if (!flushPendingSave) { toast.error("The timeline editor is still loading. Try again in a moment."); return; }
      void exportTimelineArchive({ projectId: projectId ?? "", timelineId, timelineName, flushPendingSave }, { toast: transferToast(), saveAs });
    },
    onImportTimeline: (file: File) => {
      if (!projectId || tourHeader?.disabled) return;
      const startedOn = { ...timelineSelectionRef.current };
      void importTimelineArchive(file, projectId, {
        toast: transferToast(),
        existingNames: (runtimeDiscovery.timelinesQuery.data ?? []).filter((t) => !t.is_shot).flatMap((t) => (t.name ? [t.name] : [])),
        // Open the imported timeline only if the user is still where they started
        // and the same save guard as a manual switch allows it.
        onImported: async (importedId) => {
          try { await runtimeDiscovery.timelinesQuery.refetch(); } catch { return false; }
          const current = timelineSelectionRef.current;
          if (current.projectId !== startedOn.projectId || current.timelineId !== startedOn.timelineId || !confirmRemountRef.current()) return false;
          setSearchParams((search) => {
            if (search.get("project") !== projectId) return search;
            const next = new URLSearchParams(search); next.set("timeline", importedId); return next;
          });
          return true;
        },
      }).catch(() => undefined);
    },
    onCreateTimeline: timelines?.some(t => !t.is_shot) ? handleCreateAdditionalTimeline : handleCreateFirstTimeline,
    creatingTimeline: creatingFirstTimeline,
    onSetPrimaryTimeline: handleSetPrimaryTimeline,
    settingPrimaryTimelineId,
    onRetry: () => void handleRuntimeRetry(),
    disabled: isSwitchBlockedBySave || !!tourHeader?.disabled,
    onOpenChange: setSelectorsOpen,
  };
  const runtimeProjectControls = (
    <ProjectHeaderControls
      projects={runtimePickerProps.projects}
      projectId={runtimePickerProps.projectId}
      projectName={runtimePickerProps.projectName}
      projectsLoading={runtimePickerProps.projectsLoading}
      projectsError={runtimePickerProps.projectsError}
      onRetry={runtimePickerProps.onRetry}
      onOpenChange={runtimePickerProps.onOpenChange}
      onSelectProject={runtimePickerProps.onSelectProject}
      selectedProject={selectedProject}
      pickerDisabled={runtimePickerProps.disabled}
      actionsDisabled={isSwitchBlockedBySave || runtimeDiscovery.projectsQuery.isLoading || !!tourHeader?.disabled}
      onProjectCreated={() => void runtimeDiscovery.projectsQuery.refetch()}
      onProjectUpdated={() => void runtimeDiscovery.projectsQuery.refetch()}
      confirmNavigation={() => confirmRemountRef.current()}
      logoBootTarget
    />
  );
  const runtimeTimelineControls = (
    <>
      <ProjectTimelinePicker
        {...runtimePickerProps}
        showProjectSelector={false}
      />
    </>
  );

  const projectHeaderControls = runtimeProjectControls;
  const timelinePreviewControls = runtimeTimelineControls;
  const headerControlsRef = useRef(projectHeaderControls);
  headerControlsRef.current = projectHeaderControls;
  const headerIdentity = JSON.stringify([
    projectId, timelineId, projects, timelines,
    runtimeDiscovery.projectsQuery.isLoading, runtimeDiscovery.timelinesQuery.isLoading,
    runtimeDiscovery.projectsQuery.error?.message, runtimeDiscovery.timelinesQuery.error?.message,
    isSwitchBlockedBySave, extensionUnsaved, mountedSaveStatus, creatingFirstTimeline, settingPrimaryTimelineId,
    runtimeRetrying, nativeRecovery.retrying,
    tourHeader?.projectName, tourHeader?.timelineName, tourHeader?.disabled,
  ]);

  useEffect(() => {
    if (!hasGlobalHeader) {
      return;
    }
    globalHeaderSlot.setGlobalHeaderContent(headerControlsRef.current);
    return () => globalHeaderSlot.clearGlobalHeaderContent();
  }, [
    headerIdentity,
    globalHeaderSlot.clearGlobalHeaderContent,
    globalHeaderSlot.setGlobalHeaderContent,
    hasGlobalHeader,
  ]);

  // The same header is used for the loaded editor and every page-level
  // fallback, so switching between loading, empty, and editing states does
  // not change the navigation chrome.
  const selectorsHeader = !hasGlobalHeader ? (
    <AppHeader
      navigationMode={isHomeTool ? "tools" : "home"}
      onNavigate={undefined}
      navigationControls={projectHeaderControls}
      timelineName={null}
      showProjectControls={false}
    />
  ) : null;

  const recoveryCardShowing = useRecoveryCardShowing();
  const hosted = runtimeOrigin() !== '';
  const recoveryError = runtimeConnectorError ?? discoveryError;
  const connectionFailed = !!(recoveryError || nativeRecoveryError);
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-transparent">
      {connectionFailed && (
        <RuntimeConnectorRecoveryBanner
          error={recoveryError ?? new Error(nativeRecoveryError ?? "Workspace unavailable")}
          onRetry={providerSelection ? handleRuntimeRetry : runtimeDiscovery.reconnect}
          retrying={!!providerSelection && (runtimeRetrying || nativeRecovery.retrying)}
          projectId={projectId}
          timelineId={timelineId}
          connectionUrl={runtimeOrigin() || (typeof location === "undefined" ? null : location.origin)}
        />
      )}
      {providerSelection ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <VideoEditorProvider
            key={providerSelection.remountKey}
            dataProvider={pageDataProvider ?? providerSelection.dataProvider}
            projectId={providerSelection.projectId}
            projectSlug={providerSelection.projectSlug}
            timelineId={providerSelection.timelineId}
            timelineName={providerSelection.timelineName}
            userId={providerSelection.userId}
            onSaveStatusChange={setMountedSaveStatus}
            onPendingWorkChange={onPendingWorkChange}
            extensions={resolvedExtensions}
            timelineOverlaysEnabled={timelineOverlaysEnabled}
            extensionHostEnabled
            extensionReleaseRevision="shipped"
          >
            <TimelineTransferSaveBridge target={flushTimelineSaveRef} />
            {tourSelection && <EditorTourTimelineDriver />}
            <AstridVideoEditorShell
              mode="full"
              timelineId={providerSelection.timelineId}
              onCreateTimeline={() => void handleCreateAdditionalTimeline()}
              headerNavigationControls={hasGlobalHeader ? undefined : projectHeaderControls}
              previewNavigationControls={timelinePreviewControls}
              navigationMode={isHomeTool ? "tools" : "home"}
              showHeader={!hasGlobalHeader}
            />
          </VideoEditorProvider>
        </div>
      ) : (
        <>
          {selectorsHeader}
          {hosted && recoveryCardShowing ? null : workspaceSettling ? <WorkspaceDiscoveryPending onRetry={() => void runtimeDiscovery.reconnect()} /> : (
            <>
              <div className="px-4 py-2">{timelinePreviewControls}</div>
              <div className="flex flex-1 items-center justify-center px-6">
                <Card className="w-full max-w-md">
                  <CardHeader>
                    <CardTitle>{projectMissing ? "Project not found"
                      : discoveryError ? hosted ? RUNTIME_CONNECTION_COPY.loadFailed.title : selectedProject ? "Timelines unavailable" : "Workspace unavailable"
                      : !projectId ? projects?.length === 0 ? "No projects yet" : "Select a project"
                      : timelineMissing ? "Timeline not found"
                      : "No timeline yet"}</CardTitle>
                    <CardDescription>{projectMissing
                      ? `“${projectId}” is not available in this workspace. Choose an existing project or create one.`
                      : timelineMissing ? "The selected timeline is not available in this project. Choose another timeline."
                      : discoveryError ? hosted ? RUNTIME_CONNECTION_COPY.loadFailed.sentence : discoveryError.message
                      : !projectId ? "Create a project, or choose an existing project."
                      : "Create a blank timeline for this project to open it in the editor."}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {!projectId && projects?.length === 0 && <EmptyWorkspaceGuidance
                      onRefresh={() => void runtimeDiscovery.projectsQuery.refetch()}
                      confirmedEmpty={runtimeDiscovery.projectsQuery.isSuccess && !discoveryError}
                    />}
                    {!projectId && projects?.length === 0 && <div data-testid="empty-workspace-project-action">
                      <ProjectHeaderActions
                        selectedProject={null}
                        onProjectCreated={() => void runtimeDiscovery.projectsQuery.refetch()}
                        disabled={runtimeDiscovery.projectsQuery.isLoading || !!tourHeader?.disabled}
                        confirmNavigation={() => confirmRemountRef.current()}
                      />
                    </div>}
                    {selectedProject && !discoveryError && (!timelineId || (timelineMissing && timelines?.every(t => t.is_shot))) && <Button
                      onClick={() => void handleCreateFirstTimeline()}
                      disabled={creatingFirstTimeline}
                    >{creatingFirstTimeline ? "Creating timeline…" : "Create first timeline"}</Button>}
                    {firstTimelineError && <p className="mt-3 text-xs text-destructive" role="alert">
                      Timeline setup failed ({firstTimelineError}). Retry here or check the connected Astrid Runtime.
                    </p>}
                    {discoveryError && <Button onClick={() => void runtimeDiscovery.reconnect()}>{hosted ? RUNTIME_CONNECTION_COPY.loadFailed.button : "Retry workspace discovery"}</Button>}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </>
      )}
      <EditorTourSlot />
    </div>
  );
}
