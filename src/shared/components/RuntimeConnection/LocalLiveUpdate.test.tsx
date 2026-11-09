// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A fully local page (npm run dev:local) that is already open while Astrid updates under it (Update now, or
 * npm run update in a terminal): the Runtime restarts as a new instance and the launcher's status reports Release 11.
 * The page shows the result with no reload and no click, the same way the hosted page does (LiveUpdate.test.tsx).
 */
const { runtime, connectionMock, hostedCheck } = vi.hoisted(() => ({
  runtime: { instance: 'instance-r10', release: 10 },
  connectionMock: { value: { isConnected: true, managedByPinokio: false } as unknown },
  hostedCheck: { calls: 0 },
}));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnection: () => connectionMock.value }));
vi.mock('@/integrations/runtime/client.ts', () => ({ AstridRuntimeClient: class {
  readInstallerUpdateHealth = async () => ({ status: 'ok', runtime_instance_id: runtime.instance, release: runtime.release, identity: { managed_by: 'source', release: runtime.release } });
  readInstallerUpdateStatus = async () => ({ available: false, self_update: false, state: 'none', reason: 'source' });
} }));
vi.mock('@/shared/contexts/AuthContext.tsx', () => ({ useAuthSafe: () => ({ isAuthenticated: true, authError: null }) }));
// A local page reaches its Runtime same-origin through the Vite proxy: there is no separate Runtime origin.
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => '', runtimeApiBase: () => '/api/runtime' }));
// The launcher's status: astrid.haus serves Release 11; the checkout is whatever the update left it on.
vi.mock('@/shared/lib/updates/updateStatus.ts', () => ({
  checkHostedUpdate: vi.fn(async () => { hostedCheck.calls += 1; throw new Error('a local page never reads the hosted status'); }),
  checkLocalUpdate: vi.fn(async () => ({ release: runtime.release, app: `checkout-r${runtime.release}`, servedRelease: 11, servedApp: 'served-r11', behind: runtime.release < 11,
    managedBy: null, selfUpdate: true, resolution: { installedRelease: runtime.release, servedRelease: 11, releaseBehind: runtime.release < 11 } })),
}));

import { AstridUpdatesSection } from '@/shared/components/SettingsModal/sections/AstridUpdatesSection.tsx';
import { QuietUpdateNotice } from './QuietUpdateNotice.tsx';
import { resetLiveUpdateForTest, UPDATED_NOTICE_MS } from '@/shared/lib/updates/liveUpdate.ts';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';

const POLL_MS = 3000;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
  resetLiveUpdateForTest();
  runtime.instance = 'instance-r10';
  runtime.release = 10;
  hostedCheck.calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
    String(input) === '/build.json' ? { app: 'checkout-r10', release: 10 } : { report: 'Astrid diagnostics: OK.\nLast update result: none recorded' }),
  { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** The local update finishes: the Runtime restarts as a new instance and the checkout is on Release 11. */
function finishUpdate() {
  runtime.instance = 'instance-r11';
  runtime.release = 11;
}

describe('an open local page while Astrid updates from Release 10 to 11', () => {
  it('Settings: shows "Astrid updated", then the up-to-date copy, with no user action', async () => {
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(await within(section).findByText('Update available: Release 11')).toBeInTheDocument();

    finishUpdate();
    await advance(POLL_MS + 100);
    expect(within(section).getByRole('status')).toHaveTextContent('Astrid updated: Release 10 → Release 11');

    await advance(UPDATED_NOTICE_MS + 100);
    expect(within(section).getByRole('status')).toHaveTextContent('Astrid is up to date (Release 11)');
    expect(within(section).queryByText(/Update available/)).toBeNull();
    // The Runtime's own installer status (a source checkout) is not this page's update path.
    expect(within(section).queryByText(/can't update itself|cannot update itself/i)).toBeNull();
    expect(hostedCheck.calls).toBe(0);
  });

  it('the page: the update card becomes "Astrid updated", then goes away', async () => {
    render(<QuietUpdateNotice connection={connectionMock.value as RuntimeConnectionValue} />);
    expect(await screen.findByTestId('quiet-update-notice')).toHaveTextContent('Update available: Release 11');

    finishUpdate();
    await advance(POLL_MS + 100);
    expect(screen.getByTestId('update-finished-notice')).toHaveTextContent('Astrid updated: Release 10 → Release 11');
    expect(screen.queryByTestId('quiet-update-notice')).toBeNull();

    await advance(UPDATED_NOTICE_MS + 100);
    expect(screen.queryByTestId('update-finished-notice')).toBeNull();
    expect(screen.queryByTestId('quiet-update-notice')).toBeNull();
    expect(hostedCheck.calls).toBe(0);
  });

  it('a restart on the same release is not an update', async () => {
    render(<QuietUpdateNotice connection={connectionMock.value as RuntimeConnectionValue} />);
    await screen.findByTestId('quiet-update-notice');
    runtime.instance = 'instance-r10-again';
    await advance(POLL_MS + 100);
    expect(screen.queryByTestId('update-finished-notice')).toBeNull();
    expect(screen.getByTestId('quiet-update-notice')).toHaveTextContent('Update available: Release 11');
  });
});
