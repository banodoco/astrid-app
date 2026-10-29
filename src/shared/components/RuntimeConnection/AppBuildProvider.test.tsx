import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBuildProvider } from './AppBuildProvider.tsx';
import { flushDraftsBeforeReload, registerDraftSafeReloadGuard } from '@/shared/lib/updates/draftSafeReload.ts';

vi.mock('@/shared/lib/updates/appBuildWatch.ts', () => ({ useAppBuildWatch: () => true }));

afterEach(cleanup);

describe('AppBuildProvider stale-build notice', () => {
  it('stays above an interactive editor surface and reloads after mounted drafts flush', async () => {
    const reload = vi.fn();
    const flush = vi.fn(async () => undefined);
    const unregister = registerDraftSafeReloadGuard({ label: 'Timeline', flush });
    render(
      <AppBuildProvider reload={reload}>
        <div data-testid="editor-surface" className="fixed inset-0 z-[100100]">Editor</div>
      </AppBuildProvider>,
    );

    const notice = screen.getByRole('status');
    const editor = screen.getByTestId('editor-surface');
    expect(notice).toHaveClass('z-[100110]');
    expect(editor).toHaveClass('z-[100100]');
    expect(notice).toHaveTextContent('Editor updated · Reload');
    const reloadButton = screen.getByRole('button', { name: 'Reload' });
    fireEvent.click(reloadButton);
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(flush).toHaveBeenCalledOnce();
    unregister();
  });

  it('keeps the page open and shows an error when a draft cannot be saved', async () => {
    const reload = vi.fn();
    const unregister = registerDraftSafeReloadGuard({ label: 'Agent chat', flush: async () => { throw new Error('bridge unavailable'); } });
    render(<AppBuildProvider reload={reload}>Editor</AppBuildProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent chat: bridge unavailable');
    expect(reload).not.toHaveBeenCalled();
    unregister();
  });

  it('runs another flush wave when an earlier draft becomes dirty while another guard is saving', async () => {
    let timelineDirty = true;
    let timelineFlushes = 0;
    let releaseChat!: () => void;
    const chatPaused = new Promise<void>((resolve) => { releaseChat = resolve; });
    let chatFlushes = 0;
    const unregisterTimeline = registerDraftSafeReloadGuard({
      label: 'Timeline',
      flush: async () => { timelineFlushes++; timelineDirty = false; },
      isDirty: () => timelineDirty,
    });
    const unregisterChat = registerDraftSafeReloadGuard({
      label: 'Agent chat',
      flush: async () => {
        chatFlushes++;
        if (chatFlushes === 1) { await chatPaused; timelineDirty = true; }
      },
    });

    const flushing = flushDraftsBeforeReload();
    releaseChat();
    await flushing;

    expect(timelineFlushes).toBe(2);
    expect(chatFlushes).toBe(2);
    expect(timelineDirty).toBe(false);
    unregisterTimeline();
    unregisterChat();
  });
});
