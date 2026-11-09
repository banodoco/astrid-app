// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionFor } from './connectionFixture.ts';
import { LOCAL_UPDATE_COMMAND } from './copy.ts';
import { RuntimeConnectionPanel } from './RuntimeConnectionPanel.tsx';
import { pageLocalUpdate } from '@/shared/lib/updates/updateOperation.ts';

const { connectionMock, localCheckMock, originMock } = vi.hoisted(() => ({
  connectionMock: { value: null as unknown },
  localCheckMock: vi.fn(),
  originMock: { value: '' },
}));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnection: () => connectionMock.value }));
vi.mock('@/integrations/runtime/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/connection.ts')>()),
  runtimeOrigin: () => originMock.value,
}));
vi.mock('@/shared/lib/updates/updateStatus.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/lib/updates/updateStatus.ts')>()),
  checkLocalUpdate: localCheckMock,
}));
vi.mock('@/shared/components/RuntimeConnection/AppBuildProvider.tsx', () => ({ usePageStale: () => false }));

import { AstridUpdatesSection } from '@/shared/components/SettingsModal/sections/AstridUpdatesSection.tsx';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A readable Runtime (its health names no manager): the fully-local card needs the Runtime's identity before it shows a command.
const healthyRuntime = { status: 'ok', protocol: 'workspace.v1', schema_digest: 'schema-test', runtime_instance_id: 'instance-a', runtime_session_id: 'session-a', runtime_epoch: 1, identity: { managed_by: null, release: 10 } };
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    return Promise.resolve(url.endsWith('/v1/health') ? json(200, healthyRuntime) : json(200, { report: 'Astrid diagnostics' }));
  }));
}

beforeEach(() => {
  pageLocalUpdate().reset();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
  originMock.value = '';
  connectionMock.value = { isConnected: true, managedByPinokio: false };
  localCheckMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fully-local update guidance', () => {
  it('shows the local update command without a Settings updater', async () => {
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    stubFetch();
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText('Update available: Release 4')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
  });

  it('uses the same install-command guidance for a required fully-local update', async () => {
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 5, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 5, requiredRelease: 4, requiredReason: 'Security fix', releaseBehind: true } });
    stubFetch();
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText('This update is required: Security fix')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
  });

  it('keeps the fully-local hard card on install-command guidance', async () => {
    render(<RuntimeConnectionPanel connection={connectionFor({ status: 'update_needed' }, { managedByPinokio: false })} />);

    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(screen.getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
  });

  describe('when the status reports self_update', () => {
    const TARGET = { url: 'http://127.0.0.1:5000/page-update', token: 'cd'.repeat(32) };
    const behind = { release: 3, app: 'local', servedRelease: 4, servedApp: 'served', behind: true, selfUpdate: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } };
    function stubLauncher(launcher: () => Response) {
      const fetchMock = vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url === '/__astrid/local-update-page') return Promise.resolve(json(200, TARGET));
        if (url === TARGET.url) return Promise.resolve(launcher());
        if (url.endsWith('/v1/health')) return Promise.resolve(json(200, healthyRuntime));
        return Promise.resolve(json(200, { report: 'Astrid diagnostics' }));
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('offers Update now with the local update command as the secondary', async () => {
      localCheckMock.mockResolvedValue(behind);
      stubFetch();
      render(<AstridUpdatesSection isOpen />);
      const section = screen.getByRole('region', { name: 'Updates' });

      expect(await within(section).findByRole('button', { name: 'Update now' })).toBeInTheDocument();
      expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
    });

    it('offers no Update now when the status does not report self_update', async () => {
      localCheckMock.mockResolvedValue({ ...behind, selfUpdate: false });
      stubFetch();
      render(<AstridUpdatesSection isOpen />);
      const section = screen.getByRole('region', { name: 'Updates' });

      expect(await within(section).findByText('Update available: Release 4')).toBeInTheDocument();
      expect(within(section).queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
      expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
    });

    it('updates through the launcher once per click and offers Reload', async () => {
      localCheckMock.mockResolvedValue(behind);
      const fetchMock = stubLauncher(() => json(200, { result: { status: 'updated', message: 'Astrid is updated and running.' } }));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      render(<AstridUpdatesSection isOpen />);
      const section = screen.getByRole('region', { name: 'Updates' });

      fireEvent.click(await within(section).findByRole('button', { name: 'Update now' }));
      expect(await within(section).findByText('Astrid updated.')).toBeInTheDocument();
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === TARGET.url)).toHaveLength(1);
      const post = fetchMock.mock.calls.find(([url]) => String(url) === TARGET.url)![1] as RequestInit;
      expect((post.headers as Record<string, string>).Authorization).toBe(`Bearer ${TARGET.token}`);
      expect(within(section).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    });

    it('shows a refusal and keeps the install command', async () => {
      localCheckMock.mockResolvedValue(behind);
      stubLauncher(() => json(409, { error: 'refused', code: 'local_edits_conflict', refusal: 'dirty' }));
      render(<AstridUpdatesSection isOpen />);
      const section = screen.getByRole('region', { name: 'Updates' });

      fireEvent.click(await within(section).findByRole('button', { name: 'Update now' }));
      expect(await within(section).findByRole('alert')).toHaveTextContent(/local edits overlap/);
      expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
    });
  });
});
