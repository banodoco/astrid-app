// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_AGENT_IDS, LOCAL_AGENT_TABLE, type LocalAgentChoice } from '@/integrations/astrid/localAgents.ts';
import type { AcpModelCatalog } from '@/integrations/astrid/acpRoutes.ts';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { AGENT_INTEGRATION_PROMPT } from '@/integrations/astrid/chatCopy.ts';
import { AgentSetupCard } from './AgentSetupCard';

const mocks = vi.hoisted(() => ({ models: vi.fn(), saveKey: vi.fn(), readChoice: vi.fn(), remember: vi.fn() }));
vi.mock('@/integrations/astrid/client.ts', () => ({ AstridLocalClient: class { acp = { models: mocks.models, saveAstridApiKey: mocks.saveKey }; } }));
vi.mock('./newChatThinkingSelection', () => ({ readNewChatChoice: mocks.readChoice, rememberNewChatChoice: mocks.remember }));
const clients: QueryClient[] = [];
const ready = (): LocalAgentChoice[] => LOCAL_AGENT_IDS.map(id => ({ id, name: LOCAL_AGENT_TABLE[id].name, state: 'ready', signIn: 'signed-in', line: null, models: [], defaultModel: null }));
const catalog = (): AcpModelCatalog => ({ providers: [
  { id: 'other', name: 'Other account', signedIn: false, models: [{ id: 'model', name: 'Unavailable model' }] },
  { id: 'openrouter', name: 'OpenRouter', signedIn: true, models: [{ id: 'first', name: 'First model' }, { id: 'default', name: 'Default model' }] },
  { id: 'claude', name: 'Claude', signedIn: true, models: [{ id: 'sonnet', name: 'Sonnet' }] },
], currentModel: 'openrouter/default' });
function mount(props: Partial<React.ComponentProps<typeof AgentSetupCard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const base = { agents: ready(), defaultAgent: 'astrid' as const, refetchAgents: vi.fn().mockResolvedValue(undefined), startChatWith: vi.fn().mockResolvedValue(undefined), onComplete: vi.fn(), ...props };
  const view = render(<QueryClientProvider client={client}><AgentSetupCard {...base} /></QueryClientProvider>);
  return { ...base, ...view, rerenderCard: (next: Partial<typeof base>) => view.rerender(<QueryClientProvider client={client}><AgentSetupCard {...base} {...next} /></QueryClientProvider>) };
}
const choose = (name: string) => fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
beforeEach(() => { vi.clearAllMocks(); mocks.readChoice.mockReturnValue(null); mocks.models.mockResolvedValue({ providers: [], currentModel: null }); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.useRealTimers(); });

describe('AgentSetupCard choices', () => {
  it('shows all statuses, names, subtitles and linked credit', () => {
    const agents = ready();
    agents[0] = { ...agents[0], state: 'sign-in', signIn: 'signed-out', creditLine: 'Built on oh-my-pi', creditUrl: 'https://example.test/omp' };
    agents[1].signIn = 'unknown'; agents[2].signIn = 'signed-out'; agents[3].state = 'not-installed';
    const view = mount({ agents });
    expect(within(screen.getByRole('option', { name: /Astrid's agent/ })).getByText('Set up')).toBeInTheDocument();
    expect(screen.getByText('Check sign-in')).toBeInTheDocument();
    expect(screen.getByText('Sign in', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Not installed')).toBeInTheDocument();
    expect(screen.getByText('Use your OpenRouter, ChatGPT or Claude account')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Built on oh-my-pi' })).toHaveAttribute('href', 'https://example.test/omp');
    view.rerenderCard({ agents: ready() });
    expect(screen.getAllByText('Ready')).toHaveLength(5);
  });
  it.each(['last', 'external', 'astrid'])('highlights and focuses the %s choice', kind => {
    const agents = ready();
    if (kind === 'last') mocks.readChoice.mockReturnValue({ agent: 'codex' });
    else agents[0].signIn = 'signed-out';
    if (kind === 'astrid') agents.slice(1).forEach(row => { row.signIn = 'signed-out'; });
    mount({ agents });
    const selected = screen.getByRole('option', { name: kind === 'last' ? /Use Codex/ : kind === 'external' ? /Use Claude Code/ : /Astrid's agent/ });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(selected).toHaveFocus();
  });
  it('supports arrows, Home, End and Enter', async () => {
    mount();
    fireEvent.keyDown(screen.getByRole('option', { selected: true }), { key: 'End' });
    expect(screen.getByRole('option', { name: /Another agent/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Octop/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Hermes/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Use Codex/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('option', { name: /Astrid's agent/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await screen.findByText('Getting Claude Code ready…');
  });
});

describe('another agent setup', () => {
  it.each(['astrid', "'/custom Astrid/run-astrid'", undefined])('offers terminal instructions using %s and returns to the sixth row', async command => {
    const agents = ready();
    if (command) agents[0].terminal = { command, skillSynced: false };
    agents[2].terminal = { command: 'codex', skillSynced: true };
    const view = mount({ agents, onSetup: vi.fn() });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(6);
    expect(options[5]).toHaveTextContent('Another agentUse a different agent, like Gemini CLI or OpenCode');
    expect(within(options[5]).queryByText(/Ready|Set up|Sign in|Not installed/)).toBeNull();
    choose('Another agent');
    expect(screen.getByRole('heading', { name: 'Use it from your terminal' })).toHaveFocus();
    expect(screen.getByText('Run your agent in a terminal and ask it to use Astrid. Edits, tasks and generations show up right here.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Or build an integration so it chats right here' })).toBeInTheDocument();
    expect(screen.getByText("Your coding agent can add it to Astrid's chat. Copy this prompt into it.")).toBeInTheDocument();
    const instruction = `Use Astrid to edit my video project. Run "${command ?? 'astrid'} --help" to see what it can do.`;
    expect(screen.getByText(instruction)).toBeInTheDocument();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy instruction for your agent' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(instruction));
    expect(view.startChatWith).not.toHaveBeenCalled();
    expect(view.onSetup).not.toHaveBeenCalled();
    expect(mocks.models).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('option', { name: /Another agent/ })).toHaveFocus();
    expect(screen.getByRole('option', { name: /Another agent/ })).toHaveAttribute('aria-selected', 'true');
  });
  it('copies the integration prompt without rendering it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = mount(); choose('Another agent');
    expect(view.container.innerHTML).not.toContain(AGENT_INTEGRATION_PROMPT.split('\n')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy a prompt to build the integration' }));
    expect(await screen.findByRole('button', { name: 'Prompt copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(AGENT_INTEGRATION_PROMPT);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(view.container.innerHTML).not.toContain(AGENT_INTEGRATION_PROMPT.split('\n')[0]);
  });
  it('offers a selectable prompt when copying fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    mount(); choose('Another agent');
    fireEvent.click(screen.getByRole('button', { name: 'Copy a prompt to build the integration' }));
    expect(await screen.findByRole('textbox', { name: 'Copy a prompt to build the integration' })).toHaveValue(AGENT_INTEGRATION_PROMPT);
    expect(screen.getByRole('status')).toHaveTextContent(/Copying didn't work/i);
  });
});

describe('external setup and recovery', () => {
  it('names an agent that exited during setup and lets it retry immediately', async () => {
    const error = new BridgeRouteError('Start', 502, { error: 'acp_process_exited', detail: 'ACP process stdio disconnected.' });
    const startChatWith = vi.fn().mockResolvedValueOnce({ error }).mockResolvedValue(undefined);
    const view = mount({ startChatWith });
    choose('Use Codex');
    expect(await screen.findByRole('alert')).toHaveTextContent('Codex stopped before it was ready. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again', exact: true }));
    await waitFor(() => expect(view.onComplete).toHaveBeenCalledOnce());
    expect(startChatWith).toHaveBeenCalledTimes(2);
  });
  it('lets a slow agent check finish across multiple polling ticks', async () => {
    vi.useFakeTimers();
    const agents = ready();
    agents[2] = { ...agents[2], state: 'not-installed', signIn: 'unknown' };
    let finish!: (value: LocalAgentChoice[]) => void;
    const queryFn = vi.fn(() => new Promise<LocalAgentChoice[]>(resolve => { finish = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    clients.push(client);
    const startChatWith = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      const query = useQuery({ queryKey: ['slow-agents'], queryFn, initialData: agents, staleTime: Infinity });
      return <AgentSetupCard agents={query.data} defaultAgent="astrid" refetchAgents={query.refetch} startChatWith={startChatWith} onComplete={() => {}} />;
    }
    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    choose('Use Codex');
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(queryFn).toHaveBeenCalledTimes(1);
    await act(async () => { finish(ready()); await vi.advanceTimersByTimeAsync(1); });
    expect(startChatWith).toHaveBeenCalledExactlyOnceWith('codex', undefined, expect.any(Function));
  });
  it('does not start a missing agent row', async () => {
    const view = mount({ agents: [] }); choose('Use Codex');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(view.startChatWith).not.toHaveBeenCalled();
    expect(screen.getByText('Waiting for you to sign in…')).toBeInTheDocument();
  });
  it.each(['state', 'signIn', 'steps'] as const)('waits through unchanged polls after failure, then retries when %s changes', async field => {
    vi.useFakeTimers();
    const error = new BridgeRouteError('Start', 502, { error: 'agent_sign_in_required', detail: 'Sign-in expired', next_action: 'codex login' });
    const startChatWith = vi.fn().mockResolvedValueOnce({ error }).mockResolvedValue(undefined);
    const view = mount({ startChatWith });
    await act(async () => { choose('Use Codex'); });
    const alert = screen.getByRole('alert');
    const unchanged = ready();
    unchanged[1].state = 'not-installed';
    unchanged[2].line = 'A different description';
    unchanged[2].models = [{ modelId: 'new-model', name: 'New model' }];
    await act(async () => {
      view.rerenderCard({ agents: unchanged });
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(startChatWith).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toBe(alert);
    expect(alert).toHaveTextContent('Sign-in expired');
    const changed = ready();
    if (field === 'state') changed[2].state = 'sign-in';
    if (field === 'signIn') changed[2].signIn = 'unknown';
    if (field === 'steps') changed[2].steps = [{ kind: 'sign-in', command: 'codex login', label: 'Sign in' }];
    await act(async () => { view.rerenderCard({ agents: changed }); });
    if (field === 'state') {
      expect(startChatWith).toHaveBeenCalledOnce();
      expect(screen.getByRole('alert')).toHaveTextContent('Sign-in expired');
      await act(async () => { view.rerenderCard({ agents: ready() }); });
    }
    expect(startChatWith).toHaveBeenCalledTimes(2);
    expect(view.onComplete).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps an initial setup error until its agent row changes', async () => {
    vi.useFakeTimers();
    const error = new BridgeRouteError('Start', 502, { error: 'agent_not_installed', detail: 'Agent is missing' });
    const view = mount({ initialAgent: 'codex', initialError: error });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Agent is missing');
    expect(view.startChatWith).not.toHaveBeenCalled();
    const agents = ready(); agents[2].steps = [];
    await act(async () => { view.rerenderCard({ agents }); });
    expect(view.onComplete).toHaveBeenCalledOnce();
  });
  it('compares setup steps by value across refreshed rows', async () => {
    const error = new BridgeRouteError('Start', 502, { error: 'agent_sign_in_required', detail: 'Sign-in expired' });
    const agents = ready(); agents[2].steps = [{ kind: 'sign-in', command: 'codex login', label: 'Sign in' }];
    const view = mount({ agents, initialAgent: 'codex', initialError: error });
    const refreshed = ready(); refreshed[2].steps = [{ label: 'Sign in', command: 'codex login', kind: 'sign-in' }];
    await act(async () => { view.rerenderCard({ agents: refreshed }); });
    expect(view.startChatWith).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in expired');
    const changed = ready(); changed[2].steps = [{ kind: 'sign-in', command: 'codex login', label: 'Sign in again' }];
    await act(async () => { view.rerenderCard({ agents: changed }); });
    expect(view.onComplete).toHaveBeenCalledOnce();
  });
  it.each(['success', 'failure'] as const)('offers Back after 10 seconds and ignores a late %s without starting again', async outcome => {
    vi.useFakeTimers();
    let finish!: (result: { error?: Error; sessionId?: string }) => void;
    const startChatWith = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = mount({ startChatWith });
    await act(async () => { choose('Use Codex'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(9999); });
    expect(screen.getByText('Getting Codex ready…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(startChatWith.mock.calls[0][2]()).toBe(false);
    await act(async () => {
      finish(outcome === 'success' ? { sessionId: 'codex:late' } : { error: new Error('Late failure') });
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(startChatWith).toHaveBeenCalledOnce();
    expect(view.onComplete).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('renders install steps, polls every 3 seconds and on focus, then advances when ready', async () => {
    vi.useFakeTimers();
    const agents = ready();
    agents[2] = { ...agents[2], state: 'not-installed', steps: [{ kind: 'install', command: 'install-codex', label: 'Copy install' }, { kind: 'sign-in', command: 'codex login', label: 'Copy sign-in' }] };
    const view = mount({ agents }); choose('Use Codex');
    expect(screen.getByText('install-codex')).toBeInTheDocument();
    expect(screen.getByText('codex login')).toBeInTheDocument();
    expect(screen.getByText('Waiting for Codex…')).toHaveAttribute('aria-live', 'polite');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(view.refetchAgents).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(view.refetchAgents).toHaveBeenCalledTimes(2);
    await act(async () => { view.rerenderCard({ agents: ready() }); });
    expect(view.startChatWith).toHaveBeenCalledExactlyOnceWith('codex', undefined, expect.any(Function));
    expect(view.onComplete).toHaveBeenCalledWith('codex', undefined);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(view.refetchAgents).toHaveBeenCalledTimes(3);
  });
  it('uses only sign-in steps for signed-out agents', () => {
    const agents = ready(); agents[1] = { ...agents[1], signIn: 'signed-out', steps: [{ kind: 'install', command: 'install-claude', label: 'Install' }, { kind: 'sign-in', command: 'claude login', label: 'Login' }] };
    const view = mount({ agents }); choose('Use Claude Code');
    expect(screen.queryByText('install-claude')).toBeNull();
    expect(screen.getByText('claude login')).toBeInTheDocument();
    expect(screen.getByText('Waiting for you to sign in…')).toBeInTheDocument();
    expect(view.startChatWith).not.toHaveBeenCalled();
  });
  it('falls back to line for old services and treats ready without signIn as usable', async () => {
    const agents = ready().map(({ signIn: _, ...row }) => row);
    agents[3] = { ...agents[3], state: 'not-installed', line: 'Run `install-hermes`.' };
    const view = mount({ agents }); choose('Use Hermes');
    expect(screen.getByText('install-hermes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    view.rerenderCard({ agents: ready().map(({ signIn: _, ...row }) => row) });
    await waitFor(() => expect(view.onComplete).toHaveBeenCalledWith('hermes', undefined));
  });
  it('returns setup errors to step 2 with nextAction when there are no steps', async () => {
    const error = new BridgeRouteError('Start', 502, { error: 'agent_sign_in_required', detail: 'Sign-in expired', next_action: 'codex login' });
    const view = mount({ startChatWith: vi.fn().mockResolvedValue({ error }) }); choose('Use Codex');
    expect(await screen.findByText('codex login')).toBeInTheDocument();
    expect(screen.getByText('Sign-in expired')).toBeInTheDocument();
    expect(screen.getByText('Waiting for you to sign in…')).toBeInTheDocument();
    expect(view.startChatWith).toHaveBeenCalledOnce();
    expect(view.onComplete).not.toHaveBeenCalled();
  });
  it('opens a new setup error on its agent even when the chooser is already mounted', async () => {
    const view = mount();
    view.rerenderCard({ initialAgent: 'hermes', initialError: new BridgeRouteError('Start', 502, { error: 'agent_not_installed', detail: 'Hermes is missing', next_action: 'install-hermes' }) });
    expect(await screen.findByText('install-hermes')).toBeVisible();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(view.startChatWith).not.toHaveBeenCalled();
  });
  it('shows the runtime fix over agent sign-in steps and retries immediately', async () => {
    const error = new BridgeRouteError('Start', 502, { error: 'agent_runtime_missing', detail: 'Bun is missing', next_action: 'install-bun' });
    const startChatWith = vi.fn().mockResolvedValueOnce({ error }).mockResolvedValue(undefined);
    const agents = ready();
    agents[2].steps = [{ kind: 'sign-in', command: 'codex login', label: 'Sign in' }];
    const view = mount({ agents, startChatWith }); choose('Use Codex');
    expect(await screen.findByText('install-bun')).toBeVisible();
    expect(screen.queryByText('codex login')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(view.onComplete).toHaveBeenCalledOnce());
    expect(startChatWith).toHaveBeenCalledTimes(2);
  });
  it('offers retry for a runtime error supplied by the parent', async () => {
    const error = new BridgeRouteError('Start', 502, { error: 'agent_runtime_missing', detail: 'Bun is missing', next_action: 'install-bun' });
    const view = mount({ initialAgent: 'codex', initialError: error });
    expect(await screen.findByText('install-bun')).toBeVisible();
    expect(view.startChatWith).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(view.onComplete).toHaveBeenCalledOnce());
  });
  it('shows generic failures and retries the same start callback', async () => {
    const startChatWith = vi.fn().mockResolvedValueOnce({ error: new Error('Warm-up failed') }).mockResolvedValue(undefined);
    const view = mount({ startChatWith }); choose('Use Codex');
    expect(await screen.findByRole('alert')).toHaveTextContent('Warm-up failed');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(view.onComplete).toHaveBeenCalledOnce());
    expect(startChatWith.mock.calls.map(call => call.slice(0, 2))).toEqual([['codex', undefined], ['codex', undefined]]);
  });
});

describe("Astrid's setup", () => {
  it('uses the first visible model when an explicit selection is filtered out and disables an empty search', async () => {
    mocks.models.mockResolvedValue(catalog());
    const view = mount(); choose("Astrid's agent");
    fireEvent.click(await screen.findByRole('radio', { name: 'Sonnet' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'OpenRouter' } });
    expect(screen.getByRole('radio', { name: 'First model' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Use First model' })).toBeEnabled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matching model' } });
    expect(screen.getByRole('button', { name: 'Use' })).toBeDisabled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Unavailable model' } });
    expect(screen.getByRole('button', { name: 'Use' })).toBeDisabled();
    expect(view.startChatWith).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'OpenRouter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use First model' }));
    await waitFor(() => expect(view.startChatWith).toHaveBeenCalledWith('astrid', 'openrouter/first', expect.any(Function)));
  });
  it.each(['', '   '])('shows the empty-key message and focuses the field for %j', async value => {
    mount(); choose("Astrid's agent");
    const input = await screen.findByLabelText('OpenRouter key');
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Paste your OpenRouter key first.');
    expect(input).toHaveFocus();
    expect(mocks.saveKey).not.toHaveBeenCalled();
  });
  it('keeps the linked credit on the OpenRouter key step', async () => {
    const agents = ready();
    agents[0] = { ...agents[0], state: 'sign-in', signIn: 'signed-out', creditLine: 'Built on oh-my-pi', creditUrl: 'https://github.com/can1357/oh-my-pi' };
    mount({ agents }); choose("Astrid's agent");
    expect(await screen.findByLabelText('OpenRouter key')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Built on oh-my-pi' })).toHaveAttribute('href', 'https://github.com/can1357/oh-my-pi');
  });
  it('groups and searches the full catalog, selects currentModel and starts with the selected model', async () => {
    const data = catalog();
    data.providers[1].models.push(...Array.from({ length: 60 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` })));
    mocks.models.mockResolvedValue(data);
    const view = mount(); choose("Astrid's agent");
    expect(await screen.findByRole('radio', { name: 'Default model' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Model 59' })).toBeInTheDocument();
    expect(screen.getAllByRole('group').map(group => group.querySelector('legend')?.textContent)).toEqual(['OpenRouter', 'Claude', 'Other account']);
    expect(screen.getByRole('radio', { name: 'Unavailable model' })).toBeDisabled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sonnet' } });
    expect(screen.queryByRole('radio', { name: 'Default model' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Sonnet' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Use Sonnet' }));
    await waitFor(() => expect(view.startChatWith).toHaveBeenCalledExactlyOnceWith('astrid', 'claude/sonnet', expect.any(Function)));
    expect(mocks.remember).toHaveBeenCalledWith({ agent: 'astrid', model: 'claude/sonnet' });
  });
  it('polls the session-free model query every 3 seconds and on window focus', async () => {
    vi.useFakeTimers();
    const view = mount({ initialAgent: 'astrid' });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.models).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocks.models).toHaveBeenCalledTimes(2);
    expect(view.refetchAgents).toHaveBeenCalledTimes(1);
    mocks.models.mockResolvedValue(catalog());
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.models).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('radio', { name: 'Default model' })).toBeChecked();
  });
  it('uses an older provider catalog and agent row without optional fields', async () => {
    mocks.models.mockResolvedValue(catalog());
    mount({ agents: ready().map(({ signIn: _, ...row }) => row) });
    choose("Astrid's agent");
    expect(await screen.findByRole('radio', { name: 'Default model' })).toBeChecked();
    expect(screen.queryByLabelText('OpenRouter key')).toBeNull();
  });
  it('clears the key immediately, checks it locally, then selects the catalog default', async () => {
    let resolve!: (value: unknown) => void;
    mocks.saveKey.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = mount(); choose("Astrid's agent");
    const input = await screen.findByLabelText('OpenRouter key');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(input, { target: { value: 'test-key-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(mocks.saveKey).toHaveBeenCalledWith('openrouter', 'test-key-value');
    expect(input).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('test-key-value');
    expect(screen.getByText('Checking your key…')).toBeInTheDocument();
    mocks.models.mockResolvedValue(catalog());
    await act(async () => { resolve({ signedIn: true }); });
    expect(await screen.findByRole('radio', { name: 'Default model' })).toBeChecked();
    expect(view.refetchAgents).toHaveBeenCalled();
    expect(screen.queryByLabelText('OpenRouter key')).toBeNull();
  });
  it.each([
    ['invalid_key', "OpenRouter didn't accept that key."],
    ['provider_unreachable', "Couldn't reach OpenRouter. Check your connection and try again."],
    ['other_error', 'Service detail'],
  ])('shows the %s message without retaining the key', async (code, message) => {
    mocks.saveKey.mockRejectedValue({ code, detail: 'Service detail' });
    mount(); choose("Astrid's agent");
    fireEvent.change(await screen.findByLabelText('OpenRouter key'), { target: { value: 'test-rejected-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('OpenRouter key')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('test-rejected-value');
  });
  it('shows fallback copy when the service returns no error detail', async () => {
    mocks.saveKey.mockRejectedValue({ code: 'unknown_error', detail: '', message: '' });
    mount(); choose("Astrid's agent");
    fireEvent.change(await screen.findByLabelText('OpenRouter key'), { target: { value: 'test-key-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that key. Try again.");
    expect(document.body.innerHTML).not.toContain('test-key-value');
  });
  it('asks to update Astrid for an old service 404', async () => {
    mocks.saveKey.mockRejectedValue({ code: 'not_found', detail: '', status: 404, message: '' });
    mount(); choose("Astrid's agent");
    fireEvent.change(await screen.findByLabelText('OpenRouter key'), { target: { value: 'test-key-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Update Astrid on your computer to connect a key here, or use /login below.');
    expect(document.body.innerHTML).not.toContain('test-key-value');
  });
  it('reveals terminal sign-in steps and switches to models after polling', async () => {
    const agents = ready(); agents[0].steps = [{ kind: 'sign-in', command: 'run-astrid', label: 'Start Astrid' }, { kind: 'sign-in', command: '/login', label: 'Sign in' }];
    const view = mount({ agents }); choose("Astrid's agent");
    const disclosure = await screen.findByText('Already have ChatGPT, Claude or Copilot? Use that instead');
    fireEvent.click(disclosure);
    expect(disclosure.closest('details')).toHaveAttribute('open');
    expect(screen.getByText('run-astrid')).toBeVisible();
    expect(screen.getByText('/login')).toBeVisible();
    mocks.models.mockResolvedValue(catalog());
    await act(async () => { await view.refetchAgents(); clients.at(-1)!.invalidateQueries({ queryKey: ['agent-setup-models'] }); });
    expect(await screen.findByRole('radio', { name: 'Default model' })).toBeChecked();
  });
});
