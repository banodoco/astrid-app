import { describe, expect, it, vi } from 'vitest';
import { AstridAgentSessionStore } from './useAgentSession';
import { readAstridTaskRefs } from '../runtime/agentTaskLinks';
import type { AstridLocalClient } from '@/integrations/astrid/client';

const ref = { project_id: 'project', run_id: 'run', task_id: 'task', capability_id: 'media.clip_extract' };
const notification = (update: unknown, sessionId = 'session') => ({ params: { sessionId, update } });
function fixture() {
  const queue: unknown[] = [];
  const acp = {
    connect: vi.fn(async () => ({ connection_id: 'connection' })),
    projectChat: vi.fn(async () => ({ sessions: [{ id: 'session' }, { id: 'second' }] })),
    loadSession: vi.fn(async (_connection: string, _session: string) => ({})),
    events: vi.fn(async () => ({ notifications: queue.splice(0), disconnected: false })),
    promptProjectSession: vi.fn(async () => ({})),
  };
  const store = new AstridAgentSessionStore({ acp } as unknown as AstridLocalClient);
  return { store, queue, acp };
}
const tool = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Astrid task' });
const result = (id: string, refs: unknown[], status = 'completed', content = '') => ({
  sessionUpdate: 'tool_call_update', toolCallId: id, status, content,
  rawOutput: { details: { astridTaskRefs: refs } },
});

describe('durable exact-call Runtime task association', () => {
  it('rejects prose, malformed refs and wrong projects', () => {
    expect(readAstridTaskRefs({ text: JSON.stringify(ref) }, 'project')).toEqual([]);
    expect(readAstridTaskRefs({ details: { astridTaskRefs: [ref, ref, { ...ref, task_id: '' }, { ...ref, project_id: 'other' }] } }, 'project')).toEqual([ref]);
  });

  it('upserts empty-content, interleaved partial/final updates by exact call ID', async () => {
    const { store, queue } = fixture();
    queue.push(notification(tool('A')), notification(tool('B')),
      notification(result('B', [{ ...ref, task_id: 'B' }], 'in_progress')),
      notification(result('A', [ref], 'completed', 'actual A response')),
      notification(result('B', [{ ...ref, task_id: 'B' }], 'completed', 'actual B response')),
      notification(result('A', [ref], 'completed', 'actual A response')),
      notification(result('A', [ref], 'in_progress', 'stale narration')));
    const session = await store.get('project', 'session');
    expect(session.turns.filter(turn => turn.role === 'tool_result')).toHaveLength(2);
    expect(session.turns.find(turn => turn.role === 'tool_result' && turn.tool_call_id === 'A')).toMatchObject({ content: 'actual A response', task_refs: [ref], tool_status: 'completed' });
    expect(session.taskLinks).toEqual([
      { ...ref, task_id: 'B', sessionId: 'session', toolCallId: 'B', liveObserved: false },
      { ...ref, sessionId: 'session', toolCallId: 'A', liveObserved: false },
    ]);
  });

  it('retains native structured task outcomes separately from transport status and rendered prose', async () => {
    const { store, queue } = fixture();
    const details = { projectAgentsDir: null, totalDurationMs: 50, results: [{ id: 'Review', agent: 'reviewer', exitCode: 1, aborted: false, error: '402 credits unavailable' }] };
    queue.push(notification(tool('native-task')), notification({sessionUpdate: 'tool_call_update', toolCallId: 'native-task', status: 'completed', rawOutput: {details}, content: 'Native task output'}),
      notification({sessionUpdate: 'tool_call_update', toolCallId: 'native-task', status: 'in_progress', rawOutput: {details: {results: []}}, content: 'stale partial'}));
    const session = await store.get('project', 'session');
    expect(session.turns.find(turn => turn.role === 'tool_result')).toMatchObject({tool_status: 'completed', tool_output_details: details, content: 'Native task output'});
  });

  it('rehydrates refs through session/load and isolates session switches', async () => {
    const { store, queue, acp } = fixture();
    acp.loadSession.mockImplementation(async (_connection: string, session: string) => {
      queue.push(notification(tool('same-call'), session), notification(result('same-call', [ref]), session));
      return {};
    });
    const original = await store.get('project', 'session');
    await store.get('project', 'second');
    const returned = await store.get('project', 'session');
    expect(original.taskLinks).toEqual(returned.taskLinks);
    expect(returned.turns.filter(turn => turn.role === 'tool_result')).toHaveLength(1);
    expect(acp.loadSession).toHaveBeenCalledTimes(2);
    const reloaded = fixture();
    reloaded.queue.push(notification(tool('same-call')), notification(result('same-call', [ref])));
    expect((await reloaded.store.get('project', 'session')).taskLinks).toEqual(original.taskLinks);
  });

  it('retains actual assistant text and keeps unrelated project refs unlinked', async () => {
    const { store, queue } = fixture();
    queue.push(notification(tool('A')), notification(result('A', [{ ...ref, project_id: 'other' }])),
      notification({ sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: 'Exact ACP response.' } }));
    const session = await store.get('project', 'session');
    expect(session.taskLinks).toEqual([]);
    expect(session.turns.at(-1)?.content).toBe('Exact ACP response.');
  });

  it('marks first association during an actual prompt as live, preserving it across repeated polling', async () => {
    const { store, queue, acp } = fixture();
    await store.get('project', 'session');
    acp.promptProjectSession.mockImplementation(async () => {
      queue.push(notification(tool('live')), notification(result('live', [ref])),
        notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Admitted.' } }));
      return {};
    });
    await store.prompt('session', { message: 'Extract a clip' }, {
      tool: 'video-editor', projectId: 'project', projectSlug: 'project', timelineId: null, timelineName: null,
    });
    const state = await store.get('project', 'session');
    expect(state.taskLinks[0]).toMatchObject({ ...ref, toolCallId: 'live', liveObserved: true });
    expect(state.turns.at(-1)?.content).toBe('Admitted.');
  });

  it('keeps pre-command narration and maps Codex and Claude Code raw command output', async () => {
    const { store, queue, acp } = fixture();
    await store.get('project', 'session');
    acp.promptProjectSession.mockImplementation(async () => {
      queue.push(
        notification({ sessionUpdate: 'agent_message_chunk', messageId: 'before-command', content: { type: 'text', text: "I'm running the command now…" } }),
        notification(tool('codex-shell')),
        notification({ sessionUpdate: 'tool_call_update', toolCallId: 'codex-shell', status: 'completed', rawOutput: { exit_code: 0, formatted_output: 'Codex stdout', details: { source: 'codex' } } }),
        notification(tool('claude-shell')),
        notification({ sessionUpdate: 'tool_call_update', toolCallId: 'claude-shell', status: 'completed', rawOutput: [{ type: 'text', text: 'Claude stdout' }] }),
        notification({ sessionUpdate: 'agent_message_chunk', messageId: 'after-command', content: { type: 'text', text: 'The command finished.' } }),
      );
      return {};
    });

    await store.prompt('session', { message: 'Run the command' }, {
      tool: 'video-editor', projectId: 'project', projectSlug: 'project', timelineId: null, timelineName: null,
    });

    const turns = (await store.get('project', 'session')).turns;
    expect(turns.map(turn => turn.role)).toEqual(['user', 'assistant', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant']);
    expect(turns[1]).toMatchObject({ role: 'assistant', content: "I'm running the command now…", messageId: 'before-command' });
    expect(turns.find(turn => turn.role === 'tool_result' && turn.tool_call_id === 'codex-shell')).toMatchObject({
      content: 'Codex stdout', tool_output: { exit_code: 0, formatted_output: 'Codex stdout', details: { source: 'codex' } },
      tool_output_details: { source: 'codex' },
    });
    expect(turns.find(turn => turn.role === 'tool_result' && turn.tool_call_id === 'claude-shell')).toMatchObject({
      content: 'Claude stdout', tool_output: [{ type: 'text', text: 'Claude stdout' }],
    });
    expect(turns.at(-1)).toMatchObject({ role: 'assistant', content: 'The command finished.', messageId: 'after-command' });
  });
});
