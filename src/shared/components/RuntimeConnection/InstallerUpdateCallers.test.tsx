// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { agentSessionQueryKey } from '@/tools/video-editor/hooks/useAgentSession.ts';

const harness = vi.hoisted(() => ({
  auth: { isAuthenticated: true },
  connection: { isConnected: true, managedByPinokio: false, state: { status: 'connected' } },
  instance: 'runtime-instance-a',
  manager: null as string | null,
  statusAvailable: true,
  statusState: 'none' as string,
  operationId: null as string | null,
  result: 'Update accepted.',
  outcome: 'updated' as 'updated' | 'rolled_back' | 'failed',
  pageStale: false,
  manifestRequired: false,
  postPending: false,
  releasePost: (() => undefined) as () => void,
}));

vi.mock('@/shared/contexts/AuthContext.tsx', () => ({ useAuthSafe: () => harness.auth }));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({
  useRuntimeConnection: () => harness.connection,
  useRuntimeConnectionSafe: () => harness.connection,
}));
vi.mock('@/integrations/runtime/connection.ts', () => ({
  runtimeOrigin: () => 'https://astrid.test',
  runtimeApiBase: () => 'https://astrid.test/api/runtime',
}));
vi.mock('@/shared/components/RuntimeConnection/AppBuildProvider.tsx', () => ({ usePageStale: () => harness.pageStale }));

import { AstridUpdatesSection } from '@/shared/components/SettingsModal/sections/AstridUpdatesSection.tsx';
import { QuietUpdateNotice } from './QuietUpdateNotice.tsx';
import { RuntimeConnectorRecoveryBanner } from './RuntimeConnectorRecoveryBanner.tsx';
import { RuntimeCompatibilityError } from '@/integrations/runtime/client.ts';
import { RuntimeUnavailableError } from '@/integrations/runtime/client.ts';
import { RuntimeConnectionPanel } from './RuntimeConnectionPanel.tsx';
import { connectionFor } from './connectionFixture.ts';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { registerDraftSafeReloadGuard } from '@/shared/lib/updates/draftSafeReload.ts';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';

const connection = () => ({ isConnected: true, managedByPinokio: false } as RuntimeConnectionValue);
const calls = () => vi.mocked(fetch).mock.calls.map(([input, init]) => ({ url: String(input), method: init?.method ?? 'GET', body: init?.body }));

beforeEach(() => {
  harness.auth = { isAuthenticated: true };
  harness.connection = { isConnected: true, managedByPinokio: false, state: { status: 'connected' } };
  harness.instance = 'runtime-instance-a';
  harness.manager = null;
  harness.statusAvailable = true;
  harness.statusState = 'none';
  harness.operationId = null;
  harness.result = 'Update accepted.';
  harness.outcome = 'updated';
  harness.pageStale = false;
  harness.manifestRequired = false;
  harness.postPending = false;
  harness.releasePost = () => undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (url.endsWith('/v1/health')) {
      body = {
        status: 'ok', protocol: 'workspace.v1', schema_digest: 'schema-test',
        runtime_instance_id: harness.instance, runtime_session_id: 'session-a', runtime_epoch: 1,
        release: 3, identity: { managed_by: harness.manager, release: 3 },
      };
    } else if (url.endsWith('/v1/update/status')) {
      body = {
        available: harness.statusAvailable, state: harness.statusState,
        ...(harness.operationId ? { operation_id: harness.operationId, result: harness.result } : {}),
        ...(harness.statusState === 'terminal' ? { outcome: harness.outcome } : {}),
      };
    } else if (url.endsWith('/v1/update') && method === 'POST') {
      if (harness.postPending) await new Promise<void>((resolve) => { harness.releasePost = resolve; });
      harness.operationId = '0123456789abcdef0123456789abcdef';
      harness.statusState = 'active';
      body = { accepted: true, state: 'accepted', operation_id: '0123456789abcdef0123456789abcdef', message: 'Update accepted.' };
    } else if (url === '/build.json') {
      body = { app: 'served-build', release: 4 };
    } else if (url === '/install-manifest.json') {
      body = { release: 4, ...(harness.manifestRequired ? { required: { release: 4, reason: 'Security fix' } } : {}) };
    } else if (url.includes('/v1/diagnostics')) {
      body = { report: 'Last update result: none\nInstaller transaction log:\n\nRetained back-end copies: 0 bytes' };
    } else {
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(body), {
      status: url.endsWith('/v1/update') && method === 'POST' ? 202 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('installer update callers', () => {
  it('requires a newly saved click after each lost continuation acknowledgement', async () => {
    const id = '0123456789abcdef0123456789abcdef';
    harness.statusState = 'recovery-needed';
    harness.operationId = id;
    let releaseOld!: () => void;
    const oldSave = new Promise<void>((resolve) => { releaseOld = resolve; });
    const events: string[] = [];
    let saves = 0;
    const unregister = registerDraftSafeReloadGuard({ label: 'draft', isDirty: () => false, flush: async () => {
      const save = ++saves;
      events.push(`save-${save}-start`);
      if (save === 1) await oldSave;
      events.push(`save-${save}-done`);
    } });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/update') && init?.method === 'POST') {
        events.push('post');
        throw new TypeError('lost continuation acknowledgement');
      }
      return original(input, init);
    }));
    function Surface() {
      const operation = useInstallerUpdate(connection());
      return <UpdateResolutionActions resolution={resolveUpdate({ installType: 'installer', updateReason: 'recovery-needed', updateNowAvailable: true })} operation={operation} />;
    }
    const posts = () => calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST');
    try {
      render(<><Surface /><Surface /></>);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Update' })).toHaveLength(2));
      fireEvent.click(screen.getAllByRole('button', { name: 'Update' })[0]);
      await waitFor(() => expect(events).toContain('save-1-start'));
      fireEvent.click(screen.getAllByRole('button', { name: 'Update' })[1]);
      await waitFor(() => expect(posts()).toHaveLength(1));
      await waitFor(() => expect(screen.getAllByText('Astrid needs recovery. Select Update to check the previous operation before continuing.').length).toBeGreaterThan(0));
      await act(async () => { releaseOld(); await oldSave; });
      await act(async () => { fireEvent.focus(window); });
      expect(posts()).toHaveLength(1);
      expect(events.indexOf('save-2-done')).toBeLessThan(events.indexOf('post'));
      fireEvent.click(screen.getAllByRole('button', { name: 'Update' })[0]);
      await waitFor(() => expect(posts()).toHaveLength(2));
      await waitFor(() => expect(screen.getAllByText('Astrid needs recovery. Select Update to check the previous operation before continuing.').length).toBeGreaterThan(0));
      await act(async () => { fireEvent.focus(window); });
      expect(posts()).toHaveLength(2);
      expect(events).toEqual(['save-1-start', 'save-2-start', 'save-2-done', 'post', 'save-1-done', 'save-3-start', 'save-3-done', 'post']);
      expect(harness.operationId).toBe(id);
      expect(posts().every((post) => post.body === undefined)).toBe(true);
    } finally {
      unregister();
    }
  });

  it('removes execution after permission/auth loss and keeps both command options', async () => {
    const view = render(<AstridUpdatesSection isOpen />);
    const staleButton = await screen.findByRole('button', { name: 'Update now' });
    harness.auth = { isAuthenticated: false };
    harness.connection = { isConnected: false, managedByPinokio: false, state: { status: 'blocked' } };
    view.rerender(<AstridUpdatesSection isOpen />);
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
    expect(screen.getByText('Run it yourself')).toBeInTheDocument();
    fireEvent.click(staleButton);
    await act(async () => { fireEvent.focus(window); });
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(0);
  });

  it('keeps both command options on an older Runtime without the F1 route', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/update/status')) return new Response('{}', { status: 404 });
      return original(input, init);
    }));
    render(<AstridUpdatesSection isOpen />);
    await screen.findByRole('button', { name: 'Copy for your agent' });
    expect(screen.getByText('Run it yourself')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(0);
  });

  it('shares status reads across the quiet notice and Settings, and sends one empty POST for Update now', async () => {
    render(<>
      <QuietUpdateNotice connection={connection()} />
      <AstridUpdatesSection isOpen />
    </>);

    await screen.findAllByText('Update available · Release 4');
    const statusReads = calls().filter((call) => call.url.endsWith('/v1/update/status'));
    expect(statusReads.length).toBeGreaterThan(0);
    expect(statusReads.every((call) => call.method === 'GET')).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Copy for your agent' }).length).toBeGreaterThan(0);
    const checkForUpdates = await screen.findByRole('button', { name: 'Check for updates' });
    expect(checkForUpdates).toBeEnabled();
    fireEvent.click(checkForUpdates);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled());
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(0);

    const updateNow = (await screen.findAllByRole('button', { name: 'Update now' })).at(-1)!;
    await act(async () => { fireEvent.click(updateNow); });
    await waitFor(() => expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(1));
    const post = calls().find((call) => call.url.endsWith('/v1/update') && call.method === 'POST');
    expect(post?.body).toBeUndefined();
    expect(calls().filter((call) => call.url.endsWith('/v1/update/status')).every((call) => call.method === 'GET')).toBe(true);
  });

  it('deduplicates simultaneous Update now clicks from Settings and the hard recovery card', async () => {
    harness.postPending = true;
    render(<>
      <QuietUpdateNotice connection={connection()} />
      <AstridUpdatesSection isOpen />
      <RuntimeConnectorRecoveryBanner error={new RuntimeCompatibilityError('schema', 'Update required', 'https://astrid.test/api/runtime')} onRetry={vi.fn()} />
      <RuntimeConnectionPanel connection={connectionFor({ status: 'update_needed' })} />
    </>);
    await screen.findAllByRole('button', { name: 'Update now' });
    const actions = screen.getAllByRole('button', { name: 'Update now' });
    expect(actions.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(actions[0]);
    fireEvent.click(actions[1]);
    await waitFor(() => expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(1));
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')[0].body).toBeUndefined();
    await act(async () => { harness.releasePost(); });
  });

  it.each([
    ['updated', 'Astrid updated. Reload to continue.'],
    ['rolled_back', 'The update did not finish. Astrid was restored to its previous version.'],
  ] as const)('refreshes on focus and reconnect, then confirms a matching %s result after remount and instance change', async (outcome, result) => {
    const view = render(<AstridUpdatesSection isOpen />);
    await screen.findByRole('button', { name: 'Update now' });
    const readsBeforeFocus = calls().filter((call) => call.url.endsWith('/v1/update/status')).length;
    await act(async () => { fireEvent.focus(window); });
    await waitFor(() => expect(calls().filter((call) => call.url.endsWith('/v1/update/status')).length).toBeGreaterThan(readsBeforeFocus));

    harness.auth = { isAuthenticated: false };
    harness.auth = { isAuthenticated: false };
    harness.connection = { isConnected: false, managedByPinokio: false, state: { status: 'not_running' } };
    view.rerender(<AstridUpdatesSection isOpen={false} />);
    const readsWhileDisconnected = calls().filter((call) => call.url.endsWith('/v1/update/status')).length;
    harness.auth = { isAuthenticated: true };
    harness.connection = { isConnected: true, managedByPinokio: false, state: { status: 'connected' } };
    view.rerender(<AstridUpdatesSection isOpen />);
    await waitFor(() => expect(calls().filter((call) => call.url.endsWith('/v1/update/status')).length).toBeGreaterThan(readsWhileDisconnected));

    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('Update in progress. Astrid may disconnect while it restarts.')).toBeInTheDocument());
    expect(harness.statusState).toBe('active');
    harness.auth = { isAuthenticated: false };
    harness.connection = { isConnected: false, managedByPinokio: false, state: { status: 'not_running' } };
    view.rerender(<AstridUpdatesSection isOpen={false} />);
    const readsBeforeOfflineFocus = calls().filter((call) => call.url.endsWith('/v1/update/status')).length;
    await act(async () => { fireEvent.focus(window); });
    await waitFor(() => expect(calls().filter((call) => call.url.endsWith('/v1/update/status')).length).toBeGreaterThan(readsBeforeOfflineFocus));
    view.unmount();
    harness.instance = 'runtime-instance-b';
    harness.statusState = 'terminal';
    harness.result = result;
    harness.outcome = outcome;
    harness.auth = { isAuthenticated: true };
    harness.connection = { isConnected: true, managedByPinokio: false, state: { status: 'connected' } };
    render(<AstridUpdatesSection isOpen />);
    await waitFor(() => expect(screen.getByText('Astrid restarted. Reload when your drafts can be saved.')).toBeInTheDocument());
    expect(screen.getAllByText(outcome === 'updated' ? 'Astrid updated. Reload to continue.' : 'The update did not finish. Astrid was restored to its previous version.').length).toBeGreaterThan(0);
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('re-reads the selected Runtime instance after a reconnect', async () => {
    const view = render(<AstridUpdatesSection isOpen />);
    await screen.findByRole('button', { name: 'Update now' });
    const healthReads = () => calls().filter((call) => call.url.endsWith('/v1/health')).length;
    const before = healthReads();
    harness.connection = { isConnected: false, managedByPinokio: false };
    view.rerender(<AstridUpdatesSection isOpen />);
    harness.instance = 'runtime-instance-b';
    harness.connection = { isConnected: true, managedByPinokio: false };
    view.rerender(<AstridUpdatesSection isOpen />);
    await waitFor(() => expect(healthReads()).toBeGreaterThan(before));
  });

  it.each([
    ['unauthenticated', () => { harness.auth = { isAuthenticated: false }; }],
    ['disconnected', () => { harness.connection = { isConnected: false, managedByPinokio: false }; }],
    ['Pinokio managed', () => { harness.connection = { isConnected: true, managedByPinokio: true }; }],
    ['source managed', () => { harness.manager = 'source'; }],
    ['launcher unavailable', () => { harness.statusAvailable = false; }],
    ['recovery required', () => {
      harness.statusState = 'recovery-needed';
      harness.operationId = '0123456789abcdef0123456789abcdef';
    }],
  ])('respects installer action availability and explicit recovery Update when %s', async (_label, configure) => {
    configure();
    render(<AstridUpdatesSection isOpen />);
    await screen.findByRole('button', { name: 'Check for updates' });
    if (_label === 'disconnected') await screen.findByText('Connect to Astrid before checking its release.');
    else if (_label === 'source managed') {
      // A source checkout has no release to install: the status line follows the resolver, which has no update to offer.
      await screen.findAllByText('Astrid is up to date');
      expect(screen.queryByText(/Update available/)).not.toBeInTheDocument();
    } else if (_label === 'recovery required') {
      const recoveryCopy = 'Astrid needs recovery. Select Update to check the previous operation before continuing.';
      await screen.findAllByText(recoveryCopy);
      const update = screen.getByRole('button', { name: 'Update', exact: true });
      expect(update).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Update anyway' })).not.toBeInTheDocument();
      expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(0);
      fireEvent.click(update);
      await waitFor(() => expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(1));
    }
    else await screen.findAllByText('Update available · Release 4');
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    const postCount = calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST').length;
    expect(postCount).toBe(_label === 'recovery required' ? 1 : 0);
  });

  it('keeps page-stale reload precedence over the available installer update', async () => {
    harness.pageStale = true;
    render(<RuntimeConnectorRecoveryBanner error={new RuntimeCompatibilityError('schema', 'Schema is unsupported', 'https://astrid.test/api/runtime')} onRetry={vi.fn()} />);
    await screen.findByRole('button', { name: 'Reload' });
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(0);
  });

  it('uses Reload in Updates Settings when the page is stale', async () => {
    harness.pageStale = true;
    render(<AstridUpdatesSection isOpen />);
    await screen.findByRole('button', { name: 'Reload' });
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(0);
  });

  it('shows a required reason through a connected recovery caller and keeps newer-than-served precedence', async () => {
    harness.manifestRequired = true;
    const recoveryError = new Error('Workspace discovery failed');
    render(<RuntimeConnectorRecoveryBanner error={recoveryError} onRetry={vi.fn()} />);
    await screen.findByText(/This update is required: Security fix/);
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/health')) return new Response(JSON.stringify({
        status: 'ok', protocol: 'workspace.v1', schema_digest: 'schema-test', runtime_instance_id: harness.instance,
        runtime_session_id: 'session-a', runtime_epoch: 1, release: 5, identity: { managed_by: null, release: 5 },
      }), { status: 200 });
      if (url.endsWith('/v1/update/status')) return new Response(JSON.stringify({ available: true, state: 'none' }), { status: 200 });
      if (url === '/build.json') return new Response(JSON.stringify({ app: 'served-build', release: 4 }), { status: 200 });
      if (url === '/install-manifest.json') return new Response(JSON.stringify({ release: 4 }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    render(<RuntimeConnectorRecoveryBanner error={recoveryError} onRetry={vi.fn()} />);
    await screen.findByText(/newer than astrid\.haus/);
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(0);
  });

  it('keeps Runtime-unreachable precedence over cached required and page-stale state', async () => {
    harness.manifestRequired = true;
    const view = render(<AstridUpdatesSection isOpen />);
    await screen.findByRole('button', { name: 'Update now' });
    harness.pageStale = true;
    view.rerender(<RuntimeConnectorRecoveryBanner error={new RuntimeUnavailableError(new Error('unreachable'), 'https://astrid.test/api/runtime')} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    expect(calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST')).toHaveLength(0);
  });

  it('keeps status failures visible and does not turn them into an update action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/update/status')) return new Response('offline', { status: 503 });
      if (url.endsWith('/v1/health')) return new Response(JSON.stringify({
        status: 'ok', protocol: 'workspace.v1', schema_digest: 'schema-test',
        runtime_instance_id: harness.instance, runtime_session_id: 'session-a', runtime_epoch: 1,
        release: 3, identity: { managed_by: null, release: 3 },
      }), { status: 200 });
      if (url === '/build.json') return new Response(JSON.stringify({ app: 'served-build', release: 4 }), { status: 200 });
      if (url === '/install-manifest.json') return new Response(JSON.stringify({ release: 4 }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    render(<AstridUpdatesSection isOpen />);
    await screen.findAllByText('Update available · Release 4');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  });
});

describe('installer update while an agent turn runs', () => {
  const TURN_WARNING = 'An agent turn is running; updating will interrupt it';
  const postCount = () => calls().filter((call) => call.url.endsWith('/v1/update') && call.method === 'POST').length;
  const renderWithSession = (status: 'processing' | 'waiting_user') => {
    const client = new QueryClient();
    client.setQueryData(agentSessionQueryKey('session-1', 'project-1'), { id: 'session-1', status, turns: [], taskLinks: [] });
    return render(<QueryClientProvider client={client}><AstridUpdatesSection isOpen /></QueryClientProvider>);
  };

  it('sends Update now without a dialog when no agent turn is running', async () => {
    renderWithSession('waiting_user');
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(postCount()).toBe(1));
    expect(screen.queryByText(TURN_WARNING)).not.toBeInTheDocument();
  });

  it('sends Update now directly without an agent-turn confirmation', async () => {
    renderWithSession('processing');
    const updateNow = await screen.findByRole('button', { name: 'Update now' });
    expect(screen.queryByText(TURN_WARNING)).not.toBeInTheDocument();
    fireEvent.click(updateNow);
    await waitFor(() => expect(postCount()).toBe(1));
    expect(screen.queryByText(TURN_WARNING)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update anyway' })).not.toBeInTheDocument();
  });

  it('does not automatically post or expose legacy agent-turn controls', async () => {
    renderWithSession('processing');
    await screen.findByRole('button', { name: 'Update now' });
    expect(screen.queryByText(TURN_WARNING)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wait' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update anyway' })).not.toBeInTheDocument();
    expect(postCount()).toBe(0);
  });

  it('uses the normal Update action instead of an Update anyway bypass', async () => {
    renderWithSession('processing');
    const updateNow = await screen.findByRole('button', { name: 'Update now' });
    expect(screen.queryByRole('button', { name: 'Update anyway' })).not.toBeInTheDocument();
    fireEvent.click(updateNow);
    await waitFor(() => expect(postCount()).toBe(1));
    expect(screen.queryByText(TURN_WARNING)).not.toBeInTheDocument();
  });
});
