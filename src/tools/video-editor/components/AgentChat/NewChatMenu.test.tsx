// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ComponentProps } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CHAT_COPY, AGENT_INTEGRATION_PROMPT } from '@/integrations/astrid/chatCopy.ts';
import { LOCAL_AGENT_IDS, LOCAL_AGENT_TABLE, PERSONAL_AGENT_DIRECTORIES, type LocalAgentChoice } from '@/integrations/astrid/localAgents.ts';
import { ASTRID_COMMANDS, RUNTIME_CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { BRIDGE_CONTRACT_VERSION_MISMATCH_CODE, BridgeContractError } from '@/tools/video-editor/data/bridgeContract.ts';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { NewChatMenu, type NewChatMenuHandle, type NewChatAgentModels } from './NewChatMenu.tsx';
import { rememberNewChatChoice } from './newChatThinkingSelection.ts';

const keyMocks = vi.hoisted(() => ({ saveKey: vi.fn() }));
vi.mock('@/integrations/astrid/client.ts', () => ({
  AstridLocalClient: class { acp = { saveAstridApiKey: keyMocks.saveKey }; },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView ??= vi.fn();
});
afterEach(() => { cleanup(); localStorage.clear(); });
beforeEach(() => { keyMocks.saveKey.mockReset().mockResolvedValue({ signedIn: true }); });
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

type MenuProps = Partial<ComponentProps<typeof NewChatMenu>>;

/** Renders the split button with the chat-free defaults; `rerender` keeps the same callbacks and overrides props. */
function renderMenu(props: MenuProps = {}) {
  const onNewChat = vi.fn();
  const onBrowseAgent = vi.fn();
  const base = { defaultAgent: 'claude-code' as const, agents: ready, onNewChat, onBrowseAgent, ...props };
  const view = render(<NewChatMenu {...base} />);
  const rerender = (next: MenuProps = {}) => view.rerender(<NewChatMenu {...base} {...next} />);
  return { onNewChat, onBrowseAgent, view, rerender };
}

/** Renders the split button and opens the picker from its chevron. */
function openMenu(props: MenuProps = {}) {
  const rendered = renderMenu(props);
  fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
  return rendered;
}

describe('NewChatMenu + button', () => {
  it('uses the agent and model remembered by setup while the menu is mounted', () => {
    rememberNewChatChoice({ agent: 'hermes' });
    const { onNewChat } = renderMenu();
    expect(screen.getByRole('button', { name: 'New chat · Hermes' })).toBeInTheDocument();
    act(() => rememberNewChatChoice({ agent: 'astrid', model: 'openrouter/model', modelName: 'Model' }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat · Astrid · Model' }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('astrid', 'openrouter/model');
  });
  it('starts the default agent with its default model when no chat is open', () => {
    const { onNewChat } = renderMenu({ agentModelNames: { 'claude-code': 'Sonnet' } });
    const plus = screen.getByRole('button', { name: 'New chat · Claude Code · Sonnet' });
    expect(plus).toHaveAttribute('title', 'New chat · Claude Code · Sonnet');
    fireEvent.click(plus);
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
  });

  it('starts with the open chat\'s agent and model', () => {
    const { onNewChat } = renderMenu({ current: { agent: 'codex', model: 'gpt-x', modelName: 'GPT X' }, agentModelNames: { 'claude-code': 'Sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'New chat · Codex · GPT X' }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('codex', 'gpt-x');
  });

  it('carries the open chat\'s thinking level', () => {
    const { onNewChat } = renderMenu({ current: { agent: 'claude-code', model: 'opus', modelName: 'Opus', thoughtLevel: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'New chat · Claude Code · Opus' }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('claude-code', 'opus', 'high');
  });

  it('names just the agent when the open chat has no known model', () => {
    renderMenu({ current: { agent: 'codex' } });
    expect(screen.getByRole('button', { name: 'New chat · Codex' })).toBeInTheDocument();
  });

  it('is disabled while a chat is starting or there is no project, and its chevron only without a project', () => {
    const { rerender } = renderMenu({ newChatDisabled: true });
    expect(screen.getByRole('button', { name: /^New chat/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose the agent and model for new chats' })).toBeEnabled();
    rerender({ newChatDisabled: false, disabled: true });
    expect(screen.getByRole('button', { name: /^New chat/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose the agent and model for new chats' })).toBeDisabled();
  });

  it('reports open and close of the picker through onOpenChange', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderMenu({ onOpenChange });
    await user.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it('opens with the open chat\'s agent highlighted, and the default agent otherwise', () => {
    const { view } = renderMenu({ current: { agent: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    expect(screen.getByRole('option', { name: /Codex/ })).toHaveAttribute('aria-selected', 'true');
    view.unmount();
    openMenu();
    expect(screen.getByRole('option', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('NewChatMenu agent rows', () => {
  it('treats a ready but signed-out row as needing sign-in', () => {
    openMenu({ defaultAgent: 'codex', agents: ready.map(row => row.id === 'codex' ? { ...row, signIn: 'signed-out' } : row) });
    expect(screen.getByRole('option', { name: /Codex/ })).toHaveTextContent('Sign in');
    expect(screen.queryByRole('button', { name: 'Choose a Codex model' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat · Codex' })).toBeDisabled();
  });
  it.each([undefined, 'unknown', 'signed-in'] as const)('allows ready rows with signIn %s', signIn => {
    openMenu({ defaultAgent: 'codex', agents: ready.map(row => ({ ...row, signIn })) });
    expect(screen.getByRole('option', { name: /Codex/ })).toHaveTextContent('Ready');
    expect(screen.getByRole('button', { name: 'Choose a Codex model' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New chat · Codex' })).toBeEnabled();
  });
  it.each([{ agents: undefined }, { agents: [] }])('only keeps the no-rows fallback when loading failed ($agents)', ({ agents }) => {
    const { rerender, onNewChat } = renderMenu({ agents });
    const plus = screen.getByRole('button', { name: 'New chat · Claude Code' });
    expect(plus).toBeDisabled();
    rerender({ agents, agentsLoading: true });
    expect(plus).toBeDisabled();
    rerender({ agents, agentsError: new Error('Could not load agents') });
    expect(plus).toBeEnabled();
    fireEvent.click(plus);
    expect(onNewChat).toHaveBeenCalledOnce();
  });
  it('does not apply the load-error fallback to a missing row in a loaded list', () => {
    renderMenu({ agents: ready.filter(row => row.id !== 'claude-code'), agentsError: new Error('Refresh failed') });
    expect(screen.getByRole('button', { name: 'New chat · Claude Code' })).toBeDisabled();
  });
  it('shows an agent row\'s default model and no Last used mark', () => {
    openMenu({ agentModelNames: { 'claude-code': 'Sonnet 4.5' } });
    expect(screen.getByLabelText('Ready, using Sonnet 4.5')).toHaveTextContent('Sonnet 4.5');
    expect(screen.queryByText('Last used')).toBeNull();
  });

  it('starts a chat with a ready agent row that has no model list, using its default model', () => {
    const { onNewChat } = openMenu({ agentCanBrowse: { codex: false } });
    fireEvent.click(screen.getByRole('option', { name: /Codex/ }));
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New chat · Codex' }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('codex', undefined);
  });

  it('opens a browsable agent row\'s model list instead of starting a chat', () => {
    const { onNewChat, onBrowseAgent } = openMenu();
    fireEvent.click(screen.getByRole('option', { name: /Codex/ }));
    expect(onBrowseAgent).toHaveBeenLastCalledWith('codex');
    expect(onNewChat).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Search Codex models…')).toBeTruthy();
  });

  it('chooses the agent when its row opened a model list that turns out empty', async () => {
    const { onNewChat, rerender } = openMenu({ defaultAgent: 'hermes', agentCanBrowse: { hermes: true } });
    fireEvent.click(screen.getByRole('option', { name: /Hermes/ }));
    rerender({ agentModels: { agent: 'hermes', models: [], loading: false } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New chat · Hermes' })).toBeInTheDocument());
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New chat · Hermes' }));
    expect(onNewChat).toHaveBeenCalledWith('hermes', undefined);
  });

  it('closes the menu when a ready agent is chosen, without starting a chat', async () => {
    const onOpenChange = vi.fn();
    const { onNewChat } = openMenu({ onOpenChange, agentCanBrowse: { codex: false }, agents: ready.map(choice => choice.id === 'codex' ? choice : { ...choice, state: 'sign-in' as const, line: null }) });
    fireEvent.click(screen.getByRole('option', { name: /Codex/ }));
    expect(onNewChat).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'New chat · Codex' }));
    expect(onNewChat).toHaveBeenCalledWith('codex', undefined);
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
    expect(screen.getByText('Use for new chats')).toBeInTheDocument();
    expect(screen.queryByText(RUNTIME_CONNECTION_COPY.chatNeedsUpdate)).toBeNull();
  });

  it('shows an agent\'s state label and its install line on the row', () => {
    openMenu({ agents: [{ id: 'hermes', name: 'Hermes', state: 'not-installed', line: 'Install with `hermes install`.' }] });
    expect(screen.getByRole('option', { name: /Hermes/ })).toHaveTextContent('Not installed');
    expect(screen.getByRole('option', { name: /Hermes/ })).toHaveTextContent('Install with hermes install.');
  });

  it('expands Another agent in place with the keyboard and keeps the menu open while copying both instructions', async () => {
    const user = userEvent.setup();
    const onSetupAgent = vi.fn();
    const onOpenChange = vi.fn();
    const agents = ready.map(agent => agent.id === 'astrid' ? { ...agent, terminal: { command: 'astrid-dev', skillSynced: false } } : agent);
    openMenu({ agents, onSetupAgent, onOpenChange });
    const other = screen.getByRole('option', { name: /Another agent/ });
    expect(other).toHaveTextContent('Gemini CLI, OpenCode…');
    expect(other.querySelector('svg.lucide-check')).toHaveClass('opacity-0');
    expect(other).toHaveAttribute('aria-expanded', 'false');
    expect(within(other).queryByRole('button', { name: AGENT_CHAT_COPY.copyAgentInstruction })).toBeNull();

    const command = screen.getByRole('dialog', { name: 'New chat' }).querySelector('[cmdk-root]') as HTMLElement;
    command.focus();
    for (let index = 0; index <= ready.length && other.getAttribute('aria-selected') !== 'true'; index++) {
      await user.keyboard('{ArrowDown}');
    }
    expect(other).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    expect(other).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'New chat' })).toBeInTheDocument();
    expect(onSetupAgent).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const instruction = AGENT_CHAT_COPY.anotherAgentInstruction('astrid-dev');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    const instructionButton = within(other).getByRole('button', { name: AGENT_CHAT_COPY.copyAgentInstruction });
    await user.tab();
    expect(instructionButton).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('button', { name: 'Instruction copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(instruction);
    await user.tab();
    expect(within(other).getByRole('button', { name: 'Copy integration prompt' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('button', { name: AGENT_CHAT_COPY.integrationPromptCopied })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(AGENT_INTEGRATION_PROMPT);

    command.focus();
    await user.keyboard('{Enter}');
    expect(other).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('dialog', { name: 'New chat' })).toBeInTheDocument();
  });
});

describe('NewChatMenu choice', () => {
  it('names the chosen agent on +, ticks it, and remembers it across a remount', () => {
    const { onNewChat, view } = openMenu({ agentCanBrowse: { codex: false }, agentModelNames: { codex: 'gpt-5.5' } });
    fireEvent.click(screen.getByRole('option', { name: /Codex/ }));
    expect(onNewChat).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'New chat · Codex · gpt-5.5' })).toBeInTheDocument();
    view.unmount();
    const again = openMenu({ agentCanBrowse: { codex: false }, agentModelNames: { codex: 'gpt-5.5' } });
    expect(screen.getByRole('button', { name: 'New chat · Codex · gpt-5.5' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Codex/ }).querySelector('svg.opacity-100')).not.toBeNull();
    expect(screen.getByRole('option', { name: /Claude Code/ }).querySelector('svg.opacity-100')).toBeNull();
    again.view.unmount();
  });

  it('ignores a stored choice whose agent is no longer usable', () => {
    localStorage.setItem('astrid.app.newChatChoice', JSON.stringify({ agent: 'codex' }));
    renderMenu({ agents: ready.map(choice => choice.id === 'codex' ? { ...choice, state: 'not-installed' as const, line: null } : choice) });
    expect(screen.getByRole('button', { name: /^New chat · Claude Code/ })).toBeInTheDocument();
  });
});

describe('NewChatMenu handle', () => {
  it('opens directly on an agent\'s model list through the ref', () => {
    const ref = createRef<NewChatMenuHandle>();
    const onBrowseAgent = vi.fn();
    const onOpenChange = vi.fn();
    render(<NewChatMenu ref={ref} sessions={[]} activeSessionId={null} defaultAgent="claude-code" agents={ready} onNewChat={vi.fn()} onBrowseAgent={onBrowseAgent} onOpenChange={onOpenChange} />);
    act(() => ref.current?.openModels('claude-code'));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(onBrowseAgent).toHaveBeenLastCalledWith('claude-code');
    expect(screen.getByPlaceholderText('Search Claude Code models…')).toBeInTheDocument();
  });
});

describe('NewChatMenu model list', () => {
  const effortModels = {
    agent: 'claude-code' as const, defaultModel: 'opus', loading: false,
    models: [{ id: 'opus', name: 'Opus', thoughtLevel: { configId: 'effort', name: 'Effort', currentValue: 'low', recommendedValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] } }],
  };

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

  it('opens Astrid’s key form in the model panel when the row is picked without a configured model', () => {
    const { onNewChat, onBrowseAgent } = openMenu({
      defaultAgent: 'astrid', astridKeyConfigured: false,
      agentModels: { agent: 'astrid', models: [], loading: false },
    });
    fireEvent.click(screen.getByRole('option', { name: /Astrid/ }));
    expect(screen.getByLabelText('OpenRouter key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByText('Your key goes straight to Astrid on this computer.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Get a key at openrouter\.ai\/keys/ })).toBeInTheDocument();
    expect(onBrowseAgent).toHaveBeenLastCalledWith('astrid');
    expect(onNewChat).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose the agent and model for new chats' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('refreshes models in the open panel after saving a key, then starts the selected model', async () => {
    const onAstridKeySaved = vi.fn().mockResolvedValue(undefined);
    const { onNewChat, rerender } = openMenu({
      defaultAgent: 'astrid', current: { agent: 'astrid' }, astridKeyConfigured: false, onAstridKeySaved,
      agentModels: { agent: 'astrid', models: [], loading: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Astrid model' }));
    fireEvent.change(screen.getByLabelText('OpenRouter key'), { target: { value: 'test-openrouter-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onAstridKeySaved).toHaveBeenCalledOnce());
    expect(keyMocks.saveKey).toHaveBeenCalledExactlyOnceWith('openrouter', 'test-openrouter-key');
    expect(document.body.innerHTML).not.toContain('test-openrouter-key');
    expect(screen.getByRole('option', { name: 'OpenRouter key' })).toBeInTheDocument();
    rerender({ agentModels: { agent: 'astrid', models: [{ id: 'openrouter/model', name: 'Model' }], defaultModel: 'openrouter/model', loading: false } });
    expect(screen.getByText('Model')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New chat with Model' }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('astrid', 'openrouter/model');
  });

  it('opens the Astrid key panel from + when Astrid has no configured key', () => {
    const { onNewChat } = renderMenu({
      current: { agent: 'astrid' }, defaultAgent: 'astrid', astridKeyConfigured: false,
      agentModels: { agent: 'astrid', models: [], loading: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New chat · Astrid' }));
    expect(screen.getByLabelText('OpenRouter key')).toBeInTheDocument();
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it('toggles the replacement field and Escape closes without saving', async () => {
    const { onNewChat } = renderMenu({
      current: { agent: 'astrid' }, defaultAgent: 'astrid', astridKeyConfigured: true,
      agentModels: { agent: 'astrid', models: [{ id: 'model', name: 'Model' }], defaultModel: 'model', loading: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Astrid model' }));
    fireEvent.click(screen.getByRole('option', { name: 'OpenRouter key' }));
    expect(screen.getByLabelText('OpenRouter key')).toBeInTheDocument();
    expect(screen.getByText('An OpenRouter key is saved. Enter a replacement to change it.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'OpenRouter key' }));
    expect(screen.queryByLabelText('OpenRouter key')).toBeNull();
    expect(keyMocks.saveKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'OpenRouter key' }));
    expect(screen.getByLabelText('OpenRouter key')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('OpenRouter key'), { target: { value: 'unsaved-replacement' } });
    fireEvent.keyDown(screen.getByLabelText('OpenRouter key'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('OpenRouter key')).toBeNull());
    expect(keyMocks.saveKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Astrid model' }));
    fireEvent.click(screen.getByRole('option', { name: 'OpenRouter key' }));
    expect(screen.getByLabelText('OpenRouter key')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'OpenRouter key' })).toHaveAttribute('aria-expanded', 'true');
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it.each([
    ['astrid', '~/.omp/agent/agents', 'Astrid'],
    ['claude-code', '~/.claude/agents', 'Claude Code'],
    ['codex', '~/.codex/agents', 'Codex'],
  ] as const)('shows the %s personal subagent folder in its model panel', (agent, directory, name) => {
    expect(PERSONAL_AGENT_DIRECTORIES[agent]).toBe(directory);
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a ' + name + ' model' }));
    expect(screen.getByText(directory, { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp('ask ' + name + ' to make one'))).toBeInTheDocument();
  });

  it('does not show a personal subagent folder for Hermes', () => {
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Hermes model' }));
    expect(screen.queryByText(/Subagents:/)).toBeNull();
  });

  it('starts a ready non-default agent with its own default when its catalog is empty', () => {
    const { onNewChat, onBrowseAgent, rerender } = openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Codex model' }));
    rerender({ agentModels: { agent: 'codex', models: [], loading: false } });
    fireEvent.click(screen.getByRole('option', { name: "Use the agent's default model" }));
    expect(onBrowseAgent).toHaveBeenCalledWith('codex');
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('codex', undefined);
    expect(screen.queryByPlaceholderText('Search Codex models...')).toBeNull();
  });

  it('starts Hermes directly and omits model drill-in until a model list is reported', () => {
    const { onNewChat } = openMenu({ defaultAgent: 'hermes', agentCanBrowse: { hermes: false } });
    expect(screen.getByRole('option', { name: /Hermes/ })).toHaveTextContent('Ready');
    expect(screen.queryByRole('button', { name: 'Choose a Hermes model' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Hermes/ }));
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
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
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
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
    expect(screen.getByText('Use for new chats')).toBeInTheDocument();
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
    expect(screen.getAllByText((_text, element) => element?.textContent === 'More models: ' + plainLine(signInLine)).length).toBeGreaterThan(0);
  });


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
    expect(selector).toHaveClass('h-6', 'px-1', 'rounded', '[@media(pointer:coarse)]:min-h-[44px]');
    expect(selector.className.split(/\s+/).some(token => token === 'border' || token.startsWith('border-'))).toBe(false);
    expect(selector).not.toHaveClass('min-h-[44px]', 'min-w-[44px]');
  });

  it('shows the level the row would use next to the model name', () => {
    localStorage.setItem('astrid.app.modelThoughtSelections.claude-code', JSON.stringify({ opus: 'low' }));
    openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    const selector = screen.getByRole('button', { name: 'Choose a thinking level for Opus' });
    expect(selector).toHaveClass('text-[11px]');
    expect(selector.previousElementSibling).toHaveTextContent('Opus');
    expect(selector).toHaveTextContent('· Low');
  });

  it("starts exactly one chat from a row's New chat button, and selecting the row starts none", () => {
    localStorage.setItem('astrid.app.modelThoughtSelections.claude-code', JSON.stringify({ opus: 'low' }));
    const { onNewChat } = openMenu({ agentModels: effortModels });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    fireEvent.click(screen.getByRole('option', { name: /Opus/ }));
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the agent and model for new chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Claude Code model' }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat with Opus · Low' }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('claude-code', 'opus', 'low');
    expect(screen.getByRole('button', { name: /^New chat · Claude Code · Opus/ })).toBeInTheDocument();
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
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
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
    expect(reopened.onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
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
      expect(onNewChat).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
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
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
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
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
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
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
    expect(onNewChat).toHaveBeenCalledWith('claude-code', 'opus', 'default');
  });

  it.each(['hermes', 'astrid', 'codex'] as const)('shows no selector for %s models without known levels', agent => {
    const { onNewChat } = openMenu({ agentModels: { agent, loading: false, models: [
      { id: 'a', name: 'Model A' },
      { id: 'b', name: 'Model B', thoughtLevel: { configId: 'effort', name: 'Effort', currentValue: 'high', options: [] } },
    ] } });
    fireEvent.click(screen.getByRole('button', { name: `Choose a ${LOCAL_AGENT_TABLE[agent].name} model` }));
    expect(screen.queryByRole('button', { name: /Choose a thinking level/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /^Model A/ }));
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
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
    fireEvent.click(screen.getByRole('option', { name: "Use the agent's default model" }));
    expect(onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^New chat ·/ }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith('claude-code', undefined);
  });
});

describe('NewChatMenu with an out-of-date local Astrid', () => {
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
    expect(alert).toHaveTextContent('Copy for your agent');
    expect(alert).toHaveTextContent('Run it yourself');
    expect(alert).toHaveTextContent('If you run Astrid from source checkouts');
    expect(alert).not.toHaveTextContent('This page needs a newer Astrid');
    expect(screen.getByText(command, { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText(error.message)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load agents/)).toBeNull();
  });

  it('shows malformed bridge payload errors as real errors, not update prompts', () => {
    const error = new BridgeContractError('List local agents', 'agents.0.models: Invalid input');
    openMenu({ agentsError: error });
    expect(screen.getByRole('alert')).toHaveTextContent(error.message);
    expect(screen.queryByText(RUNTIME_CONNECTION_COPY.chatNeedsUpdate)).toBeNull();
  });


  it('keeps the plain message for a network error', () => {
    openMenu({ agentsError: new Error('Failed to fetch') });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load agents: Failed to fetch');
    expect(screen.queryByText(RUNTIME_CONNECTION_COPY.chatNeedsUpdate)).toBeNull();
  });
});
