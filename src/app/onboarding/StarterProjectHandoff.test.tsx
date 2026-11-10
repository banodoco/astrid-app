import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StarterProjectHandoff, PENDING_STARTER_PROJECT_KEY } from './StarterProjectHandoff.tsx';
import { prepareStarterProject, type StarterProjectSelection } from './prepareStarterProject.ts';
import { setUpGenerationInstructions } from '@/shared/components/RuntimeConnection/copy.ts';

vi.mock('./prepareStarterProject.ts', () => ({ prepareStarterProject: vi.fn() }));
const selection = { projectId: 'project', timelineId: 'main' };
beforeEach(() => {
  localStorage.clear();
  vi.mocked(prepareStarterProject).mockReset();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('StarterProjectHandoff', () => {
  it('offers generation setup instructions to copy for an agent', async () => {
    vi.mocked(prepareStarterProject).mockReturnValue(new Promise(() => {}));
    render(<StarterProjectHandoff onReady={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Set up image generation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy for your agent' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(setUpGenerationInstructions()));
    expect(await screen.findByRole('button', { name: 'Copied. Paste them into your agent.' })).toBeInTheDocument();
  });

  it('shares the in-flight attempt through StrictMode and completes once', async () => {
    let resolve!: (value: StarterProjectSelection) => void;
    vi.mocked(prepareStarterProject).mockReturnValue(new Promise(done => { resolve = done; }));
    const ready = vi.fn();
    render(<StrictMode><StarterProjectHandoff onReady={ready} /></StrictMode>);
    expect(prepareStarterProject).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBeTruthy();
    await act(async () => resolve(selection));
    expect(ready).toHaveBeenCalledExactlyOnceWith(selection);
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBeNull();
  });

  it('retains the same persisted intent across failure, remount and Retry', async () => {
    vi.mocked(prepareStarterProject).mockRejectedValue(new Error('Runtime disconnected'));
    const first = render(<StarterProjectHandoff onReady={vi.fn()} />);
    await screen.findByRole('alert');
    const intentId = localStorage.getItem(PENDING_STARTER_PROJECT_KEY);
    first.unmount();
    const ready = vi.fn();
    render(<StarterProjectHandoff onReady={ready} />);
    await screen.findByRole('alert');
    vi.mocked(prepareStarterProject).mockResolvedValue(selection);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(ready).toHaveBeenCalledWith(selection));
    expect(vi.mocked(prepareStarterProject).mock.calls.map(([input]) => input.intentId)).toEqual([intentId, intentId, intentId]);
  });

  it('does not navigate or clear the recovery token after leaving during creation', async () => {
    let resolve!: (value: StarterProjectSelection) => void;
    vi.mocked(prepareStarterProject).mockReturnValue(new Promise(done => { resolve = done; }));
    const ready = vi.fn();
    const view = render(<StarterProjectHandoff onReady={ready} />);
    view.unmount();
    await act(async () => resolve(selection));
    expect(ready).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBeTruthy();
  });

  it('lets a user enter the editor after setup fails without fabricating a selection', async () => {
    vi.mocked(prepareStarterProject).mockRejectedValue(new Error('Your only project is archived. Unarchive it or create a new one in the editor.'));
    const ready = vi.fn();
    const openEditor = vi.fn();
    render(<StarterProjectHandoff onReady={ready} onContinueWithoutProject={openEditor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open editor' }));
    expect(openEditor).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByText('Your only project is archived. Unarchive it or create a new one in the editor.')).toBeInTheDocument();
  });

  it('shows the archived-only message and keeps Open editor available', async () => {
    vi.mocked(prepareStarterProject).mockRejectedValue(new Error('Your only project is archived. Unarchive it or create a new one in the editor.'));
    render(<StarterProjectHandoff onReady={vi.fn()} onContinueWithoutProject={vi.fn()} />);
    await screen.findByRole('alert');
    expect(screen.getByText('Your only project is archived. Unarchive it or create a new one in the editor.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open editor' })).toBeInTheDocument();
  });
});
