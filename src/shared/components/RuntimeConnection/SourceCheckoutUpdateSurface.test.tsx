// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionFor, CONNECTED_REALM } from './connectionFixture.ts';

const { connectionRef } = vi.hoisted(() => ({ connectionRef: { current: null as unknown } }));
vi.mock('@/integrations/runtime/client.ts', () => ({
  AstridRuntimeClient: class {
    // A source checkout's startup identity: managed_by is 'source' and its release is fixed at 0.
    readInstallerUpdateHealth = async () => ({ status: 'ok', release: 0, identity: { release: 0, managed_by: 'source' } });
    readInstallerUpdateStatus = async () => ({ available: false, state: 'none' });
  },
}));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => 'https://astrid.test', runtimeApiBase: () => 'https://astrid.test/api/runtime' }));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/RuntimeConnectionProvider.tsx')>()),
  useRuntimeConnection: () => connectionRef.current,
  useRuntimeConnectionSafe: () => connectionRef.current,
}));
vi.mock('./AppBuildProvider.tsx', () => ({ usePageStale: () => false }));

import { AppHeader } from '@/shared/components/AppHeader.tsx';
import { AstridUpdatesSection } from '@/shared/components/SettingsModal/sections/AstridUpdatesSection.tsx';
import { RuntimeConnectionPill } from './RuntimeConnectionPill.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('source checkout Runtime with a served required release', () => {
  it('shows no required card, header dot, Settings required text or installer command', async () => {
    connectionRef.current = connectionFor({ status: 'connected', realm: CONNECTED_REALM }, { managedByPinokio: false });
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input === '/build.json') return json({ app: 'app-a', release: 5 })();
      if (input === '/install-manifest.json') return json({ release: 5, required: { release: 5, reason: 'security fix' } })();
      if (input.endsWith('/v1/diagnostics')) return json({ report: 'Last update result: none\nInstaller transaction log:\n\nRetained back-end copies: 0 bytes' })();
      throw new Error(`unexpected fetch ${input}`);
    }));
    const healthFetch = vi.fn(async () => json({ status: 'ok', runtime_instance_id: 'instance-1' })());

    render(
      <>
        <RuntimeConnectionPill connection={connectionRef.current as never} fetchImpl={healthFetch} restartCheckIntervalMs={5} />
        <AppHeader />
        <AstridUpdatesSection isOpen />
      </>,
    );

    const section = screen.getByRole('region', { name: 'Updates' });
    // The Settings release row shows the identity it read, so its check has finished; let the page-level loads settle too.
    expect(await within(section).findByText('Release 0')).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(screen.queryByTestId('quiet-update-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-update-indicator')).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent('This update is required');
    // The status line is the resolver's result: a source checkout has no release to be behind on.
    expect(await within(section).findByText('Astrid is up to date')).toBeInTheDocument();
    expect(section).not.toHaveTextContent('Update available');
    expect(screen.queryByRole('button', { name: 'Copy for your agent' })).not.toBeInTheDocument();
    expect(screen.queryByText('Run it yourself')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/install\s*\|\s*sh|install\.ps1/);
  });
});
