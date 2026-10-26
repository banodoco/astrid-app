import { describe, expect, it, vi } from 'vitest';

import { AGENT_NOT_INSTALLED_CODE, AstridLocalAcpRoutes, isAgentSetupError, modelCatalogSchema } from './acpRoutes.ts';
import { LOCAL_AGENT_TABLE } from './localAgents.ts';
import { BridgeRouteError, type AstridBridgeTransport } from './transport.ts';

describe('AstridLocalAcpRoutes', () => {
  it('waits without a completion deadline for legacy prompts while keeping control requests bounded', async () => {
    const requestJson = vi.fn(async (_path: string, _request: unknown, _schema: unknown, _what: string) => ({ result: {} }));
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);
    await routes.promptSession('connection', 'chat', [{ type: 'text', text: 'long task' }]);
    await routes.loadSession('connection', 'chat');
    expect(requestJson.mock.calls[0]).toEqual(['/acp/connection/rpc', {
      method: 'POST', timeoutMs: null, body: { method: 'session/prompt', params: { sessionId: 'chat', prompt: [{ type: 'text', text: 'long task' }] } },
    }, expect.anything(), 'ACP session/prompt']);
    expect(requestJson.mock.calls[1]).toEqual(['/acp/connection/rpc', {
      method: 'POST', body: { method: 'session/load', params: { sessionId: 'chat' } },
    }, expect.anything(), 'ACP session/load']);
  });

  it('accepts old and new provider fields and drops unknown provider keys', () => {
    const oldCatalog = modelCatalogSchema.parse({ providers: [{ id: 'openai', name: 'OpenAI', signedIn: true, models: [] }], currentModel: null });
    expect(oldCatalog.providers[0]).toMatchObject({ id: 'openai', signedIn: true });
    const newCatalog = modelCatalogSchema.parse({ providers: [{
      id: 'openrouter', name: 'OpenRouter', signedIn: false, models: [], usable: false,
      reason: 'needs_sign_in', login: 'api-key', recommended: true, futureField: 'ignored',
    }], currentModel: null });
    expect(newCatalog.providers[0]).toMatchObject({ usable: false, reason: 'needs_sign_in', login: 'api-key', recommended: true });
    expect(newCatalog.providers[0]).not.toHaveProperty('futureField');
  });

  it('carries next_action on route errors and identifies setup error codes', () => {
    const error = new BridgeRouteError('Connect agent', 502, { error: AGENT_NOT_INSTALLED_CODE, detail: 'Install the agent', next_action: 'install-agent' });
    expect(error.nextAction).toBe('install-agent');
    expect(error.message).toContain('Next: install-agent');
    expect(isAgentSetupError(error)).toBe(AGENT_NOT_INSTALLED_CODE);
    expect(isAgentSetupError(new Error('no'))).toBeNull();
  });

  it('posts an OpenRouter key and strips it from a failing error', async () => {
    const key = 'secret-openrouter-key';
    const requestJson = vi.fn(async (_path: string, _request: unknown, _schema: unknown) => {
      throw new BridgeRouteError('Save Astrid API key', 400, { error: 'invalid_key', detail: `Rejected ${key}` });
    });
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);
    let thrown: unknown;
    try { await routes.saveAstridApiKey('openrouter', key); } catch (error) { thrown = error; }
    expect(requestJson).toHaveBeenCalledWith('/acp/astrid/api-key', {
      method: 'POST', body: { provider: 'openrouter', key },
    }, expect.anything(), 'Save Astrid API key');
    expect(thrown).toMatchObject({ code: 'invalid_key', detail: 'Rejected [redacted]' });
    expect(JSON.stringify(thrown)).not.toContain(key);
    expect(String(thrown)).not.toContain(key);
  });

  it('preserves an empty-detail 404 for the setup card without exposing the key', async () => {
    const key = 'secret-openrouter-key';
    const requestJson = vi.fn(async () => { throw new BridgeRouteError('Save Astrid API key', 404, { error: 'not_found' }); });
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);
    await expect(routes.saveAstridApiKey('openrouter', key)).rejects.toMatchObject({ code: 'not_found', detail: '', status: 404 });
  });

  it('takes over the loaded session and preserves submission identity on prompt requests', async () => {
    const requestJson = vi.fn(async (_path: string, _request: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse({ result: { _astridSession: { role: 'writer', active: true, activeRequestId: 'queued-1' } } }));
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);
    await routes.takeOverSession('second-tab', 'codex:chat-3');
    await routes.promptProjectSession('p', 'second-tab', 'codex:chat-3', [{ type: 'text', text: 'hello' }], 'queued-1');
    expect(requestJson.mock.calls.map(([path, request]) => ({ path, request }))).toEqual([
      { path: '/acp/second-tab/rpc', request: { method: 'POST', body: { method: 'session/takeover', params: { sessionId: 'codex:chat-3' } } } },
      { path: '/acp/projects/p/chat/prompt', request: { method: 'POST', timeoutMs: null, body: { connection_id: 'second-tab', session_id: 'codex:chat-3', prompt: [{ type: 'text', text: 'hello' }], request_id: 'queued-1' } } },
    ]);
  });
  it('passes a new chat model at connect and keeps model discovery read-only', async () => {
    const models = { availableModels: [{ modelId: 'model/a', name: 'Model A', description: 'A model' }], currentModelId: 'model/a' };
    const requestJson = vi.fn(async (path: string, _request: unknown, schema: { parse: (value: unknown) => unknown }) =>
      schema.parse(path === '/acp/connect' ? { connection_id: 'c 1', initialize: {} } : { models }));
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);
    await routes.connect('codex', 'model/a');
    await expect(routes.sessionModels('c 1', 'codex:chat/1')).resolves.toEqual({ models });
    expect(requestJson.mock.calls.map(([path, request]) => ({ path, request }))).toEqual([
      { path: '/acp/connect', request: { method: 'POST', body: { agent: 'codex', defaultModelId: 'model/a' } } },
      { path: '/acp/c%201/models?sessionId=codex%3Achat%2F1', request: { method: 'GET' } },
    ]);
  });
  it('discovers local agents and launches the exact selected agent', async () => {
    const catalog = { defaultAgent: 'codex', agents: [{ id: 'codex', name: LOCAL_AGENT_TABLE.codex.name, state: 'ready' as const, line: null, models: [{ modelId: 'vendor/exact', name: 'Exact' }], defaultModel: 'vendor/exact' }] };
    const requestJson = vi.fn(async (path: string, _request: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse(path === '/acp/agents' ? catalog : { connection_id: 'c1', initialize: {} }));
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);
    await expect(routes.agents()).resolves.toEqual(catalog);
    await routes.connect('codex');
    expect(requestJson.mock.calls.map(([path, request]) => ({ path, request }))).toEqual([
      { path: '/acp/agents', request: { method: 'GET' } },
      { path: '/acp/connect', request: { method: 'POST', body: { agent: 'codex' } } },
    ]);
  });
  it('supports Astrid model choices at creation and omits choices for service defaults', async () => {
    const requestJson = vi.fn(async (_path: string, _request: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse({ connection_id: 'c1', initialize: {} }));
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);
    await routes.connect('astrid', 'openai/gpt-5');
    await routes.connect();
    expect(requestJson.mock.calls.map(([, request]) => request)).toEqual([
      { method: 'POST', body: { agent: 'astrid', defaultModelId: 'openai/gpt-5' } },
      { method: 'POST', body: {} },
    ]);
  });

  it('rejects raw model config without sending a mutation request', async () => {
    const requestJson = vi.fn();
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);
    await expect(routes.setConfigOption('c1', 'saved', 'model' as 'thinking', 'other')).rejects.toThrow('To use another model, start a new chat.');
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('keeps project chat association, durable drafts, and owned prompts on the ACP transport', async () => {
    const requestJson = vi.fn(async (path: string, request: unknown, _schema: unknown) => {
      if (path.endsWith('/unassigned?connection_id=connection-1')) return { sessions: [{ id: 'legacy-1' }] };
      if (path.endsWith('/chat/prompt')) return { result: { accepted: true } };
      return {
        project_id: 'project-1', scope_key: 'realm:store:project-1', revision: 2,
        selected_session_id: 'session-1', sessions: [{ id: 'session-1' }],
        draft: { text: 'draft', revision: 1, queued_messages: [] },
      };
    });
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);

    await routes.projectChat('project-1');
    await routes.createProjectSession('project-1', 'connection-1', 'ensure', 'op-1');
    await expect(routes.unassignedProjectSessions('project-1', 'connection-1')).resolves.toEqual([{ id: 'legacy-1' }]);
    await routes.associateProjectSession('project-1', 'connection-1', 1, 'legacy-1');
    await routes.saveProjectDraft('project-1', 1, 'draft', [{ id: 'q1', text: 'queued', session_id: 'session-1' }]);
    await routes.selectProjectSession('project-1', 2, 'session-1');
    await routes.setMainProjectSession('project-1', 2, 'session-1');
    await expect(routes.promptProjectSession('project-1', 'connection-1', 'session-1', [{ type: 'text', text: 'hello' }])).resolves.toEqual({ accepted: true });

    expect(requestJson.mock.calls.map(([path, request]) => ({ path, method: (request as { method?: string }).method ?? 'GET' }))).toEqual([
      { path: '/acp/projects/project-1/chat', method: 'GET' },
      { path: '/acp/projects/project-1/chat/sessions', method: 'POST' },
      { path: '/acp/projects/project-1/chat/unassigned?connection_id=connection-1', method: 'GET' },
      { path: '/acp/projects/project-1/chat/associate', method: 'POST' },
      { path: '/acp/projects/project-1/chat/draft', method: 'PATCH' },
      { path: '/acp/projects/project-1/chat', method: 'PATCH' },
      { path: '/acp/projects/project-1/chat/main', method: 'PATCH' },
      { path: '/acp/projects/project-1/chat/prompt', method: 'POST' },
    ]);
  });

  it('renames a project session through the revisioned project chat route and preserves route errors', async () => {
    const chat = {
      project_id: 'project/one', scope_key: 'realm:project/one', revision: 8,
      selected_session_id: 'opaque:session/1', sessions: [{ id: 'opaque:session/1', title: 'New title' }],
      draft: { text: '', revision: 0, queued_messages: [] },
    };
    const requestJson = vi.fn(async (_path: string, _request: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse(chat));
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);

    await expect(routes.renameProjectSession('project/one', 7, 'opaque:session/1', 'New title')).resolves.toEqual(chat);
    expect(requestJson).toHaveBeenCalledWith('/acp/projects/project%2Fone/chat', {
      method: 'PATCH', body: { expected_revision: 7, session_id: 'opaque:session/1', title: 'New title' },
    }, expect.anything(), 'Rename project chat session');

    const conflict = new BridgeRouteError('Rename project chat session', 409, { error: 'revision_conflict', detail: 'Project chat changed' });
    const rejectingRoutes = new AstridLocalAcpRoutes({ requestJson: vi.fn(async () => { throw conflict; }) } as unknown as AstridBridgeTransport);
    await expect(rejectingRoutes.renameProjectSession('project/one', 6, 'opaque:session/1', 'Stale title')).rejects.toBe(conflict);
  });

  it('keeps browser lifecycle controls on the same-origin ACP transport', async () => {
    let connectionCount = 0;
    const requestJson = vi.fn(async (
      _path: string,
      _request: unknown,
      _schema: unknown,
      what: string,
    ) => {
      if (what === 'ACP connect') {
        connectionCount += 1;
        return { connection_id: `connection-${connectionCount}`, initialize: { protocolVersion: 1 } };
      }
      if (what === 'ACP cancel session') return { cancelled: true, session_id: 'omp-session-opaque' };
      if (what === 'ACP disconnect') return { connection_id: 'connection-1', closed: true };
      if (what === 'ACP reconnect') return { connection_id: 'connection-1', reused: true };
      if (what === 'ACP events') return { notifications: [], disconnected: false };
      return { result: { sessionId: 'omp-session-opaque' } };
    });
    const routes = new AstridLocalAcpRoutes({ requestJson } as unknown as AstridBridgeTransport);

    await expect(routes.connect()).resolves.toMatchObject({ connection_id: 'connection-1' });
    await expect(routes.createSession('connection-1', { mcpServers: [] })).resolves.toEqual({ sessionId: 'omp-session-opaque' });
    await expect(routes.resumeSession('connection-1', 'omp-session-opaque')).resolves.toEqual({ sessionId: 'omp-session-opaque' });
    await expect(routes.promptSession('connection-1', 'omp-session-opaque', [{ type: 'text', text: 'hello' }])).resolves.toEqual({ sessionId: 'omp-session-opaque' });
    await expect(routes.setConfigOption('connection-1', 'omp-session-opaque', 'thinking', 'xhigh')).resolves.toEqual({ sessionId: 'omp-session-opaque' });
    await expect(routes.cancelSession('connection-1', 'omp-session-opaque')).resolves.toEqual({
      cancelled: true,
      session_id: 'omp-session-opaque',
    });
    await expect(routes.closeSession('connection-1', 'omp-session-opaque')).resolves.toEqual({ sessionId: 'omp-session-opaque' });
    await expect(routes.events('connection-1')).resolves.toEqual({ notifications: [], disconnected: false });
    await expect(routes.disconnect('connection-1')).resolves.toEqual({ connection_id: 'connection-1', closed: true });
    await expect(routes.reconnect('connection-1')).resolves.toEqual({ connection_id: 'connection-1', reused: true });
    await expect(routes.reconnect()).resolves.toMatchObject({ connection_id: 'connection-2' });

    expect(requestJson.mock.calls.map(([path, request]) => ({
      path,
      method: (request as { method?: string }).method ?? 'GET',
      body: (request as { body?: unknown }).body,
    }))).toEqual([
      { path: '/acp/connect', method: 'POST', body: {} },
      { path: '/acp/connection-1/rpc', method: 'POST', body: { method: 'session/new', params: { mcpServers: [] } } },
      { path: '/acp/connection-1/rpc', method: 'POST', body: { method: 'session/resume', params: { sessionId: 'omp-session-opaque' } } },
      { path: '/acp/connection-1/rpc', method: 'POST', body: { method: 'session/prompt', params: { sessionId: 'omp-session-opaque', prompt: [{ type: 'text', text: 'hello' }] } } },
      { path: '/acp/connection-1/rpc', method: 'POST', body: { method: 'session/set_config_option', params: { sessionId: 'omp-session-opaque', configId: 'thinking', value: 'xhigh' } } },
      { path: '/acp/connection-1/cancel', method: 'POST', body: { sessionId: 'omp-session-opaque' } },
      { path: '/acp/connection-1/rpc', method: 'POST', body: { method: 'session/close', params: { sessionId: 'omp-session-opaque' } } },
      { path: '/acp/connection-1/events', method: 'GET', body: undefined },
      { path: '/acp/connection-1', method: 'DELETE', body: undefined },
      { path: '/acp/connection-1/reconnect', method: 'POST', body: {} },
      { path: '/acp/connect', method: 'POST', body: {} },
    ]);
  });
});
