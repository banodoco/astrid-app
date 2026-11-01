import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/shared/components/ui/tooltip.tsx';

let origin = '';
vi.mock('@/integrations/runtime/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/connection.ts')>()),
  runtimeOrigin: () => origin,
  astridBase: () => `${origin}/api/astrid`,
}));

vi.mock('@/shared/contexts/AgentChatContext', () => ({
  useAgentChatBridge: () => ({ timelineId: null, editorContext: { projectId: 'project-1' } }),
  useAgentChatActionsRegistry: () => ({ registerHandlers: () => {}, publishState: () => {}, unregister: () => {} }),
}));
vi.mock('@/tools/video-editor/hooks/useAgentVoice', () => ({
  useAgentVoice: () => ({ isRecording: false, isProcessing: false, cancelRecording: () => {} }),
}));

import { AgentChatPanel as AgentChatPanelWithoutProvider } from './AgentChat.tsx';
import { RuntimeConnectionProvider } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { isTimelineAgentSessionsAvailable, useProjectAgentTaskLinks } from '@/tools/video-editor/hooks/useAgentSession.ts';

// The chat reads the runtime connection context; mount the real provider (ungated) around the real panel.
function AgentChatPanel(props: React.ComponentProps<typeof AgentChatPanelWithoutProvider>) {
  return <RuntimeConnectionProvider gated={false}><AgentChatPanelWithoutProvider {...props} /></RuntimeConnectionProvider>;
}

const GATEWAY = 'http://127.0.0.1:17340';
const chat = {
  project_id: 'project-1', scope_key: 'realm:project-1', revision: 0,
  selected_session_id: 'saved-chat', sessions: [{ id: 'saved-chat', model_id: 'openai-codex/gpt-5.6-sol' }], draft: { text: '', revision: 0 },
};
const model = { modelId: 'openai-codex/gpt-5.6-sol', name: 'GPT 5.6 Sol' };
const agents = { defaultAgent: 'astrid', agents: [{ id: 'astrid', name: 'Astrid', state: 'ready', line: null, models: [model], defaultModel: model.modelId }] };

function withQueryClient({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
}

describe('agent chat on the hosted build', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/models?sessionId=') ? { models: { currentModelId: model.modelId, availableModels: [model] } } : url.endsWith('/chat') ? chat
        : url.endsWith('/agents') ? agents
        : url.endsWith('/rpc') ? { result: {} }
        : url.endsWith('/connect') ? { connection_id: 'connection-1', initialize: {} }
        : url.endsWith('/events') ? { notifications: [], disconnected: false } : null;
      return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  beforeAll(() => {
  Element.prototype.scrollIntoView ??= vi.fn();
});

afterEach(() => {
    origin = '';
    vi.unstubAllGlobals();
  });

  it('mounts the composer and reads project chat and signed-in models through the local gateway', async () => {
    origin = GATEWAY;
    expect(isTimelineAgentSessionsAvailable()).toBe(true);
    render(<AgentChatPanel />, { wrapper: withQueryClient });

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByText("Agent chat isn't on this page yet.")).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the full editor' })).toBeNull();
    const identity = await screen.findByRole('button', { name: 'Astrid · GPT 5.6 Sol: model and thinking level' });
    const user = userEvent.setup();
    await user.click(identity);
    expect(within(await screen.findByRole('dialog', { name: 'Model and thinking level' })).getByText('Astrid · GPT 5.6 Sol')).toBeInTheDocument();
    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    await waitFor(() => expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain(`${GATEWAY}/api/astrid/acp/connection-1/models?sessionId=saved-chat`));
    expect(urls).toContain(`${GATEWAY}/api/astrid/acp/agents`);
    expect(urls).toContain(`${GATEWAY}/api/astrid/acp/projects/project-1/chat`);
    expect(urls.every(url => url.startsWith(`${GATEWAY}/api/astrid/acp/`))).toBe(true);
    for (const [, request] of fetchSpy.mock.calls) expect(request?.headers).not.toHaveProperty('Authorization');
  });

  it('with no chat service on this computer, says so in one plain line, with no alert or retry', async () => {
    origin = GATEWAY;
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ error: 'acp_unavailable' }), { status: 503 }));
    render(<AgentChatPanel />, { wrapper: withQueryClient });

    await waitFor(() => expect(screen.getByText("Chat isn't running on this computer right now.")).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('still shows a chat service that fails as an error', async () => {
    origin = GATEWAY;
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 }));
    render(<AgentChatPanel />, { wrapper: withQueryClient });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText("Chat isn't running on this computer right now.")).toBeNull();
  });

  it('rehydrates project task links through the gateway', async () => {
    origin = GATEWAY;
    const { result } = renderHook(() => useProjectAgentTaskLinks('project-1'), { wrapper: withQueryClient });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledWith(`${GATEWAY}/api/astrid/acp/projects/project-1/chat`, expect.anything());
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith(`${GATEWAY}/api/astrid/acp/`))).toBe(true);
  });

  it('keeps same-origin chat available', async () => {
    expect(isTimelineAgentSessionsAvailable()).toBe(true);
    const { result } = renderHook(() => useProjectAgentTaskLinks('project-1'), { wrapper: withQueryClient });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith('/api/astrid/acp/projects/project-1/chat', expect.anything());
  });
});
