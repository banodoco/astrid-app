// @vitest-environment jsdom
import React from 'react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendAcpAssistantDraft,
  appendAcpTextTurn,
  AstridAgentSessionStore,
  projectChatQueryKey,
  stripAstridEditorContext,
  useCancelSession,
  useCreateSession,
  useProjectChat,
  useRenameProjectSession,
  useSaveProjectDraft,
  useSelectProjectSession,
  useSetMainProjectSession,
  useSendMessage,
  useAgentSession,
  useAgentModels,
  useConfigureAgentSession,
  useTakeOverSession,
  useLocalAgents,
  localAgentsQueryKey,
  agentSessionQueryKey,
} from './useAgentSession.ts';
import type { ProjectChatState } from '@/integrations/astrid/acpRoutes.ts';
import { BridgeRouteError, BridgeTransportFailure } from '@/integrations/astrid/transport.ts';
import { LOCAL_AGENT_TABLE } from '@/integrations/astrid/localAgents.ts';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
}

function wrapperWithClient(client: QueryClient) {
  return function QueryClientWrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

let testStorage: Storage;
beforeEach(() => {
  testStorage = createStorage();
  vi.stubGlobal('localStorage', testStorage);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('timeline agent ACP chat', () => {
  it('keeps a prompt running past five minutes on the same writer connection until it completes', async () => {
    vi.spyOn(await import('../runtime/admitted-elements'), 'refreshProjectElementContext').mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    // Model the browser deadline with the controlled clock: native timeout
    // implementations do not consistently follow Vitest's fake timers.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return deadline.signal;
    });
    const sessionId = 'codex:long-turn';
    const requestId = 'long-request';
    let active = false;
    let notifyFinished = false;
    let complete!: (response: Response) => void;
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat')) return Response.json({ project_id: 'p', scope_key: 'p', revision: 1, selected_session_id: sessionId, sessions: [{ id: sessionId }], draft: { text: '', revision: 0 } });
      if (url.endsWith('/connect')) return Response.json({ connection_id: 'original-writer', initialize: {} });
      if (url.endsWith('/rpc')) return Response.json({ result: { _astridSession: { role: 'writer', active, activeRequestId: active ? requestId : null } } });
      if (url.endsWith('/events')) {
        const updates = [
          { sessionUpdate: 'astrid_session_control', role: 'writer', active, activeRequestId: active ? requestId : null },
          ...(notifyFinished ? [{ sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'Finished the long task' } }] : []),
        ];
        notifyFinished = false;
        return Response.json({ disconnected: false, notifications: updates.map(update => ({ method: 'session/update', params: { sessionId, update } })) });
      }
      if (url.endsWith('/chat/prompt')) {
        expect(JSON.parse(String(init?.body)).request_id).toBe(requestId);
        active = true;
        return new Promise<Response>((resolve, reject) => {
          complete = resolve;
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          dispatched();
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const store = new AstridAgentSessionStore();
      await store.get('p', sessionId);
      let outcome = 'pending';
      const prompt = store.prompt(sessionId, { message: 'Make a long scene', requestId }, { tool: 'video-editor', projectId: 'p', timelineId: null })
        .then(() => { outcome = 'completed'; }, error => { outcome = String(error); });
      await started;
      await store.heartbeat('p', sessionId);
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      const running = await store.get('p', sessionId);
      expect(outcome).toBe('pending');
      expect(running.status).toBe('processing');
      expect(running.control).toEqual({ role: 'writer', active: true, activeRequestId: requestId });
      await expect(store.prompt(sessionId, { message: 'duplicate', requestId }, { tool: 'video-editor', projectId: 'p', timelineId: null })).rejects.toThrow('already active');
      active = false;
      notifyFinished = true;
      complete(Response.json({ result: { stopReason: 'end_turn' } }));
      await prompt;
      const finished = await store.get('p', sessionId);
      expect(outcome).toBe('completed');
      expect(finished.status).toBe('waiting_user');
      expect(finished.turns.filter(turn => turn.role === 'assistant')).toEqual([expect.objectContaining({ content: 'Finished the long task' })]);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/connect'))).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/prompt'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['load', 'not_found'], ['events', 'not_found'],
    ['load', 'connection_not_found'], ['events', 'connection_not_found'],
  ])('reconnects a lost bridge during %s (%s) without sending a prompt', async (stage, code) => {
    const missing = new BridgeRouteError('ACP events', 404, { error: code, detail: 'ACP connection is not available; reconnect' });
    const acp = {
      projectChat: vi.fn(async () => ({ project_id: 'p', sessions: [{ id: 'chat-1' }] })),
      connect: vi.fn().mockResolvedValueOnce({ connection_id: 'old' }).mockResolvedValue({ connection_id: 'new' }),
      loadSession: vi.fn(async (id: string) => { if (id === 'old' && stage === 'load') throw missing; return {}; }),
      events: vi.fn(async (id: string) => { if (id === 'old' && stage === 'events') throw missing; return { notifications: [], disconnected: false }; }),
      promptProjectSession: vi.fn(),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    expect((await store.get('p', 'chat-1')).id).toBe('chat-1');
    expect(acp.connect).toHaveBeenCalledTimes(2);
    expect(acp.loadSession).toHaveBeenLastCalledWith('new', 'chat-1');
    expect(acp.promptProjectSession).not.toHaveBeenCalled();
  });

  it('stops read-only recovery after one fresh connection also disappears', async () => {
    const missing = new BridgeRouteError('ACP rpc', 404, { error: 'connection_not_found', detail: 'ACP connection expired while idle; reconnect' });
    const acp = {
      projectChat: vi.fn(async () => ({ project_id: 'p', sessions: [{ id: 'chat-1' }] })),
      connect: vi.fn(async () => ({ connection_id: 'missing' })),
      loadSession: vi.fn(async () => { throw missing; }),
    };
    await expect(new AstridAgentSessionStore({ acp } as never).get('p', 'chat-1')).rejects.toBe(missing);
    expect(acp.connect).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect or hide an unknown saved session', async () => {
    const missing = new BridgeRouteError('ACP rpc', 404, { error: 'not_found', detail: 'ACP session not found: chat-1' });
    const acp = {
      projectChat: vi.fn(async () => ({ project_id: 'p', sessions: [{ id: 'chat-1' }] })),
      connect: vi.fn(async () => ({ connection_id: 'valid' })),
      loadSession: vi.fn(async () => { throw missing; }),
    };
    await expect(new AstridAgentSessionStore({ acp } as never).get('p', 'chat-1')).rejects.toBe(missing);
    expect(acp.connect).toHaveBeenCalledTimes(1);
  });

  it('streams live follower turns without recording replay receipts, blocks writes, and takes over explicitly', async () => {
    const projectChat = { project_id: 'p', scope_key: 'project:p', revision: 1, selected_session_id: 'chat-1', sessions: [{ id: 'chat-1' }], draft: { text: '', revision: 1, queued_messages: [] } };
    let eventsRead = false;
    const acp = {
      connect: vi.fn(async () => ({ connection_id: 'follower-connection' })),
      projectChat: vi.fn(async () => projectChat),
      loadSession: vi.fn(async () => ({ _astridSession: { role: 'follower', active: true, activeRequestId: 'remote-request' } })),
      events: vi.fn(async () => {
        if (eventsRead) return { disconnected: false, notifications: [] };
        eventsRead = true;
        return { disconnected: false, notifications: [
          { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-1', update: { sessionUpdate: 'user_message_chunk', live: true, requestId: 'remote-request', messageId: 'astrid-live:remote-request', content: { type: 'text', text: 'Remote request' } } } },
          { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'remote-reply', content: { type: 'text', text: 'Remote reply' } } } },
        ] };
      }),
      promptProjectSession: vi.fn(),
      cancelSession: vi.fn(),
      takeOverSession: vi.fn(async () => ({ _astridSession: { role: 'writer', active: false, activeRequestId: null } })),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    const follower = await store.get('p', 'chat-1');
    expect(follower.control).toEqual({ role: 'follower', active: true, activeRequestId: 'remote-request' });
    expect(follower.status).toBe('processing');
    expect(follower.turns).toEqual([
      expect.objectContaining({ role: 'user', content: 'Remote request', request_id: 'remote-request', messageId: 'astrid-live:remote-request' }),
      expect.objectContaining({ role: 'assistant', content: 'Remote reply', messageId: 'remote-reply' }),
    ]);
    expect(follower.durableAcceptedRequestIds).not.toContain('remote-request');
    await expect(store.prompt('chat-1', { message: 'duplicate' }, { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null })).rejects.toThrow('Take over');
    await expect(store.cancel('chat-1')).rejects.toThrow('Take over');
    expect(acp.promptProjectSession).not.toHaveBeenCalled();
    expect(acp.cancelSession).not.toHaveBeenCalled();
    const owned = await store.takeOver('p', 'chat-1');
    expect(acp.takeOverSession).toHaveBeenCalledWith('follower-connection', 'chat-1');
    expect(owned.control).toEqual({ role: 'writer', active: false, activeRequestId: null });
    expect(owned.turns).toHaveLength(2);
  });

  it('keeps live assistant output when the current writer is taken over mid-turn', async () => {
    const projectChat = { project_id: 'p', scope_key: 'project:p', revision: 1, selected_session_id: 'chat-2', sessions: [{ id: 'chat-2' }], draft: { text: '', revision: 1, queued_messages: [] } };
    const requestId = 'writer-request';
    let promptReturned = false;
    const acp = {
      connect: vi.fn(async () => ({ connection_id: 'writer-connection' })),
      projectChat: vi.fn(async () => projectChat),
      loadSession: vi.fn(async () => ({ _astridSession: { role: 'writer', active: false, activeRequestId: null } })),
      events: vi.fn(async () => {
        if (!promptReturned) return { disconnected: false, notifications: [] };
        promptReturned = false;
        return { disconnected: false, notifications: [
          { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-2', update: { sessionUpdate: 'astrid_session_control', role: 'follower', active: true, activeRequestId: requestId } } },
          { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-2', update: { sessionUpdate: 'agent_message_chunk', live: true, messageId: 'reply-2', content: { type: 'text', text: 'Streamed once' } } } },
        ] };
      }),
      promptProjectSession: vi.fn(async () => { promptReturned = true; return {}; }),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.prompt('chat-2', { message: 'hello', requestId }, { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null });
    const saved = await store.get('p', 'chat-2');
    expect(acp.promptProjectSession).toHaveBeenCalledWith('p', 'writer-connection', 'chat-2', expect.any(Array), requestId);
    expect(saved.turns.filter(turn => turn.role === 'assistant')).toEqual([expect.objectContaining({ content: 'Streamed once', messageId: 'reply-2' })]);
    expect(saved.control).toEqual({ role: 'follower', active: true, activeRequestId: requestId });
    expect(saved.status).toBe('processing');
  });

  it('allows the active writer to cancel and lets its prompt finish across active control updates', async () => {
    const projectChat = { project_id: 'p', scope_key: 'project:p', revision: 1, selected_session_id: 'chat-active', sessions: [{ id: 'chat-active' }], draft: { text: '', revision: 1, queued_messages: [] } };
    let releasePrompt!: () => void;
    const notifications: unknown[] = [];
    const promptWait = new Promise<void>(resolve => { releasePrompt = resolve; });
    const acp = {
      connect: vi.fn(async () => ({ connection_id: 'active-connection' })),
      projectChat: vi.fn(async () => projectChat),
      loadSession: vi.fn(async () => ({ _astridSession: { role: 'writer', active: false, activeRequestId: null } })),
      events: vi.fn(async () => ({ disconnected: false, notifications: notifications.splice(0) })),
      promptProjectSession: vi.fn(async () => { await promptWait; return {}; }),
      cancelSession: vi.fn(async () => {
        notifications.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-active', update: { sessionUpdate: 'astrid_session_control', role: 'writer', active: false, activeRequestId: null } } });
        releasePrompt();
        return {};
      }),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    const prompt = store.prompt('chat-active', { message: 'hello', requestId: 'local-request' }, { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null });
    await vi.waitFor(() => expect(acp.promptProjectSession).toHaveBeenCalled());
    notifications.push(
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-active', update: { sessionUpdate: 'astrid_session_control', role: 'writer', active: true, activeRequestId: 'local-request' } } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-active', update: { sessionUpdate: 'tool_call', toolCallId: 'stopped-tool', title: 'Read a file', content: 'Read a file' } } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-active', update: { sessionUpdate: 'tool_call_update', toolCallId: 'stopped-tool', status: 'in_progress' } } },
    );
    await store.get('p', 'chat-active');
    await expect(store.cancel('chat-active')).resolves.toBeUndefined();
    await expect(prompt).resolves.toBeUndefined();

    notifications.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-active', update: { sessionUpdate: 'tool_call_update', toolCallId: 'stopped-tool', status: 'in_progress' } } });
    const stopped = await store.get('p', 'chat-active');
    expect(stopped.status).toBe('waiting_user');
    expect(stopped.turns.find(turn => turn.role === 'tool_result' && turn.tool_call_id === 'stopped-tool')).toMatchObject({
      tool_status: 'cancelled',
      content: 'Stopped.',
    });

    await expect(store.prompt('chat-active', { message: 'continue', requestId: 'next-request' }, { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null })).resolves.toBeUndefined();
    expect(acp.promptProjectSession).toHaveBeenCalledTimes(2);
    expect((await store.get('p', 'chat-active')).status).toBe('waiting_user');
  });

  it('returns quietly when takeover arrives during an in-flight writer prompt', async () => {
    const projectChat = { project_id: 'p', scope_key: 'project:p', revision: 1, selected_session_id: 'chat-taken', sessions: [{ id: 'chat-taken' }], draft: { text: '', revision: 1, queued_messages: [] } };
    let releasePrompt!: () => void;
    const notification: { value: unknown } = { value: undefined };
    const promptWait = new Promise<void>(resolve => { releasePrompt = resolve; });
    const acp = {
      connect: vi.fn(async () => ({ connection_id: 'taken-connection' })),
      projectChat: vi.fn(async () => projectChat),
      loadSession: vi.fn(async () => ({ _astridSession: { role: 'writer', active: false, activeRequestId: null } })),
      events: vi.fn(async () => ({ disconnected: false, notifications: notification.value ? [notification.value] : [] })),
      promptProjectSession: vi.fn(async () => { await promptWait; return {}; }),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    const prompt = store.prompt('chat-taken', { message: 'hello', requestId: 'remote-request' }, { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null });
    await vi.waitFor(() => expect(acp.promptProjectSession).toHaveBeenCalled());
    notification.value = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-taken', update: { sessionUpdate: 'astrid_session_control', role: 'follower', active: true, activeRequestId: 'remote-request' } } };
    await store.get('p', 'chat-taken');
    releasePrompt();
    await expect(prompt).resolves.toBeUndefined();
    expect(acp.promptProjectSession).toHaveBeenCalledTimes(1);
  });

  it('does not replay a request already active in a follower session', async () => {
    const get = vi.spyOn(AstridAgentSessionStore.prototype, 'get').mockResolvedValue({
      id: 'chat-3', status: 'processing', turns: [], taskLinks: [],
      control: { role: 'follower', active: true, activeRequestId: 'queued-request' },
    } as never);
    const hook = renderHook(() => useSendMessage('chat-3', { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null }, 'p'), { wrapper });
    await expect(hook.result.current.checkAcceptedRequest('queued-request')).resolves.toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('p', 'chat-3');
    hook.unmount();
  });

  it('reads choices and defaults directly from the service without browser storage', async () => {
    const catalog = { defaultAgent: 'claude-code', agents: [
      { id: 'claude-code', name: 'Claude Code', state: 'ready', line: null, models: [{ modelId: 'sonnet', name: 'Sonnet' }], defaultModel: 'sonnet' },
      { id: 'codex', name: 'Codex', state: 'sign-in', line: LOCAL_AGENT_TABLE.codex.signInLine, models: [], defaultModel: null },
    ] };
    const store = new AstridAgentSessionStore({ acp: { agents: vi.fn(async () => catalog) } } as never);
    const write = vi.spyOn(testStorage, 'setItem');
    await expect(store.agents()).resolves.toEqual(catalog);
    expect(write).not.toHaveBeenCalled();
  });

  it('routes saved sessions by their original agent while new sessions use the current default', async () => {
    const connects: Array<string | undefined> = [];
    const projectChat = { project_id: 'p', revision: 1, selected_session_id: null, main_session_id: null, sessions: [], draft: { revision: 1 } };
    const acp = {
      connect: vi.fn(async (agent?: string) => { connects.push(agent); return { connection_id: `conn-${agent ?? 'claude-code'}` }; }),
      createProjectSession: vi.fn(async (_project: string, _connection: string) => ({ ...projectChat, operation_session_id: 'claude-code:new-1', selected_session_id: 'claude-code:new-1', sessions: [{ id: 'claude-code:new-1' }] })),
      projectChat: vi.fn(async (project: string) => ({ ...projectChat, project_id: project, sessions: [{ id: 'astrid-old' }, { id: 'claude-code:new-1' }] })),
      loadSession: vi.fn(async () => ({})),
      events: vi.fn(async () => ({ disconnected: false, notifications: [] })),
      disconnect: vi.fn(async () => ({})),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.create('p', 'new', 'op-1');
    await store.get('p', 'astrid-old');
    await store.get('p', 'claude-code:new-1');
    // The service-chosen creation connection has no reported agent; saved-session loads choose explicitly.
    expect(connects).toEqual([undefined, 'claude-code', 'astrid']);
    expect(acp.disconnect).toHaveBeenCalledWith('conn-claude-code');
    expect(acp.loadSession.mock.calls.map(call => call[0])).toEqual(['conn-claude-code', 'conn-astrid']);
  });

  it('lists saved Astrid chats without connecting to an unavailable selected default', async () => {
    const connects: Array<string | undefined> = [];
    const chat = { project_id: 'p', revision: 1, selected_session_id: 'astrid-saved', main_session_id: 'astrid-saved', sessions: [{ id: 'astrid-saved' }, { id: 'new-agent:saved' }], draft: { revision: 1 } };
    const acp = {
      projectChat: vi.fn(async () => chat),
      connect: vi.fn(async (agent?: string) => {
        connects.push(agent);
        if (agent === 'codex') throw new Error('Codex adapter is unavailable');
        return { connection_id: 'conn-astrid' };
      }),
      loadSession: vi.fn(async () => ({})),
      events: vi.fn(async () => ({ disconnected: false, notifications: [] })),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await expect(store.list('p')).resolves.toEqual([{ id: 'astrid-saved', status: 'waiting_user' }]);
    expect(connects).toEqual([]);
    await store.get('p', 'astrid-saved');
    expect(connects).toEqual(['astrid']);
    expect(acp.loadSession).toHaveBeenCalledWith('conn-astrid', 'astrid-saved');
  });

  it('keeps ensure_main on the existing main session agent after the default changes', async () => {
    const connects: Array<string | undefined> = [];
    const priorChat = { project_id: 'p', revision: 1, selected_session_id: 'astrid-selected', main_session_id: 'codex:main', sessions: [{ id: 'astrid-selected' }, { id: 'codex:main' }], draft: { revision: 1 } };
    const acp = {
      projectChat: vi.fn(async () => priorChat),
      connect: vi.fn(async (agent?: string) => { connects.push(agent); return { connection_id: `conn-${agent ?? 'astrid'}` }; }),
      createProjectSession: vi.fn(async () => priorChat),
      events: vi.fn(async () => ({ disconnected: false, notifications: [] })),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.create('p', 'ensure_main', 'op-2');
    expect(connects).toEqual(['codex']);
  });

  it('uses the service Codex default for unassigned and unscoped discovery while Astrid is active', async () => {
    const acp = {
      agents: vi.fn(async () => ({ defaultAgent: 'codex', agents: [] })),
      projectChat: vi.fn(async () => ({ project_id: 'p', sessions: [{ id: 'astrid-active' }] })),
      connect: vi.fn(async (agent: string) => ({ connection_id: `connection-${agent}` })),
      loadSession: vi.fn(async () => ({ _astridSession: { role: 'writer', active: true, activeRequestId: 'astrid-turn' } })),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
      unassignedProjectSessions: vi.fn(async () => [{ id: 'codex:external', title: 'Codex external' }, { id: 'new-agent:external' }]),
      listSessions: vi.fn(async () => ({ sessions: [{ id: 'codex:external' }, { id: 'new-agent:external' }] })),
      disconnect: vi.fn(),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.get('p', 'astrid-active');
    await expect(store.unassignedProjectSessions('p')).resolves.toEqual([{ id: 'codex:external', title: 'Codex external' }]);
    await expect(store.list()).resolves.toEqual([{ id: 'codex:external', status: 'waiting_user' }]);
    expect(acp.agents).toHaveBeenCalledTimes(2);
    expect(acp.connect.mock.calls).toEqual([['astrid'], ['codex']]);
    expect(acp.unassignedProjectSessions).toHaveBeenCalledWith('p', 'connection-codex');
    expect(acp.listSessions).toHaveBeenCalledWith('connection-codex');
    await expect(store.get('p', 'astrid-active')).resolves.toMatchObject({ control: { active: true, activeRequestId: 'astrid-turn' } });
    expect(acp.loadSession.mock.calls).toEqual([['connection-astrid', 'astrid-active']]);
    expect(acp.disconnect).not.toHaveBeenCalled();
  });

  it.each(['astrid', 'claude-code', 'codex'] as const)('passes an explicit %s model only when creating a new chat', async (agent) => {
    const sessionId = agent === 'astrid' ? 'saved-astrid' : `${agent}:saved`;
    const chat = { project_id: 'p', selected_session_id: sessionId, sessions: [{ id: sessionId, model_id: 'exact/model' }] };
    const acp = {
      connect: vi.fn(async () => ({ connection_id: 'connection' })),
      createProjectSession: vi.fn(async () => ({ ...chat, operation_session_id: sessionId })),
      projectChat: vi.fn(async () => chat),
      loadSession: vi.fn(async () => ({})),
      takeOverSession: vi.fn(async () => ({ _astridSession: { role: 'writer', active: false, activeRequestId: null } })),
      promptProjectSession: vi.fn(async () => ({})),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
      sessionModels: vi.fn(async () => ({ models: { currentModelId: 'exact/model', availableModels: [{ modelId: 'exact/model', name: 'Exact' }] } })),
      setConfigOption: vi.fn(),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    const write = vi.spyOn(testStorage, 'setItem');
    await store.create('p', 'new', 'op-new', { agent, defaultModelId: 'exact/model' });
    expect(acp.connect).toHaveBeenCalledWith(agent, 'exact/model');
    await store.get('p', sessionId);
    await store.takeOver('p', sessionId);
    await expect(store.models(sessionId, 'p')).resolves.toMatchObject({ localModels: { currentModelId: 'exact/model' } });
    await store.prompt(sessionId, { message: 'hello' }, { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null });
    expect(acp.connect).toHaveBeenCalledOnce();
    expect(acp.loadSession).toHaveBeenCalledWith('connection', sessionId);
    expect(acp.takeOverSession).toHaveBeenCalledWith('connection', sessionId);
    expect(acp.promptProjectSession).toHaveBeenCalledWith('p', 'connection', sessionId, expect.any(Array), expect.any(String));
    expect(acp.setConfigOption).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('omits choices on every plain New, even with an existing connection', async () => {
    let sequence = 0;
    const acp = {
      connect: vi.fn(async () => ({ connection_id: `connection-${++sequence}` })),
      projectChat: vi.fn(async () => ({ project_id: 'p', sessions: [{ id: 'codex:existing' }] })),
      loadSession: vi.fn(async () => ({ _astridSession: { role: 'writer', active: true, activeRequestId: 'existing-turn' } })),
      createProjectSession: vi.fn(async () => ({ project_id: 'p', selected_session_id: `codex:new-${sequence}`, sessions: [{ id: `codex:new-${sequence}` }] })),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
      disconnect: vi.fn(async () => ({})),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.get('p', 'codex:existing');
    await store.create('p', 'new', 'op-1');
    await store.create('p', 'new', 'op-2');
    expect(acp.connect.mock.calls).toEqual([['codex'], [undefined, undefined], [undefined, undefined]]);
    // Attach on the scoped existing connection before releasing each creator host.
    expect(acp.disconnect.mock.calls).toEqual([['connection-2'], ['connection-3']]);
    await expect(store.get('p', 'codex:existing')).resolves.toMatchObject({ control: { active: true, activeRequestId: 'existing-turn' } });
    expect(acp.loadSession.mock.calls).toEqual([['connection-1', 'codex:existing'], ['connection-1', 'codex:new-2'], ['connection-1', 'codex:new-3']]);
    expect(acp.loadSession.mock.invocationCallOrder[1]).toBeLessThan(acp.disconnect.mock.invocationCallOrder[0]);
    expect(acp.loadSession.mock.invocationCallOrder[2]).toBeLessThan(acp.disconnect.mock.invocationCallOrder[1]);
  });

  it.each([undefined, 'codex'] as const)('retains the live creator before releasing a new %s chat', async agent => {
    const existing = 'codex:existing';
    const created = 'codex:empty';
    let sequence = 0;
    let released = false;
    let attached = false;
    let effort = 'low';
    const acp = {
      projectChat: vi.fn(async () => ({ sessions: [{ id: existing }, { id: created }] })),
      connect: vi.fn(async () => ({ connection_id: `connection-${++sequence}` })),
      createProjectSession: vi.fn(async () => ({ selected_session_id: created, sessions: [{ id: existing }, { id: created }] })),
      loadSession: vi.fn(async (_connection: string, sessionId: string) => {
        if (sessionId === created) {
          if (released) throw new Error('Empty native chat is not on disk');
          attached = true;
        }
        return {};
      }),
      disconnect: vi.fn(async () => { expect(attached).toBe(true); released = true; }),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
      sessionModels: vi.fn(async () => {
        expect(attached).toBe(true);
        return { models: { currentModelId: 'chosen', availableModels: [], thoughtLevel: { configId: 'opaque-effort', name: 'Effort', currentValue: effort, options: [{ value: 'high', name: 'High' }] } } };
      }),
      setConfigOption: vi.fn(async (_connection: string, _session: string, _config: string, value: string) => { effort = value; }),
      promptProjectSession: vi.fn(async () => { expect(attached).toBe(true); expect(effort).toBe('high'); return {}; }),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.get('p', existing);
    await store.create('p', 'new', 'new-empty', { agent, defaultModelId: 'chosen' });
    await store.configureSessionSelection(created, 'p', 'chosen', 'high');
    await store.prompt(created, { message: 'First prompt' }, { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null });
    expect(acp.loadSession).toHaveBeenCalledWith('connection-1', created);
    expect(acp.loadSession.mock.invocationCallOrder[1]).toBeLessThan(acp.disconnect.mock.invocationCallOrder[0]);
    expect(acp.createProjectSession).toHaveBeenCalledOnce();
    expect(acp.setConfigOption).toHaveBeenCalledWith('connection-1', created, 'opaque-effort', 'high');
    expect(acp.promptProjectSession).toHaveBeenCalledWith('p', 'connection-1', created, expect.any(Array), expect.any(String));
  });

  it.each(['ensure', 'ensure_main'] as const)('routes a cross-tab %s result by its original agent (pre-read: empty)', async (mode) => {
    const chosenId = 'codex:chosen-by-other-tab';
    let current = { project_id: 'p', selected_session_id: null as string | null, main_session_id: null as string | null, sessions: [] as Array<{ id: string; model_id?: string }> };
    const agents = new Map<string, string>();
    const acp = {
      projectChat: vi.fn(async () => current),
      connect: vi.fn(async (agent?: string) => {
        const connectionId = `connection-${agents.size + 1}`;
        agents.set(connectionId, agent ?? 'astrid');
        return { connection_id: connectionId };
      }),
      createProjectSession: vi.fn(async () => {
        // Another tab selects Codex after this tab's empty registry read and Astrid connect.
        current = { project_id: 'p', selected_session_id: chosenId, main_session_id: chosenId, sessions: [{ id: chosenId, model_id: 'codex/fixed' }] };
        return { ...current, operation_session_id: chosenId };
      }),
      loadSession: vi.fn(async (connectionId: string, sessionId: string) => {
        expect(agents.get(connectionId)).toBe('codex');
        expect(sessionId).toBe(chosenId);
        return {};
      }),
      sessionModels: vi.fn(async () => ({ models: { currentModelId: 'codex/fixed', availableModels: [] } })),
      events: vi.fn(async () => ({ disconnected: false, notifications: [] })),
      disconnect: vi.fn(async () => ({})),
      setConfigOption: vi.fn(),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await expect(store.create('p', mode, `cross-tab-${mode}`)).resolves.toMatchObject({ id: chosenId });
    await store.get('p', chosenId);
    await expect(store.models(chosenId, 'p')).resolves.toMatchObject({ localModels: { currentModelId: 'codex/fixed' } });
    expect(acp.connect.mock.calls).toEqual([[undefined, undefined], ['codex']]);
    expect(acp.disconnect.mock.calls).toEqual([['connection-1']]);
    expect(acp.loadSession).toHaveBeenCalledWith('connection-2', chosenId);
    expect(acp.setConfigOption).not.toHaveBeenCalled();
  });

  it.each(['ensure', 'ensure_main'] as const)('preserves active agent A when %s returns latest agent B', async (mode) => {
    const originalId = 'astrid-active';
    const chosenId = 'codex:latest-choice';
    let current = { project_id: 'p', selected_session_id: originalId, main_session_id: originalId, sessions: [{ id: originalId }] };
    const agents = new Map<string, string>();
    const acp = {
      projectChat: vi.fn(async () => current),
      connect: vi.fn(async (agent?: string) => {
        const connectionId = `connection-${agents.size + 1}`;
        agents.set(connectionId, agent ?? 'astrid');
        return { connection_id: connectionId };
      }),
      loadSession: vi.fn(async (connectionId: string, sessionId: string) => {
        expect(agents.get(connectionId)).toBe(sessionId === originalId ? 'astrid' : 'codex');
        return sessionId === originalId ? { _astridSession: { role: 'writer', active: true, activeRequestId: 'in-flight-original' } } : {};
      }),
      createProjectSession: vi.fn(async () => {
        current = { project_id: 'p', selected_session_id: chosenId, main_session_id: chosenId, sessions: [{ id: originalId }, { id: chosenId }] };
        return { ...current, operation_session_id: chosenId };
      }),
      events: vi.fn(async () => ({ disconnected: false, notifications: [] })),
      disconnect: vi.fn(async () => ({})),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.get('p', originalId);
    await expect(store.create('p', mode, `changed-selection-${mode}`)).resolves.toMatchObject({ id: chosenId });
    await store.get('p', chosenId);
    await expect(store.get('p', originalId)).resolves.toMatchObject({ control: { role: 'writer', active: true, activeRequestId: 'in-flight-original' } });
    expect(acp.connect.mock.calls).toEqual([['astrid'], ['codex']]);
    expect(acp.createProjectSession).toHaveBeenCalledWith('p', 'connection-1', mode, `changed-selection-${mode}`);
    expect(acp.loadSession.mock.calls).toEqual([['connection-1', originalId], ['connection-2', chosenId]]);
    expect(acp.disconnect).not.toHaveBeenCalled();
  });

  it('reloads the original agent after a lost New reply and a changed default on operation replay', async () => {
    const originalId = 'astrid-committed';
    let defaultAgent = 'astrid';
    let committed = false;
    const agents = new Map<string, string>();
    const current = { project_id: 'p', selected_session_id: originalId, sessions: [{ id: originalId, model_id: 'original/model' }] };
    const acp = {
      projectChat: vi.fn(async () => current),
      connect: vi.fn(async (agent?: string) => {
        const connectionId = `connection-${agents.size + 1}`;
        agents.set(connectionId, agent ?? defaultAgent);
        return { connection_id: connectionId };
      }),
      createProjectSession: vi.fn(async (_project: string, _connection: string, _mode: string, operationId: string) => {
        expect(operationId).toBe('same-operation');
        if (!committed) {
          committed = true;
          throw new Error('New reply lost after committing Astrid chat');
        }
        // Service replays the committed operation even though the retry connected to Codex.
        return { ...current, operation_session_id: originalId };
      }),
      loadSession: vi.fn(async (connectionId: string) => {
        expect(agents.get(connectionId)).toBe('astrid');
        return {};
      }),
      sessionModels: vi.fn(async () => ({ models: { currentModelId: 'original/model', availableModels: [] } })),
      events: vi.fn(async () => ({ disconnected: false, notifications: [] })),
      disconnect: vi.fn(async () => ({})),
      setConfigOption: vi.fn(),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await expect(store.create('p', 'new', 'same-operation')).rejects.toThrow('New reply lost');
    defaultAgent = 'codex';
    await expect(store.create('p', 'new', 'same-operation')).resolves.toMatchObject({ id: originalId });
    await store.get('p', originalId);
    await expect(store.models(originalId, 'p')).resolves.toMatchObject({ localModels: { currentModelId: 'original/model' } });
    expect([...agents.values()]).toEqual(['astrid', 'codex', 'astrid']);
    expect(acp.connect.mock.calls).toEqual([[undefined, undefined], [undefined, undefined], ['astrid']]);
    expect(acp.createProjectSession.mock.calls).toEqual([
      ['p', 'connection-1', 'new', 'same-operation'], ['p', 'connection-2', 'new', 'same-operation'],
    ]);
    expect(acp.disconnect.mock.calls).toEqual([['connection-1'], ['connection-2']]);
    expect(acp.loadSession).toHaveBeenCalledWith('connection-3', originalId);
    expect(acp.setConfigOption).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects model slash commands before config or prompt dispatch (attachments: %s)', async (withAttachments) => {
    const acp = {
      projectChat: vi.fn(async () => ({ sessions: [{ id: 'saved' }] })),
      connect: vi.fn(async () => ({ connection_id: 'connection' })),
      loadSession: vi.fn(async () => ({})),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
      setConfigOption: vi.fn(),
      promptProjectSession: vi.fn(),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await expect(store.prompt('saved', {
      message: '/model provider/other', ...(withAttachments ? { attachments: [{}] as never } : {}),
    }, { tool: 'video-editor', projectId: 'p', projectSlug: null, timelineId: null, timelineName: null })).rejects.toThrow('To use another model, start a new chat.');
    expect(acp.setConfigOption).not.toHaveBeenCalled();
    expect(acp.promptProjectSession).not.toHaveBeenCalled();
  });

  it('passes explicit creation choices through the mutation hook', async () => {
    const chat = { project_id: 'p', scope_key: 'p', revision: 1, selected_session_id: 'new-chat', sessions: [{ id: 'new-chat' }], draft: { text: '', revision: 0 } };
    const create = vi.spyOn(AstridAgentSessionStore.prototype, 'create').mockResolvedValue({ id: 'new-chat', projectChat: chat });
    const hook = renderHook(() => useCreateSession(null, 'p', 'new'), { wrapper });
    await act(async () => { await hook.result.current.mutateAsync({ operationId: 'op-explicit', agent: 'astrid', defaultModelId: 'provider/exact' }); });
    expect(create).toHaveBeenCalledWith('p', 'new', 'op-explicit', { agent: 'astrid', defaultModelId: 'provider/exact' });
    hook.unmount();
  });

  it('returns no model without opening a session when no chat is active', async () => {
    const connect = vi.fn();
    const store = new AstridAgentSessionStore({ acp: { connect } } as never);
    await expect(store.models()).resolves.toEqual({ providers: [], currentModel: null, localModels: null });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: 'codex:startup', configId: 'reasoning_effort', thoughtLevel: undefined },
    { sessionId: 'claude-code:startup', configId: 'effort', thoughtLevel: undefined },
    { sessionId: 'omp-startup', configId: 'thinking', thoughtLevel: undefined },
    { sessionId: 'codex:chosen', configId: 'reasoning_effort', thoughtLevel: 'low' },
  ])('validates $sessionId created model before applying its chosen or recommended effort', async ({ sessionId, configId, thoughtLevel }) => {
    const currentModelId = 'b';
    let currentValue = 'low';
    const calls: string[] = [];
    const acp = {
      projectChat: vi.fn(async () => ({ sessions: [{ id: sessionId }] })),
      connect: vi.fn(async () => ({ connection_id: 'connection' })),
      loadSession: vi.fn(async () => ({})),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
      sessionModels: vi.fn(async () => {
        calls.push('levels');
        return { models: { currentModelId, availableModels: [], thoughtLevel: { configId, name: 'Effort', currentValue,
          options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }], recommendedValue: 'high' } } };
      }),
      setConfigOption: vi.fn(async (_connection: string, _session: string, _config: string, value: string) => { calls.push('effort'); currentValue = value; }),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.configureSessionSelection(sessionId, 'project', 'b', thoughtLevel);
    expect(calls).toEqual(['levels', 'effort', 'levels']);
    await expect(store.configureSessionSelection(sessionId, 'project', 'other')).rejects.toThrow('did not confirm the selected model');
    expect(acp.setConfigOption).toHaveBeenCalledWith('connection', sessionId, configId, thoughtLevel ?? 'high');
  });

  it.each(['success', 'failure'] as const)('awaits the new chat options already being read before configuring its model and level (%s)', async outcome => {
    let finishOptions!: (value: { providers: []; currentModel: null }) => void;
    let failOptions!: (error: Error) => void;
    const options = new Promise<{ providers: []; currentModel: null }>((yes, no) => { finishOptions = yes; failOptions = no; });
    const models = vi.spyOn(AstridAgentSessionStore.prototype, 'models').mockReturnValue(options);
    const configure = vi.spyOn(AstridAgentSessionStore.prototype, 'configureSessionSelection').mockResolvedValue(undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(() => ({
      models: useAgentModels(true, 'claude-code:new', 'project'),
      // Startup still holds a callback from the previous active chat's render.
      selection: useConfigureAgentSession('project'),
    }), { wrapper: wrapperWithClient(client) });
    try {
      await waitFor(() => expect(models).toHaveBeenCalledWith('claude-code:new', 'project'));
      const selection = { sessionId: 'claude-code:new', model: 'opus', thoughtLevel: 'high' };
      let startup!: Promise<unknown>;
      await act(async () => {
        startup = hook.result.current.selection.mutateAsync(selection).catch(error => error);
      });
      expect(configure).not.toHaveBeenCalled();
      expect(models).toHaveBeenCalledOnce(); // the mutation joins the panel's query
      const failure = new Error('Options read failed');
      await act(async () => {
        if (outcome === 'success') finishOptions({ providers: [], currentModel: null });
        else failOptions(failure);
        await startup;
      });
      if (outcome === 'success') expect(configure).toHaveBeenCalledExactlyOnceWith('claude-code:new', 'project', 'opus', 'high');
      else {
        expect(await startup).toBe(failure);
        expect(configure).not.toHaveBeenCalled();
      }
    } finally { hook.unmount(); client.clear(); }
  });

  it('allows configuring an idle chat while another chat has an active prompt', async () => {
    let finishPrompt!: () => void;
    const promptWait = new Promise<void>(yes => { finishPrompt = yes; });
    const acp = {
      projectChat: vi.fn(async () => ({ sessions: [{ id: 'codex:busy' }, { id: 'codex:idle' }] })),
      connect: vi.fn(async () => ({ connection_id: 'connection' })),
      loadSession: vi.fn(async () => ({})),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
      promptProjectSession: vi.fn(async () => { await promptWait; }),
      sessionModels: vi.fn(async () => ({ models: { currentModelId: 'b', availableModels: [], thoughtLevel: { configId: 'effort', name: 'Effort', currentValue: 'high', options: [{ value: 'high', name: 'High' }] } } })),
      setConfigOption: vi.fn(async () => undefined),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    const prompt = store.prompt('codex:busy', { message: 'hello' }, { tool: 'video-editor', projectId: 'project', projectSlug: null, timelineId: null, timelineName: null });
    try {
      await vi.waitFor(() => expect(acp.promptProjectSession).toHaveBeenCalledOnce());
      await expect(store.configureSessionSelection('codex:busy', 'project', 'b')).rejects.toThrow('Wait for the active agent turn');
      await store.configureSessionSelection('codex:idle', 'project', 'b');
      expect(acp.setConfigOption).toHaveBeenCalledExactlyOnceWith('connection', 'codex:idle', 'effort', 'high');
    } finally { finishPrompt(); await prompt; }
  });

  it.each(['hermes:no-levels', 'omp-no-levels'])('does not set effort when %s has no levels', async sessionId => {
    const setConfigOption = vi.fn();
    const store = new AstridAgentSessionStore({ acp: {
      projectChat: async () => ({ sessions: [{ id: sessionId }] }), connect: async () => ({ connection_id: 'c' }),
      loadSession: async () => ({}), events: async () => ({ notifications: [], disconnected: false }),
      sessionModels: async () => ({ models: { currentModelId: 'a', availableModels: [] } }), setConfigOption,
    } } as never);
    await store.configureSessionSelection(sessionId, 'p');
    expect(setConfigOption).not.toHaveBeenCalled();
    await expect(store.configureSessionSelection(sessionId, 'p', undefined, 'high')).rejects.toThrow('no longer advertises');
  });

  it('keeps each model query scoped to its active session', async () => {
    const models = vi.spyOn(AstridAgentSessionStore.prototype, 'models').mockImplementation(async (sessionId) => ({
      providers: [], currentModel: null, localModels: { currentModelId: sessionId === 'codex:chat-a' ? 'model-a' : 'model-b', availableModels: [] },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(({ sessionId }: { sessionId: string }) => useAgentModels(true, sessionId, 'p'), {
      wrapper: wrapperWithClient(client), initialProps: { sessionId: 'codex:chat-a' },
    });
    try {
      await waitFor(() => expect(hook.result.current.data?.localModels?.currentModelId).toBe('model-a'));
      hook.rerender({ sessionId: 'codex:chat-b' });
      await waitFor(() => expect(hook.result.current.data?.localModels?.currentModelId).toBe('model-b'));
      expect(models).toHaveBeenLastCalledWith('codex:chat-b', 'p');
      expect(client.getQueryData(['agent-models', 'codex:chat-a', 'p'])).toMatchObject({ localModels: { currentModelId: 'model-a' } });
    } finally {
      hook.unmount();
      client.clear();
    }
  });

  it('refreshes a follower model catalog from live model updates', async () => {
    const sessionId = 'codex:chat-model-follower';
    const project = { project_id: 'p', scope_key: 'project:p', revision: 1, selected_session_id: sessionId, sessions: [{ id: sessionId }], draft: { text: '', revision: 1, queued_messages: [] } };
    let eventPending = true;
    const acp = {
      connect: vi.fn(async () => ({ connection_id: 'model-connection' })),
      projectChat: vi.fn(async () => project),
      loadSession: vi.fn(async () => ({ _astridSession: { role: 'follower', active: true, activeRequestId: 'remote-model-turn' } })),
      events: vi.fn(async () => ({ disconnected: false, notifications: eventPending ? (eventPending = false, [{ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'current_model_update', currentModelId: 'model-b', models: { currentModelId: 'model-b', availableModels: [{ modelId: 'model-b', name: 'Model B' }] } } } }]) : [] })),
      sessionModels: vi.fn(async () => ({ models: { currentModelId: 'model-b', availableModels: [{ modelId: 'model-b', name: 'Model B' }] } })),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    const catalogs = vi.spyOn(AstridAgentSessionStore.prototype, 'models').mockImplementation(async () => ({ providers: [], currentModel: null, localModels: { currentModelId: eventPending ? 'model-a' : 'model-b', availableModels: [] } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(agentSessionQueryKey(sessionId, 'p'), { id: sessionId, status: 'processing', turns: [], taskLinks: [], control: { role: 'follower', active: true, activeRequestId: 'remote-model-turn' } });
    const hook = renderHook(() => useAgentModels(true, sessionId, 'p'), { wrapper: wrapperWithClient(client) });
    try {
      await waitFor(() => expect(hook.result.current.data?.localModels?.currentModelId).toBe('model-a'));
      await store.get('p', sessionId);
      await waitFor(() => expect(hook.result.current.data?.localModels?.currentModelId).toBe('model-b'));
      expect(catalogs).toHaveBeenCalledTimes(2);
    } finally {
      hook.unmount();
      client.clear();
    }
  });

  it('keeps missing identifiers as input errors before contacting ACP', async () => {
    const create = renderHook(() => useCreateSession(null), { wrapper });
    await expect(act(async () => create.result.current.mutateAsync(undefined))).rejects.toThrow('Select a project or timeline to start chatting.');
    create.unmount();

    const send = renderHook(() => useSendMessage(null), { wrapper });
    await expect(act(async () => send.result.current.mutateAsync({ message: 'hello' }))).rejects.toThrow('sessionId is required');
    send.unmount();

    const cancel = renderHook(() => useCancelSession(null), { wrapper });
    await expect(act(async () => cancel.result.current.mutateAsync())).rejects.toThrow('sessionId is required');
  });

  it('stops saved-chat load polling after failure and lets an explicit retry restore the transcript', async () => {
    let loads = 0;
    let missing = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat')) return Response.json({project_id: 'saved-project', scope_key: 'project:saved-project', revision: 1, selected_session_id: 'saved-chat-retry', sessions: [{id: 'saved-chat-retry', pending_first_message: false}], draft: {text: '', revision: 1, queued_messages: []}});
      if (url.endsWith('/connect')) return Response.json({ connection_id: 'saved-chat-connection', initialize: {} });
      if (url.endsWith('/rpc')) {
        const body = JSON.parse(String(init?.body));
        expect(body.method).toBe('session/load');
        loads++;
        return missing
          ? Response.json({ error: 'acp_transport', detail: 'ACP request "session/load" failed: ACP session not found: saved-chat-retry' }, { status: 502 })
          : Response.json({ result: {} });
      }
      return Response.json({ disconnected: false, notifications: [{ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'saved-chat-retry', update: { sessionUpdate: 'agent_message_chunk', messageId: 'old-reply', content: { type: 'text', text: 'Persisted reply' } },
      } }] });
    }));
    vi.useFakeTimers();
    const hook = renderHook(() => useAgentSession('saved-chat-retry', 'saved-project'), { wrapper });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(hook.result.current.error?.message).toContain('ACP session not found');
      const eventReads = () => vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => String(input).endsWith('/events')).length;
      const baseline = eventReads();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(loads).toBe(1);
      expect(eventReads()).toBe(baseline + 2);
      missing = false;
      await act(async () => { await hook.result.current.refetch(); await vi.advanceTimersByTimeAsync(10); });
      expect(loads).toBe(2);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.data?.turns).toEqual([expect.objectContaining({ role: 'assistant', content: 'Persisted reply' })]);
    } finally {
      hook.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['claude-code', 'Resource not found'],
    ['codex', 'no rollout found for thread ID'],
  ] as const)('recovers a legacy empty %s chat after session/load proves its transcript is missing', async (agent, missingDetail) => {
    const oldId = `${agent}:empty-before-reload`;
    const freshId = `${agent}:fresh-after-reload`;
    let projectChat = { project_id: 'reload-project', scope_key: 'project:reload-project', revision: 4, selected_session_id: oldId, main_session_id: 'other-chat', sessions: [{ id: oldId, title: 'Untitled', model_id: 'model-beta' }, { id: 'other-chat', title: 'Other' }], draft: { text: '', revision: 0, queued_messages: [] } };
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith('/chat') && init?.method !== 'POST') return Response.json(projectChat);
      if (url.endsWith('/connect')) return Response.json({ connection_id: 'claude-reload', initialize: {} });
      if (url.endsWith('/rpc')) return Response.json({ error: 'acp_transport', detail: `ACP request "session/load" failed: ${missingDetail}: ${oldId}` }, { status: 502 });
      if (url.endsWith('/chat/sessions')) {
        expect(body?.recover_session_id).toBe(oldId);
        projectChat = { ...projectChat, revision: 5, selected_session_id: freshId, sessions: [{ ...projectChat.sessions[0], id: freshId, pending_first_message: true }, projectChat.sessions[1]] };
        return Response.json({ ...projectChat, operation_session_id: freshId });
      }
      if (url.endsWith('/events')) return Response.json({ disconnected: false, notifications: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(() => useAgentSession(oldId, 'reload-project'), { wrapper: wrapperWithClient(client) });
    try {
      await waitFor(() => expect(hook.result.current.data?.id).toBe(freshId));
      const recovery = calls.find(call => call.url.endsWith('/chat/sessions'));
      expect(recovery?.body).toMatchObject({ mode: 'ensure', recover_session_id: oldId });
      expect(calls.some(call => call.url.endsWith('/rpc') && call.body?.method === 'session/new')).toBe(false);
      expect(calls.filter(call => call.url.endsWith('/chat')).length).toBeGreaterThanOrEqual(1);
      expect(client.getQueryData<ProjectChatState>(projectChatQueryKey('reload-project'))).toMatchObject({
        selected_session_id: freshId,
        main_session_id: 'other-chat',
        sessions: [{ id: freshId, title: 'Untitled', model_id: 'model-beta', pending_first_message: true }, { id: 'other-chat' }],
      });
      expect(calls.find(call => call.url.endsWith('/connect'))?.body).toEqual({ agent });
    } finally {
      hook.unmount();
      client.clear();
      vi.unstubAllGlobals();
    }
  });

  it.each(['pagehide', 'beforeunload'])('releases tab ownership with keepalive on %s and reconnects on return', async (event) => {
    const release = vi.spyOn(AstridAgentSessionStore.prototype, 'closeConnectionOnPageHide');
    window.dispatchEvent(new Event(event));
    expect(release).toHaveBeenCalledTimes(1);
    const acp = {
      projectChat: vi.fn(async () => ({ sessions: [{ id: 'chat' }] })),
      connect: vi.fn().mockResolvedValueOnce({ connection_id: 'old' }).mockResolvedValue({ connection_id: 'new' }),
      loadSession: vi.fn(async () => ({})),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    await store.get('project', 'chat');
    store.closeConnectionOnPageHide();
    store.closeConnectionOnPageHide();
    expect(acp.disconnect).toHaveBeenCalledExactlyOnceWith('old', { keepalive: true });
    await store.get('project', 'chat');
    expect(acp.connect).toHaveBeenCalledTimes(2);
    expect(acp.loadSession).toHaveBeenLastCalledWith('new', 'chat');
  });

  it('renews the heartbeat in a background tab and observes automatic writer promotion', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let role: 'writer' | 'follower' = 'follower';
    const get = vi.spyOn(AstridAgentSessionStore.prototype, 'get').mockImplementation(async (_projectId, id) => ({
      id, status: 'waiting_user', turns: [], taskLinks: [], control: { role, active: false, activeRequestId: null },
    }));
    const hook = renderHook(() => useAgentSession('background-chat', 'project'), { wrapper: wrapperWithClient(client) });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(hook.result.current.data?.control?.role).toBe('follower');
      const baseline = get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(baseline + 4);
      role = 'writer';
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(hook.result.current.data?.control?.role).toBe('writer');
    } finally {
      hook.unmount();
      client.clear();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it('polls an idle session slowly and an active turn at the streaming cadence', async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const get = vi.spyOn(AstridAgentSessionStore.prototype, 'get').mockImplementation(async (_projectId, sessionId) => ({
      id: sessionId, status: sessionId === 'active-session' ? 'processing' : 'waiting_user', turns: [], taskLinks: [],
    } as never));
    client.setQueryData(['timeline-agent-session', 'idle-session', 'project-1'], {
      id: 'idle-session', status: 'waiting_user', turns: [], taskLinks: [],
    });
    const idle = renderHook(() => useAgentSession('idle-session', 'project-1'), { wrapper: wrapperWithClient(client) });
    try {
      await act(async () => { await Promise.resolve(); });
      const idleBaseline = get.mock.calls.length;
      expect(idleBaseline).toBeGreaterThan(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
      expect(get).toHaveBeenCalledTimes(idleBaseline);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(get).toHaveBeenCalledTimes(idleBaseline + 1);
      idle.unmount();

      client.setQueryData(['timeline-agent-session', 'active-session', 'project-1'], {
        id: 'active-session', status: 'processing', turns: [], taskLinks: [],
      });
      const active = renderHook(() => useAgentSession('active-session', 'project-1'), { wrapper: wrapperWithClient(client) });
      await act(async () => { await Promise.resolve(); });
      const activeBaseline = get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(499); });
      expect(get).toHaveBeenCalledTimes(activeBaseline);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(get).toHaveBeenCalledTimes(activeBaseline + 1);
      active.unmount();
    } finally {
      idle.unmount();
      client.clear();
      vi.useRealTimers();
    }
  });

  it('polls project chat at the idle or active turn cadence', async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const projectChat = vi.spyOn(AstridAgentSessionStore.prototype, 'projectChat').mockImplementation(async (projectId) => ({
      project_id: projectId,
      revision: 1,
      draft: { revision: 1 },
    } as never));
    try {
      const idle = renderHook(() => useProjectChat('project-1'), { wrapper: wrapperWithClient(client) });
      await act(async () => { await Promise.resolve(); });
      const idleBaseline = projectChat.mock.calls.length;
      expect(idleBaseline).toBeGreaterThan(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
      expect(projectChat).toHaveBeenCalledTimes(idleBaseline);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(projectChat).toHaveBeenCalledTimes(idleBaseline + 1);
      idle.unmount();

      client.setQueryData(['timeline-agent-session', 'active-session', 'project-1'], {
        id: 'active-session', status: 'processing', turns: [], taskLinks: [],
      });
      const active = renderHook(() => useProjectChat('project-1'), { wrapper: wrapperWithClient(client) });
      await act(async () => { await Promise.resolve(); });
      const activeBaseline = projectChat.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(499); });
      expect(projectChat).toHaveBeenCalledTimes(activeBaseline);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(projectChat).toHaveBeenCalledTimes(activeBaseline + 1);
      active.unmount();
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });

  it('switches an idle session to fast polling as soon as a message is sent', async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sessionKey = ['timeline-agent-session', 'send-session', 'project-1'] as const;
    let turnActive = false;
    const get = vi.spyOn(AstridAgentSessionStore.prototype, 'get').mockImplementation(async (_projectId, sessionId) => ({
      id: sessionId, status: turnActive ? 'processing' : 'waiting_user', turns: [], taskLinks: [],
    } as never));
    let finishPrompt!: () => void;
    const prompt = vi.spyOn(AstridAgentSessionStore.prototype, 'prompt').mockImplementation(async () => {
      turnActive = true;
      await new Promise<void>(resolve => { finishPrompt = resolve; });
    });
    client.setQueryData(sessionKey, { id: 'send-session', status: 'waiting_user', turns: [], taskLinks: [] });
    const hook = renderHook(() => ({
      session: useAgentSession('send-session', 'project-1'),
      send: useSendMessage('send-session', { tool: 'video-editor', projectId: 'project-1', projectSlug: null, timelineId: null, timelineName: null }, 'project-1'),
    }), { wrapper: wrapperWithClient(client) });
    try {
      await act(async () => { await Promise.resolve(); });
      const baseline = get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(get).toHaveBeenCalledTimes(baseline);
      let sending!: Promise<unknown>;
      act(() => { sending = hook.result.current.send.mutateAsync({ message: 'hello' }); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(prompt).toHaveBeenCalled();
      expect(client.getQueryData(sessionKey)).toMatchObject({ status: 'processing' });
      const afterSend = get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(get).toHaveBeenCalledTimes(afterSend + 1);
      await act(async () => { finishPrompt(); await sending; });
    } finally {
      hook.unmount();
      client.clear();
      vi.useRealTimers();
    }
  });

  it('restores project chat reads and writes through the existing ACP routes', async () => {
    const chat = {
      project_id: 'project-1',
      scope_key: 'project:project-1',
      revision: 4,
      selected_session_id: 'session-1',
      sessions: [{ id: 'session-1' }],
      draft: { text: 'draft', revision: 2, queued_messages: [] },
    };
    const acp = {
      projectChat: vi.fn(async () => chat),
      saveProjectDraft: vi.fn(async () => chat),
      selectProjectSession: vi.fn(async () => chat),
      renameProjectSession: vi.fn(async () => chat),
    };
    const store = new AstridAgentSessionStore({ acp } as never);

    await expect(store.projectChat('project-1')).resolves.toBe(chat);
    await expect(store.saveProjectDraft('project-1', 2, 'new draft', [])).resolves.toBe(chat);
    await expect(store.selectProjectSession('project-1', 4, null)).resolves.toBe(chat);
    await expect(store.renameProjectSession('project-1', 5, 'session-1', 'Renamed')).resolves.toBe(chat);
    expect(acp.projectChat).toHaveBeenCalledWith('project-1');
    expect(acp.saveProjectDraft).toHaveBeenCalledWith('project-1', 2, 'new draft', []);
    expect(acp.selectProjectSession).toHaveBeenCalledWith('project-1', 4, null);
    expect(acp.renameProjectSession).toHaveBeenCalledWith('project-1', 5, 'session-1', 'Renamed');
  });

  it('keeps chat association order stable when selected and Main pointers change', async () => {
    const chat = { selected_session_id: 'second', main_session_id: 'second', sessions: [{ id: 'first' }, { id: 'second' }] };
    const acp = {
      projectChat: vi.fn(async () => chat),
      connect: vi.fn(async () => ({ connection_id: 'connection' })),
      events: vi.fn(async () => ({ notifications: [], disconnected: false })),
    };
    const store = new AstridAgentSessionStore({ acp } as never);
    expect((await store.list('project')).map(s => s.id)).toEqual(['first', 'second']);
    chat.selected_session_id = 'first';
    expect((await store.list('project')).map(s => s.id)).toEqual(['first', 'second']);
  });

  it('assigns Main through the existing revisioned project chat cache', async () => {
    const chat = {project_id: 'project-1', revision: 5, main_session_id: 'chosen', selected_session_id: 'chosen'} as ProjectChatState;
    const assign = vi.spyOn(AstridAgentSessionStore.prototype, 'setMainProjectSession').mockResolvedValue(chat);
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    const {result, unmount} = renderHook(() => useSetMainProjectSession('project-1'), {wrapper: wrapperWithClient(client)});
    await act(async () => result.current.mutateAsync({expectedRevision: 4, sessionId: 'chosen'}));
    expect(assign).toHaveBeenCalledWith('project-1', 4, 'chosen');
    expect(client.getQueryData(projectChatQueryKey('project-1'))).toEqual(chat);
    unmount();
    client.clear();
  });

  it('renames a project session and refreshes the scoped chat cache, while preserving errors', async () => {
    const chat = {project_id: 'project-1', revision: 6, sessions: [{id: 'session-2', title: 'Renamed'}]} as ProjectChatState;
    const rename = vi.spyOn(AstridAgentSessionStore.prototype, 'renameProjectSession').mockResolvedValue(chat);
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    const {result, unmount} = renderHook(() => useRenameProjectSession('project-1'), {wrapper: wrapperWithClient(client)});
    await act(async () => result.current.mutateAsync({expectedRevision: 5, sessionId: 'session-2', title: 'Renamed'}));
    expect(rename).toHaveBeenCalledWith('project-1', 5, 'session-2', 'Renamed');
    expect(client.getQueryData(projectChatQueryKey('project-1'))).toBe(chat);

    const conflict = new BridgeRouteError('Rename project chat session', 409, {error: 'revision_conflict'});
    rename.mockRejectedValueOnce(conflict);
    await expect(act(async () => result.current.mutateAsync({expectedRevision: 4, sessionId: 'session-2', title: 'Stale'}))).rejects.toBe(conflict);
    expect(client.getQueryData(projectChatQueryKey('project-1'))).toBe(chat);
    unmount();
    client.clear();
  });

  it('loads project chat through the query hook and uses the project-scoped cache key', async () => {
    const chat = {project_id: 'project-1', revision: 4} as ProjectChatState;
    const projectChat = vi.spyOn(AstridAgentSessionStore.prototype, 'projectChat').mockResolvedValue(chat);
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    const {result, unmount} = renderHook(() => useProjectChat('project-1'), {wrapper: wrapperWithClient(client)});

    await waitFor(() => expect(result.current.data).toBe(chat));
    expect(projectChat).toHaveBeenCalledWith('project-1');
    expect(client.getQueryData(projectChatQueryKey('project-1'))).toBe(chat);
    unmount();
    client.clear();
  });

  it('saves project drafts through the mutation hook and refreshes the scoped chat cache', async () => {
    const chat = {project_id: 'project-1', revision: 5} as ProjectChatState;
    const saveProjectDraft = vi.spyOn(AstridAgentSessionStore.prototype, 'saveProjectDraft').mockResolvedValue(chat);
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    const {result, unmount} = renderHook(() => useSaveProjectDraft('project-1'), {wrapper: wrapperWithClient(client)});

    await act(async () => result.current.mutateAsync({expectedRevision: 4, text: 'draft update', queuedMessages: []}));
    expect(saveProjectDraft).toHaveBeenCalledWith('project-1', 4, 'draft update', []);
    expect(client.getQueryData(projectChatQueryKey('project-1'))).toBe(chat);
    unmount();
    client.clear();
  });

  it('selects a project session through the mutation hook and refreshes the scoped chat cache', async () => {
    const chat = {project_id: 'project-1', revision: 5} as ProjectChatState;
    const selectProjectSession = vi.spyOn(AstridAgentSessionStore.prototype, 'selectProjectSession').mockResolvedValue(chat);
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    const {result, unmount} = renderHook(() => useSelectProjectSession('project-1'), {wrapper: wrapperWithClient(client)});

    await act(async () => result.current.mutateAsync({expectedRevision: 4, sessionId: 'session-2'}));
    expect(selectProjectSession).toHaveBeenCalledWith('project-1', 4, 'session-2');
    expect(client.getQueryData(projectChatQueryKey('project-1'))).toBe(chat);
    unmount();
    client.clear();
  });

  it('preserves ACP message boundaries when adjacent replies arrive', () => {
    const turns = [] as Parameters<typeof appendAcpTextTurn>[0];
    appendAcpTextTurn(turns, 'user', 'first', '2026-09-18T15:00:00.000Z', 'user-1');
    appendAcpTextTurn(turns, 'assistant', 'one', '2026-09-18T15:00:01.000Z', 'assistant-1');
    appendAcpTextTurn(turns, 'assistant', ' plus', '2026-09-18T15:00:01.100Z', 'assistant-1');
    appendAcpTextTurn(turns, 'user', 'second', '2026-09-18T15:00:02.000Z', 'user-2');
    appendAcpTextTurn(turns, 'assistant', 'two', '2026-09-18T15:00:03.000Z', 'assistant-2');

    expect(turns.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one plus' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'two' },
    ]);
  });

  it('keeps streamed assistant narration transient and starts a new final candidate at a new message boundary', () => {
    const preamble = appendAcpAssistantDraft(undefined, 'Checking the timeline…', 'assistant-1');
    expect(appendAcpAssistantDraft(preamble, ' reading the compact summary', 'assistant-1')).toEqual({
      content: 'Checking the timeline… reading the compact summary',
      messageId: 'assistant-1',
    });

    expect(appendAcpAssistantDraft(preamble, 'Done — moved the clip.', 'assistant-2')).toEqual({
      content: 'Done — moved the clip.',
      messageId: 'assistant-2',
    });
  });

  it('hides the model-only editor context from the rendered transcript', () => {
    expect(stripAstridEditorContext('make the first clip start later\n\n<astrid_editor_context>\n{}\n</astrid_editor_context>'))
      .toBe('make the first clip start later');
    expect(stripAstridEditorContext('<astrid_editor_context>\n{}\n</astrid_editor_context>')).toBe('');
    expect(stripAstridEditorContext('hello\n<astrid_agent_context>private</astrid_agent_context>')).toBe('hello');
    expect(stripAstridEditorContext('hello\n<astrid_agent_context>private</astrid_agent_context>\n<astrid_editor_context>{}</astrid_editor_context>')).toBe('hello');
    expect(stripAstridEditorContext('make the first clip start later\n\nAstrid editor context:\nTimeline ID: timeline-1'))
      .toBe('make the first clip start later');
  });
});


describe('explicit third-argument project routing', () => {
  const context = (projectId: string, timelineId: string | null = null) => ({
    tool: 'video-editor' as const, projectId, projectSlug: `${projectId}-slug`, timelineId, timelineName: timelineId,
  });

  it('keeps a failed request on its captured route/context and rejects a later project even if the session ID is unchanged', async () => {
    vi.resetModules();
    const { useSendMessage: scopedSend } = await import('./useAgentSession.ts');
    const prompts: Array<{ url: string; body: { session_id: string; prompt: Array<{ text: string }> } }> = [];
    let fail = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat')) return Response.json({project_id: url.includes('route-a') ? 'route-a' : 'route-b', scope_key: 'project:route', revision: 1, selected_session_id: 'same-session', sessions: [{id: 'same-session'}], draft: {text: '', revision: 1, queued_messages: []}});
      if (url.endsWith('/connect')) return Response.json({ connection_id: 'route-connection', initialize: {} });
      if (url.endsWith('/rpc')) {
        expect(JSON.parse(String(init?.body)).method).toBe('session/load');
        return Response.json({ result: {} });
      }
      if (url.endsWith('/chat/prompt')) {
        prompts.push({ url, body: JSON.parse(String(init?.body)) });
        return fail ? Response.json({ error: 'acp_transport', detail: 'reply lost' }, { status: 502 }) : Response.json({ result: {} });
      }
      return Response.json({ disconnected: false, notifications: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const hook = renderHook(({ scope, route }) => scopedSend('same-session', scope, route), {
      wrapper, initialProps: { scope: context('route-a', 'timeline-original'), route: 'route-a' },
    });
    try {
      await expect(act(async () => { await hook.result.current.mutateAsync({ message: 'captured message' }); })).rejects.toThrow('reply lost');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].url).toContain('/projects/route-a/chat/prompt');
      expect(prompts[0].body.session_id).toBe('same-session');
      const captured = prompts[0].body.prompt[1].text;
      expect(captured).toContain('timeline-original');
      // Changing the route and scope while keeping the same opaque session must
      // not dispatch the old payload to the new project.
      hook.rerender({ scope: context('route-b', 'timeline-new'), route: 'route-b' });
      const callsBeforeRetry = fetchMock.mock.calls.length;
      await expect(act(async () => { await hook.result.current.retryLastMessage(); })).rejects.toThrow('original project');
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRetry);
      expect(prompts).toHaveLength(1);
      // Returning to the original project permits retry while retaining the
      // original captured timeline, even though the current timeline changed.
      fail = false;
      hook.rerender({ scope: context('route-a', 'timeline-current'), route: 'route-a' });
      await act(async () => { await hook.result.current.retryLastMessage(); });
      expect(prompts).toHaveLength(2);
      expect(prompts[1].url).toBe(prompts[0].url);
      expect(prompts[1].body.session_id).toBe('same-session');
      expect(prompts[1].body.prompt[0].text).toBe('captured message');
      expect(prompts[1].body.prompt[1].text).toContain('timeline-original');
      expect(prompts[1].body.prompt[1].text).not.toContain('timeline-current');
      expect(hook.result.current.hasRetryableMessage).toBe(false);
    } finally {
      hook.unmount(); vi.unstubAllGlobals(); vi.resetModules();
    }
  });

  it('rejects a mixed project route/context before any ACP dispatch', async () => {
    vi.resetModules();
    const { useSendMessage: scopedSend } = await import('./useAgentSession.ts');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const hook = renderHook(() => scopedSend('mixed-session', context('context-a'), 'route-b'), { wrapper });
    try {
      await expect(act(async () => { await hook.result.current.mutateAsync({ message: 'never forward' }); })).rejects.toThrow('routing project does not match');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      hook.unmount(); vi.unstubAllGlobals(); vi.resetModules();
    }
  });
});


describe('scoped project membership and independent revision receipts', () => {
  it('refuses a missing or foreign project session before connection, load or prompt', async () => {
    const acp = {
      projectChat: vi.fn(async () => ({sessions: [{id: 'missing-session', missing: true}]})),
      connect: vi.fn(), loadSession: vi.fn(), promptProjectSession: vi.fn(),
    };
    const store = new AstridAgentSessionStore({acp} as never);
    await expect(store.get('project-a', 'foreign-session')).rejects.toThrow('does not belong');
    await expect(store.prompt('missing-session', {message: 'never dispatch'}, {
      tool: 'video-editor', projectId: 'project-a', projectSlug: null, timelineId: null, timelineName: null,
    })).rejects.toThrow('does not belong');
    expect(acp.connect).not.toHaveBeenCalled();
    expect(acp.loadSession).not.toHaveBeenCalled();
    expect(acp.promptProjectSession).not.toHaveBeenCalled();
  });

  it('keeps a late draft receipt in its captured project and preserves a newer session selection', async () => {
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    const newer = {project_id: 'old-project', revision: 8, selected_session_id: 'new-selection', sessions: [],
      draft: {revision: 2, text: 'previous', queued_messages: []}} as ProjectChatState;
    client.setQueryData(projectChatQueryKey('old-project'), newer);
    let resolve!: (value: ProjectChatState) => void;
    vi.spyOn(AstridAgentSessionStore.prototype, 'saveProjectDraft').mockImplementation(() => new Promise(done => { resolve = done; }));
    const hook = renderHook(({project}) => useSaveProjectDraft(project), {wrapper: wrapperWithClient(client), initialProps: {project: 'old-project'}});
    let pending!: Promise<ProjectChatState>;
    act(() => { pending = hook.result.current.mutateAsync({expectedRevision: 2, text: 'captured draft', queuedMessages: []}); });
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    hook.rerender({project: 'new-project'});
    await act(async () => {
      resolve({...newer, revision: 7, selected_session_id: 'obsolete-selection', draft: {revision: 3, text: 'captured draft', queued_messages: []}});
      await pending;
    });
    expect(client.getQueryData(projectChatQueryKey('old-project'))).toMatchObject({revision: 8, selected_session_id: 'new-selection', draft: {revision: 3, text: 'captured draft'}});
    expect(client.getQueryData(projectChatQueryKey('new-project'))).toBeUndefined();
    hook.unmount(); client.clear();
  });
});
