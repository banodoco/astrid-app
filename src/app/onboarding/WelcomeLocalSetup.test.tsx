import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASTRID_COMMANDS, localSetupInstructions, localSetupSteps, LOCAL_SETUP, PINOKIO_INSTALL_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { WelcomeLocalSetup } from './WelcomeLocalSetup.tsx';

beforeEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('local setup card', () => {
  it('copies instructions and shows copied feedback', async () => {
    render(<WelcomeLocalSetup onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy for your agent' }));
    expect(await screen.findByRole('button', { name: 'Copied. Paste them into your agent.' })).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(localSetupInstructions());
  });

  it('offers the agent instructions only as a copy, with the do-it-yourself steps visible', () => {
    render(<WelcomeLocalSetup onBack={vi.fn()} />);
    expect(Array.from(document.querySelectorAll('pre')).some(pre => pre.textContent === localSetupInstructions())).toBe(false);
    expect(screen.queryByRole('button', { name: 'Show the instructions' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
    expect(screen.getByText('Or do it yourself')).toBeInTheDocument();
  });

  it('shows five ordered macOS/Linux steps using commands from the shared setup source', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    render(<WelcomeLocalSetup onBack={vi.fn()} />);

    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Install Astrid: in Terminal run');
    expect(localSetupSteps().map(step => step.command).filter(Boolean)).toEqual([
      ASTRID_COMMANDS.macLinux,
      [LOCAL_SETUP.cloneCommand, LOCAL_SETUP.changeDirectoryCommand, LOCAL_SETUP.installDependenciesCommand].join('\n'),
      LOCAL_SETUP.startCommand,
      LOCAL_SETUP.openUrl,
    ]);
    expect(list.querySelectorAll('pre code')).toHaveLength(4);
    expect(within(list).getAllByRole('listitem')[4]).toHaveTextContent('Open this address in your browser. The editor opens with your project.');
    expect(within(list).getAllByRole('listitem')[4].querySelectorAll('pre code')).toHaveLength(1);
    expect(within(list).getAllByRole('listitem')[4].querySelector('pre code')?.textContent).toBe(LOCAL_SETUP.openUrl);
    expect(screen.queryByRole('link', { name: LOCAL_SETUP.openUrl })).not.toBeInTheDocument();
    expect(screen.queryByText(/step 4 command/i)).not.toBeInTheDocument();
    expect(localSetupInstructions()).not.toMatch(/confirm it shows Connected|says Connected/i);
    expect(screen.queryByText('If pasting gives nothing, select the command and press Ctrl+C.')).not.toBeInTheDocument();
  });

  it('shows the quiet Pinokio link after the local setup steps on desktop Chromium only', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    const { container } = render(<WelcomeLocalSetup onBack={vi.fn()} />);

    const list = screen.getByRole('list');
    const link = screen.getByRole('link', { name: PINOKIO_INSTALL_COPY.fullyLocalLabel });
    expect(link).toHaveAttribute('href', PINOKIO_INSTALL_COPY.installUrl);
    expect(link).toHaveClass('underline', 'underline-offset-4', 'hover:text-foreground');
    expect(list.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(screen.getByText(/Ctrl\+C stops it/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('button[aria-label*="Pinokio"]')).toBeNull();
  });

  it('hides the Pinokio link on mobile and unsupported browsers', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Firefox/131.0');
    const view = render(<WelcomeLocalSetup onBack={vi.fn()} />);
    expect(screen.queryByRole('link', { name: PINOKIO_INSTALL_COPY.fullyLocalLabel })).not.toBeInTheDocument();

    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('iPhone');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
    view.rerender(<WelcomeLocalSetup onBack={vi.fn()} />);
    expect(screen.queryByRole('link', { name: PINOKIO_INSTALL_COPY.fullyLocalLabel })).not.toBeInTheDocument();
  });

  it('copies each command row exactly, including the three-line editor setup block', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    render(<WelcomeLocalSetup onBack={vi.fn()} />);

    const labels = [
      'Copy the install command',
      'Copy the editor setup commands',
      'Copy the start command',
      'Copy the address',
    ];
    const commands = [
      ASTRID_COMMANDS.macLinux,
      [LOCAL_SETUP.cloneCommand, LOCAL_SETUP.changeDirectoryCommand, LOCAL_SETUP.installDependenciesCommand].join('\n'),
      LOCAL_SETUP.startCommand,
      LOCAL_SETUP.openUrl,
    ];

    for (let index = 0; index < labels.length; index += 1) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: labels[index] }));
        await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(index + 1));
      });
      expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(index + 1, commands[index]);
    }
  });

  it('shows the PowerShell installer command and paste hint only on Windows', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    render(<WelcomeLocalSetup onBack={vi.fn()} />);

    const firstStep = within(screen.getByRole('list')).getAllByRole('listitem')[0];
    expect(firstStep).toHaveTextContent('Install Astrid: in PowerShell run');
    expect(firstStep.querySelector('pre code')?.textContent).toBe(ASTRID_COMMANDS.windows);
    expect(within(firstStep).getByText('If pasting gives nothing, select the command and press Ctrl+C.')).toBeInTheDocument();
  });

  it('calls onBack', () => {
    const onBack = vi.fn();
    render(<WelcomeLocalSetup onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('offers the local editor in a new tab', () => {
    render(<WelcomeLocalSetup onBack={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Open my local editor' })).toHaveAttribute('href', 'http://127.0.0.1:5180');
    expect(screen.getByRole('link', { name: 'Open my local editor' })).toHaveAttribute('target', '_blank');
  });
});
