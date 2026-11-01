// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentThoughtLevel } from '@/integrations/astrid/localAgents.ts';
import { AgentChatModelLine } from './AgentChatModelLine.tsx';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= vi.fn();
});
afterEach(cleanup);

const effort: AgentThoughtLevel = {
  configId: 'effort',
  name: 'Effort',
  currentValue: 'high',
  recommendedValue: 'high',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
    { value: 'xhigh', name: 'Extra high', description: 'The most reasoning effort.' },
  ],
};

type LineProps = Partial<Parameters<typeof AgentChatModelLine>[0]>;

function renderLine(props: LineProps = {}) {
  const base = {
    agent: 'claude-code' as const,
    modelName: 'Opus',
    thoughtLevel: effort,
    hasChat: true,
    onChangeThinkingLevel: vi.fn().mockResolvedValue(undefined),
    onChooseAnotherModel: vi.fn(),
    onOpenChange: vi.fn(),
    ...props,
  };
  const view = render(<AgentChatModelLine {...base} />);
  const rerender = (next: LineProps = {}) => view.rerender(<AgentChatModelLine {...base} {...next} />);
  return { onChangeThinkingLevel: base.onChangeThinkingLevel, onChooseAnotherModel: base.onChooseAnotherModel, onOpenChange: base.onOpenChange, view, rerender };
}

const openLine = () => fireEvent.click(screen.getByRole('button', { name: /model and thinking level$/ }));
const popover = () => screen.queryByRole('dialog', { name: 'Model and thinking level' });

describe('AgentChatModelLine text', () => {
  it('names the agent, model and thinking level in one line', () => {
    renderLine();
    const identity = screen.getByTestId('agent-chat-identity');
    expect(identity).toHaveTextContent('Claude Code · Opus · High');
  });

  it('omits the level when the model uses its default level', () => {
    renderLine({ thoughtLevel: { ...effort, currentValue: 'default', options: [{ value: 'default', name: 'Default' }, ...effort.options] } });
    expect(screen.getByTestId('agent-chat-identity')).toHaveTextContent(/^Claude Code · Opus$/);
  });

  it('omits the level when the agent reports no thinking control', () => {
    renderLine({ thoughtLevel: null });
    expect(screen.getByTestId('agent-chat-identity')).toHaveTextContent(/^Claude Code · Opus$/);
  });

  it('shows only the agent until the model is known', () => {
    renderLine({ modelName: null, thoughtLevel: null });
    expect(screen.getByTestId('agent-chat-identity')).toHaveTextContent(/^Claude Code$/);
  });

  it('is plain text without a chat, with no button and no popover', () => {
    renderLine({ hasChat: false });
    const identity = screen.getByTestId('agent-chat-identity');
    expect(identity).toHaveTextContent('Claude Code · Opus · High');
    expect(identity.tagName).not.toBe('BUTTON');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('AgentChatModelLine popover', () => {
  it('opens from a button named after the line, reporting the open', () => {
    const { onOpenChange } = renderLine();
    const button = screen.getByRole('button', { name: 'Claude Code · Opus · High: model and thinking level' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(popover()).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the agent and model, the keeps-its-model note, and the thinking levels', () => {
    renderLine();
    openLine();
    const panel = popover()!;
    expect(within(panel).getByText('Claude Code · Opus')).toBeInTheDocument();
    expect(within(panel).getByText('A chat keeps its model.')).toBeInTheDocument();
    const group = within(panel).getByRole('group', { name: 'Thinking level' });
    expect(within(group).getByRole('option', { name: /High/ })).toHaveAttribute('aria-current', 'true');
    expect(within(group).getByRole('option', { name: /Low/ })).not.toHaveAttribute('aria-current');
    expect(within(group).getByRole('option', { name: /Extra high/ })).toHaveTextContent('The most reasoning effort.');
  });

  it('labels only the recommended level', () => {
    renderLine();
    openLine();
    const group = within(popover()!).getByRole('group', { name: 'Thinking level' });
    expect(within(group).getByRole('option', { name: /High/ })).toHaveTextContent('Recommended');
    expect(within(group).getByRole('option', { name: /Low/ })).not.toHaveTextContent('Recommended');
    expect(within(group).getAllByText('Recommended')).toHaveLength(1);
  });

  it('sets the thinking level and closes when another level is picked', async () => {
    const user = userEvent.setup();
    const { onChangeThinkingLevel, onOpenChange } = renderLine();
    openLine();
    await user.click(within(popover()!).getByRole('option', { name: /Low/ }));
    expect(onChangeThinkingLevel).toHaveBeenCalledExactlyOnceWith('low');
    await waitFor(() => expect(popover()).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closes without changing anything when the current level is picked', () => {
    const { onChangeThinkingLevel, onOpenChange } = renderLine();
    openLine();
    fireEvent.click(within(popover()!).getByRole('option', { name: /High/ }));
    expect(onChangeThinkingLevel).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(popover()).toBeNull();
  });

  it('keeps the popover open and shows the error when the change is rejected', async () => {
    const user = userEvent.setup();
    const { onChangeThinkingLevel } = renderLine({ onChangeThinkingLevel: vi.fn().mockRejectedValue(new Error('Agent is busy')) });
    openLine();
    await user.click(within(popover()!).getByRole('option', { name: /Low/ }));
    expect(onChangeThinkingLevel).toHaveBeenCalledWith('low');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the thinking level: Agent is busy');
    expect(popover()).toBeInTheDocument();
    expect(within(popover()!).getByRole('option', { name: /High/ })).toHaveAttribute('aria-current', 'true');
  });

  it('clears a previous error when the popover opens again', async () => {
    const user = userEvent.setup();
    renderLine({ onChangeThinkingLevel: vi.fn().mockRejectedValue(new Error('Agent is busy')) });
    openLine();
    await user.click(within(popover()!).getByRole('option', { name: /Low/ }));
    await screen.findByRole('alert');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(popover()).toBeNull());
    openLine();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('locks the level options while a change is pending', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    renderLine({ onChangeThinkingLevel: vi.fn().mockReturnValue(pending) });
    openLine();
    await user.click(within(popover()!).getByRole('option', { name: /Low/ }));
    expect(within(popover()!).getByRole('option', { name: /Low/ })).toHaveAttribute('aria-disabled', 'true');
    expect(within(popover()!).getByRole('option', { name: /High/ })).toHaveAttribute('aria-disabled', 'true');
    finish();
    await waitFor(() => expect(popover()).toBeNull());
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderLine();
    openLine();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(popover()).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe('AgentChatModelLine locked and fixed thinking', () => {
  it('disables the level options and explains the lock', () => {
    const { onChangeThinkingLevel } = renderLine({ thinkingLockedReason: 'The thinking level can change once this reply finishes.' });
    openLine();
    const option = within(popover()!).getByRole('option', { name: /Low/ });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(within(popover()!).getByText('The thinking level can change once this reply finishes.')).toBeInTheDocument();
    fireEvent.click(option);
    expect(onChangeThinkingLevel).not.toHaveBeenCalled();
  });

  it('explains a follower tab\'s lock with the takeover message', () => {
    renderLine({ thinkingLockedReason: 'Take over this chat to change its thinking level.' });
    openLine();
    expect(screen.getByText('Take over this chat to change its thinking level.')).toBeInTheDocument();
    expect(within(popover()!).getByRole('option', { name: /High/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the fixed level as text instead of options', () => {
    renderLine({ thoughtLevelFixed: true });
    openLine();
    expect(within(popover()!).getByText('Thinking: High, fixed with the model.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Thinking level' })).toBeNull();
    expect(screen.queryByRole('option', { name: /Low/ })).toBeNull();
  });
});

describe('AgentChatModelLine another model', () => {
  it('closes the popover and then asks the host to open another model', async () => {
    const user = userEvent.setup();
    const { onChooseAnotherModel, onOpenChange } = renderLine();
    openLine();
    await user.click(within(popover()!).getByRole('option', { name: 'New chat with another model' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(popover()).toBeNull();
    await waitFor(() => expect(onChooseAnotherModel).toHaveBeenCalledOnce());
  });

  it('still offers another model when the chat has no thinking control', () => {
    renderLine({ thoughtLevel: null });
    openLine();
    expect(within(popover()!).getByRole('option', { name: 'New chat with another model' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Thinking level' })).toBeNull();
  });
});
