/** In-memory ACP routes. Setup scenarios are opt-in; ordinary editor fixtures keep their canned reads. */
export type AcpReply = { status: number; body: unknown; delayMs?: number };

type Draft = { text: string; revision: number; queued_messages: unknown[] };
type ChatSession = { id: string; title: string };
type Chat = { revision: number; sessions: ChatSession[]; selected: string | null; operations: Map<string, string> };

export type FakeAcp = {
  /** `null` when the request is not an ACP path at all (the caller falls through to the other fakes). */
  handle(method: string, pathname: string, body: unknown): AcpReply | null;
  reset(): void;
};

const CONNECTION_ID = 'local-test-connection';
const emptyDraft = (): Draft => ({ text: '', revision: 0, queued_messages: [] });

const emptyChat = (): Chat => ({ revision: 0, sessions: [], selected: null, operations: new Map() });

export function createFakeAcp(projectSelectors: readonly string[], initialScenario = process.env.ASTRID_FAKE_AGENT_SCENARIO ?? ''): FakeAcp {
  let scenario = initialScenario;
  let ready = false;
  let signedIn = false;
  let connectedAgent = 'astrid';
  let currentModel: string | null = null;
  let createError: string | null = scenario === 'F' ? 'agent_runtime_missing' : null;
  let promptAttempts = 0;
  let notifications: unknown[] = [];
  const prompts = new Map<string, string>();
  const catalog = () => ({
    defaultAgent: 'astrid',
    agents: [
      { id: 'astrid', name: 'Astrid', state: signedIn || !scenario ? 'ready' : 'sign-in', signIn: signedIn || !scenario ? 'signed-in' : 'signed-out', line: 'Run `astrid`, then enter `/login`.', steps: [{ kind: 'sign-in', command: 'astrid', label: 'Copy Astrid command' }, { kind: 'sign-in', command: '/login', label: 'Copy login command' }], creditLine: 'Built on oh-my-pi', creditUrl: 'https://github.com/can1357/oh-my-pi', terminal: { command: 'astrid', skillSynced: true }, models: [], defaultModel: currentModel },
      ...[
        { id: 'claude-code', name: 'Claude Code', command: 'claude', install: 'curl -fsSL https://claude.ai/install.sh | bash', login: 'claude auth login', installed: scenario === 'C', available: scenario === 'C' && ready },
        { id: 'codex', name: 'Codex', command: 'codex', install: 'npm install -g @openai/codex', login: 'codex login', installed: ['B', 'F', 'G'].includes(scenario), available: ['B', 'F', 'G'].includes(scenario) },
        { id: 'hermes', name: 'Hermes', command: 'hermes', install: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash', login: 'hermes setup', installed: scenario === 'D' && ready, available: scenario === 'D' && ready },
        { id: 'octop', name: 'Octop', command: 'octop', install: 'curl -fsSL https://octop.app/install.sh | bash', login: 'octop models config', installed: scenario === 'H' && ready, available: scenario === 'H' && ready },
      ].map(agent => ({ id: agent.id, name: agent.name, state: agent.available ? 'ready' : agent.installed ? 'sign-in' : 'not-installed', signIn: agent.available ? 'signed-in' : 'signed-out', line: `Run \`${agent.installed ? agent.login : agent.install}\`.`, steps: [...(agent.installed ? [] : [{ kind: 'install', command: agent.install, label: `Copy ${agent.name} install command` }]), { kind: 'sign-in', command: agent.login, label: `Copy ${agent.name} sign-in command` }], terminal: { command: agent.command, skillSynced: true }, models: [], defaultModel: null })),
    ],
  });
  let draft = emptyDraft();
  // The project's id and slug name the same chat.
  let chat = emptyChat();

  function chatState(selector: string, operationSessionId?: string) {
    return {
      project_id: selector,
      scope_key: `project:${selector}`,
      revision: chat.revision,
      selected_session_id: chat.selected,
      ...(operationSessionId ? { operation_session_id: operationSessionId } : {}),
      sessions: chat.sessions,
      draft,
    };
  }

  /**
   * `ensure` and `ensure_main` keep the selected session, `new` always adds one; a repeated operation id replays.
   * There is no Main: the state omits `main_session_id`, as the fake always has.
   */
  function createSession(mode: unknown, operationId: unknown): string {
    const replay = typeof operationId === 'string' ? chat.operations.get(operationId) : undefined;
    if (replay) return replay;
    const existing = mode === 'new' ? null : chat.selected;
    let id = existing;
    if (!id) {
      id = `${scenario && connectedAgent !== 'astrid' ? `${connectedAgent}:` : ''}fake-session-${chat.sessions.length + 1}`;
      chat.sessions = [...chat.sessions, { id, title: chat.sessions.length === 0 ? 'Main' : `Chat ${chat.sessions.length + 1}` }];
      chat.selected = id;
      chat.revision += 1;
    }
    if (typeof operationId === 'string') chat.operations.set(operationId, id);
    return id;
  }

  return {
    reset() {
      draft = emptyDraft();
      chat = emptyChat();
      scenario = initialScenario; ready = false; signedIn = false; connectedAgent = 'astrid'; currentModel = null;
      createError = scenario === 'F' ? 'agent_runtime_missing' : null;
      promptAttempts = 0; notifications = []; prompts.clear();
    },
    handle(method, pathname, body) {
      const record = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      if (pathname === '/__test/agent-setup' && method === 'POST') {
        if (typeof record.scenario === 'string') { this.reset(); scenario = record.scenario; createError = scenario === 'F' ? 'agent_runtime_missing' : null; }
        if (typeof record.ready === 'boolean') ready = record.ready;
        if ('createError' in record) createError = typeof record.createError === 'string' ? record.createError : null;
        return { status: 200, body: { scenario, ready, promptAttempts } };
      }
      const promptRoute = /^\/projects\/([^/]+)\/chat\/prompt$/.exec(pathname);
      if (scenario && promptRoute && method === 'POST') {
        if (!projectSelectors.includes(decodeURIComponent(promptRoute[1]!)) || !chat.sessions.some(session => session.id === record.session_id) || record.connection_id !== CONNECTION_ID) return { status: 404, body: { error: 'not_found', detail: 'Unknown chat.' } };
        promptAttempts += 1;
        const requestId = String(record.request_id);
        const serialized = JSON.stringify(record.prompt);
        if (prompts.has(requestId) && prompts.get(requestId) !== serialized) return { status: 409, body: { error: 'request_id_conflict', detail: 'This request ID was already used for a different prompt.' } };
        if (scenario === 'G' && promptAttempts === 1) return { status: 502, body: { error: 'acp_process_exited', detail: 'The agent stopped before answering. Send again.' } };
        if (!prompts.has(requestId)) {
          prompts.set(requestId, serialized);
          for (const text of ["Hi! ", "I'm ready."]) notifications.push({ method: 'session/update', params: { sessionId: record.session_id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
        }
        return { status: 200, body: { result: { stopReason: 'end_turn' } } };
      }
      const sessionCreate = /^\/projects\/([^/]+)\/chat\/sessions$/.exec(pathname);
      if (sessionCreate && method === 'POST') {
        const selector = decodeURIComponent(sessionCreate[1]!);
        if (!projectSelectors.includes(selector)) {
          return { status: 404, body: { error: 'not_found', detail: `Unknown project ${selector}` } };
        }
        if (typeof record.connection_id !== 'string' || record.connection_id !== CONNECTION_ID) {
          return { status: 404, body: { error: 'not_found', detail: 'Unknown ACP connection.' } };
        }
        if (createError) return { status: 502, body: {
          error: createError,
          detail: createError === 'agent_runtime_missing' ? 'Bun is missing. Install it, then try again.' : createError === 'agent_not_installed' ? 'Codex is not installed.' : 'Sign in to Codex to continue.',
          next_action: createError === 'agent_runtime_missing' ? 'curl -fsSL https://bun.sh/install | bash' : createError === 'agent_not_installed' ? 'npm install -g @openai/codex' : 'codex login',
        } };
        const id = createSession(record.mode, record.operation_id);
        return { status: 200, body: chatState(selector, id), delayMs: scenario ? 1500 : 0 };
      }
      const chatRoute = /^\/projects\/([^/]+)\/chat(\/draft)?$/.exec(pathname);
      if (chatRoute) {
        const selector = decodeURIComponent(chatRoute[1]!);
        if (!projectSelectors.includes(selector)) {
          return { status: 404, body: { error: 'not_found', detail: `Unknown project ${selector}` } };
        }
        if (!chatRoute[2] && method === 'GET') return { status: 200, body: chatState(selector) };
        // Selecting one of the chat's own sessions (or none).
        if (!chatRoute[2] && method === 'PATCH' && 'selected_session_id' in record) {
          const target = record.selected_session_id;
          if (record.expected_revision !== chat.revision || !(target === null || chat.sessions.some((session) => session.id === target))) {
            return { status: 409, body: { error: 'chat_conflict', detail: 'The deterministic chat changed; reload before selecting.' } };
          }
          chat.selected = target as string | null;
          chat.revision += 1;
          return { status: 200, body: chatState(selector) };
        }
        if (chatRoute[2] && method === 'PATCH') {
          if (
            !Number.isInteger(record.expected_revision)
            || record.expected_revision !== draft.revision
            || typeof record.text !== 'string'
            || !Array.isArray(record.queued_messages)
          ) {
            return { status: 409, body: { error: 'draft_conflict', detail: 'The deterministic chat draft changed; reload before saving.' } };
          }
          draft = { text: record.text, revision: draft.revision + 1, queued_messages: record.queued_messages };
          return { status: 200, body: chatState(selector) };
        }
        return null;
      }
      // Ordinary editor tests keep one ready Astrid and no providers; setup journeys opt into the catalog.
      if (pathname === '/agents' && method === 'GET') {
        return { status: 200, body: catalog() };
      }
      if (pathname === '/models' && method === 'GET') {
        return { status: 200, body: { providers: scenario ? [
          { id: 'openrouter', name: 'OpenRouter', signedIn, usable: signedIn, reason: signedIn ? null : 'needs_sign_in', login: 'api-key', recommended: true, models: signedIn ? [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }, { id: 'openai/gpt-5', name: 'GPT-5' }] : [] },
          ...['chatgpt', 'claude', 'copilot'].map(id => ({ id, name: id, signedIn: false, usable: false, reason: 'needs_sign_in', login: 'oauth', models: [] })),
        ] : [], currentModel } };
      }
      if (scenario && pathname === '/astrid/api-key' && method === 'POST') {
        if (record.key === 'sk-or-test-offline-000000000') return { status: 502, body: { error: 'provider_unreachable', detail: 'Could not reach OpenRouter.' } };
        if (record.provider !== 'openrouter' || record.key !== 'sk-or-test-valid-0000000000') return { status: 400, body: { error: 'invalid_key', detail: 'OpenRouter rejected the key.' } };
        signedIn = true; currentModel = 'openrouter/anthropic/claude-sonnet-4';
        return { status: 200, body: { provider: 'openrouter', signedIn: true, currentModel } };
      }
      if (pathname === '/connect' && method === 'POST') {
        connectedAgent = typeof record.agent === 'string' ? record.agent : 'astrid';
        if (typeof record.defaultModelId === 'string') currentModel = record.defaultModelId;
        return { status: 200, body: { connection_id: CONNECTION_ID, initialize: {} } };
      }
      if (pathname === `/${CONNECTION_ID}/rpc` && method === 'POST') {
        if (record.method === 'session/list') return { status: 200, body: { result: { sessions: [] } } };
        // Attaching a session the chat just created: it holds no history and no control claim.
        if (record.method === 'session/load') return { status: 200, body: { result: {} } };
        return { status: 404, body: { error: 'not_found', detail: 'Only the local session/list and session/load are stubbed.' } };
      }
      if (pathname === `/${CONNECTION_ID}/models` && method === 'GET') {
        return { status: 200, body: { models: currentModel ? { availableModels: [{ modelId: currentModel, name: 'Claude Sonnet 4' }], currentModelId: currentModel } : null } };
      }
      if (pathname === `/${CONNECTION_ID}` && method === 'DELETE') {
        return { status: 200, body: { connection_id: CONNECTION_ID, closed: true } };
      }
      if (pathname === `/${CONNECTION_ID}/events` && method === 'GET') {
        const pending = notifications; notifications = [];
        return { status: 200, body: { notifications: pending, disconnected: false } };
      }
      return null;
    },
  };
}
