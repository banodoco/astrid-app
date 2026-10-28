import { projectPackContext, refreshProjectElementContext } from '../runtime/admitted-elements';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type AcpModelCatalog, type ProjectChatState } from '@/integrations/astrid/acpRoutes.ts';
import { BridgeRouteError, BridgeTransportFailure } from '@/integrations/astrid/transport.ts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { AstridLocalClient } from '@/integrations/astrid/client.ts';
import type { AgentChatEditorContext } from '@/shared/contexts/AgentChatContext.tsx';
import type { AgentTurn, AgentTurnAttachment, AgentSessionStatus } from '@/tools/video-editor/types/agent-session.ts';
import { timelineQueryKey, assetRegistryQueryKey } from '@/tools/video-editor/hooks/useTimeline.ts';
import type { LiveSceneScope } from '@/sdk/video/liveSceneAuthoring';
import type { LiveSceneOperationPort } from '@/tools/video-editor/runtime/liveSceneOperationPort';
import { recordedEditorResults, type RecordedEditorResult } from '../runtime/editorRequestPresentation';
import { runElementAcpRoundtrip } from '../runtime/elementAcpRoundtrip';
import { acceptedReplayRequestIds } from '../runtime/agentRequestReceipts';
import { readAstridTaskRefs, mergeAstridTaskRefs, type AgentTaskLink } from '../runtime/agentTaskLinks';
import { defaultThoughtLevel, knownSessionAgentId, sessionAgentId, type LocalAgentId, type LocalAgentModels } from '@/integrations/astrid/localAgents.ts';
import { AGENT_CHAT_COPY } from '@/integrations/astrid/chatCopy.ts';
import { ACP_SESSION_CONTROL_FIELD, ACP_SESSION_CONTROL_UPDATE, type AcpSessionControl } from '@/integrations/astrid/acpSessionControl.ts';

type AgentModelCatalog = AcpModelCatalog & { localModels?: LocalAgentModels | null };
export type NewAgentSessionChoice = { agent?: LocalAgentId; defaultModelId?: string };

type SendMessageInput = { message: string; attachments?: AgentTurnAttachment[]; requestId?: string };
type CapturedSendInput = { input: SendMessageInput; projectId: string | null; sessionId: string; context: AgentChatEditorContext };
export type TrackedAgentTurn = AgentTurn & { messageId?: string };
export type AgentSessionView = {
  id: string;
  status: AgentSessionStatus;
  turns: TrackedAgentTurn[];
  /** Streamed assistant text stays transient until the ACP turn completes. */
  assistantDraft?: string;
  assistantDraftMessageId?: string;
  taskLinks: AgentTaskLink[];
  durableAcceptedRequestIds?: string[];
  recordedEditorResults?: RecordedEditorResult[];
  control?: AcpSessionControl;
};
type AgentSessionOption = Pick<AgentSessionView, 'id' | 'status'>;
type JsonRecord = Record<string, unknown>;

const ACP_REQUEST_TIMEOUT_MS = 5 * 60_000;
const ACP_ACTIVE_POLL_MS = 500;
const ACP_IDLE_POLL_MS = 15_000;
const ACP_TASK_ACTIVE_POLL_MS = 1_000;
function isMissingAcpConnection(error: unknown): boolean {
  return error instanceof BridgeRouteError && error.status === 404 && (
    error.code === 'connection_not_found'
    // Older bridges lose their idle tombstones on restart. Do not treat a
    // missing saved session (also sometimes `not_found`) as a lost transport.
    || (error.code === 'not_found' && error.detail === 'ACP connection is not available; reconnect')
  );
}
function isMissingLocalAgentTranscript(error: unknown, method: 'session/load', sessionId: string): boolean {
  if (!(error instanceof BridgeRouteError) || error.code !== 'acp_transport') return false;
  const prefix = `ACP request "${method}" failed: `;
  if (!error.detail?.startsWith(prefix)) return false;
  const detail = error.detail.slice(prefix.length).trim().toLowerCase();
  return detail === `acp session not found: ${sessionId}`.toLowerCase()
    || /\bresource not found\b/.test(detail)
    || /\bno rollout found\b/.test(detail);
}
const sessionModelListeners = new Map<string, Set<() => void>>();

function notifySessionModelChanged(sessionId: string): void {
  for (const listener of sessionModelListeners.get(sessionId) ?? []) listener();
}

type CapturedAgentRequest = {
  input: SendMessageInput;
  sessionId: string;
  routingProjectId: string | undefined;
  editorContext: Omit<AgentChatEditorContext, 'elementOperationAdapter' | 'liveSceneOperationPort'>;
  hostOperationRefs: Pick<AgentChatEditorContext, 'elementOperationAdapter' | 'liveSceneOperationPort'>;
  projectAuthoring?: ReturnType<typeof projectPackContext>;
};

type AgentSendCommand =
  | { kind: 'send'; input: SendMessageInput; request?: CapturedAgentRequest }
  | { kind: 'retry'; request: CapturedAgentRequest };

function hasNonEmptyId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneAgentRequest(input: SendMessageInput, sessionId: string, context: AgentChatEditorContext, routingProjectId: string | undefined): CapturedAgentRequest {
  const timelineId = hasNonEmptyId(context.timelineId) ? context.timelineId : null;
  const timelineSelected = timelineId !== null;
  const summary = timelineSelected && context.timelineSummary ? { ...context.timelineSummary } : undefined;
  const serializableContext: CapturedAgentRequest['editorContext'] = {
    tool: 'video-editor',
      projectId: context.projectId,
    projectSlug: context.projectSlug,
    timelineId,
    timelineName: timelineSelected ? context.timelineName : null,
    deepLink: context.deepLink !== undefined
      ? context.deepLink
      : typeof globalThis.location?.href === 'string' ? globalThis.location.href : null,
    ...(summary ? { timelineSummary: summary } : {}),
    ...(timelineSelected && context.elementContext ? { elementContext: structuredClone(context.elementContext) } : {}),
  };
  return {
    input: {
      message: input.message,
      requestId: input.requestId ?? globalThis.crypto.randomUUID(),
      ...(input.attachments ? { attachments: structuredClone(input.attachments) } : {}),
    },
    sessionId,
    routingProjectId,
    editorContext: serializableContext,
    hostOperationRefs: {
      ...(timelineSelected && context.elementOperationAdapter ? { elementOperationAdapter: context.elementOperationAdapter.captureForTurn?.() ?? context.elementOperationAdapter } : {}),
      ...(timelineSelected && context.liveSceneOperationPort ? { liveSceneOperationPort: context.liveSceneOperationPort } : {}),
    },
  };
}

function editorContextForRequest(request: CapturedAgentRequest): AgentChatEditorContext {
  return { ...request.editorContext, ...request.hostOperationRefs };
}

function sceneScopeForRequest(
  sessionId: string,
  turnId: string,
  context: AgentChatEditorContext,
): { scope: LiveSceneScope; port: LiveSceneOperationPort } | null {
  const projectId = hasNonEmptyId(context.projectId) ? context.projectId : null;
  const timelineId = hasNonEmptyId(context.timelineId) ? context.timelineId : null;
  const configVersion = context.timelineSummary?.configVersion;
  const port = context.liveSceneOperationPort;
  if (!projectId || !timelineId || !port || typeof configVersion !== 'number' || !Number.isSafeInteger(configVersion) || configVersion < 0) {
    return null;
  }
  return {
    port,
    scope: { sessionId, turnId, projectId, timelineId, capturedTimelineVersion: configVersion },
  };
}

function removeUnscopedLiveSceneMarkers(content: string): string {
  const cleaned = content.replace(/<astrid_live_scene_request>[\s\S]*?(?:<\/astrid_live_scene_request>|$)/g, '')
    .replace(/<astrid_live_scene_(?:context|result)>[\s\S]*?(?:<\/astrid_live_scene_(?:context|result)>|$)/g, '')
    .trim();
  if (cleaned === content.trim()) return cleaned;
  return `${cleaned}${cleaned ? '\n\n' : ''}Live-scene request ignored because this turn has no valid selected-timeline scope.`;
}

function throwIfPromptCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('ACP prompt was cancelled before dispatch.');
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join('');
  const record = asRecord(value);
  if (!record) return '';
  if (record.type === 'text') return typeof record.text === 'string' ? record.text : '';
  if (record.content !== undefined) return textFromContent(record.content);
  if (record.title && typeof record.title === 'string') return record.title;
  return '';
}

function textFromToolOutput(value: unknown): string {
  const content = textFromContent(value);
  if (content) return content;
  const record = asRecord(value);
  if (!record) return '';

  const outputFields = ['formatted_output', 'stdout', 'stderr', 'output', 'result', 'text'];
  return outputFields.flatMap((key) => {
    const field = record[key];
    if (typeof field === 'string' && field) return [field];
    const nested = textFromContent(field);
    return nested ? [nested] : [];
  }).join('\n');
}

/** Keep the transport context model-visible but hide it from the chat UI. */
export function stripAstridEditorContext(content: string): string {
  if (content.startsWith('<astrid_element_result>')) return '';
  if (content.startsWith('<astrid_live_scene_result>') || content.startsWith('<astrid_live_scene_context>')) return '';
  const markers = ['<astrid_editor_context>', '<astrid_agent_context>'].map(marker => content.indexOf(marker)).filter(index => index >= 0);
  const markerIndex = markers.length ? Math.min(...markers) : -1;
  if (markerIndex >= 0) return content.slice(0, markerIndex).trimEnd();

  // Sessions created before the structured contract used this text prefix.
  // Keep old transcripts readable after the bridge migrates to the new block.
  const legacyMarker = content.search(/astrid editor context:\s*timeline id:/i);
  return legacyMarker >= 0 ? content.slice(0, legacyMarker).trimEnd() : content;
}

function timestamp(): string {
  return new Date().toISOString();
}

function newSessionState(id: string): AgentSessionView {
  return { id, status: 'waiting_user', turns: [], taskLinks: [] };
}

function cloneSession(session: AgentSessionView): AgentSessionView {
  return { ...session, turns: session.turns.map((turn) => ({ ...turn, ...(turn.task_refs ? { task_refs: turn.task_refs.map(ref => ({ ...ref })) } : {}) })), taskLinks: session.taskLinks.map(link => ({ ...link })) };
}

function sessionIdFromValue(value: unknown): string | null {
  const record = asRecord(value);
  return stringValue(record?.sessionId)
    ?? stringValue(record?.session_id)
    ?? stringValue(record?.id);
}

function sessionItemsFromValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return Array.isArray(record?.sessions) ? record.sessions : Array.isArray(record?.items) ? record.items : [];
}

function extractNotification(value: unknown): { sessionId: string; update: JsonRecord; messageId?: string } | null {
  const envelope = asRecord(value);
  const params = asRecord(envelope?.params) ?? envelope;
  const sessionId = stringValue(params?.sessionId) ?? stringValue(params?.session_id);
  const update = asRecord(params?.update);
  if (!sessionId || !update) return null;
  const messageId = stringValue(update.messageId) ?? stringValue(update.message_id) ?? undefined;
  return { sessionId, update, messageId };
}

function sessionControl(value: unknown): AcpSessionControl | undefined {
  const record = asRecord(value);
  if (!record || (record.role !== 'writer' && record.role !== 'follower') || typeof record.active !== 'boolean') return undefined;
  return { role: record.role, active: record.active, activeRequestId: stringValue(record.activeRequestId) };
}

function controlFromResult(value: unknown): AcpSessionControl | undefined {
  const result = asRecord(value);
  return sessionControl(result?.[ACP_SESSION_CONTROL_FIELD]) ?? sessionControl(asRecord(result?._meta)?.[ACP_SESSION_CONTROL_FIELD]);
}

export function appendAcpTextTurn(
  turns: TrackedAgentTurn[],
  role: 'user' | 'assistant',
  content: string,
  at: string,
  messageId?: string,
): void {
  const last = turns.at(-1);
  if (
    last?.role === role
    && (!messageId || !last.messageId || last.messageId === messageId)
  ) {
    if (!(role === 'user' && last.content === content)) last.content += content;
    return;
  }
  turns.push({ role, content, timestamp: at, messageId });
}

export type AcpAssistantDraft = {
  content: string;
  messageId?: string;
};

/**
 * Keep streamed assistant narration out of the committed transcript. A new
 * ACP message id starts a fresh candidate response; callers clear the draft
 * when a tool call begins so the next segment is the one that can be committed
 * when the turn stops.
 */
export function appendAcpAssistantDraft(
  draft: AcpAssistantDraft | undefined,
  content: string,
  messageId?: string,
): AcpAssistantDraft {
  const startsNewDraft = !draft
    || (
      Boolean(messageId)
      && Boolean(draft.messageId)
      && messageId !== draft.messageId
    );

  return {
    content: startsNewDraft ? content : `${draft.content}${content}`,
    messageId,
  };
}

/**
 * The ACP connection is intentionally tab-local. OMP remains the authority
 * for session identity and transcript persistence; this store only adapts the
 * streamed ACP notifications to the legacy chat panel's turn model.
 */
type LiveSceneAcpModule = typeof import('../runtime/liveSceneAcpRoundtrip');

export class AstridAgentSessionStore {
  constructor(private readonly client = new AstridLocalClient({
    projectSlug: 'astrid-acp',
    timeoutMs: ACP_REQUEST_TIMEOUT_MS,
  }), private readonly loadLiveSceneAcpRoundtrip: () => Promise<LiveSceneAcpModule> =
    () => import('../runtime/liveSceneAcpRoundtrip')) {}
  private readonly connectionIds = new Map<LocalAgentId, string>();
  private readonly connectionPromises = new Map<LocalAgentId, Promise<string>>();
  private eventsPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, AgentSessionView>();
  private readonly loaded = new Set<string>();
  private readonly loading = new Map<string, { connectionId: string; promise: Promise<void> }>();
  private readonly activePrompts = new Set<string>();
  private readonly dispatchedPrompts = new Set<string>();
  private readonly activePromptTurnStarts = new Map<string, number>();
  /** Start index of a stopped turn, retained to fence late partial tool updates until the next prompt. */
  private readonly cancelledPromptTurnStarts = new Map<string, number>();
  private readonly activePromptTexts = new Map<string, string>();
  private readonly promptControllers = new Map<string, AbortController>();
  private readonly sessionProjects = new Map<string, string>();
  private readonly replayMessages = new Map<string, Map<string, string>>();

  private async connection(agent: LocalAgentId): Promise<string> {
    const current = this.connectionIds.get(agent);
    if (current) return current;
    const pending = this.connectionPromises.get(agent);
    if (pending) return pending;

    // Existing sessions choose their own agent and keep their stored model.
    const connect = this.client.acp.connect(agent);
    const promise = connect
      .then((connection) => {
        this.connectionIds.set(agent, connection.connection_id);
        return connection.connection_id;
      })
      .finally(() => {
        this.connectionPromises.delete(agent);
      });
    this.connectionPromises.set(agent, promise);
    return promise;
  }

  /** Best-effort release of the host process when the tab goes away; the bridge's idle sweep is the backstop. */
  closeConnectionOnPageHide(): void {
    for (const [agent, connectionId] of this.connectionIds) {
      this.retireConnection(connectionId);
      void this.client.acp.disconnect(connectionId, { keepalive: true }).catch(() => undefined);
      this.connectionIds.delete(agent);
    }
  }

  private retireConnection(connectionId: string): void {
    const agent = [...this.connectionIds].find(([, id]) => id === connectionId)?.[0];
    if (!agent) return;
    this.connectionIds.delete(agent);
    for (const [sessionId, entry] of this.loading) if (entry.connectionId === connectionId) this.loading.delete(sessionId);
    for (const sessionId of this.loaded) if (sessionAgentId(sessionId) === agent) this.loaded.delete(sessionId);
  }

  private connected(agent: LocalAgentId, connectionId: string): boolean { return this.connectionIds.get(agent) === connectionId; }

  private state(sessionId: string): AgentSessionView {
    const current = this.sessions.get(sessionId);
    if (current) return current;
    const created = newSessionState(sessionId);
    this.sessions.set(sessionId, created);
    return created;
  }

  async list(projectId?: string | null): Promise<AgentSessionOption[]> {
    if (projectId) {
      const chat = await this.client.acp.projectChat(projectId);
      // Association order keeps Chat N labels stable across selection/Main changes.
      const options = chat.sessions.filter((session) => !session.missing && knownSessionAgentId(session.id) !== null).map(({ id }) => ({ id, status: this.state(id).status }));
      for (const { id } of options) this.sessionProjects.set(id, projectId);
      await this.pullEvents();
      return options;
    }
    const { defaultAgent } = await this.agents();
    const connectionId = await this.connection(defaultAgent);
    const result = await this.client.acp.listSessions(connectionId);
    const options: AgentSessionOption[] = [];
    for (const item of sessionItemsFromValue(result)) {
      const id = sessionIdFromValue(item);
      if (!id || knownSessionAgentId(id) === null) continue;
      const session = this.state(id);
      options.push({ id, status: session.status });
    }
    await this.pullEvents();
    return options;
  }

  private async assertOwned(projectId: string, sessionId: string): Promise<void> {
    const chat = await this.projectChat(projectId);
    if (!chat.sessions.some((session) => session.id === sessionId && !session.missing)) {
      throw new Error('This conversation does not belong to the selected project.');
    }
    this.sessionProjects.set(sessionId, projectId);
  }

  private assertWriter(sessionId: string): void {
    const control = this.state(sessionId).control;
    if (control?.role === 'follower') throw new Error('This chat is being written in another window. Take over the session before sending or changing settings.');
  }

  private isFollower(sessionId: string): boolean {
    return this.state(sessionId).control?.role === 'follower';
  }

  private agentForSession(sessionId: string): LocalAgentId {
    return sessionAgentId(sessionId);
  }

  private assertCanStartTurn(sessionId: string): void {
    this.assertWriter(sessionId);
    const control = this.state(sessionId).control;
    if (control?.active) throw new Error('An agent turn is already active for this chat. Wait for it to finish before sending or changing settings.');
  }

  private applySessionControl(sessionId: string, control: AcpSessionControl): void {
    const session = this.state(sessionId);
    const becameFollower = session.control?.role !== 'follower' && control.role === 'follower';
    session.control = control;
    if (becameFollower && session.assistantDraft?.trim()) {
      appendAcpTextTurn(session.turns, 'assistant', session.assistantDraft.trim(), timestamp(), session.assistantDraftMessageId);
      session.assistantDraft = undefined;
      session.assistantDraftMessageId = undefined;
    }
    session.status = this.activePrompts.has(sessionId) || control.active ? 'processing' : 'waiting_user';
  }

  private async load(connectionId: string, sessionId: string): Promise<void> {
    if (this.loaded.has(sessionId)) return;
    const pending = this.loading.get(sessionId);
    if (pending?.connectionId === connectionId) return pending.promise;
    // Keep a current prompt's state object while replacing the previous
    // connection's transient transcript; replay must not append old text.
    Object.assign(this.state(sessionId), newSessionState(sessionId));
    this.replayMessages.set(sessionId, new Map());
    const entry = { connectionId, promise: Promise.resolve() };
    entry.promise = this.client.acp.loadSession(connectionId, sessionId).then((result) => {
      if (!this.connected(this.agentForSession(sessionId), connectionId)) throw new Error('ACP disconnected during saved chat load.');
      const control = controlFromResult(result);
      if (control) this.applySessionControl(sessionId, control);
      this.loaded.add(sessionId);
    }).finally(() => { if (this.loading.get(sessionId) === entry) this.loading.delete(sessionId); });
    this.loading.set(sessionId, entry);
    return entry.promise;
  }

  async projectChat(projectId: string) { return this.client.acp.projectChat(projectId); }
  async models(sessionId?: string | null, projectId?: string | null): Promise<AgentModelCatalog> {
    if (!sessionId) return { providers: [], currentModel: null, localModels: null };
    if (!projectId) throw new Error(AGENT_CHAT_COPY.selectProjectToReadModel);
    await this.assertOwned(projectId, sessionId);
    const connectionId = await this.connection(this.agentForSession(sessionId));
    await this.load(connectionId, sessionId);
    await this.pullEvents();
    const { models } = await this.client.acp.sessionModels(connectionId, sessionId);
    return { providers: [], currentModel: null, localModels: models };
  }
  async agents() { return this.client.acp.agents(); }

  /** Confirm the created model, then apply only its freshly advertised thinking control. */
  async configureSessionSelection(sessionId: string, projectId: string | null | undefined, model?: string, thoughtLevel?: string) {
    if (this.activePrompts.has(sessionId)) throw new Error('Wait for the active agent turn before changing settings.');
    if (!projectId) throw new Error('Select a project to configure this chat.');
    await this.assertOwned(projectId, sessionId);
    const connectionId = await this.connection(this.agentForSession(sessionId));
    await this.load(connectionId, sessionId);
    await this.pullEvents();
    this.assertCanStartTurn(sessionId);
    const { models } = await this.client.acp.sessionModels(connectionId, sessionId);
    if (model && models?.currentModelId !== model) throw new Error('The agent did not confirm the selected model.');
    const level = models?.thoughtLevel;
    if (thoughtLevel && !level) throw new Error('This model no longer advertises thinking levels.');
    if (level) {
      const value = thoughtLevel ?? defaultThoughtLevel(level);
      if (!level.options.some(option => option.value === value)) throw new Error('The selected thinking level is unavailable for this model.');
      if (level.configId === 'model' || level.configId === models.modelConfigId) throw new Error(AGENT_CHAT_COPY.fixedModel);
      await this.client.acp.setConfigOption(connectionId, sessionId, level.configId, value);
      await this.pullEvents();
      const updated = await this.client.acp.sessionModels(connectionId, sessionId);
      if (updated.models?.thoughtLevel?.currentValue !== value) throw new Error('The agent did not confirm the selected thinking level.');
    }
  }

  async unassignedProjectSessions(projectId: string) {
    const { defaultAgent } = await this.agents();
    return (await this.client.acp.unassignedProjectSessions(projectId, await this.connection(defaultAgent))).filter(session => knownSessionAgentId(session.id) !== null);
  }
  async associateProjectSession(projectId: string, expectedRevision: number, sessionId: string) {
    return this.client.acp.associateProjectSession(projectId, await this.connection(this.agentForSession(sessionId)), expectedRevision, sessionId);
  }
  async takeOver(projectId: string, sessionId: string): Promise<AgentSessionView> {
    await this.assertOwned(projectId, sessionId);
    const connectionId = await this.connection(this.agentForSession(sessionId));
    await this.load(connectionId, sessionId);
    await this.pullEvents();
    const result = await this.client.acp.takeOverSession(connectionId, sessionId);
    const control = controlFromResult(result) ?? sessionControl(asRecord(result)?.control);
    if (control) this.applySessionControl(sessionId, control);
    return cloneSession(this.state(sessionId));
  }
  async selectProjectSession(projectId: string, expectedRevision: number, sessionId: string | null) {
    return this.client.acp.selectProjectSession(projectId, expectedRevision, sessionId);
  }
  async setMainProjectSession(projectId: string, expectedRevision: number, sessionId: string) {
    return this.client.acp.setMainProjectSession(projectId, expectedRevision, sessionId);
  }
  async renameProjectSession(projectId: string, expectedRevision: number, sessionId: string, title: string) {
    return this.client.acp.renameProjectSession(projectId, expectedRevision, sessionId, title);
  }
  async saveProjectDraft(projectId: string, expectedRevision: number, text: string, queuedMessages: import('@/integrations/astrid/acpRoutes.ts').ProjectChatState['draft']['queued_messages']) {
    return this.client.acp.saveProjectDraft(projectId, expectedRevision, text, queuedMessages);
  }

  async create(projectId: string, mode: 'ensure' | 'ensure_main' | 'new', operationId: string, choice: NewAgentSessionChoice = {}): Promise<{ id: string; projectChat: ProjectChatState }> {
    const chatBeforeCreate = mode === 'new' ? null : await this.client.acp.projectChat(projectId);
    const existingId = mode === 'ensure_main'
      ? chatBeforeCreate?.main_session_id
      : chatBeforeCreate?.selected_session_id ?? chatBeforeCreate?.main_session_id;
    const connectionAgent = existingId ? this.agentForSession(existingId) : choice.agent;
    // New sessions always connect with the requested choices. Omitting both lets the service repeat
    // its last successful choices, even when another tab has changed them.
    const connectionId = existingId
      ? await this.connection(this.agentForSession(existingId))
      : (await this.client.acp.connect(choice.agent, choice.defaultModelId)).connection_id;
    let keepConnection = Boolean(existingId);
    try {
      const chat = await this.client.acp.createProjectSession(projectId, connectionId, mode, operationId);
      const id = (mode === 'ensure_main' ? chat.main_session_id : null) ?? chat.operation_session_id ?? chat.selected_session_id;
      if (!id) throw new Error('Astrid ACP did not return a session ID.');
      const agent = this.agentForSession(id);
      if (this.connectionIds.get(agent) === connectionId) keepConnection = true;
      // Ensure and operation replay can return another agent's existing session. An omitted-agent
      // connect does not report its agent, so only a known matching connection can be adopted.
      if (connectionAgent === agent && !this.connectionIds.has(agent)) {
        this.connectionIds.set(agent, connectionId);
        keepConnection = true;
      }
      this.state(id);
      this.sessionProjects.set(id, projectId);
      // Empty external sessions may not exist on disk yet. Attach the regular connection while
      // the creator still owns its live host, preserving its model, thinking controls and context.
      if (!keepConnection) await this.load(await this.connection(agent), id);
      await this.pullEvents();
      return { id, projectChat: chat };
    } finally {
      // Detaching the creator promotes its remaining subscriber without replacing another host.
      if (!keepConnection) {
        await this.client.acp.disconnect(connectionId).catch(() => undefined);
        await this.pullEvents();
      }
    }
  }

  async recoverEmptyProjectSession(projectId: string, sessionId: string): Promise<{ id: string; projectChat: ProjectChatState; session: AgentSessionView } | null> {
    if (sessionAgentId(sessionId) === 'astrid') return null;
    const current = await this.client.acp.projectChat(projectId);
    if (!current.sessions.some(session => session.id === sessionId && session.pending_first_message !== false)) return null;
    const connectionId = await this.connection(this.agentForSession(sessionId));
    const projectChat = await this.client.acp.recoverProjectSession(
      projectId, connectionId, `empty-chat:${globalThis.crypto.randomUUID()}`, sessionId,
    );
    const id = projectChat.operation_session_id ?? projectChat.selected_session_id;
    if (!id) throw new Error('Astrid ACP did not return a recovered session ID.');
    this.state(id);
    this.sessionProjects.set(id, projectId);
    await this.pullEvents();
    return { id, projectChat, session: cloneSession(this.state(id)) };
  }

  async get(projectId: string, sessionId: string, replay = false): Promise<AgentSessionView> {
    await this.assertOwned(projectId, sessionId);
    const agent = this.agentForSession(sessionId);
    if (replay) {
      if (this.activePrompts.has(sessionId)) throw new Error('Wait for the active request before checking saved delivery.');
      this.loaded.delete(sessionId);
    }
    // Reconnect only a read-only transcript load, once. Never replay a prompt
    // when its delivery may already have been accepted by the previous host.
    for (let attempt = 0; attempt < 2; attempt++) {
      const connectionId = await this.connection(agent);
      try {
        await this.load(connectionId, sessionId);
        await this.pullEvents();
      } catch (error) {
        if (!isMissingAcpConnection(error)) throw error;
        this.retireConnection(connectionId);
        if (attempt === 1) throw error;
        continue;
      }
      if (this.connected(agent, connectionId)) break;
      if (attempt === 1) throw new Error('Saved delivery could not be verified because ACP disconnected.');
    }
    const session = cloneSession(this.state(sessionId));
    for (const turn of session.turns) {
      if (turn.role !== 'user' || !turn.messageId) continue;
      const raw = this.replayMessages.get(sessionId)?.get(turn.messageId);
      if (raw) turn.request_id = acceptedReplayRequestIds([raw], projectId)[0];
    }
    session.durableAcceptedRequestIds = acceptedReplayRequestIds(this.replayMessages.get(sessionId)?.values() ?? [], projectId);
    session.recordedEditorResults = recordedEditorResults(this.replayMessages.get(sessionId)?.values() ?? [], projectId, sessionId);
    return session;
  }

  async prompt(
    sessionId: string,
    input: SendMessageInput,
    editorContext: AgentChatEditorContext,
    projectId: string | undefined = editorContext.projectId ?? undefined,
    isCurrent: () => boolean = () => true,
    scopeSignal?: AbortSignal,
    captured?: { projectAuthoring?: ReturnType<typeof projectPackContext> },
  ): Promise<void> {
    this.assertCanStartTurn(sessionId);
    if (this.activePrompts.has(sessionId)) throw new Error('An ACP prompt is already active for this session');
    if (!projectId || editorContext.projectId !== projectId) throw new Error('Matching projectId is required');
    if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('message is required');
    const checkCurrent = () => {
      if (!isCurrent()) throw new Error('Conversation changed before the request completed.');
    };
    const controller = new AbortController();
    const signal = scopeSignal ? AbortSignal.any([controller.signal, scopeSignal]) : controller.signal;
    const session = this.state(sessionId);
    session.status = 'processing';
    session.assistantDraft = undefined;
    session.assistantDraftMessageId = undefined;
    this.cancelledPromptTurnStarts.delete(sessionId);
    this.activePrompts.add(sessionId);
    this.promptControllers.set(sessionId, controller);
    this.activePromptTexts.set(sessionId, input.message);
    let sceneScope: LiveSceneScope | undefined;
    let scenePort: LiveSceneOperationPort | undefined;
    let dispatchStarted = false;
    let promptConnectionId: string | null = null;
    try {
      if (signal.aborted) return;
      checkCurrent();
      await this.assertOwned(projectId, sessionId);
      if (signal.aborted) return;
      checkCurrent();
      const agent = this.agentForSession(sessionId);
      const connectionId = await this.connection(agent);
      promptConnectionId = connectionId;
      if (signal.aborted) return;
      await this.load(connectionId, sessionId);
      await this.pullEvents();
      this.assertCanStartTurn(sessionId);
      if (signal.aborted) return;
      checkCurrent();

      const isSessionConfigCommand = /^\/model(?:\s|$)/.test(input.message.trim())
        || (!input.attachments?.length && /^\/thinking(?:\s|$)/.test(input.message.trim()));
      if (isSessionConfigCommand) {
        this.assertCanStartTurn(sessionId);
        const { setSessionConfigOption } = await import('../runtime/agentSessionSettings');
        if (signal.aborted) return;
        checkCurrent();
        await this.pullEvents();
        this.assertCanStartTurn(sessionId);
        const acknowledgement = await setSessionConfigOption(this.client.acp, connectionId, sessionId, input.message);
        if (signal.aborted) return;
        checkCurrent();
        session.turns.push({
          role: 'user', content: input.message, attachments: input.attachments, timestamp: timestamp(),
          messageId: `astrid-setting-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        });
        this.commitAssistantDraft(session, acknowledgement);
        await this.pullEvents();
        return;
      }

      await refreshProjectElementContext(projectId);
      checkCurrent();
      const astridAgentContext = await import('@/tools/video-editor/runtime/astridAgentContext.ts');
      if (signal.aborted) return;
      // The first attempt records project authoring after its refresh; retries resend that same record.
      if (captured && editorContext.projectId && !captured.projectAuthoring) captured.projectAuthoring = structuredClone(projectPackContext(editorContext.projectId));
      const contextSnapshot = astridAgentContext.buildAstridAgentContextSnapshot(editorContext, input.attachments ?? [], input.requestId, captured?.projectAuthoring);
      const context = astridAgentContext.serializeAstridAgentContext(contextSnapshot);
      const sceneBinding = sceneScopeForRequest(sessionId, contextSnapshot.request_id, editorContext);
      if (sceneBinding) {
        sceneScope = sceneBinding.scope;
        scenePort = sceneBinding.port;
      }

      let liveSceneAcp: LiveSceneAcpModule | null = null;
      if (sceneScope && scenePort) {
        try {
          liveSceneAcp = await this.loadLiveSceneAcpRoundtrip();
        } catch (error) {
          throw new Error(
            `Live-scene ACP implementation failed to load: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (signal.aborted) return;
      this.assertCanStartTurn(sessionId);

      const promptBlocks = [
        { type: 'text', text: input.message },
        { type: 'text', text: context },
        ...(liveSceneAcp && sceneScope ? [{ type: 'text' as const, text: liveSceneAcp.liveScenePromptContract(sceneScope) }] : []),
      ];
      this.activePromptTurnStarts.set(sessionId, session.turns.length);
      session.turns.push({
        role: 'user',
        content: input.message,
        attachments: input.attachments,
        timestamp: timestamp(),
        messageId: `astrid-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        request_id: contextSnapshot.request_id,
      });
      checkCurrent();
      if (!projectId) throw new Error('Select a project to chat.');
      await this.pullEvents();
      this.assertCanStartTurn(sessionId);
      dispatchStarted = true;
      this.dispatchedPrompts.add(sessionId);
      await this.client.acp.promptProjectSession(projectId, connectionId, sessionId, promptBlocks, contextSnapshot.request_id);
      if (!this.connected(agent, connectionId)) throw new Error('ACP disconnected. Retry the saved message.');
      await this.pullEvents();
      if (!this.connected(agent, connectionId)) throw new Error('ACP disconnected. Retry the saved message.');
      if (this.isFollower(sessionId)) return;
      this.assertWriter(sessionId);
      const draft = trimString(session.assistantDraft);
      const hasElementOperations = /<astrid_element_operation>/.test(draft);
      let finalContent = draft;
      if (hasElementOperations) {
        try { finalContent = await runElementAcpRoundtrip({
          content: draft,
          scope: { sessionId, turnId: contextSnapshot.request_id, projectId: projectId!, timelineId: editorContext.timelineId! },
          adapter: editorContext.elementOperationAdapter,
          signal, checkCurrent,
          followup: async (feedback) => {
            checkCurrent(); throwIfPromptCancelled(signal);
            session.assistantDraft = undefined; session.assistantDraftMessageId = undefined;
            this.assertWriter(sessionId);
            await this.client.acp.promptProjectSession(projectId!, connectionId, sessionId, [{type:'text',text:feedback}]);
            if (!this.connected(agent, connectionId)) throw new Error('ACP disconnected while returning element results.');
            await this.pullEvents(); checkCurrent();
            this.assertWriter(sessionId);
            return trimString(session.assistantDraft);
          },
        }); } catch (error) { if (this.isFollower(sessionId)) return; throw error; }
      } else if (!liveSceneAcp) {
        finalContent = removeUnscopedLiveSceneMarkers(finalContent);
      }
      if (!hasElementOperations && liveSceneAcp && sceneScope && scenePort) {
        this.assertWriter(sessionId);
        try { finalContent = await liveSceneAcp.runLiveSceneAcpRoundtrip({
          content: finalContent, scope: sceneScope, port: scenePort,
          signal,
          followup: async (feedback) => {
            checkCurrent();
            throwIfPromptCancelled(signal);
            session.assistantDraft = undefined;
            session.assistantDraftMessageId = undefined;
            this.assertWriter(sessionId);
            await this.client.acp.promptProjectSession(projectId!, connectionId, sessionId, [{ type: 'text', text: feedback }]);
            if (!this.connected(agent, connectionId)) throw new Error('ACP disconnected. Retry the saved message.');
            await this.pullEvents();
            checkCurrent();
            this.assertWriter(sessionId);
            return trimString(session.assistantDraft);
          },
        }); } catch (error) { if (this.isFollower(sessionId)) return; throw error; }
      }
      checkCurrent();
      if (this.isFollower(sessionId)) return;
      this.assertWriter(sessionId);
      this.commitAssistantDraft(session, finalContent);
    } catch (error) {
      if (error instanceof BridgeTransportFailure || isMissingAcpConnection(error)) {
        if (promptConnectionId && this.connected(sessionAgentId(sessionId), promptConnectionId)) this.retireConnection(promptConnectionId);
      }
      throw error;
    } finally {
      try {
        if (sceneScope && scenePort) scenePort.endTurn(sceneScope);
      } finally {
        this.promptControllers.delete(sessionId);
        this.activePrompts.delete(sessionId);
        this.dispatchedPrompts.delete(sessionId);
        this.activePromptTurnStarts.delete(sessionId);
        this.activePromptTexts.delete(sessionId);
        session.assistantDraft = undefined;
        session.assistantDraftMessageId = undefined;
        // `session/prompt` resolves only after OMP has finished the turn. A
        // concurrent polling request may have drained the final assistant chunk
        // after the response arrived, so do not let that replay mark a completed
        // turn as "thinking" again.
        // ACP session/cancel stops the current prompt. The ACP session itself remains
        // usable, so an aborted turn returns to the same idle state as a completed one.
        session.status = session.control?.active ? 'processing' : 'waiting_user';
      }
    }
  }

  private commitAssistantDraft(session: AgentSessionView, contentOverride?: string): void {
    const content = (contentOverride ?? session.assistantDraft)?.trim();
    if (!content) return;

    session.turns.push({
      role: 'assistant',
      content,
      timestamp: timestamp(),
      messageId: session.assistantDraftMessageId,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.assertWriter(sessionId);
    const cancelledBeforeDispatch = this.activePrompts.has(sessionId) && !this.dispatchedPrompts.has(sessionId);
    const turnStart = this.activePromptTurnStarts.get(sessionId);
    if (!cancelledBeforeDispatch && this.dispatchedPrompts.has(sessionId) && turnStart !== undefined) {
      this.cancelledPromptTurnStarts.set(sessionId, turnStart);
    }
    this.promptControllers.get(sessionId)?.abort();
    const connectionId = await this.connection(this.agentForSession(sessionId));
    await this.client.acp.cancelSession(connectionId, sessionId);
    await this.pullEvents();
    const session = this.state(sessionId);
    if (turnStart !== undefined && !cancelledBeforeDispatch) this.markUnfinishedToolCallsStopped(session, turnStart);
    session.status = session.control?.active ? 'processing' : 'waiting_user';
  }

  private markUnfinishedToolCallsStopped(session: AgentSessionView, turnStart: number): void {
    const calls = session.turns.slice(turnStart).filter((turn): turn is AgentTurn & { role: 'tool_call' } => turn.role === 'tool_call');
    for (const call of calls) {
      const callIndex = session.turns.indexOf(call);
      const result = call.tool_call_id
        ? session.turns.find(turn => turn.role === 'tool_result' && turn.tool_call_id === call.tool_call_id)
        : session.turns[callIndex + 1]?.role === 'tool_result' && !session.turns[callIndex + 1].tool_call_id
          ? session.turns[callIndex + 1]
          : null;
      const status = result?.tool_status ?? call.tool_status ?? (result ? 'completed' : 'in_progress');
      if (status !== 'in_progress' && !(status === 'cancelled' && !result)) continue;

      call.tool_status = 'cancelled';
      if (result) {
        result.tool_status = 'cancelled';
        result.content = result.content || 'Stopped.';
      } else {
        const stoppedResult: AgentTurn = {
          role: 'tool_result',
          content: 'Stopped.',
          timestamp: timestamp(),
          tool_status: 'cancelled',
          ...(call.tool_call_id ? { tool_call_id: call.tool_call_id } : {}),
        };
        if (call.tool_call_id) session.turns.push(stoppedResult);
        else session.turns.splice(callIndex + 1, 0, stoppedResult);
      }
    }
  }

  /** Renew the browser lease even when a transcript load needs explicit retry. */
  async heartbeat(projectId: string, sessionId: string): Promise<void> {
    if (this.sessionProjects.get(sessionId) === projectId) await this.pullEvents();
  }

  private async pullEvents(): Promise<void> {
    if (this.eventsPromise) return this.eventsPromise;
    this.eventsPromise = (async () => {
      const connections = [...this.connectionIds.entries()];
      await Promise.all(connections.map(async ([agent, connectionId]) => {
        const response = await this.client.acp.events(connectionId).catch((error: unknown) => {
          if (isMissingAcpConnection(error)) {
            this.retireConnection(connectionId);
            return null;
          }
          throw error;
        });
        if (!response || !this.connected(agent, connectionId)) return;
        for (const notification of response.notifications) this.applyNotification(notification);
        if (response.disconnected) this.retireConnection(connectionId);
      }));
    })().finally(() => {
      this.eventsPromise = null;
    });
    return this.eventsPromise;
  }

  private applyNotification(value: unknown): void {
    const notification = extractNotification(value);
    if (!notification) return;

    const session = this.state(notification.sessionId);
    const updateType = notification.update.sessionUpdate;
    const content = textFromContent(notification.update.content);
    const at = timestamp();

    if (updateType === 'config_option_update' || updateType === 'current_model_update') {
      notifySessionModelChanged(notification.sessionId);
    }

    if (updateType === ACP_SESSION_CONTROL_UPDATE) {
      const control = sessionControl(notification.update);
      if (control) this.applySessionControl(notification.sessionId, control);
      return;
    }

    if (updateType === 'user_message_chunk' || updateType === 'agent_message_chunk') {
      if (!content) return;
      const role = updateType === 'user_message_chunk' ? 'user' : 'assistant';
      const liveUpdate = notification.update.live === true;
      const liveRequestId = liveUpdate ? stringValue(notification.update.requestId) : null;
      if (role === 'user' && liveRequestId && session.turns.some(turn => turn.role === 'user' && turn.request_id === liveRequestId)) return;
      if (role === 'user' && notification.messageId && !liveUpdate && !this.activePrompts.has(notification.sessionId)) {
        const replay = this.replayMessages.get(notification.sessionId);
        if (replay) {
          const assembled = (replay.get(notification.messageId) ?? '') + content;
          replay.set(notification.messageId, assembled);
          const visible = stripAstridEditorContext(assembled);
          const turn = session.turns.find(candidate => candidate.role === 'user' && candidate.messageId === notification.messageId);
          if (turn) turn.content = visible;
          else if (visible) session.turns.push({ role: 'user', content: visible, timestamp: at, messageId: notification.messageId });
          return;
        }
      }
      const visibleContent = role === 'user' ? stripAstridEditorContext(content) : content;
      if (!visibleContent) return;
      // ACP replays persisted user messages, but the live prompt request does
      // not consistently echo the just-sent user message. The local prompt
      // turn above is authoritative for that live request; do not duplicate it
      // if a runtime build happens to echo the same prompt back.
      if (role === 'user' && this.activePrompts.has(notification.sessionId)) {
        const promptText = this.activePromptTexts.get(notification.sessionId);
        if (liveUpdate && stringValue(notification.update.requestId) === session.control?.activeRequestId) return;
        // The local optimistic turn is authoritative for the live request.
        // ACP implementations may echo either of the two prompt content
        // blocks, so ignore all user chunks while that request is in flight.
        if (promptText && visibleContent === promptText) {
          return;
        }
      }
      if (role === 'assistant' && this.activePrompts.has(notification.sessionId) && session.control?.role !== 'follower') {
        const draft = appendAcpAssistantDraft(
          session.assistantDraft
            ? { content: session.assistantDraft, messageId: session.assistantDraftMessageId }
            : undefined,
          visibleContent,
          notification.messageId,
        );
        session.assistantDraft = draft.content;
        session.assistantDraftMessageId = draft.messageId;
        session.status = 'processing';
        return;
      }

      appendAcpTextTurn(session.turns, role, visibleContent, at, notification.messageId);
      if (role === 'user' && liveUpdate) {
        const turn = session.turns.find(candidate => candidate.role === 'user' && candidate.messageId === notification.messageId);
        if (turn) turn.request_id = stringValue(notification.update.requestId) ?? undefined;
      }
      if (role === 'assistant' && this.activePrompts.has(notification.sessionId)) {
        session.status = 'processing';
      }
      return;
    }

    if (updateType === 'tool_call') {
      // Preserve assistant narration that preceded this action in the visible
      // transcript. A later assistant chunk starts a separate response.
      if (this.activePrompts.has(notification.sessionId)) {
        this.commitAssistantDraft(session);
        session.assistantDraft = undefined;
        session.assistantDraftMessageId = undefined;
      }
      const title = stringValue(notification.update.title) ?? 'Astrid tool';
      const toolCallId = stringValue(notification.update.toolCallId) ?? undefined;
      const existing = toolCallId ? session.turns.find(turn => turn.role === 'tool_call' && turn.tool_call_id === toolCallId) : undefined;
      if (existing) {
        existing.content = content || title;
        existing.tool_args = asRecord(notification.update.rawInput) ?? existing.tool_args;
        return;
      }
      session.turns.push({
        role: 'tool_call',
        content: content || title,
        tool_name: title,
        tool_args: asRecord(notification.update.rawInput) ?? undefined,
        timestamp: at,
        ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      });
      const cancelledTurnStart = this.cancelledPromptTurnStarts.get(notification.sessionId);
      if (cancelledTurnStart !== undefined) this.markUnfinishedToolCallsStopped(session, cancelledTurnStart);
      if (this.activePrompts.has(notification.sessionId)) session.status = 'processing';
      return;
    }

    if (updateType === 'tool_call_update') {
      const toolCallId = stringValue(notification.update.toolCallId);
      if (toolCallId) {
        const rawOutput = notification.update.rawOutput;
        const outputContent = textFromToolOutput(rawOutput);
        const resultContent = content || outputContent;
        const projectId = this.sessionProjects.get(notification.sessionId);
        const refs = projectId ? readAstridTaskRefs(notification.update.rawOutput, projectId) : [];
        const existing = session.turns.find(turn => turn.role === 'tool_result' && turn.tool_call_id === toolCallId);
        const merged = mergeAstridTaskRefs(existing?.task_refs, refs);
        const call = session.turns.find(turn => turn.role === 'tool_call' && turn.tool_call_id === toolCallId);
        const callIndex = call ? session.turns.indexOf(call) : -1;
        const cancelledTurnStart = this.cancelledPromptTurnStarts.get(notification.sessionId);
        const incomingStatus = stringValue(notification.update.status) ?? undefined;
        const status = cancelledTurnStart !== undefined && callIndex >= cancelledTurnStart && incomingStatus === 'in_progress'
          ? 'cancelled'
          : incomingStatus;
        if (existing) {
          const stalePartial = ['completed', 'failed', 'cancelled'].includes(existing.tool_status ?? '') && incomingStatus === 'in_progress';
          if (resultContent && !stalePartial) existing.content = resultContent;
          existing.task_refs = merged;
          if (status && !stalePartial) existing.tool_status = status;
          if (!stalePartial) {
            existing.tool_output_details = asRecord(asRecord(rawOutput)?.details) ?? existing.tool_output_details;
            if (rawOutput !== undefined) existing.tool_output = rawOutput === null ? undefined : rawOutput;
          }
        } else {
          session.turns.push({ role: 'tool_result', content: resultContent, timestamp: at, tool_call_id: toolCallId,
            tool_status: status, task_refs: merged,
            tool_output_details: asRecord(asRecord(rawOutput)?.details) ?? undefined,
            tool_output: rawOutput === null ? undefined : rawOutput });
        }
        if (call) { call.task_refs = mergeAstridTaskRefs(call.task_refs, refs); call.tool_status = existing?.tool_status ?? status; }
        for (const ref of refs) {
          if (!session.taskLinks.some(link => link.toolCallId === toolCallId && link.task_id === ref.task_id && link.project_id === ref.project_id)) {
            session.taskLinks.push({ ...ref, sessionId: notification.sessionId, toolCallId,
              liveObserved: this.activePrompts.has(notification.sessionId) && !this.loading.has(notification.sessionId) });
          }
        }
        if (cancelledTurnStart !== undefined) this.markUnfinishedToolCallsStopped(session, cancelledTurnStart);
      } else if (content) session.turns.push({ role: 'tool_result', content, timestamp: at });
      if (this.activePrompts.has(notification.sessionId)) session.status = 'processing';
    }
  }
}

const agentStore = new AstridAgentSessionStore();
if (typeof window !== 'undefined') {
  const release = () => agentStore.closeConnectionOnPageHide();
  window.addEventListener('pagehide', release);
  window.addEventListener('beforeunload', release);
}

const agentModelsQueryKey = ['agent-models'] as const;
export const localAgentsQueryKey = ['local-agents'] as const;
export function useLocalAgents() {
  return useQuery({ queryKey: localAgentsQueryKey, queryFn: () => agentStore.agents(), retry: false, refetchOnWindowFocus: true });
}

export function useAgentModels(enabled = true, sessionId?: string | null, projectId?: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!sessionId) return;
    const listeners = sessionModelListeners.get(sessionId) ?? new Set<() => void>();
    const invalidate = () => { void queryClient.invalidateQueries({ queryKey: [...agentModelsQueryKey, sessionId, projectId ?? null] }); };
    listeners.add(invalidate);
    sessionModelListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(invalidate);
      if (listeners.size === 0) sessionModelListeners.delete(sessionId);
    };
  }, [projectId, queryClient, sessionId]);
  return useQuery({
    queryKey: [...agentModelsQueryKey, sessionId ?? null, projectId ?? null],
    enabled,
    queryFn: () => sessionId ? agentStore.models(sessionId, projectId) : agentStore.models(),
    refetchInterval: false,
    retry: false,
  });
}

export function useConfigureAgentSession(projectId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (selection: { sessionId: string; model?: string; thoughtLevel?: string }) => {
      // Join the new session's initial options read if the panel already started
      // it. Use its explicit ID rather than the previous render's active chat.
      await queryClient.fetchQuery({
        queryKey: [...agentModelsQueryKey, selection.sessionId, projectId ?? null],
        queryFn: () => agentStore.models(selection.sessionId, projectId),
        retry: false,
      });
      return agentStore.configureSessionSelection(selection.sessionId, projectId, selection.model, selection.thoughtLevel);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: agentModelsQueryKey }); },
  });
}

export const agentSessionsQueryKey = (timelineId: string | null | undefined, projectId?: string | null) =>
  ['timeline-agent-sessions', timelineId, projectId ?? null] as const;
export const agentSessionQueryKey = (sessionId: string | null | undefined, projectId?: string | null) =>
  ['timeline-agent-session', sessionId, projectId ?? null] as const;

function isActiveAgentTurn(status: AgentSessionStatus | undefined): boolean {
  return status === 'processing' || status === 'continue';
}

function isSessionActivelyControlled(session: AgentSessionView | undefined): boolean {
  return Boolean(session?.control?.active) || isActiveAgentTurn(session?.status);
}

function hasActiveProjectAgentTurn(queryClient: QueryClient, projectId: string): boolean {
  return queryClient.getQueryCache().findAll({ queryKey: ['timeline-agent-session'] }).some((query) => {
    if (query.queryKey[2] !== projectId) return false;
    return isActiveAgentTurn((query.state.data as AgentSessionView | undefined)?.status);
  });
}

/** True when any agent session this App has loaded is mid-turn. Read on demand (no subscription), e.g. on an Update click. */
export function hasAnyActiveAgentTurn(queryClient: QueryClient): boolean {
  return queryClient.getQueryCache().findAll({ queryKey: ['timeline-agent-session'] })
    .some((query) => isSessionActivelyControlled(query.state.data as AgentSessionView | undefined));
}

export function useAgentSessions(timelineId: string | null | undefined, projectId?: string | null) {
  return useQuery({
    queryKey: agentSessionsQueryKey(timelineId, projectId),
    enabled: Boolean(projectId),
    queryFn: () => agentStore.list(projectId),
    refetchInterval: 5_000,
    retry: false,
  });
}

export const projectChatQueryKey = (projectId: string | null | undefined) => ['project-agent-chat', projectId ?? null] as const;
const unassignedProjectSessionsQueryKey = (projectId: string | null | undefined) => ['project-agent-chat-unassigned', projectId ?? null] as const;

// Association/selection and draft revisions advance independently. A delayed
// draft reply must not undo a newer selected session, or vice versa.
function mergeProjectChat(current: ProjectChatState | undefined, incoming: ProjectChatState): ProjectChatState {
  if (!current) return incoming;
  const chat = current.revision > incoming.revision ? current : incoming;
  const draft = current.draft.revision > incoming.draft.revision ? current.draft : incoming.draft;
  return chat.draft === draft ? chat : { ...chat, draft };
}

function cacheProjectChat(queryClient: QueryClient, chat: ProjectChatState): void {
  queryClient.setQueryData<ProjectChatState>(projectChatQueryKey(chat.project_id), current => mergeProjectChat(current, chat));
}

export function useProjectChat(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: projectChatQueryKey(projectId),
    enabled: Boolean(projectId),
    queryFn: async () => {
      const chat = await agentStore.projectChat(projectId!);
      return mergeProjectChat(queryClient.getQueryData<ProjectChatState>(projectChatQueryKey(projectId)), chat);
    },
    refetchInterval: () => projectId && hasActiveProjectAgentTurn(queryClient, projectId)
      ? ACP_ACTIVE_POLL_MS
      : ACP_IDLE_POLL_MS,
    retry: false,
  });
}

export function useUnassignedProjectSessions(projectId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: unassignedProjectSessionsQueryKey(projectId),
    enabled: Boolean(projectId) && enabled,
    queryFn: () => agentStore.unassignedProjectSessions(projectId!),
    retry: false,
  });
}

export function useSaveProjectDraft(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { expectedRevision: number; text: string; queuedMessages: import('@/integrations/astrid/acpRoutes.ts').ProjectChatState['draft']['queued_messages'] }) => {
      if (!projectId) throw new Error('projectId is required');
      return agentStore.saveProjectDraft(projectId, input.expectedRevision, input.text, input.queuedMessages);
    },
    onSuccess: (chat) => cacheProjectChat(queryClient, chat),
  });
}

export function useSelectProjectSession(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { expectedRevision: number; sessionId: string | null }) => {
      if (!projectId) throw new Error('projectId is required');
      return agentStore.selectProjectSession(projectId, input.expectedRevision, input.sessionId);
    },
    onSuccess: (chat) => cacheProjectChat(queryClient, chat),
  });
}

export function useSetMainProjectSession(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { expectedRevision: number; sessionId: string }) => {
      if (!projectId) throw new Error('projectId is required');
      return agentStore.setMainProjectSession(projectId, input.expectedRevision, input.sessionId);
    },
    onSuccess: (chat) => cacheProjectChat(queryClient, chat),
  });
}

export function useRenameProjectSession(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { expectedRevision: number; sessionId: string; title: string }) => {
      if (!projectId) throw new Error('projectId is required');
      return agentStore.renameProjectSession(projectId, input.expectedRevision, input.sessionId, input.title);
    },
    onSuccess: (chat) => cacheProjectChat(queryClient, chat),
  });
}

export function useAssociateProjectSession(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { expectedRevision: number; sessionId: string }) => {
      if (!projectId) throw new Error('projectId is required');
      return agentStore.associateProjectSession(projectId, input.expectedRevision, input.sessionId);
    },
    onSuccess: (chat) => {
      cacheProjectChat(queryClient, chat);
      void queryClient.invalidateQueries({ queryKey: unassignedProjectSessionsQueryKey(chat.project_id) });
    },
  });
}

export function useAgentSession(sessionId: string | null | undefined, projectId?: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!sessionId || !projectId) return;
    // A failed transcript query pauses RPC retries, not the live tab's lease.
    const heartbeat = window.setInterval(() => {
      void agentStore.heartbeat(projectId, sessionId).catch(() => undefined);
    }, ACP_IDLE_POLL_MS);
    return () => window.clearInterval(heartbeat);
  }, [projectId, sessionId]);
  return useQuery({
    queryKey: agentSessionQueryKey(sessionId, projectId),
    enabled: Boolean(sessionId && projectId),
    queryFn: async () => {
      try {
        return await agentStore.get(projectId!, sessionId!);
      } catch (error) {
        if (sessionAgentId(sessionId!) !== 'astrid'
            && isMissingLocalAgentTranscript(error, 'session/load', sessionId!)) {
          const recovered = await agentStore.recoverEmptyProjectSession(projectId!, sessionId!);
          if (recovered) {
            cacheProjectChat(queryClient, recovered.projectChat);
            void queryClient.invalidateQueries({ queryKey: ['timeline-agent-sessions'] });
            return recovered.session;
          }
        }
        throw error;
      }
    },
    // Event polls are also the browser heartbeat. Keep renewing the bridge lease
    // in background tabs, so only a closed or unresponsive owner expires.
    refetchIntervalInBackground: true,
    // ACP events are drained independently of the prompt response so streamed
    // assistant text and tool activity paint while a long turn is running.
    // A failed persisted-session load needs an explicit retry/reconnect, not
    // an unbounded RPC loop. Healthy sessions still drain streamed events.
    refetchInterval: (query) => query.state.error ? false
      : isSessionActivelyControlled(query.state.data as AgentSessionView | undefined) ? ACP_ACTIVE_POLL_MS : ACP_IDLE_POLL_MS,
    retry: false,
  });
}

export function useTakeOverSession(sessionId: string | null | undefined, projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('sessionId is required');
      if (!projectId) throw new Error('projectId is required');
      return agentStore.takeOver(projectId, sessionId);
    },
    onSuccess: (session) => {
      if (!projectId) return;
      queryClient.setQueryData(agentSessionQueryKey(session.id, projectId), session);
      void queryClient.invalidateQueries({ queryKey: agentSessionQueryKey(session.id, projectId) });
    },
  });
}

/** Rehydrate project history using OMP session/load, including attached sessions. */
export function useProjectAgentTaskLinks(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useQuery<AgentTaskLink[]>({
    queryKey: ['project-agent-task-links', projectId ?? null],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const sessions = await agentStore.list(projectId);
      const links: AgentTaskLink[] = [];
      for (const session of sessions) {
        const history = await agentStore.get(projectId!, session.id);
        links.push(...history.taskLinks.filter(link => link.project_id === projectId));
      }
      return links;
    },
    // Keep background tool activity visible with the chat pane closed, while
    // avoiding a one-second project history scan when every turn is idle.
    refetchInterval: () => projectId && hasActiveProjectAgentTurn(queryClient, projectId)
      ? ACP_TASK_ACTIVE_POLL_MS
      : ACP_IDLE_POLL_MS,
    retry: false,
  });
}

export function useCreateSession(timelineId: string | null | undefined, projectId?: string | null, mode: 'ensure' | 'ensure_main' | 'new' = 'ensure') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input?: string | (NewAgentSessionChoice & { operationId: string })) => {
      if (!projectId) throw new Error('Select a project or timeline to start chatting.');
      const capturedProjectId = projectId;
      const capturedTimelineId = timelineId;
      const operationId = typeof input === 'string' ? input : input?.operationId ?? globalThis.crypto.randomUUID();
      const choice = typeof input === 'object' ? { agent: input.agent, defaultModelId: input.defaultModelId } : undefined;
      const session = await agentStore.create(capturedProjectId, mode, operationId, choice);
      return { ...session, projectId: capturedProjectId, timelineId: capturedTimelineId };
    },
    onSuccess: (session) => {
      cacheProjectChat(queryClient, session.projectChat);
      void queryClient.invalidateQueries({ queryKey: localAgentsQueryKey });
      void queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(session.timelineId, session.projectId) });
      void queryClient.invalidateQueries({ queryKey: agentSessionQueryKey(session.id, session.projectId) });
      void queryClient.invalidateQueries({ queryKey: projectChatQueryKey(session.projectId) });
    },
  });
}

export function useSendMessage(
  sessionId: string | null | undefined,
  editorContextInput?: AgentChatEditorContext | string | null,
  projectIdInput?: string | null,
) {
  // Keep the old timeline-only call shape usable for small host fixtures while
  // the video editor uses the richer structured context.
  const editorContext = typeof editorContextInput === 'string'
    ? {
        tool: 'video-editor' as const,
        projectId: null,
        projectSlug: null,
        timelineId: editorContextInput,
        timelineName: null,
      }
    : editorContextInput;
  const scopeLifetime = useMemo(() => ({ controller: new AbortController(), inFlight: false, retryInFlight: false }), [sessionId, editorContext?.projectId, editorContext?.timelineId]);
  useEffect(() => {
    if (scopeLifetime.controller.signal.aborted) scopeLifetime.controller = new AbortController();
    return () => scopeLifetime.controller.abort();
  }, [scopeLifetime]);
  const scopeRef = useRef({ sessionId, projectId: editorContext?.projectId, timelineId: editorContext?.timelineId, mounted: true });
  scopeRef.current.sessionId = sessionId; scopeRef.current.projectId = editorContext?.projectId; scopeRef.current.timelineId = editorContext?.timelineId;
  useEffect(() => { scopeRef.current.mounted = true; return () => { scopeRef.current.mounted = false; }; }, []);
  const lastMessageRef = useRef<CapturedAgentRequest | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    onMutate: (command: AgentSendCommand) => {
      // Mark the cached turn active before dispatch so both pollers switch to
      // their fast cadence immediately, including while the prompt RPC waits.
      const projectId = command.kind === 'retry'
        ? command.request.editorContext.projectId
        : command.request?.editorContext.projectId ?? editorContext?.projectId;
      if (sessionId && projectId) {
        queryClient.setQueryData<AgentSessionView>(agentSessionQueryKey(sessionId, projectId), (current) =>
          current ? { ...current, status: 'processing' } : current);
      }
    },
    mutationFn: async (command: AgentSendCommand) => {
      if (scopeLifetime.inFlight) throw new Error('A message is already being sent or retried.');
      scopeLifetime.inFlight = true;
      try {
        if (!sessionId) throw new Error('sessionId is required');
        let request: CapturedAgentRequest;
        if (command.kind === 'retry') {
          if (sessionId !== command.request.sessionId) {
            throw new Error('The active session changed; the failed message can only be retried in its original session.');
          }
          if ((projectIdInput ?? undefined) !== command.request.routingProjectId) {
            throw new Error('The active project changed; the failed message can only be retried in its original project.');
          }
          request = command.request;
        } else {
          if (scopeLifetime.retryInFlight) throw new Error('A message is already being sent or retried.');
          if (!editorContext || (!hasNonEmptyId(editorContext.projectId) && !hasNonEmptyId(editorContext.timelineId))) {
            throw new Error('Select a project or timeline to chat.');
          }
          const routingProjectId = projectIdInput ?? undefined;
          if (routingProjectId !== undefined && routingProjectId !== editorContext.projectId) {
            throw new Error('The routing project does not match the captured editor context.');
          }
          request = command.request ?? cloneAgentRequest(command.input, sessionId, editorContext, routingProjectId);
          if (request.sessionId !== sessionId || request.routingProjectId !== routingProjectId) {
            throw new Error('The active project or session changed before sending the captured message.');
          }
        }
        // A retry retains the original operation context even if the user
        // reopened another timeline in the same project. Fence continuation
        // and recovery publication to the dispatching view's lifetime.
        const dispatchScope = { ...scopeRef.current };
        const isDispatchCurrent = () => scopeRef.current.mounted && scopeRef.current.sessionId === dispatchScope.sessionId
          && scopeRef.current.projectId === dispatchScope.projectId && scopeRef.current.timelineId === dispatchScope.timelineId;
        try {
          await agentStore.prompt(request.sessionId, request.input, editorContextForRequest(request), request.routingProjectId,
            isDispatchCurrent, scopeLifetime.controller.signal, request);
          if (isDispatchCurrent()) lastMessageRef.current = null;
          return request;
        } catch (error) {
          if (isDispatchCurrent()) lastMessageRef.current = request;
          throw error;
        }
      } finally {
        scopeLifetime.inFlight = false;
      }
    },
    onSuccess: (request) => {
      void queryClient.invalidateQueries({ queryKey: agentSessionQueryKey(request.sessionId, request.editorContext.projectId) });
      // Astrid writes through the workspace runtime. Let the editor's normal
      // version-aware persistence/poll path adopt the changed document instead
      // of forcing a blind local-state replacement.
      if (request.editorContext.timelineId) {
        void queryClient.invalidateQueries({ queryKey: timelineQueryKey(request.editorContext.timelineId) });
        void queryClient.invalidateQueries({ queryKey: assetRegistryQueryKey(request.editorContext.timelineId) });
      }
    },
    onError: (error, command) => {
      const projectId = command.kind === 'retry'
        ? command.request.editorContext.projectId
        : command.request?.editorContext.projectId ?? editorContext?.projectId;
      if (sessionId && projectId) {
        void queryClient.invalidateQueries({ queryKey: agentSessionQueryKey(sessionId, projectId) });
      }
      setLocalError(error instanceof Error ? error.message : String(error));
    },
  });

  const retryLastMessage = async () => {
    const request = lastMessageRef.current;
    if (!request) return null;
    if (scopeLifetime.retryInFlight || scopeLifetime.inFlight || mutation.isPending) {
      throw new Error('A message is already being sent or retried.');
    }
    if (sessionId !== request.sessionId) {
      const error = new Error('The active session changed; the failed message can only be retried in its original session.');
      setLocalError(error.message);
      throw error;
    }
    if ((projectIdInput ?? undefined) !== request.routingProjectId) {
      const error = new Error('The active project changed; the failed message can only be retried in its original project.');
      setLocalError(error.message);
      throw error;
    }
    setLocalError(null);
    scopeLifetime.retryInFlight = true;
    try {
      return await mutation.mutateAsync({ kind: 'retry', request });
    } finally {
      scopeLifetime.retryInFlight = false;
    }
  };

  const captureSend = (input: SendMessageInput | CapturedSendInput): AgentSendCommand => {
    if (!('input' in input)) return { kind: 'send', input };
    if (input.sessionId !== sessionId || input.projectId !== projectIdInput || input.context.projectId !== input.projectId) {
      throw new Error('The submitted message does not match the active project and session.');
    }
    return { kind: 'send', input: input.input, request: cloneAgentRequest(input.input, input.sessionId, input.context, input.projectId ?? undefined) };
  };
  return {
    ...mutation,
    isPending: mutation.isPending && scopeLifetime.inFlight,
    mutate: (input: SendMessageInput | CapturedSendInput) => mutation.mutate(captureSend(input)),
    mutateAsync: (input: SendMessageInput | CapturedSendInput) => mutation.mutateAsync(captureSend(input)),
    continuationNotice: null,
    clearContinuationNotice: () => undefined,
    localError,
    clearLocalError: () => setLocalError(null),
    hasRetryableMessage: Boolean(lastMessageRef.current),
    hasCapturedMessage: (targetSessionId: string, requestId: string) => lastMessageRef.current?.sessionId === targetSessionId && lastMessageRef.current.input.requestId === requestId,
    checkAcceptedRequest: async (requestId: string) => {
      if (!projectIdInput || !sessionId) return false;
      const current = await agentStore.get(projectIdInput, sessionId);
      queryClient.setQueryData(agentSessionQueryKey(sessionId, projectIdInput), current);
      // This request is known to be running, but is not a durable receipt. Keep
      // the saved queue row until completion and let the UI disable retry while
      // control.active is true; store.prompt also fences any click racing that UI.
      if (current.control?.active && current.control.activeRequestId === requestId) return false;
      const saved = await agentStore.get(projectIdInput, sessionId, true);
      queryClient.setQueryData(agentSessionQueryKey(sessionId, projectIdInput), saved);
      return saved.durableAcceptedRequestIds?.includes(requestId) ?? false;
    },
    retryLastMessage,
  };
}

export function useCancelSession(sessionId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('sessionId is required');
      await agentStore.cancel(sessionId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentSessionQueryKey(sessionId) });
    },
  });
}
