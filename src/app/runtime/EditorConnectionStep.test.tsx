// @vitest-environment-options {"url":"https://astrid.haus/tools/video-editor?project=p1&timeline=t1#frame-42"}
import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRuntimeOrigin } from '@/integrations/runtime/connection.ts';
import { RUNTIME_SCHEMA_DIGEST } from '@/integrations/runtime/contract-metadata.ts';
import { RuntimeConnectionGate, RuntimeConnectionProvider, type RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { connectionFor } from '@/shared/components/RuntimeConnection/connectionFixture.ts';
import { writeWelcomePhase } from '@/app/onboarding/welcomeProgress.ts';
import { EditorConnectionPanel } from './RuntimeDocumentBoundary.tsx';

vi.mock('@/integrations/runtime/localNetworkPermission.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/integrations/runtime/localNetworkPermission.ts')>();
  return { ...actual, requiresLocalNetworkPermission: () => true };
});

const replace = vi.fn();
const permission = { state: 'granted', onchange: null as ((this: unknown, event: Event) => unknown) | null };

/** jsdom cannot navigate and its Location methods are unforgeable: keep the real window, replace only the location. */
function stubLocation(href: string) {
  const url = new URL(href);
  const location = { href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash, assign: vi.fn(), replace };
  const browserWindow = window;
  vi.stubGlobal('window', new Proxy(browserWindow, { get(target, property) {
    if (property === 'location') return location;
    const value = Reflect.get(target, property, target);
    return ['addEventListener', 'removeEventListener', 'dispatchEvent', 'matchMedia'].includes(String(property)) && typeof value === 'function' ? value.bind(target) : value;
  } }));
}

const EDITOR_URL = 'https://astrid.haus/tools/video-editor?project=p1&timeline=t1#frame-42';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  writeWelcomePhase(null);
  replace.mockReset();
  permission.state = 'granted';
  permission.onchange = null;
  setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: 'http://127.0.0.1:17340' });
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Chrome/141.0.0.0 Safari/537.36');
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: vi.fn(async () => permission) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The editor gate never navigates: no replace/assign, no history change, the address as it was. */
function expectNoNavigation() {
  expect(replace).not.toHaveBeenCalled();
  expect(window.location.assign).not.toHaveBeenCalled();
  expect(window.location.href).toBe(EDITOR_URL);
}

describe('editor gate: the step is drawn in place', () => {
  it.each(['needs_permission', 'blocked', 'not_running', 'refused', 'browser_update_needed', 'unsupported'] as const)(
    '%s shows the connection step and does not navigate',
    (status) => {
      stubLocation(EDITOR_URL);
      const pushState = vi.spyOn(window.history, 'pushState');
      const replaceState = vi.spyOn(window.history, 'replaceState');
      render(<EditorConnectionPanel connection={connectionFor({ status })} exit={null} />);
      expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', status === 'needs_permission' ? 'permission' : status);
      expectNoNavigation();
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['connecting', { status: 'connecting' }],
    ['phone', { status: 'phone' }],
    ['restart', { status: 'restart' }],
    ['update_needed', { status: 'update_needed' }],
  ] as const)('%s keeps its own screen, without asking Chrome', (_name, state) => {
    stubLocation(EDITOR_URL);
    const connect = vi.fn();
    render(<EditorConnectionPanel connection={connectionFor(state, { connect })} exit={null} />);
    expect(connect).not.toHaveBeenCalled();
    expectNoNavigation();
  });

  it('renders the permission explanation without probing, then Connect starts the request', () => {
    stubLocation(EDITOR_URL);
    const connect = vi.fn();
    render(<EditorConnectionPanel connection={connectionFor({ status: 'needs_permission' }, { connect })} exit={null} />);
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'permission');
    expect(screen.getByRole('heading', { name: 'Connect to Astrid on this computer' })).toBeVisible();
    expect(connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(connect).toHaveBeenCalledOnce();
  });

  it.each(['not_running', 'refused', 'blocked'] as const)('%s drawn on the way out does not ask or navigate', (status) => {
    stubLocation(EDITOR_URL);
    const connect = vi.fn();
    render(<EditorConnectionPanel connection={connectionFor({ status }, { connect })} exit={{ left: () => {} }} />);
    expect(connect).not.toHaveBeenCalled();
    expectNoNavigation();
  });
});

describe('editor gate with a live connection', () => {
  const door = () => vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/v1/health')) return json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST });
    if (url.endsWith('/v1/realm')) return json({ realm_id: 'r', display_name: 'Studio' });
    throw new Error(`Unexpected request ${url}`);
  });

  /** Stands in for the editor: local state to lose, and a beforeunload guard like useEditorBrowserDefaults'. */
  function Editor({ unloads }: { unloads: { added: number; removed: number } }) {
    const [typed, setTyped] = useState('');
    useEffect(() => {
      const guard = () => {};
      window.addEventListener('beforeunload', guard);
      unloads.added += 1;
      return () => { window.removeEventListener('beforeunload', guard); unloads.removed += 1; };
    }, [unloads]);
    return <input data-testid="editor" aria-label="chat" value={typed} onChange={(event) => setTyped(event.target.value)} />;
  }

  function renderEditor(unloads: { added: number; removed: number }) {
    return render(
      <RuntimeConnectionProvider gated requireLocalNetworkPermission pollIntervalMs={600_000}>
        <RuntimeConnectionGate panel={(connection, exit) => <EditorConnectionPanel connection={connection} exit={exit} />}>
          <Editor unloads={unloads} />
        </RuntimeConnectionGate>
      </RuntimeConnectionProvider>,
    );
  }

  async function connected() {
    await waitFor(() => expect(screen.getByTestId('editor')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('runtime-not-connected')).not.toBeInTheDocument(), { timeout: 5000 });
  }

  it.each(['prompt', 'denied'] as const)('keeps the editor mounted, inert, under the step when the permission becomes %s, and restores it', async (lost) => {
    stubLocation(EDITOR_URL);
    vi.stubGlobal('fetch', door());
    const unloads = { added: 0, removed: 0 };
    renderEditor(unloads);
    await connected();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'unsent chat text' } });
    expect(unloads.added).toBe(1);

    // Site data cleared or the permission revoked, possibly in another tab: Chrome says so on the tab's return.
    permission.state = lost;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', lost === 'denied' ? 'blocked' : expect.stringMatching(/permission|pending/)));
    const editor = screen.getByTestId('editor');
    expect(editor).toHaveValue('unsent chat text');
    expect(editor.closest('[inert]')).not.toBeNull();
    // Never unmounted: the unload guard was neither removed nor re-added.
    expect(unloads).toEqual({ added: 1, removed: 0 });
    // Never "stopped": no claim about Astrid is made without the permission.
    expect(screen.queryByText(/Astrid stopped|isn't answering|running but/)).not.toBeInTheDocument();
    expectNoNavigation();

    permission.state = 'granted';
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.queryByTestId('runtime-not-connected')).not.toBeInTheDocument(), { timeout: 8000 });
    expect(screen.getByTestId('editor')).toBe(editor);
    expect(editor).toHaveValue('unsent chat text');
    expect(editor.closest('[inert]')).toBeNull();
    expect(unloads).toEqual({ added: 1, removed: 0 });
    expectNoNavigation();
  }, 20000);

  it('never navigates before a connection either, whatever state the page is in', async () => {
    stubLocation(EDITOR_URL);
    permission.state = 'prompt';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    renderEditor({ added: 0, removed: 0 });
    await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toBeInTheDocument());
    // Before any connection the step stands in for the editor, which is not mounted.
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument();
    expectNoNavigation();
  });
});
