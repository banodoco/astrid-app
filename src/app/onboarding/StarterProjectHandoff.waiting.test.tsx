import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_REQUEST_WAIT_MS } from '@/integrations/runtime/useRuntimeRequestWait.ts';
import { StarterProjectHandoff, PENDING_STARTER_PROJECT_KEY } from './StarterProjectHandoff.tsx';
import { prepareStarterProject, type StarterProjectSelection } from './prepareStarterProject.ts';

vi.mock('./prepareStarterProject.ts', () => ({ prepareStarterProject: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(prepareStarterProject).mockReset();
});
afterEach(() => vi.useRealTimers());

describe('StarterProjectHandoff while Runtime is slow', () => {
  it('shows the attention message without aborting a slow setup that later succeeds', async () => {
    const result = deferred<StarterProjectSelection>();
    vi.mocked(prepareStarterProject).mockReturnValue(result.promise);
    const ready = vi.fn();
    render(<StarterProjectHandoff onReady={ready} />);
    expect(screen.getByRole('status')).toHaveTextContent('Astrid is connected and getting your project ready.');
    const signal = vi.mocked(prepareStarterProject).mock.calls[0][0].signal!;

    await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_REQUEST_WAIT_MS); });
    expect(screen.getByRole('status')).toHaveTextContent('Astrid on this computer is taking longer than usual. You can keep waiting or try again.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(signal.aborted).toBe(false);

    await act(async () => result.resolve({ projectId: 'ready-project', timelineId: 'main' }));
    expect(ready).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open your project' }));
    expect(ready).toHaveBeenCalledWith({ projectId: 'ready-project', timelineId: 'main' });
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBeNull();
  });

  it('aborts retry predecessor, retains its intent, and ignores its late success', async () => {
    const first = deferred<StarterProjectSelection>();
    const second = deferred<StarterProjectSelection>();
    vi.mocked(prepareStarterProject).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const ready = vi.fn();
    render(<StarterProjectHandoff onReady={ready} onContinueWithoutProject={vi.fn()} />);
    const intentId = localStorage.getItem(PENDING_STARTER_PROJECT_KEY);
    const firstSignal = vi.mocked(prepareStarterProject).mock.calls[0][0].signal!;

    await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_REQUEST_WAIT_MS); });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(firstSignal.aborted).toBe(true);
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBe(intentId);
    expect(vi.mocked(prepareStarterProject)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prepareStarterProject).mock.calls[1][0].intentId).toBe(intentId);

    await act(async () => first.resolve({ projectId: 'obsolete', timelineId: 'old' }));
    expect(ready).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBe(intentId);

    await act(async () => second.resolve({ projectId: 'current-project', timelineId: 'main' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open your project' }));
    expect(ready).toHaveBeenCalledExactlyOnceWith({ projectId: 'current-project', timelineId: 'main' });
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBeNull();
  });

  it('ignores a late error from an aborted attempt after retry starts', async () => {
    const first = deferred<StarterProjectSelection>();
    const second = deferred<StarterProjectSelection>();
    vi.mocked(prepareStarterProject).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<StarterProjectHandoff onReady={vi.fn()} />);
    const intentId = localStorage.getItem(PENDING_STARTER_PROJECT_KEY);
    await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_REQUEST_WAIT_MS); });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => second.reject(new Error('current attempt failed')));
    expect(screen.getByRole('alert')).toHaveTextContent("Astrid on this computer couldn't set it up.");
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('current attempt failed')).toBeInTheDocument();

    await act(async () => first.reject(new Error('late obsolete error')));
    expect(screen.getByText('current attempt failed')).toBeInTheDocument();
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBe(intentId);
  });

  it('aborts when opening the editor and ignores a later completion', async () => {
    const result = deferred<StarterProjectSelection>();
    vi.mocked(prepareStarterProject).mockReturnValue(result.promise);
    const ready = vi.fn();
    const openEditor = vi.fn();
    render(<StarterProjectHandoff onReady={ready} onContinueWithoutProject={openEditor} />);
    const intentId = localStorage.getItem(PENDING_STARTER_PROJECT_KEY);
    const signal = vi.mocked(prepareStarterProject).mock.calls[0][0].signal!;

    await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_REQUEST_WAIT_MS); });
    fireEvent.click(screen.getByRole('button', { name: 'Open editor' }));
    expect(signal.aborted).toBe(true);
    expect(openEditor).toHaveBeenCalledOnce();
    await act(async () => result.resolve({ projectId: 'obsolete', timelineId: 'old' }));
    expect(ready).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBe(intentId);
  });
});
