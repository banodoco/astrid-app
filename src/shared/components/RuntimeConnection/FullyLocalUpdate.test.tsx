// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionFor } from './connectionFixture.ts';
import { installCommand } from './copy.ts';
import { RuntimeConnectionPanel } from './RuntimeConnectionPanel.tsx';

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

const LOCAL_UPDATE_COMMAND = installCommand('update');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { report: 'Astrid diagnostics' }))));
}

beforeEach(() => {
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
  it('shows install-command guidance without a Settings updater or npm route', async () => {
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    stubFetch();
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText('Update available · Release 4')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
    expect(section.textContent).not.toContain('npm run update');
  });

  it('uses the same install-command guidance for a required fully-local update', async () => {
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 5, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 5, requiredRelease: 4, requiredReason: 'Security fix', releaseBehind: true } });
    stubFetch();
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText('This update is required: Security fix')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(within(section).getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
    expect(section.textContent).not.toContain('npm run update');
  });

  it('keeps the fully-local hard card on install-command guidance', async () => {
    render(<RuntimeConnectionPanel connection={connectionFor({ status: 'update_needed' }, { managedByPinokio: false })} />);

    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(screen.getByRole('code')).toHaveTextContent(LOCAL_UPDATE_COMMAND);
    expect(document.body.textContent ?? '').not.toContain('npm run update');
  });
});
