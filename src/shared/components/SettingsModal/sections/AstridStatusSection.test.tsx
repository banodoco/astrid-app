import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AstridStatusSection } from './AstridStatusSection.tsx';
import { RUNTIME_CONNECTION_COPY as CONNECTION_COPY, installCommand } from '@/shared/components/RuntimeConnection/copy.ts';
import { ASTRID_HELP_URL } from '@/integrations/astrid/help.ts';

const mocks = vi.hoisted(() => ({
  readStatus: vi.fn(),
  clipboard: vi.fn(),
  connect: vi.fn(),
  connection: {
    state: { status: 'connected', realm: { realm_id: 'realm-1', display_name: 'Studio' } },
    isChecking: false, schemaDigest: null, localServiceOutOfDate: false, connect: () => {},
  } as { state: { status: string; realm?: { realm_id: string; display_name: string } }; isChecking: boolean; schemaDigest: string | null; localServiceOutOfDate: boolean; connect: () => void },
}));

vi.mock('@/integrations/runtime/client.ts', () => ({
  AstridRuntimeClient: class {
    readStatus = mocks.readStatus;
  },
}));

vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({
  useRuntimeConnection: () => mocks.connection,
}));

vi.mock('@/shared/lib/browser/clipboard.ts', () => ({
  writeClipboardTextSafe: mocks.clipboard,
}));

async function openDetails() {
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
}

describe('AstridStatusSection', () => {
  beforeEach(() => {
    mocks.connection.state = { status: 'connected', realm: { realm_id: 'realm-1', display_name: 'Studio' } };
    mocks.connection.isChecking = false;
    mocks.connection.schemaDigest = null;
    mocks.connection.localServiceOutOfDate = false;
    mocks.connection.connect = mocks.connect.mockReset();
    mocks.clipboard.mockReset().mockResolvedValue(true);
    mocks.readStatus.mockReset().mockResolvedValue({
      health: {
        status: 'ok',
        protocol: 'workspace.v1',
        schema_digest: `sha256:${'a'.repeat(64)}`,
        runtime_epoch: 2,
        runtime_session_id: 'session-1',
        runtime_instance_id: 'runtime-1',
        services: [
          { name: 'comfyui', state: 'starting', last_exit: null, restart_count: 0 },
          { name: 'pack-host', state: 'running', last_exit: null, restart_count: 1 },
          { name: 'chat', state: 'failed', last_exit: 2, restart_count: 3, reason: 'startup_failed' },
        ],
      },
      realm: { realm_id: 'realm-1', display_name: 'Studio', version: 4, created_at: '2026-01-01T00:00:00Z' },
    });
  });

  it('keeps Runtime and Workspace checks in the single status section', async () => {
    render(<AstridStatusSection isOpen />);
    // Runtime and Workspace marks stay visible; the workspace name waits behind Details.
    expect(screen.getByText('Runtime')).toHaveAttribute('data-state', 'pass');
    expect(screen.queryByText('Studio')).not.toBeInTheDocument();
    await openDetails();
    expect(await screen.findByText('Studio')).toBeInTheDocument();
    expect(screen.getByText('Runtime')).toHaveAttribute('data-state', 'pass');
    expect(document.querySelector('[data-check="workspace"]')).toHaveAttribute('data-state', 'pass');
    expect(screen.queryByRole('heading', { name: 'Connection' })).not.toBeInTheDocument();
  });

  it('uses the shared resolver action in Settings for a source checkout schema mismatch', () => {
    mocks.connection.schemaDigest = `sha256:${'f'.repeat(64)}`;
    render(<AstridStatusSection isOpen />);

    expect(screen.getByText(/This page needs a newer Astrid/)).toBeInTheDocument();
    expect(screen.getByText('update your checkouts')).toBeInTheDocument();
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CONNECTION_COPY.agent.commandCopy })).not.toBeInTheDocument();
  });

  it('offers the browser permission action before checking Runtime details', () => {
    mocks.connection.state = { status: 'needs_permission' };
    render(<AstridStatusSection isOpen />);
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_COPY.permission.connect }));
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.readStatus).not.toHaveBeenCalled();
    expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
  });

  it('keeps blocked permission recovery instructions inside the status section', () => {
    mocks.connection.state = { status: 'blocked' };
    render(<AstridStatusSection isOpen />);
    expect(screen.getByText(CONNECTION_COPY.blocked.steps.join(' '))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CONNECTION_COPY.permission.connect })).not.toBeInTheDocument();
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it('shows the connected workspace and readable service states without inventing versions', async () => {
    render(<AstridStatusSection isOpen />);

    await openDetails();
    expect(await screen.findByText('Studio')).toBeInTheDocument();
    expect(screen.getByText('workspace.v1')).toBeInTheDocument();
    expect(screen.queryByText('Versions')).not.toBeInTheDocument();
    expect(screen.getByText('Task host')).toBeInTheDocument();
    expect(screen.getByText('comfyui')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Starting…')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent("Part of Astrid isn't working. Give these instructions to your coding agent to restart it.");
    expect(screen.getByRole('link', { name: 'Get help' })).toHaveAttribute('href', ASTRID_HELP_URL);
    expect(document.querySelector('svg.lucide-circle-alert')).not.toBeNull();
    expect(screen.getByText(/Restarts: 3/)).toBeInTheDocument();
    expect(screen.queryByText('Restarts: 0')).not.toBeInTheDocument();
    expect(screen.getByText(/Reason: startup_failed/)).toBeInTheDocument();
    expect(screen.getByText(/Last exit code: 2/)).toBeInTheDocument();
    expect(screen.getByText(/service-chat\.log/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.getByText('curl -fsSL https://astrid.haus/install | sh')).toBeInTheDocument();
  });

  it('shows historical service failures without treating a running service as unhealthy', async () => {
    mocks.readStatus.mockResolvedValue({
      health: {
        status: 'ok',
        protocol: 'workspace.v1',
        schema_digest: `sha256:${'b'.repeat(64)}`,
        services: [
          { name: 'custom-worker', state: 'running', last_exit: null, restart_count: 0 },
          { name: 'retrying-worker', state: 'running', last_exit: 1, restart_count: 0, reason: 'exited' },
        ],
      },
      realm: { realm_id: 'realm-1', display_name: 'Studio', version: 4, created_at: '2026-01-01T00:00:00Z' },
    });
    render(<AstridStatusSection isOpen />);

    await openDetails();
    const customWorker = await screen.findByText('custom-worker');
    expect(customWorker.closest('li')).toHaveTextContent(/service-custom-worker\.log/);
    const retryingWorker = screen.getByText('retrying-worker').closest('li');
    expect(retryingWorker).toHaveTextContent('Last stop reason: exited');
    expect(retryingWorker).toHaveTextContent('Last exit code: 1');
    expect(retryingWorker).toHaveTextContent(/service-retrying-worker\.log/);
    expect(retryingWorker).toHaveTextContent('Running');
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();
    expect(screen.queryByText('curl -fsSL https://astrid.haus/install | sh')).not.toBeInTheDocument();
    expect(screen.queryByText(/Restarts:/)).not.toBeInTheDocument();
  });

  it('copies service reason, exit and log details into the agent brief', async () => {
    render(<AstridStatusSection isOpen />);
    await openDetails();
    fireEvent.click(await screen.findByRole('button', { name: CONNECTION_COPY.agent.copy }));

    await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledOnce());
    const brief = String(mocks.clipboard.mock.calls[0][0]);
    expect(brief).toContain('chat: failed');
    expect(brief).toContain('Reason: startup_failed');
    expect(brief).toContain('Last exit code: 2');
    expect(brief).toContain('service-chat.log');
    expect(brief).toContain('curl -s');
  });

  it('shows the shared repair command for degraded health even without a failed service', async () => {
    mocks.readStatus.mockResolvedValue({
      health: {
        status: 'degraded',
        protocol: 'workspace.v1',
        schema_digest: `sha256:${'c'.repeat(64)}`,
        services: [{ name: 'pack-host', state: 'running', last_exit: null, restart_count: 1 }],
      },
      realm: { realm_id: 'realm-1', display_name: 'Studio', version: 4, created_at: '2026-01-01T00:00:00Z' },
    });
    render(<AstridStatusSection isOpen />);

    expect(await screen.findByRole('status')).toHaveTextContent("Part of Astrid isn't working. Give these instructions to your coding agent to restart it.");
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.getByText('curl -fsSL https://astrid.haus/install | sh')).toBeInTheDocument();
  });

  it('labels the Runtime repair surface as beta on Windows only', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    const view = render(<AstridStatusSection isOpen />);

    expect(await screen.findByText(CONNECTION_COPY.windowsBeta)).toBeInTheDocument();
    expect(screen.getByText('irm https://astrid.haus/install.ps1 | iex')).toBeInTheDocument();

    platform.mockReturnValue('MacIntel');
    userAgent.mockReturnValue('Macintosh');
    view.rerender(<AstridStatusSection isOpen />);
    expect(screen.queryByText(CONNECTION_COPY.windowsBeta)).not.toBeInTheDocument();
    expect(screen.getByText('curl -fsSL https://astrid.haus/install | sh')).toBeInTheDocument();
  });

  it('copies the same install command shown in the repair control', async () => {
    render(<AstridStatusSection isOpen />);
    expect(await screen.findByRole('button', { name: 'Copy command' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledWith(installCommand('install')));
    expect(await screen.findByRole('button', { name: 'Command copied' })).toBeInTheDocument();
  });

  it('copies a complete agent brief separately from the repair command', async () => {
    render(<AstridStatusSection isOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy for your agent' }));
    await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledOnce());
    const brief = mocks.clipboard.mock.calls[0][0];
    expect(brief).toContain('selected workspace and data root');
    expect(brief).toContain('The installer adopts an existing workspace itself');
    expect(brief).toContain(installCommand('install'));
    expect(brief).not.toBe(installCommand('install'));
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });

  it('shows Needs an update with the update command when Astrid on this computer is older than this page', async () => {
    mocks.connection.localServiceOutOfDate = true;
    mocks.readStatus.mockResolvedValue({
      health: {
        status: 'ok',
        protocol: 'workspace.v1',
        schema_digest: `sha256:${'a'.repeat(64)}`,
        services: [{ name: 'pack-host', state: 'running', last_exit: null, restart_count: 0 }],
      },
      realm: { realm_id: 'realm-1', display_name: 'Studio', version: 4, created_at: '2026-01-01T00:00:00Z' },
    });
    render(<AstridStatusSection isOpen />);

    expect(await screen.findByText('Connected. Chat needs an update')).toBeInTheDocument();
    expect(screen.getByText(/Chat on this computer is older than this page/)).toBeInTheDocument();
    expect(screen.getByText(/If you run Astrid from source checkouts/)).toBeInTheDocument();
    expect(screen.queryByText(/This page needs a newer Astrid/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledWith(installCommand('update')));
    expect(mocks.clipboard).not.toHaveBeenCalledWith(installCommand('install'));
  });

  it('does not show the update status while the local service is up to date', async () => {
    render(<AstridStatusSection isOpen />);

    await openDetails();
    expect(await screen.findByText('Studio')).toBeInTheDocument();
    expect(screen.queryByText('Needs an update')).not.toBeInTheDocument();
    expect(screen.queryByText(/This page needs a newer Astrid/)).not.toBeInTheDocument();
  });

  it('shows the connection state without requesting details while offline', () => {
    mocks.connection.state = { status: 'not_running' };
    render(<AstridStatusSection isOpen />);

    expect(screen.getByRole('status')).toHaveTextContent(CONNECTION_COPY.notRunning.title);
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it('names a refusal instead of claiming Astrid is not answering', () => {
    mocks.connection.state = { status: 'refused' };
    render(<AstridStatusSection isOpen />);

    expect(screen.getByRole('status')).toHaveTextContent('Running, but refused this page');
    expect(screen.queryByText(CONNECTION_COPY.notRunning.title)).not.toBeInTheDocument();
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it('does not request Runtime details while settings are closed', () => {
    render(<AstridStatusSection isOpen={false} />);

    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it('reads current health again when settings are reopened', async () => {
    const first = {
      health: {
        status: 'ok',
        protocol: 'workspace.v1',
        schema_digest: `sha256:${'a'.repeat(64)}`,
        services: [{ name: 'pack-host', state: 'running', last_exit: null, restart_count: 0 }],
      },
      realm: { realm_id: 'realm-1', display_name: 'Studio', version: 4, created_at: '2026-01-01T00:00:00Z' },
    };
    const second = {
      health: { ...first.health, status: 'degraded', services: [{ name: 'pack-host', state: 'failed', last_exit: 1, restart_count: 1 }] },
      realm: first.realm,
    };
    mocks.readStatus.mockReset().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const view = render(<AstridStatusSection isOpen />);

    await openDetails();
    expect(await screen.findByText('Running')).toBeInTheDocument();
    view.rerender(<AstridStatusSection isOpen={false} />);
    view.rerender(<AstridStatusSection isOpen />);

    await openDetails();
    expect(await screen.findByText("Part of Astrid isn't working. Give these instructions to your coding agent to restart it.")).toBeInTheDocument();
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(mocks.readStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps the workspace, connection details and services behind a closed Details toggle', async () => {
    render(<AstridStatusSection isOpen />);

    await waitFor(() => expect(mocks.readStatus).toHaveBeenCalled());
    const toggle = await screen.findByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    for (const hidden of ['Studio', 'workspace.v1', 'Task host']) expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace', { selector: 'h3' })).not.toBeInTheDocument();
    // What the person needs stays in view: the status and the Runtime and Workspace marks.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Runtime')).toHaveAttribute('data-state', 'pass');
    expect(document.querySelector('[data-check="workspace"]')).toHaveAttribute('data-state', 'pass');
  });

  it('shortens the schema digest inside Details and keeps the full value as its tooltip', async () => {
    render(<AstridStatusSection isOpen />);

    await openDetails();
    const short = await screen.findByText(`sha256:${'a'.repeat(8)}…${'a'.repeat(6)}`);
    expect(short).toHaveAttribute('title', `sha256:${'a'.repeat(64)}`);
  });

  it('keeps the update command outside Details when an update is needed', async () => {
    mocks.connection.localServiceOutOfDate = true;
    render(<AstridStatusSection isOpen />);

    expect(screen.getByRole('status')).toHaveTextContent('Chat needs an update');
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false');
  });
});
