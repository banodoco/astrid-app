// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { RuntimeConnectionPill } from './RuntimeConnectionPill.tsx';
import { RUNTIME_CONNECTION_COPY as COPY } from './copy.ts';
import { CONNECTED_REALM, connectionFor } from './connectionFixture.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const healthy = (instanceId: string) => json({ status: 'ok', runtime_instance_id: instanceId });
/** Nothing answers: the gateway is gone. */
const unreachable = () => { throw new TypeError('Failed to fetch'); };

/** Answers the health route in order; the last answer repeats. Counts every call. */
function healthRoute(...answers: Array<() => Response>) {
  let index = 0;
  return vi.fn(async (_input: string, _init?: RequestInit) => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return answer();
  });
}

/** A health route whose answer the test changes while the page is watching. */
function switchableRoute(first: () => Response) {
  const route = { answer: first };
  const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => route.answer());
  return { route, fetchImpl };
}

const connected = (managedByPinokio = false) => connectionFor({ status: 'connected', realm: CONNECTED_REALM }, { managedByPinokio });
const status = () => screen.getByTestId('runtime-connection-status');

function onWindows() {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36');
}

describe('RuntimeConnectionPill', () => {
  it('connected: shows nothing, and says "Connected to Astrid" to a screen reader only', async () => {
    const fetchImpl = healthRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);

    expect(status()).toHaveAttribute('data-state', 'connected');
    expect(status()).toHaveClass('sr-only');
    expect(status()).toHaveTextContent('Connected to Astrid');
    expect(screen.queryByText(/Direct Journey/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Connected ·/)).not.toBeInTheDocument();
    await waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(status()).toHaveAttribute('data-state', 'connected');
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/\/api\/runtime\/v1\/health$/);
    expect(isRecoveryCardShowing()).toBe(false);
  });

  it('restarted on a new instance: one card with Reload, bottom-right with a gutter, and nothing else', async () => {
    const fetchImpl = healthRoute(healthy('instance-1'), healthy('instance-2'));
    const onReload = vi.fn();
    render(<RuntimeConnectionPill connection={connected()} onReload={onReload} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Astrid restarted' })).toBeInTheDocument();
    expect(screen.getByText('Reload to carry on. Your changes are kept.')).toBeInTheDocument();
    expect(status()).toHaveAttribute('data-state', 'restarted');
    expect(screen.queryByText('Reload needed')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const card = screen.getByRole('alert');
    expect(card).toHaveClass('fixed', 'right-4', 'bottom-20', 'sm:bottom-4', 'w-[calc(100%-2rem)]', 'max-w-sm', 'rounded-2xl', 'p-5');
    expect(card).not.toHaveClass('left-0');
    expect(screen.getByRole('heading')).toHaveClass('font-serif', 'text-base');
    expect(screen.getByText(COPY.restarted.sentence)).toHaveClass('text-sm', 'text-muted-foreground');
    expect(isRecoveryCardShowing()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('another identity behind the door after connecting is the same restart card, not a second message', async () => {
    const fetchImpl = healthRoute(healthy('instance-1'), json({ error: 'runtime_identity_mismatch' }, 503));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid restarted' })).toBeInTheDocument());
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByText(COPY.restarted.sentence)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(status()).toHaveAttribute('data-state', 'restarted');
  });

  it('Astrid down for two readings in a row: the "Astrid stopped" card with the install line, and no Connected', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { route, fetchImpl } = switchableRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    route.answer = unreachable;

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid stopped' })).toBeInTheDocument());
    expect(screen.getByText('Give these instructions to your coding agent to start Astrid again. Your changes are kept.')).toBeInTheDocument();
    expect(status()).toHaveAttribute('data-state', 'stopped');
    expect(status()).not.toHaveTextContent('Connected');
    expect(screen.getByRole('alert')).toHaveClass('fixed', 'right-4', 'bottom-20', 'sm:bottom-4');
    expect(isRecoveryCardShowing()).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: COPY.agent.commandCopy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(String(writeText.mock.calls[0][0])).toMatch(/^curl -fsSL https:\/\/astrid\.haus\/install \| sh$/);
  });

  it('Pinokio stopped card says where to start Astrid and has no installer or coding-agent instructions', async () => {
    const { route, fetchImpl } = switchableRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected(true)} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    route.answer = unreachable;

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid stopped' })).toBeInTheDocument());
    expect(screen.getByText(COPY.stopped.pinokioSentence)).toBeInTheDocument();
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: COPY.agent.commandCopy })).not.toBeInTheDocument();
  });

  it('Astrid answers a no-cors request but its CORS read fails: the refused card, with no install line and no "stopped"', async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    });
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: COPY.refused.title })).toBeInTheDocument());
    expect(status()).toHaveAttribute('data-state', 'refused');
    expect(screen.queryByRole('heading', { name: 'Astrid stopped' })).not.toBeInTheDocument();
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
  });

  it('when the permission is gone the pill blames nothing: it asks the permission first', async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    });
    const confirmPermission = vi.fn(async () => false);
    render(<RuntimeConnectionPill connection={{ ...connected(), confirmPermission }} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(confirmPermission.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(status()).toHaveAttribute('data-state', 'connected');
    expect(fetchImpl.mock.calls.every(([, init]) => init?.mode !== 'no-cors')).toBe(true);
  });

  it('names PowerShell on the stopped card on Windows', async () => {
    onWindows();
    const { route, fetchImpl } = switchableRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    route.answer = unreachable;

    await waitFor(() => expect(screen.getByText('Or run this yourself in PowerShell:')).toBeInTheDocument());
  });

  it('two answers that come late are busy: a calm card with no install command, and it clears when Astrid answers', async () => {
    vi.useFakeTimers();
    try {
      // A health request that never answers is aborted by the watch's own timer, which counts as a slow reading.
      const timeout = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
      const answer = { step: healthy('instance-1') as (init?: RequestInit) => Promise<Response> | Response };
      const busyFetch = vi.fn(async (_input: string, init?: RequestInit) => answer.step(init));
      render(<RuntimeConnectionPill connection={connected()} fetchImpl={busyFetch} restartCheckIntervalMs={3000} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(status()).toHaveAttribute('data-state', 'connected');

      answer.step = timeout;
      await act(async () => { await vi.advanceTimersByTimeAsync(3000 * 6); });
      expect(status()).toHaveAttribute('data-state', 'busy');
      expect(screen.getByRole('heading', { name: COPY.busy.title })).toBeInTheDocument();
      expect(screen.getByText(COPY.busy.sentence)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: COPY.agent.commandCopy })).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/curl|install/);
      expect(isRecoveryCardShowing()).toBe(true);

      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download diagnostics' })); await Promise.resolve(); });
      expect(screen.getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
      expect(screen.getByText(/astrid-runtime doctor.*astrid-diagnostics\.txt/)).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy for your agent' })); await Promise.resolve(); });
      expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/doctor.*log directory named in its report/));

      answer.step = healthy('instance-1');
      await act(async () => { await vi.advanceTimersByTimeAsync(3000 * 2); });
      expect(status()).toHaveAttribute('data-state', 'connected');
      expect(isRecoveryCardShowing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('busy-card diagnostics download uses the Runtime report when available', async () => {
    vi.useFakeTimers();
    try {
      const timeout = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
      const answer = { step: healthy('instance-1') as (init?: RequestInit) => Promise<Response> | Response };
      const busyFetch = vi.fn(async (_input: string, init?: RequestInit) => answer.step(init));
      const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagnostics');
      const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
      const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      const diagnosticsFetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/build.json') {
          return new Response(JSON.stringify({ app: 'served-app-build', release: 42 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ report: 'Astrid diagnostics\nApp build: served-app-build\nApp release: 42' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      vi.stubGlobal('fetch', diagnosticsFetch);
      render(<RuntimeConnectionPill connection={connected()} fetchImpl={busyFetch} restartCheckIntervalMs={3000} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      answer.step = timeout;
      await act(async () => { await vi.advanceTimersByTimeAsync(3000 * 6); });
      expect(status()).toHaveAttribute('data-state', 'busy');

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download diagnostics' })); await Promise.resolve(); });
      expect(anchorClick).toHaveBeenCalledOnce();
      const diagnosticsCall = diagnosticsFetch.mock.calls.find(([input]) => String(input).includes('/v1/diagnostics'));
      expect(diagnosticsCall).toBeDefined();
      const diagnosticsUrl = new URL(String(diagnosticsCall?.[0]), window.location.origin);
      expect(diagnosticsUrl.searchParams.get('app_build')).toBe('served-app-build');
      expect(diagnosticsUrl.searchParams.get('app_release')).toBe('42');
      expect(diagnosticsCall?.[1]).toEqual(expect.objectContaining({ cache: 'no-store' }));
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(await (createObjectURL.mock.calls[0][0] as Blob).text()).toContain('App build: served-app-build\nApp release: 42');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:diagnostics');
      expect(screen.queryByRole('button', { name: 'Copy for your agent' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('one dropped reading is not a stop', async () => {
    const fetchImpl = healthRoute(healthy('instance-1'), unreachable, healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);

    await waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(6));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(status()).toHaveAttribute('data-state', 'connected');
  });

  it('the stopped card clears by itself when the same Astrid answers again', async () => {
    const { route, fetchImpl } = switchableRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    route.answer = unreachable;

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid stopped' })).toBeInTheDocument());
    route.answer = healthy('instance-1');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(status()).toHaveAttribute('data-state', 'connected');
    expect(isRecoveryCardShowing()).toBe(false);
  });

  it('a new Astrid answering after the stop turns the stopped card into the restart card', async () => {
    const { route, fetchImpl } = switchableRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    route.answer = unreachable;
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid stopped' })).toBeInTheDocument());
    route.answer = healthy('instance-2');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid restarted' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Astrid stopped' })).not.toBeInTheDocument();
    expect(status()).toHaveAttribute('data-state', 'restarted');
  });

  it('the gateway answers 503 but the engine is down: two readings in a row show the "Astrid stopped" card', async () => {
    const { route, fetchImpl } = switchableRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    route.answer = json({ error: 'runtime_unavailable' }, 503);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid stopped' })).toBeInTheDocument());
    expect(status()).toHaveAttribute('data-state', 'stopped');
    expect(isRecoveryCardShowing()).toBe(true);
    expect(document.body.textContent).not.toMatch(/Runtime|workspace|realm|gateway|127\.0\.0\.1|npm run/);

    route.answer = healthy('instance-1');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(isRecoveryCardShowing()).toBe(false);
  });

  it('any other answer that is not ok (a 500, a 404) counts as a failed reading too', async () => {
    const { route, fetchImpl } = switchableRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    route.answer = json({ error: 'boom' }, 500);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid stopped' })).toBeInTheDocument());
  });

  it('one 503 between good readings is not a stop', async () => {
    const fetchImpl = healthRoute(healthy('instance-1'), json({ error: 'runtime_unavailable' }, 503), healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);

    await waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(6));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(status()).toHaveAttribute('data-state', 'connected');
  });

  it('re-checks on focus as well as on the interval', async () => {
    const fetchImpl = healthRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={60_000} />);

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // Let the first check settle, so the focus check is not skipped as still in flight.
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });

  it('the cards say Astrid and never name a Runtime, workspace, realm or command', async () => {
    const { route, fetchImpl } = switchableRoute(healthy('instance-1'));
    render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    route.answer = unreachable;
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid stopped' })).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/Runtime|workspace|realm|gateway|127\.0\.0\.1|npm run/);
    route.answer = healthy('instance-2');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Astrid restarted' })).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/Runtime|workspace|realm|gateway|127\.0\.0\.1|npm run/);
  });

  it.each(['not_running', 'refused'] as const)('renders nothing while %s, and asks Astrid nothing', (status) => {
    const fetchImpl = healthRoute(healthy('instance-1'));
    const { container } = render(
      <RuntimeConnectionPill connection={connectionFor({ status })} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets the editor go back to its own messages once the card is gone', async () => {
    const fetchImpl = healthRoute(healthy('instance-1'), healthy('instance-2'));
    const view = render(<RuntimeConnectionPill connection={connected()} fetchImpl={fetchImpl} restartCheckIntervalMs={5} />);
    await waitFor(() => expect(isRecoveryCardShowing()).toBe(true));
    view.unmount();
    expect(isRecoveryCardShowing()).toBe(false);
  });
});
