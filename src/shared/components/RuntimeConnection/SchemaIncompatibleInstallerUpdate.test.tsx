// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://astrid.haus/"}
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor as waitForAssertion } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/shared/contexts/AuthContext.tsx';
import { AuthGate } from '@/shared/auth/components/AuthGate.tsx';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { RuntimeConnectionPanel } from './RuntimeConnectionPanel.tsx';
import { setRuntimeOrigin } from '@/integrations/runtime/connection.ts';
import { AstridUpdatesSection } from '@/shared/components/SettingsModal/sections/AstridUpdatesSection.tsx';

// Provider boot and the real recovery card render alongside the rest of the
// focused suite. Await their observable transitions rather than relying on
// Testing Library's short default deadline or an initial fallback render.
const waitFor = <T,>(assertion: () => T | Promise<T>) => waitForAssertion(assertion, { timeout: 10_000 });

function RealGatePanel() {
  const auth = useAuth();
  const connection = useRuntimeConnection();
  return <>
    <output data-testid="auth-state">{String(auth.isAuthenticated)}</output>
    <output data-testid="connection-auth-state">{String(connection.isAuthenticated)}</output>
    <RuntimeConnectionPanel connection={connection} />
    <AstridUpdatesSection isOpen />
  </>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  [3, 'update', true, 200, 200],
  [5, 'newer', true, 200, 200],
  [5, 'newer', false, 404, 200],
  [3, 'fallback', false, 200, 200],
  [3, 'fallback', false, 404, 200],
  [3, 'denied', false, 401, 200],
  [3, 'unauthenticated', false, 401, 401],
] as const)('reads incompatible release %i (%s, capability %s, status HTTP %i, health HTTP %i)', async (release, expected, capability, statusCode, healthStatus) => {
  setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: 'http://127.0.0.1:17340' });
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  const permissionStatus = { state: 'granted', onchange: null as ((this: unknown, event: Event) => unknown) | null };
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn(async () => permissionStatus) },
  });
  const requests: Array<{ url: string; method: string; body: BodyInit | null | undefined }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body });
    let body: unknown = {};
    let status = 200;
    if (url.endsWith('/v1/health')) {
      body = {
        status: 'ok', protocol: 'workspace.v1', schema_digest: 'incompatible-schema',
        runtime_epoch: 1, runtime_session_id: 'session', runtime_instance_id: 'instance',
        identity: { managed_by: null, release }, release,
      };
      status = healthStatus;
    } else if (url.endsWith('/v1/update/status')) {
      body = statusCode === 401
        ? { code: 'unauthorized', message: 'Update status access denied.' }
        : statusCode === 404
          ? { code: 'not_found', message: 'Installer status route is not available.' }
          : { available: capability, state: 'none' };
      status = statusCode;
    } else if (url.endsWith('/v1/update') && method === 'POST') {
      status = 202;
      body = { accepted: true, state: 'accepted', operation_id: '0123456789abcdef0123456789abcdef', message: 'Update accepted.' };
    } else if (url === '/build.json') {
      body = { app: 'served', release: 4 };
    } else if (url === '/install-manifest.json') {
      body = { release: 4 };
    } else if (url.endsWith('/v1/realm')) {
      body = { realm_id: 'realm', display_name: 'Workspace' };
    } else {
      status = 404;
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);

  render(<MemoryRouter><AuthProvider><AuthGate><RealGatePanel /></AuthGate></AuthProvider></MemoryRouter>);

  if (expected === 'update') {
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Update now' })).toHaveLength(2));
    expect(screen.getByTestId('auth-state')).toHaveTextContent('true');
    expect(screen.getByTestId('connection-auth-state')).toHaveTextContent('true');
    expect(screen.getAllByRole('button', { name: 'Copy for your agent' }).length).toBeGreaterThan(0);
    expect(requests.some((request) => request.url.endsWith('/v1/realm'))).toBe(false);
    expect(requests.filter((request) => request.url.endsWith('/v1/update') && request.method === 'POST')).toHaveLength(0);
    expect(requests.some((request) => request.url.endsWith('/v1/update/status'))).toBe(true);

    await act(async () => { fireEvent.focus(window); });
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/v1/update/status')).length).toBeGreaterThan(1));
    expect(requests.filter((request) => request.url.endsWith('/v1/update') && request.method === 'POST')).toHaveLength(0);

    const readsBeforePoll = requests.filter((request) => request.url.endsWith('/v1/update/status')).length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3100)); });
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/v1/update/status')).length).toBeGreaterThan(readsBeforePoll));
    expect(requests.filter((request) => request.url.endsWith('/v1/update') && request.method === 'POST')).toHaveLength(0);

    const readsBeforePermissionReset = requests.filter((request) => request.url.endsWith('/v1/update/status')).length;
    await act(async () => {
      permissionStatus.state = 'denied';
      permissionStatus.onchange?.call(permissionStatus, new Event('change'));
    });
    await waitFor(() => expect(screen.getByTestId('connection-auth-state')).toHaveTextContent('false'));
    await act(async () => { fireEvent.focus(window); });
    expect(requests.filter((request) => request.url.endsWith('/v1/update/status'))).toHaveLength(readsBeforePermissionReset);
    await act(async () => {
      permissionStatus.state = 'granted';
      permissionStatus.onchange?.call(permissionStatus, new Event('change'));
    });
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/v1/update/status')).length).toBeGreaterThan(readsBeforePermissionReset));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Update now' })).toHaveLength(2));
    expect(requests.filter((request) => request.url.endsWith('/v1/update') && request.method === 'POST')).toHaveLength(0);

    fireEvent.click(screen.getAllByRole('button', { name: 'Update now' })[0]!);
    await screen.findByText('Update accepted.');
    const posts = requests.filter((request) => request.url.endsWith('/v1/update') && request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toBeUndefined();
  } else if (expected === 'newer') {
    expect(await screen.findByRole('heading', { name: 'Astrid on this computer is newer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(requests.some((request) => request.url.endsWith('/v1/update/status'))).toBe(true);
    expect(requests.filter((request) => request.url.endsWith('/v1/update') && request.method === 'POST')).toHaveLength(0);
  } else if (expected === 'unauthenticated') {
    await waitFor(() => expect(screen.getByTestId('auth-state')).toHaveTextContent('false'));
    await act(async () => { fireEvent.focus(window); });
    await waitFor(() => expect(screen.getByRole('heading', { name: "Astrid isn't answering on this computer" })).toBeInTheDocument());
    expect(requests.some((request) => request.url.endsWith('/v1/update/status'))).toBe(false);
    expect(screen.getAllByRole('button', { name: /Copy command/ }).length).toBeGreaterThan(0);
    expect(requests.filter((request) => request.url.endsWith('/v1/update') && request.method === 'POST')).toHaveLength(0);
  } else {
    expect(await screen.findByRole('heading', { name: 'Update Astrid' })).toBeInTheDocument();
    await waitFor(() => expect(requests.some((request) => request.url.endsWith('/v1/update/status'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy for your agent' }).length).toBeGreaterThan(0);
    expect(requests.some((request) => request.url.endsWith('/v1/update/status'))).toBe(true);
    expect(requests.filter((request) => request.url.endsWith('/v1/update') && request.method === 'POST')).toHaveLength(0);
  }
});
