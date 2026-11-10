// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An astrid.haus page that is already open while Astrid updates under it (by a terminal command or Update now):
 * the Runtime restarts as a new instance on Release 11, and the page shows the result with no reload and no click.
 */
const { runtime, connectionMock } = vi.hoisted(() => ({
  runtime: { instance: 'instance-r10', release: 10 },
  connectionMock: { value: { isConnected: true, managedByPinokio: false } as unknown },
}));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnection: () => connectionMock.value }));
vi.mock('@/integrations/runtime/client.ts', () => ({ AstridRuntimeClient: class {
  readInstallerUpdateHealth = async () => ({ status: 'ok', runtime_instance_id: runtime.instance, release: runtime.release, identity: { managed_by: null, release: runtime.release } });
  readInstallerUpdateStatus = async () => ({ available: true, self_update: true, state: 'none', reason: 'none' });
} }));
// A signed-in page: the update operation polls only for an authenticated workspace.
vi.mock('@/shared/contexts/AuthContext.tsx', () => ({ useAuthSafe: () => ({ isAuthenticated: true, authError: null }) }));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => 'https://astrid.test', runtimeApiBase: () => 'http://127.0.0.1:17340/api/runtime' }));
// The served manifest is Release 11; the installed release is whatever the live Runtime reports.
vi.mock('@/shared/lib/updates/updateStatus.ts', () => {
  const status = (health: { identity?: { release?: number } }) => {
    const release = health.identity?.release ?? 0;
    return { release, app: 'app', servedRelease: 11, servedApp: 'app', behind: release < 11, managedBy: null,
      resolution: { installedRelease: release, servedRelease: 11, releaseBehind: release < 11 } };
  };
  return { checkHostedUpdate: vi.fn(async (health: { identity?: { release?: number } }) => status(health)), checkLocalUpdate: vi.fn() };
});

import { AstridUpdatesSection } from '@/shared/components/SettingsModal/sections/AstridUpdatesSection.tsx';
import { QuietUpdateNotice } from './QuietUpdateNotice.tsx';
import { resetLiveUpdateForTest, UPDATED_NOTICE_MS } from '@/shared/lib/updates/liveUpdate.ts';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';

const POLL_MS = 3000;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetLiveUpdateForTest();
  runtime.instance = 'instance-r10';
  runtime.release = 10;
  // A fresh fetch per test is a fresh page operation (pageUpdateOperation is keyed by fetch).
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
    String(input) === '/build.json' ? { app: 'app', release: 11 } : { report: 'Astrid diagnostics: OK.\nLast update result: none recorded' }),
  { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** The update finishes: the Runtime restarts as a new instance on Release 11. */
function finishUpdate() {
  runtime.instance = 'instance-r11';
  runtime.release = 11;
}

describe('an open page while Astrid updates from Release 10 to 11', () => {
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
