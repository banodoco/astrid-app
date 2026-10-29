// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionFor, CONNECTED_REALM } from './connectionFixture.ts';

const { connectionRef } = vi.hoisted(() => ({ connectionRef: { current: null as unknown } }));
vi.mock('@/integrations/runtime/client.ts', () => ({
  AstridRuntimeClient: class {
    readInstallerUpdateHealth = async () => ({ status: 'ok', release: 3, identity: { release: 3, managed_by: null } });
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
import { RuntimeConnectionPill } from './RuntimeConnectionPill.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('required update on the connected page', () => {
  it('shows the Update Astrid card and the header dot without opening Settings', async () => {
    connectionRef.current = connectionFor({ status: 'connected', realm: CONNECTED_REALM }, { managedByPinokio: false });
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input === '/build.json') return json({ app: 'app-a', release: 5 })();
      if (input === '/install-manifest.json') return json({ release: 5, required: { release: 5, reason: 'security fix' } })();
      throw new Error(`unexpected fetch ${input}`);
    }));
    const healthFetch = vi.fn(async (_input: string, _init?: RequestInit) => json({ status: 'ok', runtime_instance_id: 'instance-1' })());

    render(
      <>
        <RuntimeConnectionPill connection={connectionRef.current as never} fetchImpl={healthFetch} restartCheckIntervalMs={5} />
        <AppHeader />
      </>,
    );

    const card = await waitFor(() => screen.getByTestId('quiet-update-notice'));
    expect(within(card).getByText('Update Astrid')).toBeVisible();
    expect(card).toHaveTextContent('This update is required: security fix');
    expect(within(card).getByText('Copy for your agent')).toBeVisible();
    expect(within(card).getByText('Run it yourself')).toBeVisible();
    expect(screen.getByTestId('settings-update-indicator')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
