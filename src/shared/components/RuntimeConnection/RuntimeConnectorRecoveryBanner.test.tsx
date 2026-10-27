import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeAuthenticationError, RuntimeCompatibilityError, RuntimeUnavailableError } from '@/integrations/runtime/client.ts';
import { setRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { RUNTIME_CONNECTION_COPY as COPY } from './copy.ts';
import { RuntimeConnectorRecoveryBanner, buildWorkspaceRestartBrief } from './RuntimeConnectorRecoveryBanner';
import { useAppEventListener } from '@/shared/lib/typedEvents.ts';

const harness = vi.hoisted(() => ({ origin: '' }));
vi.mock('@/integrations/runtime/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/connection.ts')>()),
  runtimeOrigin: () => harness.origin,
}));

beforeEach(() => { harness.origin = ''; });

afterEach(() => {
  harness.origin = '';
  setRecoveryCardShowing(false);
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe('RuntimeConnectorRecoveryBanner overlay and quiet retry', () => {
  it('renders in an overlay layer outside the editor, which stays mounted, and ignores Escape', () => {
    const { container } = render(<div data-testid="editor"><RuntimeConnectorRecoveryBanner error={new Error('down')} onRetry={vi.fn()} /></div>);
    expect(screen.getByTestId('editor')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="runtime-connector-alert"]')).toBeNull();
    expect(screen.getByTestId('runtime-connector-alert')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('runtime-connector-alert')).toBeInTheDocument();
  });

  it('retries quietly every 3s with one in flight, and stops when the card goes away', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      const onRetry = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
      const view = render(<RuntimeConnectorRecoveryBanner error={new Error('down')} onRetry={onRetry} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(onRetry).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(onRetry).toHaveBeenCalledTimes(1);
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(3000); });
      expect(onRetry).toHaveBeenCalledTimes(2);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(onRetry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RuntimeConnectorRecoveryBanner', () => {
  it('keeps the recovery hard-card install action and routes Details to Settings Updates', () => {
    const onOpen = vi.fn();
    function Capture() {
      useAppEventListener('openSettings', onOpen);
      return <RuntimeConnectorRecoveryBanner error={new RuntimeCompatibilityError('schema', 'Update required', 'http://localhost:17340')} onRetry={vi.fn()} />;
    }
    render(<Capture />);
    expect(screen.getByText('Update Astrid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
    expect(screen.getByText(/curl -fsSL https:\/\/astrid\.haus\/install \| sh -s -- --update/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
    window.history.replaceState({}, '', '/');
  });

  it('offers retry and both restart paths, with a truthful idle and retrying state', async () => {
    const onRetry = vi.fn();
    const view = render(<RuntimeConnectorRecoveryBanner retrying={false} error={new Error("Connection refused.")} onRetry={onRetry} />);

    expect(screen.getByRole('heading', { name: 'Workspace Runtime is unavailable' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry Runtime connection' })).toHaveFocus());
    expect(screen.getByTestId('workspace-connection-summary')).toHaveTextContent('Connection refused.');
    expect(screen.getByTestId('workspace-connection-diagnostic')).toHaveTextContent('Connection refused.');
    expect(screen.getByTestId('workspace-connection-diagnostic').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Show full connection error'));
    expect(screen.getByTestId('workspace-connection-diagnostic').closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Copy restart instructions' })).toBeInTheDocument();
    expect(screen.getByText(/Return to the same Astrid App checkout/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Runtime connection' }));
    expect(onRetry).toHaveBeenCalledOnce();

    view.rerender(<RuntimeConnectorRecoveryBanner retrying error={new Error("Connection refused.")} onRetry={onRetry} />);
    expect(screen.getByRole('button', { name: 'Retrying Runtime connection…' })).toBeDisabled();
  });

  it('copies instructions for the same existing Runtime, sanitizing the optional configured URL', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<RuntimeConnectorRecoveryBanner
      retrying={false}
      error={new Error("Runtime health check failed.")}
      connectionUrl="http://user:secret@localhost:22894/runtime?token=secret#private"
      onRetry={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy restart instructions' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const brief = String(writeText.mock.calls[0][0]);
    expect(brief).toContain('npm run dev:local');
    expect(brief).toContain('Runtime health check failed.');
    expect(brief).toContain('http://localhost:22894/runtime');
    expect(brief).toContain('Do not reset, reinstall, create a new data root');
    expect(brief).toContain('Verify that the same configured Runtime is healthy');
    expect(brief).not.toContain('secret');
    expect(screen.queryByLabelText('Restart brief')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Restart instructions copied');
  });

  it('shows a selectable brief when browser clipboard permission is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('Clipboard denied'); }) },
    });
    render(<RuntimeConnectorRecoveryBanner retrying={false} error={new Error("Bridge timeout.")} onRetry={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy restart instructions' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Clipboard access is unavailable'));
    expect((screen.getByLabelText('Restart brief') as HTMLTextAreaElement).value).toContain('Bridge timeout.');
  });

  it('shows the manual restart steps that preserve the existing installation and Runtime data', () => {
    render(<RuntimeConnectorRecoveryBanner retrying={false} error={new Error("Runtime is offline.")} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Show restart steps' })).toBeNull();
    expect(screen.getByText(/Return to the same Astrid App checkout/)).toBeInTheDocument();
    expect(screen.getByText('npm run dev:local')).toBeInTheDocument();
    expect(screen.getByText(/restart that same Runtime with its current command, profile, and data-root configuration/)).toBeInTheDocument();
    expect(screen.getByText(/Do not reset or reinstall the workspace/)).toBeInTheDocument();
  });

  it('keeps the typed recovery action and original error message available', () => {
    const error = new RuntimeUnavailableError(new Error('startup admission failed'), '/api/runtime');
    render(<RuntimeConnectorRecoveryBanner retrying={false} error={error} onRetry={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(error.recoveryAction);
    fireEvent.click(screen.getByText('Show full connection error'));
    expect(screen.getByTestId('workspace-connection-diagnostic')).toHaveTextContent(error.message);
  });

  it('builds the agent brief with only a sanitized HTTP(S) target', () => {
    expect(buildWorkspaceRestartBrief({ error: '', connectionUrl: 'file:///private/runtime.db' }))
      .not.toContain('file:///private/runtime.db');
    expect(buildWorkspaceRestartBrief({ error: '', connectionUrl: 'not a URL' }))
      .toContain('The editor cannot reach its configured Astrid Runtime.');
  });

  it('uses the shared diagnostic and PowerShell health check in the Windows restart brief', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    const brief = buildWorkspaceRestartBrief({
      error: new Error('readiness_timeout'),
      connectionUrl: 'http://127.0.0.1:17340/api/runtime',
    });

    expect(brief).toContain('Current editor diagnostic: readiness_timeout');
    expect(brief).toContain('service-<name>.log under %LOCALAPPDATA%\\Astrid Runtime\\logs');
    expect(brief).toContain("Invoke-RestMethod -Uri 'http://127.0.0.1:17340/api/runtime/v1/health'");
    expect(brief).toContain(`-Headers @{ Origin = '${window.location.origin}' }`);
  });

  it('includes the current project and timeline route identity in the agent brief', () => {
    const brief = buildWorkspaceRestartBrief({
      error: 'Timeline lookup timed out.',
      projectId: 'newblanktimeline3',
      timelineId: 'timeline-a',
    });

    expect(brief).toContain('project newblanktimeline3, timeline timeline-a');
    expect(brief).toContain('Timeline lookup timed out.');
  });
});


describe('hosted typed recovery', () => {
  it.each([
    [new RuntimeAuthenticationError('/api/runtime'), COPY.connectorFailure.authentication],
    [new RuntimeUnavailableError(new Error('No space left on device'), '/api/runtime'), COPY.connectorFailure.storage],
    [new RuntimeUnavailableError(new Error('startup admission failed'), '/api/runtime'), COPY.connectorFailure.admission],
    [new Error('internal failure details'), COPY.loadFailed.title],
  ])('shows the failure kind for %s', (error, title) => {
    harness.origin = 'http://127.0.0.1:17340';
    const onRetry = vi.fn();
    render(<RuntimeConnectorRecoveryBanner error={error} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent(title);
    expect(screen.queryByText('internal failure details')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: COPY.loadFailed.button }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('stops quiet retries when a hosted failure becomes authentication and retries only on click', async () => {
    harness.origin = 'http://127.0.0.1:17340';
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const view = render(<RuntimeConnectorRecoveryBanner error={new Error('down')} onRetry={onRetry} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.rerender(<RuntimeConnectorRecoveryBanner error={new RuntimeAuthenticationError('/api/runtime')} onRetry={onRetry} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(2);
    view.rerender(<RuntimeConnectorRecoveryBanner error={new Error('down')} onRetry={onRetry} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onRetry).toHaveBeenCalledTimes(3);
  });
});
