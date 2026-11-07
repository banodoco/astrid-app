// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ComponentProps } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOCAL_AGENT_IDS, LOCAL_AGENT_TABLE, type LocalAgentChoice } from '@/integrations/astrid/localAgents.ts';
import { toast } from '@/shared/components/ui/toast.tsx';
import { ASTRID_COMMANDS, RUNTIME_CONNECTION_COPY, withCommandShell } from '@/shared/components/RuntimeConnection/copy.ts';
import { BRIDGE_CONTRACT_VERSION_MISMATCH_CODE } from '@/tools/video-editor/data/bridgeContract.ts';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { AgentChatMenu, type AgentChatMenuHandle, type NewChatAgentModels } from './AgentChatMenu.tsx';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= vi.fn();
});
afterEach(() => { cleanup(); localStorage.clear(); });
const plainLine = (line: string) => line.replaceAll('`', '');

const ready: LocalAgentChoice[] = LOCAL_AGENT_IDS
  .map(id => ({ id, name: LOCAL_AGENT_TABLE[id].name, state: 'ready', line: null, models: [], defaultModel: null }));
const claudeModels: NewChatAgentModels = {
  agent: 'claude-code',
  defaultModel: 'sonnet',
  loading: false,
  models: [
    { id: 'opus', name: 'Opus', detail: 'For complex work' },
    { id: 'sonnet', name: 'Sonnet', detail: 'Most efficient' },
  ],
};

type MenuProps = Partial<ComponentProps<typeof AgentChatMenu>>;

/** Renders the menu with the chat-free defaults; `rerender` keeps the same callbacks and overrides props. */
function renderMenu(props: MenuProps = {}) {
  const onNewChat = vi.fn();
  const onBrowseAgent = vi.fn();
  const base = { sessions: [], activeSessionId: null, defaultAgent: 'claude-code' as const, agents: ready, onNewChat, onBrowseAgent, ...props };
  const view = render(<AgentChatMenu {...base} />);
  const rerender = (next: MenuProps = {}) => view.rerender(<AgentChatMenu {...base} {...next} />);
  return { onNewChat, onBrowseAgent, view, rerender };
}

/** Renders the menu and opens it from its trigger. */
function openMenu(props: MenuProps = {}) {
  const rendered = renderMenu(props);
  fireEvent.click(screen.getByRole('button', { name: /^Chat: / }));
  return rendered;
}

const sessionsTwo = [{ id: 'one', title: 'Planning' }, { id: 'two' }];

describe('AgentChatMenu trigger', () => {
  it('names the open chat by its trimmed title', () => {
    renderMenu({ sessions: [{ id: 'a', title: '  Launch plan  ' }], activeSessionId: 'a' });
    const trigger = screen.getByRole('button', { name: 'Chat: Launch plan' });
    expect(trigger).toHaveTextContent('Launch plan');
  });

  it('falls back to the chat number, then to its list position, when a chat has no title', () => {
    const { view } = renderMenu({ sessions: [{ id: 'a', chatNumber: 7 }], activeSessionId: 'a' });
    expect(screen.getByRole('button', { name: 'Chat: Chat 7' })).toBeInTheDocument();
    view.unmount();
    renderMenu({ sessions: [{ id: 'a' }, { id: 'b' }], activeSessionId: 'b' });
    expect(screen.getByRole('button', { name: 'Chat: Chat 2' })).toBeInTheDocument();
  });

  it('says New chat when no chat is open', () => {
    renderMenu({ sessions: sessionsTwo, activeSessionId: null });
    expect(screen.getByRole('button', { name: 'Chat: New chat' })).toHaveTextContent('New chat');
  });

  it('says New chat while a new chat is starting, even with a chat open', () => {
    renderMenu({ sessions: sessionsTwo, activeSessionId: 'one', starting: true });
    expect(screen.getByRole('button', { name: 'Chat: New chat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat: Planning' })).toBeNull();
  });

  it('is disabled when the host disables it', () => {
    renderMenu({ disabled: true });
    expect(screen.getByRole('button', { name: 'Chat: New chat' })).toBeDisabled();
  });

  it('reports open and close through onOpenChange', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderMenu({ onOpenChange });
    await user.click(screen.getByRole('button', { name: 'Chat: New chat' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it('opens with the open chat highlighted when one is open, and the default agent otherwise', () => {
    const { view } = renderMenu({ sessions: [{ id: 'a' }], activeSessionId: 'a' });
    fireEvent.click(screen.getByRole('button', { name: 'Chat: Chat 1' }));
    expect(screen.getByRole('option', { name: /^Chat 1/ })).toHaveAttribute('aria-selected', 'true');
    view.unmount();
    openMenu();
    expect(screen.getByRole('option', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('AgentChatMenu chats', () => {
  it('lists chats under a Chats heading, marks the active one, and selects a row closing the menu', async () => {
    const onSelectSession = vi.fn();
    const onOpenChange = vi.fn();
    renderMenu({ sessions: sessionsTwo, activeSessionId: 'one', onSelectSession, onOpenChange });
    fireEvent.click(screen.getByRole('button', { name: 'Chat: Planning' }));
    expect(screen.getByText('Chats')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Planning/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('option', { name: /^Chat 2/ })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('option', { name: /^Chat 2/ }));
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith('two');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('shows no Chats group or search field without chats', () => {
    openMenu({ sessions: [] });
    expect(screen.queryByText('Chats')).toBeNull();
    expect(screen.queryByPlaceholderText('Search chats…')).toBeNull();
  });

  it('uses titles in the rows, keeps fallback names, and searches both titles and fallback names', () => {
    openMenu({ sessions: sessionsTwo, activeSessionId: 'one', onRenameSession: vi.fn() });
    expect(screen.getByRole('option', { name: /^Planning/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('option', { name: /^Chat 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename Planning' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename Chat 2' })).toBeNull();
    const search = screen.getByPlaceholderText('Search chats…');
    fireEvent.change(search, { target: { value: 'Chat 1' } });
    expect(screen.getByRole('option', { name: /^Planning/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'Planning' } });
    expect(screen.getByRole('option', { name: /^Planning/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /^Chat 2/ })).toBeNull();
  });

  it('keeps fallback chat numbers stable when missing sessions are omitted or new chats are appended', () => {
    const { rerender } = renderMenu({ sessions: [{ id: 'one', title: 'Planning', chatNumber: 1 }, { id: 'three', chatNumber: 3 }], activeSessionId: 'three' });
    expect(screen.getByRole('button', { name: 'Chat: Chat 3' })).toHaveTextContent('Chat 3');
    fireEvent.click(screen.getByRole('button', { name: 'Chat: Chat 3' }));
    expect(screen.getByRole('option', { name: /^Planning/ })).not.toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('option', { name: /^Chat 3/ })).toHaveAttribute('aria-current', 'true');
    rerender({ sessions: [{ id: 'one', title: 'Planning', chatNumber: 1 }, { id: 'three', chatNumber: 3 }, { id: 'four', chatNumber: 4 }], activeSessionId: 'three' });
    expect(screen.getByRole('option', { name: /^Chat 3/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Chat 4/ })).toBeTruthy();
  });

  it('uses only a filled Main star and exposes full truncated chat names', async () => {
    const label = 'A long planning chat name that needs all available space';
    openMenu({ sessions: [{ id: 'one', title: label }, { id: 'two' }], activeSessionId: 'one', mainSessionId: 'one', onRenameSession: vi.fn() });
    const row = await screen.findByRole('option', { name: new RegExp(`^${label}`) });
    expect(within(row).getByTitle(label)).toHaveTextContent(label);
    const main = within(row).getByTitle('Main chat');
    expect(main.querySelector('svg')).toHaveClass('fill-current');
    expect(within(main).getByText('Main')).toHaveClass('sr-only');
    expect(within(row).getByRole('button', { name: `Rename ${label}` })).toBeInTheDocument();
    expect(within(screen.getByRole('option', { name: 'Chat 2' })).getByTitle('Chat 2')).toBeInTheDocument();
  });

  it('shows each chat\'s agent and last model under its title, and the agent alone when the model is unknown', async () => {
    const describeSession = (id: string) => id === 'codex:one'
      ? { agent: 'codex' as const, model: '6 Sol' }
      : { agent: 'claude-code' as const, model: null };
    renderMenu({ sessions: [{ id: 'codex:one' }, { id: 'claude-code:two' }], activeSessionId: 'codex:one', describeSession });
    fireEvent.click(screen.getByRole('button', { name: 'Chat: Chat 1' }));
    expect(await screen.findByText('Codex · 6 Sol')).toBeTruthy();
    expect(within(screen.getByRole('option', { name: /^Chat 2/ })).getByText('Claude Code')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search chats…'), { target: { value: 'codex' } });
    expect(screen.getByRole('option', { name: /^Chat 1/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /^Chat 2/ })).toBeNull();
  });

  it('makes another chat main without selecting it', async () => {
    const user = userEvent.setup();
    const onSetMainSession = vi.fn();
    const onSelectSession = vi.fn();
    openMenu({ sessions: sessionsTwo, activeSessionId: 'one', mainSessionId: 'one', onSetMainSession, onSelectSession });
    await user.click(screen.getByRole('button', { name: 'Make Chat 2 main' }));
    expect(onSetMainSession).toHaveBeenCalledExactlyOnceWith('two');
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /^Chat 2/ })).toBeTruthy();
  });

  it('disables the make-main buttons while a main change is pending', () => {
    openMenu({ sessions: sessionsTwo, activeSessionId: 'one', mainSessionId: 'one', onSetMainSession: vi.fn(), settingMainSessionId: 'two' });
    expect(screen.getByRole('button', { name: 'Make Chat 2 main' })).toBeDisabled();
  });

  it('keeps the Chats group above the agent list and hides Rename when no chat is open', () => {
    openMenu({ sessions: sessionsTwo, activeSessionId: null, onRenameSession: vi.fn() });
    expect(screen.queryByRole('button', { name: /^Rename / })).toBeNull();
    const chatsHeading = screen.getByText('Chats');
    const agentHeading = screen.getByText('New chat with');
    expect(chatsHeading.compareDocumentPosition(agentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('closes the menu and opens the rename dialog from the active row', async () => {
    const onOpenChange = vi.fn();
    openMenu({ sessions: [{ id: 'one', title: 'Planning' }], activeSessionId: 'one', onRenameSession: vi.fn().mockResolvedValue(undefined), onOpenChange });
    fireEvent.click(screen.getByRole('button', { name: 'Rename Planning' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(await screen.findByText('Rename chat')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Chat name' })).toHaveValue('Planning');
  });

  it('trims and saves a nonempty title', async () => {
    const onRenameSession = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    openMenu({ sessions: [{ id: 'one' }], activeSessionId: 'one', onOpenChange, onSelectSession: vi.fn(), onRenameSession });
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Chat 1' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    const nameInput = screen.getByRole('textbox', { name: 'Chat name' }) as HTMLInputElement;
    expect(nameInput.selectionStart).toBe(0);
    expect(nameInput.selectionEnd).toBe('Chat 1'.length);
    fireEvent.change(nameInput, { target: { value: '  Launch plan  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onRenameSession).toHaveBeenCalledWith('one', 'Launch plan'));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Chat name' })).toBeNull());
  });

  it('validates empty and 120 character titles without saving', async () => {
    const onRenameSession = vi.fn().mockResolvedValue(undefined);
    openMenu({ sessions: [{ id: 'one' }], activeSessionId: 'one', onRenameSession });
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Chat 1' }));
    const input = screen.getByRole('textbox', { name: 'Chat name' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a chat name.')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'x'.repeat(121) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Chat names must be 120 characters or fewer.')).toBeTruthy();
    expect(onRenameSession).not.toHaveBeenCalled();
  });

  it('accepts exactly 120 characters', async () => {
    const onRenameSession = vi.fn().mockResolvedValue(undefined);
    openMenu({ sessions: [{ id: 'one' }], activeSessionId: 'one', onRenameSession });
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Chat 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat name' }), { target: { value: 'x'.repeat(120) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onRenameSession).toHaveBeenCalledWith('one', 'x'.repeat(120)));
  });

  it('shows a toast when renaming fails and keeps the dialog open', async () => {
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => 'toast-id');
    const onRenameSession = vi.fn().mockRejectedValue(new Error('Rename failed'));
    openMenu({ sessions: [{ id: 'one' }], activeSessionId: 'one', onRenameSession });
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Chat 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Rename failed'));
    expect(screen.getByRole('textbox', { name: 'Chat name' })).toBeInTheDocument();
    toastError.mockRestore();
  });
});

describe('AgentChatMenu agent rows and search', () => {
  it('shows an agent row\'s default model and no Last used mark', () => {
    openMenu({ agentModelNames: { 'claude-code': 'Sonnet 4.5' } });
    expect(screen.getByLabelText('Ready, using Sonnet 4.5')).toHaveTextContent('Sonnet 4.5');
    expect(screen.queryByText('Last used')).toBeNull();
  });

  it('filters chats and agent rows together by name and model text', () => {
    openMenu({ sessions: sessionsTwo, activeSessionId: 'one', agentModelNames: { codex: 'GPT 6 Sol' } });
    const search = screen.getByPlaceholderText('Search chats…');
    fireEvent.change(search, { target: { value: 'codex sol' } });
    expect(screen.getByRole('option', { name: /Codex/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Claude Code/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /^Planning/ })).toBeNull();
    fireEvent.change(search, { target: { value: 'zzz-no-match' } });
    expect(screen.getByText('No chats found.')).toBeInTheDocument();
  });

  it('hides the attach option when a search matches nothing', () => {
    openMenu({ sessions: sessionsTwo, activeSessionId: 'one', attachExisting: { open: false, toggle: vi.fn() } });
    fireEvent.change(screen.getByPlaceholderText('Search chats…'), { target: { value: 'nothing-matches-this' } });
    expect(screen.queryByRole('option', { name: /Attach an existing chat/ })).toBeNull();
    expect(screen.getByText('No chats found.')).toBeInTheDocument();
  });

  it('starts a chat with a ready agent row using its default agent', () => {
    const { onNewChat } = openMenu({ sessions: sessionsTwo, activeSessionId: 'one' });
    fireEvent.click(screen.getByRole('option', { name: /Codex/ }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('codex', undefined);
  });

  it('closes the menu when a ready agent starts a chat', async () => {
    const onOpenChange = vi.fn();
    const { onNewChat } = openMenu({ onOpenChange, agents: ready.map(choice => choice.id === 'codex' ? choice : { ...choice, state: 'sign-in' as const, line: null }) });
    fireEvent.click(screen.getByRole('option', { name: /Codex/ }));
    expect(onNewChat).toHaveBeenCalledWith('codex', undefined);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('disables agent rows while a new chat cannot start', () => {
    openMenu({ newChatDisabled: true });
    for (const row of screen.getAllByRole('option', { name: /Claude Code|Codex/ })) {
      expect(row).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('shows the Checking message while agents load', () => {
    openMenu({ agentsLoading: true, agents: [] });
    expect(screen.getByText('Checking agent availability…')).toBeInTheDocument();
  });

  it('shows a plain agent load error inside the New chat group', () => {
    openMenu({ agentsError: new Error('Failed to fetch') });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load agents: Failed to fetch');
    expect(screen.getByText('New chat with')).toBeInTheDocument();
    expect(screen.queryByText(RUNTIME_CONNECTION_COPY.chatNeedsUpdate)).toBeNull();
  });

  it('shows an agent\'s state label and its install line on the row', () => {
    openMenu({ agents: [{ id: 'hermes', name: 'Hermes', state: 'not-installed', line: 'Install with `hermes install`.' }] });
    expect(screen.getByRole('option', { name: /Hermes/ })).toHaveTextContent('Not installed');
    expect(screen.getByRole('option', { name: /Hermes/ })).toHaveTextContent('Install with hermes install.');
  });
});

describe('AgentChatMenu handle', () => {
  it('opens directly on an agent\'s model list through the ref', () => {
    const ref = createRef<AgentChatMenuHandle>();
    const onBrowseAgent = vi.fn();
    const onOpenChange = vi.fn();
    render(<AgentChatMenu ref={ref} sessions={[]} activeSessionId={null} defaultAgent="claude-code" agents={ready} onNewChat={vi.fn()} onBrowseAgent={onBrowseAgent} onOpenChange={onOpenChange} />);
    act(() => ref.current?.openModels('claude-code'));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(onBrowseAgent).toHaveBeenLastCalledWith('claude-code');
    expect(screen.getByPlaceholderText('Search Claude Code models…')).toBeInTheDocument();
  });
});

describe('AgentChatMenu model list', () => {
  it('opens the model menu from the row arrow without starting a chat', async () => {
    const { onNewChat, onBrowseAgent } = openMenu({ agents: [
      { id: 'claude-code', name: LOCAL_AGENT_TABLE['claude-code'].name, state: 'not-installed', line: 'Use the Claude Code installer.', models: [], defaultModel: null },
      { id: 'codex', name: LOCAL_AGENT_TABLE.codex.name, state: 'ready', line: null, models: [], defaultModel: null },
    ] });
    expect(screen.getByRole('option', { name: /Claude Code/ })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Codex/ })).toHaveTextContent('Ready');
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Codex model' }));
    expect(onBrowseAgent).toHaveBeenLastCalledWith('codex');
    expect(onNewChat).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Search Codex models…')).toBeTruthy();
  });

  it('starts a ready non-default agent with its own default when its catalog is empty', () => {
    const { onNewChat, onBrowseAgent, rerender } = openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Codex model' }));
    rerender({ agentModels: { agent: 'codex', models: [], loading: false } });
    fireEvent.click(screen.getByRole('option', { name: 'Use the agent’s default model' }));
    expect(onBrowseAgent).toHaveBeenCalledWith('codex');
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('codex', undefined);
    expect(screen.queryByPlaceholderText('Search Codex models...')).toBeNull();
  });

  it('starts Hermes directly and omits model drill-in until a model list is reported', () => {
    const { onNewChat } = openMenu({ defaultAgent: 'hermes', agentCanBrowse: { hermes: false } });
    expect(screen.getByRole('option', { name: /Hermes/ })).toHaveTextContent('Ready');
    expect(screen.queryByRole('button', { name: 'Choose a Hermes model' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Hermes/ }));
    expect(onNewChat).toHaveBeenCalledWith('hermes', undefined);
  });

  it('does not enter Hermes model browsing with ArrowRight until models are reported', () => {
    const { onBrowseAgent } = openMenu({ defaultAgent: 'hermes', agentCanBrowse: { hermes: false } });
    fireEvent.keyDown(document.querySelector('[cmdk-root]') as HTMLElement, { key: 'ArrowRight' });
    expect(onBrowseAgent).not.toHaveBeenCalledWith('hermes');
    expect(screen.queryByPlaceholderText('Search Hermes models…')).toBeNull();
  });

  it('closes the Hermes model picker when a session reports an empty list', async () => {
    const { onBrowseAgent, rerender } = openMenu({ defaultAgent: 'hermes', agentCanBrowse: { hermes: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Hermes model' }));
    rerender({ agentModels: { agent: 'hermes', models: [], loading: false } });
    await waitFor(() => expect(screen.queryByPlaceholderText('Search Hermes models…')).toBeNull());
    expect(onBrowseAgent).toHaveBeenLastCalledWith(null);
  });

  it('only offers the agents returned by the service', () => {
    openMenu({ agents: ready.filter(agent => agent.id === 'codex') });
    expect(screen.getByRole('option', { name: /Codex/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Astrid|Claude Code/ })).toBeNull();
  });

  it('opens an agent\'s models with → and starts the chat with the picked model', async () => {
    const { onNewChat, onBrowseAgent, rerender } = openMenu();
    const list = document.querySelector('[cmdk-root]') as HTMLElement;
    expect(screen.getByRole('option', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onBrowseAgent).toHaveBeenLastCalledWith('claude-code');
    expect(screen.getByText('Loading models...')).toBeTruthy();
    rerender({ agentModels: claudeModels });
    expect(screen.getByRole('option', { name: /Sonnet/ })).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(screen.getByRole('option', { name: /Sonnet/ })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('option', { name: /Opus/ }));
    expect(onNewChat).toHaveBeenCalledWith('claude-code', 'opus');
  });

  it('opens a submenu from the row arrow, searches it, and goes back with ←', () => {
    const { onBrowseAgent, rerender } = openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    rerender({ agentModels: claudeModels });
    const search = screen.getByPlaceholderText('Search Claude Code models…');
    fireEvent.change(search, { target: { value: 'complex' } });
    expect(screen.getByRole('option', { name: /Opus/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Sonnet/ })).toBeNull();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.keyDown(search, { key: 'ArrowLeft' });
    expect(onBrowseAgent).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('option', { name: /Codex/ })).toBeTruthy();
  });

  it('returns to the agent list from the back row', () => {
    const { onBrowseAgent } = openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    fireEvent.click(screen.getByRole('option', { name: /Claude Code/ }));
    expect(onBrowseAgent).toHaveBeenLastCalledWith(null);
    expect(screen.getByText('New chat with')).toBeInTheDocument();
  });

  it('explains when an agent has not reported its models yet', () => {
    const { rerender } = openMenu();
    fireEvent.keyDown(document.querySelector('[cmdk-root]') as HTMLElement, { key: 'ArrowRight' });
    rerender({ agentModels: { agent: 'claude-code', models: [], loading: false, note: 'Start one first.' } });
    expect(screen.getByText('Start one first.')).toBeTruthy();
  });

  it('shows the Astrid sign-in command at the foot of its model list', () => {
    const signInLine = "Run `'/home/test/.local/share/astrid/run-astrid'`, then enter `/login` in Astrid.";
    const agents = ready.map(choice => choice.id === 'astrid' ? { ...choice, signInLine } : choice);
    const { onBrowseAgent, rerender } = openMenu({ agents });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Astrid model' }));
    rerender({ agents, agentModels: { agent: 'astrid', models: [], loading: false, note: 'No models available.' } });
    expect(onBrowseAgent).toHaveBeenCalledWith('astrid');
    expect(screen.getByText((_text, element) => element?.textContent === `More models: ${plainLine(signInLine)}`)).toBeTruthy();
  });

  it('keeps attaching an existing chat in the same menu', () => {
    const toggle = vi.fn();
    openMenu({ attachExisting: { open: false, toggle } });
    fireEvent.click(screen.getByRole('option', { name: /Attach an existing chat/ }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('offers Hide existing chats while attached chats are shown', () => {
    const toggle = vi.fn();
    openMenu({ attachExisting: { open: true, toggle } });
    fireEvent.click(screen.getByRole('option', { name: /Hide existing chats/ }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  const effortModels = {
    agent: 'claude-code' as const, defaultModel: 'opus', loading: false,
    models: [{ id: 'opus', name: 'Opus', thoughtLevel: { configId: 'effort', name: 'Effort', currentValue: 'low', recommendedValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] } }],
  };

  it('keeps the compact, borderless selector on the name line with the description underneath', () => {
    openMenu({ agentModels: { ...effortModels, models: [{ ...effortModels.models[0], detail: 'For complex work with a description that can wrap across the full row' }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    const row = screen.getByRole('option', { name: /Opus/ });
    const selector = within(row).getByRole('button', { name: 'Choose a thinking level for Opus' });
    const name = within(row).getByText('Opus');
    const detail = within(row).getByText(/For complex work/);
    expect(selector.parentElement).toBe(name.parentElement);
    expect(name.parentElement).toHaveClass('flex');
    expect(name.parentElement?.nextElementSibling).toBe(detail);
    expect(detail.parentElement).toHaveClass('flex-1', 'flex-col');
    expect(detail).not.toHaveClass('truncate');
    expect(selector).toHaveTextContent('High');
    expect(selector).toHaveClass('ml-auto', 'self-start', 'h-6', 'px-1.5', 'rounded', '[@media(pointer:coarse)]:min-h-[44px]');
    expect(selector.className.split(/\s+/).some(token => token === 'border' || token.startsWith('border-'))).toBe(false);
    expect(selector).not.toHaveClass('min-h-[44px]', 'min-w-[44px]');
  });

  it('highlights the selector while its level popover is open', () => {
    openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    const selector = screen.getByRole('button', { name: 'Choose a thinking level for Opus' });
    expect(selector).toHaveClass('aria-expanded:bg-accent', 'aria-expanded:text-foreground');
    expect(selector).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(selector);
    expect(selector).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(screen.getByRole('option', { name: 'Low' }), { key: 'Escape' });
    expect(selector).toHaveAttribute('aria-expanded', 'false');
  });

  it('starts immediately from a model with the recommended effort', async () => {
    const { onNewChat } = openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    await waitFor(() => expect(screen.getByRole('option', { name: /Opus/ })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(document.querySelector('[cmdk-root]')!, { key: 'Enter' });
    expect(onNewChat).toHaveBeenCalledWith('claude-code', 'opus', 'high');
  });

  it('opens levels above the selector without starting a chat or replacing the model list', async () => {
    const user = userEvent.setup();
    const { onNewChat } = openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    const search = screen.getByPlaceholderText('Search Claude Code models…');
    fireEvent.change(search, { target: { value: 'Opus' } });
    await user.click(screen.getByRole('button', { name: 'Choose a thinking level for Opus' }));
    const high = within(screen.getByRole('group', { name: 'Thinking level' })).getByRole('option', { name: /High/ });
    expect(high).toHaveAttribute('aria-current', 'true');
    expect(high).toHaveTextContent('Recommended');
    expect(high).toHaveClass('min-h-8', '[@media(pointer:coarse)]:min-h-[44px]');
    expect(high).not.toHaveClass('min-h-[44px]');
    expect(high.closest('[data-side]')).toHaveAttribute('data-side', 'top');
    expect(search).toHaveValue('Opus');
    expect(screen.getByRole('option', { name: /Opus/ })).toBeInTheDocument();
    expect(screen.getAllByText('Claude Code')).toHaveLength(1); // Only the agent back row remains.
    expect(screen.queryByText('A chat keeps its model and thinking level.')).toBeNull();
    expect(screen.queryByText(/Press → to pick its thinking level/)).toBeNull();
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it('updates the row without starting, remembers the choice after remount, and starts on the row click', async () => {
    const { onNewChat, view } = openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a thinking level for Opus' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    expect(onNewChat).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose a thinking level for Opus' })).toHaveTextContent('Low');
    expect(screen.getByPlaceholderText('Search Claude Code models…')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Thinking level')).toBeNull());
    view.unmount();

    const reopened = openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    expect(screen.getByRole('button', { name: 'Choose a thinking level for Opus' })).toHaveTextContent('Low');
    fireEvent.click(screen.getByRole('button', { name: 'Choose a thinking level for Opus' }));
    expect(screen.getByRole('option', { name: 'Low' })).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(screen.getByRole('option', { name: 'Low' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('option', { name: /Opus/ }));
    expect(reopened.onNewChat).toHaveBeenCalledExactlyOnceWith('claude-code', 'opus', 'low');
  });

  it('keeps the explicit thinking choice when storage is unavailable', () => {
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    try {
      const { onNewChat } = openMenu({ agentModels: effortModels });
      fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
      fireEvent.click(screen.getByRole('button', { name: 'Choose a thinking level for Opus' }));
      fireEvent.click(screen.getByRole('option', { name: 'Low' }));
      fireEvent.keyDown(screen.getByPlaceholderText('Search Claude Code models…'), { key: 'ArrowLeft' });
      fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
      expect(screen.getByRole('button', { name: 'Choose a thinking level for Opus' })).toHaveTextContent('Low');
      fireEvent.click(screen.getByRole('option', { name: /Opus/ }));
      expect(onNewChat).toHaveBeenCalledExactlyOnceWith('claude-code', 'opus', 'low');
    } finally { save.mockRestore(); }
  });

  it.each(['ArrowRight', ' '])('opens with %j, navigates levels, selects without starting, and returns with Esc', async key => {
    const user = userEvent.setup();
    const { onNewChat } = openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    const search = screen.getByPlaceholderText('Search Claude Code models…');
    const row = screen.getByRole('option', { name: /Opus/ });
    await waitFor(() => expect(row).toHaveAttribute('aria-selected', 'true'));
    search.focus();
    await user.keyboard(key === ' ' ? ' ' : '{ArrowRight}');
    const high = within(screen.getByRole('group', { name: 'Thinking level' })).getByRole('option', { name: /High/ });
    expect(high).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: 'Low' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(onNewChat).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose a thinking level for Opus' })).toHaveTextContent('Low');
    await waitFor(() => expect(search).toHaveFocus());
    expect(row).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('option', { name: 'Low' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{Escape}');
    await waitFor(() => expect(search).toHaveFocus());
    expect(row).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('claude-code', 'opus', 'low');
  });

  it('keeps model ↑/↓ navigation and Enter while giving each model its own level', async () => {
    const user = userEvent.setup();
    const { onNewChat } = openMenu({ agentModels: { ...effortModels, models: [
      effortModels.models[0], { ...effortModels.models[0], id: 'sonnet', name: 'Sonnet' },
    ] } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    await waitFor(() => expect(screen.getByRole('option', { name: /Opus/ })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a thinking level for Opus' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Sonnet/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Choose a thinking level for Sonnet' })).toHaveTextContent('High');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('claude-code', 'opus', 'low');
  });

  it('shows Codex descriptions and sentence-case option names', () => {
    openMenu({ agentModels: { ...effortModels, agent: 'codex', models: [{ id: 'sol', name: 'Sol', thoughtLevel: {
      configId: 'reasoning_effort', name: 'Effort', currentValue: 'high', options: [
        { value: 'high', name: 'High', description: 'Greater reasoning effort.' },
        { value: 'xhigh', name: 'Extra high', description: 'The most reasoning effort.' },
      ],
    } }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Codex model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a thinking level for Sol' }));
    expect(screen.getByRole('option', { name: /Extra high/ })).toHaveTextContent('The most reasoning effort.');
    expect(within(screen.getByRole('group', { name: 'Thinking level' })).getByRole('option', { name: /^High/ })).toHaveAttribute('aria-current', 'true');
  });

  it('falls back to the recommendation if a remembered level is no longer offered', () => {
    localStorage.setItem('astrid.app.modelThoughtSelections.claude-code', JSON.stringify({ opus: 'removed' }));
    openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    expect(screen.getByRole('button', { name: 'Choose a thinking level for Opus' })).toHaveTextContent('High');
  });

  it('defaults to the reported Default row without a recommendation', () => {
    const { onNewChat } = openMenu({ agentModels: { ...effortModels, models: [{ id: 'opus', name: 'Opus', thoughtLevel: {
      configId: 'effort', name: 'Effort', currentValue: 'high', options: [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High' }],
    } }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    fireEvent.click(screen.getByRole('option', { name: /Opus/ }));
    expect(onNewChat).toHaveBeenCalledWith('claude-code', 'opus', 'default');
  });

  it.each(['hermes', 'astrid', 'codex'] as const)('shows no selector for %s models without known levels', agent => {
    const { onNewChat } = openMenu({ agentModels: { agent, loading: false, models: [
      { id: 'a', name: 'Model A' },
      { id: 'b', name: 'Model B', thoughtLevel: { configId: 'effort', name: 'Effort', currentValue: 'high', options: [] } },
    ] } });
    fireEvent.click(screen.getByRole('button', { name: `Choose a ${LOCAL_AGENT_TABLE[agent].name} model` }));
    expect(screen.queryByRole('button', { name: /Choose a thinking level/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Model A' }));
    expect(onNewChat).toHaveBeenCalledWith(agent, 'a');
  });

  it('caps the model list at the submenu limit and says how many are hidden', () => {
    const models = Array.from({ length: 52 }, (_, index) => ({ id: `m${index}`, name: `Model ${index}` }));
    openMenu({ agentModels: { agent: 'codex', models, loading: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Codex model' }));
    expect(screen.getByText('Showing 50 of 52. Keep typing to narrow.')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Model 51' })).toBeNull();
  });

  it('shows the loading state while a model list is fetched', () => {
    openMenu({ agentModels: { agent: 'claude-code', models: [], loading: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    expect(screen.getByText('Loading models...')).toBeInTheDocument();
  });

  it('uses the agent-default row when the model list is empty', () => {
    const { onNewChat } = openMenu({ agentModels: { agent: 'claude-code', models: [], loading: false, note: 'Start one first.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    expect(screen.getByText('Start one first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Use the agent’s default model' }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('claude-code', undefined);
  });
});

describe('AgentChatMenu with an out-of-date local Astrid', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['MacIntel', 'Macintosh', ASTRID_COMMANDS.macLinuxUpdate],
    ['Win32', 'Windows', ASTRID_COMMANDS.windowsUpdate],
  ])('shows the update prompt and %s update command instead of the raw error', (platform, os, command) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(os);
    const error = new BridgeRouteError('List local agents', 409, { error: BRIDGE_CONTRACT_VERSION_MISMATCH_CODE });
    openMenu({ agentsError: error });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(RUNTIME_CONNECTION_COPY.chatNeedsUpdate);
    expect(alert).toHaveTextContent(RUNTIME_CONNECTION_COPY.updateNeeded.title);
    expect(alert).toHaveTextContent(withCommandShell(RUNTIME_CONNECTION_COPY.updateNeeded.sentence));
    expect(screen.getByText(command, { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText(error.message)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load agents/)).toBeNull();
  });

  it('places the update prompt above the Chats group', () => {
    const error = new BridgeRouteError('List local agents', 409, { error: BRIDGE_CONTRACT_VERSION_MISMATCH_CODE });
    openMenu({ agentsError: error, sessions: sessionsTwo, activeSessionId: 'one' });
    const alert = screen.getByRole('alert');
    const chats = screen.getByText('Chats');
    expect(alert.compareDocumentPosition(chats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the plain message for a network error', () => {
    openMenu({ agentsError: new Error('Failed to fetch') });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load agents: Failed to fetch');
    expect(screen.queryByText(RUNTIME_CONNECTION_COPY.chatNeedsUpdate)).toBeNull();
  });
});
