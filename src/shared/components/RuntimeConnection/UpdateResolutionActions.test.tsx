// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';
import { useAppEventListener } from '@/shared/lib/typedEvents.ts';
import { installCommand } from './copy.ts';
import { registerDraftSafeReloadGuard } from '@/shared/lib/updates/draftSafeReload.ts';
import type { InstallerUpdateView } from '@/shared/lib/updates/useInstallerUpdate.ts';

const installerResolution = resolveUpdate({
  compatibility: { kind: 'schema', detail: 'Update required' },
  installType: 'installer',
  updateNowAvailable: true,
});

function installerOperation(start = vi.fn(async () => undefined)): InstallerUpdateView {
  return { available: true, pending: false, start } as unknown as InstallerUpdateView;
}

function mountWithEventCapture(resolution: ReturnType<typeof resolveUpdate>) {
  const onOpen = vi.fn();
  function Capture() {
    useAppEventListener('openSettings', onOpen);
    return <UpdateResolutionActions resolution={resolution} />;
  }
  render(<Capture />);
  return onOpen;
}

describe('update resolution Settings actions', () => {
  it('routes a soft update nudge to the expanded Updates destination and preserves the URL hash', () => {
    window.history.replaceState({}, '', '/tools/video-editor?project=film#edit');
    const onOpen = mountWithEventCapture(resolveUpdate({ installedRelease: 1, servedRelease: 2, releaseBehind: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
    expect(window.location.search).toContain('project=film');
    expect(window.location.hash).toBe('#edit');
  });

  it('keeps a hard card action in place and adds Details to the same Settings destination', () => {
    const onOpen = mountWithEventCapture(resolveUpdate({ compatibility: { kind: 'schema', detail: 'Update required' }, installType: 'pinokio' }));
    expect(screen.getByText('Update in Pinokio')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
  });

  it('shows the install update command for fully-local installs', () => {
    mountWithEventCapture(resolveUpdate({ compatibility: { kind: 'schema', detail: 'Update required' }, installType: 'fully-local' }));
    expect(screen.getByRole('code')).toHaveTextContent(installCommand('update'));
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  });

  it('flushes registered drafts before starting an explicit installer update', async () => {
    const events: string[] = [];
    const flush = vi.fn(async () => { events.push('flush'); });
    const start = vi.fn(async () => { events.push('start'); });
    const unregister = registerDraftSafeReloadGuard({ label: 'editor draft', flush });
    try {
      render(<UpdateResolutionActions resolution={installerResolution} operation={installerOperation(start)} />);
      fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(events).toEqual(['flush', 'start']);
    } finally {
      unregister();
    }
  });

  it('shows a flush error and does not start or post an explicit installer update', async () => {
    const updatePost = vi.fn();
    const start = vi.fn(async () => { await fetch('/api/updates'); });
    vi.stubGlobal('fetch', updatePost);
    const unregister = registerDraftSafeReloadGuard({ label: 'editor draft', flush: async () => { throw new Error('draft store unavailable'); } });
    try {
      render(<UpdateResolutionActions resolution={installerResolution} operation={installerOperation(start)} />);
      fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('draft store unavailable');
      expect(start).not.toHaveBeenCalled();
      expect(updatePost).not.toHaveBeenCalled();
    } finally {
      unregister();
      vi.unstubAllGlobals();
    }
  });

  it('uses the same draft guard after agent-turn confirmation', async () => {
    const start = vi.fn(async () => undefined);
    const unregister = registerDraftSafeReloadGuard({ label: 'editor draft', flush: async () => { throw new Error('draft store unavailable'); } });
    const queryClient = new QueryClient();
    queryClient.setQueryData(['timeline-agent-session', 'active'], { status: 'processing' });
    try {
      render(<QueryClientProvider client={queryClient}><UpdateResolutionActions resolution={installerResolution} operation={installerOperation(start)} /></QueryClientProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
      expect(await screen.findByRole('button', { name: 'Update anyway' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update anyway' })); });
      expect(await screen.findByRole('alert')).toHaveTextContent('draft store unavailable');
      expect(start).not.toHaveBeenCalled();
    } finally {
      unregister();
      queryClient.clear();
    }
  });
});
