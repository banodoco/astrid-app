// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';
import { useAppEventListener } from '@/shared/lib/typedEvents.ts';
import { ASTRID_COMMANDS, installCommand } from './copy.ts';
import { registerDraftSafeReloadGuard } from '@/shared/lib/updates/draftSafeReload.ts';
import type { InstallerUpdateView } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { INSTALLER_UPDATE_REASON_MESSAGES } from '@/integrations/runtime/client.ts';

const installerResolutions = [
  ['Update now', resolveUpdate({ compatibility: { kind: 'schema', detail: 'Update required' }, installType: 'installer', updateNowAvailable: true })],
  ['Update', resolveUpdate({ installType: 'installer', updateReason: 'recovery-needed', updateNowAvailable: true })],
] as const;

beforeEach(() => localStorage.clear());

function installerOperation(start = vi.fn(async () => undefined)): InstallerUpdateView {
  return { available: true, pending: false, start } as unknown as InstallerUpdateView;
}

function mountWithEventCapture(resolution: ReturnType<typeof resolveUpdate>, installType?: 'pinokio' | 'source' | 'fully-local' | 'installer') {
  const onOpen = vi.fn();
  function Capture() {
    useAppEventListener('openSettings', onOpen);
    return <UpdateResolutionActions resolution={resolution} installType={installType} />;
  }
  render(<Capture />);
  return onOpen;
}

describe('update resolution after an in-app update ends', () => {
  const finished = (outcome: 'failed' | 'updated') => ({
    available: true, pending: false, fresh: true, error: null, installType: 'installer',
    status: { available: true, self_update: true, state: 'terminal', outcome, operation_id: 'op-1', result: 'Update finished.' },
    start: vi.fn(async () => undefined),
  }) as unknown as InstallerUpdateView;

  it('offers the plain install line as the next action after a failed update, not --update', () => {
    render(<UpdateResolutionActions resolution={resolveUpdate({ installType: 'installer', installedRelease: 3, servedRelease: 3 })} operation={finished('failed')} />);
    expect(screen.getByText('The update did not complete. Download diagnostics to see why.')).toBeInTheDocument();
    expect(screen.getByRole('code')).toHaveTextContent(ASTRID_COMMANDS.macLinux);
    expect(screen.getByRole('code').textContent).not.toContain('--update');
  });

  it('a failed update offers both ways to repair and points to the full story', () => {
    const failed = finished('failed');
    const operation = { ...failed, status: { ...failed.status, log_path: '/Users/me/Library/Logs/Astrid Runtime/install.log' } } as unknown as InstallerUpdateView;
    render(<UpdateResolutionActions resolution={resolveUpdate({ installType: 'installer', installedRelease: 3, servedRelease: 3 })} operation={operation} />);
    expect(screen.getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(screen.getAllByRole('code')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
    expect(screen.getByText('Details: /Users/me/Library/Logs/Astrid Runtime/install.log')).toBeInTheDocument();
  });

  it('Settings keeps its own Diagnostics row, so a failed update there adds no second button', () => {
    render(<UpdateResolutionActions resolution={resolveUpdate({ installType: 'installer', installedRelease: 3, servedRelease: 3 }, 'settings')} operation={finished('failed')} context="settings" />);
    expect(screen.getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download diagnostics' })).toBeNull();
  });

  it('does not offer the install line after an update that finished', () => {
    render(<UpdateResolutionActions resolution={resolveUpdate({ installType: 'installer', installedRelease: 3, servedRelease: 3 })} operation={finished('updated')} />);
    expect(screen.queryByRole('code')).toBeNull();
  });
});

describe('update resolution Settings actions', () => {
  it('shows the plain install line, not --update, when an install needs repair', () => {
    const resolution = resolveUpdate({ installType: 'installer', updateReason: 'needs-repair', installedRelease: 10, servedRelease: 10 });
    render(<UpdateResolutionActions resolution={resolution} />);
    expect(screen.getByRole('code')).toHaveTextContent(ASTRID_COMMANDS.macLinux);
    expect(screen.getByRole('code').textContent).not.toContain('--update');
    expect(screen.getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
  });

  it('shows the plain install line, not --update, when Update Now is refused for autostart off', () => {
    const resolution = resolveUpdate({ installType: 'installer', updateReason: 'autostart-off' });
    render(<UpdateResolutionActions resolution={resolution} />);
    expect(screen.getByText('Run this command, then start Astrid:')).toBeInTheDocument();
    expect(screen.getByRole('code')).toHaveTextContent(ASTRID_COMMANDS.macLinux);
    expect(screen.getByRole('code').textContent).not.toContain('--update');
    expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy instructions for your agent' })).not.toBeInTheDocument();
  });

  it('routes a soft update nudge to the expanded Updates destination and preserves the URL hash', () => {
    window.history.replaceState({}, '', '/tools/video-editor?project=film#edit');
    const onOpen = mountWithEventCapture(resolveUpdate({ installedRelease: 1, servedRelease: 2, releaseBehind: true }));
    fireEvent.click(screen.getByRole('button', { name: 'See updates' }));
    // See updates already goes to Settings Updates, so the card does not repeat it as Details.
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
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

  it('leaves Details out in Settings, which is the Details destination', () => {
    render(<UpdateResolutionActions resolution={resolveUpdate({ compatibility: { kind: 'schema', detail: 'Update required' }, installType: 'pinokio' }, 'settings')} context="settings" />);
    expect(screen.getByText('Update in Pinokio')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
  });

  it('shows the install update command for fully-local installs', () => {
    mountWithEventCapture(resolveUpdate({ compatibility: { kind: 'schema', detail: 'Update required' }, installType: 'fully-local' }), 'fully-local');
    expect(screen.getByRole('code')).toHaveTextContent(installCommand('update'));
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  });

  it.each(installerResolutions)('flushes registered drafts before starting the explicit installer %s action', async (label, resolution) => {
    const events: string[] = [];
    const flush = vi.fn(async () => { events.push('flush'); });
    const start = vi.fn(async () => { events.push('start'); });
    const clipboard = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const unregister = registerDraftSafeReloadGuard({ label: 'editor draft', flush });
    try {
      render(<UpdateResolutionActions resolution={resolution} operation={installerOperation(start)} />);
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
        if (label === 'Update now') {
          expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
          const command = installCommand('update');
          expect(screen.getByText(command, { exact: true })).toBeInTheDocument();
          fireEvent.click(screen.getByRole('button', { name: 'Copy instructions for your agent' }));
          await waitFor(() => expect(clipboard).toHaveBeenCalledOnce());
          expect(clipboard.mock.calls[0][0]).toContain(command);
          expect(clipboard.mock.calls[0][0]).not.toContain('May I update Astrid');
          expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
        }
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(events).toEqual(['flush', 'start']);
    } finally {
      unregister();
    }
  });

  it.each(installerResolutions)('shows a flush error and does not start or post the explicit installer %s action', async (label, resolution) => {
    const updatePost = vi.fn();
    const start = vi.fn(async () => { await fetch('/v1/update', { method: 'POST' }); });
    vi.stubGlobal('fetch', updatePost);
    const unregister = registerDraftSafeReloadGuard({ label: 'editor draft', flush: async () => { throw new Error('draft store unavailable'); } });
    try {
      render(<UpdateResolutionActions resolution={resolution} operation={installerOperation(start)} />);
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(await screen.findByRole('alert')).toHaveTextContent('draft store unavailable');
      expect(start).not.toHaveBeenCalled();
      expect(updatePost).not.toHaveBeenCalled();
    } finally {
      unregister();
      vi.unstubAllGlobals();
    }
  });
});

describe('update resolution in-app availability', () => {
  it('shows Update now disabled while a busy Astrid refuses the start, with no command', () => {
    const start = vi.fn(async () => undefined);
    const operation = { available: true, pending: false, start, updateReason: 'busy' } as unknown as InstallerUpdateView;
    const resolution = resolveUpdate({ installType: 'installer', updateReason: 'busy', updateNowAvailable: true });
    render(<UpdateResolutionActions resolution={resolution} operation={operation} />);
    const button = screen.getByRole('button', { name: 'Update now' });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Copy instructions for your agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run it yourself' })).not.toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });

  it('hides Update now and shows the one-line reason with the command when Astrid cannot update itself', () => {
    const operation = { available: false, pending: false, start: vi.fn(), updateReason: undefined } as unknown as InstallerUpdateView;
    const resolution = resolveUpdate({ installType: 'installer', releaseBehind: true, installedRelease: 10, servedRelease: 11 }, 'settings');
    render(<UpdateResolutionActions resolution={resolution} operation={operation} />);
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(screen.getByText(INSTALLER_UPDATE_REASON_MESSAGES['self-update-unavailable'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
  });
});

describe('autostart-off card', () => {
  it('shows the new copy, the strict update command, the agent action, and no Update now', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    expect(INSTALLER_UPDATE_REASON_MESSAGES['autostart-off']).toBe('Start at sign-in is off, so update from a terminal. This command updates Astrid and starts it; your choice stays off.');
    render(<UpdateResolutionActions resolution={resolveUpdate({ installType: 'installer', updateReason: 'autostart-off' })} />);
    expect(screen.getByText(INSTALLER_UPDATE_REASON_MESSAGES['autostart-off'])).toBeInTheDocument();
    expect(screen.getByRole('code')).toHaveTextContent(ASTRID_COMMANDS.macLinuxUpdate);
    expect(screen.getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(document.body.textContent).not.toContain('then start Astrid');
  });
});

describe('windows-upgrade-unsupported', () => {
  const resolution = (context: 'page' | 'settings') => resolveUpdate({ installType: 'installer', installedRelease: 10, servedRelease: 11, releaseBehind: true, updateReason: 'windows-upgrade-unsupported', updateNowAvailable: true, selfUpdate: true }, context);

  it('on the page: no Update now; the copy and manual actions sit beside Download diagnostics', () => {
    render(<UpdateResolutionActions resolution={resolution('page')} operation={installerOperation()} />);
    expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
    expect(screen.getByRole('code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(INSTALLER_UPDATE_REASON_MESSAGES['self-update-unavailable']);
  });

  it('on the page: offers Copy instructions for your agent and the manual command, with Download diagnostics', () => {
    render(<UpdateResolutionActions resolution={resolution('page')} operation={installerOperation()} />);
    expect(screen.getByRole('button', { name: 'Copy instructions for your agent' })).toBeInTheDocument();
    expect(document.body.textContent).toContain('Run it yourself');
    expect(screen.getByRole('code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
  });

  it('in Settings: the manual command is offered too; its own Diagnostics row is the pointer', () => {
    const { container } = render(<UpdateResolutionActions resolution={resolution('settings')} operation={installerOperation()} context="settings" />);
    expect(screen.getByRole('code')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Run the command below');
  });
});
