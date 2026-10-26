import { z } from 'zod';

import { ACP_UNAVAILABLE_CODE, BridgeRouteError, type AstridBridgeTransport } from './transport.ts';
import { localAgentCatalogSchema, localAgentModelsSchema, type LocalAgentId } from './localAgents.ts';
import { AGENT_CHAT_COPY } from './chatCopy.ts';

const connectionSchema = z.strictObject({
  connection_id: z.string().min(1),
  initialize: z.unknown(),
});
const rpcResponseSchema = z.strictObject({ result: z.unknown() });
const cancelResponseSchema = z.strictObject({
  cancelled: z.literal(true),
  session_id: z.string().min(1),
});
const disconnectResponseSchema = z.strictObject({
  connection_id: z.string().min(1),
  closed: z.literal(true),
});
const reconnectResponseSchema = z.strictObject({
  connection_id: z.string().min(1),
  reused: z.literal(true),
});
const eventsResponseSchema = z.strictObject({
  notifications: z.array(z.unknown()),
  disconnected: z.boolean(),
});
const modelUsageSchema = z.strictObject({
  limits: z.array(z.strictObject({
    unit: z.enum(['percent', 'tokens', 'requests', 'usd', 'minutes', 'bytes', 'unknown']).optional(),
    used: z.number().optional(), limit: z.number().optional(), remaining: z.number().optional(),
    usedFraction: z.number().optional(), remainingFraction: z.number().optional(),
    durationMs: z.number().optional(), resetsAt: z.number().optional(),
    status: z.enum(['ok', 'warning', 'exhausted', 'unknown']).optional(),
  })),
});
export const modelCatalogSchema = z.strictObject({
  providers: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), signedIn: z.boolean(),
    models: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
    usage: modelUsageSchema.optional(),
    usable: z.boolean().optional(),
    reason: z.enum(['needs_sign_in', 'no_available_models']).nullable().optional(),
    login: z.enum(['oauth', 'api-key', 'local']).optional(),
    recommended: z.boolean().optional(),
  })),
  currentModel: z.string().nullable(),
});
const saveAstridApiKeyResponseSchema = z.object({
  provider: z.literal('openrouter'),
  signedIn: z.literal(true),
  currentModel: z.string().nullable(),
});
export type SaveAstridApiKeyResponse = z.infer<typeof saveAstridApiKeyResponseSchema>;
const localModelResponseSchema = z.object({ models: localAgentModelsSchema.nullable() });
export type AcpModelCatalog = z.infer<typeof modelCatalogSchema>;
export type AcpModelProvider = AcpModelCatalog['providers'][number];

export const AGENT_NOT_INSTALLED_CODE = 'agent_not_installed';
export const AGENT_SIGN_IN_REQUIRED_CODE = 'agent_sign_in_required';
export const AGENT_RUNTIME_MISSING_CODE = 'agent_runtime_missing';
export type AgentSetupErrorCode =
  | typeof AGENT_NOT_INSTALLED_CODE
  | typeof AGENT_SIGN_IN_REQUIRED_CODE
  | typeof AGENT_RUNTIME_MISSING_CODE;

// Defined beside the transport retry that must not retry it; re-exported for the chat pane.
export { ACP_UNAVAILABLE_CODE };

/** True for the door's "no chat service here" answer: a state the chat pane shows plainly, never an error. */
export function isAcpUnavailable(error: unknown): boolean {
  return error instanceof BridgeRouteError && error.status === 503 && error.code === ACP_UNAVAILABLE_CODE;
}

export function isAgentSetupError(error: unknown): AgentSetupErrorCode | null {
  if (!(error instanceof BridgeRouteError)) return null;
  return error.code === AGENT_NOT_INSTALLED_CODE
    || error.code === AGENT_SIGN_IN_REQUIRED_CODE
    || error.code === AGENT_RUNTIME_MISSING_CODE
    ? error.code
    : null;
}

class AstridApiKeyRouteError extends Error {
  constructor(readonly code: string | undefined, readonly detail: string, readonly status?: number) {
    super(detail);
    this.name = 'AstridApiKeyRouteError';
  }
}

export type AstridAcpConnection = z.infer<typeof connectionSchema>;
export type AstridAcpRpcParams = Record<string, unknown>;
const projectChatSchema = z.object({
  project_id: z.string(),
  scope_key: z.string(),
  revision: z.number().int(),
  selected_session_id: z.string().nullable(),
  main_session_id: z.string().nullable().optional(),
  operation_session_id: z.string().optional(),
  sessions: z.array(z.object({ id: z.string(), title: z.string().optional(), missing: z.boolean().optional(), pending_first_message: z.boolean().optional(), model_id: z.string().optional() })),
  draft: z.object({
    text: z.string(), revision: z.number().int(),
    queued_messages: z.array(z.object({ id: z.string(), text: z.string(), session_id: z.string(), attachments: z.array(z.unknown()).optional() })).optional(),
  }),
});
export type ProjectChatState = z.infer<typeof projectChatSchema>;
const unassignedSessionsSchema = z.object({ sessions: z.array(z.object({ id: z.string(), title: z.string().optional() })) });
export type ProjectChatCandidate = z.infer<typeof unassignedSessionsSchema>['sessions'][number];

/**
 * Browser-side controls for the host-owned ACP lifecycle. The connection id
 * is ephemeral and held by the caller; OMP's opaque session id is never
 * rewritten or persisted here.
 */
export class AstridLocalAcpRoutes {
  constructor(private readonly transport: AstridBridgeTransport) {}

  async projectChat(projectId: string): Promise<ProjectChatState> {
    return this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat`, { method: 'GET' }, projectChatSchema, 'Read project chat');
  }

  async createProjectSession(projectId: string, connectionId: string, mode: 'ensure' | 'ensure_main' | 'new', operationId: string): Promise<ProjectChatState> {
    return this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat/sessions`, {
      method: 'POST', body: { connection_id: connectionId, mode, operation_id: operationId },
    }, projectChatSchema, 'Create project chat session');
  }

  async recoverProjectSession(projectId: string, connectionId: string, operationId: string, sessionId: string): Promise<ProjectChatState> {
    return this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat/sessions`, {
      method: 'POST', body: { connection_id: connectionId, mode: 'ensure', operation_id: operationId, recover_session_id: sessionId },
    }, projectChatSchema, 'Recover empty project chat session');
  }

  async unassignedProjectSessions(projectId: string, connectionId: string): Promise<ProjectChatCandidate[]> {
    const result = await this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat/unassigned?connection_id=${encodeURIComponent(connectionId)}`, { method: 'GET' }, unassignedSessionsSchema, 'List unassigned OMP sessions');
    return result.sessions;
  }

  async associateProjectSession(projectId: string, connectionId: string, expectedRevision: number, sessionId: string): Promise<ProjectChatState> {
    return this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat/associate`, {
      method: 'POST', body: { connection_id: connectionId, expected_revision: expectedRevision, session_id: sessionId },
    }, projectChatSchema, 'Attach existing OMP session');
  }

  async saveProjectDraft(projectId: string, expectedRevision: number, text: string, queuedMessages: ProjectChatState['draft']['queued_messages'] = []): Promise<ProjectChatState> {
    return this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat/draft`, {
      method: 'PATCH', body: { expected_revision: expectedRevision, text, queued_messages: queuedMessages },
    }, projectChatSchema, 'Save project chat draft');
  }

  async selectProjectSession(projectId: string, expectedRevision: number, selectedSessionId: string | null): Promise<ProjectChatState> {
    return this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat`, {
      method: 'PATCH', body: { expected_revision: expectedRevision, selected_session_id: selectedSessionId },
    }, projectChatSchema, 'Select project chat session');
  }

  async setMainProjectSession(projectId: string, expectedRevision: number, sessionId: string): Promise<ProjectChatState> {
    return this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat/main`, {
      method: 'PATCH', body: { expected_revision: expectedRevision, main_session_id: sessionId },
    }, projectChatSchema, 'Choose Main project chat');
  }

  async renameProjectSession(projectId: string, expectedRevision: number, sessionId: string, title: string): Promise<ProjectChatState> {
    return this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat`, {
      method: 'PATCH', body: { expected_revision: expectedRevision, session_id: sessionId, title },
    }, projectChatSchema, 'Rename project chat session');
  }

  async promptProjectSession(projectId: string, connectionId: string, sessionId: string, prompt: Array<Record<string, unknown>>, requestId?: string): Promise<unknown> {
    const response = await this.transport.requestJson(`/acp/projects/${encodeURIComponent(projectId)}/chat/prompt`, {
      method: 'POST', timeoutMs: null, body: { connection_id: connectionId, session_id: sessionId, prompt, ...(requestId ? { request_id: requestId } : {}) },
    }, rpcResponseSchema, 'Prompt project chat session');
    return response.result;
  }

  async agents() {
    return this.transport.requestJson('/acp/agents', { method: 'GET' }, localAgentCatalogSchema, 'List local agents');
  }

  async connect(agent?: LocalAgentId, defaultModelId?: string): Promise<AstridAcpConnection> {
    return this.transport.requestJson(
      '/acp/connect',
      { method: 'POST', body: { ...(agent ? { agent } : {}), ...(defaultModelId ? { defaultModelId } : {}) } },
      connectionSchema,
      'ACP connect',
    );
  }

  async models(): Promise<AcpModelCatalog> {
    return this.transport.requestJson('/acp/models', { method: 'GET' }, modelCatalogSchema, 'List ACP models');
  }

  async saveAstridApiKey(provider: 'openrouter', key: string): Promise<SaveAstridApiKeyResponse> {
    try {
      return await this.transport.requestJson('/acp/astrid/api-key', {
        method: 'POST', body: { provider, key },
      }, saveAstridApiKeyResponseSchema, 'Save Astrid API key');
    } catch (error) {
      const code = error instanceof BridgeRouteError ? error.code : undefined;
      const status = error instanceof BridgeRouteError ? error.status : undefined;
      const rawDetail = error instanceof BridgeRouteError
        ? error.detail ?? ''
        : error instanceof Error ? error.message : 'Request failed';
      const redactKey = (value: string) => key ? value.split(key).join('[redacted]') : value;
      throw new AstridApiKeyRouteError(code ? redactKey(code) : code, redactKey(rawDetail), status);
    }
  }

  async sessionModels(connectionId: string, sessionId: string) {
    return this.transport.requestJson(`/acp/${encodeURIComponent(connectionId)}/models?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'GET' }, localModelResponseSchema, 'List local agent models');
  }

  async reconnect(connectionId?: string): Promise<AstridAcpConnection | z.infer<typeof reconnectResponseSchema>> {
    if (!connectionId) return this.connect();
    return this.transport.requestJson(
      '/acp/' + encodeURIComponent(connectionId) + '/reconnect',
      { method: 'POST', body: {} },
      reconnectResponseSchema,
      'ACP reconnect',
    );
  }

  async createSession<T = unknown>(connectionId: string, params: AstridAcpRpcParams = {}): Promise<T> {
    return this.rpc<T>(connectionId, 'session/new', params);
  }

  async resumeSession<T = unknown>(connectionId: string, sessionId: string, params: AstridAcpRpcParams = {}): Promise<T> {
    return this.rpc<T>(connectionId, 'session/resume', { ...params, sessionId });
  }

  async loadSession<T = unknown>(connectionId: string, sessionId: string, params: AstridAcpRpcParams = {}): Promise<T> {
    return this.rpc<T>(connectionId, 'session/load', { ...params, sessionId });
  }

  async takeOverSession<T = unknown>(connectionId: string, sessionId: string): Promise<T> {
    return this.rpc<T>(connectionId, 'session/takeover', { sessionId });
  }

  async listSessions<T = unknown>(connectionId: string, params: AstridAcpRpcParams = {}): Promise<T> {
    return this.rpc<T>(connectionId, 'session/list', params);
  }

  async promptSession<T = unknown>(
    connectionId: string,
    sessionId: string,
    prompt: Array<Record<string, unknown>>,
  ): Promise<T> {
    return this.rpc<T>(connectionId, 'session/prompt', { sessionId, prompt });
  }

  async setConfigOption<T = unknown>(
    connectionId: string,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<T> {
    if (configId === 'model') throw new Error(AGENT_CHAT_COPY.fixedModel);
    return this.rpc<T>(connectionId, 'session/set_config_option', { sessionId, configId, value });
  }

  async cancelSession(connectionId: string, sessionId: string): Promise<z.infer<typeof cancelResponseSchema>> {
    return this.transport.requestJson(
      `/acp/${encodeURIComponent(connectionId)}/cancel`,
      { method: 'POST', body: { sessionId } },
      cancelResponseSchema,
      'ACP cancel session',
    );
  }

  async closeSession<T = unknown>(connectionId: string, sessionId: string): Promise<T> {
    return this.rpc<T>(connectionId, 'session/close', { sessionId });
  }

  async events(connectionId: string): Promise<z.infer<typeof eventsResponseSchema>> {
    return this.transport.requestJson(
      `/acp/${encodeURIComponent(connectionId)}/events`,
      {},
      eventsResponseSchema,
      'ACP events',
    );
  }

  async disconnect(connectionId: string, options: { keepalive?: boolean } = {}): Promise<z.infer<typeof disconnectResponseSchema>> {
    return this.transport.requestJson(
      `/acp/${encodeURIComponent(connectionId)}`,
      { method: 'DELETE', ...options },
      disconnectResponseSchema,
      'ACP disconnect',
    );
  }

  private async rpc<T>(connectionId: string, method: string, params: AstridAcpRpcParams): Promise<T> {
    const response = await this.transport.requestJson(
      `/acp/${encodeURIComponent(connectionId)}/rpc`,
      { method: 'POST', ...(method === 'session/prompt' ? { timeoutMs: null } : {}), body: { method, params } },
      rpcResponseSchema,
      `ACP ${method}`,
    );
    return response.result as T;
  }
}
