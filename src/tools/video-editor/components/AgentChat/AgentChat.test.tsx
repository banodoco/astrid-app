// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncExternalStore, type ComponentProps } from 'react';
import type { AgentTurn } from '@/tools/video-editor/types/agent-session';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import type { LocalAgentChoice } from '@/integrations/astrid/localAgents.ts';
import { AgentChatPanel as AgentChatPanelWithoutProvider } from './AgentChat';
import { RuntimeConnectionProvider, useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { BridgeContractError } from '@/tools/video-editor/data/bridgeContract.ts';

// A tiny store standing in for the bridge's pending composer prompt, so a test can click a draft button twice.
const composerPrompt = vi.hoisted(() => {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: string | null) { value = next; listeners.forEach((listener) => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
});

const mocks = vi.hoisted(() => ({
  useAgentChatBridge: vi.fn(),
  useAgentChatActionsRegistry: vi.fn(),
  useVideoEditorRuntime: vi.fn(),
  useAgentSessions: vi.fn(),
  useProjectChat: vi.fn(),
  useSaveProjectDraft: vi.fn(),
  useSelectProjectSession: vi.fn(),
  useSetMainProjectSession: vi.fn(),
  useRenameProjectSession: vi.fn(),
  useUnassignedProjectSessions: vi.fn(),
  useAssociateProjectSession: vi.fn(),
  useCreateSession: vi.fn(),
  useAgentSession: vi.fn(),
  useSendMessage: vi.fn(),
  useAgentModels: vi.fn(),
  useConfigureAgentSession: vi.fn(),
  useLocalAgents: vi.fn(),
  modelRefetch: vi.fn(),
  useCancelSession: vi.fn(),
  useTakeOverSession: vi.fn(),
  useCurrentAttachmentSet: vi.fn(),
  composerRemoveAttachment: vi.fn(),
  composerClearAttachments: vi.fn(),
  loadGenerationForLightbox: vi.fn(),
  // Mutable so individual tests can flip isTasksPaneLocked to satisfy the
  // engagement gate that drives auto-create.
  panesState: { isTasksPaneLocked: false, setIsTasksPaneLocked: vi.fn() },
}));


vi.mock('@/shared/contexts/AgentChatContext', () => ({
  useAgentChatBridge: (...args: unknown[]) => mocks.useAgentChatBridge(...args),
  useAgentChatActionsRegistry: (...args: unknown[]) => mocks.useAgentChatActionsRegistry(...args),
}));

vi.mock('@/tools/video-editor/contexts/VideoEditorRuntimeContext', () => ({
  useVideoEditorRuntime: (...args: unknown[]) => mocks.useVideoEditorRuntime(...args),
}));

vi.mock('@/tools/video-editor/hooks/useAgentSession', () => ({
  useAgentSessions: (...args: unknown[]) => mocks.useAgentSessions(...args),
  useProjectChat: (...args: unknown[]) => mocks.useProjectChat(...args),
  useSaveProjectDraft: (...args: unknown[]) => mocks.useSaveProjectDraft(...args),
  useSelectProjectSession: (...args: unknown[]) => mocks.useSelectProjectSession(...args),
  useSetMainProjectSession: (...args: unknown[]) => mocks.useSetMainProjectSession(...args),
  useRenameProjectSession: (...args: unknown[]) => mocks.useRenameProjectSession(...args),
  useUnassignedProjectSessions: (...args: unknown[]) => mocks.useUnassignedProjectSessions(...args),
  useAssociateProjectSession: (...args: unknown[]) => mocks.useAssociateProjectSession(...args),
  useCreateSession: (...args: unknown[]) => mocks.useCreateSession(...args),
  useAgentSession: (...args: unknown[]) => mocks.useAgentSession(...args),
  useSendMessage: (...args: unknown[]) => mocks.useSendMessage(...args),
  useAgentModels: (...args: unknown[]) => mocks.useAgentModels(...args),
  useConfigureAgentSession: (...args: unknown[]) => mocks.useConfigureAgentSession(...args),
  useLocalAgents: (...args: unknown[]) => mocks.useLocalAgents(...args),
  useCancelSession: (...args: unknown[]) => mocks.useCancelSession(...args),
  useTakeOverSession: (...args: unknown[]) => mocks.useTakeOverSession(...args),
}));

vi.mock('@/shared/state/selectionStore', () => ({
  composerRemoveAttachment: (...args: unknown[]) => mocks.composerRemoveAttachment(...args),
  composerClearAttachments: (...args: unknown[]) => mocks.composerClearAttachments(...args),
}));

vi.mock('@/shared/state/currentAttachmentSet', () => ({
  useCurrentAttachmentSet: (...args: unknown[]) => mocks.useCurrentAttachmentSet(...args),
}));

vi.mock('@/shared/state/panesStore', () => ({
  usePanesStore: (selector: (state: typeof mocks.panesState) => unknown) => selector(mocks.panesState),
}));


vi.mock('@/tools/video-editor/lib/generation-utils', () => ({
  loadGenerationForLightbox: (...args: unknown[]) => mocks.loadGenerationForLightbox(...args),
}));

vi.mock('@/domains/media-lightbox/MediaLightbox', () => ({
  MediaLightbox: ({ media }: { media: { id: string } }) => <div data-testid="media-lightbox">{media.id}</div>,
}));

vi.mock('./AgentChatMessage', () => ({
  AgentChatMessage: ({ turn }: { turn: { content: string } }) => <div>{turn.content}</div>,
  AgentChatToolGroup: () => null,
  AgentChatAttachmentStrip: ({
    attachments,
    onRemoveAttachment,
    onRemoveShot,
  }: {
    attachments: Array<{ clipId: string; shotId?: string }>;
    onRemoveAttachment?: (attachment: { clipId: string; shotId?: string }) => void;
    onRemoveShot?: (shotId: string) => void;
  }) => (
    <div>
      {attachments.map((attachment) => (
        <button
          key={`remove-${attachment.clipId}`}
          type="button"
          onClick={() => onRemoveAttachment?.(attachment)}
        >
          {`remove-${attachment.clipId}`}
        </button>
      ))}
      {attachments
        .filter((attachment) => attachment.shotId)
        .map((attachment) => (
          <button
            key={`remove-shot-${attachment.shotId}`}
            type="button"
            onClick={() => onRemoveShot?.(attachment.shotId!)}
          >
            {`remove-shot-${attachment.shotId}`}
          </button>
        ))}
    </div>
  ),
}));

function iso(timestampMs: number) {
  return new Date(timestampMs).toISOString();
}

function createUserTurn(content: string, timestampMs: number): AgentTurn {
  return {
    role: 'user',
    content,
    timestamp: iso(timestampMs),
  };
}

function createTimelineClip(clipId: string) {
  return {
    clipId,
    assetKey: `asset-${clipId}`,
    url: `https://example.com/${clipId}.png`,
    mediaType: 'image' as const,
    isTimelineBacked: true,
  };
}

function createState() {
  return {
    projectId: 'project-1' as string | null,
    projectChats: {
      'project-1': { project_id: 'project-1', scope_key: 'scope-1', revision: 1, selected_session_id: 'session-1', sessions: [{ id: 'session-1' }], draft: { text: '', revision: 0, queued_messages: [] as Array<{ id: string; text: string; session_id: string; attachments?: unknown[] }> } },
      'project-2': { project_id: 'project-2', scope_key: 'scope-2', revision: 1, selected_session_id: 'session-1', sessions: [{ id: 'session-1' }], draft: { text: '', revision: 0, queued_messages: [] as Array<{ id: string; text: string; session_id: string; attachments?: unknown[] }> } },
    },
    timelineId: 'timeline-1' as string | null,
    timelineClips: [] as Array<ReturnType<typeof createTimelineClip>>,
    sessionsData: [{ id: 'session-1', status: 'waiting_user' }],
    activeSessionData: {
      id: 'session-1',
      status: 'waiting_user',
      turns: [] as AgentTurn[],
      durableAcceptedRequestIds: undefined as string[] | undefined,
      control: undefined as { role: 'writer' | 'follower'; active: boolean; activeRequestId: string | null } | undefined,
    },
    createSession: {
      isPending: false,
      error: null as Error | null,
      reset: vi.fn(),
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ id: 'session-2' }),
    },
    sendMessage: {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
      localError: null as string | null,
      error: null as Error | null,
      clearLocalError: vi.fn(),
    },
    cancelSession: {
      mutate: vi.fn(),
      isPending: false,
    },
    takeOverSession: {
      mutate: vi.fn(),
      isPending: false,
      error: null as Error | null,
    },
  };
}

function mockFromState(state: ReturnType<typeof createState>) {
  mocks.useVideoEditorRuntime.mockImplementation(() => ({
    mediaLightbox: {
      loadGenerationForLightbox: mocks.loadGenerationForLightbox,
      Lightbox: ({ media }: { media: { id: string } }) => <div data-testid="media-lightbox">{media.id}</div>,
    },
  }));
  mocks.useAgentChatBridge.mockImplementation(() => ({
    timelineId: state.timelineId,
    editorContext: state.projectId ? { tool: 'video-editor', projectId: state.projectId, projectSlug: 'project-one', timelineId: state.timelineId, timelineName: null } : null,
    pendingComposerPrompt: useSyncExternalStore(composerPrompt.subscribe, composerPrompt.get),
    clearPendingComposerPrompt: () => composerPrompt.set(null),
  }));
  mocks.useAgentChatActionsRegistry.mockImplementation(() => ({
    registerHandlers: vi.fn(),
    publishState: vi.fn(),
    unregister: vi.fn(),
  }));
  mocks.useAgentSessions.mockImplementation(() => ({
    data: state.sessionsData,
    isLoading: false,
  }));
  mocks.useProjectChat.mockImplementation((projectId: string | null) => ({ data: projectId ? state.projectChats[projectId as 'project-1' | 'project-2'] : undefined }));
  mocks.useSaveProjectDraft.mockImplementation((projectId: string | null) => ({ mutateAsync: vi.fn().mockImplementation(async (input: { text: string; queuedMessages: Array<{ id: string; text: string; session_id: string; attachments?: unknown[] }> }) => {
    const chat = state.projectChats[projectId as 'project-1' | 'project-2'];
    chat.draft = { text: input.text, revision: chat.draft.revision + 1, queued_messages: input.queuedMessages };
    return chat;
  }) }));
  mocks.useSelectProjectSession.mockImplementation(() => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }));
  mocks.useSetMainProjectSession.mockImplementation(() => ({ isPending: false, mutateAsync: vi.fn().mockResolvedValue(undefined) }));
  mocks.useRenameProjectSession.mockImplementation(() => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }));
  mocks.useUnassignedProjectSessions.mockImplementation(() => ({ data: undefined, isLoading: false }));
  mocks.useAssociateProjectSession.mockImplementation(() => ({ mutate: vi.fn(), isPending: false }));
  mocks.useCreateSession.mockImplementation(() => state.createSession);
  mocks.useAgentSession.mockImplementation(() => ({
    data: state.activeSessionData,
    isLoading: false,
    error: (state as typeof state & { activeError?: Error }).activeError ?? null,
  }));
  mocks.useAgentModels.mockImplementation(() => ({ data: { currentModel: null, providers: [], localModels: { currentModelId: 'openai/gpt-5', availableModels: [{ modelId: 'openai/gpt-5', name: 'GPT 5' }] } }, isLoading: false, error: null, refetch: mocks.modelRefetch }));
  mocks.useLocalAgents.mockImplementation(() => ({ data: { agents: [{ id: 'astrid', name: 'Astrid', state: 'ready', line: null, models: [{ modelId: 'openai/gpt-5', name: 'GPT 5' }], defaultModel: 'openai/gpt-5' }], defaultAgent: 'astrid' }, isLoading: false, error: null, refetch: vi.fn() }));
  mocks.useSendMessage.mockImplementation(() => state.sendMessage);
  mocks.useCancelSession.mockImplementation(() => state.cancelSession);
  mocks.useTakeOverSession.mockImplementation(() => state.takeOverSession);
  mocks.useCurrentAttachmentSet.mockImplementation(() => ({
    clips: state.timelineClips,
    summary: state.timelineClips.length > 0 ? `attaching ${state.timelineClips.length} image` : '',
  }));
}

// The chat reads the runtime connection context, so every render mounts it (same component identity across rerenders).
function AgentChatPanel(props: ComponentProps<typeof AgentChatPanelWithoutProvider>) {
  return <RuntimeConnectionProvider gated={false}><AgentChatPanelWithoutProvider {...props} /></RuntimeConnectionProvider>;
}

function renderAgentChat(isExpanded = false) {
  return render(<AgentChatPanel isExpanded={isExpanded} />);
}

function rerenderAgentChat(rerender: ReturnType<typeof render>['rerender'], isExpanded = false) {
  rerender(<AgentChatPanel isExpanded={isExpanded} />);
}

function renderSetupChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const panel = () => <QueryClientProvider client={client}><AgentChatPanel /></QueryClientProvider>;
  const view = render(panel());
  return { ...view, refresh: () => view.rerender(panel()) };
}

async function getInput() {
  const textbox = await screen.findByRole('textbox');
  await waitFor(() => expect(textbox).not.toBeDisabled());
  return textbox;
}

async function queueMessage(textbox: HTMLElement, text: string) {
  fireEvent.change(textbox, { target: { value: text } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toBe(''));
}

function getQueuedTexts() {
  return Array.from(document.querySelectorAll('.line-clamp-2')).map((node) => node.textContent);
}

beforeEach(() => {
  // The new-chat choice persists in localStorage; keep it from leaking between tests.
  localStorage.removeItem('astrid.app.newChatChoice');
});

describe('AgentChat', () => {
  beforeEach(() => {
    mocks.useConfigureAgentSession.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(undefined) });
    vi.clearAllMocks();
    // Default: pane is locked so the engagement gate is satisfied and the
    // existing auto-create assertions still hold. Tests that need the unengaged
    // baseline flip this back to false.
    mocks.panesState.isTasksPaneLocked = true;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });

    mocks.loadGenerationForLightbox.mockResolvedValue({
      id: 'gen-1',
      generation_id: 'gen-1',
      location: 'https://example.com/shared.png',
      imageUrl: 'https://example.com/shared.png',
      thumbUrl: 'https://example.com/shared.png',
      type: 'image',
      primary_variant_id: null,
      name: 'Shared image',
    });
  });

  it('focuses the composer with the cursor at the end on every draft click', async () => {
    mockFromState(createState());
    const prompt = 'Build a new extension that ';
    render(
      <>
        <button type="button" onClick={() => composerPrompt.set(prompt)}>Draft extension</button>
        <AgentChatPanel isExpanded />
      </>,
    );
    const draftButton = screen.getByRole('button', { name: 'Draft extension' });
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    for (let click = 1; click <= 2; click += 1) {
      // A real click moves focus onto the button before the handler runs.
      act(() => { draftButton.focus(); });
      await userEvent.click(draftButton);
      await waitFor(() => expect(composer).toHaveFocus());
      expect(composer.value).toContain(prompt);
      expect(composer.selectionStart).toBe(composer.value.length);
    }
  });

  it('focuses the composer once it unlocks, when a draft click landed while it was locked', async () => {
    const prompt = 'Create a custom effect or animation that ';
    const locked = createState();
    locked.activeSessionData.status = 'cancelled';
    mockFromState(locked);
    const panel = () => (
      <>
        <button type="button" onClick={() => composerPrompt.set(prompt)}>Draft effect</button>
        <AgentChatPanel isExpanded />
      </>
    );
    const view = render(panel());
    const draftButton = screen.getByRole('button', { name: 'Draft effect' });
    act(() => { draftButton.focus(); });
    await userEvent.click(draftButton);
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toContain(prompt));
    expect(composer).toBeDisabled();
    expect(composer).not.toHaveFocus();

    mockFromState(createState());
    view.rerender(panel());
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).selectionStart).toBe(composer.value.length);
  });

  describe('setup recovery', () => {
    const agents = (): LocalAgentChoice[] => ['astrid', 'codex', 'hermes'].map(id => ({ id: id as LocalAgentChoice['id'], name: id, state: 'ready', signIn: 'signed-in', line: null, models: [], defaultModel: null }));
    function setupState() {
      const state = createState();
      state.projectChats['project-1'].selected_session_id = 'codex:session-1';
      state.projectChats['project-1'].sessions = [{ id: 'codex:session-1' }];
      state.activeSessionData.id = 'codex:session-1';
      state.sessionsData = [{ id: 'codex:session-1', status: 'waiting_user' }];
      mockFromState(state);
      const localAgents = { data: { defaultAgent: 'codex', agents: agents() }, refetch: vi.fn().mockResolvedValue(undefined), error: null };
      mocks.useLocalAgents.mockImplementation(() => localAgents);
      return { state, localAgents };
    }
    it('shows only the fix and Set up for a broken agent, with the setup placeholder', async () => {
      const { state, localAgents } = setupState();
      const view = renderSetupChat();
      await getInput();
      state.activeSessionData.status = 'error';
      localAgents.data.agents[1] = { ...localAgents.data.agents[1], signIn: 'signed-out', line: 'Run `codex login`.' };
      view.refresh();
      expect(screen.getByRole('textbox')).toBeDisabled();
      expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Set up Codex to keep chatting');
      expect(screen.getByText('codex login')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Set up', exact: true })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(/Agent error\. Try again/)).toBeNull();
    });
    it('opens setup for an unready agent chosen from the new chat menu', async () => {
      const { state, localAgents } = setupState();
      localAgents.data.agents[2] = { ...localAgents.data.agents[2], state: 'not-installed', line: 'Install with `hermes install`.' };
      const view = renderSetupChat();
      await getInput();

      fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
      fireEvent.click(screen.getByRole('option', { name: /Hermes/ }));

      const card = screen.getByRole('region', { name: 'How do you want Astrid to think?' });
      expect(within(card).getByRole('heading', { name: 'Hermes' })).toBeInTheDocument();
      expect(within(card).getByText('hermes install')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'New chat' })).toBeNull();
      expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    });
    it.each(['broken', 'setup-error', 'both'] as const)('shows one muted host line for a follower with %s', async kind => {
      const { state, localAgents } = setupState();
      const view = renderSetupChat();
      await getInput();
      state.activeSessionData.control = { role: 'follower', active: false, activeRequestId: null };
      state.activeSessionData.status = 'error';
      if (kind !== 'setup-error') localAgents.data.agents[1].signIn = 'signed-out';
      if (kind !== 'broken') {
        state.sendMessage.localError = 'Agent needs sign-in';
        state.sendMessage.error = new BridgeRouteError('Prompt', 502, { error: 'agent_sign_in_required', detail: 'Agent needs sign-in', next_action: 'codex login' });
      }
      view.refresh();
      const line = screen.getByText('Codex needs setting up on the computer running this chat.');
      expect(line).toHaveClass('text-muted-foreground');
      expect(screen.queryAllByText('Codex needs setting up on the computer running this chat.')).toHaveLength(1);
      expect(screen.queryByRole('region', { name: 'How do you want Astrid to think?' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Set up', exact: true })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('textbox')).toBeDisabled();
    });
    it.each(['codex', 'hermes'])('does not carry a setup error into another %s chat or reopen it on return', async nextAgent => {
      const { state } = setupState();
      const view = renderSetupChat();
      await getInput();
      state.sendMessage.localError = 'Old setup error';
      state.sendMessage.error = new BridgeRouteError('Prompt', 502, { error: 'agent_sign_in_required', detail: 'Old setup error', next_action: 'codex login' });
      view.refresh();
      await screen.findByText('Old setup error');
      const nextId = `${nextAgent}:session-2`;
      state.projectChats['project-1'].selected_session_id = nextId;
      state.projectChats['project-1'].sessions = [{ id: nextId }];
      state.sessionsData = [{ id: nextId, status: 'waiting_user' }];
      state.activeSessionData.id = nextId;
      view.refresh();
      await waitFor(() => expect(screen.queryByText('Old setup error')).toBeNull());
      expect(screen.queryByRole('region', { name: 'How do you want Astrid to think?' })).toBeNull();
      expect(screen.getByRole('textbox')).toBeEnabled();
      state.projectChats['project-1'].selected_session_id = 'codex:session-1';
      state.projectChats['project-1'].sessions = [{ id: 'codex:session-1' }];
      state.sessionsData = [{ id: 'codex:session-1', status: 'waiting_user' }];
      state.activeSessionData.id = 'codex:session-1';
      view.refresh();
      await waitFor(() => expect(mocks.useAgentSession).toHaveBeenLastCalledWith('codex:session-1', 'project-1'));
      expect(screen.queryByText('Old setup error')).toBeNull();
      expect(screen.getByRole('textbox')).toBeEnabled();
    });
    it('resets createSession and dismisses its setup error when setup completes', async () => {
      const { state, localAgents } = setupState();
      const view = renderSetupChat();
      await getInput();
      state.createSession.error = new BridgeRouteError('Create', 502, { error: 'agent_sign_in_required', detail: 'Create needs sign-in', next_action: 'codex login' });
      view.refresh();
      await screen.findByText('Create needs sign-in');
      localAgents.data.agents = localAgents.data.agents.map(row => row.id === 'codex' ? { ...row, steps: [] } : row);
      view.refresh();
      await screen.findByText('✓ Codex is set up.');
      expect(state.createSession.reset).toHaveBeenCalledOnce();
      expect(state.sendMessage.clearLocalError).toHaveBeenCalledOnce();
      view.refresh();
      expect(screen.queryByText('Create needs sign-in')).toBeNull();
      expect(screen.queryByRole('region', { name: 'How do you want Astrid to think?' })).toBeNull();
      expect(screen.getByRole('textbox')).toBeEnabled();
    });
    describe('terminal nudge', () => {
      const NUDGE_KEY = 'astrid.setting.device.agentTerminalNudgeSeen';
      const nudge = () => screen.queryByRole('region', { name: 'You can also talk to Astrid from your terminal' });
      beforeEach(() => { localStorage.removeItem(NUDGE_KEY); });
      async function setUpCodex(terminal: LocalAgentChoice['terminal'], projectName: string | null = 'My first project') {
        const { state, localAgents } = setupState();
        localAgents.data.agents = localAgents.data.agents.map(row => ({ ...row, terminal: row.id === 'codex' ? terminal : { command: row.id, skillSynced: true } }));
        mocks.useAgentChatBridge.mockImplementation(() => ({
          timelineId: state.timelineId,
          editorContext: { tool: 'video-editor', projectId: 'project-1', projectSlug: 'project-one', projectName, timelineId: state.timelineId, timelineName: null },
        }));
        const view = renderSetupChat();
        await getInput();
        state.createSession.error = new BridgeRouteError('Create', 502, { error: 'agent_sign_in_required', detail: 'Create needs sign-in', next_action: 'codex login' });
        view.refresh();
        await screen.findByText('Create needs sign-in');
        localAgents.data.agents = localAgents.data.agents.map(row => row.id === 'codex' ? { ...row, steps: [] } : row);
        view.refresh();
        await screen.findByText('✓ Codex is set up.');
        return { state, localAgents, view };
      }
      function reply(state: ReturnType<typeof createState>, view: { refresh: () => void }) {
        state.activeSessionData.turns = [createUserTurn('hi', 1_000), { role: 'assistant', content: "Hi! I'm ready.", timestamp: iso(2_000) }];
        view.refresh();
      }

      it('shows once, after the first reply, with the agent command and the open project', async () => {
        const { state, view } = await setUpCodex({ command: 'codex', skillSynced: true });
        expect(nudge()).toBeNull();
        reply(state, view);
        const region = await waitFor(() => { const found = nudge(); expect(found).not.toBeNull(); return found!; });
        expect(within(region).getByText('codex')).toBeInTheDocument();
        expect(within(region).getByText('make the intro two seconds shorter')).toBeInTheDocument();
        expect(within(region).getByText('Updated "My first project"')).toBeInTheDocument();
        expect(within(region).getByText('Edits, tasks and generations show up right here.')).toBeInTheDocument();
        expect(within(region).queryByText('Uses the same OpenRouter key and model as here.')).toBeNull();
        expect(localStorage.getItem(NUDGE_KEY)).toBe('true');
      });

      it('copies the agent command', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        const { state, view } = await setUpCodex({ command: 'codex', skillSynced: true });
        reply(state, view);
        fireEvent.click(await screen.findByRole('button', { name: 'Copy terminal command' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('codex'));
      });

      it('closes, and reopens from the chat menu as Use from your terminal', async () => {
        const { state, view } = await setUpCodex({ command: 'codex', skillSynced: true });
        reply(state, view);
        await waitFor(() => expect(nudge()).not.toBeNull());
        fireEvent.click(within(nudge()!).getByRole('button', { name: 'Close' }));
        expect(nudge()).toBeNull();
        view.refresh();
        expect(nudge()).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^Chat:/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Use from your terminal' }));
        await waitFor(() => expect(nudge()).not.toBeNull());
        expect(nudge()).toHaveFocus();
      });

      it('does not show by itself again once it has been shown in this browser', async () => {
        localStorage.setItem(NUDGE_KEY, 'true');
        const { state, view } = await setUpCodex({ command: 'codex', skillSynced: true });
        reply(state, view);
        await screen.findByText("Hi! I'm ready.");
        expect(nudge()).toBeNull();
      });

      it('stays hidden, with no menu entry, when the skill did not sync', async () => {
        const { state, view } = await setUpCodex({ command: 'codex', skillSynced: false });
        reply(state, view);
        await screen.findByText("Hi! I'm ready.");
        expect(nudge()).toBeNull();
        expect(localStorage.getItem(NUDGE_KEY)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^Chat:/ }));
        await screen.findByRole('button', { name: /Attach an existing chat/ });
        expect(screen.queryByRole('button', { name: 'Use from your terminal' })).toBeNull();
      });
    });
    it('ignores a start error that arrives after switching chats', async () => {
      const { state } = setupState();
      let reject!: (error: Error) => void;
      state.createSession.mutateAsync.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
      const view = renderSetupChat();
      await getInput();
      fireEvent.click(screen.getByRole('button', { name: /^New chat · Codex/ }));
      await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalledOnce());
      state.projectChats['project-1'].selected_session_id = 'hermes:session-2';
      state.projectChats['project-1'].sessions = [{ id: 'hermes:session-2' }];
      state.sessionsData = [{ id: 'hermes:session-2', status: 'waiting_user' }];
      state.activeSessionData.id = 'hermes:session-2';
      view.refresh();
      await waitFor(() => expect(mocks.useAgentSession).toHaveBeenLastCalledWith('hermes:session-2', 'project-1'));
      await act(async () => { reject(new BridgeRouteError('Create', 502, { error: 'agent_sign_in_required', detail: 'Late setup error' })); });
      expect(screen.queryByText('Late setup error')).toBeNull();
      expect(screen.queryByRole('region', { name: 'How do you want Astrid to think?' })).toBeNull();
      expect(screen.getByRole('textbox')).toBeEnabled();
    });
  });

  it('shows the fixed agent and model with its thinking level in the model line', async () => {
    const state = createState();
    const sessionId = 'codex:session-1';
    const projectId = 'project-1';
    state.projectChats[projectId].selected_session_id = sessionId;
    state.projectChats[projectId].sessions = [{ id: sessionId }];
    state.sessionsData = [{ id: sessionId, status: 'waiting_user' }];
    state.activeSessionData.id = sessionId;
    mockFromState(state);
    mocks.useAgentModels.mockImplementation(() => ({
      data: {
        currentModel: 'openai/gpt-5',
        providers: [{ id: 'openai', name: 'OpenAI', signedIn: true, models: [{ id: 'gpt-5', name: 'GPT 5' }] }],
        localModels: {
          currentModelId: 'vendor/codex-current',
          thoughtLevel: { configId: 'reasoning_effort', name: 'Reasoning effort', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
          availableModels: [
            { modelId: 'vendor/codex-current', name: 'Codex Current' },
            { modelId: 'vendor/codex-target', name: 'Codex Target', description: 'For focused coding' },
          ],
        },
      },
      isLoading: false,
      error: null,
      refetch: mocks.modelRefetch,
    }));

    renderAgentChat();
    const identity = await screen.findByTestId('agent-chat-identity');
    expect(identity).toHaveTextContent('Codex · Codex Current · High');
    expect(screen.queryByText('Codex Current', { exact: true })).toBeNull();
    const user = userEvent.setup();
    await user.click(identity);
    const panel = await screen.findByRole('dialog', { name: 'Model and thinking level' });
    expect(within(panel).getByText('Codex · Codex Current')).toBeInTheDocument();
    expect(within(panel).getByText('A chat keeps its model.')).toBeInTheDocument();
    expect(within(panel).getByRole('option', { name: /High/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('combobox', { name: 'Agent model' })).toBeNull();

    await waitFor(() => {
      expect(mocks.useAgentModels).toHaveBeenCalledWith(true, sessionId, projectId);
    });
  });

  it.each([
    ['astrid', 'Astrid'], ['claude-code', 'Claude Code'], ['codex', 'Codex'],
  ])('starts a %s chat with a model from the service catalog', async (agent, name) => {
    const state = createState();
    state.createSession.mutateAsync.mockImplementationOnce(async () => {
      state.projectChats['project-1'] = {
        ...state.projectChats['project-1'],
        revision: 2,
        selected_session_id: 'codex:session-2',
        sessions: [{ id: 'session-1' }, { id: 'codex:session-2' }],
      };
      return { id: 'codex:session-2' };
    });
    mockFromState(state);
    mocks.useLocalAgents.mockImplementation(() => ({
      data: { agents: [{ id: agent, name, state: 'ready', line: null, models: [{ modelId: 'vendor/exact', name: 'Exact model' }], defaultModel: 'vendor/exact' }], defaultAgent: 'astrid' },
      isLoading: false, error: null, refetch: vi.fn(),
    }));

    renderAgentChat();
    const identity = await screen.findByTestId('agent-chat-identity');
    expect(identity).toHaveTextContent('Astrid · GPT 5');
    expect(screen.getByRole('button', { name: 'Astrid · GPT 5: model and thinking level' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    fireEvent.click(await screen.findByRole('button', { name: `Choose a ${name} model` }));
    expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('option', { name: /Exact model/ }));
    expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /^New chat ·/ }));
    await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalledWith({ operationId: expect.any(String), agent, defaultModelId: 'vendor/exact' }));
  });

  it('omits model information when no model is known', async () => {
    mockFromState(createState());
    mocks.useAgentModels.mockReturnValue({ data: undefined, isLoading: false });
    renderAgentChat();
    const identity = await screen.findByTestId('agent-chat-identity');
    expect(identity).toHaveTextContent(/^Astrid$/);
    expect(identity).toHaveAccessibleName('Astrid: model and thinking level');
  });

  it.each(['success', 'failure'] as const)('passes the chosen model and effort to startup and holds the composer (%s)', async outcome => {
    const state = createState();
    const oldId = 'codex:old';
    const newId = 'codex:new';
    state.projectChats['project-1'].selected_session_id = oldId;
    state.projectChats['project-1'].sessions = [{ id: oldId }];
    state.activeSessionData.id = oldId;
    let finishCreation!: () => void;
    state.createSession.mutateAsync.mockImplementationOnce(() => new Promise(yes => {
      finishCreation = () => {
        state.projectChats['project-1'].selected_session_id = newId;
        state.projectChats['project-1'].sessions.push({ id: newId });
        yes({ id: newId });
      };
    }));
    mockFromState(state);
    mocks.useAgentModels.mockReturnValue({ data: { providers: [], currentModel: null, localModels: {
      currentModelId: 'sol', availableModels: [{ modelId: 'sol', name: 'Sol' }], thoughtLevel: { configId: 'reasoning_effort', name: 'Effort', currentValue: 'low',
        recommendedValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    } }, isLoading: false });
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const selection = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
    mocks.useConfigureAgentSession.mockReturnValue({ mutateAsync: selection });
    mocks.useLocalAgents.mockReturnValue({ data: { defaultAgent: 'codex', agents: [{ id: 'codex', name: 'Codex', state: 'ready', line: null, models: [{ modelId: 'sol', name: 'Sol', thoughtLevel: { configId: 'reasoning_effort', name: 'Effort', currentValue: 'low', recommendedValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] } }], defaultModel: 'sol' }] }, refetch: vi.fn() });
    renderAgentChat();
    await screen.findByTestId('agent-chat-identity');
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Codex model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a thinking level for Sol' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    expect(selection).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose a thinking level for Sol' })).toHaveTextContent('Low');
    fireEvent.click(screen.getByRole('option', { name: /Sol/ }));
    expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /^New chat ·/ }));
    await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalledOnce());
    expect(selection).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBeDisabled();
    await act(async () => { finishCreation(); });
    await waitFor(() => expect(selection).toHaveBeenCalledWith({ sessionId: newId, model: 'sol', thoughtLevel: 'low' }));
    expect(screen.getByRole('textbox')).toBeDisabled();
    await act(async () => { if (outcome === 'success') resolve(); else reject(new Error('Effort rejected')); });
    if (outcome === 'failure') {
      expect(screen.getByRole('alert')).toHaveTextContent('Effort rejected');
      expect(screen.getByRole('textbox')).toBeDisabled();
    } else await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  });

  it.each(['success', 'failure'] as const)('locks the composer and shows the chosen agent during slow startup (%s)', async (outcome) => {
    const state = createState();
    state.activeSessionData.turns = [createUserTurn('Previous chat transcript', 1)];
    let resolve!: (value: { id: string }) => void;
    let reject!: (error: Error) => void;
    state.createSession.mutateAsync.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    mockFromState(state);
    mocks.useLocalAgents.mockReturnValue({
      data: { agents: [{ id: 'astrid', name: 'Astrid', state: 'ready', line: null, models: [], defaultModel: null }, { id: 'codex', name: 'Codex', state: 'ready', line: null, models: [{ modelId: 'sol', name: 'Sol', thoughtLevel: { configId: 'reasoning_effort', name: 'Effort', currentValue: 'low', recommendedValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] } }], defaultModel: 'sol' }], defaultAgent: 'astrid' },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    renderAgentChat();
    const input = await getInput();
    fireEvent.change(input, { target: { value: 'Retain this draft' } });
    expect(screen.getByText('Previous chat transcript')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a Codex model' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Sol/ }));
    expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /^New chat ·/ }));
    await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalled());
    vi.useFakeTimers();
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(24_000); });
      expect(screen.getByTestId('agent-chat-identity')).toHaveTextContent(/^Codex$/);
      expect(screen.queryByText('Previous chat transcript')).toBeNull();
      expect(input).toBeDisabled();
      expect(input).toHaveAttribute('placeholder', 'Starting Codex…');
      expect(input).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(window, { key: 'r', metaKey: true, shiftKey: true });
      expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();
      await act(async () => {
        if (outcome === 'failure') reject(new Error('Slow adapter failed'));
        else {
          state.projectChats['project-1'] = { ...state.projectChats['project-1'], revision: 2, selected_session_id: 'codex:session-2', sessions: [{ id: 'session-1' }, { id: 'codex:session-2' }] };
          state.activeSessionData = { ...state.activeSessionData, id: 'codex:session-2', turns: [] };
          resolve({ id: 'codex:session-2' });
        }
      });
      expect(input).not.toBeDisabled();
      expect(input).toHaveValue('Retain this draft');
      if (outcome === 'failure') {
        expect(screen.getByRole('alert')).toHaveTextContent("Codex didn't start.");
        expect(screen.getByTestId('agent-chat-identity')).toHaveTextContent(/^Astrid · GPT 5$/);
        expect(screen.getByText('Previous chat transcript')).toBeInTheDocument();
        expect(mocks.useAgentSession).toHaveBeenLastCalledWith('session-1', 'project-1');
      } else {
        expect(screen.getByTestId('agent-chat-identity')).toHaveTextContent(/^Codex · GPT 5$/);
        expect(screen.queryByText('Previous chat transcript')).toBeNull();
        expect(mocks.useAgentSession).toHaveBeenLastCalledWith('codex:session-2', 'project-1');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the default agent from + with no model, so the service repeats its remembered model', async () => {
    const state = createState();
    mockFromState(state);
    // An agent with no model list: its row only opens the drill-in, which offers the agent default (no model sent). Only + starts the chat.
    mocks.useLocalAgents.mockReturnValue({
      data: { defaultAgent: 'codex', agents: [{ id: 'codex', name: 'Codex', state: 'ready', line: null, models: [], defaultModel: null }] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    renderAgentChat();
    expect(screen.getByTestId('agent-chat-identity')).toHaveTextContent('Astrid · GPT 5');
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Codex/ }));
    fireEvent.click(await screen.findByRole('option', { name: "Use the agent's default model" }));
    expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /^New chat ·/ }));
    await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalledWith({ operationId: expect.any(String), agent: 'codex' }));
  });

  it('shows the failed agent start details and retries the same new chat', async () => {
    const state = createState();
    state.createSession.mutateAsync.mockRejectedValueOnce(new Error('adapter failed'));
    mockFromState(state);
    mocks.useLocalAgents.mockImplementation(() => ({
      data: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', line: null, models: [{ modelId: 'vendor/exact', name: 'Exact model' }], defaultModel: 'vendor/exact' }], defaultAgent: 'astrid' },
      isLoading: false, error: null, refetch: vi.fn(),
    }));

    renderAgentChat();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a Codex model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Exact model/ }));
    expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /^New chat ·/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Codex didn't start.");
    expect(alert).toHaveTextContent('Details: adapter failed');
    state.createSession.mutateAsync.mockResolvedValueOnce({ id: 'codex:session-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalledTimes(2));
    expect(state.createSession.mutateAsync.mock.calls[1]).toEqual(state.createSession.mutateAsync.mock.calls[0]);
  });

  it.each([
    ['provider auth failure', 'Provider authentication failed (401)'],
    ['provider balance failure', 'insufficient credits'],
    ['ordinary failure', 'Unexpected turn failure'],
    ['authoring failure', 'Element authoring failed'],
  ])('does not offer mid-chat model switching after %s', async (_label, message) => {
    const state = createState() as ReturnType<typeof createState> & { activeError?: Error };
    state.activeSessionData.status = 'error';
    state.activeError = new Error(message);
    mockFromState(state);
    renderAgentChat();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(screen.queryByRole('button', { name: 'Switch model' })).toBeNull();
  });

  it('keeps saying chat is unavailable once a conversation has turns: the same plain line, no alert', async () => {
    const state = createState() as ReturnType<typeof createState> & { activeError?: Error };
    state.activeSessionData.turns = [{ role: 'assistant', content: 'Earlier answer', timestamp: iso(1_000) }] as AgentTurn[];
    state.activeError = new BridgeRouteError('Read chat session', 503, { error: 'acp_unavailable' });
    mockFromState(state);
    renderAgentChat();
    expect(await screen.findByText('Earlier answer')).toBeInTheDocument();
    expect(screen.getByText("Chat isn't running on this computer right now.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('creates project chat without a timeline when engaged', async () => {
    const state = createState();
    state.timelineId = null;
    state.sessionsData = [];
    state.projectChats['project-1'].sessions = [];
    state.projectChats['project-1'].selected_session_id = null;
    state.createSession = {
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
    };
    mockFromState(state);

    const view = renderAgentChat();

    expect(screen.getByTestId('agent-chat-identity')).toHaveTextContent('Astrid');
    expect(screen.getByTestId('agent-chat-header').querySelector('img')).toBeNull();

    expect(screen.queryByText('Select a project to start chatting.')).not.toBeInTheDocument();
    await waitFor(() => expect(state.createSession.mutate).toHaveBeenCalledTimes(1));
    expect(mocks.useCreateSession).toHaveBeenCalledWith(null, 'project-1', 'ensure');
  });

  it('names the open chat in one menu trigger, with attach inside that menu in the narrow header', async () => {
    const state = createState();
    state.sessionsData = [
      { id: 'session-1', status: 'waiting_user' },
      { id: 'session-2', status: 'waiting_user' },
    ];
    state.projectChats['project-1'].sessions = [{ id: 'session-1' }, { id: 'session-2' }];
    mockFromState(state);
    const selectSession = vi.fn().mockResolvedValue(undefined);
    const onSelectorOpenChange = vi.fn();
    mocks.useSelectProjectSession.mockReturnValue({ mutateAsync: selectSession });

    render(<AgentChatPanel onSessionSelectorOpenChange={onSelectorOpenChange} />);

    const trigger = screen.getByRole('button', { name: 'Chat: Chat 1' });
    expect(trigger).toHaveClass('min-w-0', 'max-w-full');
    expect(screen.getByTestId('agent-chat-header')).toHaveClass('min-w-0');
    expect(trigger).toHaveTextContent('Chat 1');
    expect(screen.queryByText('session-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach existing' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();

    const user = userEvent.setup();
    await user.click(trigger);
    expect(await screen.findByPlaceholderText('Search chats…')).toBeInTheDocument();
    expect(onSelectorOpenChange).toHaveBeenLastCalledWith(true);
    expect(await screen.findByRole('option', { name: /^Chat 1/ })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /^Chat 2/ }));
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith({ expectedRevision: 1, sessionId: 'session-2' }));
    expect(onSelectorOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('downloads the complete active chat transcript as one Markdown file', async () => {
    const state = createState();
    state.projectChats['project-1'].sessions[0] = { id: 'session-1', title: 'Research: Chat 33' };
    state.activeSessionData.turns = [
      { role: 'user', content: 'The first message', timestamp: '2026-10-26T09:00:00.000Z' },
      { role: 'assistant', content: 'The first answer', timestamp: '2026-10-26T09:00:01.000Z' },
      { role: 'user', content: 'A later follow-up', timestamp: '2026-10-26T09:01:00.000Z' },
      { role: 'tool_call', content: 'Read the project', tool_name: 'Read', tool_call_id: 'read-1', tool_args: { path: 'notes.md' }, timestamp: '2026-10-26T09:01:01.000Z' },
      { role: 'tool_result', content: 'Project notes content', tool_call_id: 'read-1', tool_status: 'completed', timestamp: '2026-10-26T09:01:02.000Z' },
      { role: 'assistant', content: 'The later answer', timestamp: '2026-10-26T09:01:03.000Z' },
    ];
    state.activeSessionData.status = 'processing';
    Object.assign(state.activeSessionData, { assistantDraft: 'Assistant response in progress' });
    mockFromState(state);
    let captured: Blob | undefined;
    let filename = '';
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const create = vi.fn((blob: Blob) => { captured = blob; return 'blob:whole-chat'; });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download;
    });
    try {
      renderAgentChat();
      const downloadButton = screen.getByRole('button', { name: 'Download this chat' });
      expect(downloadButton).toBeEnabled();
      fireEvent.click(downloadButton);
      expect(create).toHaveBeenCalledTimes(1);
      expect(captured?.type).toBe('text/markdown;charset=utf-8');
      expect(filename).toMatch(/^research-chat-33-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsText(captured!);
      });
      expect(text).toContain('The first message');
      expect(text).toContain('The first answer');
      expect(text).toContain('A later follow-up');
      expect(text).toContain('Project notes content');
      expect(text).toContain('The later answer');
      expect(text).toContain('Turn count: 6');
      expect(text).toContain('In progress at capture: Yes');
      expect(text).toContain('Assistant response in progress');
      expect(text).toContain('Assistant (in progress at capture)');
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
    }
  });

  it('disables chat download when the active chat has no turns', () => {
    const state = createState();
    mockFromState(state);
    renderAgentChat();
    expect(screen.getByRole('button', { name: 'Download this chat' })).toBeDisabled();
  });

  it('uses registry titles and creation numbers even when inventory is reordered or missing a chat', async () => {
    const state = createState();
    state.sessionsData = [{ id: 'unregistered', status: 'waiting_user' }, { id: 'missing', status: 'waiting_user' }, { id: 'session-1', status: 'waiting_user' }];
    Object.assign(state.projectChats['project-1'], {
      selected_session_id: 'session-3', main_session_id: 'session-3',
      sessions: [{ id: 'session-1', title: 'Planning' }, { id: 'missing', missing: true }, { id: 'session-3' }],
    });
    mockFromState(state);
    const view = renderAgentChat();
    const selector = await screen.findByRole('button', { name: /^Chat: / });
    await waitFor(() => expect(selector).toHaveTextContent('Chat 3'));
    await userEvent.setup().click(selector);
    expect(screen.getAllByRole('option').filter(row => /^(Planning|Chat \d)/.test(row.textContent ?? '')).map(row => row.textContent)).toEqual([
      expect.stringContaining('Planning'), expect.stringContaining('Chat 3'),
    ]);
    state.sessionsData = [{ id: 'session-4', status: 'waiting_user' }, ...state.sessionsData];
    state.projectChats['project-1'].sessions.push({ id: 'session-4' });
    rerenderAgentChat(view.rerender);
    expect(selector).toHaveTextContent('Chat 3');
    expect(screen.getByRole('option', { name: /^Chat 4/ })).toBeInTheDocument();
  });

  it('opens on Main, preserves a local chat choice across refetch, and can promote that chat', async () => {
    const state = createState();
    state.sessionsData = [
      { id: 'session-1', status: 'waiting_user' },
      { id: 'session-2', status: 'waiting_user' },
    ];
    Object.assign(state.projectChats['project-1'], {
      selected_session_id: 'session-2',
      main_session_id: 'session-2',
      sessions: [{ id: 'session-1' }, { id: 'session-2' }],
    });
    mockFromState(state);
    const selectSession = vi.fn().mockResolvedValue(undefined);
    const setMainSession = vi.fn().mockResolvedValue(undefined);
    mocks.useSelectProjectSession.mockReturnValue({ mutateAsync: selectSession });
    mocks.useSetMainProjectSession.mockReturnValue({ isPending: false, mutateAsync: setMainSession });

    const view = renderAgentChat();
    const selector = await screen.findByRole('button', { name: /^Chat: / });
    await waitFor(() => expect(selector).toHaveTextContent('Chat 2'));

    const user = userEvent.setup();
    await user.click(selector);
    expect(within(await screen.findByRole('option', { name: /^Chat 2/ })).getByRole('img', { name: 'Main chat' })).toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /Chat 1/ }));
    await waitFor(() => expect(selector).toHaveTextContent('Chat 1'));

    view.rerender(<AgentChatPanel isExpanded={false} />);
    await waitFor(() => expect(selector).toHaveTextContent('Chat 1'));
    const priorSelectCount = selectSession.mock.calls.length;
    await user.click(selector);
    await user.click(screen.getByRole('button', { name: 'Make Chat 1 main' }));
    await waitFor(() => expect(setMainSession).toHaveBeenCalledWith({ expectedRevision: 1, sessionId: 'session-1' }));
    await waitFor(() => expect(selector).toHaveTextContent('Chat 1'));
    expect(selectSession).toHaveBeenCalledTimes(priorSelectCount);
    expect(screen.getByRole('option', { name: /Chat 1/ })).toBeInTheDocument();
  });

  it('waits for persisted selection when history resolves before the project registry', async () => {
    const state = createState();
    state.sessionsData = [
      { id: 'session-1', status: 'waiting_user' },
      { id: 'session-2', status: 'waiting_user' },
    ];
    Object.assign(state.projectChats['project-1'], {
      selected_session_id: 'session-1', main_session_id: 'session-2',
      sessions: [{ id: 'session-1' }, { id: 'session-2' }],
    });
    mockFromState(state);
    mocks.useProjectChat.mockReturnValue({ data: undefined, isLoading: true });
    const view = renderAgentChat();
    expect(screen.queryByRole('button', { name: 'Chat: Chat 1' })).toBeNull();
    expect(mocks.useAgentSession).not.toHaveBeenCalledWith('session-1', 'project-1');
    expect(state.createSession.mutate).not.toHaveBeenCalled();

    mocks.useProjectChat.mockReturnValue({ data: state.projectChats['project-1'], isLoading: false });
    view.rerender(<AgentChatPanel isExpanded={false} />);
    const selector = await screen.findByRole('button', { name: /^Chat: / });
    await waitFor(() => expect(selector).toHaveTextContent('Chat 1'));

    const user = userEvent.setup();
    await user.click(selector);
    await user.click(await screen.findByRole('option', { name: /Chat 2/ }));
    await waitFor(() => expect(selector).toHaveTextContent('Chat 2'));
    mocks.useProjectChat.mockReturnValue({ data: undefined, isLoading: true });
    view.rerender(<AgentChatPanel isExpanded={false} />);
    expect(selector).toHaveTextContent('Chat 2');
    mocks.useProjectChat.mockReturnValue({ data: state.projectChats['project-1'], isLoading: false });
    view.rerender(<AgentChatPanel isExpanded={false} />);
    expect(selector).toHaveTextContent('Chat 2');
  });

  it('reopens the persisted selected chat when Main is unset', async () => {
    const state = createState();
    state.sessionsData = [{ id: 'session-1', status: 'waiting_user' }];
    Object.assign(state.projectChats['project-1'], {
      selected_session_id: 'session-1', main_session_id: null, sessions: [{ id: 'session-1' }],
    });
    mockFromState(state);
    mocks.useProjectChat.mockReturnValue({ data: undefined, isLoading: true });
    const view = renderAgentChat();
    expect(mocks.useAgentSession).not.toHaveBeenCalledWith('session-1', 'project-1');
    expect(state.createSession.mutate).not.toHaveBeenCalled();

    mocks.useProjectChat.mockReturnValue({ data: state.projectChats['project-1'], isLoading: false });
    view.rerender(<AgentChatPanel isExpanded={false} />);
    const selector = await screen.findByRole('button', { name: /^Chat: / });
    await waitFor(() => expect(selector).toHaveTextContent('Chat 1'));
    expect(state.createSession.mutate).not.toHaveBeenCalled();
    expect(mocks.useAgentSession).toHaveBeenCalledWith('session-1', 'project-1');
  });

  it('keeps project chats selectable when Main is unset without creating a replacement Main', async () => {
    const state = createState();
    state.sessionsData = [{ id: 'session-1', status: 'waiting_user' }, { id: 'session-2', status: 'waiting_user' }];
    Object.assign(state.projectChats['project-1'], {
      selected_session_id: 'session-2', main_session_id: null, sessions: [{ id: 'session-1' }, { id: 'session-2' }],
    });
    mockFromState(state);
    const view = renderAgentChat();
    const selector = await screen.findByRole('button', { name: /^Chat: / });
    await waitFor(() => expect(selector).toHaveTextContent('Chat 2'));
    expect(state.createSession.mutate).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(selector);
    await user.click(await screen.findByRole('option', { name: /Chat 1/ }));
    await waitFor(() => expect(selector).toHaveTextContent('Chat 1'));
    const priorRevision = state.projectChats['project-1'].revision;
    state.projectChats['project-1'] = {
      ...state.projectChats['project-1'], selected_session_id: 'session-1', revision: priorRevision + 1,
    };
    view.rerender(<AgentChatPanel isExpanded={false} />);
    expect(selector).toHaveTextContent('Chat 1');
    await user.click(selector);
    expect(screen.getByRole('button', { name: 'Make Chat 1 main' })).toBeEnabled();
  });

  it('does not create or assign Main when existing project chats have no Main', async () => {
    mocks.panesState.isTasksPaneLocked = false;
    const state = createState();
    state.sessionsData = [{ id: 'session-1', status: 'waiting_user' }];
    Object.assign(state.projectChats['project-1'], { main_session_id: null });
    mockFromState(state);
    renderAgentChat();
    await waitFor(() => expect(mocks.useCreateSession).toHaveBeenCalledWith('timeline-1', 'project-1', 'ensure'));
    expect(state.createSession.mutate).not.toHaveBeenCalled();
    expect(state.projectChats['project-1'].main_session_id).toBeNull();
  });

  it('waits for authoritative project chat state before attempting Main creation', async () => {
    const state = createState();
    state.sessionsData = [];
    mockFromState(state);
    mocks.useProjectChat.mockReturnValue({ data: undefined, isLoading: true });
    renderAgentChat();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.createSession.mutate).not.toHaveBeenCalled();
  });

  it('restores the local project draft after switching A→B→A while the host save is pending', async () => {
    mocks.panesState.isTasksPaneLocked = false;
    const state = createState();
    state.sessionsData = [{ id: 'session-1', status: 'waiting_user' }];
    mockFromState(state);
    const view = renderAgentChat();
    const textbox = await getInput();
    fireEvent.change(textbox, { target: { value: 'A local draft' } });

    state.projectId = 'project-2';
    rerenderAgentChat(view.rerender);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'B draft' } });

    state.projectId = 'project-1';
    rerenderAgentChat(view.rerender);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('A local draft'));
    expect(state.projectChats['project-2'].draft.text).not.toBe('A local draft');
  });

  it('shows saved-chat load failures and retries only when the user clicks Retry saved chat', async () => {
    const state = createState();
    mockFromState(state);
    const refetch = vi.fn();
    mocks.useAgentSession.mockReturnValue({ data: undefined, error: new Error('ACP session not found: saved-chat'), isFetching: false, refetch });
    renderAgentChat();
    expect(await screen.findByText('ACP session not found: saved-chat')).toBeInTheDocument();
    expect(refetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved chat' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('uses four composer rows in split view and eight when chat fills the pane', async () => {
    const state = createState();
    mockFromState(state);

    const view = renderAgentChat();
    const textbox = await getInput();
    expect(textbox.tagName).toBe('TEXTAREA');
    expect(textbox).toHaveAttribute('rows', '4');

    view.rerender(<AgentChatPanel isExpanded />);
    expect(await screen.findByRole('textbox')).toHaveAttribute('rows', '8');
  });

  it('auto-creates a session when the engagement gate fires (pane locked) with a timeline available', async () => {
    const state = createState();
    state.sessionsData = [];
    state.projectChats['project-1'].sessions = [];
    state.projectChats['project-1'].selected_session_id = null;
    state.createSession = {
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ id: 'session-2' }),
    };
    mockFromState(state);

    renderAgentChat();

    await waitFor(() => expect(state.createSession.mutate).toHaveBeenCalledTimes(1));
  });

  it('keeps a pre-dispatch cancelled session eligible for normal selection', async () => {
    const state = createState();
    state.sessionsData = [
      { id: 'cancelled-session', status: 'cancelled' },
      { id: 'predispatch-cancel-session', status: 'waiting_user' },
    ];
    Object.assign(state.projectChats['project-1'], {
      selected_session_id: null, main_session_id: null,
      sessions: [{ id: 'cancelled-session' }, { id: 'predispatch-cancel-session' }],
    });
    mockFromState(state);

    renderAgentChat();

    await waitFor(() => expect(mocks.useAgentSession).toHaveBeenCalledWith('predispatch-cancel-session', 'project-1'));
  });

  it('does not auto-create when unengaged (pane unlocked, no markEngaged)', async () => {
    mocks.panesState.isTasksPaneLocked = false;
    const state = createState();
    state.sessionsData = [];
    state.createSession = {
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
    };
    mockFromState(state);

    renderAgentChat();

    // Give the auto-create effect time to NOT fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.createSession.mutate).not.toHaveBeenCalled();
  });

  it('offers no voice input: no mic control and Cmd+Shift+R is not captured', async () => {
    const state = createState();
    state.timelineId = null;
    state.sessionsData = [];
    mockFromState(state);

    renderAgentChat();

    expect(screen.queryByTitle(/voice input/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/recording/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/transcribing/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/queue next message|type a message/i)).toBeInTheDocument();

    const notCancelled = fireEvent.keyDown(window, {
      key: 'r',
      metaKey: true,
      shiftKey: true,
    });
    expect(notCancelled).toBe(true);
  });

  it('routes attachment removal through the composer intent', async () => {
    const state = createState();
    state.timelineClips = [
      createTimelineClip('clip-1'),
      createTimelineClip('clip-2'),
    ];
    mockFromState(state);

    renderAgentChat();

    fireEvent.click(screen.getByRole('button', { name: 'remove-clip-1' }));

    expect(mocks.composerRemoveAttachment).toHaveBeenCalledWith(expect.objectContaining({
      clipId: 'clip-1',
      url: 'https://example.com/clip-1.png',
      mediaType: 'image',
    }));
  });

  it('allows typing while processing and queues without sending immediately', async () => {
    const state = createState();
    state.activeSessionData.status = 'processing';
    mockFromState(state);

    renderAgentChat();

    const textbox = await getInput();
    expect(textbox).not.toBeDisabled();

    await queueMessage(textbox, 'queued while processing');

    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText('queued while processing')).toBeInTheDocument();
  });

  it('stops one turn, clears queued messages, and keeps the same chat ready for the next turn', async () => {
    const state = createState();
    state.activeSessionData.status = 'processing';
    state.activeSessionData.turns = [{
      role: 'tool_call', content: 'Read a file', tool_call_id: 'running-tool', tool_status: 'in_progress', timestamp: iso(1_000),
    }];
    state.cancelSession.mutate = vi.fn(() => {
      state.activeSessionData.status = 'waiting_user';
      state.activeSessionData.turns.push({
        role: 'tool_result', content: 'Stopped.', tool_call_id: 'running-tool', tool_status: 'cancelled', timestamp: iso(2_000),
      });
    });
    mockFromState(state);

    const view = renderAgentChat();

    const textbox = await getInput();
    await queueMessage(textbox, 'queued while the turn runs');
    expect(getQueuedTexts()).toEqual(['queued while the turn runs']);

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(state.cancelSession.mutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle('Stop agent')).toBeNull();
    await waitFor(() => expect(getQueuedTexts()).toEqual([]));
    rerenderAgentChat(view.rerender);

    expect(await getInput()).toBeEnabled();
    expect(screen.queryByText('Session stopped. Start a new conversation to continue.')).toBeNull();
    expect(state.activeSessionData.id).toBe('session-1');
    expect(state.activeSessionData.turns.find(turn => turn.role === 'tool_result')?.tool_status).toBe('cancelled');

    await queueMessage(await getInput(), 'continue in the same chat');
    await waitFor(() => expect(state.sendMessage.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ message: 'continue in the same chat' }),
      sessionId: 'session-1',
      projectId: 'project-1',
    })));
  });

  it('keeps a message in the transcript and out of queue rows while its optimistic send is in flight', async () => {
    const state = createState();
    let finishSend = () => {};
    const pendingSend = new Promise<void>(resolve => { finishSend = resolve; });
    state.sendMessage.mutateAsync = vi.fn(() => pendingSend);
    mockFromState(state);

    renderAgentChat();

    await queueMessage(await getInput(), 'sending now');
    await waitFor(() => expect(state.sendMessage.mutateAsync).toHaveBeenCalledTimes(1));

    expect(screen.getByText('sending now')).toBeInTheDocument();
    expect(getQueuedTexts()).toEqual([]);

    await act(async () => { finishSend(); });
  });

  it('auto-sends the queued head with attachments snapshotted at queue time', async () => {
    const state = createState();
    state.activeSessionData.status = 'processing';
    state.timelineClips = [createTimelineClip('clip-1')];
    mockFromState(state);

    const view = renderAgentChat();
    const textbox = await getInput();

    await queueMessage(textbox, 'send old attachment');
    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();

    state.timelineClips = [createTimelineClip('clip-2')];
    state.activeSessionData.status = 'waiting_user';
    rerenderAgentChat(view.rerender);

    await waitFor(() => {
      expect(state.sendMessage.mutateAsync).toHaveBeenCalledWith({
        input: { message: 'send old attachment', attachments: [expect.objectContaining({ clipId: 'clip-1' })], requestId: expect.any(String) },
        projectId: 'project-1',
        sessionId: 'session-1',
        context: expect.objectContaining({ projectId: 'project-1' }),
      });
    });
  });

  it('settles optimism after completion without requiring an echoed user turn', async () => {
    const state = createState();
    state.activeSessionData.status = 'processing';
    state.activeSessionData.turns = [createUserTurn('same text', 9_000)];
    mockFromState(state);
    const view = renderAgentChat();
    const textbox = await getInput();
    await queueMessage(textbox, 'same text');
    await queueMessage(textbox, 'same text');
    state.activeSessionData.status = 'waiting_user';
    rerenderAgentChat(view.rerender);
    await waitFor(() => expect(state.sendMessage.mutateAsync).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  it('keeps a failed head queued, shows an error, and only resumes draining after the failed head is removed', async () => {
    const state = createState();
    state.activeSessionData.status = 'processing';
    state.sendMessage.mutateAsync = vi.fn().mockImplementation(async ({ input: { message, requestId } }: { input: { message: string; requestId: string } }) => {
      if (message === 'first queued') {
        state.activeSessionData.turns = [{ role: 'user', content: message, timestamp: iso(13_000), request_id: requestId }];
        state.sendMessage.localError = 'Send failed';
        throw new Error('Send failed');
      }

      return undefined;
    });
    mockFromState(state);

    const view = renderAgentChat();
    const textbox = await getInput();

    await queueMessage(textbox, 'first queued');
    await queueMessage(textbox, 'second queued');

    state.activeSessionData.status = 'waiting_user';
    rerenderAgentChat(view.rerender);

    await waitFor(() => expect(state.sendMessage.mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Send failed')).toBeInTheDocument());
    expect(getQueuedTexts()).toEqual(['first queued', 'second queued']);

    fireEvent.click(screen.getAllByTitle('Remove queued message')[0]);

    await waitFor(() => {
      expect(state.sendMessage.mutateAsync).toHaveBeenNthCalledWith(2, {
        input: { message: 'second queued', attachments: [], requestId: expect.any(String) },
        projectId: 'project-1',
        sessionId: 'session-1',
        context: expect.objectContaining({ projectId: 'project-1' }),
      });
    });
  });

  it('keeps the original empty prompt visible while failed queued work is paused', async () => {
    const state = createState();
    state.activeSessionData.status = 'processing';
    state.sendMessage.mutateAsync = vi.fn().mockImplementation(async () => {
      state.sendMessage.localError = 'Send failed';
      throw new Error('Send failed');
    });
    mockFromState(state);

    const view = renderAgentChat();
    const textbox = await getInput();
    await queueMessage(textbox, 'failed queued message');

    state.activeSessionData.status = 'waiting_user';
    rerenderAgentChat(view.rerender);

    await waitFor(() => expect(screen.getByText('Send failed')).toBeInTheDocument());
    expect(screen.getByText('✨ I can do almost anything')).toBeInTheDocument();
    expect(screen.getByText('failed queued message')).toBeInTheDocument();
  });

  it('rebinds a failed Claude first-message queue row to its recovered empty session and drains it once', async () => {
    const state = createState();
    const oldSessionId = 'claude-code:vanished-empty';
    const recoveredSessionId = 'claude-code:recovered-empty';
    state.projectChats['project-1'].selected_session_id = oldSessionId;
    state.projectChats['project-1'].sessions = [{ id: oldSessionId, pending_first_message: true }];
    state.activeSessionData.id = oldSessionId;
    state.activeSessionData.status = 'processing';
    state.sessionsData = [{ id: oldSessionId, status: 'processing' }];
    state.timelineClips = [createTimelineClip('clip-queued-before-recovery')];
    state.sendMessage.mutateAsync = vi.fn()
      .mockRejectedValueOnce(new Error('The original empty chat disappeared'))
      .mockResolvedValue(undefined);
    mockFromState(state);
    mocks.useLocalAgents.mockReturnValue({
      data: { defaultAgent: 'claude-code', agents: [{ id: 'claude-code', name: 'Claude Code', state: 'ready', line: null, models: [], defaultModel: null }] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    const persistedQueueSessionIds: string[][] = [];
    mocks.useSaveProjectDraft.mockImplementation(() => ({ mutateAsync: vi.fn().mockImplementation(async (input: { text: string; queuedMessages: Array<{ id: string; text: string; session_id: string; attachments?: unknown[] }> }) => {
      persistedQueueSessionIds.push(input.queuedMessages.map(row => row.session_id));
      const chat = state.projectChats['project-1'];
      chat.draft = { text: input.text, revision: chat.draft.revision + 1, queued_messages: input.queuedMessages };
      return chat;
    }) }));

    const view = renderAgentChat();
    const textbox = await getInput();
    await queueMessage(textbox, 'continue the first task');
    await waitFor(() => expect(state.projectChats['project-1'].draft.queued_messages).toHaveLength(1));
    const savedRow = state.projectChats['project-1'].draft.queued_messages[0]!;
    expect(savedRow.session_id).toBe(oldSessionId);
    expect(savedRow.attachments).toEqual([expect.objectContaining({ clipId: 'clip-queued-before-recovery' })]);

    state.activeSessionData.status = 'waiting_user';
    rerenderAgentChat(view.rerender);
    await waitFor(() => expect(state.sendMessage.mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Not sent. Delivery not confirmed: Send now checks saved history first, and may send this message again.')).toBeInTheDocument());

    // The bridge has replaced the missing session with a same-agent empty session
    // and atomically remapped the durable queue row to that ID.
    const chat = state.projectChats['project-1'];
    const savesBeforeRecovery = persistedQueueSessionIds.length;
    state.projectChats['project-1'] = {
      ...chat,
      revision: chat.revision + 1,
      selected_session_id: recoveredSessionId,
      main_session_id: recoveredSessionId,
      sessions: [{ id: recoveredSessionId, pending_first_message: true }],
      draft: {
        ...chat.draft,
        revision: chat.draft.revision + 1,
        queued_messages: chat.draft.queued_messages.map(row => ({ ...row, session_id: recoveredSessionId })),
      },
    };
    state.activeSessionData.id = recoveredSessionId;
    state.activeSessionData.status = 'waiting_user';
    state.sessionsData = [{ id: recoveredSessionId, status: 'waiting_user' }];
    rerenderAgentChat(view.rerender);

    await waitFor(() => expect(state.sendMessage.mutateAsync).toHaveBeenCalledTimes(2));
    expect(state.sendMessage.mutateAsync).toHaveBeenNthCalledWith(2, {
      input: {
        message: savedRow.text,
        attachments: [expect.objectContaining({ clipId: 'clip-queued-before-recovery' })],
        requestId: savedRow.id,
      },
      projectId: 'project-1',
      sessionId: recoveredSessionId,
      context: expect.objectContaining({ projectId: 'project-1' }),
    });
    await waitFor(() => expect(state.projectChats['project-1'].draft.queued_messages).toHaveLength(0));
    expect(state.sendMessage.mutateAsync).toHaveBeenCalledTimes(2);
    expect(persistedQueueSessionIds.slice(savesBeforeRecovery).flat()).not.toContain(oldSessionId);
  });

  it.each([
    ['ordinary saved queue update', false] as const,
    ['recovered started chat', true] as const,
  ])('%s does not unpause or rebind a failed queued row', async (scenario, startedChat) => {
    const state = createState();
    const oldSessionId = 'claude-code:vanished-empty';
    const otherSessionId = 'claude-code:other';
    state.projectChats['project-1'].selected_session_id = oldSessionId;
    state.projectChats['project-1'].sessions = [{ id: oldSessionId, pending_first_message: true }];
    state.activeSessionData.id = oldSessionId;
    state.activeSessionData.status = 'processing';
    state.sessionsData = [{ id: oldSessionId, status: 'processing' }];
    state.sendMessage.mutateAsync = vi.fn().mockRejectedValue(new Error('The original empty chat disappeared'));
    mockFromState(state);
    mocks.useLocalAgents.mockReturnValue({
      data: { defaultAgent: 'claude-code', agents: [{ id: 'claude-code', name: 'Claude Code', state: 'ready', line: null, models: [], defaultModel: null }] },
      isLoading: false, error: null, refetch: vi.fn(),
    });

    const view = renderAgentChat();
    const textbox = await getInput();
    await queueMessage(textbox, 'keep this safely queued');
    await waitFor(() => expect(state.projectChats['project-1'].draft.queued_messages).toHaveLength(1));
    const savedRow = state.projectChats['project-1'].draft.queued_messages[0]!;
    state.activeSessionData.status = 'waiting_user';
    rerenderAgentChat(view.rerender);
    await waitFor(() => expect(state.sendMessage.mutateAsync).toHaveBeenCalledTimes(1));

    const chat = state.projectChats['project-1'];
    state.projectChats['project-1'] = {
      ...chat,
      revision: chat.revision + 1,
      selected_session_id: startedChat ? otherSessionId : oldSessionId,
      main_session_id: startedChat ? otherSessionId : chat.main_session_id,
      sessions: startedChat
        ? [{ id: otherSessionId, pending_first_message: false }]
        : [{ id: oldSessionId, pending_first_message: true }],
      draft: {
        ...chat.draft,
        revision: chat.draft.revision + 1,
        queued_messages: startedChat
          ? chat.draft.queued_messages.map(row => ({ ...row, session_id: otherSessionId }))
          : chat.draft.queued_messages.map(row => ({ ...row, text: `${scenario}: ${row.text}` })),
      },
    };
    state.activeSessionData.id = startedChat ? otherSessionId : oldSessionId;
    state.activeSessionData.status = 'waiting_user';
    state.sessionsData = [{ id: state.projectChats['project-1'].selected_session_id!, status: 'waiting_user' }];
    rerenderAgentChat(view.rerender);

    await new Promise(resolve => setTimeout(resolve, 450));
    expect(state.sendMessage.mutateAsync).toHaveBeenCalledTimes(1);
    expect(state.projectChats['project-1'].draft.queued_messages).toHaveLength(1);
    expect(state.projectChats['project-1'].draft.queued_messages[0]?.session_id).toBe(startedChat ? otherSessionId : oldSessionId);
    expect(state.projectChats['project-1'].draft.queued_messages[0]?.id).toBe(savedRow.id);
  });

  it('reorders and deletes queued messages in the rendered stack', async () => {
    const state = createState();
    state.activeSessionData.status = 'processing';
    mockFromState(state);

    renderAgentChat();

    const textbox = await getInput();

    await queueMessage(textbox, 'first');
    await queueMessage(textbox, 'second');
    await queueMessage(textbox, 'third');

    expect(getQueuedTexts()).toEqual(['first', 'second', 'third']);

    fireEvent.click(screen.getAllByTitle('Move queued message down')[0]);
    expect(getQueuedTexts()).toEqual(['second', 'first', 'third']);

    fireEvent.click(screen.getAllByTitle('Remove queued message')[1]);
    expect(getQueuedTexts()).toEqual(['second', 'third']);
  });

  it('keeps an active foreign request read-only through takeover and completion without replaying saved queue work', async () => {
    const state = createState();
    state.projectChats['project-1'].draft = { text: 'Saved text', revision: 4, queued_messages: [
      { id: 'active-request', text: 'Already running', session_id: 'session-1', attachments: [] },
      { id: 'queued-next', text: 'Waiting behind it', session_id: 'session-1', attachments: [] },
    ] };
    state.activeSessionData.status = 'waiting_user'; // Control data must still report the live turn.
    state.activeSessionData.turns = [
      { role: 'user', content: 'Already running', timestamp: iso(11_000), request_id: 'active-request' },
      { role: 'assistant', content: 'Live assistant update', timestamp: iso(12_000) },
    ];
    state.activeSessionData.control = { role: 'follower', active: true, activeRequestId: 'active-request' };
    state.activeSessionData.durableAcceptedRequestIds = ['active-request'];
    mockFromState(state);

    const view = renderAgentChat();
    await screen.findByText('Live assistant update');
    await screen.findByText('Already running');
    expect(screen.queryByText('In progress in another tab')).toBeNull();
    expect(screen.getByRole('button', { name: 'Active in another tab — take over' })).toBeEnabled();
    expect(screen.getByPlaceholderText('Type to queue next message...')).toBeDisabled();
    expect(screen.queryByText(/Delivery not confirmed/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    expect(screen.queryByTitle('Stop agent')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Agent model' })).toBeNull();
    expect(getQueuedTexts()).toEqual(['Waiting behind it']);
    expect(state.projectChats['project-1'].draft.queued_messages.map(row => row.id)).toEqual(['active-request', 'queued-next']);
    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();
    expect(mocks.useTakeOverSession).toHaveBeenCalledWith('session-1', 'project-1');

    fireEvent.click(screen.getByRole('button', { name: 'Active in another tab — take over' }));
    expect(state.takeOverSession.mutate).toHaveBeenCalledTimes(1);

    state.activeSessionData.control = { role: 'writer', active: true, activeRequestId: 'active-request' };
    rerenderAgentChat(view.rerender);
    expect(await screen.findByText('Already running')).toBeInTheDocument();
    expect(screen.queryByText('In progress')).toBeNull();
    expect(getQueuedTexts()).toEqual(['Waiting behind it']);
    expect(screen.queryByRole('button', { name: 'Active in another tab — take over' })).toBeNull();
    expect(screen.queryByText(/Delivery not confirmed/)).toBeNull();
    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();

    state.activeSessionData.control = { role: 'writer', active: false, activeRequestId: null };
    state.activeSessionData.status = 'waiting_user';
    rerenderAgentChat(view.rerender);
    await waitFor(() => expect(state.projectChats['project-1'].draft.queued_messages.map(row => row.id)).toEqual(['queued-next']));
    expect(getQueuedTexts()).toEqual(['Waiting behind it']);
    expect(screen.getByText(/Delivery not confirmed/)).toBeInTheDocument();
    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();

    // Another tab may take ownership after this panel has completed its takeover.
    state.activeSessionData.control = { role: 'follower', active: false, activeRequestId: null };
    rerenderAgentChat(view.rerender);
    expect(screen.getByRole('button', { name: 'Active in another tab — take over' })).toBeEnabled();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    expect(screen.getByTitle('Remove queued message')).toBeDisabled();
    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the active external session model to a follower with takeover available', async () => {
    const state = createState();
    const sessionId = 'codex:chat-3';
    state.projectChats['project-1'].selected_session_id = sessionId;
    state.projectChats['project-1'].sessions = [{ id: sessionId }];
    state.sessionsData = [{ id: sessionId, status: 'waiting_user' }];
    state.activeSessionData.id = sessionId;
    state.activeSessionData.status = 'waiting_user';
    state.activeSessionData.control = { role: 'follower', active: false, activeRequestId: null };
    mockFromState(state);

    const localModels = { currentModelId: 'vendor/alpha-precise', availableModels: [
      { modelId: 'vendor/alpha-precise', name: 'Alpha Precise', description: 'Careful code review' },
      { modelId: 'vendor/beta-fast', name: 'Beta Fast', description: 'Quick drafts' },
    ] };
    mocks.useAgentModels.mockReturnValue({
      data: { currentModel: null, providers: [], localModels },
      isLoading: false,
      error: null,
      refetch: mocks.modelRefetch,
    });

    renderAgentChat();
    const identity = screen.getByTestId('agent-chat-identity');
    expect(identity).toHaveTextContent('Codex · Alpha Precise');
    expect(screen.queryByRole('combobox', { name: 'Agent model' })).toBeNull();
    expect(mocks.useAgentModels).toHaveBeenCalledWith(true, sessionId, 'project-1');
    expect(screen.getByRole('button', { name: 'Active in another tab — take over' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Active in another tab — take over' }));
    expect(state.takeOverSession.mutate).toHaveBeenCalledTimes(1);

    await userEvent.setup().click(screen.getByTestId('agent-chat-identity'));
    const panel = await screen.findByRole('dialog', { name: 'Model and thinking level' });
    expect(within(panel).getByText('Codex · Alpha Precise')).toBeInTheDocument();
    expect(within(panel).getByText('A chat keeps its model.')).toBeInTheDocument();
  });
  describe('model line and chat menu', () => {
    const effortModels = () => ({ data: { currentModel: null, providers: [], localModels: {
      currentModelId: 'openai/gpt-5', availableModels: [{ modelId: 'openai/gpt-5', name: 'GPT 5' }],
      thoughtLevel: { configId: 'reasoning_effort', name: 'Effort', currentValue: 'low', recommendedValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    } }, isLoading: false, error: null, refetch: mocks.modelRefetch });
    const panelOf = () => screen.findByRole('dialog', { name: 'Model and thinking level' });

    it('shows the chat menu trigger even with a single chat', async () => {
      mockFromState(createState());
      renderAgentChat();
      expect(await screen.findByRole('button', { name: 'Chat: Chat 1' })).toBeInTheDocument();
    });

    it('sets the open chat\'s thinking level through its session configuration', async () => {
      const state = createState();
      mockFromState(state);
      const selection = vi.fn().mockResolvedValue(undefined);
      mocks.useConfigureAgentSession.mockReturnValue({ mutateAsync: selection });
      mocks.useAgentModels.mockReturnValue(effortModels());
      renderAgentChat();
      fireEvent.click(await screen.findByTestId('agent-chat-identity'));
      fireEvent.click(within(await panelOf()).getByRole('option', { name: /High/ }));
      await waitFor(() => expect(selection).toHaveBeenCalledWith({ sessionId: 'session-1', thoughtLevel: 'high' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model and thinking level' })).toBeNull());
    });

    it.each([
      ['a reply in progress', (state: ReturnType<typeof createState>) => { state.activeSessionData.status = 'processing'; }],
      ['a send still pending', (state: ReturnType<typeof createState>) => { state.sendMessage.isPending = true; }],
    ])('locks the thinking options while %s', async (_label, setup) => {
      const state = createState();
      setup(state);
      mockFromState(state);
      mocks.useAgentModels.mockReturnValue(effortModels());
      renderAgentChat();
      fireEvent.click(await screen.findByTestId('agent-chat-identity'));
      const panel = within(await panelOf());
      expect(panel.getByText('The thinking level can change once this reply finishes.')).toBeInTheDocument();
      expect(panel.getByRole('option', { name: /High/ })).toHaveAttribute('aria-disabled', 'true');
    });

    it('asks a follower tab to take over before changing the thinking level', async () => {
      const state = createState();
      state.activeSessionData.control = { role: 'follower', active: false, activeRequestId: null };
      mockFromState(state);
      mocks.useAgentModels.mockReturnValue(effortModels());
      renderAgentChat();
      fireEvent.click(await screen.findByTestId('agent-chat-identity'));
      const panel = within(await panelOf());
      expect(panel.getByText('Take over this chat to change its thinking level.')).toBeInTheDocument();
      expect(panel.getByRole('option', { name: /High/ })).toHaveAttribute('aria-disabled', 'true');
    });

    it('opens the new-chat menu on the chat\'s agent models from "Change model for new chats"', async () => {
      mockFromState(createState());
      renderAgentChat();
      fireEvent.click(await screen.findByTestId('agent-chat-identity'));
      fireEvent.click(within(await panelOf()).getByRole('option', { name: 'Change model for new chats' }));
      expect(await screen.findByPlaceholderText('Search Astrid models…')).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'New chat' })).toBeInTheDocument();
    });

    it('reports the header overlay open while the chat menu, the model line or the new-chat picker is open', async () => {
      mockFromState(createState());
      const onSelectorOpenChange = vi.fn();
      render(<AgentChatPanel onSessionSelectorOpenChange={onSelectorOpenChange} />);
      const user = userEvent.setup();
      fireEvent.click(await screen.findByRole('button', { name: 'Chat: Chat 1' }));
      expect(onSelectorOpenChange).toHaveBeenLastCalledWith(true);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(onSelectorOpenChange).toHaveBeenLastCalledWith(false));
      fireEvent.click(screen.getByTestId('agent-chat-identity'));
      expect(onSelectorOpenChange).toHaveBeenLastCalledWith(true);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(onSelectorOpenChange).toHaveBeenLastCalledWith(false));
      fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
      expect(onSelectorOpenChange).toHaveBeenLastCalledWith(true);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(onSelectorOpenChange).toHaveBeenLastCalledWith(false));
    });

    it('starts a new chat with the open chat\'s agent from the + button', async () => {
      const state = createState();
      mockFromState(state);
      renderAgentChat();
      fireEvent.click(await screen.findByRole('button', { name: /^New chat · Astrid/ }));
      await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ agent: 'astrid' })));
    });

    it('keeps no-key Astrid setup inside the open new-chat model panel', async () => {
      const state = createState();
      mockFromState(state);
      mocks.useLocalAgents.mockReturnValue({
        data: { defaultAgent: 'astrid', agents: [{ id: 'astrid', name: 'Astrid', state: 'ready', signIn: 'signed-in', line: null, models: [], defaultModel: null }] },
        isLoading: false, error: null, refetch: vi.fn().mockResolvedValue(undefined),
      });
      renderAgentChat();
      fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
      fireEvent.click(screen.getByRole('button', { name: 'Choose a Astrid model' }));
      expect(await screen.findByLabelText('OpenRouter key')).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'New chat' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'How do you want Astrid to think?' })).toBeNull();
      expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    });
  });
});


describe('project-only Astrid chat', () => {
  it('enables sending in a project without a timeline and forwards its explicit context', async () => {
    const state = createState();
    state.timelineId = null;
    mockFromState(state);
    const context = { tool: 'video-editor', projectId: 'project-1', projectSlug: 'first', timelineId: null, timelineName: null };
    mocks.useAgentChatBridge.mockReturnValue({ timelineId: null, editorContext: context });
    render(<AgentChatPanel isExpanded />);
    const composer = screen.getByPlaceholderText('Type a message...');
    expect(composer).not.toBeDisabled();
    fireEvent.change(composer, { target: { value: 'Remember model B for this project' } });
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(state.sendMessage.mutateAsync).toHaveBeenCalled());
    expect(mocks.useAgentSessions).toHaveBeenCalledWith(null, 'project-1');
    expect(mocks.useCreateSession).toHaveBeenCalledWith(null, 'project-1', 'ensure');
    expect(mocks.useSendMessage).toHaveBeenCalledWith('session-1', context, 'project-1');
  });
});


describe('project draft consumer ownership', () => {
  it('hydrates each project draft/queue, flushes to its original owner on switch, and reopens retained local text', async () => {
    vi.clearAllMocks();
    mocks.panesState.isTasksPaneLocked = true;
    const state = createState();
    state.activeSessionData.status = 'processing';
    mockFromState(state);
    const context = (projectId: string) => ({ tool: 'video-editor' as const, projectId, projectSlug: projectId, timelineId: null, timelineName: null });
    let currentProject = 'draft-owner-a';
    mocks.useAgentChatBridge.mockImplementation(() => ({ timelineId: null, editorContext: context(currentProject) }));
    const drafts = new Map(['draft-owner-a', 'draft-owner-b'].map((projectId) => [projectId, {
      project_id: projectId, scope_key: `realm:store:${projectId}`, revision: 1,
      selected_session_id: `session-${projectId}`, sessions: [{ id: `session-${projectId}` }],
      draft: { text: `saved ${projectId}`, revision: 3, queued_messages: [
        { id: `queue-${projectId}`, text: `queued ${projectId}`, session_id: `session-${projectId}`, attachments: [] },
      ] },
    }]));
    mocks.useProjectChat.mockImplementation((projectId: string) => ({ data: drafts.get(projectId), refetch: vi.fn() }));
    mocks.useAgentSessions.mockImplementation((_timelineId: null, projectId: string) => ({ data: [{ id: `session-${projectId}`, status: 'processing' }], isLoading: false }));
    const saved: Array<{ projectId: string; text: string; queuedMessages: Array<{ session_id: string }> }> = [];
    mocks.useSaveProjectDraft.mockImplementation((projectId: string) => ({ isPending: false, mutateAsync: vi.fn(async (input: {
      expectedRevision: number; text: string; queuedMessages: Array<{ id: string; text: string; session_id: string; attachments: never[] }>;
    }) => {
      saved.push({ projectId, text: input.text, queuedMessages: input.queuedMessages });
      const previous = drafts.get(projectId)!;
      const next = { ...previous, draft: { text: input.text, revision: input.expectedRevision + 1, queued_messages: input.queuedMessages } };
      drafts.set(projectId, next); return next;
    }) }));
    const view = renderAgentChat();
    try {
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('saved draft-owner-a'));
      expect(getQueuedTexts()).toEqual(['queued draft-owner-a']);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'local text for A' } });
      currentProject = 'draft-owner-b';
      rerenderAgentChat(view.rerender);
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('saved draft-owner-b'));
      await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ projectId: 'draft-owner-a', text: 'local text for A' })));
      expect(getQueuedTexts()).toEqual(['queued draft-owner-b']);
      expect(mocks.useSendMessage).toHaveBeenCalledWith('session-draft-owner-b', context('draft-owner-b'), 'draft-owner-b');
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'local text for B' } });
      currentProject = 'draft-owner-a';
      rerenderAgentChat(view.rerender);
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('local text for A'));
      await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ projectId: 'draft-owner-b', text: 'local text for B' })));
      expect(getQueuedTexts()).toEqual(['queued draft-owner-a']);
      expect(saved.every(({ projectId, queuedMessages }) => queuedMessages.every(item => item.session_id === `session-${projectId}`))).toBe(true);
      expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it.each(['plain', 'another agent'])('keeps New (%s) on the new registry snapshot while the sessions cache is stale', async (choice) => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView ??= vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1; });
    const state = createState();
    mockFromState(state);
    const openPane = vi.fn();
    mocks.panesState.setIsTasksPaneLocked = openPane;
    state.projectChats['project-1'] = { ...state.projectChats['project-1'], main_session_id: 'session-1' } as typeof state.projectChats['project-1'];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ['project-agent-chat', 'project-1'];
    client.setQueryData(key, state.projectChats['project-1']);
    mocks.useProjectChat.mockImplementation(() => useQuery({ queryKey: key, queryFn: async () => state.projectChats['project-1'], enabled: false }));
    mocks.useLocalAgents.mockReturnValue({ data: { agents: [{ id: 'astrid', name: 'Astrid', state: 'ready', line: null, models: [], defaultModel: null }, { id: 'codex', name: 'Codex', state: 'ready', line: null, models: choice === 'plain' ? [] : [{ modelId: 'codex-default', name: 'Codex Default' }], defaultModel: choice === 'plain' ? null : 'codex-default' }], defaultAgent: 'astrid' }, refetch: vi.fn() });
    let finish!: (session: { id: string }) => void;
    state.createSession.mutateAsync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const newId = choice === 'plain' ? 'session-2' : 'codex:session-2';
    mocks.useAgentSession.mockImplementation((id: string) => ({ data: { id, status: 'waiting_user', turns: [] }, isLoading: false }));
    const view = render(<QueryClientProvider client={client}><AgentChatPanel /></QueryClientProvider>);
    const composer = screen.getByRole('textbox');
    fireEvent.change(composer, { target: { value: 'Keep my unsent draft' } });
    await waitFor(() => expect(mocks.useAgentSession).toHaveBeenLastCalledWith('session-1', 'project-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    if (choice === 'plain') {
      fireEvent.click(await screen.findByRole('option', { name: /^Codex/ }));
      fireEvent.click(await screen.findByRole('option', { name: "Use the agent's default model" }));
    }
    else {
      fireEvent.click(await screen.findByRole('button', { name: 'Choose a Codex model' }));
      fireEvent.click(await screen.findByRole('option', { name: /Codex Default/ }));
    }
    expect(state.createSession.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /^New chat ·/ }));
    await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalledOnce());
    // useCreateSession publishes its registry receipt before handleNewSession's
    // local selection applies. Commit that snapshot while the separate 5s
    // sessions query still contains only Chat 1, with no creation receipt in UI state.
    const created = {
      ...state.projectChats['project-1'],
      selected_session_id: newId,
      main_session_id: newId,
      sessions: [{ id: 'session-1' }, { id: newId }],
      revision: state.projectChats['project-1'].revision + 1,
    };
    await act(async () => { client.setQueryData(key, created); });
    const selector = screen.getByRole('button', { name: 'Chat: New chat' });
    expect(selector).toBeDisabled();
    await act(async () => { finish({ id: newId }); });
    expect(selector).not.toBeDisabled();
    expect(composer).toHaveFocus();
    fireEvent.click(selector);
    expect(within(await screen.findByRole('option', { name: /^Chat 2/ })).getByRole('img', { name: 'Main chat' })).toBeInTheDocument();
    fireEvent.click(selector);
    await waitFor(() => expect(mocks.useAgentSession).toHaveBeenLastCalledWith(newId, 'project-1'));
    expect(selector).toHaveTextContent('Chat 2');
    view.rerender(<QueryClientProvider client={client}><AgentChatPanel isExpanded /></QueryClientProvider>);
    expect(mocks.useAgentSession).toHaveBeenLastCalledWith(newId, 'project-1');
    expect(state.createSession.mutate).not.toHaveBeenCalled();
    expect(composer).toHaveValue('Keep my unsent draft');
    expect(openPane).toHaveBeenCalledWith(true);
    expect(state.sessionsData).toEqual([
      { id: 'session-1', status: 'waiting_user' },
    ]);
    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });
  it.each([false, true])('ignores a delayed New completion after a project transition (return to origin: %s)', async (returnToOrigin) => {
    const state = createState();
    mockFromState(state);
    const openPane = vi.fn();
    mocks.panesState.setIsTasksPaneLocked = openPane;
    mocks.useAgentSession.mockImplementation((id: string) => ({ data: { id, status: 'waiting_user', turns: [] }, isLoading: false }));
    let finish!: (value: { id: string }) => void;
    state.createSession.mutateAsync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = renderAgentChat();
    await waitFor(() => expect(mocks.useAgentSession).toHaveBeenLastCalledWith('session-1', 'project-1'));
    fireEvent.click(await screen.findByRole('button', { name: /^New chat · Astrid/ }));
    state.projectId = 'project-2';
    rerenderAgentChat(view.rerender);
    if (returnToOrigin) { state.projectId = 'project-1'; rerenderAgentChat(view.rerender); }
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Current project draft' } });
    await act(async () => { finish({ id: 'late-project-1-session' }); });
    expect(mocks.useAgentSession).not.toHaveBeenLastCalledWith('late-project-1-session', state.projectId);
    expect(screen.getByRole('textbox')).toHaveValue('Current project draft');
    expect(openPane).not.toHaveBeenCalled();
    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();
    view.unmount();
  });
  it('keeps the prior chat and unsent composer when creation fails', async () => {
    vi.clearAllMocks();
    const state = createState();
    mockFromState(state);
    state.createSession.mutateAsync.mockRejectedValue(new Error('Connection lost'));
    render(<AgentChatPanel />);
    const composer = screen.getByRole('textbox');
    fireEvent.change(composer, { target: { value: 'Still my draft' } });
    await waitFor(() => expect(mocks.useAgentSession).toHaveBeenLastCalledWith('session-1', 'project-1'));
    fireEvent.click(await screen.findByRole('button', { name: /^New chat · Astrid/ }));
    await waitFor(() => expect(state.createSession.mutateAsync).toHaveBeenCalledOnce());
    expect(mocks.useAgentSession).toHaveBeenLastCalledWith('session-1', 'project-1');
    expect(composer).toHaveValue('Still my draft');
    expect(state.sendMessage.mutateAsync).not.toHaveBeenCalled();
  });
});

describe('local Astrid update flag', () => {
  function OutOfDateProbe() {
    const { localServiceOutOfDate } = useRuntimeConnection();
    return <span data-testid="out-of-date">{String(localServiceOutOfDate)}</span>;
  }
  const page = () => (
    <RuntimeConnectionProvider gated={false}>
      <AgentChatPanelWithoutProvider isExpanded />
      <OutOfDateProbe />
    </RuntimeConnectionProvider>
  );

  it('does not mark malformed local chat payloads as out of date', async () => {
    mocks.useLocalAgents.mockReturnValue({
      data: undefined,
      isLoading: false,
      isSuccess: false,
      error: new BridgeContractError('List local agents', 'agents.0.models: Invalid input'),
      refetch: vi.fn(),
    });
    const view = render(page());
    await waitFor(() => expect(screen.getByTestId('out-of-date')).toHaveTextContent('false'));

    mocks.useLocalAgents.mockReturnValue({
      data: { agents: [{ id: 'astrid', name: 'Astrid', state: 'ready', line: null, models: [{ modelId: 'openai/gpt-5', name: 'GPT 5' }], defaultModel: 'openai/gpt-5' }], defaultAgent: 'astrid' },
      isLoading: false,
      isSuccess: true,
      error: null,
      refetch: vi.fn(),
    });
    view.rerender(page());
    await waitFor(() => expect(screen.getByTestId('out-of-date')).toHaveTextContent('false'));
  });

});
