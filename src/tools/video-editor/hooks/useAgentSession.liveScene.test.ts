import { describe, expect, it, vi } from 'vitest';
import type { AstridLocalClient } from '@/integrations/astrid/client';
import type { AgentChatEditorContext } from '@/shared/contexts/AgentChatContext';
import type { TimelineReader } from '@/sdk/video/timeline/reader';
import { LiveSceneOperationPort } from '../runtime/liveSceneOperationPort';
import { AstridAgentSessionStore, stripAstridEditorContext } from './useAgentSession';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function editorContext(port: LiveSceneOperationPort): AgentChatEditorContext {
  return {
    tool: 'video-editor', projectId: 'p', projectSlug: 'slug', timelineId: 't', timelineName: 'Timeline',
    timelineSummary: { configVersion: 7, trackCount: 1, clipCount: 1, assetCount: 0, duration: 22 },
    liveSceneOperationPort: port,
  };
}

function emptyAcp() {
  return {
    projectChat: vi.fn(async () => ({ sessions: ['session-origin', 'session-load-failure', 'session-cancel-during-load'].map(id => ({ id })) })),
    connect: vi.fn(async () => ({ connection_id: 'connection' })),
    loadSession: vi.fn(async () => ({})),
    promptProjectSession: vi.fn(async () => ({})),
    cancelSession: vi.fn(async () => ({})),
    events: vi.fn(async () => ({ notifications: [], disconnected: false })),
  };
}

describe('actual ACP store scene roundtrip', () => {
  it('prompts the same ACP connection/session with correlated read and durable receipts independently of Elements', async () => {
    const port = new LiveSceneOperationPort();
    port.setReader({ snapshot: () => ({ projectId: 'p', timelineId: 't', baseVersion: 7 }) } as TimelineReader);
    const elementExecute = vi.fn(async () => ({ operation: 'elements.list', config_version: 7 }));
    const pending: unknown[] = [];
    let calls = 0;
    let scope: Record<string, unknown>;
    port.registration('haus.astrid.threejs-live-editor')!.register(async (request) => {
      if (request.action === 'read') return { kind: 'read', capture: {
        projectId: 'p', timelineId: 't', capturedTimelineVersion: 7,
        packageRevision: `sha256:${'a'.repeat(64)}`, entryRevision: `sha256:${'b'.repeat(64)}`, packageObjectId: 'package', entryObjectId: 'entry',
      }, placementIds: ['clip'], timing: [{ id: 'clip', at: 2, duration: 20, sourceOffset: 55 }], source: { text: 'old', offset: 0, totalLength: 3 } };
      return { kind: 'published', projectId: 'p', timelineId: 't', revision: `sha256:${'c'.repeat(64)}`, entryRevision: `sha256:${'d'.repeat(64)}`,
        affectedPlacements: ['clip'], acknowledgedTimelineVersion: 8, flushReceipt: { version: 8 } };
    });
    const acp = {
      projectChat: vi.fn(async () => ({ sessions: ['session-origin', 'session-load-failure', 'session-cancel-during-load'].map(id => ({ id })) })),
    connect: vi.fn(async () => ({ connection_id: 'connection' })),
      loadSession: vi.fn(async () => ({})),
      promptProjectSession: vi.fn(async (_project: string, _connection: string, session: string, blocks: Array<{ text: string }>) => {
        calls += 1;
        let text: string;
        if (calls === 1) {
          const contract = blocks.find((block) => block.text.startsWith('<astrid_live_scene_context>'))!.text;
          scope = JSON.parse(contract.replace('<astrid_live_scene_context>', '').replace('</astrid_live_scene_context>', '')).scope;
          text = `<astrid_live_scene_request>${JSON.stringify({ schema: 'astrid.live-scene-request/v1', requestId: 'read', scope,
              placementIds: ['clip'], action: 'read', offset: 0, length: 100 })}</astrid_live_scene_request>`;
        } else {
          const feedback = JSON.parse(blocks[0].text.replace('<astrid_live_scene_result>', '').replace('</astrid_live_scene_result>', ''));
          expect(feedback.scope.sessionId).toBe(session);
          expect(feedback.results[0].ok).toBe(true);
          if (calls === 2) {
            expect(feedback.results[0].requestId).toBe('read');
            text = `<astrid_live_scene_request>${JSON.stringify({ schema: 'astrid.live-scene-request/v1', requestId: 'publish', scope,
              placementIds: ['clip'], action: 'publish', capture: feedback.results[0].result.capture, replacements: [{ before: 'old', after: 'new' }] })}</astrid_live_scene_request>`;
          } else {
            expect(feedback.results[0].requestId).toBe('publish');
            expect(feedback.results[0].result.flushReceipt.version).toBe(8);
            text = 'I received the durable publication receipt.';
          }
        }
        pending.push({ params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', messageId: `reply-${calls}`, content: { type: 'text', text } } } });
        return {};
      }),
      events: vi.fn(async () => ({ notifications: pending.splice(0), disconnected: false })),
    };
    const store = new AstridAgentSessionStore({ acp } as unknown as AstridLocalClient);
    const editor: AgentChatEditorContext = { ...editorContext(port),
      elementOperationAdapter: { execute: elementExecute } as unknown as AgentChatEditorContext['elementOperationAdapter'] };
    await store.prompt('session-origin', { message: 'Edit scene' }, editor);
    expect(acp.promptProjectSession).toHaveBeenCalledTimes(3);
    for (const call of acp.promptProjectSession.mock.calls) expect(call.slice(0, 3)).toEqual(['p', 'connection', 'session-origin']);
    expect(elementExecute).not.toHaveBeenCalled();
    const session = await store.get('p', 'session-origin');
    expect(session.turns).toHaveLength(2);
    expect(session.turns[1].content).toContain('Scene published:');
    expect(session.turns[1].content).toContain('received the durable publication receipt');
    expect(session.status).toBe('waiting_user');
    expect(stripAstridEditorContext(acp.promptProjectSession.mock.calls[1][3][0].text)).toBe('');
  });

  it('surfaces a live-scene ACP module-load failure and still ends the scene turn', async () => {
    vi.resetModules();
    vi.doMock('../runtime/liveSceneAcpRoundtrip', () => {
      throw new Error('test module load failure');
    });

    try {
      const { AstridAgentSessionStore: IsolatedStore } = await import('./useAgentSession');
      const port = new LiveSceneOperationPort();
      const endTurn = vi.spyOn(port, 'endTurn');
      const acp = emptyAcp();
      const store = new IsolatedStore({ acp } as unknown as AstridLocalClient);

      await expect(store.prompt('session-load-failure', { message: 'Edit scene' }, editorContext(port)))
        .rejects.toThrow(/Live-scene ACP implementation failed to load/);
      expect(acp.promptProjectSession).not.toHaveBeenCalled();
      expect(endTurn).toHaveBeenCalledOnce();
      expect((await store.get('p', 'session-load-failure')).status).toBe('waiting_user');
    } finally {
      vi.doUnmock('../runtime/liveSceneAcpRoundtrip');
      vi.resetModules();
    }
  });

  it('does not start a stale ACP turn when cancellation arrives during module loading', async () => {
    vi.resetModules();
    const loadStarted = deferred();
    const releaseLoad = deferred();
    vi.doMock('../runtime/liveSceneAcpRoundtrip', async () => {
      loadStarted.resolve();
      await releaseLoad.promise;
      return vi.importActual('../runtime/liveSceneAcpRoundtrip');
    });

    try {
      const { AstridAgentSessionStore: IsolatedStore } = await import('./useAgentSession');
      const port = new LiveSceneOperationPort();
      const endTurn = vi.spyOn(port, 'endTurn');
      const acp = emptyAcp();
      const store = new IsolatedStore({ acp } as unknown as AstridLocalClient);
      const prompt = store.prompt('session-cancel-during-load', { message: 'Edit scene' }, editorContext(port));

      await loadStarted.promise;
      await store.cancel('session-cancel-during-load');
      releaseLoad.resolve();
      await prompt;

      expect(acp.cancelSession).toHaveBeenCalledWith('connection', 'session-cancel-during-load');
      expect(acp.promptProjectSession).not.toHaveBeenCalled();
      expect(endTurn).toHaveBeenCalledOnce();
      expect((await store.get('p', 'session-cancel-during-load')).status).toBe('waiting_user');
    } finally {
      vi.doUnmock('../runtime/liveSceneAcpRoundtrip');
      vi.resetModules();
    }
  });
});
