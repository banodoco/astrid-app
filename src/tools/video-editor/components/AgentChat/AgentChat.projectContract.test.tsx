// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, getConfig, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatEditorContext } from '@/shared/contexts/AgentChatContext';
import type { LocalAgentChoice } from '@/integrations/astrid/localAgents';
import type { ProjectChatState } from '@/integrations/astrid/acpRoutes';

// Waits here are hang ceilings, not timing assertions: on an oversubscribed
// machine the default 1000 ms asyncUtilTimeout expires while real transport
// work is still progressing. Scoped to this file and restored afterwards.
const HANG_CEILING_MS = 10_000;
const defaultAsyncUtilTimeout = getConfig().asyncUtilTimeout;
beforeAll(() => { configure({ asyncUtilTimeout: HANG_CEILING_MS }); });
afterAll(() => { configure({ asyncUtilTimeout: defaultAsyncUtilTimeout }); });

// The editor is the host boundary. Chat, its hooks, ACP routes, transport,
// presentation, attachment selection and query cache are all real.
const host = vi.hoisted(() => ({ context: null as AgentChatEditorContext | null,
  actions: { registerHandlers: vi.fn(), publishState: vi.fn(), unregister: vi.fn() } }));
vi.mock('@/shared/contexts/AgentChatContext', () => ({
  useAgentChatBridge: () => ({ editorContext: host.context, timelineId: host.context?.timelineId }),
  useAgentChatActionsRegistry: () => host.actions,
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function context(projectId: string): AgentChatEditorContext {
  return { tool: 'video-editor', projectId, projectSlug: `slug-${projectId}`,
    timelineId: `timeline-${projectId}`, timelineName: `Timeline ${projectId}`,
    timelineSummary: { configVersion: 7, trackCount: 2, clipCount: 3, assetCount: 1, duration: 12 } };
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
class HostTransport {
  readonly calls: Array<{ route: string; body: Record<string, any> }> = [];
  readonly chats = new Map<string, ProjectChatState>();
  readonly transcripts = new Map<string, Array<{ role: 'user' | 'assistant'; text: string; messageId?: string }>>();
  readonly events: unknown[] = [];
  agents: LocalAgentChoice[] = ['astrid', 'codex'].map(id => ({ id: id as 'astrid' | 'codex', name: id === 'astrid' ? 'Astrid' : 'Codex', state: 'ready', line: null, models: [{ modelId: 'openai/model-a', name: 'Model A' }, { modelId: 'openai/model-b', name: 'Model B' }], defaultModel: 'openai/model-a' }));
  modelReadFailure: { error: string; detail: string; next_action?: string } | null = null;
  promptSetupFailure: { error: string; detail: string; next_action?: string } | null = null;
  connectFailure: Error | null = null;
  loadFailure: Error | null = null;
  promptFailure: Error | null = null;
  acceptedResponseFailure: Error | null = null;
  disconnected = false;
  expiredConnection: string | null = null;
  private connections = 0;
  private readonly connectionAgents = new Map<string, string>();
  private readonly connectionModels = new Map<string, string>();
  onPrompt: (() => Promise<void>) | null = null;
  onCreate: (() => Promise<void>) | null = null;
  onLoad: (() => Promise<void>) | null = null;
  onDraft: (() => Promise<void>) | null = null;
  draftFailure: number | null = null;
  assistant = 'Done.';
  private sequence = 0;
  chat(project: string) {
    if (!this.chats.has(project)) this.chats.set(project, { project_id: project, scope_key: `realm:${project}`,
      revision: 0, selected_session_id: null, main_session_id: null, sessions: [], draft: { text: '', revision: 0, queued_messages: [] } });
    return this.chats.get(project)!;
  }
  seed(project: string, id = `session-${project}`) {
    const chat = this.chat(project);
    chat.sessions.push({ id }); chat.selected_session_id = id;
    this.transcripts.set(id, []);
    return id;
  }
  event(id: string, role: 'user' | 'assistant', text: string, index: number, messageId?: string) {
    this.events.push({ params: { sessionId: id, update: { sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
      messageId: messageId ?? `${id}-${role}-${index}`, content: { type: 'text', text } } } });
  }
  fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).replace('/api/astrid', '');
    const body = JSON.parse(String(init?.body ?? '{}'));
    this.calls.push({ route, body });
    if (route === '/acp/models') return response({ providers: [], currentModel: null });
    if (route === '/acp/agents') return response({ defaultAgent: 'astrid', agents: this.agents });
    if (route.includes('/models?sessionId=')) {
      // These are deterministic model-endpoint outcomes, not a transient bridge outage; avoid
      // exercising the transport's retry ladder so the warm-up recovery assertions observe the
      // setup/generic UI branch directly.
      if (this.modelReadFailure) return response(this.modelReadFailure, 400);
      const session = [...this.chats.values()].flatMap(chat => chat.sessions).find(session => session.id === decodeURIComponent(route.split('sessionId=')[1]));
      const model = session?.model_id ?? 'openai/model-a';
      return response({ models: { currentModelId: model, availableModels: [{ modelId: model, name: model.endsWith('model-b') ? 'Model B' : 'Model A' }] } });
    }
    if (init?.method === 'DELETE') return response({ connection_id: route.split('/').at(-1), closed: true });
    if (route === '/acp/connect') {
      if (this.connectFailure) throw this.connectFailure;
      const id = `connection-${++this.connections}`;
      this.connectionAgents.set(id, body.agent ?? 'astrid');
      this.connectionModels.set(id, body.defaultModelId ?? 'openai/model-a');
      return response({ connection_id: id, initialize: {} });
    }
    if (this.expiredConnection && route.startsWith(`/acp/${this.expiredConnection}/`)) {
      return response({ error: 'not_found', detail: 'ACP connection is not available; reconnect' }, 404);
    }
    if (route.endsWith('/events')) {
      const disconnected = this.disconnected; this.disconnected = false;
      return response({ notifications: this.events.splice(0), disconnected });
    }
    if (route.endsWith('/cancel')) return response({ cancelled: true, session_id: body.sessionId });
    if (route.endsWith('/rpc')) {
      // The project panel may load a transcript, but must never create, list or
      // prompt through the global compatibility RPC.
      expect(body.method).toBe('session/load');
      if (this.onLoad) await this.onLoad();
      if (this.loadFailure) throw this.loadFailure;
      for (const [index, turn] of (this.transcripts.get(body.params.sessionId) ?? []).entries()) {
        this.event(body.params.sessionId, turn.role, turn.text, index, turn.messageId);
      }
      return response({ result: {} });
    }
    const match = route.match(/^\/acp\/projects\/([^/]+)\/chat(?:\/(\w+))?$/);
    if (!match) throw new Error(`Unexpected transport route: ${route}`);
    const [, project, action] = match;
    const chat = this.chat(project);
    if (action === 'sessions') {
      if (this.onCreate) await this.onCreate();
      expect(body.operation_id).toEqual(expect.any(String));
      expect(body.operation_id.length).toBeGreaterThan(0);
      if (body.mode === 'new' || !chat.selected_session_id) {
        const prefix = this.connectionAgents.get(body.connection_id) === 'codex' ? 'codex:' : '';
        const id = `${prefix}session-${project}-${++this.sequence}`;
        this.seed(project, id); chat.sessions.find(session => session.id === id)!.model_id = this.connectionModels.get(body.connection_id); chat.revision++;
        if (body.mode === 'new') chat.main_session_id = id;
      }
      return response({ ...chat, operation_session_id: chat.selected_session_id });
    }
    if (action === 'draft') {
      if (this.onDraft) await this.onDraft();
      if (this.draftFailure) return response({ error: 'internal_error', detail: 'Disk is full' }, this.draftFailure);
      if (body.expected_revision !== chat.draft.revision) return response({ error: 'draft_conflict', detail: 'Draft changed' }, 409);
      chat.draft = { text: body.text, revision: chat.draft.revision + 1, queued_messages: body.queued_messages };
      return response(chat);
    }
    if (action === 'prompt') {
      if (this.promptSetupFailure) return response(this.promptSetupFailure, 502);
      if (!chat.sessions.some(s => s.id === body.session_id)) return response({ error: 'session_not_owned', detail: 'Unowned session' }, 403);
      const assistantReply = this.assistant;
      if (this.onPrompt) await this.onPrompt();
      if (this.promptFailure) throw this.promptFailure;
      const transcript = this.transcripts.get(body.session_id)!;
      transcript.push({ role: 'user', text: body.prompt.map((block: { text: string }) => block.text).join('\n\n') }, { role: 'assistant', text: assistantReply });
      // ACP commonly does not echo the live user turn. Replay happens on load.
      this.event(body.session_id, 'assistant', assistantReply, transcript.length);
      if (this.acceptedResponseFailure) throw this.acceptedResponseFailure;
      return response({ result: { stopReason: 'end_turn' } });
    }
    if (!action && init?.method === 'PATCH') {
      if (body.expected_revision !== chat.revision) return response({ error: 'chat_conflict', detail: 'Chat changed' }, 409);
      const session = chat.sessions.find(s => s.id === body.session_id);
      if (!session) return response({ error: 'session_not_owned', detail: 'Unowned session' }, 403);
      session.title = body.title.trim(); chat.revision++;
    }
    return response(chat);
  };
}
let fixture: HostTransport;
let clients: QueryClient[] = [];
let RealPanel: typeof import('./AgentChat')['AgentChatPanel'];
let RuntimeProvider: typeof import('@/integrations/runtime/RuntimeConnectionProvider.tsx')['RuntimeConnectionProvider'];
// The chat reads the runtime connection context: mount the real provider (ungated) around the real panel.
function Panel() {
  return <RuntimeProvider gated={false}><RealPanel /></RuntimeProvider>;
}
async function freshModules() {
  vi.resetModules();
  RealPanel = (await import('./AgentChat')).AgentChatPanel;
  RuntimeProvider = (await import('@/integrations/runtime/RuntimeConnectionProvider.tsx')).RuntimeConnectionProvider;
  const { usePanesStoreApi } = await import('@/shared/state/panesStore');
  usePanesStoreApi().setState({ isTasksPaneLocked: true });
}
function mount(strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const panel = <QueryClientProvider client={client}><Panel /></QueryClientProvider>;
  return render(strict ? <React.StrictMode>{panel}</React.StrictMode> : panel);
}
async function send(text: string) {
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByTitle('Send'));
}
beforeEach(async () => {
  fixture = new HostTransport();
  host.context = context('p1');
  vi.stubGlobal('fetch', fixture.fetch);
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  Element.prototype.scrollIntoView ??= vi.fn();
  await freshModules();
});
afterEach(async () => {
  cleanup();
  await act(async () => { await Promise.resolve(); });
  for (const client of clients) client.clear();
  clients = [];
  vi.unstubAllGlobals();
});

describe('real panel → real hooks → owned ACP transport', () => {
  it('keeps the chooser open after Back during a slow start and ignores the late created session', async () => {
    fixture.agents[0] = { ...fixture.agents[0], state: 'sign-in', signIn: 'signed-out' };
    const pending = deferred();
    fixture.onCreate = () => pending.promise;
    mount();
    await screen.findByRole('listbox', { name: 'How do you want Astrid to think?' });
    fireEvent.click(screen.getByRole('option', { name: /Use Codex/ }));
    await screen.findByText('Getting Codex ready…');
    await screen.findByRole('button', { name: 'Back' }, { timeout: 20_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await act(async () => { pending.resolve(); });
    await waitFor(() => expect(fixture.chat('p1').sessions).toHaveLength(1));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.queryByText('✓ Codex is set up.')).toBeNull();
    expect(fixture.calls.filter(call => call.route.endsWith('/sessions'))).toHaveLength(1);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
  it('shows setup instead of auto-creating with an unready default, then finishes and focuses the composer', async () => {
    fixture.agents[0] = { ...fixture.agents[0], state: 'sign-in', signIn: 'signed-out', line: 'Run `astrid`, then `/login`.' };
    fixture.agents[1].signIn = 'signed-in';
    mount();
    await screen.findByRole('listbox', { name: 'How do you want Astrid to think?' });
    expect(fixture.calls.filter(call => call.route.endsWith('/sessions'))).toHaveLength(0);
    expect(screen.getByRole('textbox')).toBeDisabled();
    fireEvent.click(screen.getByRole('option', { name: /Use Codex/ }));
    await screen.findByText('✓ Codex is set up.');
    expect(screen.getByText('Send your first message.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(fixture.calls.filter(call => call.route.endsWith('/sessions'))).toHaveLength(1);
    await send('First message after setup');
    await screen.findByText('Done.');
    expect(screen.queryByRole('listbox', { name: 'How do you want Astrid to think?' })).toBeNull();
  });

  it.each([undefined, 'signed-in'] as const)('keeps auto-create for a ready default (signIn: %s)', async signIn => {
    fixture.agents[0].signIn = signIn;
    mount();
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    expect(fixture.calls.filter(call => call.route.endsWith('/sessions'))).toHaveLength(1);
    expect(screen.queryByRole('listbox', { name: 'How do you want Astrid to think?' })).toBeNull();
  });

  it('locks a broken active agent and opens its setup instructions', async () => {
    fixture.seed('p1');
    mount();
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    fixture.agents[0] = { ...fixture.agents[0], state: 'sign-in', signIn: 'signed-out', line: 'Run `astrid`, then `/login`.' };
    await act(async () => { await clients[0].invalidateQueries({ queryKey: ['local-agents'] }); });
    await waitFor(() => expect(screen.getByRole('textbox')).toBeDisabled());
    expect(screen.getByText('/login')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy command' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Set up', exact: true }));
    // The card uses the dedicated, session-free model query for Astrid.
    await waitFor(() => expect(fixture.calls.some(call => call.route === '/acp/models')).toBe(true));
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('routes prompt setup errors to the card, preserving the failed message for retry', async () => {
    fixture.seed('p1');
    fixture.promptSetupFailure = { error: 'agent_not_installed', detail: 'Agent is missing', next_action: 'install-agent' };
    mount();
    await send('Keep this message');
    expect(await screen.findByText('install-agent')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.queryByText(/Astrid bridge .* failed/)).toBeNull();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(fixture.chat('p1').draft.queued_messages).toEqual([expect.objectContaining({ text: 'Keep this message' })]);
  });

  it('resumes a broken agent in its existing chat and explicitly retries its retained message', async () => {
    fixture.seed('p1', 'codex:session-p1');
    fixture.promptSetupFailure = { error: 'agent_sign_in_required', detail: 'Sign-in expired', next_action: 'codex login' };
    mount();
    await send('Retry after sign-in');
    expect(await screen.findByText('codex login')).toBeVisible();
    fixture.promptSetupFailure = null;
    fixture.agents[1] = { ...fixture.agents[1], signIn: 'signed-in' };
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await screen.findByText('✓ Codex is set up.');
    expect(fixture.calls.filter(call => call.route.endsWith('/sessions'))).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await screen.findByText('Done.');
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(2);
  });

  it.each(['generic', 'setup'] as const)('recovers a %s warm-up failure without creating another session', async kind => {
    fixture.agents[0] = { ...fixture.agents[0], state: 'sign-in', signIn: 'signed-out' };
    fixture.agents[1].signIn = 'signed-in';
    fixture.modelReadFailure = kind === 'setup'
      ? { error: 'agent_sign_in_required', detail: 'Sign-in expired', next_action: 'codex login' }
      : { error: 'acp_bridge_error', detail: 'Adapter exited' };
    mount();
    await screen.findByRole('listbox', { name: 'How do you want Astrid to think?' });
    fireEvent.click(screen.getByRole('option', { name: /Use Codex/ }));
    if (kind === 'setup') {
      await screen.findByText('codex login');
      expect(screen.getByText('Waiting for you to sign in…')).toBeInTheDocument();
    } else {
      await screen.findByRole('button', { name: 'Try again' });
      expect(screen.getByRole('alert')).toHaveTextContent('Adapter exited');
    }
    expect(fixture.calls.filter(call => call.route.endsWith('/sessions'))).toHaveLength(1);
    fixture.modelReadFailure = null;
    if (kind === 'setup') {
      fixture.agents[1] = { ...fixture.agents[1], steps: [] };
      await act(async () => { window.dispatchEvent(new Event('focus')); });
    } else fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('✓ Codex is set up.');
    expect(fixture.calls.filter(call => call.route.endsWith('/sessions'))).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
  });

  it.each(['main', 'agent', 'model'] as const)('New (%s) opens the created Main chat and reopens it after remount', async (choice) => {
    const firstId = fixture.seed('p1');
    fixture.chat('p1').main_session_id = firstId;
    const view = mount();
    const selector = await screen.findByRole('button', { name: /^Chat: / });
    await waitFor(() => expect(selector).toHaveTextContent('Chat 1'));
    fireEvent.click(screen.getByRole('button', { name: /^Chat: / }));
    if (choice === 'main') {
      fireEvent.click(await screen.findByRole('option', { name: /^Astrid/ }));
    } else {
      if (choice === 'agent') {
        fireEvent.click(await screen.findByRole('button', { name: 'Choose a Codex model' }));
        fireEvent.click(await screen.findByRole('option', { name: /Model A/ }));
      }
      else {
        fireEvent.click(await screen.findByRole('button', { name: 'Choose a Astrid model' }));
        fireEvent.click(await screen.findByRole('option', { name: /Model B/ }));
      }
    }
    await waitFor(() => expect(fixture.chat('p1').selected_session_id).not.toBe(firstId));
    const newId = fixture.chat('p1').selected_session_id;
    expect(fixture.chat('p1').main_session_id).toBe(newId);
    if (choice === 'agent') expect(newId).toMatch(/^codex:/);
    await waitFor(() => expect(selector).toHaveTextContent('Chat 2'));
    await waitFor(() => expect(fixture.calls.some(c => c.body.params?.sessionId === newId)).toBe(true));
    if (choice === 'model') expect(fixture.calls).toContainEqual({ route: '/acp/connect', body: { agent: 'astrid', defaultModelId: 'openai/model-b' } });
    expect(fixture.calls.some(call => /\/model$/.test(call.route))).toBe(false);
    expect(fixture.calls.some(call => call.route === '/acp/model')).toBe(false);
    expect(fixture.calls.some(c => c.route.endsWith('/chat/main'))).toBe(false);
    view.unmount();
    await freshModules();
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Chat: / })).toHaveTextContent('Chat 2'));
    fireEvent.click(screen.getByRole('button', { name: /^Chat: / }));
    expect(await screen.findByRole('option', { name: /^Chat 2/ })).toHaveTextContent('Main');
    expect(fixture.calls.filter(c => c.route.endsWith('/sessions'))).toHaveLength(1);
  });

  it('renames the current chat through the existing PATCH route and restores the title after remount', async () => {
    const id = fixture.seed('p1');
    fixture.chat('p1').main_session_id = id;
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Chat: / }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Chat 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat name' }), { target: { value: '  Launch plan  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Chat: / })).toHaveTextContent('Launch plan'));
    expect(fixture.calls).toContainEqual({ route: '/acp/projects/p1/chat', body: { expected_revision: 0, session_id: id, title: 'Launch plan' } });
    view.unmount();
    await freshModules();
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Chat: / })).toHaveTextContent('Launch plan'));
  });

  it('recovers a restarted bridge while keeping restored messages paused and the draft intact', async () => {
    const id = fixture.seed('p1');
    fixture.chat('p1').draft = { text: 'Keep my draft', revision: 4, queued_messages: [
      { id: 'not-confirmed', text: 'hi', session_id: id, attachments: [] },
    ] };
    // The first transcript request encounters a connection from before restart.
    fixture.expiredConnection = 'connection-1';
    mount();
    await screen.findByText(/Delivery not confirmed/);
    await waitFor(() => expect(fixture.calls.filter(call => call.route === '/acp/connect')).toHaveLength(2));
    expect(fixture.calls.some(call => call.route === '/acp/connection-2/rpc')).toBe(true);
    expect(screen.getByRole('textbox')).toHaveValue('Keep my draft');
    expect(fixture.chat('p1').draft.queued_messages.map(row => row.id)).toEqual(['not-confirmed']);
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(0);
  });

  function receipt(id: string, project = 'p1') {
    return '<astrid_editor_context>' + JSON.stringify({ schema: 'astrid.editor-context/v1', request_id: id,
      context_revision: 'snapshot', captured_at: '2026-10-15T12:00:00Z', project: { id: project }, editor: { tool: 'video-editor' } }) + '</astrid_editor_context>';
  }
  it('reconciles only exact durable IDs assembled across replay chunks, preserving draft and pausing other queued messages', async () => {
    const id = fixture.seed('p1');
    fixture.chat('p1').draft = { text: 'Keep my draft', revision: 4, queued_messages: [
      { id: 'accepted-id', text: 'Same words', session_id: id, attachments: [] },
      { id: 'failed-id', text: 'Same words', session_id: id, attachments: [] },
    ] };
    const raw = receipt('accepted-id');
    fixture.transcripts.set(id, [{ role: 'user', text: 'Same words', messageId: 'durable-user' },
      { role: 'user', text: raw.slice(0, 40), messageId: 'durable-user' },
      { role: 'user', text: raw.slice(40), messageId: 'durable-user' },
      { role: 'assistant', text: 'Answered.' }]);
    mount();
    await screen.findByText('Answered.');
    await waitFor(() => expect(fixture.chat('p1').draft.queued_messages.map(row => row.id)).toEqual(['failed-id']));
    expect(screen.getByRole('textbox')).toHaveValue('Keep my draft');
    expect(screen.getByText(/Delivery not confirmed/)).toBeInTheDocument();
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(0);
    expect(screen.queryByText(/astrid.editor-context/)).not.toBeInTheDocument();
  });
  it('recovers accepted delivery after a lost response and fresh module reload without resending', async () => {
    fixture.seed('p1');
    fixture.acceptedResponseFailure = new Error('Response lost after acceptance');
    // Keep replay unavailable until the reload; the separate durable-disconnect test covers immediate reconciliation.
    fixture.onPrompt = async () => { fixture.loadFailure = new Error('Replay unavailable until reload'); };
    const first = mount();
    await send('Accepted before connection failed');
    await screen.findByRole('button', { name: 'Send now' });
    await waitFor(() => expect(fixture.chat('p1').draft.queued_messages).toHaveLength(1));
    const savedId = fixture.chat('p1').draft.queued_messages[0].id;
    const prompt = fixture.calls.find(call => call.route.endsWith('/prompt'))!;
    const captured = JSON.parse(prompt.body.prompt[1].text.replace('<astrid_editor_context>', '').replace('</astrid_editor_context>', ''));
    expect(captured.request_id).toBe(savedId);
    first.unmount();
    await freshModules();
    fixture.acceptedResponseFailure = null;
    fixture.loadFailure = null;
    fixture.onPrompt = null;
    mount();
    await waitFor(() => expect(fixture.chat('p1').draft.queued_messages).toEqual([]));
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
  });
  it('checks fresh saved replay before a manual retry and never redispatches an acknowledged ID', async () => {
    const id = fixture.seed('p1');
    fixture.chat('p1').draft = { text: 'Retained', revision: 4, queued_messages: [
      { id: 'accepted-later', text: 'Already sent', session_id: id, attachments: [] },
    ] };
    mount();
    const retry = await screen.findByRole('button', { name: 'Send now' });
    await waitFor(() => expect(retry).toBeEnabled());
    fixture.transcripts.set(id, [{ role: 'user', text: 'Already sent' + receipt('accepted-later') }, { role: 'assistant', text: 'Durable answer' }]);
    fireEvent.click(retry);
    await waitFor(() => expect(fixture.chat('p1').draft.queued_messages).toEqual([]));
    expect(screen.getByRole('textbox')).toHaveValue('Retained');
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(0);
  });
  describe('saved queue rows that were not sent', () => {
    function seedRestoredRow() {
      const id = fixture.seed('p1');
      fixture.chat('p1').draft = { text: '', revision: 4, queued_messages: [
        { id: 'restored-row', text: 'Restored instruction', session_id: id, attachments: [] },
      ] };
      return id;
    }
    it('reads as Not sent with a Send now action and never sends by itself', async () => {
      seedRestoredRow();
      mount();
      expect(await screen.findByText('Restored instruction')).toBeInTheDocument();
      expect(screen.getByText(/Not sent/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send now' })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
      expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(0);
    });
    it('Send now sends the row and clears it', async () => {
      seedRestoredRow();
      mount();
      const button = await screen.findByRole('button', { name: 'Send now' });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await screen.findByText('Done.');
      await waitFor(() => expect(fixture.chat('p1').draft.queued_messages).toEqual([]));
      expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
    });
    it('does not call the composer a queue, and a new message sends instead of queueing behind the row', async () => {
      seedRestoredRow();
      mount();
      await screen.findByRole('button', { name: 'Send now' });
      const box = await screen.findByRole('textbox');
      await waitFor(() => expect(box).not.toBeDisabled());
      expect(box.getAttribute('placeholder')).not.toMatch(/queue/i);
      await send('Fresh message');
      await screen.findByText('Done.');
      expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(1);
      expect(screen.getByText('Restored instruction')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send now' })).toBeInTheDocument();
    });
    it('says plainly that a queued message could not be saved, with Retry and no either/or choice', async () => {
      seedRestoredRow();
      mount();
      await screen.findByRole('button', { name: 'Send now' });
      await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
      fixture.draftFailure = 500;
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edit that cannot save' } });
      expect(await screen.findByText(/A queued message could not be saved to Astrid \(Disk is full\)/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /overwrite|Load saved/ })).not.toBeInTheDocument();
      fixture.draftFailure = null;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('edit that cannot save'));
      await waitFor(() => expect(screen.queryByText(/could not be saved/)).not.toBeInTheDocument());
    });
    it('never interrupts for a draft that could not be saved when nothing is queued', async () => {
      fixture.seed('p1');
      mount();
      await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
      fixture.draftFailure = 500;
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved words' } });
      await waitFor(() => expect(fixture.calls.some(call => call.route.endsWith('/draft'))).toBe(true));
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveValue('unsaved words');
    });
  });
  it('rebases silently onto a newer draft revision when accepted delivery is recovered over a divergent local draft', async () => {
    const id = fixture.seed('p1');
    fixture.chat('p1').draft = { text: 'Original', revision: 4, queued_messages: [
      { id: 'accepted-conflict', text: 'Accepted', session_id: id, attachments: [] },
    ] };
    const gate = deferred(); fixture.onLoad = () => gate.promise;
    fixture.transcripts.set(id, [{ role: 'user', text: 'Accepted' + receipt('accepted-conflict') }]);
    mount();
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Original'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My local draft' } });
    fixture.chat('p1').draft = { ...fixture.chat('p1').draft, text: 'Other client draft', revision: 5 };
    await act(async () => gate.resolve());
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('My local draft'));
    expect(screen.getByRole('textbox')).toHaveValue('My local draft');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
    expect(fixture.chat('p1').draft.queued_messages).toEqual([]);
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toHaveLength(0);
  });

  it('keeps ordinary intentionally queued live messages draining in order after successful turns', async () => {
    fixture.seed('p1');
    const gate = deferred(); let prompts = 0;
    fixture.onPrompt = async () => { if (++prompts === 1) await gate.promise; };
    mount();
    await send('First live message');
    await waitFor(() => expect(prompts).toBe(1));
    await send('Second live message');
    await act(async () => gate.resolve());
    await waitFor(() => expect(prompts).toBe(2));
    await waitFor(() => expect(fixture.chat('p1').draft.queued_messages).toEqual([]));
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt')).map(call => call.body.prompt[0].text))
      .toEqual(['First live message', 'Second live message']);
  });
  it('does not save unchanged drafts or paused queues when two panels mount and unmount', async () => {
    const sessionId = fixture.seed('p1');
    fixture.chat('p1').draft = { text: 'Saved composer', revision: 4, queued_messages: [
      { id: 'saved-q', text: 'Paused queue', session_id: sessionId, attachments: [{ clipId: 'saved-clip' }] },
    ] };
    const original = structuredClone(fixture.chat('p1').draft);
    const first = mount();
    const second = mount();
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2));
    await waitFor(() => screen.getAllByRole('textbox').forEach(input => expect(input).toHaveValue('Saved composer')));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    first.unmount(); second.unmount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fixture.calls.filter(call => call.route.endsWith('/draft'))).toEqual([]);
    expect(fixture.chat('p1').draft).toEqual(original);
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toEqual([]);
  });

  it('keeps local text over a divergent saved draft when reopened, rebasing silently and keeping the other client queue', async () => {
    fixture.seed('p1');
    fixture.chat('p1').draft = { text: 'Original draft', revision: 4, queued_messages: [] };
    const first = mount();
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Original draft'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My unsaved edit' } });
    const otherSaved = { text: 'Other client edit', revision: 5, queued_messages: [
      { id: 'other-q', text: 'Other queued message', session_id: 'session-p1', attachments: [{ clipId: 'other-asset' }] },
    ] };
    fixture.chat('p1').draft = structuredClone(otherSaved);
    first.unmount();
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('My unsaved edit'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    mount();
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('My unsaved edit'));
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('My unsaved edit'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fixture.chat('p1').draft.queued_messages.map(row => row.id)).toEqual(['other-q']);
    expect(fixture.calls.filter(call => call.route.endsWith('/draft')).map(call => call.body.expected_revision)).toContain(5);
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toEqual([]);
  });

  it('sends ensure/new operation ids, exact text and captured context/attachments through project routes; reopens durable history in a fresh store', async () => {
    const view = mount();
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    const ensure = fixture.calls.find(c => c.route.endsWith('/sessions'))!;
    expect(ensure).toMatchObject({ route: '/acp/projects/p1/chat/sessions', body: { mode: 'ensure', connection_id: 'connection-1' } });
    fireEvent.click(screen.getByRole('button', { name: /^Chat: / }));
    fireEvent.click(await screen.findByRole('option', { name: /^Astrid/ }));
    await waitFor(() => expect(fixture.calls.filter(c => c.route.endsWith('/sessions'))).toHaveLength(2));
    await waitFor(() => expect(fixture.calls.some(c => c.body.params?.sessionId === fixture.chat('p1').selected_session_id)).toBe(true));
    expect(fixture.calls.filter(c => c.route.endsWith('/sessions'))[1].body).toMatchObject({ mode: 'new', operation_id: expect.any(String) });
    const { setTimelineClipData, editorReplaceTimelineSelection } = await import('@/shared/state/selectionStore');
    act(() => {
      setTimelineClipData([{ clipId: 'clip-1', assetKey: 'asset-1', url: 'https://example.test/image.png', mediaType: 'image', isTimelineBacked: true, trackId: 'track', at: 2, duration: 3 }]);
      editorReplaceTimelineSelection(['clip-1']);
    });
    await send('Change only the cube color to teal.');
    await screen.findByText('Done.');
    await waitFor(() => expect(screen.queryByText('Thinking...')).not.toBeInTheDocument());
    const prompt = fixture.calls.filter(c => c.route.endsWith('/prompt'));
    expect(prompt).toHaveLength(1);
    expect(prompt[0]).toMatchObject({ route: '/acp/projects/p1/chat/prompt', body: {
      connection_id: 'connection-2', session_id: fixture.chat('p1').selected_session_id,
      prompt: [{ type: 'text', text: 'Change only the cube color to teal.' }, { type: 'text', text: expect.any(String) }],
    } });
    const captured = JSON.parse(prompt[0].body.prompt[1].text.replace('<astrid_editor_context>', '').replace('</astrid_editor_context>', ''));
    expect(captured).toMatchObject({ project: { id: 'p1' }, timeline: { id: 'timeline-p1', summary: { config_version: 7 } },
      selection: { clip_ids: ['clip-1'], assets: [{ clip_id: 'clip-1', track_id: 'track', at: 2, duration: 3 }] } });
    expect(fixture.calls.findIndex(c => c.route.endsWith('/draft'))).toBeLessThan(fixture.calls.findIndex(c => c.route.endsWith('/prompt')));
    await waitFor(() => expect(fixture.chat('p1').draft.queued_messages).toEqual([]));
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    await freshModules(); // new tab-local store, fresh connection and query cache
    mount();
    await screen.findByText('Change only the cube color to teal.');
    await screen.findByText('Done.');
    // The first (ensure) chat has no agent choice; the two New chats pick the Astrid row, which names its agent.
    // Each temporary host is released, and the saved chat reconnects to its original agent after reload.
    expect(fixture.calls.filter(c => c.route === '/acp/connect').map(c => c.body)).toEqual([{}, { agent: 'astrid' }, { agent: 'astrid' }, { agent: 'astrid' }]);
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))).toHaveLength(1);
    expect(fixture.chat('p1').sessions).toHaveLength(2);
  });

  it('can submit after development StrictMode replays mount effects', async () => {
    fixture.seed('p1');
    mount(true);
    await send('StrictMode scene instruction');
    await screen.findByText('Done.');
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))).toHaveLength(1);
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  it.each(['rejection', 'timeout'] as const)('settles terminal %s with visible recovery and persisted user text', async failure => {
    fixture.seed('p1');
    mount();
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    if (failure === 'rejection') fixture.promptFailure = new Error('Prompt rejected');
    if (failure === 'timeout') fixture.promptFailure = new DOMException('Deadline elapsed', 'TimeoutError');
    await send(`Retain ${failure} text`);
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.queryByText('Thinking...')).not.toBeInTheDocument());
    expect(fixture.chat('p1').draft.queued_messages).toEqual([expect.objectContaining({ text: `Retain ${failure} text` })]);
    expect(screen.getByRole('button', { name: 'Send now' })).toBeInTheDocument();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))).toHaveLength(1);
  });

  // The host accepts the prompt and then drops the connection. A failed send now
  // refetches the session at once (perf(agent-chat): 70fecd3a), so the durable
  // acceptance is seen immediately: the text is delivered and shown in the
  // transcript, the saved queue row is retired, and nothing offers a re-send.
  it('settles a disconnect after durable acceptance with visible recovery and no duplicate send', async () => {
    fixture.seed('p1');
    mount();
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    fixture.onPrompt = async () => { fixture.disconnected = true; };
    await send('Retain disconnect text');
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.queryByText('Thinking...')).not.toBeInTheDocument());
    await screen.findByText('Retain disconnect text');
    await waitFor(() => expect(fixture.chat('p1').draft.queued_messages).toEqual([]));
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
    const prompts = fixture.calls.filter(c => c.route.endsWith('/prompt'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0].body.prompt[0]).toMatchObject({ type: 'text', text: 'Retain disconnect text' });
  });

  it('shows recoverable initialization failure without automatically issuing another creation operation', async () => {
    fixture.connectFailure = new Error('Initialize failed');
    fixture.chat('p1').draft.text = 'Keep initialization text';
    mount();
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox')).toHaveValue('Keep initialization text');
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
    expect(fixture.calls.filter(c => c.route === '/acp/connect')).toHaveLength(1);
    fixture.connectFailure = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    expect(fixture.calls.filter(c => c.route.endsWith('/sessions'))).toHaveLength(1);
  });

  it('preserves a saved draft when transcript load fails, then recovers through Retry', async () => {
    fixture.seed('p1'); fixture.chat('p1').draft.text = 'Unsent scene edit';
    fixture.loadFailure = new Error('Load failed');
    mount();
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox')).toHaveValue('Unsent scene edit');
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    fixture.loadFailure = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved chat', exact: true }));
    await send('Recovered edit');
    await screen.findByText('Done.');
  });

  it('does not send after old-project preflight completes in a newly selected project', async () => {
    fixture.seed('p1'); fixture.seed('p2');
    const view = mount();
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    // Delay ownership lookup at the submission boundary, after normal hydration.
    const originalFetch = fixture.fetch;
    const gate = deferred();
    let blocked = false;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!blocked && url.endsWith('/projects/p1/chat') && (!init?.method || init.method === 'GET')) {
        blocked = true; await gate.promise;
      }
      return originalFetch(url, init);
    });
    await send('Old project instruction');
    await waitFor(() => expect(blocked).toBe(true));
    host.context = context('p2');
    view.rerender(<QueryClientProvider client={clients[0]}><Panel /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    await act(async () => { gate.resolve(); });
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))).toHaveLength(0);
    expect(screen.queryByText('Old project instruction')).not.toBeInTheDocument();
    expect(fixture.chat('p1').draft.queued_messages).toEqual([expect.objectContaining({ text: 'Old project instruction' })]);
    await send('New project instruction');
    await screen.findByText('Done.');
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))[0].route).toBe('/acp/projects/p2/chat/prompt');
  });

  it('ignores a delayed old-project operation response instead of publishing through either host adapter', async () => {
    fixture.seed('p1'); fixture.seed('p2');
    const oldAdapter = { execute: vi.fn() };
    const newAdapter = { execute: vi.fn() };
    host.context = { ...context('p1'), elementOperationAdapter: oldAdapter as never };
    const gate = deferred(); fixture.onPrompt = () => gate.promise;
    fixture.assistant = '<astrid_element_operation>{"name":"elements.list"}</astrid_element_operation>';
    const view = mount();
    await send('Old operation');
    await waitFor(() => expect(fixture.calls.some(c => c.route.endsWith('/prompt'))).toBe(true));
    host.context = { ...context('p2'), elementOperationAdapter: newAdapter as never };
    view.rerender(<QueryClientProvider client={clients[0]}><Panel /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    await act(async () => { gate.resolve(); });
    expect(oldAdapter.execute).not.toHaveBeenCalled();
    expect(newAdapter.execute).not.toHaveBeenCalled();
    expect(screen.queryByText('Old operation')).not.toBeInTheDocument();
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  it('keeps New selected when an older draft reply arrives late', async () => {
    fixture.seed('p1');
    const view = mount();
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    const gate = deferred(); let delayed = false;
    const originalFetch = fixture.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const reply = await originalFetch(url, init);
      if (!delayed && url.endsWith('/draft')) { delayed = true; await gate.promise; }
      return reply;
    });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft for the new conversation' } });
    await waitFor(() => expect(delayed).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /^Chat: / }));
    fireEvent.click(await screen.findByRole('option', { name: /^Astrid/ }));
    await waitFor(() => expect(fixture.chat('p1').selected_session_id).not.toBe('session-p1'));
    const newId = fixture.chat('p1').selected_session_id;
    await waitFor(() => expect(fixture.calls.some(c => c.body.params?.sessionId === newId)).toBe(true));
    await act(async () => { gate.resolve(); });
    await send('Use the new session');
    await screen.findByText('Done.');
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ session_id: newId }) }),
    ]);
    view.unmount();
  });

  it('retires a pending operation when New changes sessions within the same project', async () => {
    fixture.seed('p1');
    const execute = vi.fn();
    host.context = { ...context('p1'), elementOperationAdapter: { execute } as never };
    const gate = deferred(); fixture.onPrompt = () => gate.promise;
    fixture.assistant = '<astrid_element_operation>{"name":"elements.list"}</astrid_element_operation>';
    mount();
    await send('Old session operation');
    await waitFor(() => expect(fixture.calls.some(c => c.route.endsWith('/prompt'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /^Chat: / }));
    fireEvent.click(await screen.findByRole('option', { name: /^Astrid/ }));
    await waitFor(() => expect(fixture.chat('p1').selected_session_id).not.toBe('session-p1'));
    const newId = fixture.chat('p1').selected_session_id;
    await waitFor(() => expect(fixture.calls.some(c => c.body.params?.sessionId === newId)).toBe(true));
    await waitFor(() => expect(screen.queryByText('Thinking...')).not.toBeInTheDocument());
    fixture.onPrompt = null; fixture.assistant = 'New session completed.';
    await send('New session instruction');
    await screen.findByText('New session completed.');
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))).toHaveLength(2);
    await act(async () => { gate.resolve(); });
    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  it('retains failed submission text after a fresh store reload and pauses it until explicit retry', async () => {
    fixture.seed('p1'); fixture.promptFailure = new Error('Lost reply');
    const view = mount();
    await send('Recover this unsent instruction');
    await screen.findByRole('alert');
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    fixture.promptFailure = null;
    await freshModules();
    mount();
    await screen.findByRole('button', { name: 'Send now' });
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    expect(screen.getByText('Recover this unsent instruction')).toBeInTheDocument();
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await screen.findByText('Done.');
    expect(fixture.calls.filter(c => c.route.endsWith('/prompt'))).toHaveLength(2);
  });

  it('rejects an unowned session before load or prompt execution', async () => {
    fixture.seed('p1');
    const { AstridAgentSessionStore } = await import('../../hooks/useAgentSession');
    const store = new AstridAgentSessionStore();
    await expect(store.prompt('session-foreign', { message: 'Do not execute' }, context('p1'))).rejects.toThrow('does not belong');
    expect(fixture.calls.filter(c => c.route.endsWith('/rpc') || c.route.endsWith('/prompt') || c.route === '/acp/connect')).toEqual([]);
  });
  it('retries the captured editor scope with a fresh turn after the same project selects another timeline', async () => {
    fixture.seed('p1'); fixture.promptFailure = new Error('Lost reply');
    const view = mount();
    await send('Keep the captured timeline instruction');
    await screen.findByRole('alert');
    const original = fixture.calls.find(call => call.route.endsWith('/prompt'))!.body.prompt;
    host.context = { ...context('p1'), timelineId: 'timeline-p1-new', timelineName: 'New timeline' };
    view.rerender(<QueryClientProvider client={clients[0]}><Panel /></QueryClientProvider>);
    fixture.promptFailure = null;
    fireEvent.click(await screen.findByRole('button', { name: 'Send now' }));
    await screen.findByText('Done.');
    const prompts = fixture.calls.filter(call => call.route.endsWith('/prompt'));
    expect(prompts).toHaveLength(2);
    expect(prompts[1].body.prompt[0]).toEqual(original[0]);
    const snapshot = (blocks: Array<{ text: string }>) => JSON.parse(blocks[1].text.split('<astrid_editor_context>\n')[1].split('\n</astrid_editor_context>')[0]);
    const captured = snapshot(original);
    const retried = snapshot(prompts[1].body.prompt);
    // Delivery retains its logical identity; host admission uses a separate fresh turn.
    expect(retried.request_id).toBe(captured.request_id);
    expect(retried).toEqual({ ...captured, request_id: retried.request_id, captured_at: retried.captured_at });
    expect(prompts[1].route).toBe('/acp/projects/p1/chat/prompt');
  });

});

describe('project chat draft sync across clients', () => {
  const key = ['project-agent-chat', 'p1'];
  const alerts = () => screen.queryAllByRole('alert');
  const boxes = () => screen.getAllByRole('textbox') as HTMLTextAreaElement[];
  const refetchAll = async () => { for (const client of clients) await client.refetchQueries({ queryKey: key }); };
  async function twoClients() {
    fixture.seed('p1');
    fixture.chat('p1').draft = { text: 'Original', revision: 4, queued_messages: [] };
    mount(); mount();
    await waitFor(() => expect(boxes().map(box => box.value)).toEqual(['Original', 'Original']));
    await waitFor(() => expect(boxes().every(box => !box.disabled)).toBe(true));
  }
  const drafts = () => fixture.calls.filter(call => call.route.endsWith('/draft'));

  it('lets the text in front of the user win when two clients type: no prompt, no banner', async () => {
    await twoClients();
    fireEvent.change(boxes()[0], { target: { value: 'typed in A' } });
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('typed in A'));
    // B still holds its old base (revision 4) and types: the Runtime refuses revision 4, the App rebases silently.
    fireEvent.change(boxes()[1], { target: { value: 'typed in B' } });
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('typed in B'));
    expect(boxes()[1]).toHaveValue('typed in B');
    expect(alerts()).toEqual([]);
    expect(screen.queryByText(/another client/i)).not.toBeInTheDocument();
  });

  it('adopts another client draft only when this composer is idle, and ignores it while focused or edited', async () => {
    await twoClients();
    fireEvent.change(boxes()[0], { target: { value: 'from A' } });
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('from A'));
    // B is focused: ignored.
    act(() => boxes()[1].focus());
    await act(async () => { await clients[1].refetchQueries({ queryKey: key }); });
    expect(boxes()[1]).toHaveValue('Original');
    // B blurred and unedited: adopted.
    act(() => boxes()[1].blur());
    await act(async () => { await clients[1].refetchQueries({ queryKey: key }); });
    await waitFor(() => expect(boxes()[1]).toHaveValue('from A'));
    // Now A edits again while B has local edits (unsaved, save refused): B keeps its text.
    fixture.draftFailure = 500;
    fireEvent.change(boxes()[1], { target: { value: 'B local edit' } });
    await waitFor(() => expect(drafts().length).toBeGreaterThan(1));
    fixture.chat('p1').draft = { text: 'A again', revision: fixture.chat('p1').draft.revision + 1, queued_messages: [] };
    await act(async () => { await clients[1].refetchQueries({ queryKey: key }); });
    expect(boxes()[1]).toHaveValue('B local edit');
    expect(alerts()).toEqual([]);
  });

  it('keeps a cleared draft empty against a stale echo, and the empty value is really saved', async () => {
    fixture.seed('p1');
    fixture.chat('p1').draft = { text: 'Old content', revision: 4, queued_messages: [] };
    mount();
    await waitFor(() => expect(boxes()[0]).toHaveValue('Old content'));
    fireEvent.change(boxes()[0], { target: { value: '' } });
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe(''));
    const clearedRevision = fixture.chat('p1').draft.revision;
    // A slow read that started before the clear lands now, carrying the old text and an older revision.
    await act(async () => { clients[0].setQueryData(key, { ...structuredClone(fixture.chat('p1')), draft: { text: 'Old content', revision: clearedRevision - 1, queued_messages: [] } }); });
    await act(async () => { await Promise.resolve(); });
    expect(boxes()[0]).toHaveValue('');
    // Even a newer echo of the old text from elsewhere is not adopted while the composer is focused.
    act(() => boxes()[0].focus());
    await act(async () => { clients[0].setQueryData(key, { ...structuredClone(fixture.chat('p1')), draft: { text: 'Old content', revision: clearedRevision + 1, queued_messages: [] } }); });
    expect(boxes()[0]).toHaveValue('');
    expect(fixture.chat('p1').draft.text).toBe('');
  });

  it('keeps the latest text when debounced saves are slow and land out of order', async () => {
    fixture.seed('p1');
    mount();
    await waitFor(() => expect(boxes()[0]).not.toBeDisabled());
    const gate = deferred(); let first = true;
    fixture.onDraft = async () => { if (first) { first = false; await gate.promise; } };
    fireEvent.change(boxes()[0], { target: { value: 'one' } });
    await waitFor(() => expect(drafts()).toHaveLength(1));
    fireEvent.change(boxes()[0], { target: { value: 'one two' } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(drafts()).toHaveLength(1);
    await act(async () => gate.resolve());
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('one two'));
    expect(boxes()[0]).toHaveValue('one two');
    expect(drafts().map(call => call.body.text)).toEqual(['one', 'one two']);
    expect(alerts()).toEqual([]);
  });

  it('merges queued messages by id when clients conflict, losing none and not resurrecting removed rows', async () => {
    const id = fixture.seed('p1');
    fixture.chat('p1').draft = { text: '', revision: 4, queued_messages: [
      { id: 'mine', text: 'Mine', session_id: id, attachments: [] },
      { id: 'gone', text: 'Sent elsewhere', session_id: id, attachments: [] },
    ] };
    mount();
    await screen.findByText('Mine');
    await waitFor(() => expect(boxes()[0]).not.toBeDisabled());
    // Another client adds a row and sends 'gone'.
    fixture.chat('p1').draft = { text: '', revision: 5, queued_messages: [
      { id: 'mine', text: 'Mine', session_id: id, attachments: [] },
      { id: 'theirs', text: 'Theirs', session_id: id, attachments: [] },
    ] };
    fireEvent.change(boxes()[0], { target: { value: 'typing now' } });
    await waitFor(() => expect(fixture.chat('p1').draft.text).toBe('typing now'));
    expect(fixture.chat('p1').draft.queued_messages.map(row => row.id)).toEqual(['mine', 'theirs']);
    expect(await screen.findByText('Theirs')).toBeInTheDocument();
    expect(screen.queryByText('Sent elsewhere')).not.toBeInTheDocument();
    expect(alerts()).toEqual([]);
    expect(fixture.calls.filter(call => call.route.endsWith('/prompt'))).toEqual([]);
  });
});
