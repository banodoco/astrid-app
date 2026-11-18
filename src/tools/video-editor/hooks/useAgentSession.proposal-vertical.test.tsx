import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSendMessage } from './useAgentSession.ts';

// The editor and agent prompt path list the project's admitted elements from the Runtime. These suites do not own pack
// admission, so the list read answers an empty admitted set. A module-level mock survives vi.resetModules().
vi.mock('../runtime/admittedElementLoader', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/admittedElementLoader')>(),
  readProjectElementList: async (projectId: string) => ({
    version: 1, projectId, realmId: 'realm', selectionDigest: 'a'.repeat(64), projects: [], elements: [],
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cut timeline-agent proposal vertical', () => {
  it('does not prompt or apply an edge proposal when ACP is unavailable', async () => {
    const queryClient = new QueryClient();
    const proposalApply = vi.fn();
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/acp/projects/project-1/chat')) {
        return new Response(JSON.stringify({ error: 'acp_unavailable', detail: 'No ACP service is available.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected bridge request while ACP is unavailable: ${url}`);
    });
    vi.stubGlobal('fetch', request);
    const context = {
      tool: 'video-editor' as const,
      projectId: 'project-1',
      projectSlug: 'project-one',
      timelineId: 'tl-1',
      timelineName: 'Timeline',
      elementOperationAdapter: { execute: proposalApply },
    };
    const { result, unmount } = renderHook(() => useSendMessage('session-1', context, 'project-1'), {
      wrapper: ({ children }: { children: React.ReactNode }) => React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      ),
    });

    let mutationError: unknown;
    try {
      await act(async () => {
        try {
          await result.current.mutateAsync({ input: { message: 'apply proposal' }, projectId: 'project-1', sessionId: 'session-1', context });
        } catch (error) { mutationError = error; }
      });
      expect(mutationError).toMatchObject({ code: 'acp_unavailable', status: 503 });
      expect(request).toHaveBeenCalledTimes(1);
      expect(String(request.mock.calls[0]?.[0])).toMatch(/\/acp\/projects\/project-1\/chat$/);
    } finally {
      unmount();
    }
    expect(request.mock.calls.some(([input]) => String(input).endsWith('/acp/projects/project-1/chat/prompt'))).toBe(false);
    expect(proposalApply).not.toHaveBeenCalled();
  });
});

describe('cut timeline-agent proposal vertical', () => {
  it('cannot apply an edge proposal when the session belongs to another project', async () => {
    const queryClient = new QueryClient();
    const proposalApply = vi.fn();
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith('/acp/projects/project-1/chat')
        ? { project_id: 'project-1', scope_key: 'project-1', revision: 1, selected_session_id: 'session-1', sessions: [{ id: 'session-1' }], draft: { text: '', revision: 1 } }
        : url.endsWith('/connect')
        ? { connection_id: 'connection-1', initialize: {} }
        : url.endsWith('/rpc')
          ? { result: {} }
          : url.endsWith('/events')
          ? { notifications: [], disconnected: false }
          : { error: 'session_not_owned', detail: 'Session does not belong to this project' };
      return new Response(JSON.stringify(payload), { status: url.endsWith('/prompt') ? 403 : 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', request);
    const context = {
      tool: 'video-editor' as const,
      projectId: 'project-1',
      projectSlug: 'project-one',
      timelineId: 'tl-1',
      timelineName: 'Timeline',
      elementOperationAdapter: { execute: proposalApply },
    };
    const { result, unmount } = renderHook(() => useSendMessage('session-1', context, 'project-1'), {
      wrapper: ({ children }: { children: React.ReactNode }) => React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      ),
    });

    let mutationError: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ input: { message: 'apply proposal' }, projectId: 'project-1', sessionId: 'session-1', context });
      } catch (error) { mutationError = error; }
    });
    expect(mutationError).toMatchObject({ code: 'session_not_owned' });
    expect(request.mock.calls.some(([input]) => String(input).endsWith('/acp/projects/project-1/chat/prompt'))).toBe(true);
    expect(proposalApply).not.toHaveBeenCalled();
    unmount();
  });
});
