// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectionMock, readStatusMock, statusReadMock, statusMock, hostedCheckMock, localCheckMock, originMock } = vi.hoisted(() => ({ connectionMock: { value: null as unknown }, readStatusMock: vi.fn(), statusReadMock: vi.fn(), statusMock: { value: null as unknown }, hostedCheckMock: vi.fn(), localCheckMock: vi.fn(), originMock: { value: 'https://astrid.test' } }));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnection: () => connectionMock.value }));
vi.mock('@/integrations/runtime/client.ts', () => ({ AstridRuntimeClient: class { readInstallerUpdateHealth = async () => (await readStatusMock()).health; readInstallerUpdateStatus = async () => { statusReadMock(); return statusMock.value; }; } }));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => originMock.value, runtimeApiBase: () => 'http://127.0.0.1:17340/api/runtime' }));
vi.mock('@/shared/lib/updates/updateStatus.ts', () => ({ checkHostedUpdate: hostedCheckMock, checkLocalUpdate: localCheckMock }));

import { AstridUpdatesSection } from './AstridUpdatesSection.tsx';
import { APP_BUILD } from '@/shared/lib/updates/appBuildWatch.ts';
import { ASTRID_COMMANDS, installCommand, LOCAL_UPDATE_COMMAND, RUNTIME_CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { ASTRID_STATUS_COPY } from './astridStatusCopy.ts';
import { pageUpdateOperation } from '@/shared/lib/updates/updateOperation.ts';
import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { INSTALLER_UPDATE_REASON_MESSAGES } from '@/integrations/runtime/installerUpdateReasons.ts';

beforeEach(() => {
  vi.unstubAllEnvs();
  connectionMock.value = { isConnected: true, managedByPinokio: false };
  statusReadMock.mockReset();
  readStatusMock.mockReset().mockResolvedValue({ health: { status: 'ok', release: 3 } });
  statusMock.value = { available: false, state: 'none' };
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
    expect(report).toContain(`App release: 12\nApp build: ${APP_BUILD || 'served-app-build'}`);
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
    hostedCheckMock.mockResolvedValue({ release: 10, app: 'app-a', servedRelease: 11, servedApp: 'app-b', behind: true, resolution: { installedRelease: 10, servedRelease: 11, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 11')).toBeInTheDocument();
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
    hostedCheckMock.mockResolvedValue({ release: 10, app: 'current', servedRelease: 11, servedApp: 'served', behind: true, resolution: { installedRelease: 10, servedRelease: 11, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 11')).toBeInTheDocument();
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
    // The releases come only from the launcher. The Runtime's health is read for its instance (a finished update shows
    // live, UR-15l-3 a8), but never its installer status route nor the hosted release check.
    expect(localCheckMock).toHaveBeenCalled();
    expect(hostedCheckMock).not.toHaveBeenCalled();
    expect(statusReadMock).not.toHaveBeenCalled();
    expect(within(section).getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
  });

  it('does not expose the fully-local in-app updater; shows the local npm update command', async () => {
    originMock.value = '';
    vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 4')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(within(section).getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
    expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
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
    hostedCheckMock.mockResolvedValue({ release: 10, app: 'current', servedRelease: 12, servedApp: 'served', behind: true, resolution: { installedRelease: 10, servedRelease: 12, requiredRelease: 11, requiredReason: 'Security fix', releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 12')).toBeInTheDocument();
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

  it.each([
    ['the live recovery word', 'recovery-needed'],
    ['the report recovery word', 'recovery_needed'],
    ['an unknown word', 'partially-applied'],
  ])('never shows a result line for %s in the report when no update has run', async (_name, result) => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/build.json') return Promise.resolve(new Response(JSON.stringify({ app: 'served-app-build', release: 1 }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ report: `Astrid diagnostics\nLast update result: ${result}\nInstaller transaction log:\ntransaction line\nRetained back-end copies: 0 bytes` }), { status: 200 }));
    }));
    hostedCheckMock.mockResolvedValue({ release: 1, app: 'served-app-build', servedRelease: 1, servedApp: 'served-app-build', behind: false, resolution: { installedRelease: 1, servedRelease: 1, releaseBehind: false } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Astrid is up to date (Release 1)')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Diagnostics' }));
    // The log shows only once the report has loaded, so the missing result line is not just an early read.
    expect(await within(section).findByText('transaction line')).toBeInTheDocument();
    expect(within(section).queryByText(/^Last result:/)).toBeNull();
    expect(within(section).queryByText(/An update result is available/)).toBeNull();
  });

  it('offers the plain install line after a failed update, not only the diagnostics link', async () => {
    statusMock.value = { available: true, self_update: true, state: 'terminal', outcome: 'failed', operation_id: 'op-failed', result: 'Update failed.' };
    // The shared operation store is read directly, as the repair tests do, so the failed status is in place before render.
    const operation = pageUpdateOperation(runtimeApiBase());
    try {
      await operation.refresh();
      hostedCheckMock.mockResolvedValue({ release: 3, app: 'current', servedRelease: 3, servedApp: 'served', behind: false, resolution: { installedRelease: 3, servedRelease: 3, releaseBehind: false } });
      render(<AstridUpdatesSection isOpen />);
      const section = screen.getByRole('region', { name: 'Updates' });
      const command = await within(section).findByRole('code');
      expect(command).toHaveTextContent(ASTRID_COMMANDS.macLinux);
      expect(command.textContent).not.toContain('--update');
      expect(within(section).getAllByRole('code')).toHaveLength(1);
    } finally {
      // Later tests share this store, so it returns to an idle Astrid.
      statusMock.value = { available: false, state: 'none' };
      await operation.refresh();
    }
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
    expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
    expect(within(section).queryByRole('button', { name: 'Update now' })).toBeNull();
  });

  it('turns an old chat service into the update card, with the direct-install update command', async () => {
    connectionMock.value = { isConnected: true, managedByPinokio: false, state: { status: 'connected' }, schemaDigest: null, localServiceOutOfDate: true };
    hostedCheckMock.mockResolvedValue(status(4, 4));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText(new RegExp(RUNTIME_CONNECTION_COPY.chatNeedsUpdate))).toBeInTheDocument();
    expect(within(section).getByRole('status')).toHaveTextContent('Update Astrid');
    expect(within(section).getByRole('code')).toHaveTextContent('curl -fsSL https://astrid.haus/install | sh -s -- --update');
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

describe('Updates repair entry for a direct install', () => {
  const PLAIN_INSTALL_LINE = 'curl -fsSL https://astrid.haus/install | sh';
  const directIdentity = { managed_by: null, release: 3 };
  const current = { release: 3, app: 'current', servedRelease: 3, servedApp: 'served', behind: false, resolution: { installedRelease: 3, servedRelease: 3, releaseBehind: false } };
  // The section reads the shared update operation's health, so each test loads its Runtime health into that store first.
  const loadHealth = async (health: Record<string, unknown>) => {
    readStatusMock.mockResolvedValue({ health });
    await pageUpdateOperation(runtimeApiBase()).refresh();
  };

  it('gives a degraded direct install the plain install line, without --update', async () => {
    await loadHealth({ status: 'degraded', release: 3, runtime_instance_id: 'runtime-degraded', identity: directIdentity, services: [{ name: 'chat', state: 'failed', last_exit: 2, restart_count: 1 }] });
    hostedCheckMock.mockResolvedValue(current);
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText(ASTRID_STATUS_COPY.repairTitle)).toBeInTheDocument();
    expect(within(section).getByText(ASTRID_STATUS_COPY.repairDescription)).toBeInTheDocument();
    expect(within(section).getByRole('code')).toHaveTextContent(PLAIN_INSTALL_LINE);
    expect(within(section).getByRole('code').textContent).not.toContain('--update');
  });

  it('leaves the repair row out while an update is offered, which is then the only path', async () => {
    await loadHealth({ status: 'degraded', release: 3, runtime_instance_id: 'runtime-behind', identity: directIdentity, services: [{ name: 'chat', state: 'failed', last_exit: 2, restart_count: 1 }] });
    hostedCheckMock.mockResolvedValue({ ...current, release: 10, servedRelease: 11, behind: true, resolution: { installedRelease: 10, servedRelease: 11, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText(/^Update available/)).toBeInTheDocument();
    expect(within(section).queryByText(ASTRID_STATUS_COPY.repairTitle)).toBeNull();
    expect(section.textContent).not.toContain(ASTRID_STATUS_COPY.repairDescription);
  });

  it('shows no repair entry while the direct install is healthy', async () => {
    await loadHealth({ status: 'ok', release: 3, runtime_instance_id: 'runtime-ok', identity: directIdentity, services: [] });
    hostedCheckMock.mockResolvedValue(current);
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText(/^Astrid is up to date/)).toBeInTheDocument();
    expect(within(section).queryByText(ASTRID_STATUS_COPY.repairTitle)).toBeNull();
    expect(within(section).queryByRole('code')).toBeNull();
  });
});

describe("Hannah's state: Release 1 after a finished storage move, Release 10 served", () => {
  // The Runtime's own report for this state (astrid-runtime tests/fixtures/field_states.json, rendered by diagnostics_report).
  const fixture = (name: string) => readFileSync(path.resolve(__dirname, '../../../lib/updates/__fixtures__', `${name}.diagnostics.txt`), 'utf8');
  const hannah = { release: 1, app: 'current', servedRelease: 10, servedApp: 'served', behind: true, resolution: { installedRelease: 1, servedRelease: 10, releaseBehind: true } };
  const serve = (report: string) => vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => Promise.resolve(new Response(JSON.stringify(
    String(input) === '/build.json' ? { app: 'served-app-build', release: 10 } : { report }), { status: 200, headers: { 'Content-Type': 'application/json' } }))));

  it('shows Release 10 is ready with the too-old copy and the one command, never the generic line', async () => {
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 1, identity: { managed_by: null, release: 1 } } });
    statusMock.value = { available: true, state: 'none' };
    serve(fixture('hannah-before-receipt'));
    hostedCheckMock.mockResolvedValue(hannah);
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Release 10 is ready')).toBeInTheDocument();
    expect(within(section).getByText(/^You have Release 1\. Releases before 10 can't update from this page, so this one update needs a command\. It keeps your projects\./)).toBeInTheDocument();
    expect(within(section).getByText(/Open Terminal, paste the command, press Return\./)).toBeInTheDocument();
    expect(within(section).getByText(installCommand('update'))).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(section.textContent).not.toContain("Astrid can't update itself on this computer");
    // No receipt from an installer before UR-15a: nothing claims the last update did nothing.
    expect(within(section).queryByText("The last update didn't install anything")).toBeNull();
  });

  it('says the last update did nothing and points to Download diagnostics when the receipt is not-updated', async () => {
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 1, identity: { managed_by: null, release: 1 } } });
    statusMock.value = { available: true, state: 'none' };
    serve(fixture('hannah-not-updated'));
    hostedCheckMock.mockResolvedValue(hannah);
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText("The last update didn't install anything")).toBeInTheDocument();
    expect(within(section).getByText(/^Astrid is still Release 1; Release 10 is available\. This is a problem in Astrid, not something you did\. Your projects are safe\./)).toBeInTheDocument();
    expect(within(section).getAllByRole('button', { name: 'Download diagnostics' })).toHaveLength(2);
    expect(within(section).getByRole('button', { name: 'Copy command (try again)' })).toBeInTheDocument();
    expect(section.textContent).not.toContain("Astrid can't update itself on this computer");
    // Every command on this update state is the --update form; the plain install line is for repair only.
    const commands = within(section).getAllByRole('code').map((node) => node.textContent ?? '');
    expect(commands.length).toBeGreaterThanOrEqual(2);
    for (const command of commands) expect(command).toBe(installCommand('update'));
    expect(within(section).queryByText(ASTRID_STATUS_COPY.repairTitle)).toBeNull();
  });

  it('reads the update log under the Runtime\'s new label', async () => {
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 1, identity: { managed_by: null, release: 1 } } });
    serve('Last update result: rolled_back\nInstaller log (install.log, last 80 lines):\nnew label line\nProgram versions on disk: 1 version, 0 bytes');
    hostedCheckMock.mockResolvedValue(hannah);
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    await within(section).findByText('Release 10 is ready');
    fireEvent.click(within(section).getByRole('button', { name: 'Diagnostics' }));
    expect(await within(section).findByText('new label line')).toBeInTheDocument();
  });
});

describe('receipts from terminal runs: each has its row, Download diagnostics and the right command', () => {
  const behind = { release: 10, app: 'current', servedRelease: 11, servedApp: 'served', behind: true, resolution: { installedRelease: 10, servedRelease: 11, releaseBehind: true } };
  const receipt = (fields: Record<string, unknown>) => `Astrid diagnostics\nLast installer run (last-run.json): ${JSON.stringify({ format: 'astrid-last-run/v1', mode: 'update', start: 10, still: 10, target: 11, exit_code: 1, ...fields })}\nLast update result: none\n`;
  const serve = (report: string) => vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => Promise.resolve(new Response(JSON.stringify(
    String(input) === '/build.json' ? { app: 'served-app-build', release: 11 } : { report }), { status: 200, headers: { 'Content-Type': 'application/json' } }))));
  const mount = async (report: string, status: Record<string, unknown> = { available: true, state: 'none' }) => {
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 10, identity: { managed_by: null, release: 10 } } });
    statusMock.value = status;
    // The page's update operation is kept per fetch, so the report is served first.
    serve(report);
    hostedCheckMock.mockResolvedValue(behind);
    await pageUpdateOperation(runtimeApiBase()).refresh();
    render(<AstridUpdatesSection isOpen />);
    return screen.getByRole('region', { name: 'Updates' });
  };
  const repairLine = ASTRID_COMMANDS.macLinux;

  it.each([
    ['failed', { kind: 'failed', reason: 'error' }, "The update to Release 11 didn't finish", /^Astrid is still Release 10 and your projects are unchanged\. Reason: the update stopped with an error\.$/, 'Copy command (try again)', installCommand('update')],
    ['rolled-back', { kind: 'rolled-back', reason: 'error' }, "The update to Release 11 didn't finish", /^Astrid went back to Release 10 and your projects are unchanged\. Reason: the new version didn't start\.$/, 'Copy command (try again)', installCommand('update')],
    ['disk-full', { kind: 'not-updated', reason: 'disk-space', exit_code: 3 }, 'Not enough disk space to update', /Free up space, then try again\.$/, 'Copy command (try again)', installCommand('update')],
    ['two copies', { kind: 'not-updated', reason: 'other-runtime-running', exit_code: 3 }, 'Two copies of Astrid are running', /^An older copy of Astrid started again alongside this one\./, 'Copy repair command', repairLine],
  ] as const)('%s', async (_name, fields, title, body, label, command) => {
    const section = await mount(receipt(fields));
    expect(await within(section).findByText(title)).toBeInTheDocument();
    expect(within(section).getByText(body)).toBeInTheDocument();
    // Its own Download diagnostics, beside the Diagnostics row's.
    expect(within(section).getAllByRole('button', { name: 'Download diagnostics' })).toHaveLength(2);
    expect(within(section).getByRole('button', { name: label })).toBeInTheDocument();
    expect(within(section).getAllByRole('code').map((node) => node.textContent)).toContain(command);
    expect(section.textContent).not.toContain("Astrid can't update itself on this computer");
    expect(section.textContent).not.toMatch(/R0|R1|handoff|back-end|the message above/);
  });

  it('windows-upgrade-unsupported receipt: Download diagnostics and no command to try again', async () => {
    const section = await mount(receipt({ kind: 'failed', reason: 'windows-upgrade-unsupported' }));
    expect(await within(section).findByText("This update can't install on this computer yet")).toBeInTheDocument();
    expect(within(section).getAllByRole('button', { name: 'Download diagnostics' })).toHaveLength(2);
    expect(within(section).queryByRole('button', { name: 'Copy command (try again)' })).toBeNull();
  });

  it('windows-upgrade-unsupported in update status: its line, no retry command, never the generic line', async () => {
    const section = await mount('Astrid diagnostics\nLast update result: none\n', { available: true, self_update: true, state: 'none', reason: 'windows-upgrade-unsupported' });
    expect(await within(section).findAllByText(INSTALLER_UPDATE_REASON_MESSAGES['windows-upgrade-unsupported'])).not.toHaveLength(0);
    expect(within(section).queryByRole('code')).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(within(section).getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
    expect(section.textContent).not.toContain('Run the command below');
  });
});
