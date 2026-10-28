// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectionMock, readStatusMock, hostedCheckMock, localCheckMock, originMock } = vi.hoisted(() => ({ connectionMock: { value: null as unknown }, readStatusMock: vi.fn(), hostedCheckMock: vi.fn(), localCheckMock: vi.fn(), originMock: { value: 'https://astrid.test' } }));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnection: () => connectionMock.value }));
vi.mock('@/integrations/runtime/client.ts', () => ({ AstridRuntimeClient: class { readStatus = readStatusMock; } }));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => originMock.value, runtimeApiBase: () => 'http://127.0.0.1:17340/api/runtime' }));
vi.mock('@/shared/lib/updates/updateStatus.ts', () => ({ checkHostedUpdate: hostedCheckMock, checkLocalUpdate: localCheckMock }));

import { AstridUpdatesSection } from './AstridUpdatesSection.tsx';
import { APP_BUILD } from '@/shared/lib/updates/appBuildWatch.ts';

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
    expect(await within(section).findByText('rolled_back')).toBeInTheDocument();
    fireEvent.click(within(section).getByText('View log'));
    expect(within(section).getByText('transaction line')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
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
    expect(await within(section).findByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
    expect(within(section).getByText(/astrid-runtime doctor.*astrid-diagnostics\.txt/)).toBeInTheDocument();
  });

  it('checks immediately when opened and shows the shared update action', async () => {
    hostedCheckMock.mockResolvedValue({ release: 3, app: 'app-a', servedRelease: 4, servedApp: 'app-b', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available · Release 4')).toBeInTheDocument();
    expect(readStatusMock).toHaveBeenCalledOnce();
    expect(hostedCheckMock).toHaveBeenCalledOnce();
    expect(within(section).getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
    expect(within(section).getByText(/No coding agent\? Run this in a terminal/)).toBeInTheDocument();
    expect(within(section).getByText('Release 3')).toBeInTheDocument();
    expect(within(section).getByText(/App build/)).toBeInTheDocument();
  });

  it('shows a stable error instead of claiming up to date when a check fails', async () => {
    hostedCheckMock.mockRejectedValue(new Error('offline'));
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    await waitFor(() => expect(within(section).getByRole('status')).toHaveTextContent('offline'));
    expect(within(section).queryByText('Astrid is up to date')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Check for updates' }));
    expect(within(section).getByRole('status')).toHaveTextContent('Checking for updates…');
    await waitFor(() => expect(within(section).getByRole('status')).toHaveTextContent('offline'));
  });

  it('uses the resolver command actions for a soft hosted installer update', async () => {
    hostedCheckMock.mockResolvedValue({ release: 3, app: 'current', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available · Release 4')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
    expect(localCheckMock).not.toHaveBeenCalled();
  });

  it('uses Pinokio update action for Pinokio installs', async () => {
    connectionMock.value = { isConnected: true, managedByPinokio: true };
    hostedCheckMock.mockResolvedValue({ release: 3, app: 'current', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available · Release 4')).toBeInTheDocument();
    expect(within(section).getByText('Update in Pinokio')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Copy for your agent' })).toBeNull();
  });

  it('gets fully-local status only from the launcher and offers its resolver actions', async () => {
    originMock.value = '';
    vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available · Release 4')).toBeInTheDocument();
    expect(localCheckMock).toHaveBeenCalledOnce();
    expect(readStatusMock).not.toHaveBeenCalled();
    expect(within(section).getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
    expect(within(section).getByText('Run it yourself')).toBeInTheDocument();
  });

  it.each([
    ['Pinokio', 'pinokio', false, 'Update in Pinokio'],
    ['fully-local', 'fully-local', true, 'Copy for your agent'],
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
    expect(await within(section).findByRole('status')).toHaveTextContent('launcher unavailable');
    expect(within(section).queryByText('Astrid is up to date')).toBeNull();
  });

  it('shows required reason and keeps required-update precedence', async () => {
    hostedCheckMock.mockResolvedValue({ release: 3, app: 'current', servedRelease: 5, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 5, requiredRelease: 4, requiredReason: 'Security fix', releaseBehind: true } });
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available · Release 5')).toBeInTheDocument();
    expect(within(section).getByText('This update is required: Security fix')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
    const onOpen = vi.fn();
    window.addEventListener('openSettings', (event) => onOpen((event as CustomEvent).detail), { once: true });
    fireEvent.click(within(section).getByRole('button', { name: 'Details' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
  });

  it('reports newer-than-served before offering an update and clearly shows up-to-date', async () => {
    hostedCheckMock.mockResolvedValueOnce({ release: 5, app: 'current', servedRelease: 4, servedApp: 'served', behind: false, resolution: { installedRelease: 5, servedRelease: 4, releaseBehind: false } })
      .mockResolvedValueOnce({ release: 4, app: 'current', servedRelease: 4, servedApp: 'served', behind: false, resolution: { installedRelease: 4, servedRelease: 4, releaseBehind: false } });
    const view = render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText(/newer than astrid\.haus/)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Copy for your agent' })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Check for updates' }));
    expect(await within(section).findByText('Astrid is up to date')).toBeInTheDocument();
    view.unmount();
  });
});
