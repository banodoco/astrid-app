import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import VideoEditorPage, {
  LAST_OPENED_PROJECT_STORAGE_KEY,
  VIDEO_EDITOR_SWIPE_LOCK_CLASS,
} from "@/tools/video-editor/pages/VideoEditorPage.tsx";
import {
  AstridRuntimeClient,
  RUNTIME_CLIENT_SCOPES,
  RuntimeAuthenticationError,
  RuntimeCompatibilityError,
} from "@/integrations/runtime/client.ts";
import type { DataProvider } from "@/tools/video-editor/data/DataProvider.ts";
import type {
  RuntimeDataProvider,
  RuntimeDataProviderOptions,
} from "@/integrations/runtime/dataProvider.ts";
import type { Transport } from "@/integrations/runtime/generated.ts";
import {
  RUNTIME_SCHEMA_DIGEST,
  RUNTIME_TARGETED_EXECUTION_CAPABILITY,
} from "@/integrations/runtime/contract-metadata.ts";
import { useTimelineQueries } from "@/tools/video-editor/hooks/useTimelineQueries.ts";
import {
  usePollSync,
  type UsePollSyncQueries,
} from "@/tools/video-editor/hooks/usePollSync.ts";
import { assetRegistryQueryKey } from "@/tools/video-editor/hooks/useTimeline.ts";
import { createInteractionState } from "@/tools/video-editor/lib/interaction-state.ts";
import * as timelineData from "@/tools/video-editor/lib/timeline-data.ts";
import { createDefaultTimelineConfig } from "@/tools/video-editor/lib/defaults.ts";
import type {
  TimelineConfig,
  AssetRegistry,
} from "@/tools/video-editor/types/index.ts";
import {
  AgentChatProvider,
  useAgentChatBridge,
} from "@/shared/contexts/AgentChatContext.tsx";
import { setBuiltInExtensionEnabled } from "@/tools/video-editor/runtime/builtInExtensionEnablement.ts";
import { STORAGE_KEYS } from "@/shared/lib/storage/storageKeys.ts";
import { exitEditorTour, getEditorTourState, startEditorTour } from "@/shared/state/editorTourStore.ts";
import {
  registerEditorTourOverlay,
} from "@/tools/video-editor/tour/timeline/editorTourSlot.tsx";

const browserStorage = new Map<string, string>();
const localStorageFixture: Storage = {
  get length() {
    return browserStorage.size;
  },
  clear: () => browserStorage.clear(),
  getItem: (key) => browserStorage.get(key) ?? null,
  key: (index) => Array.from(browserStorage.keys())[index] ?? null,
  removeItem: (key) => browserStorage.delete(key),
  setItem: (key, value) => browserStorage.set(key, String(value)),
};
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);

const state = vi.hoisted(() => ({
  auth: { userId: "user-1" as string | null },
  project: {
    selectedProjectId: "project-1" as string | null,
    setSelectedProjectId: vi.fn((id: string | null) => {
      state.project.selectedProjectId = id;
    }),
  },
  projectCrud: {
    projects: [{ id: "project-1", name: "Project One", user_id: "user-1" }],
    isLoadingProjects: false,
  },
  settings: {
    settings: { lastTimelineId: "timeline-1" as string | undefined },
    update: vi.fn(async () => undefined),
  },
  timelines: {
    data: [
      {
        id: "timeline-1",
        name: "Main timeline",
        updated_at: "2026-06-11T10:00:00Z",
      },
    ] as Array<{
      id: string;
      name: string;
      updated_at?: string | null;
    }>,
    isLoading: false,
    error: null as Error | null,
    timelineMutationsAvailable: false,
    createTimeline: {
      isPending: false,
      mutateAsync: vi.fn(async () => ({ id: "created-timeline" })),
    },
    renameTimeline: {
      mutateAsync: vi.fn(async () => undefined),
    },
    deleteTimeline: {
      mutateAsync: vi.fn(async () => undefined),
    },
  },
  runtimeDiscovery: {
    // Overrides for the mocked Runtime discovery hook: a pending or failed
    // project list, or one that resolved without the URL's project.
    projectsPending: false,
    projectsError: null as Error | null,
    retainDiscoveryDataOnError: false,
    omitRuntimeProject: false,
    includeL04: false,
  },
  discovery: {
    bridgeHealthy: true,
    bridgeDown: false,
    healthLoading: false,
    projectsLoading: false,
    projectsError: null as Error | null,
    projects: [] as {
      slug: string;
      name: string;
      project_id?: string;
      created_at?: string;
    }[],
    timelinesLoading: false,
    // Mirrors react-query's `isPending` for a query that has no data yet and is
    // not fetching (e.g. disabled until the project resolves).
    timelinesPending: false,
    timelinesError: null as Error | null,
    timelines: [] as {
      timeline_id: string;
      timeline_ulid?: string;
      slug?: string;
      name: string;
      is_default?: boolean;
      is_shot?: boolean;
    }[],
    timelineProjectId: null as string | null,
  },
  ensureProjectHasTimeline: vi.fn(async () => "01CREATED"),
  createCanonicalTimeline: vi.fn(async (_projectId: string, request: { timelineId: string; name?: string; idempotencyKey?: string }) => request.timelineId),
  setPrimaryTimeline: vi.fn(async (timelineId: string) => {
    state.discovery.timelines = state.discovery.timelines.map((timeline) => ({
      ...timeline,
      is_default: timeline.timeline_id === timelineId,
    }));
  }),
  selectedProvider: null as DataProvider | null,
  providerProbe: null as React.ComponentType<{
    dataProvider: DataProvider;
    timelineId: string;
  }> | null,
  providerMounts: 0,
  providerUnmounts: 0,
  pendingWorkCallback: null as
    | null
    | ((
        state: import("@/sdk/context.ts").ExtensionPendingWorkState,
      ) => void),
  saveStatusCallback: null as
    | null
    | ((status: "saved" | "saving" | "dirty" | "retrying" | "error") => void),
  confirm: vi.fn(() => true),
  /** Captured extensions prop from the last VideoEditorProvider render (for smoke tests). */
  lastProviderExtensions: null as readonly any[] | null,
  /** Captured timelineOverlaysEnabled prop from the last VideoEditorProvider render. */
  lastTimelineOverlaysEnabled: null as boolean | null,
  /**
   * Dev-local scratchpad array backing the real `devLocalExtensions` module
   * (which is empty on main). Tests push fixture extensions into it.
   */
  devLocalExtensions: [] as any[],
  /**
   * Simulated runtime lifecycle: the mocked provider records one activation
   * entry per extension id when an id enters the extensions prop and one
   * disposal entry when it leaves — mirroring ExtensionLifecycleHost's
   * synchronize() contract (dispose on removal, activate on re-add).
   */
  extensionActivations: [] as string[],
  extensionDisposals: [] as string[],
  nativeProbe: vi.fn(),
  runtimeOnError: null as null | ((error: unknown) => void),
  runtimeCtor: vi.fn(function MockRuntimeProvider(
    this: Record<string, unknown>,
    options: unknown,
  ) {
    this.kind = "runtime";
    this.options = options;
    this.reconnect = vi.fn(async () => undefined);
    this.setPrimaryTimeline = state.setPrimaryTimeline;
    state.runtimeOnError =
      (options as { onRuntimeError?: (error: unknown) => void })
        .onRuntimeError ?? null;
  }),
}));

vi.mock("@/integrations/astrid/nativeEditorConnection.ts", () => ({assertNativeEditorConnection: state.nativeProbe}));

vi.mock("@/integrations/runtime/RuntimeConnectionProvider.tsx", () => ({
  useRuntimeConnection: () => ({ connectedBefore: true }),
  useRuntimeConnectionSafe: () => ({ connectedBefore: true }),
}));

vi.mock("@/shared/contexts/AuthContext.tsx", () => ({
  useAuth: () => state.auth,
}));

vi.mock("@/shared/contexts/ProjectContext.tsx", () => ({
  useProjectSelectionContext: () => state.project,
  useProjectCrudContext: () => state.projectCrud,
  useProjectIdentityContext: () => ({ userId: state.auth.user?.id ?? null }),
}));

// Page routing is covered by useHomeNavigation.test.ts. Keeping that hook real
// here would mount user-preference persistence, which is outside this page
// contract.
vi.mock("@/shared/hooks/useHomeNavigation.ts", () => ({
  useHomeNavigation: () => ({
    navigateHome: vi.fn(),
    targetPath: "/tools/video-editor",
  }),
}));

vi.mock("@/shared/hooks/settings/useToolSettings.ts", () => ({
  useToolSettings: () => state.settings,
}));

vi.mock("@/integrations/runtime/createDefaultTimeline.ts", () => ({
  ensureProjectHasTimeline: (...args: unknown[]) =>
    state.ensureProjectHasTimeline(...(args as [string, unknown])),
  createCanonicalTimeline: (...args: unknown[]) =>
    state.createCanonicalTimeline(...(args as [string, { timelineId: string }, unknown])),
}));

vi.mock("@/tools/video-editor/hooks/useTimelinesList.ts", () => ({
  useTimelinesList: () => state.timelines,
}));

vi.mock(
  "@/tools/video-editor/hooks/useRuntimeEditorDiscovery.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/tools/video-editor/hooks/useRuntimeEditorDiscovery.ts")
      >();
    return {
      ...actual,
      useRuntimeEditorDiscovery: ({
        projectId,
      }: {
        projectId: string | null;
      }) => {
        const override = state.runtimeDiscovery;
        const projects = [
          ...state.discovery.projects.map((p) => ({
            ...p,
            project_id: p.project_id ?? p.slug,
            metadata: {},
          })),
          ...(override.omitRuntimeProject
            ? []
            : [
                {
                  project_id: "project-r",
                  slug: "runtime-project",
                  name: "Runtime project",
                  metadata: {},
                },
              ]),
          ...(override.includeL04 ? [{
            project_id: L04_PROJECT,
            slug: "l04-project",
            name: "L04 project",
            metadata: {},
          }, {
            project_id: "l04-other-project-id",
            slug: "l04-other",
            name: "L04 other project",
            metadata: {},
          }] : []),
        ];
        const listPending = override.projectsPending;
        const listed = listPending || (!!override.projectsError && !override.retainDiscoveryDataOnError) ? null : projects;
        const project =
          listed?.find((p) => p.project_id === projectId) ?? null;
        return {
          project,
          projectsQuery: {
            data: listed ?? undefined,
            isSuccess: listed !== null && !override.projectsError,
            isLoading: listPending,
            isFetching: listPending,
            error: override.projectsError,
            refetch: vi.fn(),
          },
          timelinesQuery: {
            data: project && (state.discovery.timelinesLoading || state.discovery.timelinesPending || (state.discovery.timelinesError && !override.retainDiscoveryDataOnError))
              ? undefined
              : project && state.discovery.timelineProjectId
                && state.discovery.timelineProjectId !== projectId
                ? []
                : projectId === L04_PROJECT
                  ? state.discovery.timelines.length > 0
                    ? state.discovery.timelines
                    : [
                        { timeline_id: L04_TIMELINE, name: "L04 timeline", is_default: true },
                        { timeline_id: "l04-other-timeline", name: "L04 other timeline" },
                      ]
                  : projectId === "l04-other-project-id"
                    ? [{ timeline_id: "l04-other-timeline", name: "L04 other timeline" }]
                : project
                  ? [
                      ...state.discovery.timelines,
                      ...(projectId === "project-r"
                        ? [{ timeline_id: "timeline-r", name: "Runtime timeline" }]
                        : []),
                    ]
                  : undefined,
            isLoading: !!project && (state.discovery.timelinesLoading || state.discovery.timelinesPending),
            isFetching: !!project && state.discovery.timelinesLoading,
            error: project ? state.discovery.timelinesError : null,
            refetch: vi.fn(),
          },
          reconnect: vi.fn(async () => undefined),
        };
      },
    };
  },
);

vi.mock("@/integrations/runtime/dataProvider.ts", () => ({
  RuntimeDataProvider: state.runtimeCtor,
}));

// The dev-local scratchpad is empty on main; tests push fixtures into the
// shared hoisted array so the page's `devLocalExtensions` filter sees them.
vi.mock("@/tools/video-editor/dev/localExtensions.ts", () => ({
  devLocalExtensions: state.devLocalExtensions,
}));

vi.mock("@/tools/video-editor/components/AstridVideoEditorShell.tsx", () => ({
  AstridVideoEditorShell: ({
    timelineId,
    headerNavigationControls,
    previewNavigationControls,
    showHeader,
  }: {
    timelineId: string;
    headerNavigationControls?: React.ReactNode;
    previewNavigationControls?: React.ReactNode;
    showHeader?: boolean;
  }) => (
    <div data-testid="video-editor-shell">
      {timelineId}
      {showHeader && headerNavigationControls}
      {previewNavigationControls}
    </div>
  ),
}));

// The driver needs the real editor store; the page contract is only that it mounts inside the tour's editor.
vi.mock("@/tools/video-editor/tour/runner/EditorTourRunner.tsx", () => ({
  EditorTourRunner: () => <div data-testid="tour-overlay" />,
}));
vi.mock("@/tools/video-editor/tour/timeline/EditorTourTimelineDriver.tsx", () => ({
  EditorTourTimelineDriver: () => <div data-testid="tour-driver" />,
}));

vi.mock("@/tools/video-editor/contexts/VideoEditorProvider.tsx", async () => {
  const ReactModule = await import("react");
  const { useOptionalAgentChatRegistry } =
    await import("@/shared/contexts/AgentChatContext.tsx");

  return {
    VideoEditorProvider: ({
      dataProvider,
      projectId,
      projectSlug,
      timelineId,
      timelineName,
      onSaveStatusChange,
      onPendingWorkChange,
      extensions,
      timelineOverlaysEnabled,
      children,
    }: {
      dataProvider: DataProvider & { kind?: string };
      projectId?: string | null;
      projectSlug?: string | null;
      timelineId: string;
      timelineName?: string | null;
      onSaveStatusChange?: (
        status: "saved" | "saving" | "dirty" | "retrying" | "error",
      ) => void;
      onPendingWorkChange?: (
        state: import("@/sdk/context.ts").ExtensionPendingWorkState,
      ) => void;
      extensions?: readonly any[];
      timelineOverlaysEnabled?: boolean;
      children: React.ReactNode;
    }) => {
      const registry = useOptionalAgentChatRegistry();
      ReactModule.useEffect(() => {
        if (!registry) return;
        registry.register({
          timelineId,
          editorContext: projectId
            ? {
                tool: "video-editor",
                projectId,
                projectSlug: projectSlug ?? null,
                timelineId,
                timelineName: timelineName ?? null,
                timelineSummary: {
                  configVersion: 7,
                  trackCount: 1,
                  clipCount: 2,
                  assetCount: 1,
                  duration: 4,
                },
              }
            : null,
        });
        return registry.unregister;
      }, [registry, projectId, projectSlug, timelineId, timelineName]);
      state.selectedProvider = dataProvider;
      const Probe = state.providerProbe;
      const [saveStatus, setSaveStatus] = ReactModule.useState<
        "saved" | "saving" | "dirty" | "retrying" | "error"
      >("saved");
      state.saveStatusCallback = onSaveStatusChange ?? null;
      state.pendingWorkCallback =
        onPendingWorkChange ?? null;
      state.lastProviderExtensions = extensions ?? null;
      state.lastTimelineOverlaysEnabled = timelineOverlaysEnabled ?? false;

      ReactModule.useEffect(() => {
        state.providerMounts += 1;
        return () => {
          state.providerUnmounts += 1;
          if (state.saveStatusCallback === onSaveStatusChange) {
            state.saveStatusCallback = null;
            state.pendingWorkCallback = null;
          }
        };
      }, []);

      // Simulate the runtime lifecycle (mirrors ExtensionLifecycleHost's
      // synchronize): an id entering the extensions prop is activated once,
      // an id leaving it is disposed once. The direct-extension fast path
      // delivers a fresh list whenever the page's external-store memo changes.
      const prevExtensionIdsRef = ReactModule.useRef<string[]>([]);
      ReactModule.useEffect(() => {
        const ids = (extensions ?? [])
          .map((ext: { manifest?: { id?: unknown } }) =>
            typeof ext?.manifest?.id === "string" ? ext.manifest.id : "",
          )
          .filter((id: string) => id.length > 0);
        const prev = prevExtensionIdsRef.current;
        for (const id of ids) {
          if (!prev.includes(id)) state.extensionActivations.push(id);
        }
        for (const id of prev) {
          if (!ids.includes(id)) state.extensionDisposals.push(id);
        }
        prevExtensionIdsRef.current = ids;
      }, [extensions]);

      ReactModule.useEffect(() => {
        onSaveStatusChange?.(saveStatus);
      }, [onSaveStatusChange, saveStatus]);

      return (
        <div
          data-testid="video-editor-provider"
          data-kind={dataProvider.kind ?? "unknown"}
          data-timeline-id={timelineId}
          data-project-id={projectId ?? ""}
          data-timeline-name={timelineName ?? ""}
          data-timeline-overlays-enabled={String(
            timelineOverlaysEnabled ?? false,
          )}
        >
          <button type="button" onClick={() => setSaveStatus("saving")}>
            status-saving
          </button>
          <button type="button" onClick={() => setSaveStatus("dirty")}>
            status-dirty
          </button>
          <button type="button" onClick={() => setSaveStatus("retrying")}>
            status-retrying
          </button>
          <button type="button" onClick={() => setSaveStatus("error")}>
            status-error
          </button>
          <button type="button" onClick={() => setSaveStatus("saved")}>
            status-saved
          </button>
          <span data-testid="mock-save-status">{saveStatus}</span>
          {Probe && (
            <Probe dataProvider={dataProvider} timelineId={timelineId} />
          )}
          {children}
        </div>
      );
    },
  };
});

/** New timeline is the last row of the timeline picker's list; it reads "Creating timeline…" until a creation settles. */
async function createTimelineFromPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
  await user.click(await screen.findByRole("button", { name: "New timeline" }));
}

function deferred<T = void>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolvePromise = done; });
  return { promise, resolve: (value?: T) => resolvePromise(value as T) };
}

function ChatScopeProbe() {
  const scope = useAgentChatBridge();
  return (
    <output data-testid="chat-scope">
      {JSON.stringify(scope.editorContext)}
    </output>
  );
}

function renderPage(initialEntry: string, withChatScope = false) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[initialEntry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        {withChatScope ? (
          <AgentChatProvider>
            <VideoEditorPage />
            <ChatScopeProbe />
          </AgentChatProvider>
        ) : (
          <VideoEditorPage />
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()) };
}

const L04_PROJECT = "l04-project-id";
const L04_TIMELINE = "l04-timeline";
const L04_HEAD = "l04-head-1";
const L04_NEXT_HEAD = "l04-head-2";
const L04_TOKEN = `sha256:${"a".repeat(64)}`;
const L04_UNKNOWN = `sha256:${"b".repeat(64)}`;
const L04_CARD_URL = `/api/runtime/v1/objects/${encodeURIComponent(L04_TOKEN)}`;
const l04Config: TimelineConfig = {
  ...createDefaultTimelineConfig(),
  clips: [
    {
      id: "l04-card",
      at: 0,
      track: "V1",
      clipType: "end-spanning-layer",
      hold: 1,
      params: { cardAssets: { card0: "l04-card-asset" } },
    },
  ],
};
const l04Registry: AssetRegistry = {
  assets: {
    "l04-card-asset": {
      file: "card.png",
      type: "image/png",
      media_id: L04_TOKEN,
      content_sha256: L04_TOKEN,
    },
  },
};
let l04Queries: ReturnType<typeof useTimelineQueries> | null = null;
let l04Navigate: ReturnType<typeof useNavigate>;

function makeL04Transport() {
  const requests: Array<{ provider: string; method: string; path: string }> =
    [];
  const providers: RuntimeDataProvider[] = [];
  let held = false;
  let revised = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const response = (value: unknown) => ({
    status: 200,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
  const transportFor =
    (provider: string): Transport =>
    async (method, path) => {
      requests.push({ provider, method, path });
      if (path === "/v1/health")
        return response({
          status: "ok",
          protocol: "workspace.v1",
          schema_digest: RUNTIME_SCHEMA_DIGEST,
          runtime_epoch: 1,
          runtime_instance_id: "runtime-instance-l04",
        });
      if (path === "/v1/handshake")
        return response({
          protocol: "workspace.v1",
          schema_digest: RUNTIME_SCHEMA_DIGEST,
          session_id: "l04-session",
          actor_id: "astrid-product-connector",
          realm_id: "l04-realm",
          scopes: RUNTIME_CLIENT_SCOPES,
          capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY],
        });
      if (path === "/v1/realm")
        return response({
          realm_id: "l04-realm",
          display_name: "L04 offline fixture",
          version: 1,
          created_at: "2026-10-08T00:00:00Z",
        });
      const inspection =
        /^\/v1\/projects\/([^/]+)\/timelines\/([^/]+)\/inspect$/.exec(path);
      if (method === "POST" && inspection) {
        if (held) await gate;
        const head = revised ? L04_NEXT_HEAD : L04_HEAD;
        return response({
          project_id: inspection[1],
          timeline_id: inspection[2],
          revision_id: head,
          head_revision_id: head,
          is_current_head: true,
          representation: "canonical_head",
          authority: "runtime_parent_composition",
        });
      }
      const revision =
        /^\/v1\/projects\/([^/]+)\/timelines\/([^/]+)\/composition-revisions\/([^/]+)$/.exec(
          path,
        );
      if (method === "GET" && revision) {
        const next = revision[3] === L04_NEXT_HEAD;
        const registry = next
          ? {
              assets: {
                "l04-card-asset": {
                  ...l04Registry.assets["l04-card-asset"],
                  metadata: { observedRevision: L04_NEXT_HEAD },
                },
              },
            }
          : l04Registry;
        return response({
          project_id: revision[1],
          timeline_id: revision[2],
          revision_id: revision[3],
          content_digest: `sha256:${(next ? "d" : "c").repeat(64)}`,
          payload: { config: l04Config, registry, clips: [], occurrences: [] },
          created_at: "2026-10-08T00:00:00Z",
        });
      }
      throw new Error(
        `Unexpected L04 offline transport request: ${method} ${path}`,
      );
    };
  return {
    requests,
    providers,
    transportFor,
    hold: () => {
      held = true;
    },
    advance: () => {
      revised = true;
      held = false;
      release();
    },
    release: () => {
      held = false;
      release();
    },
  };
}

function L04PollProbe({
  admitted,
  queries,
  dataProvider,
}: {
  admitted: timelineData.TimelineData;
  queries: UsePollSyncQueries;
  dataProvider: DataProvider;
}) {
  const dataRef = React.useRef(admitted);
  const selectedClipIdRef = React.useRef<string | null>(null);
  const selectedTrackIdRef = React.useRef<string | null>(null);
  const editSeqRef = React.useRef(0);
  const pendingOpsRef = React.useRef(0);
  const savedSeqRef = React.useRef(0);
  const configVersionRef = React.useRef(admitted.configVersion);
  const lastSavedSignatureRef = React.useRef(admitted.stableSignature);
  const isSavingRef = React.useRef(false);
  const interactionStateRef = React.useRef(createInteractionState());
  const resolveAssetUrl = React.useCallback(
    (file: string) => dataProvider.resolveAssetUrl(file),
    [dataProvider],
  );
  const commitData = React.useCallback((next: timelineData.TimelineData) => {
    dataRef.current = next;
  }, []);
  usePollSync({
    queries,
    provider: dataProvider,
    resolveAssetUrl,
    commitData,
    dataRef,
    selectedClipIdRef,
    selectedTrackIdRef,
    editSeqRef,
    pendingOpsRef,
    savedSeqRef,
    configVersionRef,
    lastSavedSignatureRef,
    isSavingRef,
    interactionStateRef,
  });
  return (
    <output data-testid="l04-admitted-card">
      {
        (
          admitted.resolvedConfig.clips[0].params?.__astridAssets as
            Record<string, string> | undefined
        )?.card0
      }
    </output>
  );
}

function L04QueryProbe({
  dataProvider,
  timelineId,
}: {
  dataProvider: DataProvider;
  timelineId: string;
}) {
  const resolveAssetUrl = React.useCallback(
    (file: string) => dataProvider.resolveAssetUrl(file),
    [dataProvider],
  );
  const queries = useTimelineQueries(dataProvider, timelineId, resolveAssetUrl);
  l04Queries = queries;
  const [admitted, setAdmitted] =
    React.useState<timelineData.TimelineData | null>(null);
  React.useEffect(() => {
    if (queries.timelineQuery.data)
      setAdmitted((current) => current ?? queries.timelineQuery.data!);
  }, [queries.timelineQuery.data]);
  return admitted ? (
    <L04PollProbe
      admitted={admitted}
      queries={queries}
      dataProvider={dataProvider}
    />
  ) : null;
}

function L04RouteDriver() {
  l04Navigate = useNavigate();
  return null;
}
function renderL04Page(
  entry = `/tools/video-editor?project=${L04_PROJECT}&timeline=${L04_TIMELINE}`,
) {
  state.runtimeDiscovery.includeL04 = true;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[entry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <L04RouteDriver />
        <VideoEditorPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    client,
    refresh: () => view.rerender(tree()),
    navigate: (url: string) => act(() => l04Navigate(url)),
  };
}

async function flushL04() {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  });
}

describe("VideoEditorPage", () => {
  const originalDEV = import.meta.env.DEV;

  beforeAll(() => {
    // Node's jsdom environment can expose window without an available storage origin.
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageFixture,
    });
    // jsdom does not provide scrollIntoView, which cmdk calls internally.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
  });

  beforeEach(() => {
    (import.meta.env as Record<string, unknown>).DEV = true;
    window.localStorage.clear();
    // The tour starts on the first editor mount; these tests are about the editor, so it has been seen.
    window.localStorage.setItem(STORAGE_KEYS.EDITOR_TOUR_SEEN, "1");
    state.auth.userId = "user-1";
    state.project.selectedProjectId = "project-1";
    state.project.setSelectedProjectId.mockClear();
    state.projectCrud.projects = [
      { id: "project-1", name: "Project One", user_id: "user-1" },
    ];
    state.projectCrud.isLoadingProjects = false;
    state.settings.settings = { lastTimelineId: "timeline-1" };
    state.settings.update.mockClear();
    state.timelines.data = [
      {
        id: "timeline-1",
        name: "Main timeline",
        updated_at: "2026-06-11T10:00:00Z",
      },
    ];
    state.timelines.isLoading = false;
    state.timelines.error = null;
    state.timelines.timelineMutationsAvailable = false;
    state.timelines.createTimeline.isPending = false;
    state.timelines.createTimeline.mutateAsync.mockClear();
    state.timelines.renameTimeline.mutateAsync.mockClear();
    state.timelines.deleteTimeline.mutateAsync.mockClear();
    state.runtimeDiscovery.projectsPending = false;
    state.runtimeDiscovery.projectsError = null;
    state.runtimeDiscovery.retainDiscoveryDataOnError = false;
    state.runtimeDiscovery.omitRuntimeProject = false;
    state.runtimeDiscovery.includeL04 = false;
    state.discovery.bridgeHealthy = true;
    state.discovery.bridgeDown = false;
    state.discovery.healthLoading = false;
    state.discovery.projectsLoading = false;
    state.discovery.projectsError = null;
    state.discovery.projects = [{ slug: "ados-talks", name: "Ados Talks" }];
    state.discovery.timelinesLoading = false;
    state.discovery.timelinesPending = false;
    state.discovery.timelinesError = null;
    state.discovery.timelineProjectId = null;
    state.discovery.timelines = [
      {
        timeline_id: "11111111-1111-1111-1111-111111111111",
        timeline_ulid: "01JM4K5N7P0000000000000017",
        slug: "intro-cut",
        name: "Intro Cut",
        is_default: true,
      },
      {
        timeline_id: "22222222-2222-2222-2222-222222222222",
        timeline_ulid: "01JM4K5N7P0000000000000018",
        slug: "alt-cut",
        name: "Alt Cut",
        is_default: false,
      },
    ];
    state.ensureProjectHasTimeline.mockReset().mockResolvedValue("01CREATED");
    state.createCanonicalTimeline.mockReset().mockImplementation(async (_projectId, request) => request.timelineId);
    state.setPrimaryTimeline.mockClear();
    state.selectedProvider = null;
    state.providerProbe = null;
    state.providerMounts = 0;
    state.providerUnmounts = 0;
    state.saveStatusCallback = null;
    state.lastProviderExtensions = null;
    state.lastTimelineOverlaysEnabled = null;
    state.devLocalExtensions.length = 0;
    state.extensionActivations.length = 0;
    state.extensionDisposals.length = 0;
    state.confirm.mockReset();
    state.confirm.mockReturnValue(true);
    state.runtimeCtor.mockClear();
    state.runtimeOnError = null;
    state.nativeProbe.mockReset().mockRejectedValue(new Error("Configured workspace unavailable"));
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("confirm", state.confirm);
    window.confirm = state.confirm;
  });

  afterEach(() => {
    browserStorage.clear();
    vi.unstubAllEnvs();
    (import.meta.env as Record<string, unknown>).DEV = originalDEV;
  });

  afterAll(() => {
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(
        window,
        "localStorage",
        originalLocalStorageDescriptor,
      );
    } else {
      delete (window as Window & { localStorage?: Storage }).localStorage;
    }
  });

  it("guards source imports before any source row exists and confirms staged draft navigation", async () => {
    state.discovery.projects = [{
      slug: 'transcript-project', name: 'Transcript project', project_id: 'project-canonical-id',
    }];
    renderPage(
      "/tools/video-editor?project=project-canonical-id&timeline=11111111-1111-1111-1111-111111111111",
    );
    await screen.findByTestId("video-editor-provider");
    act(() =>
      state.pendingWorkCallback?.({ writing: true, unsaved: false }),
    );
    expect(
      screen.getByRole("combobox", { name: "Select project" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Select timeline" }),
    ).toBeDisabled();
    act(() =>
      state.pendingWorkCallback?.({ writing: false, unsaved: true }),
    );
    state.confirm.mockReturnValue(false);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
    await user.click(await screen.findByText("Alt Cut"));
    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining("project transcript draft"),
    );
    expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
      "data-timeline-id",
      "11111111-1111-1111-1111-111111111111",
    );
  });
  it("offers exactly one header project and one preview timeline selector for direct Runtime URLs", async () => {
    renderPage(
      "/tools/video-editor?project=project-r&timeline=timeline-r&localTest=1",
    );
    await screen.findByTestId("video-editor-provider");
    expect(
      screen.getAllByRole("combobox", { name: "Select project" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("combobox", { name: "Select timeline" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("combobox", { name: "Select project" }),
    ).toHaveTextContent("Runtime project");
    expect(screen.queryByRole("button", { name: "Open tools" })).toBeNull();
    expect(screen.queryByTestId("runtime-project-timeline")).toBeNull();
  });

  it("publishes canonical Runtime project chat scope before any timeline exists and updates it on dropdown selection", async () => {
    state.discovery.timelines = [];
    state.discovery.timelinesLoading = true;
    state.discovery.projects = [
      {
        slug: "fresh-project",
        name: "Fresh project",
        project_id: "runtime-p1",
      },
      {
        slug: "other-project",
        name: "Other project",
        project_id: "runtime-p2",
      },
    ];
    renderPage("/tools/video-editor?project=runtime-p1", true);
    expect(screen.queryByText("No timeline yet")).toBeNull();
    expect(screen.queryByText('Timeline not found')).toBeNull();
    const scope = () =>
      JSON.parse(screen.getByTestId("chat-scope").textContent!);
    await waitFor(() =>
      expect(scope()).toMatchObject({
        projectId: "runtime-p1",
        projectSlug: "fresh-project",
        timelineId: null,
      }),
    );
    expect(screen.queryByTestId("video-editor-provider")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Select project" }));
    await user.click(await screen.findByRole("option", { name: /Other project/ }));
    await waitFor(() =>
      expect(scope()).toMatchObject({
        projectId: "runtime-p2",
        projectSlug: "other-project",
        timelineId: null,
      }),
    );
    expect(
      window.localStorage.getItem(LAST_OPENED_PROJECT_STORAGE_KEY),
    ).toBe("runtime-p2");
    expect(state.runtimeCtor).not.toHaveBeenCalled();
  });

  it("restores the last opened project after discovery completes", async () => {
    state.discovery.projects = [
      {
        slug: "newest-project",
        name: "Newest project",
        created_at: "2026-10-13T10:00:00Z",
      },
      {
        slug: "last-opened-project",
        name: "Last opened project",
        created_at: "2026-10-10T10:00:00Z",
      },
    ];
    window.localStorage.setItem(
      LAST_OPENED_PROJECT_STORAGE_KEY,
      "last-opened-project",
    );

    renderPage("/tools/video-editor");

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Select project" }),
      ).toHaveTextContent("Last opened project"),
    );
  });

  it('resumes a canonical project ID before another project with a colliding slug', async () => {
    state.discovery.projects = [
      { project_id: 'other-id', slug: 'remembered-id', name: 'Colliding alias' },
      { project_id: 'remembered-id', slug: 'remembered-slug', name: 'Remembered project' },
    ];
    window.localStorage.setItem(LAST_OPENED_PROJECT_STORAGE_KEY, 'remembered-id');
    renderPage('/tools/video-editor');

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select project' })).toHaveTextContent('Remembered project'));
    expect(state.runtimeCtor).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'remembered-id' }));
  });

  it("falls back from a stale project preference to the newest project", async () => {
    state.discovery.projects = [
      {
        slug: "older-project",
        name: "Older project",
        created_at: "2026-10-10T10:00:00Z",
      },
      {
        slug: "newest-project",
        name: "Newest project",
        created_at: "2026-10-13T10:00:00Z",
      },
    ];
    window.localStorage.setItem(
      LAST_OPENED_PROJECT_STORAGE_KEY,
      "deleted-project",
    );

    renderPage("/tools/video-editor");

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Select project" }),
      ).toHaveTextContent("Newest project"),
    );
    expect(
      window.localStorage.getItem(LAST_OPENED_PROJECT_STORAGE_KEY),
    ).toBe("newest-project");
  });

  it("keeps an explicit canonical project URL authoritative and reports an unknown project", async () => {
    state.discovery.projects = [
      {
        slug: "stored-project",
        name: "Stored project",
        created_at: "2026-10-13T10:00:00Z",
      },
    ];
    window.localStorage.setItem(
      LAST_OPENED_PROJECT_STORAGE_KEY,
      "stored-project",
    );

    renderPage("/tools/video-editor?project=missing-project");

    expect(
      await screen.findByRole("heading", { name: "Project not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Select project" }),
    ).toHaveTextContent("Project unavailable");
    expect(
      window.localStorage.getItem(LAST_OPENED_PROJECT_STORAGE_KEY),
    ).toBe("stored-project");
  });

  it("keeps an explicit canonical project over a different stored project during discovery", async () => {
    state.discovery.projects = [];
    state.runtimeDiscovery.projectsPending = true;
    window.localStorage.setItem(
      LAST_OPENED_PROJECT_STORAGE_KEY,
      "stored-project",
    );

    const view = renderPage(
      "/tools/video-editor?project=explicit-project",
    );
    expect(
      screen.getByRole("combobox", { name: "Select project" }),
    ).toHaveTextContent("Loading project");

    state.runtimeDiscovery.projectsPending = false;
    state.discovery.projects = [
      {
        slug: "stored-project",
        name: "Stored project",
        created_at: "2026-10-14T10:00:00Z",
      },
      {
        slug: "explicit-project",
        name: "Explicit project",
        created_at: "2026-10-10T10:00:00Z",
      },
    ];
    view.refresh();

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Select project" }),
      ).toHaveTextContent("Explicit project"),
    );
    expect(
      window.localStorage.getItem(LAST_OPENED_PROJECT_STORAGE_KEY),
    ).toBe("explicit-project");
  });


  it("shows project creation when discovery authoritatively returns no projects", async () => {
    state.discovery.projects = [];
    state.runtimeDiscovery.omitRuntimeProject = true;

    renderPage("/tools/video-editor");

    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(screen.getByText("Expected to see your work? It may be in another Astrid folder on this computer.")).toBeInTheDocument();
    expect(screen.getByText("Find my work")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take the editor tour" })).toBeInTheDocument();
    expect(within(screen.getByTestId("empty-workspace-project-action")).getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Select project" }),
    ).toHaveTextContent("Select project");
  });

  it("does not offer the tour for a nonempty or failed project discovery result", async () => {
    const nonempty = renderPage("/tools/video-editor");
    expect(await screen.findByRole("combobox", { name: "Select project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take the editor tour" })).toBeNull();
    nonempty.unmount();

    state.discovery.projects = [];
    state.runtimeDiscovery.omitRuntimeProject = true;
    state.runtimeDiscovery.projectsError = new Error("Runtime busy");
    state.runtimeDiscovery.retainDiscoveryDataOnError = true;
    renderPage("/tools/video-editor");
    expect((await screen.findAllByText("Runtime busy")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Take the editor tour" })).toBeNull();
  });

  it("keeps canonical Runtime identity and full live editor context when a timeline is present", async () => {
    state.discovery.projects = [
      {
        slug: "fresh-project",
        name: "Fresh project",
        project_id: "runtime-p1",
      },
    ];
    renderPage(
      "/tools/video-editor?project=runtime-p1&timeline=11111111-1111-1111-1111-111111111111",
      true,
    );
    await screen.findByTestId("video-editor-provider");
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("chat-scope").textContent!),
      ).toMatchObject({
        projectId: "runtime-p1",
        projectSlug: "fresh-project",
        timelineId: "11111111-1111-1111-1111-111111111111",
        timelineSummary: { configVersion: 7 },
      }),
    );
      expect(state.runtimeCtor).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "runtime-p1" }),
    );
  });

  it("locks horizontal overscroll swipe-back on the root only while the editor is mounted", async () => {
    state.discovery.projects = [
      { slug: "fresh-project", name: "Fresh project", project_id: "runtime-p1" },
    ];
    const view = renderPage(
      "/tools/video-editor?project=runtime-p1&timeline=11111111-1111-1111-1111-111111111111",
    );
    await screen.findByTestId("video-editor-provider");
    expect(document.documentElement.classList.contains(VIDEO_EDITOR_SWIPE_LOCK_CLASS)).toBe(true);
    view.unmount();
    expect(document.documentElement.classList.contains(VIDEO_EDITOR_SWIPE_LOCK_CLASS)).toBe(false);
  });

  it('automatically clears a mounted failure only after a fresh authenticated workspace probe, retaining the editor and draft scope', async () => {
    const ready=deferred();state.nativeProbe.mockImplementationOnce(()=>ready.promise);
    renderPage('/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111');
    const editor=await screen.findByTestId('video-editor-provider'), mounts=state.providerMounts;
    act(()=>state.pendingWorkCallback?.({writing:false,unsaved:true}));
    act(()=>state.runtimeOnError?.(new RuntimeAuthenticationError('/api/runtime')));
    await screen.findByTestId('runtime-connector-alert');
    expect(state.nativeProbe).toHaveBeenCalledOnce();expect(editor).toBeVisible();
    await act(async()=>{ready.resolve();await ready.promise;});
    await waitFor(()=>expect(screen.queryByTestId('runtime-connector-alert')).toBeNull());
    expect(screen.getByTestId('video-editor-provider')).toBe(editor);expect(editor).toBeVisible();expect(state.providerMounts).toBe(mounts);expect(state.providerUnmounts).toBe(0);
  });

  it('shows a schema update banner over the mounted editor and preserves the draft and undo-capable editor instance', async () => {
    const probe = deferred();
    state.nativeProbe.mockImplementationOnce(() => probe.promise);
    renderPage('/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111');
    const editor = await screen.findByTestId('video-editor-provider');
    const mounts = state.providerMounts;
    act(() => state.pendingWorkCallback?.({ writing: false, unsaved: true }));
    act(() => state.runtimeOnError?.(new RuntimeCompatibilityError('schema', 'digest mismatch', '/api/runtime')));
    expect(await screen.findByTestId('runtime-connector-alert')).toBeInTheDocument();
    expect(document.body).toHaveTextContent('Update Astrid');
    expect(document.body).toHaveTextContent('Copy for your agent');
    expect(screen.getByTestId('video-editor-provider')).toBe(editor);
    expect(editor).toBeVisible();
    expect(state.providerMounts).toBe(mounts);
    expect(state.providerUnmounts).toBe(0);
  });

  it('does not let an older successful probe clear a failure reported after that probe started', async () => {
    const older=deferred(), newer=deferred();
    state.nativeProbe.mockImplementationOnce(()=>older.promise).mockImplementationOnce(()=>newer.promise);
    renderPage('/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111');
    const editor=await screen.findByTestId('video-editor-provider');
    act(()=>state.runtimeOnError?.(new RuntimeAuthenticationError('/api/runtime/first')));
    await waitFor(()=>expect(state.nativeProbe).toHaveBeenCalledTimes(1));
    const latest=new RuntimeAuthenticationError('/api/runtime/latest');act(()=>state.runtimeOnError?.(latest));
    await waitFor(()=>expect(state.nativeProbe).toHaveBeenCalledTimes(2));
    await act(async()=>{older.resolve();await older.promise;});
    expect(screen.getByTestId('runtime-connector-alert')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Show full connection error'));
    expect(screen.getByTestId('workspace-connection-diagnostic')).toHaveTextContent(latest.message);
    await act(async()=>{newer.resolve();await newer.promise;});
    await waitFor(()=>expect(screen.queryByTestId('runtime-connector-alert')).toBeNull());expect(screen.getByTestId('video-editor-provider')).toBe(editor);
  });

  it("keeps an unverified URL behind discovery recovery when discovery fails", async () => {
    state.runtimeDiscovery.projectsError = new Error("Runtime busy");
    renderPage(
      "/tools/video-editor?project=project-r&timeline=timeline-r",
    );

    expect(await screen.findByTestId("runtime-connector-alert")).toBeInTheDocument();
    expect(screen.queryByTestId("video-editor-provider")).toBeNull();
    expect(state.runtimeCtor).not.toHaveBeenCalled();
  });

  it("keeps the verified editor and drafts mounted through a discovery refetch failure", async () => {
    const view = renderPage('/tools/video-editor?project=project-r&timeline=timeline-r');
    const editor = await screen.findByTestId('video-editor-provider');
    act(() => state.pendingWorkCallback?.({ writing: false, unsaved: true }));
    state.runtimeDiscovery.retainDiscoveryDataOnError = true;
    state.runtimeDiscovery.projectsError = new Error('Runtime temporarily unavailable');
    state.discovery.timelinesError = new Error('Timeline refresh failed');
    view.refresh();

    expect(await screen.findByTestId('runtime-connector-alert')).toBeInTheDocument();
    expect(screen.getByTestId('video-editor-provider')).toBe(editor);
    expect(state.providerMounts).toBe(1);
    expect(state.providerUnmounts).toBe(0);
  });

  it("shows a loading state, never 'not available', while the project list is pending", async () => {
    state.runtimeDiscovery.projectsPending = true;
    renderPage("/tools/video-editor?project=project-r");

    // The header's picker holds a quiet loading bar; no status card or copy. A
    // first load keeps the boot layer up meanwhile.
    expect(await screen.findByText("Loading project")).toBeInTheDocument();
    expect(screen.queryByText("Connecting to workspace…")).toBeNull();
    expect(
      screen.queryByText(/not available in this workspace/),
    ).toBeNull();
    expect(screen.queryByText("Project not found")).toBeNull();
  });

  it("reports 'not available' only after the resolved list lacks the project", async () => {
    state.runtimeDiscovery.omitRuntimeProject = true;
    renderPage("/tools/video-editor?project=project-r");

    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeInTheDocument();
    expect(screen.getByText(/not available in this workspace/)).toBeInTheDocument();
    expect(document.querySelector("[data-boot-hold]")).toBeNull();
    expect(screen.queryByText("Connecting to workspace…")).toBeNull();
  });

  it("surfaces Runtime auth recovery in the existing Runtime editor route", async () => {
    renderPage(
      "/tools/video-editor?project=project-r&timeline=timeline-r",
    );

    await screen.findByTestId("video-editor-provider");
    expect(state.runtimeCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-r",
        onRuntimeError: expect.any(Function),
      }),
    );
    expect(screen.queryByTestId("astrid-acp-session-controls")).toBeNull();

    act(() => {
      state.runtimeOnError?.(new RuntimeAuthenticationError("/api/runtime"));
    });

    expect(
      await screen.findByTestId("runtime-connector-alert"),
    ).toHaveTextContent("Workspace Runtime authentication failed");
    await waitFor(()=>expect(screen.getByRole('button',{name:'Retry Runtime connection'})).toBeEnabled());
    state.nativeProbe.mockResolvedValueOnce(undefined);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry Runtime connection" }));
    expect(state.runtimeCtor.mock.instances[0].reconnect).toHaveBeenCalledTimes(
      1,
    );
  });


  it('reports an unknown canonical project id as not found without building a provider', async () => {
    renderPage('/tools/video-editor?project=missing-project&timeline=timeline-r');

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(state.runtimeCtor).not.toHaveBeenCalled();
  });

  it('keeps an explicit canonical project pending while discovery is loading', async () => {
    state.runtimeDiscovery.projectsPending = true;
    const view = renderPage('/tools/video-editor?project=project-r&timeline=timeline-r', true);

    expect(await screen.findByText('Loading project')).toBeInTheDocument();
    expect(screen.queryByText('Connecting to workspace…')).toBeNull();
    expect(screen.queryByText(/not found|not available|unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('video-editor-provider')).toBeNull();
    expect(state.runtimeCtor).not.toHaveBeenCalled();
    state.runtimeDiscovery.projectsPending = false;
    view.refresh();
    expect(await screen.findByTestId('video-editor-provider')).toBeInTheDocument();
    expect(state.runtimeCtor).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-r' }));
  });

  it('does not mount a provider when timeline verification rejects a cross-project row', async () => {
    state.discovery.timelinesError = new Error('Runtime returned a timeline belonging to a different project.');
    renderPage('/tools/video-editor?project=project-r&timeline=timeline-r');

    expect(await screen.findByTestId('runtime-connector-alert')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Timelines unavailable', hidden: true })).toBeInTheDocument();
    expect(state.runtimeCtor).not.toHaveBeenCalled();
  });

  it("does not expose manual ACP controls even when the retired debug flag is present", async () => {
    renderPage(
      "/tools/video-editor?project=project-r&timeline=timeline-r&acpDebug=1",
    );

    await screen.findByTestId("video-editor-provider");
    expect(screen.queryByTestId("astrid-acp-session-controls")).toBeNull();
  });

  it("does not loop timeline creation when Astrid returns an empty list", async () => {
    state.discovery.projects = [];
    state.runtimeDiscovery.omitRuntimeProject = true;
    state.settings.settings = { lastTimelineId: undefined };
    state.timelines.data = [];
    state.timelines.timelineMutationsAvailable = false;

    // Bare editor routes are Astrid-first now. They must not enter the retired
    // relational auto-create path just because no Astrid timeline is selected.
    const view = renderPage("/tools/video-editor");
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create timeline" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/tools/video-editor"]}>
          <VideoEditorPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.timelines.createTimeline.mutateAsync).not.toHaveBeenCalled();
    expect(state.timelines.renameTimeline.mutateAsync).not.toHaveBeenCalled();
    expect(state.timelines.deleteTimeline.mutateAsync).not.toHaveBeenCalled();
  });

  it("renames the current timeline from the canonical editor route", async () => {
    state.discovery.projects = [
      {
        slug: "ados-talks",
        name: "Ados Talks",
        project_id: "project-canonical-id",
      },
    ];
    const renameTimeline = vi
      .spyOn(AstridRuntimeClient.prototype, "renameTimeline")
      .mockResolvedValue(
        {} as Awaited<ReturnType<AstridRuntimeClient["renameTimeline"]>>,
      );

    renderPage(
      "/tools/video-editor?project=project-canonical-id&timeline=11111111-1111-1111-1111-111111111111",
    );
    await screen.findByTestId("video-editor-provider");

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
    await user.click(
      await screen.findByRole("button", { name: "Rename timeline" }),
    );
    await user.clear(screen.getByRole("textbox", { name: "Timeline name" }));
    await user.type(
      screen.getByRole("textbox", { name: "Timeline name" }),
      "Renamed intro",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(renameTimeline).toHaveBeenCalledWith(
        "project-canonical-id",
        "11111111-1111-1111-1111-111111111111",
        "Renamed intro",
      );
    });
  });

  it("automatically creates and opens Main from the authoritative empty-project state", async () => {
    state.discovery.projects = [
      {
        slug: "demo-project",
        name: "Demo Project",
        project_id: "project-canonical-id",
      },
    ];
    state.discovery.timelines = [];
    state.ensureProjectHasTimeline.mockImplementation(async () => {
      state.discovery.timelines = [{ timeline_id: "01CREATED", name: "Main" }];
      return "01CREATED";
    });
    renderPage("/tools/video-editor?project=project-canonical-id");

    const provider = await screen.findByTestId("video-editor-provider");
    expect(provider).toHaveAttribute("data-kind", "runtime");
    expect(provider).toHaveAttribute("data-timeline-id", "01CREATED");
    expect(state.ensureProjectHasTimeline).toHaveBeenCalledWith(
      "project-canonical-id",
      expect.anything(),
    );
    expect(state.runtimeCtor).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-canonical-id" }),
    );
  });

  it("does not retry failed automatic Main timeline creation on every render", async () => {
    state.discovery.projects = [
      {
        slug: "demo-project",
        name: "Demo Project",
        project_id: "project-canonical-id",
      },
    ];
    state.discovery.timelines = [];
    state.ensureProjectHasTimeline.mockRejectedValue(new Error("unavailable"));
    renderPage("/tools/video-editor?project=project-canonical-id");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create first timeline" })).toBeEnabled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.ensureProjectHasTimeline).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Create first timeline" }),
    ).toBeEnabled();
  });

  it("offers first-timeline creation when a deleted timeline is still in the URL", async () => {
    state.discovery.projects = [{
      slug: "demo-project",
      name: "Demo Project",
      project_id: "project-canonical-id",
    }];
    state.discovery.timelines = [];

    renderPage("/tools/video-editor?project=project-canonical-id&timeline=deleted-timeline");

    expect(await screen.findByText("Timeline not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create first timeline" })).toBeEnabled();
    expect(state.ensureProjectHasTimeline).not.toHaveBeenCalled();
  });

  it("retries additional timeline creation with the same idempotency identity", async () => {
    state.createCanonicalTimeline
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementationOnce(async (_projectId, request) => request.timelineId);
    renderPage("/tools/video-editor?project=project-r&timeline=timeline-r");
    await screen.findByTestId("video-editor-provider");

    const user = userEvent.setup();
    await createTimelineFromPicker(user);
    await waitFor(() => expect(state.createCanonicalTimeline).toHaveBeenCalledOnce());
    await createTimelineFromPicker(user);
    await waitFor(() => expect(state.createCanonicalTimeline).toHaveBeenCalledTimes(2));

    const firstRequest = state.createCanonicalTimeline.mock.calls[0];
    const retryRequest = state.createCanonicalTimeline.mock.calls[1];
    expect(firstRequest[0]).toBe("project-r");
    expect(retryRequest[0]).toBe("project-r");
    expect(retryRequest[1]).toEqual(firstRequest[1]);
    expect(retryRequest[1]).toMatchObject({
      name: "Timeline 4",
      idempotencyKey: expect.stringContaining("astrid-timeline-create-project-r-"),
    });
  });

  it("does not let an additional timeline completion switch away during a save", async () => {
    const creation = deferred<string>();
    state.createCanonicalTimeline.mockReturnValueOnce(creation.promise as never);
    renderPage("/tools/video-editor?project=project-r&timeline=timeline-r");
    const provider = await screen.findByTestId("video-editor-provider");
    const user = userEvent.setup();
    await createTimelineFromPicker(user);
    await waitFor(() => expect(state.createCanonicalTimeline).toHaveBeenCalledOnce());

    act(() => state.saveStatusCallback?.("saving"));
    await act(async () => {
      creation.resolve("timeline-created");
      await creation.promise;
    });

    expect(screen.getByTestId("video-editor-provider")).toBe(provider);
    expect(provider).toHaveAttribute("data-timeline-id", "timeline-r");
    expect(state.providerMounts).toBe(1);
  });

  it("marks and selects the new primary timeline through the Runtime provider", async () => {
    renderPage("/tools/video-editor?project=project-r&timeline=timeline-r");
    await screen.findByTestId("video-editor-provider");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
    await user.click(screen.getByRole("button", { name: "Make Alt Cut primary" }));

    await waitFor(() => expect(state.setPrimaryTimeline).toHaveBeenCalledWith("22222222-2222-2222-2222-222222222222"));
    await waitFor(() => expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
      "data-timeline-id", "22222222-2222-2222-2222-222222222222",
    ));
    // The closed trigger now carries the primary star for the current timeline.
    expect(
      within(screen.getByRole("combobox", { name: "Select timeline" })).getByRole("img", { name: "Primary timeline" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
    const row = await screen.findByRole("option", { name: /Alt Cut/ });
    expect(within(row).getByRole("img", { name: "Primary timeline" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make Alt Cut primary" })).toBeNull();
  });

  it("rejects a timeline id discovered under a different project", async () => {
    state.discovery.projects = [
      { slug: "project-one", name: "Project One", project_id: "project-one" },
      { slug: "project-two", name: "Project Two", project_id: "project-two" },
    ];
    state.discovery.timelines = [
      { timeline_id: "timeline-two", name: "Project Two timeline" },
    ];
    state.discovery.timelineProjectId = "project-two";
    renderPage("/tools/video-editor?project=project-two&timeline=timeline-one");

    expect(await screen.findByRole("heading", { name: "Timeline not found" })).toBeInTheDocument();
    expect(screen.queryByTestId("video-editor-provider")).toBeNull();
    expect(state.runtimeCtor).not.toHaveBeenCalled();
  });

  it('keeps the selected shot visible while hiding other shot timelines', async () => {
    state.discovery.timelines.push(
      { timeline_id: 'selected-shot', name: 'Selected shot', is_shot: true },
      { timeline_id: 'other-shot', name: 'Other shot', is_shot: true },
    );
    renderPage('/tools/video-editor?project=project-r&timeline=selected-shot');
    await screen.findByTestId('video-editor-provider');
    const picker = screen.getByRole('combobox', { name: 'Select timeline' });
    expect(picker).toHaveTextContent('Selected shot');
    await userEvent.setup().click(picker);

    expect(screen.getByRole('option', { name: /Selected shot/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Other shot/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Intro Cut/ })).toBeInTheDocument();
  });



  it("remounts the editor when the canonical timeline selection changes", async () => {
    const first = renderPage(
      "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
    );

    const provider = await screen.findByTestId("video-editor-provider");
    expect(provider).toHaveAttribute(
      "data-timeline-id",
      "11111111-1111-1111-1111-111111111111",
    );
    expect(state.providerMounts).toBe(1);

    // A new explicit selection (different URL) mounts a fresh editor.
    first.unmount();
    renderPage(
      "/tools/video-editor?project=ados-talks&timeline=22222222-2222-2222-2222-222222222222",
    );

    await waitFor(() => {
      expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
        "data-timeline-id",
        "22222222-2222-2222-2222-222222222222",
      );
    });
    expect(state.providerMounts).toBe(2);
  });

  it("renders only Astrid projects in the selector dropdown", async () => {
    renderPage(
      "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
    );

    await screen.findByTestId("video-editor-provider");

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Select project" }));

    expect(screen.queryByText("Astrid App projects")).toBeNull();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Project One/ })).toBeNull();
    expect(
      screen.getByRole("option", { name: /Ados Talks/ }),
    ).toBeInTheDocument();
  });




  it("auto-picks the default timeline when a canonical project has no timeline", async () => {
    renderPage("/tools/video-editor?project=ados-talks");

    const provider = await screen.findByTestId("video-editor-provider");
    expect(provider).toHaveAttribute("data-kind", "runtime");
    // Auto-pick selects the ULID as the routable ref.
    expect(provider).toHaveAttribute(
      "data-timeline-id",
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("shows a loading state, never 'No timeline yet', while the timelines query has not started", async () => {
    state.discovery.timelinesPending = true;
    renderPage("/tools/video-editor?project=ados-talks");
    expect(screen.queryByText("No timeline yet")).toBeNull();
    expect(screen.queryByTestId("video-editor-provider")).toBeNull();
  });

  it("auto-picks the first timeline when no default exists", async () => {
    state.discovery.timelines = [
      {
        timeline_id: "22222222-2222-2222-2222-222222222222",
        timeline_ulid: "01JM4K5N7P0000000000000018",
        slug: "alt-cut",
        name: "Alt Cut",
        is_default: false,
      },
    ];
    renderPage("/tools/video-editor?project=ados-talks");

    const provider = await screen.findByTestId("video-editor-provider");
    expect(provider).toHaveAttribute("data-kind", "runtime");
    // Auto-pick selects the ULID as the routable ref.
    expect(provider).toHaveAttribute(
      "data-timeline-id",
      "22222222-2222-2222-2222-222222222222",
    );
  });

  it("renders the selectors with the current canonical selection while keeping the editor mounted", async () => {

    renderPage(
      "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
    );

    const provider = await screen.findByTestId("video-editor-provider");
    expect(provider.parentElement?.parentElement).toHaveClass("bg-transparent");
    expect(provider.parentElement?.parentElement).not.toHaveClass("bg-background");

    expect(
      screen.getByRole("combobox", { name: "Select project" }),
    ).toHaveTextContent("Ados Talks");
    // Timeline label = the discovered timeline's name.
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Select timeline" }),
      ).toHaveTextContent("Intro Cut");
    });
  });





  it("passes a save-status callback into the mounted provider", async () => {
    renderPage(
      "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
    );

    await screen.findByTestId("video-editor-provider");
    expect(state.saveStatusCallback).toBeTypeOf("function");
  });

  it("switching projects with a clean editor auto-picks a timeline and remounts", async () => {
    state.discovery.projects = [
      { slug: "ados-talks", name: "Ados Talks" },
      { slug: "other-project", name: "Other Project" },
    ];

    renderPage(
      "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
    );

    const provider = await screen.findByTestId("video-editor-provider");
    await waitFor(() => {
      expect(screen.getByTestId("mock-save-status")).toHaveTextContent("saved");
    });
    expect(state.providerMounts).toBe(1);

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Select project" }));
    await user.click(await screen.findByText("Other Project"));

    await waitFor(() => {
      expect(state.providerMounts).toBe(2);
    });
    expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
      "data-kind",
      "runtime",
    );
    // Auto-pick selects the ULID as the routable ref.
    expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
      "data-timeline-id",
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("blocks switching while the editor is saving", async () => {
    await mountEditor();

    act(() => {
      state.saveStatusCallback?.("saving");
    });

    expect(
      screen.getByRole("combobox", { name: "Select project" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Select timeline" }),
    ).toBeDisabled();

    // Still on the same timeline — switch blocked without confirm
    expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
      "data-timeline-id",
      "11111111-1111-1111-1111-111111111111",
    );
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("blocks switching while the editor is retrying a transport failure", async () => {
    await mountEditor();

    act(() => {
      state.saveStatusCallback?.("retrying");
    });

    // A retry is scheduled (a save WILL happen) — switching would abandon it,
    // so both selectors are disabled and no confirm dialog is offered.
    expect(
      screen.getByRole("combobox", { name: "Select project" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Select timeline" }),
    ).toBeDisabled();
    expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
      "data-timeline-id",
      "11111111-1111-1111-1111-111111111111",
    );
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("confirms dirty-state timeline switches when accepted and blocks when declined", async () => {
    await mountEditor();

    // Dirty + denied → switch must be blocked, provider unchanged
    state.confirm.mockReturnValue(false);
    fireEvent.click(screen.getByText("status-dirty"));
    await waitFor(() => {
      expect(screen.getByTestId("mock-save-status")).toHaveTextContent("dirty");
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
    await user.click(await screen.findByText("Alt Cut"));

    expect(state.confirm).toHaveBeenCalledWith(
      "You have unsaved timeline changes. Switch editors and discard them?",
    );
    expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
      "data-kind",
      "runtime",
    );

    // Reset to saved, then dirty + confirmed → confirm is called
    state.confirm.mockReset();
    state.confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText("status-saved"));
    await waitFor(() => {
      expect(screen.getByTestId("mock-save-status")).toHaveTextContent("saved");
    });
    fireEvent.click(screen.getByText("status-dirty"));
    await waitFor(() => {
      expect(screen.getByTestId("mock-save-status")).toHaveTextContent("dirty");
    });

    await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
    await user.click(await screen.findByText("Alt Cut"));

    expect(state.confirm).toHaveBeenCalledWith(
      "You have unsaved timeline changes. Switch editors and discard them?",
    );
    await waitFor(() => {
      expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
        "data-kind",
        "runtime",
      );
      expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
        "data-timeline-id",
        "22222222-2222-2222-2222-222222222222",
      );
    });
  });

  it("confirms error-state timeline switches and blocks when declined", async () => {
    await mountEditor();

    // Error + denied → switch blocked
    state.confirm.mockReturnValue(false);
    act(() => {
      state.saveStatusCallback?.("error");
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
    await user.click(await screen.findByText("Alt Cut"));

    expect(state.confirm).toHaveBeenCalledWith(
      "The last timeline save failed. Switch editors anyway?",
    );
    expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
      "data-kind",
      "runtime",
    );

    // Error + confirmed → confirm was honored
    state.confirm.mockReset();
    state.confirm.mockReturnValue(true);
    act(() => {
      state.saveStatusCallback?.("saved");
      state.saveStatusCallback?.("error");
    });

    await user.click(screen.getByRole("combobox", { name: "Select timeline" }));
    await user.click(await screen.findByText("Alt Cut"));

    expect(state.confirm).toHaveBeenCalledWith(
      "The last timeline save failed. Switch editors anyway?",
    );
    await waitFor(() => {
      expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
        "data-kind",
        "runtime",
      );
      expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
        "data-timeline-id",
        "22222222-2222-2222-2222-222222222222",
      );
    });
  });


  async function mountEditor() {
    renderPage(
      "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
    );
    const provider = await screen.findByTestId("video-editor-provider");
    expect(provider).toHaveAttribute("data-kind", "runtime");
    await waitFor(() => {
      expect(screen.getByTestId("mock-save-status")).toHaveTextContent("saved");
    });
    return provider;
  }

  // ---------------------------------------------------------------------------
  // ?extensionSmoke=1 in the stock app path
  // ---------------------------------------------------------------------------

  describe("editor tour selection", () => {
    const USER_ENTRY = "/tools/video-editor?project=project-r&timeline=timeline-r";

    afterEach(() => {
      exitEditorTour();
      registerEditorTourOverlay(null);
    });

    it("mounts an in-memory local-mode editor while the tour runs and restores the user's own selection on exit", async () => {
      renderPage(USER_ENTRY);
      const userEditor = await screen.findByTestId("video-editor-provider");
      expect(userEditor).toHaveAttribute("data-kind", "runtime");
      expect(userEditor).toHaveAttribute("data-project-id", "project-r");
      const userProvider = state.selectedProvider!;
      const runtimeConstructions = state.runtimeCtor.mock.calls.length;
      const fetchCalls = vi.mocked(fetch).mock.calls.length;
      expect(screen.queryByTestId("tour-driver")).toBeNull();

      act(() => startEditorTour());

      const tourEditor = await screen.findByTestId("tour-driver").then(() => screen.getByTestId("video-editor-provider"));
      expect(tourEditor).toHaveAttribute("data-timeline-id", "tour-timeline");
      expect(tourEditor).toHaveAttribute("data-project-id", "");
      expect(tourEditor).toHaveAttribute("data-kind", "unknown");
      const tourProvider = state.selectedProvider!;
      expect(tourProvider).not.toBe(userProvider);
      expect(tourProvider.persistenceEnabled).toBe(false);
      expect(screen.getByRole("combobox", { name: "Select project" })).toHaveTextContent("Onboarding project");
      expect(screen.getByRole("combobox", { name: "Select timeline" })).toHaveTextContent("Lantern Valley");
      await expect(tourProvider.saveTimeline("tour-timeline", {} as never, 1)).rejects.toThrow(/in memory only/);
      // The user's Runtime provider is neither rebuilt nor reached; the tour made no request.
      expect(state.runtimeCtor.mock.calls.length).toBe(runtimeConstructions);
      expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCalls);
      expect(state.providerMounts).toBe(2);
      expect(state.providerUnmounts).toBe(1);

      act(() => exitEditorTour());

      await waitFor(() => expect(screen.queryByTestId("tour-driver")).toBeNull());
      const restored = screen.getByTestId("video-editor-provider");
      expect(restored).toHaveAttribute("data-kind", "runtime");
      expect(restored).toHaveAttribute("data-project-id", "project-r");
      expect(restored).toHaveAttribute("data-timeline-id", "timeline-r");
      expect(state.selectedProvider).toBe(userProvider);
      expect(state.runtimeCtor.mock.calls.length).toBe(runtimeConstructions);
      expect(state.providerMounts).toBe(3);
      expect(state.providerUnmounts).toBe(2);
    });

    it("gives every run its own editor and in-memory provider (Replay starts from an empty demo)", async () => {
      renderPage(USER_ENTRY);
      await screen.findByTestId("video-editor-provider");

      act(() => startEditorTour());
      await screen.findByTestId("tour-driver");
      const firstRun = state.selectedProvider!;
      act(() => exitEditorTour());
      await waitFor(() => expect(screen.queryByTestId("tour-driver")).toBeNull());

      act(() => startEditorTour());
      await screen.findByTestId("tour-driver");
      expect(state.selectedProvider).not.toBe(firstRun);
      expect(state.selectedProvider!.persistenceEnabled).toBe(false);
      expect(state.providerMounts).toBe(4);
    });

    it("renders the runner's overlay in the page's slot only while the tour runs", async () => {
      renderPage(USER_ENTRY);
      await screen.findByTestId("video-editor-provider");
      expect(screen.queryByTestId("tour-overlay")).toBeNull();

      act(() => startEditorTour());
      expect(await screen.findByTestId("tour-overlay")).toBeInTheDocument();

      act(() => exitEditorTour());
      await waitFor(() => expect(screen.queryByTestId("tour-overlay")).toBeNull());
    });
  });

  describe("?extensionSmoke=1 page integration", () => {
    it("does not change the native tool catalog for test-only URL flags", async () => {
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111&localTest=1&extensionSmoke=1&timelineOverlayCanary=1",
      );
      await screen.findByTestId("video-editor-provider");
      expect(state.lastProviderExtensions ?? []).toHaveLength(0);
      expect(state.lastTimelineOverlaysEnabled).toBe(false);
    });

    it("does NOT pass the smoke extension when ?extensionSmoke is absent", async () => {
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");

      // No smoke extension — provider receives empty or no extensions
      expect(state.lastProviderExtensions ?? []).toHaveLength(0);
    });

    it("does NOT pass the smoke extension when extensionSmoke=0 (not exactly 1)", async () => {
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111&extensionSmoke=0",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");

      expect(state.lastProviderExtensions ?? []).toHaveLength(0);
    });

    it("does NOT pass the smoke extension when extensionSmoke is empty", async () => {
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111&extensionSmoke",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");

      expect(state.lastProviderExtensions ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // ?timelineOverlayCanary=1 — DEV-only canary gate for the timelineOverlay family
  // ---------------------------------------------------------------------------

  describe("?timelineOverlayCanary=1 (DEV canary gate)", () => {
    it("does not change native overlay capability for a canary URL", async () => {
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111&timelineOverlayCanary=1",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");
      expect(state.lastTimelineOverlaysEnabled).toBe(false);
      expect(provider).toHaveAttribute(
        "data-timeline-overlays-enabled",
        "false",
      );
    });

    it("keeps the overlay dark in DEV when the canary query is absent", async () => {
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");
      expect(state.lastTimelineOverlaysEnabled).toBe(false);
      expect(provider).toHaveAttribute(
        "data-timeline-overlays-enabled",
        "false",
      );
    });

    it("ignores a non-1 canary value in DEV (only exactly 1 enables)", async () => {
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111&timelineOverlayCanary=0",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(state.lastTimelineOverlaysEnabled).toBe(false);
      expect(provider).toHaveAttribute(
        "data-timeline-overlays-enabled",
        "false",
      );
    });

    it("ignores the canary query in production (DEV off) — the query must never be honored outside DEV", async () => {
      (import.meta.env as Record<string, unknown>).DEV = false;
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111&timelineOverlayCanary=1",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");
      expect(state.lastTimelineOverlaysEnabled).toBe(false);
      expect(provider).toHaveAttribute(
        "data-timeline-overlays-enabled",
        "false",
      );
    });


  });

  // ---------------------------------------------------------------------------
  // Extension-driven overlay gate — an enabled dev-local extension that
  // declares a `timelineOverlay` contribution mounts the host without the
  // canary query (DEV only; production drops devLocalExtensions entirely).
  // ---------------------------------------------------------------------------

  describe("timelineOverlay host gate via enabled dev-local extension (DEV)", () => {
    const OVERLAY_EXT_ID = "haus.astrid.dev.overlay-fixture";

    function makeOverlayDevLocalExtension() {
      return {
        manifest: {
          id: OVERLAY_EXT_ID,
          version: "0.1.0",
          label: "Local Overlay Fixture",
          description: "A dev-local overlay extension for host-gate tests.",
          apiVersion: 1,
          contributions: [
            {
              id: `${OVERLAY_EXT_ID}-overlay`,
              kind: "timelineOverlay",
              render: `${OVERLAY_EXT_ID}-overlay`,
              order: 5,
              label: "Local Overlay Fixture",
            },
          ],
        },
        activate: vi.fn(() => ({ dispose: vi.fn() })),
      };
    }

    it("mounts the overlay host when an overlay-capable dev-local extension is enabled (no URL param)", async () => {
      state.devLocalExtensions.push(makeOverlayDevLocalExtension());
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");
      expect(state.lastTimelineOverlaysEnabled).toBe(true);
      expect(provider).toHaveAttribute(
        "data-timeline-overlays-enabled",
        "true",
      );
    });

    it("keeps the host dark when the enabled dev-local extension has no timelineOverlay contribution", async () => {
      state.devLocalExtensions.push({
        manifest: {
          id: "haus.astrid.dev.slot-only-fixture",
          version: "0.1.0",
          label: "Local Slot Fixture",
          description: "A dev-local slot-only extension for host-gate tests.",
          apiVersion: 1,
          contributions: [
            {
              id: "haus.astrid.dev.slot-only-fixture-status",
              kind: "slot",
              slot: "statusBar",
              render: "haus.astrid.dev.slot-only-fixture-status",
              label: "Local Slot Fixture Status",
            },
          ],
        },
        activate: vi.fn(() => ({ dispose: vi.fn() })),
      });
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(state.lastTimelineOverlaysEnabled).toBe(false);
      expect(provider).toHaveAttribute(
        "data-timeline-overlays-enabled",
        "false",
      );
    });

    it("drops the overlay gate when the overlay extension is disabled through the external store", async () => {
      state.devLocalExtensions.push(makeOverlayDevLocalExtension());
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(state.lastTimelineOverlaysEnabled).toBe(true);

      act(() => {
        setBuiltInExtensionEnabled(OVERLAY_EXT_ID, false);
      });

      await waitFor(() => {
        expect(state.lastTimelineOverlaysEnabled).toBe(false);
      });
    });

    it("applies the built-in enablement store in production so the ExtensionManager toggle takes effect", async () => {
      (import.meta.env as Record<string, unknown>).DEV = false;
      // A reviewed bundled id: production admits only the frozen reviewed inventory.
      const REVIEWED_ID = "haus.astrid.transcript-lane";
      state.devLocalExtensions.push({
        manifest: {
          id: REVIEWED_ID,
          version: "0.1.0",
          label: "Transcript",
          description: "A reviewed built-in overlay for production enablement tests.",
          apiVersion: 1,
          contributions: [
            {
              id: `${REVIEWED_ID}-overlay`,
              kind: "timelineOverlay",
              render: `${REVIEWED_ID}-overlay`,
              order: 5,
              label: "Transcript",
            },
          ],
        },
        activate: vi.fn(() => ({ dispose: vi.fn() })),
      });
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      await screen.findByTestId("video-editor-provider");
      expect(state.lastTimelineOverlaysEnabled).toBe(true);

      act(() => {
        setBuiltInExtensionEnabled(REVIEWED_ID, false);
      });
      await waitFor(() => {
        expect(state.lastTimelineOverlaysEnabled).toBe(false);
      });

      act(() => {
        setBuiltInExtensionEnabled(REVIEWED_ID, true);
      });
      await waitFor(() => {
        expect(state.lastTimelineOverlaysEnabled).toBe(true);
      });
    });

    it("ignores the extension-driven gate in production (DEV off)", async () => {
      (import.meta.env as Record<string, unknown>).DEV = false;
      state.devLocalExtensions.push(makeOverlayDevLocalExtension());
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");
      expect(state.lastTimelineOverlaysEnabled).toBe(false);
      expect(provider).toHaveAttribute(
        "data-timeline-overlays-enabled",
        "false",
      );
    });
  });

  describe("dev-local extension enablement (external store)", () => {
    const DEV_LOCAL_ID = "haus.astrid.dev.local-fixture";

    function makeDevLocalExtension() {
      return {
        manifest: {
          id: DEV_LOCAL_ID,
          version: "0.1.0",
          label: "Local Fixture Extension",
          description: "A dev-local scratchpad extension for enablement tests.",
          apiVersion: 1,
          contributions: [
            {
              id: `${DEV_LOCAL_ID}-status`,
              kind: "slot",
              slot: "statusBar",
              render: `${DEV_LOCAL_ID}-status`,
              label: "Local Fixture Status",
            },
          ],
        },
        activate: vi.fn(() => ({ dispose: vi.fn() })),
      };
    }

    it("passes an enabled dev-local extension into the provider (activated once)", async () => {
      state.devLocalExtensions.push(makeDevLocalExtension());
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");
      expect(state.lastProviderExtensions).toHaveLength(1);
      expect(state.lastProviderExtensions![0].manifest.id).toBe(DEV_LOCAL_ID);
      expect(state.extensionActivations).toEqual([DEV_LOCAL_ID]);
      expect(state.extensionDisposals).toEqual([]);
    });

    it("drops the dev-local extension when disabled through the external store (no searchParams change, no refresh key)", async () => {
      state.devLocalExtensions.push(makeDevLocalExtension());
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(state.lastProviderExtensions).toHaveLength(1);

      // Toggling the store notifies the page's useSyncExternalStore
      // subscription; the smokeDirectExtensions memo must update from the
      // snapshot without any URL or loader-refresh change.
      act(() => {
        setBuiltInExtensionEnabled(DEV_LOCAL_ID, false);
      });

      await waitFor(() => {
        expect(state.lastProviderExtensions ?? []).toHaveLength(0);
      });
      // Runtime teardown: the extension left the provider's extension list.
      expect(state.extensionDisposals).toEqual([DEV_LOCAL_ID]);
    });

    it("does not mount a dev-local extension that is disabled before the page renders", async () => {
      act(() => {
        setBuiltInExtensionEnabled(DEV_LOCAL_ID, false);
      });
      state.devLocalExtensions.push(makeDevLocalExtension());
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      await screen.findByTestId("video-editor-provider");

      expect(state.lastProviderExtensions ?? []).toHaveLength(0);
      expect(state.extensionActivations).toEqual([]);
    });

    it("re-enables a disabled dev-local extension and activates it exactly once", async () => {
      state.devLocalExtensions.push(makeDevLocalExtension());
      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      await screen.findByTestId("video-editor-provider");
      expect(state.lastProviderExtensions).toHaveLength(1);
      expect(state.extensionActivations).toEqual([DEV_LOCAL_ID]);

      // Disable → teardown (exactly one disposal).
      act(() => {
        setBuiltInExtensionEnabled(DEV_LOCAL_ID, false);
      });
      await waitFor(() => {
        expect(state.lastProviderExtensions ?? []).toHaveLength(0);
      });
      expect(state.extensionDisposals).toEqual([DEV_LOCAL_ID]);

      // Re-enable → the extension comes back, and only one new activation is
      // recorded for the re-add (1 initial + 1 re-enable), with no extra
      // disposal from the re-add itself.
      act(() => {
        setBuiltInExtensionEnabled(DEV_LOCAL_ID, true);
      });

      await waitFor(() => {
        expect(state.lastProviderExtensions).toHaveLength(1);
        expect(state.lastProviderExtensions![0].manifest.id).toBe(DEV_LOCAL_ID);
      });
      expect(
        state.extensionActivations.filter((id) => id === DEV_LOCAL_ID),
      ).toHaveLength(2);
      expect(
        state.extensionDisposals.filter((id) => id === DEV_LOCAL_ID),
      ).toHaveLength(1);
    });

    it("does not mount dev-local extensions when DEV is off", async () => {
      state.devLocalExtensions.push(makeDevLocalExtension());
      (import.meta.env as Record<string, unknown>).DEV = false;

      renderPage(
        "/tools/video-editor?project=ados-talks&timeline=11111111-1111-1111-1111-111111111111",
      );

      const provider = await screen.findByTestId("video-editor-provider");
      expect(provider).toHaveAttribute("data-kind", "runtime");
      expect(state.lastProviderExtensions ?? []).toHaveLength(0);
      expect(state.extensionActivations).toEqual([]);
    });
  });

  describe("P2-L04.PROVIDER actual page provider lifetime", () => {
    let actualRuntime: typeof import("@/integrations/runtime/dataProvider.ts");
    let runtime: ReturnType<typeof makeL04Transport>;
    const defaultRuntimeCtor = state.runtimeCtor.getMockImplementation()!;

    beforeAll(async () => {
      actualRuntime = await vi.importActual<
        typeof import("@/integrations/runtime/dataProvider.ts")
      >("@/integrations/runtime/dataProvider.ts");
    });
    beforeEach(() => {
      state.discovery.projects = [
        { slug: "l04-project", name: "L04 Project", project_id: L04_PROJECT },
        {
          slug: "l04-other",
          name: "L04 Other",
          project_id: "l04-other-project-id",
        },
      ];
      state.discovery.timelines = [
        { timeline_id: L04_TIMELINE, name: "Opening name", is_default: true },
        { timeline_id: "l04-other-timeline", name: "Other timeline" },
      ];
      runtime = makeL04Transport();
      l04Queries = null;
      state.runtimeCtor.mockImplementation(function (_options: unknown) {
        const options = _options as RuntimeDataProviderOptions;
        const provider = new actualRuntime.RuntimeDataProvider({
          ...options,
          transport: runtime.transportFor(
            `provider-${runtime.providers.length + 1}`,
          ),
        });
        runtime.providers.push(provider);
        state.runtimeOnError =
          (options.onRuntimeError as ((error: unknown) => void) | undefined) ??
          null;
        return provider;
      });
    });
    afterEach(() => {
      runtime.release();
      state.providerProbe = null;
      vi.restoreAllMocks();
      state.runtimeCtor.mockImplementation(defaultRuntimeCtor);
    });

    it.each([false, true])(
      "keeps its admitted provider and card through pending reads and discovered name refresh (initially absent=%s)",
      async (initiallyAbsent) => {
        if (initiallyAbsent) {
          state.discovery.timelinesLoading = true;
          state.discovery.timelines = [];
        }
        state.providerProbe = L04QueryProbe;
        const view = renderL04Page();
        if (initiallyAbsent) {
          // Discovery must verify the document before a provider can mount.
          // Once admitted below, pending reads and display metadata keep it.
          expect(screen.queryByTestId("video-editor-provider")).toBeNull();
          expect(runtime.providers).toHaveLength(0);
          state.discovery.timelinesLoading = false;
          state.discovery.timelines = [
            {
              timeline_id: L04_TIMELINE,
              name: "Opening name",
              is_default: true,
            },
          ];
          view.refresh();
          expect(await screen.findByTestId("video-editor-provider")).toBeInTheDocument();
        }
        try {
          const admittedCard = await screen.findByTestId("l04-admitted-card");
          expect(admittedCard).toHaveTextContent(L04_CARD_URL);
          expect(
            l04Queries!.timelineQuery.data?.resolvedConfig.clips[0].params
              ?.__astridAssets,
          ).toMatchObject({ card0: L04_CARD_URL });
          const admittedProvider = state.selectedProvider!;
          expect(admittedProvider).toBe(runtime.providers[0]);
          expect(await admittedProvider.resolveAssetUrl(L04_TOKEN)).toBe(
            L04_CARD_URL,
          );
          const admittedRegistry = l04Queries!.assetRegistryQuery.data;
          const mounts = state.providerMounts;
          const editorNode = screen.getByTestId("video-editor-provider");
          runtime.hold();
          const pending = view.client.refetchQueries({
            queryKey: assetRegistryQueryKey(L04_TIMELINE),
            exact: true,
          });
          await waitFor(() =>
            expect(
              view.client.getQueryState(assetRegistryQueryKey(L04_TIMELINE))
                ?.fetchStatus,
            ).toBe("fetching"),
          );
          state.discovery.timelinesLoading = false;
          state.discovery.timelines = [
            {
              timeline_id: L04_TIMELINE,
              name: "Refreshed display name",
              is_default: true,
            },
          ];
          view.refresh();
          await waitFor(() =>
            expect(
              screen.getByRole("combobox", { name: "Select timeline" }),
            ).toHaveTextContent("Refreshed display name"),
          );
          expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
            "data-timeline-name",
            "Refreshed display name",
          );
          expect(screen.getByTestId("video-editor-provider")).toBe(editorNode);
          expect(state.providerMounts).toBe(mounts);
          expect(state.providerUnmounts).toBe(0);
          expect
            .soft(
              state.selectedProvider,
              "display metadata must retain the admitted state owner",
            )
            .toBe(admittedProvider);
          runtime.advance();
          // The shared head check caches for 6 s, so an external revision is observed on the next check.
          const now = Date.now();
          const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 6_001);
          try {
            await pending;
            await view.client.refetchQueries({
              queryKey: assetRegistryQueryKey(L04_TIMELINE),
              exact: true,
            });
            await waitFor(() =>
              expect(l04Queries!.assetRegistryQuery.data).not.toBe(
                admittedRegistry,
              ),
            );
          } finally {
            dateNow.mockRestore();
          }
          await flushL04();
          expect(
            l04Queries!.assetRegistryQuery.data?.assets["l04-card-asset"],
          ).toMatchObject({
            media_id: L04_TOKEN,
            content_sha256: L04_TOKEN,
            metadata: { observedRevision: L04_NEXT_HEAD },
          });
          const refreshed = await timelineData.loadTimelineJsonFromProvider(
            admittedProvider,
            L04_TIMELINE,
            (file) => admittedProvider.resolveAssetUrl(file),
          );
          expect(refreshed.head?.headRevisionId).toBe(L04_NEXT_HEAD);
          expect(
            refreshed.resolvedConfig.clips[0].params?.__astridAssets,
          ).toMatchObject({ card0: L04_CARD_URL });
          await expect(
            state.selectedProvider!.resolveAssetUrl(L04_TOKEN),
          ).resolves.toBe(L04_CARD_URL);
        } finally {
          view.unmount();
          view.client.clear();
          runtime.release();
          await flushL04();
        }
      },
    );

    it("replaces provider and editor at real timeline/project authority changes", async () => {
      const view = renderL04Page();
      try {
        await screen.findByTestId("video-editor-provider");
        const first = state.selectedProvider;
        expect(state.providerMounts).toBe(1);
        view.navigate(
          `/tools/video-editor?project=${L04_PROJECT}&timeline=l04-other-timeline`,
        );
        await waitFor(() => expect(state.providerMounts).toBe(2));
        const second = state.selectedProvider;
        expect(second).not.toBe(first);
        expect(screen.getByTestId("video-editor-provider")).toHaveAttribute(
          "data-timeline-id",
          "l04-other-timeline",
        );
        view.navigate(
          "/tools/video-editor?project=l04-other-project-id&timeline=l04-other-timeline",
        );
        await waitFor(() => expect(state.providerMounts).toBe(3));
        expect(state.selectedProvider).not.toBe(second);
        expect(state.providerUnmounts).toBe(2);
        expect(
          state.runtimeCtor.mock.calls.map(
            ([options]) => (options as RuntimeDataProviderOptions).projectId,
          ),
        ).toEqual([L04_PROJECT, L04_PROJECT, "l04-other-project-id"]);
      } finally {
        view.unmount();
        view.client.clear();
      }
    });



    it("resolves a known card and rejects a truly unknown token on the page-selected provider", async () => {
      const view = renderL04Page();
      try {
        await screen.findByTestId("video-editor-provider");
        const provider = state.selectedProvider!;
        const data = await timelineData.loadTimelineJsonFromProvider(
          provider,
          L04_TIMELINE,
        );
        expect(
          data.resolvedConfig.clips[0].params?.__astridAssets,
        ).toMatchObject({ card0: L04_CARD_URL });
        await provider.loadAssetRegistry(L04_TIMELINE);
        expect(await provider.resolveAssetUrl(L04_TOKEN)).toBe(L04_CARD_URL);
        await expect(provider.resolveAssetUrl(L04_UNKNOWN)).rejects.toThrow(
          `Workspace Runtime has no managed object for asset ${L04_UNKNOWN}`,
        );
        expect(
          runtime.requests.some(({ path }) => path.startsWith("/v1/objects/")),
        ).toBe(false);
      } finally {
        view.unmount();
        view.client.clear();
      }
    });
  });
});
