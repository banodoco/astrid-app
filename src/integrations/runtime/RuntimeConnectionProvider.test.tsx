// @vitest-environment jsdom
import React from 'react';
import { flushSync } from 'react-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeConnectionGate,
  RuntimeConnectionProvider,
  useRuntimeConnection,
  PROBE_TIMEOUT_MS,
  SLOW_PROBE_TIMEOUT_MS,
  type RuntimeConnectionPanelExit,
  type RuntimeConnectionValue,
} from './RuntimeConnectionProvider.tsx';
import type { PermissionsLike } from './localNetworkPermission.ts';
import { autoConnectRequested, requestAutoConnect } from './autoConnectRequest.ts';
import { RuntimeConnectionPanel } from '@/shared/components/RuntimeConnection/RuntimeConnectionPanel.tsx';
import { RUNTIME_CONNECTION_COPY as CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS, RUNTIME_SCHEMA_DIGEST } from './contract-metadata.ts';

const REALM = { realm_id: 'realm-1', display_name: 'Direct Journey' };
const STORAGE_KEY = 'astrid.runtime.connectedBefore';
const PINOKIO_STORAGE_KEY = 'astrid.runtime.managedByPinokio';

type Route = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch whose answers can be swapped between probes; records every URL it was asked for. */
function fakeGateway() {
  const calls: string[] = [];
  const routes: Record<string, Route> = {
    '/v1/health': () => json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST }),
    '/v1/realm': () => json(REALM),
  };
  /** The door answers every request but refuses this page's origin: a CORS read fails, a `no-cors` request still resolves (opaque). */
  let refusing = false;
  const noCorsCalls: string[] = [];
  /** Counts the CORS reads only; the `no-cors` follow-up that tells a refusal from a closed port is tracked in `noCorsCalls`. */
  const cors = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const path = Object.keys(routes).find((candidate) => url.endsWith(candidate));
    if (!path) throw new Error(`unexpected request ${url}`);
    return routes[path]!();
  }) as unknown as typeof fetch;
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.mode !== 'no-cors') return cors(input);
    noCorsCalls.push(String(input));
    if (refusing) return Promise.resolve(new Response(null, { status: 200 }));
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  const down = () => {
    routes['/v1/health'] = () => {
      throw new TypeError('Failed to fetch');
    };
  };
  const refuse = () => {
    refusing = true;
    down();
  };
  const up = () => {
    refusing = false;
    routes['/v1/health'] = () => json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST });
  };
  const gatewayDown = (error: string, status = 503) => {
    routes['/v1/health'] = () => json({ error }, status);
  };
  return { calls, noCorsCalls, cors, fetchImpl, routes, down, refuse, up, gatewayDown };
}

/** `counted` sees only CORS reads; a `no-cors` follow-up (the refusal check) fails as a closed port would, uncounted. */
function corsOnly(counted: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => init?.mode === 'no-cors'
    ? Promise.reject(new TypeError('Failed to fetch'))
    : counted(input, init)) as typeof fetch;
}

/** Flush React's queued work without tying the test to the probe's internal promise chain. */
async function flushReactWork() {
  await act(async () => {});
}

function fakePermissions(initial: string) {
  const status: { state: string; onchange: ((this: unknown, event: Event) => unknown) | null } = { state: initial, onchange: null };
  const permissions: PermissionsLike = { query: vi.fn(async () => status) };
  return {
    permissions,
    status,
    change(next: string) {
      status.state = next;
      status.onchange?.call(status, new Event('change'));
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function captureProbeTimeouts() {
  const expirations: (() => void)[] = [];
  const waitingLines: (() => void)[] = [];
  const realSetTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === PROBE_TIMEOUT_MS) {
      expirations.push(() => typeof handler === 'function' ? handler(...args) : undefined);
      return 0;
    }
    if (ms === 1000) {
      waitingLines.push(() => typeof handler === 'function' ? handler(...args) : undefined);
      return 0;
    }
    return realSetTimeout(handler, ms, ...args);
  }) as typeof window.setTimeout);
  return { expirations, showWaitingLine: () => waitingLines[0]?.() };
}

let latest: RuntimeConnectionValue;
function Probe() {
  latest = useRuntimeConnection();
  return <span data-testid="status">{latest.state.status}</span>;
}

function PanelProbe() {
  latest = useRuntimeConnection();
  return <>
    <RuntimeConnectionPanel connection={latest} />
    <span data-testid="status">{latest.state.status}</span>
  </>;
}

function RecordingPanelProbe({ values }: { values: RuntimeConnectionValue[] }) {
  const connection = useRuntimeConnection();
  latest = connection;
  values.push(connection);
  return <>
    <RuntimeConnectionPanel connection={connection} />
    <span data-testid="status">{connection.state.status}</span>
  </>;
}

function RecordingProbe({ states }: { states: RuntimeConnectionValue['state'][] }) {
  const connection = useRuntimeConnection();
  latest = connection;
  states.push(connection.state);
  return <span data-testid="status">{connection.state.status}</span>;
}

function renderProvider(
  gateway: ReturnType<typeof fakeGateway>,
  permissions: PermissionsLike | undefined,
  props: Partial<React.ComponentProps<typeof RuntimeConnectionProvider>> = {},
) {
  return render(
    <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={permissions} pollIntervalMs={10} {...props}>
      <Probe />
    </RuntimeConnectionProvider>,
  );
}

function renderPanelProvider(
  gateway: ReturnType<typeof fakeGateway>,
  permissions: PermissionsLike | undefined,
  props: Partial<React.ComponentProps<typeof RuntimeConnectionProvider>> = {},
) {
  return render(
    <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={permissions} pollIntervalMs={10} {...props}>
      <PanelProbe />
    </RuntimeConnectionProvider>,
  );
}

const status = () => screen.getByTestId('status').textContent;

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  window.history.replaceState({}, '', '/tools/video-editor');
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const GATEWAY = 'http://127.0.0.1:17340';

/**
 * The Runtime origin is set once per module instance (`setRuntimeOrigin`), so each path loads fresh copies of the
 * connection and provider modules. `null` is the same-origin proxy path; a gateway origin is the door path.
 */
async function loadProviderFor(origin: string | null) {
  vi.resetModules();
  const connection = await import('@/integrations/runtime/connection.ts');
  connection.setRuntimeOrigin(origin ? { VITE_RUNTIME_ORIGIN: origin } : {});
  return import('./RuntimeConnectionProvider.tsx');
}

describe.each([
  ['proxy path (same origin)', null],
  ['door path (gateway origin)', GATEWAY],
] as const)('Pinokio identity over the %s', (_label, origin) => {
  it('recognises a Pinokio Runtime from identity.managed_by, connects, and reads the health it was asked on that path', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, identity: { managed_by: 'pinokio', release: 4 } });
    const { RuntimeConnectionProvider: Provider, useRuntimeConnection: useConnection } = await loadProviderFor(origin);
    const values: RuntimeConnectionValue[] = [];
    function Watch() {
      const connection = useConnection();
      values.push(connection);
      return <span data-testid="status">{connection.state.status}</span>;
    }
    render(
      <Provider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <Watch />
      </Provider>,
    );
    await waitFor(() => expect(status()).toBe('connected'));
    expect(values.at(-1)?.state).toMatchObject({ status: 'connected', managedByPinokio: true });
    expect(values.at(-1)?.managedByPinokio).toBe(true);
    expect(window.localStorage.getItem(PINOKIO_STORAGE_KEY)).toBe('1');
    expect(gateway.calls).toEqual([`${origin ?? ''}/api/runtime/v1/health`, `${origin ?? ''}/api/runtime/v1/realm`]);
  });

  it('carries the installed release from the health identity, so the pack re-poll key can tell releases apart', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, identity: { managed_by: 'pinokio', release: 12 } });
    const { RuntimeConnectionProvider: Provider, useRuntimeConnection: useConnection } = await loadProviderFor(origin);
    const values: RuntimeConnectionValue[] = [];
    function Watch() {
      const connection = useConnection();
      values.push(connection);
      return <span data-testid="status">{connection.state.status}</span>;
    }
    render(
      <Provider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <Watch />
      </Provider>,
    );
    await waitFor(() => expect(status()).toBe('connected'));
    expect(values.at(-1)?.runtimeRelease).toBe(12);
    expect(values.at(-1)?.schemaDigest).toBe(RUNTIME_SCHEMA_DIGEST);
  });

  it('shows the Pinokio update sentence and no installer command for an incompatible Pinokio Runtime', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', schema_digest: 'sha256:old-runtime', identity: { managed_by: 'pinokio' } });
    const { RuntimeConnectionProvider: Provider, useRuntimeConnection: useConnection } = await loadProviderFor(origin);
    function Watch() {
      const connection = useConnection();
      return <>
        <RuntimeConnectionPanel connection={connection} />
        <span data-testid="status">{connection.state.status}</span>
      </>;
    }
    render(
      <Provider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={600_000}>
        <Watch />
      </Provider>,
    );
    await waitFor(() => expect(status()).toBe('update_needed'));
    expect(await screen.findByText(CONNECTION_COPY.updateNeeded.pinokioSentence)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy command/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('astrid.haus/install');
  });
});

describe('granted', () => {
  it.each(RUNTIME_ACCEPTED_SCHEMA_DIGESTS)('connects to the compatible Runtime contract %s', async (digest) => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', schema_digest: digest });
    renderProvider(gateway, fakePermissions('granted').permissions);
    await waitFor(() => expect(status()).toBe('connected'));
    expect(latest.realmName).toBe(REALM.display_name);
  });

  it('probes health then realm at once and connects, exposing the realm name', async () => {
    const gateway = fakeGateway();
    const onConnected = vi.fn();
    renderProvider(gateway, fakePermissions('granted').permissions, { onConnected });

    await waitFor(() => expect(status()).toBe('connected'));
    expect(latest.state).toEqual({ status: 'connected', realm: REALM });
    expect(latest.realmName).toBe('Direct Journey');
    expect(latest.schemaDigest).toBe(RUNTIME_SCHEMA_DIGEST);
    expect(latest.isBooting).toBe(false);
    expect(gateway.calls.map((url) => url.replace(/^.*\/api\/runtime/, ''))).toEqual(['/v1/health', '/v1/realm']);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('records Pinokio provenance from health and exposes it in the connected state', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, identity: { managed_by: 'pinokio' } });
    renderProvider(gateway, fakePermissions('granted').permissions);
    await waitFor(() => expect(status()).toBe('connected'));
    expect(latest.state).toMatchObject({ status: 'connected', managedByPinokio: true });
    expect(window.localStorage.getItem(PINOKIO_STORAGE_KEY)).toBe('1');
  });

  it.each([
    ['managed by Pinokio', { identity: { managed_by: 'pinokio' } }, true],
    ['managed by a native installer', { identity: { managed_by: null, release: 3 } }, false],
    ['managed from source', { identity: { managed_by: 'source', release: 0 } }, false],
    ['not managed by Pinokio', {}, false],
    ['still reporting only the retired install field', { install: { managed_by: 'pinokio' } }, false],
  ] as const)('records health evidence when Runtime is %s', async (_label, healthEvidence, expected) => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', schema_digest: RUNTIME_SCHEMA_DIGEST, ...healthEvidence });
    renderProvider(gateway, fakePermissions('granted').permissions);
    await waitFor(() => expect(status()).toBe('connected'));
    expect(latest.managedByPinokio).toBe(expected);
    expect(window.localStorage.getItem(PINOKIO_STORAGE_KEY)).toBe(expected ? '1' : '0');
  });

  it('uses Pinokio update instructions when an incompatible Runtime reports Pinokio', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', schema_digest: 'sha256:old-runtime', identity: { managed_by: 'pinokio' } });
    // Simulate a changed install: this browser last saw a non-Pinokio Runtime.
    window.localStorage.setItem(PINOKIO_STORAGE_KEY, '0');
    const values: RuntimeConnectionValue[] = [];
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={600_000}>
        <RecordingPanelProbe values={values} />
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(status()).toBe('update_needed'));
    expect(values.find((value) => value.state.status === 'update_needed')?.managedByPinokio).toBe(true);
    expect(await screen.findByText(CONNECTION_COPY.updateNeeded.pinokioSentence)).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(PINOKIO_STORAGE_KEY)).toBe('1'));
    expect(screen.queryByRole('button', { name: /Copy command/ })).not.toBeInTheDocument();
  });

  it.each([false, true])('keeps the mount-time connection history when a new probe connects (had connected before: %s)', async (hadConnectedBefore) => {
    if (hadConnectedBefore) window.localStorage.setItem(STORAGE_KEY, '1');
    const gateway = fakeGateway();
    renderProvider(gateway, fakePermissions('granted').permissions);

    await waitFor(() => expect(status()).toBe('connected'));
    expect(latest.connectedBefore).toBe(hadConnectedBefore);
  });

  it.each([
    ['unknown', 'sha256:unknown'],
    ['missing', undefined],
  ])('shows update_needed for a %s health digest', async (_name, digest) => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', ...(digest === undefined ? {} : { schema_digest: digest }) });
    // Keep the first admission probe separate from the provider's background health poll.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let view: ReturnType<typeof renderProvider> | undefined;
    try {
      view = renderProvider(gateway, fakePermissions('granted').permissions);
      await waitFor(() => expect(status()).toBe('update_needed'));
      expect(gateway.calls.map((url) => url.replace(/^.*\/api\/runtime/, ''))).toEqual(['/v1/health']);

      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(status()).toBe('update_needed');
      expect(gateway.calls.map((url) => url.replace(/^.*\/api\/runtime/, ''))).toEqual(['/v1/health', '/v1/health']);
    } finally {
      view?.unmount();
      vi.useRealTimers();
    }
  });

  it('keeps bounded update health polling and connects when Runtime becomes compatible', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', schema_digest: 'sha256:old-runtime' });
    const POLL_MS = 456_789;
    let tick: () => void = () => {};
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms !== POLL_MS) return realSetInterval(handler, ms, ...args);
      tick = () => (handler as () => void)();
      return realSetInterval(() => {}, ms);
    }) as typeof window.setInterval);

    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: POLL_MS });
    await waitFor(() => expect(status()).toBe('update_needed'));
    expect(gateway.calls.map((url) => url.replace(/^.*\/api\/runtime/, ''))).toEqual(['/v1/health']);

    // The long interval has not been ticked, so there is no immediate retry loop.
    expect(status()).toBe('update_needed');
    expect(gateway.calls).toHaveLength(1);

    gateway.up();
    await act(async () => { tick(); });
    await waitFor(() => expect(status()).toBe('connected'));
    expect(gateway.calls.map((url) => url.replace(/^.*\/api\/runtime/, ''))).toEqual([
      '/v1/health', '/v1/health', '/v1/realm',
    ]);
  });

  it.each(['focus', 'interval'] as const)('a %s re-check between the probe answering and the connected render starts no second probe', async (trigger) => {
    const gateway = fakeGateway();
    // Plain stub answers: their json() settles in microtasks only, so the test controls exactly where the probe resumes.
    const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    let releaseRealm: (response: Response) => void = () => {};
    gateway.routes['/v1/health'] = () => answer({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST });
    gateway.routes['/v1/realm'] = () => new Promise<Response>((resolve) => { releaseRealm = resolve; });
    // Capture the provider's own poll (recognised by its distinctive period) so the test can fire it by hand.
    const POLL_MS = 123_456;
    let tick: () => void = () => {};
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms !== POLL_MS) return realSetInterval(handler, ms, ...args);
      tick = () => (handler as () => void)();
      return realSetInterval(() => {}, ms);
    }) as typeof window.setInterval);
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: POLL_MS });
    await waitFor(() => expect(gateway.calls).toHaveLength(2));

    // The probe answers. Only microtasks run, so the probe has resumed (and cleared its in-flight guard) while React has
    // not yet rendered the connected outcome, which is the window a slow machine leaves open.
    releaseRealm(answer(REALM));
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
    else tick();

    await waitFor(() => expect(status()).toBe('connected'));
    expect(gateway.calls.map((url) => url.replace(/^.*\/api\/runtime/, ''))).toEqual(['/v1/health', '/v1/realm']);
  });

  it('fresh profile reaches not_running after two granted-permission failures', async () => {
    const gateway = fakeGateway();
    gateway.down();
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    expect(status()).toBe('connecting');
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('not_running'));
    expect(latest.state).toMatchObject({ status: 'not_running' });
    expect(latest.isBooting).toBe(false);
  });

  it('a failed CORS read followed by an opaque no-cors answer reaches refused, not not_running', async () => {
    const gateway = fakeGateway();
    gateway.refuse();
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    expect(status()).toBe('connecting');
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('refused'));
    expect(latest.state).toEqual({ status: 'refused' });
    expect(latest.isBooting).toBe(false);
    // One no-cors request per failed reading, to the same URL the CORS read used, and nothing else.
    expect(gateway.noCorsCalls).toEqual(gateway.calls);
    expect(gateway.calls.every((url) => url.endsWith('/v1/health'))).toBe(true);
  });

  it('a failed CORS read and a failed no-cors follow-up (nothing listening) stays not_running', async () => {
    const gateway = fakeGateway();
    gateway.down();
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('not_running'));
    expect(gateway.noCorsCalls).toHaveLength(2);
  });

  it('keeps polling while refused and connects by itself once the door accepts the page', async () => {
    const gateway = fakeGateway();
    gateway.refuse();
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('refused'));
    gateway.up();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('connected'));
  });

  it('refused after a slow reading and its untimed follow-up both fail the CORS read', async () => {
    const gateway = fakeGateway();
    gateway.refuse();
    let expireProbe: () => void = () => {};
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === PROBE_TIMEOUT_MS) {
        expireProbe = () => typeof handler === 'function' ? handler(...args) : undefined;
        return realSetTimeout(() => {}, ms);
      }
      return realSetTimeout(handler, ms, ...args);
    }) as typeof window.setTimeout);
    let calls = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.mode !== 'no-cors' && calls++ === 0) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return gateway.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    renderProvider({ ...gateway, fetchImpl }, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(calls).toBe(1));
    act(() => expireProbe());
    await waitFor(() => expect(latest.isBooting).toBe(false));
    await waitFor(() => expect(status()).toBe('refused'));
    // The timed-out read never asks the no-cors question: only the follow-up's failure did.
    expect(gateway.noCorsCalls).toHaveLength(1);
  });

  it.each(['prompt', 'denied'] as const)('sends no no-cors probe when permission is %s', async (state) => {
    const gateway = fakeGateway();
    gateway.refuse();
    const permission = fakePermissions(state);
    renderProvider(gateway, permission.permissions, { pollIntervalMs: 10 });
    await waitFor(() => expect(status()).toBe(state === 'denied' ? 'blocked' : 'needs_permission'));
    if (state === 'prompt') {
      // Chrome refuses the explicit Connect probe (the person said no), and the permission is still not granted.
      await act(async () => { latest.connect(); });
      await flushReactWork();
      expect(gateway.cors).toHaveBeenCalledTimes(1);
    }
    expect(gateway.noCorsCalls).toHaveLength(0);
    expect(status()).not.toBe('refused');
  });

  it('a slow reading and its failed follow-up show help without another reading', async () => {
    const gateway = fakeGateway();
    gateway.down();
    let expireProbe: () => void = () => {};
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === PROBE_TIMEOUT_MS) {
        expireProbe = () => typeof handler === 'function' ? handler(...args) : undefined;
        return realSetTimeout(() => {}, ms);
      }
      return realSetTimeout(handler, ms, ...args);
    }) as typeof window.setTimeout);
    let calls = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (calls++ > 0) return gateway.fetchImpl(input);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as unknown as typeof fetch;
    renderProvider({ ...gateway, fetchImpl: corsOnly(fetchImpl) }, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    act(() => expireProbe());
    await waitFor(() => expect(latest.isBooting).toBe(false));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(latest.state.status).toBe('not_running'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds the slow follow-up to 60 seconds, shows help, and lets Try again connect', async () => {
    const timers = new Map<number, () => void>();
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === PROBE_TIMEOUT_MS || ms === SLOW_PROBE_TIMEOUT_MS) {
        timers.set(ms, () => typeof handler === 'function' ? handler(...args) : undefined);
        return 0;
      }
      return realSetTimeout(handler, ms, ...args);
    }) as typeof window.setTimeout);
    const gateway = fakeGateway();
    let stalled = true;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => stalled
      ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
      : gateway.fetchImpl(input)) as unknown as typeof fetch;
    renderPanelProvider({ ...gateway, fetchImpl }, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await act(async () => { timers.get(PROBE_TIMEOUT_MS)!(); });
    expect(latest.state.status).toBe('connecting');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(SLOW_PROBE_TIMEOUT_MS).toBe(60_000);
    await act(async () => { timers.get(SLOW_PROBE_TIMEOUT_MS)!(); });
    expect(latest.state.status).toBe('not_running');
    expect(screen.getByRole('heading', { name: CONNECTION_COPY.notRunning.title })).toBeInTheDocument();
    stalled = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(status()).toBe('connected'));
  });

  it('follows a slow probe with an untimed probe, keeps the waiting state, and connects on its late answer', async () => {
    const { expirations, showWaitingLine } = captureProbeTimeouts();
    let tickInterval: () => void = () => {};
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 600_000) {
        tickInterval = () => typeof handler === 'function' ? handler(...args) : undefined;
        return 0;
      }
      return realSetInterval(handler, ms, ...args);
    }) as typeof window.setInterval);
    const firstStarted = deferred<void>();
    const followupStarted = deferred<AbortSignal | undefined>();
    const realmStarted = deferred<void>();
    const healthAnswer = deferred<Response>();
    const realmAnswer = deferred<Response>();
    let healthCalls = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/health')) {
        if (healthCalls++ === 0) {
          firstStarted.resolve();
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        }
        followupStarted.resolve(init?.signal);
        return healthAnswer.promise;
      }
      realmStarted.resolve();
      return realmAnswer.promise;
    }) as unknown as typeof fetch;
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={600_000}>
        <Probe />
        <RuntimeConnectionGate panel={(connection, exit) => <RuntimeConnectionPanel connection={connection} exit={exit} />}>
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );

    await firstStarted.promise;
    act(() => showWaitingLine());
    expect(screen.getByText(CONNECTION_COPY.connecting.sentence)).toBeInTheDocument();
    expect(expirations).toHaveLength(1);
    let followupSignal: AbortSignal | undefined;
    await act(async () => {
      expirations[0]!();
      followupSignal = await followupStarted.promise;
    });
    await flushReactWork();

    expect(followupSignal?.aborted).toBe(false);
    expect(expirations).toHaveLength(1);
    expect(latest.state).toEqual({ status: 'connecting' });
    expect(latest.isChecking).toBe(true);
    expect(screen.getByText(CONNECTION_COPY.connecting.sentence)).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event('focus'));
      tickInterval();
    });
    await flushReactWork();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await act(async () => {
      healthAnswer.resolve(json({ status: 'ok', schema_digest: RUNTIME_SCHEMA_DIGEST }));
      await realmStarted.promise;
      realmAnswer.resolve(json(REALM));
    });
    expect(latest.state).toEqual({ status: 'connected', realm: REALM });
  });

  it('records an untimed refusal as a failure, then resumes timed probes', async () => {
    const { expirations } = captureProbeTimeouts();
    const firstStarted = deferred<void>();
    const followupStarted = deferred<void>();
    const nextProbeStarted = deferred<void>();
    let healthCalls = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/health')) {
        const call = healthCalls++;
        if (call === 0) {
          firstStarted.resolve();
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        }
        if (call === 1) {
          followupStarted.resolve();
          return Promise.resolve(json({ error: 'runtime_unavailable' }, 503));
        }
        nextProbeStarted.resolve();
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      throw new Error(`unexpected request ${String(input)}`);
    }) as unknown as typeof fetch;
    renderProvider({ ...fakeGateway(), fetchImpl }, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });

    await firstStarted.promise;
    await act(async () => {
      expirations[0]!();
      await followupStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.state).toEqual({ status: 'not_running' });
    expect(expirations).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await nextProbeStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(expirations).toHaveLength(2);
    expect(latest.state).toEqual({ status: 'not_running' });
  });

  it('aborts the untimed slow follow-up when unmounted', async () => {
    const { expirations } = captureProbeTimeouts();
    const firstStarted = deferred<void>();
    const followupStarted = deferred<AbortSignal | undefined>();
    let healthCalls = 0;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (healthCalls++ === 0) {
        firstStarted.resolve();
      } else {
        followupStarted.resolve(init?.signal);
      }
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }) as unknown as typeof fetch;
    const view = renderProvider({ ...fakeGateway(), fetchImpl }, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });

    await firstStarted.promise;
    let followupSignal: AbortSignal | undefined;
    await act(async () => {
      expirations[0]!();
      followupSignal = await followupStarted.promise;
    });
    expect(followupSignal?.aborted).toBe(false);
    act(() => view.unmount());
    expect(followupSignal?.aborted).toBe(true);
  });

  it('lets explicit Connect replace the untimed slow follow-up', async () => {
    const { expirations } = captureProbeTimeouts();
    const firstStarted = deferred<void>();
    const followupStarted = deferred<AbortSignal | undefined>();
    const connectStarted = deferred<void>();
    let healthCalls = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/health')) {
        const call = healthCalls++;
        if (call === 0) firstStarted.resolve();
        if (call === 1) followupStarted.resolve(init?.signal);
        if (call === 2) connectStarted.resolve();
      }
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }) as unknown as typeof fetch;
    renderProvider({ ...fakeGateway(), fetchImpl }, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });

    await firstStarted.promise;
    let followupSignal: AbortSignal | undefined;
    await act(async () => {
      expirations[0]!();
      followupSignal = await followupStarted.promise;
      latest.connect();
      await connectStarted.promise;
    });
    expect(followupSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(expirations).toHaveLength(1);
  });

  it('keeps the permission prompt for any browser that supports the local-network permission', async () => {
    const gateway = fakeGateway();
    const permissions = fakePermissions('prompt');
    renderProvider(gateway, permissions.permissions);
    await waitFor(() => expect(latest.state.status).toBe('needs_permission'));
    expect(permissions.permissions.query).toHaveBeenCalled();
    expect(gateway.cors).not.toHaveBeenCalled();
  });

  it('classifies a real Firefox user agent as unsupported without querying permission or probing', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0');
    const gateway = fakeGateway();
    const permissions = fakePermissions('prompt');
    renderProvider(gateway, permissions.permissions);

    await waitFor(() => expect(latest.state.status).toBe('unsupported'));
    act(() => latest.connect());
    expect(permissions.permissions.query).not.toHaveBeenCalled();
    expect(gateway.cors).not.toHaveBeenCalled();
  });

  it.each([true, false])('classifies a phone without permission queries or probes (requireLocalNetworkPermission=%s)', async (requireLocalNetworkPermission) => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36');
    const gateway = fakeGateway();
    const permissions = fakePermissions('granted');
    renderPanelProvider(gateway, permissions.permissions, { requireLocalNetworkPermission });

    await waitFor(() => expect(latest.state.status).toBe('phone'));
    expect(screen.getByRole('heading', { name: CONNECTION_COPY.phone.title })).toBeInTheDocument();
    act(() => latest.connect());
    expect(permissions.permissions.query).not.toHaveBeenCalled();
    expect(gateway.cors).not.toHaveBeenCalled();
  });

  it('background polls do not change the rendered panel while a reading is pending', async () => {
    const gateway = fakeGateway();
    gateway.down();
    const permissions = fakePermissions('granted');
    const view = render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={permissions.permissions} pollIntervalMs={10}>
        <RuntimeConnectionGate panel={(connection, exit) => <RuntimeConnectionPanel connection={connection} exit={exit} />}>
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'not_running'));
    const panel = screen.getByTestId('runtime-not-connected');
    const rendered = panel.innerHTML;
    let release: (response: Response) => void = () => {};
    gateway.routes['/v1/health'] = () => new Promise<Response>((resolve) => { release = resolve; });
    const callsAtVerdict = gateway.calls.length;
    await waitFor(() => expect(gateway.calls.length).toBeGreaterThan(callsAtVerdict));
    expect(panel.innerHTML).toBe(rendered);
    expect(screen.queryByText('Looking for Astrid on this computer…')).not.toBeInTheDocument();
    release(new Response('<html></html>', { status: 200 }));
    await waitFor(() => expect(gateway.calls.length).toBeGreaterThan(callsAtVerdict + 1));
    expect(panel.innerHTML).toBe(rendered);
    view.unmount();
  });

  it('connectedBefore: two silent readings show not_running', async () => {
    window.localStorage.setItem(STORAGE_KEY, '1');
    const gateway = fakeGateway();
    gateway.down();
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    expect(status()).toBe('connecting');
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(status()).toBe('not_running'));
    expect(latest.state).toEqual({ status: 'not_running' });
  });

  it.each([503, 502])('gateway down body at HTTP %i establishes Astrid is installed', async (httpStatus) => {
    const gateway = fakeGateway();
    gateway.gatewayDown('runtime_unavailable', httpStatus);
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('not_running'));
    expect(latest.state).toEqual({ status: 'not_running' });
  });

  it('remembers any gateway down reading even when the second reading is silent', async () => {
    const gateway = fakeGateway();
    gateway.gatewayDown('runtime_unavailable');
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    expect(status()).toBe('connecting');

    gateway.down();
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('not_running'));
    expect(latest.state).toEqual({ status: 'not_running' });
  });

  it.each([502, 503])('shows restart help for an identity mismatch at HTTP %i', async (httpStatus) => {
    const gateway = fakeGateway();
    gateway.gatewayDown('runtime_identity_mismatch', httpStatus);
    renderPanelProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(status()).toBe('restart'));
    expect(screen.getByRole('heading', { name: CONNECTION_COPY.restarted.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CONNECTION_COPY.restarted.reload })).toBeInTheDocument();
    expect(screen.queryByText(CONNECTION_COPY.notRunning.title)).toBeNull();
  });

  it('a 503 with no readable body remains a transient check, not a stopped verdict', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => new Response('<html></html>', { status: 503 });
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(status()).toBe('not_running'));
    expect(latest.state).toEqual({ status: 'not_running' });
  });

  it('a foreign Not found error stays silent, so two readings still show not_running', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ error: 'Not found' }, 404);
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    expect(status()).toBe('connecting');
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('not_running'));
    expect(latest.state).toEqual({ status: 'not_running' });
  });

  it('recovers by the interval, with no reload, and stops probing once connected', async () => {
    const gateway = fakeGateway();
    gateway.down();
    const POLL_MS = 654_321;
    let tick: () => void = () => {};
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms !== POLL_MS) return realSetInterval(handler, ms, ...args);
      tick = () => (handler as () => void)();
      return realSetInterval(() => {}, ms);
    }) as typeof window.setInterval);
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: POLL_MS });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('not_running'));

    gateway.up();
    await act(async () => { tick(); });
    await waitFor(() => expect(status()).toBe('connected'));
    const settled = gateway.calls.length;
    await act(async () => { tick(); window.dispatchEvent(new Event('focus')); });
    await flushReactWork();
    expect(gateway.calls).toHaveLength(settled);
  });

  it('recovers on window focus when the interval is far away', async () => {
    const gateway = fakeGateway();
    gateway.down();
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    await flushReactWork();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('not_running'));

    gateway.up();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('connected'));
  });
});

describe('app entry preference', () => {
  const PREFERENCE_KEY = 'astrid:prefers-app';

  it('is remembered once the gate connects, so the next visit to the bare domain goes straight in', async () => {
    const gateway = fakeGateway();
    renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 10 });
    await waitFor(() => expect(status()).toBe('connected'));
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBe('1');
  });

  it('is not remembered while Astrid is absent, or before Connect is pressed', async () => {
    const gateway = fakeGateway();
    gateway.down();
    const { unmount } = renderProvider(gateway, fakePermissions('granted').permissions, { pollIntervalMs: 10 });
    await waitFor(() => expect(status()).toBe('not_running'));
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
    unmount();

    renderProvider(fakeGateway(), fakePermissions('prompt').permissions);
    await waitFor(() => expect(latest.state.status).toBe('needs_permission'));
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
  });

  it('is not set by a same-origin build, which has no gate', async () => {
    const { RuntimeConnectionProvider: Provider } = await import('./RuntimeConnectionProvider.tsx');
    render(<Provider permissions={{ query: vi.fn() }}><div /></Provider>);
    await flushReactWork();
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
  });

  it('still connects when storage refuses the write', async () => {
    vi.spyOn(Object.getPrototypeOf(window.localStorage), 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    renderProvider(fakeGateway(), fakePermissions('granted').permissions);
    await waitFor(() => expect(status()).toBe('connected'));
  });
});

describe('prompt', () => {
  it.each(['focus', 'interval'] as const)('does not probe on %s when permission resets before React renders', async (trigger) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const gateway = fakeGateway();
    gateway.down();
    const permission = fakePermissions('granted');
    const view = renderPanelProvider(gateway, permission.permissions);
    try {
      await flushReactWork();
      expect(gateway.calls).toHaveLength(1);
      gateway.up();

      act(() => {
        permission.change('prompt');
        // The previous granted render still owns its focus listener and interval until React commits.
        if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
        else vi.advanceTimersByTime(10);
      });
      await flushReactWork();
      expect(gateway.calls).toHaveLength(1);
      expect(latest.state.status).toBe('needs_permission');
      expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_PROBE_TIMEOUT_MS); });
      expect(gateway.calls).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      await flushReactWork();
      expect(latest.state.status).toBe('connected');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('shows the permission screen on a fresh browser without probing or asking permission', async () => {
    const gateway = fakeGateway();
    renderPanelProvider(gateway, fakePermissions('prompt').permissions);

    await waitFor(() => expect(latest.isBooting).toBe(false));
    expect(latest.state.status).toBe('needs_permission');
    expect(latest.state).toEqual({ status: 'needs_permission' });
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'permission');
    expect(screen.getByRole('heading', { name: 'Connect to Astrid on this computer' })).toBeInTheDocument();
    expect(screen.queryByText(CONNECTION_COPY.waiting)).not.toBeInTheDocument();
    await flushReactWork();
    window.dispatchEvent(new Event('focus'));
    expect(gateway.cors).not.toHaveBeenCalled();
  });

  it('Connect on the permission screen starts the prompt probe and connects', async () => {
    const gateway = fakeGateway();
    let releaseHealth: (response: Response) => void = () => {};
    gateway.routes['/v1/health'] = () => new Promise<Response>((resolve) => { releaseHealth = resolve; });
    renderPanelProvider(gateway, fakePermissions('prompt').permissions);

    await waitFor(() => expect(latest.state.status).toBe('needs_permission'));
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'permission');
    expect(gateway.cors).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(latest.isChecking).toBe(true));
    expect(gateway.cors).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'pending');
    expect(screen.getByRole('heading', { name: 'Choose Allow in Chrome' })).toBeInTheDocument();
    expect(screen.queryByText(CONNECTION_COPY.waiting)).not.toBeInTheDocument();

    releaseHealth(json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST }));
    await waitFor(() => expect(status()).toBe('connected'));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('keeps the not-running waiting line while granted permission schedules polling', async () => {
    const gateway = fakeGateway();
    gateway.down();
    renderPanelProvider(gateway, fakePermissions('granted').permissions);

    await waitFor(() => expect(latest.state.status).toBe('not_running'));
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'not_running');
    expect(screen.getByText(CONNECTION_COPY.waiting)).toBeInTheDocument();
  });

  it('a failed Connect probe stays in needs_permission while permission remains prompt', async () => {
    const gateway = fakeGateway();
    gateway.down();
    renderPanelProvider(gateway, fakePermissions('prompt').permissions);

    await waitFor(() => expect(latest.state.status).toBe('needs_permission'));
    expect(gateway.cors).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(latest.isChecking).toBe(false));
    expect(latest.state).toEqual({ status: 'needs_permission' });
    expect(latest.state.status).toBe('needs_permission');
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'permission');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('keeps needs_permission while the browser prompt is open, and ignores a second connect()', async () => {
    const gateway = fakeGateway();
    let release: (response: Response) => void = () => {};
    gateway.routes['/v1/health'] = () => new Promise<Response>((resolve) => { release = resolve; });
    renderProvider(gateway, fakePermissions('prompt').permissions);
    await waitFor(() => expect(latest.isBooting).toBe(false));

    act(() => latest.connect());
    await waitFor(() => expect(status()).toBe('needs_permission'));
    expect(latest.isBooting).toBe(false);
    expect(latest.isChecking).toBe(true);
    act(() => latest.connect());
    expect(gateway.cors).toHaveBeenCalledTimes(1);

    release(json({ status: 'ok', schema_digest: RUNTIME_SCHEMA_DIGEST }));
    await waitFor(() => expect(status()).toBe('connected'));
  });

  it('connect() with nothing listening stays on the first-time panel and keeps offering Connect', async () => {
    const gateway = fakeGateway();
    gateway.down();
    renderProvider(gateway, fakePermissions('prompt').permissions);
    await waitFor(() => expect(latest.isBooting).toBe(false));

    act(() => latest.connect());
    await waitFor(() => expect(latest.isChecking).toBe(false));
    expect(latest.state).toEqual({ status: 'needs_permission' });
    expect(latest.state.status).toBe('needs_permission');
  });

  it('the browser granting the permission starts probing without a click', async () => {
    const gateway = fakeGateway();
    const permission = fakePermissions('prompt');
    renderProvider(gateway, permission.permissions);
    await waitFor(() => expect(latest.state.status).toBe('needs_permission'));
    expect(gateway.cors).not.toHaveBeenCalled();

    act(() => permission.change('granted'));
    await waitFor(() => expect(status()).toBe('connected'));
  });

  it('a grant while the Connect probe is pending under the prompt aborts it and probes again, then connects', async () => {
    const gateway = fakeGateway();
    const permission = fakePermissions('prompt');
    let attempts = 0;
    const signals: (AbortSignal | undefined)[] = [];
    // The first health request is the one Chrome holds open behind its prompt: it settles only when aborted.
    gateway.routes['/v1/health'] = () => json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST });
    const base = gateway.fetchImpl;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      if (String(input).endsWith('/v1/health') && attempts++ === 0) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      return (base as unknown as (i: RequestInfo | URL) => Promise<Response>)(input);
    }) as unknown as typeof fetch;
    renderProvider({ ...gateway, fetchImpl }, permission.permissions);
    await waitFor(() => expect(latest.state.status).toBe('needs_permission'));

    act(() => latest.connect());
    await waitFor(() => expect(status()).toBe('needs_permission'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    act(() => permission.change('granted'));
    await waitFor(() => expect(status()).toBe('connected'));
    expect(signals[0]?.aborted).toBe(true);
    expect(latest.state).toEqual({ status: 'connected', realm: REALM });
  });

  it('a rejected permission query on Chromium asks for a browser update and never probes', async () => {
    const gateway = fakeGateway();
    const throwing: PermissionsLike = { query: vi.fn(async () => { throw new TypeError('unknown permission name'); }) };
    renderProvider(gateway, throwing);

    await waitFor(() => expect(latest.state.status).toBe('browser_update_needed'));
    expect(throwing.query).toHaveBeenCalled();
    expect(gateway.cors).not.toHaveBeenCalled();
  });

  it('a refusal during connect() is read from the permission: denied becomes blocked', async () => {
    const gateway = fakeGateway();
    gateway.down();
    const permission = fakePermissions('prompt');
    renderProvider(gateway, permission.permissions);
    await waitFor(() => expect(latest.isBooting).toBe(false));

    permission.status.state = 'denied'; // the browser's answer, before it reports a change
    act(() => latest.connect());
    await waitFor(() => expect(status()).toBe('blocked'));
  });
});

describe('denied', () => {
  it('is blocked and sends nothing, and connect() does nothing', async () => {
    const gateway = fakeGateway();
    renderProvider(gateway, fakePermissions('denied').permissions);

    await waitFor(() => expect(status()).toBe('blocked'));
    act(() => latest.connect());
    window.dispatchEvent(new Event('focus'));
    expect(gateway.cors).not.toHaveBeenCalled();
  });

  it.each([
    ['focus', 'granted'], ['visibilitychange', 'granted'],
    ['focus', 'prompt'], ['visibilitychange', 'prompt'],
  ] as const)('re-queries denied permission on %s to %s without a change event', async (event, next) => {
    const gateway = fakeGateway();
    const permission = fakePermissions('denied');
    const view = renderProvider(gateway, permission.permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(status()).toBe('blocked'));
    permission.status.state = next;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { (event === 'focus' ? window : document).dispatchEvent(new Event(event)); });
    await waitFor(() => expect(status()).toBe(next === 'granted' ? 'connected' : 'needs_permission'));
    if (next === 'prompt') expect(gateway.cors).not.toHaveBeenCalled();
    view.unmount();
    const queries = vi.mocked(permission.permissions.query).mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(permission.permissions.query).toHaveBeenCalledTimes(queries);
  });

  it('allowing it in site settings connects without a reload', async () => {
    const gateway = fakeGateway();
    const permission = fakePermissions('denied');
    renderProvider(gateway, permission.permissions);
    await waitFor(() => expect(status()).toBe('blocked'));

    act(() => permission.change('granted'));
    await waitFor(() => expect(status()).toBe('connected'));
  });
});

describe('storage', () => {
  it('still renders, connects and stays first-time when localStorage throws', async () => {
    vi.spyOn(Object.getPrototypeOf(window.localStorage), 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Object.getPrototypeOf(window.localStorage), 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const gateway = fakeGateway();
    gateway.down();
    renderProvider(gateway, fakePermissions('granted').permissions);
    await waitFor(() => expect(status()).toBe('not_running'));
    expect(latest.state).toEqual({ status: 'not_running' });

    gateway.up();
    await waitFor(() => expect(status()).toBe('connected'));
  });
});

describe('gate', () => {
  it('mounts nothing below it, so no Runtime query can run, until connected', async () => {
    const gateway = fakeGateway();
    gateway.down();
    const mounted = vi.fn();
    function RuntimeQueryOwner() {
      React.useEffect(mounted, []);
      return <div data-testid="app" />;
    }
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <RuntimeConnectionGate>
          <RuntimeQueryOwner />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'not_running'));
    expect(screen.queryByTestId('app')).toBeNull();
    expect(mounted).not.toHaveBeenCalled();

    gateway.up();
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(screen.queryByTestId('runtime-not-connected')).toBeNull();
  });

  it('the placeholder panel shows the state name and nothing else', async () => {
    const gateway = fakeGateway();
    gateway.down();
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <RuntimeConnectionGate>
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toHaveTextContent(/^not_running$/));
  });

  it('takes a panel and a pill as render props', async () => {
    const gateway = fakeGateway();
    gateway.down();
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <RuntimeConnectionGate
          panel={({ state }, exit) => (exit ? <LeaveAtOnce exit={exit} /> : <p data-testid="custom-panel">{state.status}</p>)}
          pill={({ realmName }) => <p data-testid="custom-pill">{realmName}</p>}
        >
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('custom-panel')).toHaveTextContent('not_running'));
    expect(screen.queryByTestId('custom-pill')).toBeNull();

    gateway.up();
    await waitFor(() => expect(screen.getByTestId('custom-pill')).toHaveTextContent('Direct Journey'));
    expect(screen.getByTestId('app')).toBeInTheDocument();
    expect(screen.queryByTestId('custom-panel')).toBeNull();
  });
});

/** A panel with no leaving motion: it hands over to the app as soon as it is asked to leave. */
function LeaveAtOnce({ exit }: { exit: RuntimeConnectionPanelExit }) {
  React.useEffect(() => { exit.left(); }, [exit]);
  return null;
}

/** A test panel that draws `screen` while not connected and leaves at once when Astrid answers. */
const leavesAtOnce = (screen: (connection: RuntimeConnectionValue) => React.ReactNode) => (
  (connection: RuntimeConnectionValue, exit: RuntimeConnectionPanelExit | null) => (exit ? <LeaveAtOnce exit={exit} /> : screen(connection))
);

describe('gate: the panel on its way out', () => {
  /** Shows the screen it is given; on its way out, a button stands for the panel's leaving motion. */
  const gate = (gateway: ReturnType<typeof fakeGateway>) => render(
    <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
      <RuntimeConnectionGate
        panel={({ state }, exit) => (
          <div data-testid="panel" data-exit={exit ? '' : undefined}>
            {state.status}
            {exit && <button type="button" onClick={exit.left}>left</button>}
          </div>
        )}
      >
        <div data-testid="app" />
      </RuntimeConnectionGate>
    </RuntimeConnectionProvider>,
  );

  it('after a setup screen, mounts the app beneath the same panel, which keeps its screen until it has left', async () => {
    const gateway = fakeGateway();
    gateway.down();
    gate(gateway);
    await waitFor(() => expect(screen.getByTestId('panel')).toHaveTextContent('not_running'));
    const panel = screen.getByTestId('panel');

    gateway.up();
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    // The same element, still on the screen it was showing, now on its way out.
    expect(screen.getByTestId('panel')).toBe(panel);
    expect(panel).toHaveTextContent('not_running');
    expect(panel).toHaveAttribute('data-exit');

    fireEvent.click(screen.getByRole('button', { name: 'left' }));
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(screen.getByTestId('app')).toBeInTheDocument();
  });

  it('removes a visible panel that leaves from its own effect, before the gate has re-rendered', async () => {
    function LeavesOnMount({ exit }: { exit: RuntimeConnectionPanelExit }) {
      React.useEffect(() => { exit.left(); }, [exit]);
      return <div data-testid="panel">leaving</div>;
    }
    const gateway = fakeGateway();
    gateway.down();
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <RuntimeConnectionGate panel={({ state }, exit) => (exit ? <LeavesOnMount exit={exit} /> : <div data-testid="panel">{state.status}</div>)}>
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('panel')).toHaveTextContent('not_running'));
    gateway.up();
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('panel')).toBeNull());
  });

  it('a Runtime that answers at once: the connecting screen leaves into the app the same way', async () => {
    const gateway = fakeGateway();
    gate(gateway);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(screen.getByTestId('panel')).toHaveTextContent('connecting');
    expect(screen.getByTestId('panel')).toHaveAttribute('data-exit');
    fireEvent.click(screen.getByRole('button', { name: 'left' }));
    expect(screen.queryByTestId('panel')).toBeNull();
  });
});

describe('gate: the landing page already asked to go in', () => {
  it('consumes entry intent before a denied permission resets during the blocked commit', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const gateway = fakeGateway();
    const permission = fakePermissions('prompt');
    let denied = false;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!denied) {
        denied = true;
        queueMicrotask(() => flushSync(() => permission.change('denied')));
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return gateway.fetchImpl(input, init);
    });
    const reset = deferred<void>();
    // Reset at the first blocked commit, before the gate's deferred state update can use up entry intent.
    const observer = new MutationObserver(async () => {
      if (!screen.queryByRole('heading', { name: 'Allow Astrid in Chrome' })) return;
      observer.disconnect();
      // Drain the failed probe's microtasks without letting React render the deferred entry-flag update.
      for (let i = 0; i < 50; i += 1) await Promise.resolve();
      flushSync(() => permission.change('prompt'));
      reset.resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const view = render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={fetchImpl} permissions={permission.permissions}>
        <RuntimeConnectionGate connectOnEntry panel={connection => <RuntimeConnectionPanel connection={connection} />}>
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );
    try {
      await reset.promise;
      await flushReactWork();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
      expect(screen.queryByTestId('app')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_PROBE_TIMEOUT_MS); });
      fireEvent.focus(window);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      await flushReactWork();
      expect(screen.getByTestId('app')).toBeInTheDocument();
    } finally {
      observer.disconnect();
      view.unmount();
      vi.useRealTimers();
    }
  });

  /** A small panel that exposes whether the gate presented permission or an in-flight browser prompt. */
  const panel = ({ state, isChecking }: RuntimeConnectionValue) => (
    state.status === 'needs_permission' && isChecking
      ? <p data-testid="panel-state">pending</p>
      : state.status === 'needs_permission'
      ? <p data-testid="permission">permission</p>
      : <p data-testid="panel-state">{state.status}</p>
  );
  const renderGate = (gateway: ReturnType<typeof fakeGateway>, permission: string, pollIntervalMs = 10) => render(
    <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions(permission).permissions} pollIntervalMs={pollIntervalMs}>
      <Probe />
      <RuntimeConnectionGate panel={leavesAtOnce(panel)}>
        <div data-testid="app" />
      </RuntimeConnectionGate>
    </RuntimeConnectionProvider>,
  );

  it('starts the permission request at once with the handoff flag, without showing an explainer', async () => {
    requestAutoConnect();
    const gateway = fakeGateway();
    renderGate(gateway, 'prompt');

    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(screen.queryByTestId('permission')).toBeNull();
    expect(gateway.cors).toHaveBeenCalled();
    // One-shot: the flag is used up.
    expect(autoConnectRequested()).toBe(false);
  });

  it('consumes ?connect=1 once, preserves other URL parts, and immediately asks for permission', async () => {
    window.history.replaceState({}, '', '/tools/video-editor?timeline=timeline-7&connect=1#frame-42');
    const gateway = fakeGateway();
    renderGate(gateway, 'prompt');
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(window.location.href).toContain('/tools/video-editor?timeline=timeline-7#frame-42');
    expect(window.location.search).not.toContain('connect=1');
    expect(gateway.cors).toHaveBeenCalledTimes(2);
    expect(autoConnectRequested()).toBe(false);
  });

  it('uses the installer query itself as authorization when session storage is unavailable', async () => {
    window.history.replaceState({}, '', '/tools/video-editor?timeline=timeline-7&connect=1#frame-42');
    Object.defineProperty(window.sessionStorage, 'setItem', {
      configurable: true,
      value: () => { throw new Error('session storage is blocked'); },
    });
    Object.defineProperty(window.sessionStorage, 'getItem', {
      configurable: true,
      value: () => { throw new Error('session storage is blocked'); },
    });
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => new Promise<Response>(() => {});
    renderGate(gateway, 'prompt');

    await waitFor(() => expect(screen.getByTestId('panel-state')).toHaveTextContent('pending'));
    expect(gateway.cors).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?timeline=timeline-7');
    expect(window.location.hash).toBe('#frame-42');
    expect(autoConnectRequested()).toBe(false);
  });

  it('keeps the installer handoff on the permission screen while Chrome\'s prompt is open', async () => {
    requestAutoConnect();
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => new Promise<Response>(() => {});
    renderGate(gateway, 'prompt');

    await waitFor(() => expect(screen.getByTestId('panel-state')).toHaveTextContent('pending'));
    expect(screen.queryByTestId('permission')).toBeNull();
  });

  it('shows the permission screen on a fresh direct visit without asking permission or probing', async () => {
    const gateway = fakeGateway();
    gateway.down();
    window.sessionStorage.clear();
    renderGate(gateway, 'prompt', 600_000);

    await waitFor(() => expect(screen.getByTestId('permission')).toHaveTextContent('permission'));
    expect(latest.state).toEqual({ status: 'needs_permission' });
    expect(gateway.cors).not.toHaveBeenCalled();
    await flushReactWork();
    expect(latest.state).toEqual({ status: 'needs_permission' });
    expect(screen.getByTestId('permission')).toBeInTheDocument();
  });

  it('with the permission already granted or denied the flag has nothing to do, and does not linger', async () => {
    for (const permission of ['granted', 'denied']) {
      requestAutoConnect();
      const gateway = fakeGateway();
      const view = renderGate(gateway, permission);
      await waitFor(() => expect(autoConnectRequested()).toBe(false));
      view.unmount();
    }
  });

  it('a later permission reset shows the permission screen again, because the flag was used up', async () => {
    requestAutoConnect();
    const gateway = fakeGateway();
    gateway.down();
    window.localStorage.setItem(STORAGE_KEY, '1');
    const permissions = fakePermissions('prompt');
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={permissions.permissions} pollIntervalMs={10}>
        <RuntimeConnectionGate panel={leavesAtOnce(panel)}><div data-testid="app" /></RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(autoConnectRequested()).toBe(false));
    permissions.change('denied');
    permissions.change('prompt');
    await waitFor(() => expect(screen.getByTestId('permission')).toBeInTheDocument());
  });

  it('survives storage that refuses to be read', () => {
    vi.spyOn(Object.getPrototypeOf(window.localStorage), 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Object.getPrototypeOf(window.localStorage), 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => requestAutoConnect()).not.toThrow();
    expect(autoConnectRequested()).toBe(false);
  });
});

describe('permission and setup evidence matrix', () => {
  const permissions = ['prompt', 'granted', 'denied'] as const;
  const entries = ['none', 'onboarding-continue', 'installer-query'] as const;
  const outcomes = ['answers', 'no-answer', 'refused', 'slow'] as const;
  const cases = permissions.flatMap((permission) => [false, true].flatMap((connectedBefore) => entries.flatMap((entry) => outcomes.map((outcome) => ({
    permission,
    connectedBefore,
    entry,
    outcome,
  })))));

  const assertNoEvidencePayload = (states: readonly RuntimeConnectionValue['state'][]) => {
    for (const state of states) expect(state).not.toHaveProperty('evidence');
  };

  it.each(cases)('$permission, connectedBefore=$connectedBefore, $entry, Runtime $outcome', async ({ permission: initialPermission, connectedBefore, entry, outcome }) => {
    const observedStates: RuntimeConnectionValue['state'][] = [];
    if (connectedBefore) window.localStorage.setItem(STORAGE_KEY, '1');
    if (entry === 'installer-query') window.history.replaceState({}, '', '/tools/video-editor?timeline=timeline-7&connect=1#frame-42');

    const gateway = fakeGateway();
    if (outcome === 'refused') gateway.refuse();
    else if (outcome !== 'answers') gateway.down();
    const permission = fakePermissions(initialPermission);
    const expireProbes: (() => void)[] = [];
    let timedOutProbes = 0;
    const realSetTimeout = window.setTimeout.bind(window);
    if (outcome === 'slow') {
      vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms === PROBE_TIMEOUT_MS) {
          expireProbes.push(() => {
            timedOutProbes += 1;
            if (typeof handler === 'function') handler(...args);
          });
          return realSetTimeout(() => {}, ms);
        }
        return realSetTimeout(handler, ms, ...args);
      }) as typeof window.setTimeout);
    }
    let heldPromptProbe = false;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (initialPermission === 'prompt' && String(input).endsWith('/v1/health') && !heldPromptProbe) {
        heldPromptProbe = true;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      if (outcome === 'slow' && timedOutProbes === 0) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return gateway.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    // The refusal check is not a reading: it is counted on the gateway, and never sent before permission is granted.
    const providerFetch = ((input: RequestInfo | URL, init?: RequestInit) => init?.mode === 'no-cors' ? gateway.fetchImpl(input, init) : fetchImpl(input, init)) as typeof fetch;

    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={providerFetch} permissions={permission.permissions} pollIntervalMs={600_000}>
        <RecordingProbe states={observedStates} />
      <RuntimeConnectionGate connectOnEntry={entry === 'onboarding-continue'} panel={(connection, exit) => <RuntimeConnectionPanel connection={connection} exit={exit} />}>
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );

    if (entry === 'installer-query') {
      await waitFor(() => expect(window.location.search).not.toContain('connect=1'));
      expect(window.location.href).toContain('#frame-42');
    }

    if (initialPermission === 'denied') {
      await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'blocked'));
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(gateway.noCorsCalls).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /Set up Astrid|Astrid isn't (?:running|answering)/ })).not.toBeInTheDocument();
      assertNoEvidencePayload(observedStates);
      return;
    }

    if (initialPermission === 'prompt' && entry === 'none') {
      await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'permission'));
      expect(latest.state).toEqual({ status: 'needs_permission' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: /Set up Astrid|Astrid isn't (?:running|answering)/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    }

    if (initialPermission === 'prompt') {
      await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'pending');
      expect(screen.queryByRole('heading', { name: /Set up Astrid|Astrid isn't (?:running|answering)/ })).not.toBeInTheDocument();
      // The first probe is held open as if Chrome's prompt were still visible. Granting permission aborts it and
      // lets the granted-permission probe produce the actual answered or silent result below.
      if (outcome === 'answers') gateway.up();
      act(() => permission.change('granted'));
    }

    if (initialPermission === 'prompt' && entry !== 'none') {
      expect(screen.queryByRole('heading', { name: /Set up Astrid|Astrid isn't (?:running|answering)/ })).not.toBeInTheDocument();
    }

    if (outcome === 'answers') {
      await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
      expect(latest.state).toMatchObject({ status: 'connected' });
      expect(screen.getByTestId('app')).toBeInTheDocument();
      assertNoEvidencePayload(observedStates);
      return;
    }

    if (outcome === 'slow') {
      await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(initialPermission === 'prompt' ? 2 : 1));
      act(() => expireProbes[0]!());
      await waitFor(() => expect(latest.isBooting).toBe(false));
      await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(initialPermission === 'prompt' ? 3 : 2));
      await waitFor(() => expect(latest.state.status).toBe('not_running'));
      expect(latest.state).toEqual({ status: 'not_running' });
      expect(latest.connectedBefore).toBe(connectedBefore);
      assertNoEvidencePayload(observedStates);
      return;
    }

    // A single failed reading remains connecting. A second real failure produces one recovery screen.
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(initialPermission === 'prompt' ? 2 : 1));
    await flushReactWork();
    expect(latest.state.status).toBe('connecting');
    expect(latest.state).not.toHaveProperty('evidence');
    expect(screen.queryByRole('heading', { name: /Set up Astrid|Astrid isn't (?:running|answering)/ })).not.toBeInTheDocument();
    assertNoEvidencePayload(observedStates);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    const finalStatus = outcome === 'refused' ? 'refused' : 'not_running';
    await waitFor(() => expect(latest.state.status).toBe(finalStatus));
    expect(latest.state).toEqual({ status: finalStatus });
    expect(latest.connectedBefore).toBe(connectedBefore);
    assertNoEvidencePayload(observedStates);
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', finalStatus);
    expect(screen.queryByTestId('app')).not.toBeInTheDocument();
    if (outcome === 'refused') {
      // Astrid answered: the card says so, and offers no install.
      expect(screen.getByRole('heading', { name: CONNECTION_COPY.refused.title })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /Set up Astrid|Astrid isn't (?:running|answering)/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/curl -fsSL|irm https/)).not.toBeInTheDocument();
      expect(gateway.noCorsCalls.length).toBeGreaterThan(0);
    } else {
      expect(screen.getByRole('heading', { name: "Astrid isn't answering on this computer" })).toBeInTheDocument();
    }
  });

  it('resets failed readings when permission leaves and returns to granted', async () => {
    const gateway = fakeGateway();
    gateway.down();
    const permission = fakePermissions('granted');
    renderProvider(gateway, permission.permissions, { pollIntervalMs: 600_000 });

    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    await flushReactWork();
    expect(latest.state.status).toBe('connecting');

    act(() => permission.change('denied'));
    await waitFor(() => expect(latest.state.status).toBe('blocked'));
    act(() => permission.change('prompt'));
    await waitFor(() => expect(latest.state.status).toBe('needs_permission'));
    act(() => permission.change('granted'));

    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(2));
    await flushReactWork();
    expect(latest.state.status).toBe('connecting');
    expect(latest.state).not.toHaveProperty('evidence');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(latest.state.status).toBe('not_running'));
    expect(latest.state).toEqual({ status: 'not_running' });
  });

  it.each([
    ['unknown', null, false],
    ['Pinokio', '1', true],
    ['other installer', '0', false],
  ] as const)('not-running guidance uses last-seen provenance: %s', async (_label, storedValue, shouldMentionPinokio) => {
    if (storedValue !== null) window.localStorage.setItem(PINOKIO_STORAGE_KEY, storedValue);
    const gateway = fakeGateway();
    gateway.down();
    const permission = fakePermissions('granted');
    renderPanelProvider(gateway, permission.permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(status()).toBe('connecting'));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('not_running'));
    const expectedSentence = shouldMentionPinokio ? CONNECTION_COPY.notRunning.pinokioHint : CONNECTION_COPY.notRunning.sentence;
    expect(screen.getByText(expectedSentence)).toBeInTheDocument();
  });
});

describe('same-origin build', () => {
  it('is not gated: children render at once and the gate leaves installer intent untouched', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const permissionsQuery = vi.fn();
    window.history.replaceState({}, '', '/tools/video-editor?timeline=timeline-7&connect=1#frame-42');
    const { RuntimeConnectionGate: Gate, RuntimeConnectionProvider: Provider } = await import('./RuntimeConnectionProvider.tsx');
    render(
      <Provider permissions={{ query: permissionsQuery }}>
        <Gate connectOnEntry>
          <div data-testid="app" />
        </Gate>
      </Provider>,
    );

    expect(screen.getByTestId('app')).toBeInTheDocument();
    await flushReactWork();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(permissionsQuery).not.toHaveBeenCalled();
    expect(autoConnectRequested()).toBe(false);
    expect(window.location.search).toBe('?timeline=timeline-7&connect=1');
    expect(window.location.hash).toBe('#frame-42');
    vi.unstubAllGlobals();
  });

  it('a configured Runtime origin equal to the page origin is gated without querying local-network permission', async () => {
    const connection = await import('./connection.ts');
    connection.setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: window.location.origin });
    const { RuntimeConnectionProvider: Provider, useRuntimeConnection: useFresh } = await import('./RuntimeConnectionProvider.tsx');
    function FreshProbe() {
      latest = useFresh();
      return <span data-testid="status">{latest.state.status}</span>;
    }
    const gateway = fakeGateway();
    const permission = fakePermissions('prompt');
    render(
      <Provider fetchImpl={gateway.fetchImpl} permissions={permission.permissions} pollIntervalMs={10}>
        <FreshProbe />
      </Provider>,
    );

    await waitFor(() => expect(status()).toBe('connected'));
    expect(latest.gated).toBe(true);
    expect(permission.permissions.query).not.toHaveBeenCalled();
    expect(gateway.calls[0]).toBe(`${window.location.origin}/api/runtime/v1/health`);
  });

  it('is gated once a Runtime origin is configured, and probes that origin', async () => {
    const connection = await import('./connection.ts');
    connection.setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: 'http://127.0.0.1:17340' });
    // The module was reloaded, so the hook must come from the same copy as the provider.
    const { RuntimeConnectionProvider: Provider, useRuntimeConnection: useFresh } = await import('./RuntimeConnectionProvider.tsx');
    function FreshProbe() {
      latest = useFresh();
      return <span data-testid="status">{latest.state.status}</span>;
    }
    const gateway = fakeGateway();
    render(
      <Provider fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <FreshProbe />
      </Provider>,
    );

    await waitFor(() => expect(status()).toBe('connected'));
    expect(latest.gated).toBe(true);
    expect(gateway.calls[0]).toBe('http://127.0.0.1:17340/api/runtime/v1/health');
  });
});

describe('gate: incompatible Runtime and local-service update flag', () => {
  const marker = ({ state }: RuntimeConnectionValue) => <p data-testid="custom-panel">{state.status}</p>;

  it('an incompatible health digest still shows the gate panel, not the app', async () => {
    const gateway = fakeGateway();
    gateway.routes['/v1/health'] = () => json({ status: 'ok', schema_digest: 'sha256:old-runtime' });
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <RuntimeConnectionGate panel={leavesAtOnce(marker)}>
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('custom-panel')).toHaveTextContent('update_needed'));
    expect(screen.queryByTestId('app')).toBeNull();
  });

  it('a local-service update flag keeps the connected state and the app, and clears again', async () => {
    const gateway = fakeGateway();
    render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission fetchImpl={gateway.fetchImpl} permissions={fakePermissions('granted').permissions} pollIntervalMs={10}>
        <Probe />
        <RuntimeConnectionGate panel={leavesAtOnce(marker)}>
          <div data-testid="app" />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(status()).toBe('connected'));
    expect(latest.localServiceOutOfDate).toBe(false);

    act(() => latest.setLocalServiceOutOfDate(true));
    expect(latest.localServiceOutOfDate).toBe(true);
    expect(status()).toBe('connected');
    expect(screen.getByTestId('app')).toBeInTheDocument();
    expect(screen.queryByTestId('custom-panel')).toBeNull();

    act(() => latest.setLocalServiceOutOfDate(false));
    expect(latest.localServiceOutOfDate).toBe(false);
    expect(status()).toBe('connected');
  });
});

describe('useRuntimeConnection', () => {
  it('throws outside its provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('useRuntimeConnection must be used within a RuntimeConnectionProvider');
  });
});

describe('permission transitions, before and after a connection', () => {
  const transitions = [
    ['granted', 'prompt'],
    ['granted', 'denied'],
    ['denied', 'granted'],
    ['prompt', 'granted'],
  ] as const;
  const screenFor = { prompt: 'needs_permission', denied: 'blocked' } as const;
  const phases = ['before', 'after'] as const;
  const cases = phases.flatMap((phase) => transitions.map(([from, to]) => ({ phase, from, to })));

  it.each(cases)('$phase a connection: $from -> $to', async ({ phase, from, to }) => {
    const gateway = fakeGateway();
    const permission = fakePermissions(phase === 'after' ? 'granted' : from);
    const seen: string[] = [];
    const watchStatus = () => seen.push(status() ?? '');
    const record = () => { watchStatus(); };

    // Before a connection the door is down while the permission is granted (so nothing is connected yet) and up otherwise,
    // so that a grant can connect; after a connection it is up throughout.
    if (phase === 'before' && from === 'granted') gateway.down();
    renderProvider(gateway, permission.permissions, { pollIntervalMs: 600_000 });
    if (phase === 'after') {
      await waitFor(() => expect(status()).toBe('connected'));
    } else if (from === 'granted') {
      await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(1));
    } else {
      await waitFor(() => expect(status()).toBe(screenFor[from]));
      // Not granted: nothing is sent, and no screen speaks about the Runtime.
      expect(gateway.cors).not.toHaveBeenCalled();
      expect(gateway.noCorsCalls).toHaveLength(0);
    }
    record();

    // After a connection a "regain" transition is first a loss to its starting state.
    if (phase === 'after' && from !== 'granted') {
      act(() => permission.change(from));
      await waitFor(() => expect(status()).toBe(screenFor[from]));
      expect(latest.isConnected).toBe(false);
      record();
    }
    const requestsBefore = gateway.cors.mock.calls.length + gateway.noCorsCalls.length;

    act(() => permission.change(to));
    if (to === 'granted') {
      gateway.up();
      await waitFor(() => expect(status()).toBe('connected'));
      expect(latest.isConnected).toBe(true);
      // The grant is what lets probing start again.
      if (phase === 'after' || from !== 'granted') expect(gateway.cors.mock.calls.length).toBeGreaterThan(requestsBefore);
    } else {
      await waitFor(() => expect(status()).toBe(screenFor[to]));
      expect(latest.isConnected).toBe(false);
      await flushReactWork();
      // Nothing more is sent once the permission is gone, however long the poll interval has run.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
      expect(gateway.cors.mock.calls.length + gateway.noCorsCalls.length).toBe(requestsBefore);
    }
    record();
    // No claim about the Runtime was ever made without the permission: never stopped, never not running, never refused.
    expect(seen).not.toContain('not_running');
    expect(seen).not.toContain('refused');
    expect(seen).not.toContain('restart');
  });

  it('a reset that Chrome never announces is found when the tab resumes, and reconnects once granted again', async () => {
    const gateway = fakeGateway();
    const permission = fakePermissions('granted');
    renderProvider(gateway, permission.permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(status()).toBe('connected'));
    // Site data cleared in another tab: the state changes, `onchange` does not fire.
    permission.status.state = 'prompt';
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('needs_permission'));
    expect(latest.isConnected).toBe(false);
    permission.status.state = 'granted';
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(status()).toBe('connected'));
  });

  it('confirmPermission re-reads the browser, and says no while it is not granted', async () => {
    const gateway = fakeGateway();
    const permission = fakePermissions('granted');
    renderProvider(gateway, permission.permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(status()).toBe('connected'));
    await expect(latest.confirmPermission()).resolves.toBe(true);
    permission.status.state = 'denied';
    await expect(latest.confirmPermission()).resolves.toBe(false);
    await waitFor(() => expect(status()).toBe('blocked'));
  });

  it('Connect answered by nothing (Chrome dismissed or never asked) keeps Connect and adds the site-settings steps', async () => {
    const gateway = fakeGateway();
    gateway.down();
    const permission = fakePermissions('prompt');
    renderPanelProvider(gateway, permission.permissions, { pollIntervalMs: 600_000 });
    await waitFor(() => expect(status()).toBe('needs_permission'));
    expect(latest.askUnanswered).toBe(false);
    expect(screen.queryByText(/didn't ask, allow it here/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(latest.askUnanswered).toBe(true));
    expect(status()).toBe('needs_permission');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.getByText(/didn't ask, allow it here/)).toBeInTheDocument();
    for (const step of CONNECTION_COPY.blocked.steps) expect(screen.getByText(step)).toBeInTheDocument();
    // It never claims anything about Astrid, and sent no refusal check while the permission was not granted.
    expect(gateway.noCorsCalls).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: /isn't answering|running but/ })).not.toBeInTheDocument();
    // Pressing Connect again starts a fresh attempt.
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(gateway.cors).toHaveBeenCalledTimes(2));
  });
});

describe('the local path never touches the permission', () => {
  it.each([
    ['gated, no permission required (a loopback page)', { gated: true, requireLocalNetworkPermission: false }],
    ['ungated (no VITE_RUNTIME_ORIGIN)', { gated: false }],
  ] as const)('%s', async (_name, props) => {
    const query = vi.fn();
    const gateway = fakeGateway();
    render(
      <RuntimeConnectionProvider {...props} fetchImpl={gateway.fetchImpl} permissions={{ query }} pollIntervalMs={600_000}>
        <Probe />
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(status()).toBe('connected'));
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(latest.confirmPermission()).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
});
