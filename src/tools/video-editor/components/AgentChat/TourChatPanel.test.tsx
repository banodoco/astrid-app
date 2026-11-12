// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { AgentChatPanel as AgentChatPanelWithoutProvider } from './AgentChat';
import { RuntimeConnectionProvider } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { AstridBridgeTransport } from '@/integrations/astrid/transport.ts';
import {
  markEditorTourReady,
  exitEditorTour,
  getEditorTourState,
  setEditorTourBeat,
  skipEditorTourAnimation,
  startEditorTour,
} from '@/shared/state/editorTourStore.ts';
import { getPaneLockHolds } from '@/shared/state/paneLockHolds.ts';
import { EDITOR_TOUR_SCRIPT } from '@/tools/video-editor/tour/tourScript.ts';
import { EDITOR_TOUR_ANCHORS, editorTourSelector } from '@/tools/video-editor/tour/anchors.ts';

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
  useCancelSession: vi.fn(),
  useTakeOverSession: vi.fn(),
  useAgentVoice: vi.fn(),
  useCurrentAttachmentSet: vi.fn(),
  composerRemoveAttachment: vi.fn(),
  composerClearAttachments: vi.fn(),
  loadGenerationForLightbox: vi.fn(),
}));


vi.mock('@/shared/contexts/AgentChatContext', () => ({
  useAgentChatBridge: (...args: unknown[]) => mocks.useAgentChatBridge(...args),
  useAgentChatActionsRegistry: (...args: unknown[]) => mocks.useAgentChatActionsRegistry(...args),
}));

vi.mock('@/tools/video-editor/contexts/VideoEditorRuntimeContext', () => ({
  useVideoEditorRuntime: (...args: unknown[]) => mocks.useVideoEditorRuntime(...args),
}));

vi.mock('@/shared/state/selectionStore', () => ({
  composerRemoveAttachment: (...args: unknown[]) => mocks.composerRemoveAttachment(...args),
  composerClearAttachments: (...args: unknown[]) => mocks.composerClearAttachments(...args),
}));

vi.mock('@/tools/video-editor/hooks/useAgentSession', () => ({
  // Present only while the function exists; the chat then always has its sessions.
  isTimelineAgentSessionsAvailable: () => true,
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

vi.mock('@/tools/video-editor/hooks/useAgentVoice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/tools/video-editor/hooks/useAgentVoice.ts')>()),
  useAgentVoice: (...args: unknown[]) => mocks.useAgentVoice(...args),
}));

vi.mock('@/shared/state/currentAttachmentSet', () => ({
  useCurrentAttachmentSet: (...args: unknown[]) => mocks.useCurrentAttachmentSet(...args),
}));

vi.mock('@/domains/media-lightbox/MediaLightbox', () => ({
  MediaLightbox: () => null,
}));

// The real chat after the tour exits: the minimal hook shapes AgentChat.test.tsx gives it.
function mockRealChatHooks() {
  const chat = { project_id: 'project-1', scope_key: 'scope-1', revision: 1, selected_session_id: 'session-1', sessions: [{ id: 'session-1' }], draft: { text: '', revision: 0, queued_messages: [] } };
  mocks.useVideoEditorRuntime.mockImplementation(() => ({
    mediaLightbox: { loadGenerationForLightbox: mocks.loadGenerationForLightbox, Lightbox: () => null },
  }));
  mocks.useAgentChatBridge.mockImplementation(() => ({
    timelineId: 'timeline-1',
    editorContext: { tool: 'video-editor', projectId: 'project-1', projectSlug: 'project-one', timelineId: 'timeline-1', timelineName: null },
  }));
  mocks.useAgentChatActionsRegistry.mockImplementation(() => ({ registerHandlers: vi.fn(), publishState: vi.fn(), unregister: vi.fn() }));
  mocks.useAgentSessions.mockImplementation(() => ({ data: [{ id: 'session-1', status: 'waiting_user' }], isLoading: false }));
  mocks.useProjectChat.mockImplementation(() => ({ data: chat }));
  mocks.useSaveProjectDraft.mockImplementation(() => ({ mutateAsync: vi.fn().mockResolvedValue(chat) }));
  mocks.useSelectProjectSession.mockImplementation(() => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }));
  mocks.useSetMainProjectSession.mockImplementation(() => ({ isPending: false, mutateAsync: vi.fn().mockResolvedValue(undefined) }));
  mocks.useRenameProjectSession.mockImplementation(() => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }));
  mocks.useUnassignedProjectSessions.mockImplementation(() => ({ data: undefined, isLoading: false }));
  mocks.useAssociateProjectSession.mockImplementation(() => ({ mutate: vi.fn(), isPending: false }));
  mocks.useCreateSession.mockImplementation(() => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({ id: 'session-2' }) }));
  mocks.useAgentSession.mockImplementation(() => ({
    data: { id: 'session-1', status: 'waiting_user', turns: [], durableAcceptedRequestIds: undefined, control: undefined },
    isLoading: false,
    error: null,
  }));
  mocks.useAgentModels.mockImplementation(() => ({ data: { currentModel: null, providers: [], localModels: { currentModelId: 'openai/gpt-5', availableModels: [{ modelId: 'openai/gpt-5', name: 'GPT 5' }] } }, isLoading: false, error: null, refetch: vi.fn() }));
  mocks.useConfigureAgentSession.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(undefined) });
  mocks.useLocalAgents.mockImplementation(() => ({ data: { agents: [{ id: 'astrid', name: 'Astrid', state: 'ready', line: null, models: [{ modelId: 'openai/gpt-5', name: 'GPT 5' }], defaultModel: 'openai/gpt-5' }], defaultAgent: 'astrid' }, isLoading: false, error: null, refetch: vi.fn() }));
  mocks.useSendMessage.mockImplementation(() => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false, localError: null }));
  mocks.useCancelSession.mockImplementation(() => ({ mutate: vi.fn(), isPending: false }));
  mocks.useTakeOverSession.mockImplementation(() => ({ mutate: vi.fn(), isPending: false, error: null }));
  mocks.useCurrentAttachmentSet.mockImplementation(() => ({ clips: [], summary: '' }));
  mocks.useAgentVoice.mockImplementation(() => ({
    startRecording: vi.fn(), stopRecording: vi.fn(), cancelRecording: vi.fn(), isRecording: false, isProcessing: false, remainingSeconds: 30,
  }));
}

// The real chat reads the runtime connection context, so every render mounts it (same identity across rerenders).
function AgentChatPanel(props: ComponentProps<typeof AgentChatPanelWithoutProvider>) {
  return <RuntimeConnectionProvider gated={false}><AgentChatPanelWithoutProvider {...props} /></RuntimeConnectionProvider>;
}

const ACT1 = EDITOR_TOUR_SCRIPT.acts[1];
const ACT2 = EDITOR_TOUR_SCRIPT.acts[2];

const SESSION_HOOK_SPIES = [
  mocks.useAgentSessions,
  mocks.useProjectChat,
  mocks.useSaveProjectDraft,
  mocks.useSelectProjectSession,
  mocks.useSetMainProjectSession,
  mocks.useRenameProjectSession,
  mocks.useUnassignedProjectSessions,
  mocks.useAssociateProjectSession,
  mocks.useCreateSession,
  mocks.useAgentSession,
  mocks.useSendMessage,
  mocks.useAgentModels,
  mocks.useConfigureAgentSession,
  mocks.useLocalAgents,
  mocks.useCancelSession,
  mocks.useTakeOverSession,
  mocks.useAgentVoice,
  mocks.useAgentChatActionsRegistry,
];

function composer(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(`${editorTourSelector(EDITOR_TOUR_ANCHORS.chatComposer)} textarea`)!;
}

function sendButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(editorTourSelector(EDITOR_TOUR_ANCHORS.chatSend))!;
}

function transcript(): HTMLElement {
  return document.querySelector<HTMLElement>(editorTourSelector(EDITOR_TOUR_ANCHORS.chatTranscript))!;
}

function exchange(): HTMLElement {
  return document.querySelector<HTMLElement>(editorTourSelector(EDITOR_TOUR_ANCHORS.chatExchange))!;
}

/** The transcript's text as it shows: without the unseen full-reply copy that reserves the streaming bubble's size. */
function shownTranscript(): string {
  const copy = transcript().cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
  return copy.textContent ?? '';
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Advances in small steps until `done` holds; returns the elapsed time. Guarded so a stuck tour fails instead of hanging. */
function advanceUntil(done: () => boolean, stepMs = 10, maxMs = 60_000): number {
  let elapsed = 0;
  while (!done() && elapsed < maxMs) {
    advance(stepMs);
    elapsed += stepMs;
  }
  return elapsed;
}

function chatReady(): boolean {
  return getEditorTourState().ready.chat;
}

/** Types the act's prompt and sends it, asserting Send's gating on the way. */
function typeAndSend(prompt: string) {
  expect(sendButton()).toBeDisabled();
  advanceUntil(() => {
    // Ready is raised in the same tick the last character lands, never before.
    expect(chatReady()).toBe(composer().value === prompt);
    return chatReady();
  });
  expect(composer().value).toBe(prompt);
  expect(sendButton()).toBeEnabled();
  fireEvent.click(sendButton());
}

/** Streams the act's reply and cards to completion, checking that ready only rises after the full exchange. */
function respondUntilReady(reply: string, cardCount: number) {
  expect(chatReady()).toBe(false);
  expect(screen.getByText('Thinking...')).toBeInTheDocument();
  advanceUntil(() => {
    if (chatReady()) {
      expect(transcript().textContent).toContain(reply);
      expect(screen.queryByRole('button', { name: `[${cardCount} action${cardCount === 1 ? '' : 's'}]` })).not.toBeNull();
    }
    return chatReady();
  });
  expect(chatReady()).toBe(true);
  expect(screen.queryByText('Thinking...')).toBeNull();
}

/** The tour opens on its welcome; most of these tests begin at act 1's compose, where typing starts. */
function startAtCompose() {
  act(() => {
    startEditorTour();
    setEditorTourBeat(1, 'compose');
  });
}

describe('TourChatPanel (AgentChatPanel during the editor tour)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let requestJsonSpy: ReturnType<typeof vi.spyOn>;
  let requestRawSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.clearAllMocks();
    mockRealChatHooks();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch must not run during the tour'));
    requestJsonSpy = vi.spyOn(AstridBridgeTransport.prototype, 'requestJson').mockRejectedValue(new Error('bridge must not run during the tour'));
    requestRawSpy = vi.spyOn(AstridBridgeTransport.prototype, 'requestRaw').mockRejectedValue(new Error('bridge must not run during the tour'));
  });

  afterEach(() => {
    act(() => exitEditorTour());
    fetchSpy.mockRestore();
    requestJsonSpy.mockRestore();
    requestRawSpy.mockRestore();
    delete (window as { matchMedia?: unknown }).matchMedia;
    vi.useRealTimers();
  });

  it('swaps in before the real chat: no session hook mounts and no bridge call is made while the tour runs', () => {
    act(() => startEditorTour());
    render(<AgentChatPanel />);

    for (const spy of SESSION_HOOK_SPIES) expect(spy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestJsonSpy).not.toHaveBeenCalled();
    expect(requestRawSpy).not.toHaveBeenCalled();

    expect(composer()).not.toBeNull();
    expect(sendButton()).not.toBeNull();
    expect(transcript()).not.toBeNull();
  });

  it('holds the Tasks pane locked while mounted, saving nothing, and gives it back on unmount', () => {
    act(() => startEditorTour());
    const view = render(<AgentChatPanel />);
    expect(getPaneLockHolds()).toEqual({ tasks: true, gens: false });
    view.unmount();
    expect(getPaneLockHolds()).toEqual({});
  });

  it('during the welcome shows the real empty state and types nothing until act 1 compose', () => {
    act(() => startEditorTour());
    render(<AgentChatPanel />);
    expect(getEditorTourState().beat).toBe('welcome');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText('✨ I can do almost anything')).toBeInTheDocument();
    expect(composer().value).toBe('');
    expect(sendButton()).toBeDisabled();

    act(() => setEditorTourBeat(1, 'compose'));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(composer().value).toBe(EDITOR_TOUR_SCRIPT.acts[1].prompt);
  });

  it('looks like a fresh real chat: menu title, agent line, empty state, no old avatar header', () => {
    startAtCompose();
    render(<AgentChatPanel />);

    expect(screen.getByRole('button', { name: 'Chat: New chat' })).toBeInTheDocument();
    expect(screen.getByText('Astrid', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chat: New chat' }).closest('div[class*="border-b"]')!.querySelector('img')).toBeNull();
    expect(screen.getByText('✨ I can do almost anything')).toBeInTheDocument();
    expect(composer().placeholder).toBe('Type a message...');

    act(() => skipEditorTourAnimation());
    fireEvent.click(sendButton());
    expect(screen.queryByText('✨ I can do almost anything')).toBeNull();
  });

  it('leaves Enter to the tour runner: the composer ignores it, and Send only sets `sent` once', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    act(() => skipEditorTourAnimation());
    expect(chatReady()).toBe(true);

    fireEvent.keyDown(composer(), { key: 'Enter' });
    fireEvent.keyDown(sendButton(), { key: 'Enter' });
    expect(getEditorTourState().sent).toBe(false);

    fireEvent.click(sendButton());
    expect(getEditorTourState().sent).toBe(true);
    expect(sendButton()).toBeDisabled();
    // A second activation (Enter on the focused button after the runner's own handling) changes nothing.
    fireEvent.click(sendButton());
    expect(getEditorTourState().sent).toBe(true);
    expect(getEditorTourState().act).toBe(1);
    expect(getEditorTourState().beat).toBe('compose');
  });

  it('types act 1, sends it, streams the reply and cards, then moves to act 2', () => {
    startAtCompose();
    render(<AgentChatPanel />);

    expect(composer().readOnly).toBe(true);
    expect(composer().value).toBe('');
    expect(sendButton()).toBeDisabled();
    expect(chatReady()).toBe(false);

    advance(1000);
    const partial = composer().value;
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(ACT1.prompt.length);
    expect(ACT1.prompt.startsWith(partial)).toBe(true);
    expect(chatReady()).toBe(false);

    typeAndSend(ACT1.prompt);

    // Send only sets `sent` in the store; nothing else in the tour state moves.
    expect(getEditorTourState().sent).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestJsonSpy).not.toHaveBeenCalled();
    expect(within(transcript()).getByText(ACT1.prompt)).toBeInTheDocument();

    act(() => setEditorTourBeat(1, 'respond'));
    expect(composer().value).toBe('');
    expect(within(transcript()).getByText(ACT1.prompt)).toBeInTheDocument();
    expect(transcript().textContent).not.toContain(ACT1.reply.slice(0, 20));

    expect(screen.getByText('Thinking...')).toBeInTheDocument();
    // The spotlight's first hold: the sent prompt with the thinking line under it, and nothing else.
    expect(exchange()).toContainElement(screen.getByText('Thinking...'));
    expect(exchange()).toContainElement(within(transcript()).getByText(ACT1.prompt));
    const thinkingHeightMarker = exchange().children.length;
    expect(thinkingHeightMarker).toBe(2);
    expect(composer().placeholder).toBe('Type to queue next message...');
    // Thinking lasts 2.5 s, then a few reply characters have streamed in.
    advance(2650);
    expect(shownTranscript()).toContain(ACT1.reply.slice(0, 20));
    expect(shownTranscript()).not.toContain(ACT1.reply);
    // The bubble has its final size from the first character: the whole reply is laid out, unseen, under what has
    // arrived, so the spotlight around the exchange expands once and never chases the stream.
    const reserved = exchange().querySelector('[aria-hidden="true"]')!;
    expect(reserved).toHaveClass('invisible');
    expect(reserved.textContent).toContain(ACT1.reply);
    expect(chatReady()).toBe(false);
    // Like the real chat, the indicator is gone once the reply text starts.
    expect(screen.queryByText('Thinking...')).toBeNull();

    // Cards appear one at a time: the group label counts up from one action to two.
    let sawOneAction = false;
    let sawTwoActions = false;
    const sawLabels = () => {
      sawOneAction ||= screen.queryByRole('button', { name: '[1 action]' }) !== null;
      sawTwoActions ||= screen.queryByRole('button', { name: '[2 actions]' }) !== null;
    };
    advanceUntil(() => {
      sawLabels();
      return chatReady();
    });
    sawLabels();
    expect(sawOneAction).toBe(true);
    expect(sawTwoActions).toBe(true);
    expect(transcript().textContent).toContain(ACT1.reply);
    // The tour's groups start expanded, so each card's name and detail show without a click.
    expect(screen.getByRole('button', { name: '[2 actions]' })).toHaveAttribute('aria-expanded', 'true');
    for (const card of ACT1.toolCards) {
      expect(transcript().textContent).toContain(card.name);
      expect(transcript().textContent).toContain(card.detail);
      // The actions are outside the exchange: the spotlight leaves it for them.
      expect(exchange().textContent).not.toContain(card.name);
    }
    expect(exchange().textContent).toContain(ACT1.reply);
    expect(exchange().textContent).toContain(ACT1.prompt);
    expect(exchange().querySelector('[aria-hidden="true"]')).toBeNull();
    expect(screen.queryByText('Thinking...')).toBeNull();

    act(() => setEditorTourBeat(2, 'compose'));
    expect(chatReady()).toBe(false);
    expect(within(transcript()).getByText(ACT1.prompt)).toBeInTheDocument();
    expect(transcript().textContent).toContain(ACT1.reply);

    advance(1000);
    expect(composer().value.length).toBeGreaterThan(0);
    expect(ACT2.prompt.startsWith(composer().value)).toBe(true);
    expect(chatReady()).toBe(false);
  });

  it('paces typing by elapsed time: one long stall jumps ahead instead of delaying the end', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    advance(500);
    expect(composer().value.length).toBeLessThan(ACT1.prompt.length);
    expect(chatReady()).toBe(false);

    // The main thread stalls: the next frame sees a clock far past the end of the whole prompt.
    const now = performance.now();
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(now + 60_000);
    advance(16);
    nowSpy.mockRestore();

    expect(composer().value).toBe(ACT1.prompt);
    expect(chatReady()).toBe(true);
  });

  it('skipAnimation finishes the typing and the reply at once', () => {
    startAtCompose();
    render(<AgentChatPanel />);

    advance(1000);
    expect(composer().value).not.toBe(ACT1.prompt);
    act(() => skipEditorTourAnimation());
    expect(composer().value).toBe(ACT1.prompt);
    expect(chatReady()).toBe(true);
    expect(sendButton()).toBeEnabled();

    act(() => setEditorTourBeat(1, 'respond'));
    advance(450);
    expect(transcript().textContent).not.toContain(ACT1.reply);
    act(() => skipEditorTourAnimation());
    expect(transcript().textContent).toContain(ACT1.reply);
    expect(screen.queryByRole('button', { name: '[2 actions]' })).not.toBeNull();
    expect(chatReady()).toBe(true);
    expect(screen.queryByText('Thinking...')).toBeNull();

    // Nothing keeps streaming after the skip.
    advance(5000);
    expect(transcript().textContent).toContain(ACT1.reply);
    expect(chatReady()).toBe(true);
  });

  it('reduced motion shows the prompt and the reply without waiting on timers', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })),
    });

    startAtCompose();
    expect(getEditorTourState().reducedMotion).toBe(true);
    render(<AgentChatPanel />);

    expect(composer().value).toBe(ACT1.prompt);
    expect(chatReady()).toBe(true);
    expect(sendButton()).toBeEnabled();

    act(() => setEditorTourBeat(1, 'respond'));
    expect(transcript().textContent).toContain(ACT1.reply);
    expect(screen.queryByRole('button', { name: '[2 actions]' })).not.toBeNull();
    expect(chatReady()).toBe(true);
    expect(screen.queryByText('Thinking...')).toBeNull();
  });

  it('arriving by Back (instant) shows the compose prompt typed, unsent and sendable, with nothing typing', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    act(() => setEditorTourBeat(1, 'respond'));
    act(() => skipEditorTourAnimation());
    act(() => setEditorTourBeat(1, 'compose', true));

    expect(composer().value).toBe(ACT1.prompt);
    expect(chatReady()).toBe(true);
    expect(sendButton()).toBeEnabled();
    expect(getEditorTourState().sent).toBe(false);
    expect(transcript().textContent).not.toContain(ACT1.prompt);

    advance(5000);
    expect(composer().value).toBe(ACT1.prompt);
    fireEvent.click(sendButton());
    // The runner's watcher (not mounted here) is what moves compose on; the panel only marks it sent.
    expect(getEditorTourState().sent).toBe(true);
  });

  it('arriving at respond by Back shows the full reply and every tool card at once, without thinking', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    act(() => setEditorTourBeat(1, 'respond', true));

    expect(transcript().textContent).toContain(ACT1.reply);
    expect(screen.queryByRole('button', { name: '[2 actions]' })).not.toBeNull();
    expect(chatReady()).toBe(true);
    expect(screen.queryByText('Thinking...')).toBeNull();
  });

  it('anchors the act’s actions (its tool group) for the spotlight to contract onto, and the whole pane for the card to keep clear of', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    act(() => setEditorTourBeat(1, 'respond', true));

    const actions = document.querySelectorAll(editorTourSelector(EDITOR_TOUR_ANCHORS.chatActions));
    expect(actions).toHaveLength(1);
    expect(exchange().contains(actions[0])).toBe(false);
    expect(transcript().contains(actions[0])).toBe(true);
    expect(actions[0].textContent).toContain('[2 actions]');
    expect(actions[0].textContent).not.toContain(ACT1.reply);
    expect(document.querySelector(editorTourSelector(EDITOR_TOUR_ANCHORS.chatPane))?.contains(transcript())).toBe(true);
  });

  it('keeps the actions group’s reserved layout when the store says ready before the last card has rendered: nothing may shrink and jump', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    typeAndSend(ACT1.prompt);
    act(() => setEditorTourBeat(1, 'respond'));
    // Into the reply, before any card: the group already has its final layout, unseen.
    advance(2650);
    const group = () => document.querySelector<HTMLElement>(editorTourSelector(EDITOR_TOUR_ANCHORS.chatActions))!;
    const reserved = () => group().querySelector(':scope > [aria-hidden="true"]');
    expect(reserved()?.textContent).toContain(ACT1.toolCards.at(-1)!.name);
    // The store's flag can reach a render before the progress it was set with: ready, the last card not in yet.
    act(() => markEditorTourReady('chat'));
    expect(reserved()?.textContent).toContain(ACT1.toolCards.at(-1)!.name);
    advanceUntil(() => (group().textContent ?? '').split(ACT1.toolCards.at(-1)!.name).length > 2);
    expect(reserved()).not.toBeNull();
  });

  it('on the gallery beat shows act 2 complete with Send disabled, and nothing animating', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    act(() => setEditorTourBeat(2, 'land'));
    const landText = transcript().textContent;
    act(() => setEditorTourBeat(2, 'gallery'));

    expect(transcript().textContent).toBe(landText);
    expect(transcript().textContent).toContain(ACT2.prompt);
    expect(transcript().textContent).toContain(ACT2.reply);
    expect(screen.getAllByRole('button', { name: '[2 actions]' })).toHaveLength(2); // acts 1 and 2, both complete
    expect(screen.queryByText('Thinking...')).toBeNull();
    expect(sendButton()).toBeDisabled();
    advance(5000);
    expect(transcript().textContent).toBe(landText);
    expect(getEditorTourState().sent).toBe(false);
  });

  it('plays a normal beat after Back once the user moves forward again', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    act(() => setEditorTourBeat(1, 'respond', true));
    act(() => setEditorTourBeat(1, 'land'));
    act(() => setEditorTourBeat(2, 'compose'));
    expect(composer().value).toBe('');
    expect(chatReady()).toBe(false);
    advanceUntil(chatReady);
    expect(composer().value).toBe(EDITOR_TOUR_SCRIPT.acts[2].prompt);
  });

  it('a new run resets the transcript and composer', () => {
    startAtCompose();
    render(<AgentChatPanel />);

    typeAndSend(ACT1.prompt);
    act(() => setEditorTourBeat(1, 'respond'));
    respondUntilReady(ACT1.reply, ACT1.toolCards.length);
    act(() => setEditorTourBeat(2, 'compose'));
    advance(1000);
    expect(transcript().textContent).toContain(ACT1.reply);

    const runId = getEditorTourState().runId;
    startAtCompose();
    expect(getEditorTourState().runId).toBe(runId + 1);
    expect(getEditorTourState().act).toBe(1);
    expect(composer().value).toBe('');
    expect(transcript().textContent).toBe('✨ I can do almost anythingAstrid · default model');
    expect(within(transcript()).queryByText(ACT1.prompt)).toBeNull();
    expect(transcript().textContent).not.toContain(ACT1.reply);

    advance(1000);
    expect(composer().value.length).toBeGreaterThan(0);
    expect(ACT1.prompt.startsWith(composer().value)).toBe(true);
  });

  it('after the tour exits, the real chat mounts and the tour composer is gone', () => {
    startAtCompose();
    render(<AgentChatPanel />);
    expect(composer().readOnly).toBe(true);
    for (const spy of SESSION_HOOK_SPIES) expect(spy).not.toHaveBeenCalled();

    act(() => exitEditorTour());

    expect(mocks.useAgentSessions).toHaveBeenCalled();
    expect(mocks.useProjectChat).toHaveBeenCalled();
    expect(mocks.useAgentSession).toHaveBeenCalled();
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea!.readOnly).toBe(false);
    expect(screen.queryByText('Thinking...')).toBeNull();
    expect(within(document.body).queryByText(ACT1.prompt)).toBeNull();
  });
});
