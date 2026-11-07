// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectionMock, readStatusMock, hostedCheckMock, localCheckMock, originMock } = vi.hoisted(() => ({ connectionMock: { value: null as unknown }, readStatusMock: vi.fn(), hostedCheckMock: vi.fn(), localCheckMock: vi.fn(), originMock: { value: 'https://astrid.test' } }));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnection: () => connectionMock.value }));
vi.mock('@/integrations/runtime/client.ts', () => ({ AstridRuntimeClient: class { readInstallerUpdateHealth = async () => (await readStatusMock()).health; } }));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => originMock.value, runtimeApiBase: () => 'http://127.0.0.1:17340/api/runtime' }));
vi.mock('@/shared/lib/updates/updateStatus.ts', () => ({ checkHostedUpdate: hostedCheckMock, checkLocalUpdate: localCheckMock }));

import { AstridUpdatesSection } from './AstridUpdatesSection.tsx';
import { APP_BUILD } from '@/shared/lib/updates/appBuildWatch.ts';
import { installCommand, RUNTIME_CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';

beforeEach(() => {
  vi.unstubAllEnvs();
  connectionMock.value = { isConnected: true, managedByPinokio: false };
  readStatusMock.mockReset().mockResolvedValue({ health: { status: 'ok', release: 3 } });
  hostedCheckMock.mockReset();
  localCheckMock.mockReset();
  originMock.value = 'https://astrid.test';
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const buildResponse = String(input) === '/build.json';
    return Promise.resolve(new Response(JSON.stringify(buildResponse
      ? { app: 'served-app-build', release: 12 }
      : { report: 'Astrid diagnostics\nLast update result: rolled_back\nInstaller transaction log:\ntransaction line\nRetained back-end copies: 0 bytes' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }));
});

describe('Astrid Updates Settings section', () => {
  it('shows the report-backed last result and expandable update log', async () => {
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    // The result sits after the "Last result:" label in the same paragraph, so match its text as a substring.
    expect(await within(section).findByText(/The update did not finish\. Astrid was restored to its previous version\./)).toBeInTheDocument();
    const diagnosticsToggle = within(section).getByRole('button', { name: 'Diagnostics' });
    expect(diagnosticsToggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(section).queryByText('transaction line')).toBeNull();
    // The download sits on the Diagnostics row itself, so it is there before the detail opens.
    expect(within(section).getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
    fireEvent.click(diagnosticsToggle);
    expect(diagnosticsToggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(section).getByRole('heading', { name: 'Update log' })).toBeInTheDocument();
    expect(within(section).getByText('transaction line')).toBeInTheDocument();
    // Opening the detail does not add a second download button.
    expect(within(section).getAllByRole('button', { name: 'Download diagnostics' })).toHaveLength(1);
    const diagnosticCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/v1/diagnostics'));
    expect(diagnosticCall).toBeDefined();
    const requestUrl = new URL(String(diagnosticCall?.[0]), 'http://localhost');
    expect(requestUrl.search).toBe('');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:settings-diagnostics');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(within(section).getByRole('button', { name: 'Download diagnostics' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const report = await (createObjectURL.mock.calls[0][0] as Blob).text();
    expect(report).toContain(`App build: ${APP_BUILD || 'served-app-build'}\nApp release: 12`);
    expect(report.match(/^App build:/gm)).toHaveLength(1);
    expect(report.match(/^App release:/gm)).toHaveLength(1);
  });

  it('offers agent and terminal instructions when Runtime diagnostics cannot answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    fireEvent.click(within(section).getByRole('button', { name: 'Diagnostics' }));
    // The mount-time diagnostics read fails asynchronously, so the fallback appears after the click settles.
    expect(await within(section).findByText("Couldn't collect diagnostics from Astrid.")).toBeInTheDocument();
    expect(await within(section).findByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
    expect(within(section).getByText(/astrid-runtime doctor.*astrid-diagnostics\.txt/)).toBeInTheDocument();
  });

  it('checks immediately when opened and shows the shared update action', async () => {
    hostedCheckMock.mockResolvedValue({ release: 3, app: 'app-a', servedRelease: 4, servedApp: 'app-b', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 4')).toBeInTheDocument();
    expect(readStatusMock).toHaveBeenCalledOnce();
    expect(hostedCheckMock).toHaveBeenCalledOnce();
    expect(within(section).getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
    expect(within(section).getByText(/No coding agent\? Run this in a terminal/)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Check for updates' })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Diagnostics' }));
    expect(within(section).getByText(/App build/)).toBeInTheDocument();
  });

  it('shows a stable error instead of claiming up to date when a check fails', async () => {
    hostedCheckMock.mockRejectedValue(new Error('offline'));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    await waitFor(() => expect(within(section).getByRole('status')).toHaveTextContent('Could not check Astrid update status. Check your connection and try again.'));
    expect(within(section).queryByText('offline')).toBeNull();
    expect(within(section).queryByText(/Astrid is up to date/)).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Check for updates' }));
    expect(within(section).getByRole('status')).toHaveTextContent('Checking for updates…');
    await waitFor(() => expect(within(section).getByRole('status')).toHaveTextContent('Could not check Astrid update status. Check your connection and try again.'));
  });

  it('uses the resolver command actions for a soft hosted installer update', async () => {
    hostedCheckMock.mockResolvedValue({ release: 3, app: 'current', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 4')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
    expect(localCheckMock).not.toHaveBeenCalled();
  });

  it('uses Pinokio update action for Pinokio installs', async () => {
    connectionMock.value = { isConnected: true, managedByPinokio: true };
    hostedCheckMock.mockResolvedValue({ release: 3, app: 'current', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 4')).toBeInTheDocument();
    expect(within(section).getByText('Update in Pinokio')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Copy instructions for your agent' })).toBeNull();
  });

  it('gets fully-local status only from the launcher and offers its resolver actions', async () => {
    originMock.value = '';
    vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 4')).toBeInTheDocument();
    expect(localCheckMock).toHaveBeenCalledOnce();
    expect(readStatusMock).not.toHaveBeenCalled();
    expect(within(section).getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
  });

  it('does not expose the fully-local in-app updater or stale npm route', async () => {
    originMock.value = '';
    vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 4')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(within(section).getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
    expect(within(section).getByRole('code')).toHaveTextContent(installCommand('update'));
    expect(within(section).queryByText(/npm run update/)).toBeNull();
  });

  it.each([
    ['Pinokio', 'pinokio', false, 'Update in Pinokio'],
    ['fully-local', 'fully-local', true, 'Copy instructions for your agent'],
  ] as const)('shows required reason and the %s primary action', async (_name, mode, local, primary) => {
    if (mode === 'pinokio') connectionMock.value = { isConnected: true, managedByPinokio: true };
    if (local) {
      originMock.value = '';
      vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
      localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 5, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 5, requiredRelease: 4, requiredReason: 'Security fix', releaseBehind: true } });
    } else {
      hostedCheckMock.mockResolvedValue({ release: 3, app: 'current', servedRelease: 5, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 5, requiredRelease: 4, requiredReason: 'Security fix', releaseBehind: true } });
    }
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('This update is required: Security fix')).toBeInTheDocument();
    expect(within(section).getByText(primary)).toBeInTheDocument();
    if (mode === 'fully-local') expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
  });

  it('shows launcher errors without claiming the fully-local install is up to date', async () => {
    originMock.value = '';
    vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
    localCheckMock.mockRejectedValue(new Error('launcher unavailable'));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByRole('status')).toHaveTextContent('Could not check Astrid update status. Check your connection and try again.');
    expect(within(section).queryByText(/Astrid is up to date/)).toBeNull();
  });

  it('shows required reason and keeps required-update precedence', async () => {
    hostedCheckMock.mockResolvedValue({ release: 3, app: 'current', servedRelease: 5, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 5, requiredRelease: 4, requiredReason: 'Security fix', releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 5')).toBeInTheDocument();
    expect(within(section).getByText('This update is required: Security fix')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    // Settings is where Details leads, so the section does not link to itself.
    expect(within(section).queryByRole('button', { name: 'Details' })).toBeNull();
  });

  it('reports newer-than-served before offering an update and clearly shows up-to-date', async () => {
    hostedCheckMock.mockResolvedValueOnce({ release: 5, app: 'current', servedRelease: 4, servedApp: 'served', behind: false, resolution: { installedRelease: 5, servedRelease: 4, releaseBehind: false } })
      .mockResolvedValueOnce({ release: 4, app: 'current', servedRelease: 4, servedApp: 'served', behind: false, resolution: { installedRelease: 4, servedRelease: 4, releaseBehind: false } });
    const view = render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText(/newer than astrid\.haus/)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Copy instructions for your agent' })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Check for updates' }));
    expect(await within(section).findByText(/^Astrid is up to date/)).toBeInTheDocument();
    view.unmount();
  });

  it('leaves out the empty last result and the empty log when no in-app update has run', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const buildResponse = String(input) === '/build.json';
      return Promise.resolve(new Response(JSON.stringify(buildResponse
        ? { app: 'served-app-build', release: 1 }
        : { report: 'Astrid diagnostics\nLast update result: none\nInstaller transaction log:\n\nRetained back-end copies: 0 bytes' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    hostedCheckMock.mockResolvedValue({ release: 1, app: 'served-app-build', servedRelease: 1, servedApp: 'served-app-build', behind: false, resolution: { installedRelease: 1, servedRelease: 1, releaseBehind: false } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Astrid is up to date (Release 1)')).toBeInTheDocument();
    expect(within(section).queryByText(/^Last result:/)).toBeNull();
    expect(within(section).getByRole('button', { name: 'Check for updates' })).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Diagnostics' }));
    expect(within(section).queryByRole('heading', { name: 'Update log' })).toBeNull();
  });

  it('shows the inline message and the fallback when the diagnostics download comes back empty', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/build.json') return Promise.resolve(new Response(JSON.stringify({ app: 'a', release: 1 }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ report: '   ' }), { status: 200 }));
    }));
    // The spy from the earlier download test is still installed (this file does not restore mocks), so clear its calls.
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:empty');
    createObjectURL.mockClear();
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    fireEvent.click(await within(section).findByRole('button', { name: 'Diagnostics' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Download diagnostics' }));
    expect(await within(section).findByText("Couldn't collect diagnostics from Astrid.")).toBeInTheDocument();
    expect(within(section).getByText(/astrid-runtime doctor.*astrid-diagnostics\.txt/)).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('downloads diagnostics from the folded row, and shows the fallback there when Astrid cannot give the report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/v1/diagnostics'))).toBe(true));
    // A failed read alone stays quiet while the row is folded.
    expect(within(section).queryByText("Couldn't collect diagnostics from Astrid.")).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Download diagnostics' }));
    expect(await within(section).findByText("Couldn't collect diagnostics from Astrid.")).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Diagnostics' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Updates for an Astrid older than this page', () => {
  const INSTALL_LINE = /install\s*\|\s*sh|install\.ps1/;
  const oldRuntime = (managedByPinokio = false) => {
    connectionMock.value = { isConnected: false, isAuthenticated: true, managedByPinokio, state: { status: 'update_needed' } };
  };
  const status = (release: number, servedRelease: number, managedBy: string | null = null) => ({
    release, app: 'current', servedRelease, servedApp: 'served', behind: release < servedRelease, managedBy,
    resolution: { installedRelease: release, servedRelease, releaseBehind: release < servedRelease },
  });

  it('gives a source checkout its one update path, though it has no release to name', async () => {
    oldRuntime();
    hostedCheckMock.mockResolvedValue(status(0, 12, 'source'));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByRole('status')).toHaveTextContent('Update Astrid');
    expect(within(section).getByText('update your checkouts')).toBeInTheDocument();
    expect(within(section).queryByRole('code')).toBeNull();
    expect(section.textContent).not.toMatch(INSTALL_LINE);
  });

  it('gives a Pinokio Astrid only Pinokio’s Update: no install command and no agent brief', async () => {
    oldRuntime(true);
    hostedCheckMock.mockResolvedValue(status(3, 4));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText('Update in Pinokio')).toBeInTheDocument();
    expect(within(section).getByText(RUNTIME_CONNECTION_COPY.updateNeeded.pinokioSentence)).toBeInTheDocument();
    expect(within(section).queryByRole('code')).toBeNull();
    for (const name of ['Copy instructions for your agent', 'Copy for your agent', 'Copy command', 'Update now']) expect(within(section).queryByRole('button', { name })).toBeNull();
    expect(section.textContent).not.toContain('Run it yourself');
    expect(section.textContent).not.toMatch(INSTALL_LINE);
  });

  it('gives a fully local Astrid the same update command as every direct install', async () => {
    oldRuntime();
    originMock.value = '';
    vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
    localCheckMock.mockResolvedValue(status(3, 4));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(within(section).getByRole('code')).toHaveTextContent(installCommand('update'));
    expect(within(section).queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(section.textContent).not.toContain('npm run update');
  });

  it('turns an old chat service into the update card, with the direct-install update command', async () => {
    connectionMock.value = { isConnected: true, managedByPinokio: false, state: { status: 'connected' }, schemaDigest: null, localServiceOutOfDate: true };
    hostedCheckMock.mockResolvedValue(status(4, 4));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText(new RegExp(RUNTIME_CONNECTION_COPY.chatNeedsUpdate))).toBeInTheDocument();
    expect(within(section).getByRole('status')).toHaveTextContent('Update Astrid');
    expect(within(section).getByRole('code')).toHaveTextContent(installCommand('update'));
  });

  it('keeps the update card when the release check cannot answer', async () => {
    oldRuntime(true);
    hostedCheckMock.mockRejectedValue(new Error('offline'));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText('Update in Pinokio')).toBeInTheDocument();
    expect(within(section).getByRole('status')).toHaveTextContent('Update Astrid');
    expect(within(section).queryByRole('code')).toBeNull();
  });
});
