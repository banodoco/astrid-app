import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Loader2, X } from 'lucide-react';
import type { GenerationRow } from '@/domains/generation/types/index.ts';
import { sessionAgentId, type LocalAgentId } from '@/integrations/astrid/localAgents.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { isAcpUnavailable, isAgentSetupError } from '@/integrations/astrid/acpRoutes.ts';
import { AGENT_CHAT_COPY } from '@/integrations/astrid/chatCopy.ts';
import { MediaLightbox } from '@/domains/media-lightbox/MediaLightbox.tsx';
import { Button } from '@/shared/components/ui/button.tsx';
import { downloadBlobAsFile } from '@/shared/runtime/browserDownloadRuntime.ts';
import { conversationExportFilename, formatConversationExport, type ConversationExportTurn } from '@/shared/components/conversation/conversationExport.ts';
import { useAgentChatBridge, useAgentChatActionsRegistry, type AgentChatActionsHandlers } from '@/shared/contexts/AgentChatContext.tsx';
import { composerClearAttachments, composerRemoveAttachment } from '@/shared/state/selectionStore.ts';
import { useCurrentAttachmentSet } from '@/shared/state/currentAttachmentSet.ts';
import { usePanesStore } from '@/shared/state/panesStore.ts';
import {
  isTimelineAgentSessionsAvailable,
  useAgentSession,
  useAgentSessions,
  useProjectChat,
  useSaveProjectDraft,
  useSelectProjectSession,
  useSetMainProjectSession,
  useRenameProjectSession,
  useUnassignedProjectSessions,
  useAssociateProjectSession,
  useCancelSession,
  useTakeOverSession,
  useCreateSession,
  useSendMessage,
  useAgentModels,
  useConfigureAgentSession,
  useLocalAgents,
} from '@/tools/video-editor/hooks/useAgentSession.ts';
import { useAgentVoice } from '@/tools/video-editor/hooks/useAgentVoice.ts';
import { CHAT_VOICE_ENABLED } from '@/tools/video-editor/hooks/chatVoice.ts';
import { useRenderDiagnostic } from '@/tools/video-editor/hooks/usePerfDiagnostics.ts';
import { loadGenerationForLightbox } from '@/tools/video-editor/lib/generation-utils.ts';
import type {
  AgentSessionStatus,
  AgentTurn,
  AgentTurnAttachment,
} from '@/tools/video-editor/types/agent-session.ts';
import { AgentChatAttachmentStrip, AgentChatMessage, AgentChatToolGroup, type AgentChatAttachmentPreviewItem } from './AgentChatMessage.tsx';
import { useChatScroll } from './useChatScroll';
import { AgentTaskResults } from './AgentTaskResults';
import { AgentChatMenu, type AgentChatMenuHandle, type NewChatAgentModels } from './AgentChatMenu';
import { NewChatMenu, type NewChatMenuHandle } from './NewChatMenu';
import { AgentChatModelLine } from './AgentChatModelLine';
import { ChatUpdateNeeded, isChatUpdateError } from './ChatUpdateNeeded';
import { AgentSetupCard } from './AgentSetupCard';
import { TerminalNudge } from './TerminalNudge';
import { useSetting } from '@/shared/settings/useSetting.ts';
import { terminalNudgeSeen } from '@/shared/settings/declarations.ts';
import { CommandLine } from './CommandLine';
import { AgentIcon, agentNames, isAgentUsable } from './agentIdentity';
import { ProjectChatDraftPersistence, mergeQueues, sameProjectDraft } from './projectChatDraftPersistence';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { AgentChatComposer } from './AgentChatComposer';
import { buildRenderedTurns } from './buildRenderedTurns';
import { TourChatPanel } from './TourChatPanel';
import { useEditorTourRunning } from '@/shared/state/editorTourStore.ts';
import { EDITOR_TOUR_ANCHOR_ATTRIBUTE, EDITOR_TOUR_ANCHORS } from '@/tools/video-editor/tour/anchors.ts';
import { presentEditorRequests } from '../../runtime/editorRequestPresentation';
import { useDraftSafeReload } from '@/shared/lib/updates/draftSafeReload.ts';

export { buildRenderedTurns, type RenderedTurn, type ToolCallPair } from './buildRenderedTurns';

type QueuedMessage = {
  id: string;
  text: string;
  sessionId: string;
  attachments: AgentTurnAttachment[];
};

type OptimisticMessage = QueuedMessage & {
  sentAtMs: number;
  priorTurnCount: number;
};

function isDraftConflict(error: unknown): boolean {
  return error instanceof BridgeRouteError && error.status === 409 && (error.code === 'draft_conflict' || /draft/i.test(error.detail ?? ''));
}

const unsavedProjectChatDrafts = new Map<string, { text: string; queue: QueuedMessage[]; dirty: boolean; scopeKey: string; persistence: ProjectChatDraftPersistence<QueuedMessage> }>();
type AgentSessionView = {
  durableAcceptedRequestIds?: string[];
  recordedEditorResults?: import('../../runtime/editorRequestPresentation').RecordedEditorResult[];
  id: string;
  status: AgentSessionStatus;
  turns: AgentTurn[];
  assistantDraft?: string;
  control?: { role: 'writer' | 'follower'; active: boolean; activeRequestId: string | null };
};

type AgentSessionOption = Pick<AgentSessionView, 'id' | 'status'>;



function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAgentSessionStatus(value: unknown): value is AgentSessionStatus {
  switch (value) {
    case 'waiting_user':
    case 'processing':
    case 'continue':
    case 'done':
    case 'cancelled':
    case 'error':
      return true;
    default:
      return false;
  }
}

function isAgentTurn(value: unknown): value is AgentTurn {
  if (!isRecord(value) || typeof value.content !== 'string' || typeof value.timestamp !== 'string') {
    return false;
  }

  switch (value.role) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'tool_result':
      return true;
    default:
      return false;
  }
}

function isAgentSessionView(value: unknown): value is AgentSessionView {
  return isRecord(value)
    && typeof value.id === 'string'
    && isAgentSessionStatus(value.status)
    && Array.isArray(value.turns)
    && value.turns.every(isAgentTurn);
}

function isAgentSessionOption(value: unknown): value is AgentSessionOption {
  return isRecord(value)
    && typeof value.id === 'string'
    && isAgentSessionStatus(value.status);
}

function readAgentSessions(value: unknown): AgentSessionOption[] {
  return Array.isArray(value) ? value.filter(isAgentSessionOption) : [];
}

function readAgentSession(value: unknown): AgentSessionView | undefined {
  return isAgentSessionView(value) ? value : undefined;
}

function readSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id === 'string') return value.id;
  if (typeof value.sessionId === 'string') return value.sessionId;
  return undefined;
}

function createMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

interface AgentChatPanelProps {
  /** Whether chat currently fills the action pane vertically. */
  isExpanded?: boolean;
  /** Keep the containing action pane visible while a chat header menu's portal is open. */
  onSessionSelectorOpenChange?: (open: boolean) => void;
}

/** What the pane says while no chat service runs on this computer (the door's `acp_unavailable`). */
const CHAT_UNAVAILABLE = "Chat isn't running on this computer right now.";

export function AgentChatPanel({ isExpanded = false, onSessionSelectorOpenChange }: AgentChatPanelProps) {
  useRenderDiagnostic('AgentChatPanel');
  const scope = useAgentChatBridge();
  const tourRunning = useEditorTourRunning();

  // The first-run tour shows a scripted conversation in place of the real chat: no session hooks, no agent.
  if (tourRunning) return <TourChatPanel isExpanded={isExpanded} />;

  if (!isTimelineAgentSessionsAvailable()) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <img
          src="/astrid-avatar.png"
          alt=""
          aria-hidden="true"
          className="h-8 w-8 rounded-full object-cover"
        />
        <p className="text-sm font-medium text-foreground">Timeline agent chat is managed in Astrid</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Run the agent workflow in Astrid, then refresh this editor to load the updated timeline.
        </p>
      </div>
    );
  }

  return (
    <AvailableAgentChatPanel
      key={scope.editorContext?.projectId ?? 'unscoped'}
      isExpanded={isExpanded}
      onSessionSelectorOpenChange={onSessionSelectorOpenChange}
    />
  );
}

function AvailableAgentChatPanel({
  isExpanded,
  onSessionSelectorOpenChange,
}: {
  isExpanded: boolean;
  onSessionSelectorOpenChange?: (open: boolean) => void;
}) {

  const {
    timelineId,
    editorContext,
    pendingComposerPrompt,
    clearPendingComposerPrompt,
  } = useAgentChatBridge();
  const projectId = editorContext?.projectId ?? null;
  const sessions = useAgentSessions(timelineId, projectId);
  const localAgents = useLocalAgents();
  const refetchLocalAgents = localAgents.refetch;
  const { setLocalServiceOutOfDate } = useRuntimeConnection();
  const projectChat = useProjectChat(projectId);
  const saveDraft = useSaveProjectDraft(projectId);
  const selectSession = useSelectProjectSession(projectId);
  const setMainSession = useSetMainProjectSession(projectId);
  const renameSession = useRenameProjectSession(projectId);
  const [showAttachSessions, setShowAttachSessions] = useState(false);
  const unassignedSessions = useUnassignedProjectSessions(projectId, showAttachSessions);
  const associateSession = useAssociateProjectSession(projectId);
  const hasMainContract = projectChat.data?.main_session_id !== undefined;
  const createSession = useCreateSession(timelineId, projectId, 'ensure');
  const createNewSession = useCreateSession(timelineId, projectId, 'new');
  // Engagement signal: when the pane is locked the user has clearly committed to
  // having chat visible, so auto-create can fire without an explicit click.
  const isTasksPaneLocked = usePanesStore((state) => state.isTasksPaneLocked);
  const setIsTasksPaneLocked = usePanesStore((state) => state.setIsTasksPaneLocked);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const modelCatalog = useAgentModels(true, activeSessionId, projectId);
  const configureSession = useConfigureAgentSession(projectId);
  // A chat's agent is fixed by its session; with no chat yet, the next one uses the last-used agent.
  const defaultAgent: LocalAgentId = localAgents.data?.defaultAgent ?? 'astrid';
  const chatAgent = activeSessionId ? sessionAgentId(activeSessionId) : defaultAgent;
  const modelName = useCallback((sessionId: string, modelId: string) => {
    const agent = localAgents.data?.agents.find(choice => choice.id === sessionAgentId(sessionId));
    return agent?.models.find(model => model.modelId === modelId)?.name ?? modelId;
  }, [localAgents.data]);
  const chatModelId = modelCatalog.data?.localModels?.currentModelId
    ?? (activeSessionId ? projectChat.data?.sessions.find(session => session.id === activeSessionId)?.model_id : undefined)
    ?? null;
  const chatModelName = useMemo(() => {
    if (!activeSessionId) return null;
    const models = modelCatalog.data?.localModels;
    const modelId = models?.currentModelId ?? projectChat.data?.sessions.find(session => session.id === activeSessionId)?.model_id;
    if (!modelId) return null;
    return models?.availableModels.find(model => model.modelId === modelId)?.name ?? modelName(activeSessionId, modelId);
  }, [activeSessionId, modelCatalog.data, modelName, projectChat.data]);
  const chatThoughtLevel = modelCatalog.data?.localModels?.thoughtLevel ?? null;
  // Some agents carry thinking inside the model option; that level is fixed with the model.
  const chatThoughtLevelFixed = Boolean(chatThoughtLevel && (chatThoughtLevel.configId === 'model' || chatThoughtLevel.configId === modelCatalog.data?.localModels?.modelConfigId));
  const describeSession = useCallback((sessionId: string) => {
    const modelId = projectChat.data?.sessions.find(session => session.id === sessionId)?.model_id;
    return { agent: sessionAgentId(sessionId), model: sessionId === activeSessionId ? chatModelName : modelId ? modelName(sessionId, modelId) : null };
  }, [activeSessionId, chatModelName, modelName, projectChat.data]);
  const agentModelNames = useMemo(() => Object.fromEntries((localAgents.data?.agents ?? []).map(agent => [
    agent.id, agent.models.find(model => model.modelId === agent.defaultModel)?.name ?? agent.defaultModel,
  ])), [localAgents.data]);
  const astridKeyConfigured = localAgents.data
    ? Boolean(localAgents.data.agents.find(agent => agent.id === 'astrid')?.models.length)
    : undefined;
  const [draft, setDraft] = useState('');
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [pausedQueueHeadId, setPausedQueueHeadId] = useState<string | null>(null);
  const pausedQueuedIdsRef = useRef(new Set<string>());
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticMessage | null>(null);
  const [attachmentLightboxMedia, setAttachmentLightboxMedia] = useState<GenerationRow | null>(null);
  const [setupRequest, setSetupRequest] = useState<{ agent: LocalAgentId; sessionId: string | null; error?: unknown } | null>(null);
  // Mutation errors can outlive the chat they came from.
  const setupErrorScopes = useRef(new Map<unknown, { agent: LocalAgentId; sessionId: string | null }>());
  const dismissedSetupErrors = useRef(new Set<unknown>());
  // Back leaves creation running, but its response must not select a chat.
  const setupStartIsCurrentRef = useRef<(() => boolean) | undefined>(undefined);
  const [setupDone, setSetupDone] = useState<{ agent: LocalAgentId; sessionId: string | null } | null>(null);
  const [startingAgent, setStartingAgent] = useState<LocalAgentId | null>(null);
  const [startFailure, setStartFailure] = useState<{ agent: LocalAgentId; choice?: LocalAgentId; model?: string; thoughtLevel?: string; sessionId?: string; sourceSessionId: string | null; error: unknown; details: string; updateNeeded: boolean } | null>(null);
  // Engagement flag local to AgentChatPanel: flipped by markEngaged() (split-button click)
  // and decoupled from pane open state so the close-path bug from the rev-4
  // setIsTasksPaneOpenProgrammatic approach can't recur.
  const [userEngaged, setUserEngaged] = useState(false);
  const hasAutoCreatedSessionRef = useRef(false);
  const autoCreateOperationIdRef = useRef<string | null>(null);
  const manualCreateOperationIdRef = useRef<{ projectId: string; id: string; agent?: LocalAgentId; model?: string } | null>(null);
  // A completion from an earlier project visit must never select its chat here.
  if (manualCreateOperationIdRef.current?.projectId !== projectId) manualCreateOperationIdRef.current = null;
  const lightboxRequestIdRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const hasProject = Boolean(projectId);
  const wasStartingRef = useRef(false);
  useEffect(() => {
    const wasStarting = wasStartingRef.current;
    wasStartingRef.current = startingAgent !== null;
    // Focus after the disabled composer has been committed as editable again.
    if (wasStarting && !startingAgent) inputRef.current?.focus({ preventScroll: true });
  }, [startingAgent]);


  const activeSession = useAgentSession(activeSessionId, projectId);
  // Non-editor hosts may still provide the legacy settings-backed timeline
  // bridge. Preserve that path with a timeline-only context while the loaded
  // editor supplies the full project/timeline snapshot above.
  const sendMessage = useSendMessage(activeSessionId, editorContext, projectId);
  const cancelSession = useCancelSession(activeSessionId);
  const takeOverSession = useTakeOverSession(activeSessionId, projectId);
  const sessionOptions = useMemo(() => {
    // Membership, selection and Main must share one registry snapshot. The
    // independently polled sessions query supplies status and drains events;
    // it can still be stale when New publishes its registry receipt.
    const statuses = new Map(readAgentSessions(sessions.data).map(session => [session.id, session.status]));
    return (projectChat.data?.sessions ?? []).flatMap((session, index) => session.missing ? [] : [{
      id: session.id,
      title: session.title,
      status: statuses.get(session.id) ?? 'waiting_user',
      // Count missing entries too so siblings never renumber.
      chatNumber: index + 1,
    }]);
  }, [sessions.data, projectChat.data?.sessions]);
  const [browseAgent, setBrowseAgent] = useState<LocalAgentId | null>(null);
  const chatMenuRef = useRef<AgentChatMenuHandle>(null);
  const newChatMenuRef = useRef<NewChatMenuHandle>(null);
  // The action pane stays shown while any header popover is open.
  const headerOverlaysRef = useRef({ menu: false, model: false, newChat: false });
  const setHeaderOverlayOpen = useCallback((overlay: 'menu' | 'model' | 'newChat', open: boolean) => {
    headerOverlaysRef.current[overlay] = open;
    const overlays = headerOverlaysRef.current;
    onSessionSelectorOpenChange?.(overlays.menu || overlays.model || overlays.newChat);
  }, [onSessionSelectorOpenChange]);
  const agentCanBrowse = useMemo(() => ({ hermes: Boolean(localAgents.data?.agents.find(agent => agent.id === 'hermes')?.models.length) }), [localAgents.data]);
  const newChatModels = useMemo<NewChatAgentModels | null>(() => {
    if (!browseAgent) return null;
    const agent = localAgents.data?.agents.find(choice => choice.id === browseAgent);
    return {
      agent: browseAgent,
      models: (agent?.models ?? []).map(model => ({ id: model.modelId, name: model.name, detail: model.description, thoughtLevel: model.thoughtLevel })),
      defaultModel: agent?.defaultModel ?? null,
      loading: localAgents.isLoading || (!agent && localAgents.isFetching),
      note: localAgents.error ? AGENT_CHAT_COPY.modelsFailed : AGENT_CHAT_COPY.noModels,
    };
  }, [browseAgent, localAgents.data, localAgents.error, localAgents.isFetching, localAgents.isLoading]);
  const hydratedProjectDraftRef = useRef(false);
  const draftPersistenceRef = useRef<ProjectChatDraftPersistence<QueuedMessage> | null>(null);
  const draftPersistenceProjectRef = useRef<string | null>(null);
  const draftScopeRef = useRef<string | null>(null);
  const draftSnapshotRef = useRef({ text: draft, queue });
  draftSnapshotRef.current = { text: draft, queue };
  useEffect(() => {
    if (!projectChat.data) return;
    const restored = projectChat.data.draft.queued_messages ?? [];
    const savedQueue = restored.map((item) => ({ id: item.id, text: item.text, sessionId: item.session_id, attachments: Array.isArray(item.attachments) ? item.attachments as AgentTurnAttachment[] : [] }));
    const saved = { text: projectChat.data.draft.text, queue: savedQueue };
    if (hydratedProjectDraftRef.current) {
      // Empty-session recovery moves durable queue rows by submission ID. Adopt
      // only that safe replacement, preserving any unsaved local text or rows.
      const entries = projectChat.data.sessions;
      const recoveredIds = new Set<string>();
      const rebind = (item: QueuedMessage) => {
        const moved = savedQueue.find(saved => saved.id === item.id && saved.sessionId !== item.sessionId);
        if (!moved || entries.some(session => session.id === item.sessionId)
            || sessionAgentId(item.sessionId) === 'astrid'
            || sessionAgentId(item.sessionId) !== sessionAgentId(moved.sessionId)
            || !entries.some(session => session.id === moved.sessionId && session.pending_first_message === true)) return item;
        recoveredIds.add(item.id);
        return { ...item, sessionId: moved.sessionId };
      };
      const rebound = draftSnapshotRef.current.queue.map(rebind);
      if (recoveredIds.size) {
        const persistence = draftPersistenceRef.current;
        if (persistence) {
          // Older queued saves keep their old CAS token. Only the new lifetime
          // may observe the recovery revision and save the rebound local draft.
          persistence.mounted = false;
          draftPersistenceRef.current = new ProjectChatDraftPersistence(persistence.revision, {
            ...persistence.saved, queue: persistence.saved.queue.map(rebind),
          });
        }
        draftSnapshotRef.current = { ...draftSnapshotRef.current, queue: rebound };
        setQueue(rebound);
        recoveredIds.forEach(id => pausedQueuedIdsRef.current.delete(id));
        setPausedQueueHeadId(id => id && recoveredIds.has(id) ? null : id);
        setOptimisticMessage(item => item && recoveredIds.has(item.id) ? null : item);
        sendingRef.current = false;
      }
      const idle = draftPersistenceRef.current;
      // Another client's newer draft is adopted only by a composer that is unfocused, has nothing in flight and no
      // edits since its last save. Otherwise what is on screen wins and the next save simply overwrites.
      if (idle && projectChat.data.draft.revision > idle.revision && idle.idle
          && !sameProjectDraft(saved, idle.saved) && sameProjectDraft(draftSnapshotRef.current, idle.saved)
          && document.activeElement !== inputRef.current) {
        idle.adopt(projectChat.data.draft.revision, saved);
        draftSnapshotRef.current = saved;
        setDraft(saved.text);
        setQueue(saved.queue);
        saved.queue.forEach(item => pausedQueuedIdsRef.current.add(item.id));
        setPausedQueueHeadId(saved.queue[0]?.id ?? null);
        return;
      }
      draftPersistenceRef.current?.observe(projectChat.data.draft.revision, saved, draftSnapshotRef.current);
      return;
    }
    hydratedProjectDraftRef.current = true;
    draftScopeRef.current = projectChat.data.scope_key;
    const retained = unsavedProjectChatDrafts.get(projectId!);
    const local = retained?.scopeKey === projectChat.data.scope_key && retained.dirty ? retained : undefined;
    // A reopened composer continues its own in-flight save. A second mounted
    // composer keeps a separate CAS base, so divergent edits still conflict.
    const persistence = local && !local.persistence.mounted
      ? local.persistence
      : new ProjectChatDraftPersistence(projectChat.data.draft.revision, saved);
    if (local && persistence !== local.persistence) {
      persistence.revision = local.persistence.revision;
      persistence.saved = local.persistence.saved;
    }
    persistence.mounted = true;
    draftPersistenceProjectRef.current = projectId!;
    persistence.observe(projectChat.data.draft.revision, saved, local ?? saved);
    draftPersistenceRef.current = persistence;
    const initial = local ? { text: local.text, queue: local.queue } : saved;
    draftSnapshotRef.current = initial;
    setDraft(initial.text);
    setQueue(initial.queue);
    initial.queue.forEach(item => pausedQueuedIdsRef.current.add(item.id));
    setPausedQueueHeadId(initial.queue[0]?.id ?? null);
  }, [projectChat.data, projectId]);
  const persistDraftForOwner = useCallback(async (
    snapshot: { text: string; queue: QueuedMessage[] },
    ownerProjectId: string,
    persistence: ProjectChatDraftPersistence<QueuedMessage>,
  ) => {
    const toWire = (rows: QueuedMessage[]) => rows.map((item) => ({ id: item.id, text: item.text, session_id: item.sessionId, attachments: item.attachments }));
    try {
      await persistence.save(snapshot, async (firstRevision) => {
        let expectedRevision = firstRevision;
        let queue = snapshot.queue;
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await saveDraft.mutateAsync({ expectedRevision, text: snapshot.text, queuedMessages: toWire(queue) });
            return { revision: result.draft.revision, snapshot: { text: snapshot.text, queue } };
          } catch (error) {
            if (!isDraftConflict(error) || attempt >= 3) throw error;
            // Drafts are last-writer-wins: rebase onto the server's current version and write again. The text on
            // screen always wins; queued rows are merged by id so none is lost.
            const current = (await projectChat.refetch()).data;
            if (!current) throw error;
            const remote = (current.draft.queued_messages ?? []).map((item) => ({ id: item.id, text: item.text, sessionId: item.session_id, attachments: Array.isArray(item.attachments) ? item.attachments as AgentTurnAttachment[] : [] }));
            const base = persistence.saved.queue;
            queue = mergeQueues(base, remote, queue);
            const live = draftPersistenceRef.current === persistence ? draftSnapshotRef.current.queue : snapshot.queue;
            const liveMerged = mergeQueues(base, remote, live);
            if (draftPersistenceRef.current === persistence && JSON.stringify(liveMerged) !== JSON.stringify(live)) {
              const known = new Set(live.map(item => item.id));
              liveMerged.forEach(item => { if (!known.has(item.id)) pausedQueuedIdsRef.current.add(item.id); });
              draftSnapshotRef.current = { ...draftSnapshotRef.current, queue: liveMerged };
              setQueue(liveMerged);
            }
            expectedRevision = current.draft.revision;
          }
        }
      });
      if (draftPersistenceRef.current === persistence) setDraftSaveError(null);
      const current = unsavedProjectChatDrafts.get(ownerProjectId);
      if (current?.persistence === persistence && sameProjectDraft(current, snapshot)) {
        const durable = persistence.current;
        unsavedProjectChatDrafts.set(ownerProjectId, {
          ...current,
          ...durable,
          dirty: !persistence.idle || !sameProjectDraft(durable, persistence.saved),
        });
      }
    } catch (error) {
      if (draftPersistenceRef.current !== persistence) throw error;
      // A draft that fails to save is not worth interrupting anyone: the next edit saves again. A queued message is.
      if (snapshot.queue.length > 0) setDraftSaveError(error instanceof BridgeRouteError ? (error.detail ?? error.message) : error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [projectChat, saveDraft, setQueue, setDraftSaveError]);
  const flushDraftRef = useRef<() => Promise<void>>(async () => undefined);
  flushDraftRef.current = async () => {
    const persistence = draftPersistenceRef.current;
    const ownerProjectId = draftPersistenceProjectRef.current;
    if (!ownerProjectId || !persistence) return;
    await persistDraftForOwner(draftSnapshotRef.current, ownerProjectId, persistence);
  };
  const activePersistence = draftPersistenceRef.current;
  useLayoutEffect(() => {
    if (!activePersistence || !projectId || draftPersistenceProjectRef.current !== projectId) return;
    activePersistence.track(draftSnapshotRef.current, (snapshot) => persistDraftForOwner(snapshot, projectId, activePersistence));
  }, [activePersistence, projectId, persistDraftForOwner, draft, queue]);
  useDraftSafeReload('Agent chat', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const persistence = draftPersistenceRef.current;
      const snapshot = draftSnapshotRef.current;
      if (!projectId) return;
      if (!persistence) {
        if (!snapshot.text && snapshot.queue.length === 0) return;
        throw new Error('the draft has not finished loading and cannot be saved yet');
      }
      if (persistence.idle && sameProjectDraft(snapshot, persistence.saved)) return;
      await flushDraftRef.current();
      const current = draftPersistenceRef.current;
      if (current?.idle && sameProjectDraft(draftSnapshotRef.current, current.saved)) return;
    }
    throw new Error('the draft kept changing while it was being saved');
  }, Boolean(projectId && !hydratedProjectDraftRef.current), () => {
    if (!projectId) return false;
    const persistence = draftPersistenceRef.current;
    const snapshot = draftSnapshotRef.current;
    return persistence
      ? !persistence.idle || !sameProjectDraft(snapshot, persistence.saved)
      : Boolean(snapshot.text || snapshot.queue.length);
  });
  useEffect(() => {
    if (!projectId || !hydratedProjectDraftRef.current) return;
    const timer = window.setTimeout(() => { void flushDraftRef.current().catch(() => undefined); }, 350);
    return () => window.clearTimeout(timer);
  }, [projectId, draft, queue]);
  useEffect(() => {
    const persistence = draftPersistenceRef.current;
    if (!projectId || !persistence || !draftScopeRef.current) return;
    const snapshot = draftSnapshotRef.current;
    unsavedProjectChatDrafts.set(projectId, { ...snapshot, dirty: !persistence.idle || !sameProjectDraft(snapshot, persistence.saved), scopeKey: draftScopeRef.current, persistence });
  }, [projectId, draft, queue]);
  useEffect(() => {
    if (draftPersistenceRef.current) draftPersistenceRef.current.mounted = true;
    return () => {
      if (draftPersistenceRef.current) draftPersistenceRef.current.mounted = false;
      void flushDraftRef.current().catch(() => undefined);
    };
  }, []);
  const activeSessionData = startingAgent ? undefined : readAgentSession(activeSession.data);
  const handleSetMainSession = useCallback(async (sessionId: string) => {
    if (!projectChat.data) return;
    await setMainSession.mutateAsync({ expectedRevision: projectChat.data.revision, sessionId });
    setActiveSessionId(sessionId);
  }, [projectChat.data, setMainSession]);
  const { scrollContainerRef, scrollContentRef, onScroll } = useChatScroll(
    activeSessionId,
    !activeSession.isLoading && activeSessionId !== null && activeSessionData?.id === activeSessionId,
    activeSessionData?.turns.length ?? 0,
  );
  const { clips, summary } = useCurrentAttachmentSet();

  const voice = useAgentVoice({
    onTranscription: (text) => {
      if (isPanelMountedRef.current) void handleSend(text);
    },
  });
  // Stable ref so registered handlers always invoke the current voice closure
  // without re-registering when useVoiceRecording returns new function identities.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const isPanelMountedRef = useRef(true);
  useEffect(() => {
    isPanelMountedRef.current = true;
    return () => {
      isPanelMountedRef.current = false;
      voiceRef.current.cancelRecording();
    };
  }, []);

  const renderedTurns = useMemo(
    () => buildRenderedTurns(activeSessionData?.turns ?? []),
    [activeSessionData?.turns],
  );
  const activeStatus = activeSessionData?.status;
  const sessionControl = activeSessionData?.control;
  const isFollower = sessionControl?.role === 'follower';
  const isCancelled = activeStatus === 'cancelled';
  const isProcessing = activeStatus === 'processing' || activeStatus === 'continue' || Boolean(sessionControl?.active);
  const showKillSwitch = !isFollower && (activeStatus === 'processing' || activeStatus === 'continue' || Boolean(sessionControl?.active));
  /** A saved row awaiting Send now remains visible after a failed attempt, even if its local turn was recorded. */
  const notSent = (item: QueuedMessage) => pausedQueuedIdsRef.current.has(item.id)
    && optimisticMessage?.id !== item.id
    && !(sessionControl?.active && item.id === sessionControl.activeRequestId);
  const stopAgent = useCallback(() => {
    setQueue([]);
    setPausedQueueHeadId(null);
    setOptimisticMessage(null);
    cancelSession.mutate();
  }, [cancelSession]);
  const activeAgentRow = localAgents.data?.agents.find(agent => agent.id === chatAgent);
  const agentBroken = Boolean(activeSessionId && localAgents.data && !isAgentUsable(activeAgentRow));
  const composerLockedRef = useRef(false);
  const configurationFailed = Boolean(startFailure?.sessionId && startFailure.sessionId === activeSessionId);
  composerLockedRef.current = isFollower || startingAgent !== null || configurationFailed || agentBroken || setupRequest !== null;
  useEffect(() => {
    if (isFollower || startingAgent) voiceRef.current.cancelRecording();
  }, [isFollower, startingAgent]);
  const showNoProjectState = !hasProject && sessionOptions.length === 0;
  // A saved row waiting for "Send now" is paused (`pausedQueuedIdsRef`): it never auto-sends, so it does not make the
  // composer look busy. Only a row that will be sent when the running turn ends is a real queue.
  const hasQueuedMessages = queue.some((item) => item.sessionId === activeSessionId && !pausedQueuedIdsRef.current.has(item.id));
  const activeQueue = startingAgent ? [] : queue.filter((item) => item.sessionId === activeSessionId);
  const transcriptRequestIds = useMemo(() => new Set(
    activeSessionData?.turns.flatMap(turn => turn.role === 'user' && turn.request_id ? [turn.request_id] : []) ?? [],
  ), [activeSessionData?.turns]);
  const displayedQueue = activeQueue.filter(item => notSent(item) || (item.id !== optimisticMessage?.id
    && !transcriptRequestIds.has(item.id)
    && !(sessionControl?.active && item.id === sessionControl.activeRequestId)));
  // A phone or tablet has no shortcut keys to press: its way to talk is the mic.
  const [coarsePointer] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true);
  const idlePlaceholder = !CHAT_VOICE_ENABLED
    ? 'Type a message...'
    : coarsePointer ? 'Type, or tap the mic to talk...' : 'Type or press Cmd+Shift+R to talk...';
  const setupAgentName = chatAgent === 'astrid' ? AGENT_CHAT_COPY.astridAgent : agentNames[chatAgent];
  const inputPlaceholder = agentBroken
    ? AGENT_CHAT_COPY.setupPlaceholder(setupAgentName)
    : startingAgent
    ? `Starting ${agentNames[startingAgent]}…`
    : showNoProjectState
    ? 'Select a project to start chatting...'
    : voice.isRecording
      ? 'Recording...'
      : (isProcessing || sendMessage.isPending || hasQueuedMessages)
        ? 'Type to queue next message...'
        : idlePlaceholder;
  const optimisticTurnAlreadyMaterialized = optimisticMessage !== null
    && Boolean(activeSessionData?.turns.some((turn) => turn.role === 'user' && turn.request_id === optimisticMessage.id));
  const promptFailure = sendMessage.localError && isAgentSetupError(sendMessage.error) ? sendMessage.error : sendMessage.localError;
  const chatFailures = [activeSession.error, promptFailure, createSession.error, sessions.error, projectChat.error].filter(error => {
    if (!isAgentSetupError(error)) return true;
    if (!setupErrorScopes.current.has(error)) setupErrorScopes.current.set(error, { agent: chatAgent, sessionId: activeSessionId });
    const source = setupErrorScopes.current.get(error)!;
    return !dismissedSetupErrors.current.has(error) && source.agent === chatAgent && source.sessionId === activeSessionId;
  });
  // No chat service on this computer is a state, not a failure: the pane says so in one plain line, with no alert or retry.
  const chatUnavailable = chatFailures.some(isAcpUnavailable);
  const showEmptyState = !startingAgent && !activeSession.isLoading && renderedTurns.length === 0 && !isProcessing && !sendMessage.isPending;
  const turnFailure = chatFailures.find(Boolean);
  const writableChat = hasProject && !isFollower && !chatUnavailable && !sessions.isError && !projectChat.isError;
  const defaultAgentRow = localAgents.data?.agents.find(agent => agent.id === defaultAgent);
  const defaultAgentReady = isAgentUsable(defaultAgentRow) && defaultAgentRow?.signIn !== 'unknown';
  const hasAvailableProjectSession = Boolean(projectChat.data?.sessions.some(session => !session.missing));
  const currentSetupRequest = setupRequest?.sessionId === activeSessionId ? setupRequest : null;
  const showSetupCard = writableChat && (currentSetupRequest !== null || (!activeSessionId && !hasAvailableProjectSession && Boolean(localAgents.data) && !defaultAgentReady));
  const inputDisabled = agentBroken || showSetupCard || startingAgent !== null || configurationFailed || isFollower || !hasProject || !activeSessionId || isCancelled || voice.isRecording || voice.isProcessing;
  // A prefilled prompt is a draft, never sent. It never overwrites an unsent draft: it goes after it. The cursor
  // lands at the end, so the user continues the sentence. Focus waits for an enabled composer: focus() on a disabled
  // textarea does nothing, and a click can arrive while the composer is still locked (starting, no session yet).
  const composerFocusPendingRef = useRef(false);
  useEffect(() => {
    if (pendingComposerPrompt) {
      setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${pendingComposerPrompt}` : pendingComposerPrompt));
      clearPendingComposerPrompt?.();
      composerFocusPendingRef.current = true;
    }
    if (!composerFocusPendingRef.current || inputDisabled) return;
    composerFocusPendingRef.current = false;
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  }, [clearPendingComposerPrompt, inputDisabled, pendingComposerPrompt]);
  const showSetupOnHost = !writableChat && (agentBroken || isAgentSetupError(turnFailure) || currentSetupRequest !== null);
  useEffect(() => {
    setupErrorScopes.current.forEach((source, error) => {
      if (source.sessionId !== activeSessionId) dismissedSetupErrors.current.add(error);
    });
    if (startFailure && isAgentSetupError(startFailure.error) && startFailure.sourceSessionId !== activeSessionId) setStartFailure(null);
    if (setupRequest && setupRequest.sessionId !== activeSessionId) {
      setupStartIsCurrentRef.current = undefined;
      setSetupRequest(null);
      setStartFailure(null);
    }
  }, [activeSessionId, setupRequest, startFailure]);
  const focusedSetupRef = useRef<typeof setupDone>(null);
  useEffect(() => {
    if (!setupDone || focusedSetupRef.current === setupDone || setupDone.sessionId !== activeSessionId
      || showSetupCard || agentBroken || startingAgent || configurationFailed || isFollower || isCancelled) return;
    inputRef.current?.focus({ preventScroll: true });
    focusedSetupRef.current = setupDone;
  }, [setupDone, activeSessionId, showSetupCard, agentBroken, startingAgent, configurationFailed, isFollower, isCancelled]);
  // The terminal note: once per browser, under "✓ X is set up" after the first finished reply; the chat menu reopens it.
  const [nudgeSeen, setNudgeSeen] = useSetting(terminalNudgeSeen);
  const [terminalNudge, setTerminalNudge] = useState<{ sessionId: string; afterTurns: number; fromMenu: boolean } | null>(null);
  const terminalNudgeRef = useRef<HTMLElement>(null);
  const agentTerminal = activeAgentRow?.terminal;
  const terminalCommand = agentTerminal?.skillSynced ? agentTerminal.command : null;
  const firstReplyIndex = renderedTurns.findIndex(item => item.kind === 'message' && item.turn.role === 'assistant');
  const setupDoneShown = Boolean(setupDone && setupDone.sessionId === activeSessionId && !showSetupCard && !agentBroken);
  useEffect(() => {
    if (nudgeSeen || !terminalCommand || !activeSessionId || !setupDoneShown || firstReplyIndex < 0 || isProcessing) return;
    setNudgeSeen(true);
    setTerminalNudge({ sessionId: activeSessionId, afterTurns: firstReplyIndex + 1, fromMenu: false });
  }, [nudgeSeen, terminalCommand, activeSessionId, setupDoneShown, firstReplyIndex, isProcessing, setNudgeSeen]);
  const showTerminalNudge = Boolean(terminalCommand && terminalNudge && terminalNudge.sessionId === activeSessionId);
  useEffect(() => {
    if (!showTerminalNudge || !terminalNudge?.fromMenu) return;
    terminalNudgeRef.current?.scrollIntoView?.({ block: 'nearest' });
    terminalNudgeRef.current?.focus({ preventScroll: true });
  }, [showTerminalNudge, terminalNudge]);
  const terminalNudgeView = showTerminalNudge && terminalCommand ? <TerminalNudge ref={terminalNudgeRef} agent={chatAgent} command={terminalCommand}
    projectName={editorContext?.projectName} onDismiss={() => { setTerminalNudge(null); inputRef.current?.focus({ preventScroll: true }); }} /> : null;
  useEffect(() => {
    if (!writableChat || !isAgentSetupError(turnFailure)) return;
    setSetupDone(null);
    setSetupRequest({ agent: chatAgent, sessionId: activeSessionId, error: turnFailure });
    void refetchLocalAgents();
  }, [turnFailure, writableChat, chatAgent, activeSessionId, refetchLocalAgents]);
  // One update flow: a reply from the local chat service this page can't read also puts Settings on Update Astrid
  // (it never gates the app). The next chat read that comes back readable clears it.
  const chatServiceOutOfDate = startFailure?.updateNeeded === true
    || [localAgents.error, ...chatFailures].some(isChatUpdateError);
  const chatReadSucceeded = localAgents.isSuccess || sessions.isSuccess;
  useEffect(() => {
    if (chatServiceOutOfDate) setLocalServiceOutOfDate(true);
    else if (chatReadSucceeded) setLocalServiceOutOfDate(false);
  }, [chatServiceOutOfDate, chatReadSucceeded, setLocalServiceOutOfDate]);
  const turnFailureMessage = turnFailure instanceof Error ? turnFailure.message : turnFailure ? String(turnFailure) : 'Agent error. Try again or start a new conversation.';

  const handleAttachmentPreviewClick = useCallback(async (attachment: AgentChatAttachmentPreviewItem) => {
    if (!attachment.generationId) {
      return;
    }

    const requestId = lightboxRequestIdRef.current + 1;
    lightboxRequestIdRef.current = requestId;
    setAttachmentLightboxMedia(null);

    try {
      const media = await loadGenerationForLightbox(attachment.generationId);
      if (lightboxRequestIdRef.current !== requestId) {
        return;
      }

      setAttachmentLightboxMedia(media);
    } catch (error) {
      if (lightboxRequestIdRef.current === requestId) {
        setAttachmentLightboxMedia(null);
      }
      console.warn('[AgentChat] Failed to open attachment lightbox', error);
    }
  }, []);

  const handleCloseAttachmentLightbox = useCallback(() => {
    lightboxRequestIdRef.current += 1;
    setAttachmentLightboxMedia(null);
  }, []);

  const handleRemoveAttachment = useCallback((attachment: AgentChatAttachmentPreviewItem) => {
    composerRemoveAttachment({
      url: attachment.url,
      mediaType: attachment.mediaType,
      generationId: attachment.generationId,
      clipId: attachment.clipId,
    });
  }, []);

  const handleRemoveShot = useCallback((shotId: string) => {
    clips
      .filter((clip) => clip.shotId === shotId)
      .forEach((clip) => composerRemoveAttachment({
        url: clip.url,
        mediaType: clip.mediaType,
        generationId: clip.generationId,
        clipId: clip.clipId,
      }));
  }, [clips]);

  const moveQueuedMessageUp = useCallback((index: number) => {
    if (index <= 0) {
      return;
    }

    setQueue((prev) => {
      if (index >= prev.length) {
        return prev;
      }
      const previous = prev[index];
      let siblingIndex = index - 1;
      while (siblingIndex >= 0 && prev[siblingIndex].sessionId !== previous.sessionId) siblingIndex -= 1;
      if (siblingIndex < 0) return prev;
      const next = [...prev];
      [next[siblingIndex], next[index]] = [next[index], next[siblingIndex]];
      return next;
    });
  }, []);

  const moveQueuedMessageDown = useCallback((index: number) => {
    setQueue((prev) => {
      if (index < 0 || index >= prev.length - 1) {
        return prev;
      }
      const current = prev[index];
      let siblingIndex = index + 1;
      while (siblingIndex < prev.length && prev[siblingIndex].sessionId !== current.sessionId) siblingIndex += 1;
      if (siblingIndex >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[siblingIndex]] = [next[siblingIndex], next[index]];
      return next;
    });
  }, []);

  const removeQueuedMessage = useCallback((id: string) => {
    pausedQueuedIdsRef.current.delete(id);
    if (pausedQueueHeadId === id) {
      setPausedQueueHeadId(null);
    }
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, [pausedQueueHeadId]);

  // Main is the opening default; retain explicit choices, including a New
  // selection queued before this render's opening-default updater applies.
  useEffect(() => {
    if (hasProject && !projectChat.data) return;
    if (setupStartIsCurrentRef.current?.() === false) return;
    setActiveSessionId(current => {
      if (current && (current === projectChat.data?.selected_session_id || sessionOptions.some(session => session.id === current))) return current;
      const preferred = projectChat.data?.selected_session_id ?? projectChat.data?.main_session_id;
      if (preferred && sessionOptions.some(session => session.id === preferred)) return preferred;
      return (sessionOptions.find(session => session.status !== 'cancelled') ?? sessionOptions[0])?.id ?? null;
    });
  }, [hasProject, hasMainContract, projectChat.data, sessionOptions]);

  // An empty engaged project gets one session. Existing project chats remain
  // selectable when Main is unset, and the host CAS claim arbitrates tabs.
  const isEngaged = userEngaged || isTasksPaneLocked || voice.isRecording || voice.isProcessing;
  useEffect(() => {
    if (hasAutoCreatedSessionRef.current || !projectChat.data || projectChat.isLoading || projectChat.isError
      || createSession.isPending || !hasProject
      || hasAvailableProjectSession || !isEngaged || !defaultAgentReady || setupRequest) return;
    hasAutoCreatedSessionRef.current = true;
    autoCreateOperationIdRef.current ??= createMessageId();
    createSession.mutate(autoCreateOperationIdRef.current, {
      onError: () => { /* Retain the operation ID for explicit recovery. */ },
      onSuccess: session => {
        autoCreateOperationIdRef.current = null;
        const sessionId = readSessionId(session);
        if (sessionId) setActiveSessionId(current => current ?? sessionId);
      },
    });
  }, [createSession, hasProject, hasAvailableProjectSession, projectChat.data, projectChat.isLoading, projectChat.isError, isEngaged, defaultAgentReady, setupRequest]);

  useEffect(() => {
    sendingRef.current = false;
    setPausedQueueHeadId(draftSnapshotRef.current.queue.find(item => item.sessionId === activeSessionId)?.id ?? null);
    setOptimisticMessage(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (!isFollower || !activeSessionId) return;
    const followerQueue = queue.filter(item => item.sessionId === activeSessionId);
    followerQueue.forEach(item => pausedQueuedIdsRef.current.add(item.id));
    if (followerQueue.length > 0) setPausedQueueHeadId(current => current ?? followerQueue[0].id);
  }, [isFollower, activeSessionId, queue]);

  useEffect(() => {
    if (pausedQueueHeadId && !queue.some((item) => item.id === pausedQueueHeadId)) {
      setPausedQueueHeadId(null);
    }
  }, [pausedQueueHeadId, queue]);

  // Clear optimistic message only when the matching turn appears in real data
  useEffect(() => {
    if (!optimisticMessage || !activeSessionData?.turns) return;
    if (activeSessionData.turns.length <= optimisticMessage.priorTurnCount) return;

    const hasRealTurn = activeSessionData.turns.some((turn, index) => (
      index >= optimisticMessage.priorTurnCount
      && turn.role === 'user'
      && turn.request_id === optimisticMessage.id
    ));

    if (hasRealTurn) {
      setOptimisticMessage(null);
    }
  }, [activeSessionData?.turns, optimisticMessage]);

  const reconcileAcceptedQueue = useCallback((ids: readonly string[], sessionId: string) => {
    const accepted = new Set(ids);
    const snapshot = draftSnapshotRef.current;
    const removed = snapshot.queue.filter(item => item.sessionId === sessionId && accepted.has(item.id));
    if (!removed.length) return false;
    const remaining = snapshot.queue.filter(item => !(item.sessionId === sessionId && accepted.has(item.id)));
    // Recovered delivery is not permission to dispatch a subsequent saved row.
    remaining.forEach(item => pausedQueuedIdsRef.current.add(item.id));
    removed.forEach(item => pausedQueuedIdsRef.current.delete(item.id));
    draftSnapshotRef.current = { ...snapshot, queue: remaining };
    setQueue(remaining);
    setPausedQueueHeadId(remaining.find(item => item.sessionId === sessionId)?.id ?? null);
    setOptimisticMessage(previous => previous && accepted.has(previous.id) ? null : previous);
    return true;
  }, []);
  useEffect(() => {
    if (!activeSessionId || !hydratedProjectDraftRef.current) return;
    const acceptedIds = activeSessionData?.durableAcceptedRequestIds ?? [];
    const inFlightId = sessionControl?.active ? sessionControl.activeRequestId : null;
    reconcileAcceptedQueue(inFlightId ? acceptedIds.filter(id => id !== inFlightId) : acceptedIds, activeSessionId);
  }, [activeSessionId, activeSessionData?.durableAcceptedRequestIds, queue, reconcileAcceptedQueue, sessionControl?.active, sessionControl?.activeRequestId]);

  const sendingRef = useRef(false);
  const currentSessionRef = useRef(activeSessionId);
  currentSessionRef.current = activeSessionId;
  const currentContextRef = useRef(editorContext);
  currentContextRef.current = editorContext;
  const sendNow = useCallback(async (item: QueuedMessage, retryCaptured = false, checkSaved = false) => {
    if (!activeSessionId || !projectId || !editorContext || item.sessionId !== activeSessionId || composerLockedRef.current || sessionControl?.active) {
      return;
    }

    const isCurrent = () => isPanelMountedRef.current && currentSessionRef.current === item.sessionId
      && !draftSnapshotRef.current.queue.some(row => row.id === item.id && row.sessionId !== item.sessionId)
      && currentContextRef.current?.projectId === projectId && currentContextRef.current?.timelineId === editorContext.timelineId;
    const priorTurnCount = activeSessionData?.turns.length ?? 0;
    const sentAtMs = Date.now();

    sendingRef.current = true;
    pausedQueuedIdsRef.current.add(item.id);
    // Persist the exact captured submission before an ownership lookup or ACP
    // dispatch can fail. A reopened panel pauses this durable head for retry.
    const retainedQueue = draftSnapshotRef.current.queue.some(row => row.id === item.id)
      ? draftSnapshotRef.current.queue : [...draftSnapshotRef.current.queue, item];
    draftSnapshotRef.current = { text: draftSnapshotRef.current.text, queue: retainedQueue };
    setQueue(retainedQueue);
    setOptimisticMessage({
      id: item.id,
      sessionId: item.sessionId,
      text: item.text,
      attachments: item.attachments,
      sentAtMs,
      priorTurnCount,
    });

    try {
      await flushDraftRef.current();
      if (!isCurrent()) return;
      if (checkSaved && await sendMessage.checkAcceptedRequest(item.id)) {
        if (isCurrent()) { reconcileAcceptedQueue([item.id], item.sessionId); await flushDraftRef.current(); }
        return;
      }
      if (!isCurrent()) return;
      if (retryCaptured) await sendMessage.retryLastMessage();
      else await sendMessage.mutateAsync({
        input: { message: item.text, attachments: item.attachments, requestId: item.id },
        projectId,
        sessionId: item.sessionId,
        context: editorContext,
      });
      if (!isCurrent()) return;
      pausedQueuedIdsRef.current.delete(item.id);
      const remaining = draftSnapshotRef.current.queue.filter(row => row.id !== item.id);
      draftSnapshotRef.current = { ...draftSnapshotRef.current, queue: remaining };
      setQueue(remaining);
      setPausedQueueHeadId(prev => prev === item.id ? null : prev);
      setOptimisticMessage(prev => prev?.id === item.id ? null : prev);
      await flushDraftRef.current();
    } catch (error) {
      if (!isCurrent()) return;
      setPausedQueueHeadId(item.id);
      setOptimisticMessage((prev) => (prev && prev.id === item.id ? null : prev));
      throw error;
    } finally {
      if (isCurrent()) sendingRef.current = false;
    }
  }, [activeSessionData?.turns.length, activeSessionId, editorContext, projectId, sendMessage, reconcileAcceptedQueue, sessionControl?.active]);

  const handleSend = useCallback(async (rawText?: string) => {
    const text = (rawText ?? draft).trim();
    if (!text || !activeSessionId || !hasProject || composerLockedRef.current) return;

    const attachments: AgentTurnAttachment[] = clips.map((clip) => ({
      clipId: clip.clipId,
      url: clip.url,
      mediaType: clip.mediaType,
      isTimelineBacked: clip.isTimelineBacked,
      generationId: clip.generationId,
      variantId: clip.variantId,
      shotId: clip.shotId,
      shotName: clip.shotName,
      shotSelectionClipCount: clip.shotSelectionClipCount,
      trackId: clip.trackId,
      at: clip.at,
      duration: clip.duration,
    }));

    if (rawText === undefined) {
      setDraft('');
      draftSnapshotRef.current = { ...draftSnapshotRef.current, text: '' };
    }
    const item: QueuedMessage = {
      id: createMessageId(),
      text,
      sessionId: activeSessionId,
      attachments,
    };
    composerClearAttachments();

    if (
      sendingRef.current
      || isFollower
      || isProcessing
      || sendMessage.isPending
      || optimisticMessage
      // Paused rows are waiting on the person, not on a turn: a new message sends now, ahead of them, and they stay put.
      || queue.some((row) => row.sessionId === activeSessionId && !pausedQueuedIdsRef.current.has(row.id))
    ) {
      setQueue((prev) => [...prev, item]);
      return;
    }

    try { await sendNow(item); } catch {
      // The durable queue and visible recovery retain the failed submission.
    }
  }, [activeSessionId, clips, draft, hasProject, isProcessing, isFollower, optimisticMessage, queue, sendMessage.isPending, sendNow]);

  useEffect(() => {
    if (
      sendingRef.current
      || startingAgent !== null
      || configurationFailed
      || agentBroken
      || setupRequest !== null
      || isFollower
      || isProcessing
      || sendMessage.isPending
      || optimisticMessage
      || queue.length === 0
      || !activeSessionId
      || !projectId
    ) {
      return;
    }

    const next = draftSnapshotRef.current.queue.find((item) => item.sessionId === activeSessionId);
    if (!next || next.id === pausedQueueHeadId || pausedQueuedIdsRef.current.has(next.id)) {
      return;
    }

    void (async () => {
      try {
        await sendNow(next);
        setQueue((prev) => prev.filter((item) => item.id !== next.id));
      } catch {
        // Leave the failed head in place; pausedQueueHeadId will prevent further drains.
      }
    })();
  }, [queue, pausedQueueHeadId, startingAgent, configurationFailed, agentBroken, setupRequest, isFollower, isProcessing, sendMessage.isPending, optimisticMessage, activeSessionId, projectId, sendNow]);

  const handleNewSession = useCallback(async (agent?: LocalAgentId, model?: string, isCurrent?: () => boolean): Promise<string | null> => {
    if (!projectId) return null;
    if (!manualCreateOperationIdRef.current || manualCreateOperationIdRef.current.agent !== agent || manualCreateOperationIdRef.current.model !== model) {
      manualCreateOperationIdRef.current = { projectId, id: createMessageId(), agent, model };
    }
    const operation = manualCreateOperationIdRef.current;
    const session = await createNewSession.mutateAsync({ operationId: operation.id, ...(agent ? { agent } : {}), ...(model ? { defaultModelId: model } : {}) });
    if (!isPanelMountedRef.current || isCurrent?.() === false || manualCreateOperationIdRef.current !== operation
      || currentContextRef.current?.projectId !== operation.projectId) return null;
    manualCreateOperationIdRef.current = null;
    const sessionId = readSessionId(session);
    if (sessionId) {
      setPausedQueueHeadId(null);
      setOptimisticMessage(null);
      setSetupRequest(current => current ? { ...current, sessionId } : null);
      setActiveSessionId(sessionId);
      setIsTasksPaneLocked?.(true);
    }
    return sessionId ?? null;
  }, [createNewSession, projectId, setIsTasksPaneLocked]);

  const startChatWith = useCallback(async (agent?: LocalAgentId, model?: string, thoughtLevel?: string, recoverySessionId?: string, isCurrent?: () => boolean) => {
    const chosen = agent ?? defaultAgent;
    const sourceSessionId = currentSessionRef.current;
    setupStartIsCurrentRef.current = isCurrent;
    let sessionId: string | null = null;
    setStartFailure(null);
    setStartingAgent(chosen);
    try {
      sessionId = recoverySessionId ?? await handleNewSession(agent, model, isCurrent);
      if (isCurrent?.() === false) return {};
      // Join this chat's initial options read before validating its fixed model
      // and applying the selected thinking level.
      if (sessionId) await configureSession.mutateAsync({ sessionId, model, thoughtLevel });
      return { sessionId };
    } catch (error) {
      if (isCurrent?.() === false || (currentSessionRef.current !== sourceSessionId && currentSessionRef.current !== sessionId)) return {};
      if (isAgentSetupError(error) && hasProject && !isFollower) { setSetupDone(null); setSetupRequest({ agent: chosen, sessionId: sessionId ?? sourceSessionId, error }); void refetchLocalAgents(); }
      setStartFailure({ agent: chosen, choice: agent, model, thoughtLevel, sessionId: sessionId ?? undefined, sourceSessionId: sessionId ?? sourceSessionId, error, details: error instanceof Error ? error.message : String(error), updateNeeded: isChatUpdateError(error) });
      return { error };
    } finally {
      setStartingAgent(null);
    }
  }, [defaultAgent, handleNewSession, configureSession, hasProject, isFollower, refetchLocalAgents]);

  // Cmd+Shift+R global shortcut — kept verbatim per plan_v5 Step 4.7.
  useEffect(() => {
    // Chat voice is switched off: the shortcut is not registered.
    if (!CHAT_VOICE_ENABLED) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (!hasProject || isFollower || startingAgent) {
          return;
        }
        if (voice.isRecording) {
          voice.stopRecording();
        } else if (!voice.isProcessing) {
          voice.startRecording();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasProject, isFollower, startingAgent, voice]);

  // ==========================================================================
  // Actions registry — exposes stable handlers the parent (TasksPane split
  // button) can invoke. Stable identity means the registration effect runs
  // exactly once per mount, even though `voice` re-renders. Reactive state is
  // published separately so the split button mic icon flips with recording.
  // ==========================================================================
  const actionsRegistry = useAgentChatActionsRegistry();
  const stableHandlers = useMemo<AgentChatActionsHandlers>(() => ({
    toggleRecording: () => {
      if (composerLockedRef.current) return;
      const v = voiceRef.current;
      if (v.isRecording) {
        v.stopRecording();
      } else if (!v.isProcessing) {
        v.startRecording();
      }
    },
    focusComposer: () => {
      // The pane may still be sliding in: do not scroll the page to reach it.
      inputRef.current?.focus({ preventScroll: true });
    },
    markEngaged: () => {
      setUserEngaged(true);
    },
  }), []);

  // Astrid is answering: the turn is running, being sent or queued behind one.
  // Element operations stay in this state until their durable Runtime ACK;
  // name that wait so a slow save is visibly pending rather than looking done.
  const agentWorking = isProcessing || sendMessage.isPending || hasQueuedMessages;
  const elementOperationPending = isProcessing && /<astrid_element_operation>/.test(activeSessionData?.assistantDraft ?? '');
  const activeSessionOption = sessionOptions.find(session => session.id === activeSessionId);
  const activeChatTitle = activeSessionOption?.title?.trim() || `Chat ${activeSessionOption?.chatNumber ?? Math.max(sessionOptions.length, 1)}`;
  const downloadChat = () => {
    if (!activeSessionId || activeSessionData?.id !== activeSessionId || !activeSessionData.turns.length) return;
    const capturedDate = new Date();
    const capturedAt = capturedDate.toISOString();
    const turns: ConversationExportTurn[] = activeSessionData.turns.map(turn => {
      if (turn.role !== 'assistant') return { turn };
      const presented = presentEditorRequests(turn.content, turn.timestamp, activeSessionData.recordedEditorResults);
      return { turn: { ...turn, content: presented.prose }, editorActions: presented.pairs };
    });
    if (optimisticMessage && optimisticMessage.sessionId === activeSessionId && !optimisticTurnAlreadyMaterialized) {
      turns.push({ turn: {
        role: 'user', content: optimisticMessage.text, timestamp: new Date(optimisticMessage.sentAtMs).toISOString(),
        attachments: optimisticMessage.attachments,
      } });
    }
    if (activeSessionData.assistantDraft?.trim()) {
      turns.push({ turn: { role: 'assistant', content: activeSessionData.assistantDraft, timestamp: capturedAt }, inProgress: true });
    }
    const markdown = formatConversationExport({
      title: activeChatTitle,
      agent: agentNames[chatAgent],
      model: chatModelName ?? chatModelId,
      thinkingLevel: chatThoughtLevel
        ? chatThoughtLevel.options.find(option => option.value === chatThoughtLevel.currentValue)?.name ?? chatThoughtLevel.currentValue
        : null,
      sessionId: activeSessionId,
      capturedAt,
      inProgress: isProcessing,
      turns,
    });
    downloadBlobAsFile(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), conversationExportFilename(activeChatTitle, capturedDate));
  };

  useEffect(() => {
    actionsRegistry.registerHandlers(stableHandlers);
    actionsRegistry.publishState({
      isRecording: voice.isRecording,
      isProcessing: voice.isProcessing,
      isAgentWorking: agentWorking,
    });
    return () => actionsRegistry.unregister();
    // stableHandlers and actionsRegistry are both referentially stable, so this
    // effect runs exactly once per mount despite voice churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionsRegistry, stableHandlers]);

  useEffect(() => {
    actionsRegistry.publishState({
      isRecording: voice.isRecording,
      isProcessing: voice.isProcessing,
      isAgentWorking: agentWorking,
    });
  }, [actionsRegistry, voice.isRecording, voice.isProcessing, agentWorking]);

  return (
    // No background of its own — sits on the parent pane's bg so the only
    // visible color change between halves is the divider line itself.
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Header: one menu names the chat (switch, start, rename); the small line under it is the chat's agent and model. */}
      <div data-testid="agent-chat-header" className="relative flex min-w-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5">
        <div className="-ml-1.5 flex min-w-0 flex-col items-start">
          <AgentChatMenu
            ref={chatMenuRef}
            sessions={sessionOptions}
            activeSessionId={activeSessionId}
            mainSessionId={projectChat.data?.main_session_id ?? null}
            settingMainSessionId={setMainSession.isPending ? setMainSession.variables?.sessionId ?? null : null}
            describeSession={describeSession}
            onSelectSession={(sessionId) => {
              if (!projectId || !projectChat.data) return;
              void selectSession.mutateAsync({ expectedRevision: projectChat.data.revision, sessionId }).then(() => { setSetupRequest(null); setSetupDone(null); setActiveSessionId(sessionId); }).catch(() => undefined);
            }}
            onSetMainSession={hasMainContract
              ? (sessionId) => void handleSetMainSession(sessionId).catch(() => undefined)
              : undefined}
            onRenameSession={projectChat.data
              ? (sessionId, title) => renameSession.mutateAsync({ expectedRevision: projectChat.data!.revision, sessionId, title })
              : undefined}
            starting={startingAgent !== null}
            disabled={startingAgent !== null || !hasProject}
            defaultAgent={defaultAgent}
            agents={localAgents.data?.agents}
            agentModelNames={agentModelNames}
            agentCanBrowse={agentCanBrowse}
            agentsLoading={localAgents.isLoading}
            agentsError={localAgents.error instanceof Error ? localAgents.error : null}
            newChatDisabled={createNewSession.isPending}
            onBrowseAgent={setBrowseAgent}
            agentModels={newChatModels}
            onNewChat={(agent, model, thoughtLevel) => void startChatWith(agent, model, thoughtLevel)}
            onSetupAgent={agent => { setSetupDone(null); setSetupRequest({ agent, sessionId: activeSessionId }); }}
            attachExisting={projectId ? { open: showAttachSessions, toggle: () => setShowAttachSessions((open) => !open) } : undefined}
            onOpenChange={(open) => {
              if (open) void localAgents.refetch();
              setHeaderOverlayOpen('menu', open);
            }}
            onUseFromTerminal={terminalCommand && activeSessionId
              ? () => setTerminalNudge({ sessionId: activeSessionId, afterTurns: renderedTurns.length, fromMenu: true })
              : undefined}
          />
          <AgentChatModelLine
            agent={startingAgent ?? chatAgent}
            hasChat={Boolean(activeSessionId) && !startingAgent}
            modelName={startingAgent ? null : activeSessionId ? chatModelName : agentModelNames[defaultAgent] ?? null}
            thoughtLevel={activeSessionId ? chatThoughtLevel : null}
            thoughtLevelFixed={chatThoughtLevelFixed}
            thinkingLockedReason={isFollower
              ? 'Take over this chat to change its thinking level.'
              : isProcessing || sendMessage.isPending ? 'The thinking level can change once this reply finishes.' : null}
            onChangeThinkingLevel={(thoughtLevel) => configureSession.mutateAsync({ sessionId: activeSessionId!, thoughtLevel })}
            onChooseAnotherModel={() => chatMenuRef.current?.openModels(chatAgent)}
            onOpenChange={(open) => setHeaderOverlayOpen('model', open)}
          />
        </div>
        <div className="flex h-7 shrink-0 items-center gap-1 self-start">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={downloadChat}
            disabled={!activeSessionId || activeSessionData?.id !== activeSessionId || !activeSessionData.turns.length}
            title="Download this chat"
            aria-label="Download this chat"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <NewChatMenu
            ref={newChatMenuRef}
            current={activeSessionId && !startingAgent ? {
              agent: chatAgent,
              model: chatModelId ?? undefined,
              modelName: chatModelName,
              thoughtLevel: chatThoughtLevel?.options.length && !chatThoughtLevelFixed ? chatThoughtLevel.currentValue : undefined,
            } : null}
            defaultAgent={defaultAgent}
            agents={localAgents.data?.agents}
            agentModelNames={agentModelNames}
            agentCanBrowse={agentCanBrowse}
            astridKeyConfigured={astridKeyConfigured}
            agentsLoading={localAgents.isLoading}
            agentsError={localAgents.error instanceof Error ? localAgents.error : null}
            disabled={startingAgent !== null || !hasProject}
            newChatDisabled={createNewSession.isPending}
            onBrowseAgent={setBrowseAgent}
            agentModels={newChatModels}
            onSetupAgent={agent => { setSetupDone(null); setSetupRequest({ agent, sessionId: activeSessionId }); }}
            onAstridKeySaved={async () => { await localAgents.refetch({ cancelRefetch: false }); }}
            onNewChat={(agent, model, thoughtLevel) => { setSetupRequest(null); setSetupDone(null); void startChatWith(agent, model, thoughtLevel); }}
            onOpenChange={(open) => {
              if (open) void localAgents.refetch();
              setHeaderOverlayOpen('newChat', open);
            }}
          />
          {isProcessing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />}
        </div>
      </div>
      {startFailure && !showSetupCard && !isAgentSetupError(startFailure.error) && (
        <div role="alert" className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {startFailure.updateNeeded
            ? <ChatUpdateNeeded detail={startFailure.details} />
            : <><p>{agentNames[startFailure.agent]} didn't start.</p><p>Details: {startFailure.details}</p></>}
          <button type="button" className="mt-1 underline" onClick={() => void startChatWith(startFailure.choice, startFailure.model, startFailure.thoughtLevel, startFailure.sessionId)}>Try again</button>
        </div>
      )}
      {showAttachSessions && projectId && (
        <div id="unassigned-project-chats" className="border-b border-border/70 px-4 py-2" aria-label="Unassigned existing chats">
          <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
            {unassignedSessions.data?.map((session) => (
              <button
                key={session.id}
                type="button"
                className="truncate rounded px-2 py-1 text-left text-xs hover:bg-muted disabled:opacity-50"
                disabled={associateSession.isPending || !projectChat.data}
                onClick={() => {
                  if (!projectChat.data) return;
                  associateSession.mutate({ expectedRevision: projectChat.data.revision, sessionId: session.id }, {
                    onSuccess: (chat) => setActiveSessionId(chat.selected_session_id),
                  });
                }}
                title={session.title ?? session.id}
              >
                {session.title || session.id}
              </button>
            ))}
            {unassignedSessions.isLoading && <span className="px-2 py-1 text-xs text-muted-foreground">Loading sessions…</span>}
            {!unassignedSessions.isLoading && !unassignedSessions.data?.length && <span className="px-2 py-1 text-xs text-muted-foreground">No unassigned OMP sessions.</span>}
          </div>
        </div>
      )}
      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={onScroll} {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.chatTranscript }} className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {isFollower && (
          // Stays in view while scrolling, just under the header that names the chat's agent.
          <div role="status" className="sticky top-0 z-10 mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-border/70 bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm">
            <span>Active in another tab</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              aria-label="Active in another tab — take over"
              disabled={takeOverSession.isPending || !activeSessionId || !projectId}
              onClick={() => takeOverSession.mutate()}
            >
              Take over
            </Button>
            {takeOverSession.error && <span role="alert">Could not take over: {takeOverSession.error instanceof Error ? takeOverSession.error.message : String(takeOverSession.error)}</span>}
          </div>
        )}
        {draftSaveError && (
          <div role="alert" className="mb-2 rounded-md border border-destructive/40 p-2 text-xs text-destructive">
            <p>
              A queued message could not be saved to Astrid ({draftSaveError}). It is still queued in this window, but reloading or closing it would lose it.{' '}
              <button type="button" className="underline" onClick={() => void flushDraftRef.current().catch(() => undefined)}>Retry</button>
            </p>
          </div>
        )}
        {startingAgent && !showSetupCard && (
          <div role="status" className="flex min-h-full items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Starting {agentNames[startingAgent]}…
          </div>
        )}
        {!startingAgent && !showSetupCard && activeSession.isLoading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        )}

        {showSetupCard && <AgentSetupCard
          agents={localAgents.data?.agents ?? []}
          defaultAgent={defaultAgent}
          initialAgent={currentSetupRequest?.agent}
          initialError={currentSetupRequest?.error}
          refetchAgents={localAgents.refetch}
          onSetup={agent => setSetupRequest({ agent, sessionId: activeSessionId })}
          startChatWith={async (agent, model, isCurrent) => {
            setSetupRequest(current => current ?? { agent, sessionId: activeSessionId });
            hasAutoCreatedSessionRef.current = true;
            const recovery = startFailure?.agent === agent && (!model || model === startFailure.model) ? startFailure : null;
            return startChatWith(agent, model ?? recovery?.model, recovery?.thoughtLevel, recovery ? recovery.sessionId
              : !startFailure && activeSessionId && sessionAgentId(activeSessionId) === agent && (!model || model === chatModelId) ? activeSessionId : undefined, isCurrent);
          }}
          onComplete={(agent, sessionId) => {
            setupStartIsCurrentRef.current = undefined;
            setSetupRequest(null);
            setStartFailure(null);
            setupErrorScopes.current.forEach((_scope, error) => dismissedSetupErrors.current.add(error));
            createSession.reset();
            sendMessage.clearLocalError?.();
            setSetupDone({ agent, sessionId: sessionId ?? currentSessionRef.current });
          }}
        />}
        {!showSetupCard && !agentBroken && setupDone && setupDone.sessionId === activeSessionId && <div role="status" className="space-y-1 py-3 text-sm">
          <p>{AGENT_CHAT_COPY.setupDone(setupDone.agent === 'astrid' ? AGENT_CHAT_COPY.astridAgent : agentNames[setupDone.agent])}</p>
          <p className="text-muted-foreground">{AGENT_CHAT_COPY.firstMessage}</p>
        </div>}
        {showEmptyState && !showSetupCard && setupDone?.sessionId !== activeSessionId && (
          <div className="flex min-h-full flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground">
            {chatUnavailable ? (
              <p>{CHAT_UNAVAILABLE}</p>
            ) : sessions.isError ? (
              <>
                <p>Local Astrid chat is unavailable.</p>
                <p className="mt-1 text-xs">Start the Astrid ACP bridge, then reopen this pane.</p>
              </>
            ) : showNoProjectState ? (
              <>
                <p>Select a project to start chatting.</p>
                <p className="mt-1 text-xs">Open a project to create a conversation.</p>
              </>
            ) : (
              <>
                <p>✨ I can do almost anything</p>
                {CHAT_VOICE_ENABLED && (coarsePointer
                  ? <p className="mt-1 text-xs">Tap the mic to talk</p>
                  : <p className="mt-1 text-xs">Press <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">Cmd+Shift+R</kbd> to talk</p>)}
                <p data-testid="agent-chat-runs-with" className="mt-4 flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-[11px]">
                  <AgentIcon agent={startingAgent ?? chatAgent} className="h-3 w-3 shrink-0" />
                  {agentNames[chatAgent]} · {chatModelName ?? 'default model'}
                </p>
              </>
            )}
          </div>
        )}

        <div ref={scrollContentRef} className="flex flex-col gap-2.5">
          {terminalNudge?.afterTurns === 0 && terminalNudgeView && <div className="py-1">{terminalNudgeView}</div>}
          {renderedTurns.map((item, turnIndex) => [
            item.kind === 'message' ? (
              <AgentChatMessage
                key={item.key}
                turn={item.turn}
                recordedResults={activeSessionData?.recordedEditorResults}
                onAttachmentClick={handleAttachmentPreviewClick}
              />
            ) : (
              <div key={`${activeSessionId}:${item.key}`} className="space-y-2">
                <AgentChatToolGroup pairs={item.pairs} />
                {item.pairs.map((pair, index) => <div key={pair.call.tool_call_id ?? index} data-agent-tool-call-id={pair.call.tool_call_id}>
                  <AgentTaskResults refs={pair.result?.task_refs ?? pair.call.task_refs ?? []} projectId={projectId} />
                </div>)}
              </div>
            ),
            terminalNudge?.afterTurns === turnIndex + 1 ? <div key="terminal-nudge" className="py-1">{terminalNudgeView}</div> : null,
          ])}

          {!startingAgent && optimisticMessage && !optimisticTurnAlreadyMaterialized && (
            <div className="flex w-full justify-end">
              <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
                <div>{optimisticMessage.text}</div>
                {optimisticMessage.attachments.length > 0 && (
                  <AgentChatAttachmentStrip
                    attachments={optimisticMessage.attachments}
                    isUser
                  />
                )}
              </div>
            </div>
          )}

          {!startingAgent && agentWorking && (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {elementOperationPending ? 'Adding…' : 'Thinking...'}
            </div>
          )}
        </div>

      </div>

      {/* Input bar */}
      <div className="border-t border-border/70 px-3 py-3">
        {displayedQueue.length > 0 && (
          <div className="mb-2 flex flex-col gap-2">
            {displayedQueue.map((item, index) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs"
              >
                <div className="flex-1 text-foreground">
                  <div className="line-clamp-2 break-words leading-relaxed">{item.text}</div>
                  {notSent(item) && <div className="text-muted-foreground">Not sent{item.id === pausedQueueHeadId && !isFollower ? '. Delivery not confirmed: Send now checks saved history first, and may send this message again.' : ''}</div>}
                </div>
                {item.attachments.length > 0 && (
                  <span className="shrink-0 rounded-full bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground">
                    {`📎 ${item.attachments.length}`}
                  </span>
                )}
                {notSent(item) && (isFollower ? (
                  <Button type="button" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={takeOverSession.isPending || !activeSessionId || !projectId} onClick={() => takeOverSession.mutate()}>
                    Take over to send
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    disabled={Boolean(sessionControl?.active) || activeSession.isLoading || sendMessage.isPending || Boolean(optimisticMessage)}
                    onClick={() => { void sendNow(item, sendMessage.hasCapturedMessage?.(item.sessionId, item.id) ?? false, true).catch(() => undefined); }}
                  >
                    Send now
                  </Button>
                ))}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  disabled={isFollower || index === 0}
                  onClick={() => moveQueuedMessageUp(queue.indexOf(item))}
                  title="Move queued message up"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  disabled={isFollower || index === displayedQueue.length - 1}
                  onClick={() => moveQueuedMessageDown(queue.indexOf(item))}
                  title="Move queued message down"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  disabled={isFollower}
                  onClick={() => removeQueuedMessage(item.id)}
                  title="Remove queued message"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {clips.length > 0 && (
          <div className="mb-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <AgentChatAttachmentStrip
              attachments={clips}
              isUser={false}
              className="mt-0"
              onAttachmentClick={handleAttachmentPreviewClick}
              onRemoveAttachment={handleRemoveAttachment}
              onRemoveShot={handleRemoveShot}
              maxPreviewCount={null}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span>{summary}</span>
              {clips.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    // Clear both surfaces. Gallery is always available; the
                    // timeline-side replace is bridge-nullable when no
                    // VideoEditorProvider is mounted (e.g. /shots, /art routes).
                    composerClearAttachments();
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}

        {voice.isRecording && (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-red-500/10 px-3 py-2 text-sm">
            <div className="flex items-center gap-2 text-red-400">
              <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-red-500" />
              Recording... {voice.remainingSeconds}s
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-red-400 hover:text-red-300"
              onClick={() => voice.stopRecording()}
            >
              Done
            </Button>
          </div>
        )}

        {voice.isProcessing && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Transcribing...
          </div>
        )}

        {!isProcessing && !sendMessage.isPending && isCancelled && (
          <div className="mb-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Session stopped. Start a new conversation to continue.
          </div>
        )}

        {chatUnavailable && !showEmptyState && (
          <p className="mb-2 px-1 text-xs text-muted-foreground">{CHAT_UNAVAILABLE}</p>
        )}

        {!agentBroken && !showSetupCard && !showSetupOnHost && !isProcessing && !sendMessage.isPending && !isCancelled && !chatUnavailable && !isAgentSetupError(turnFailure) && (turnFailure || (activeStatus === 'error' && setupDone?.sessionId !== activeSessionId)) && (
          <div role="alert" className="mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {isChatUpdateError(turnFailure) ? <ChatUpdateNeeded detail={turnFailure.message} /> : turnFailureMessage}
            {(sessions.error || projectChat.error) && (
              <button type="button" className="ml-2 underline" disabled={sessions.isFetching || projectChat.isFetching}
                onClick={() => { void sessions.refetch(); void projectChat.refetch(); }}>
                Retry
              </button>
            )}
            {createSession.error && (
              <button type="button" className="ml-2 underline" disabled={createSession.isPending}
                onClick={() => createSession.mutate(autoCreateOperationIdRef.current ?? undefined)}>
                Retry
              </button>
            )}
            {activeSession.error && (
              <button type="button" aria-label="Retry saved chat" className="ml-2 underline" disabled={activeSession.isFetching} onClick={() => { void activeSession.refetch(); }}>
                Retry
              </button>
            )}
          </div>
        )}

        {showSetupOnHost && <p className="mb-2 text-xs text-muted-foreground">{AGENT_CHAT_COPY.setupOnHost(setupAgentName)}</p>}
        {writableChat && agentBroken && !showSetupCard && <p className="mb-2 text-xs text-muted-foreground">
          {activeAgentRow?.line && <CommandLine line={activeAgentRow.line} />}{' '}
          <button type="button" className="underline" onClick={() => { setSetupDone(null); setSetupRequest({ agent: chatAgent, sessionId: activeSessionId }); }}>{AGENT_CHAT_COPY.setUp}</button>
        </p>}
        <AgentChatComposer
          inputRef={inputRef}
          value={startingAgent ? '' : draft}
          onChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          rows={isExpanded ? 8 : 4}
          placeholder={inputPlaceholder}
          inputDisabled={inputDisabled}
          voice={CHAT_VOICE_ENABLED ? {
            isRecording: voice.isRecording,
            onToggle: () => voice.isRecording ? voice.stopRecording() : voice.startRecording(),
            onCancel: () => voice.cancelRecording(),
            micDisabled: agentBroken || showSetupCard || startingAgent !== null || configurationFailed || isFollower || !hasProject || !activeSessionId || isCancelled || voice.isProcessing || sendMessage.isPending,
          } : undefined}
          onSend={() => void handleSend()}
          sendDisabled={agentBroken || showSetupCard || startingAgent !== null || configurationFailed || isFollower || !hasProject || !draft.trim() || !activeSessionId || isCancelled}
          onStop={showKillSwitch ? stopAgent : undefined}
          stopDisabled={cancelSession.isPending}
        />
      </div>

      {attachmentLightboxMedia && (
        <MediaLightbox
          media={attachmentLightboxMedia}
          initialVariantId={attachmentLightboxMedia.primary_variant_id ?? undefined}
          onClose={handleCloseAttachmentLightbox}
          features={{ showDownload: true, showTaskDetails: true }}
        />
      )}
    </div>
  );
}
