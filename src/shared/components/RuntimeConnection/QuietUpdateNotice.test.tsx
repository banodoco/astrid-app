// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppEventListener } from '@/shared/lib/typedEvents.ts';

const { readStatusMock, hostedCheckMock, localCheckMock } = vi.hoisted(() => ({ readStatusMock: vi.fn(), hostedCheckMock: vi.fn(), localCheckMock: vi.fn() }));
vi.mock('@/integrations/runtime/client.ts', () => ({ AstridRuntimeClient: class { readInstallerUpdateHealth = async () => (await readStatusMock()).health; } }));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => 'https://astrid.test', runtimeApiBase: () => 'https://astrid.test/api/runtime' }));
vi.mock('@/shared/lib/updates/updateStatus.ts', () => ({ checkHostedUpdate: hostedCheckMock, checkLocalUpdate: localCheckMock }));
vi.mock('./AppBuildProvider.tsx', () => ({ usePageStale: () => false }));

import { QuietUpdateNotice } from './QuietUpdateNotice.tsx';

describe('quiet Update available notice', () => {
  it('uses the shared resolver once per page load and routes its action to Settings Updates', async () => {
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 3 } });
    hostedCheckMock.mockResolvedValue({
      release: 3, app: 'app-a', servedRelease: 4, servedApp: 'app-b', behind: true,
      resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true },
    });
    const onOpen = vi.fn();
    function Capture({ id }: { id: string }) {
      useAppEventListener('openSettings', onOpen);
      return <QuietUpdateNotice key={id} connection={{ isConnected: true, managedByPinokio: false } as never} />;
    }
    window.history.replaceState({}, '', '/tools/video-editor#edit');
    const view = render(<Capture id="first" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(readStatusMock).toHaveBeenCalledOnce();
    expect(hostedCheckMock).toHaveBeenCalledOnce();
    expect(screen.getByTestId('quiet-update-notice')).toHaveTextContent('Update available: Release 4');
    fireEvent.click(screen.getByRole('button', { name: 'See updates' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
    expect(window.location.hash).toBe('#edit');
    await act(async () => { view.rerender(<Capture id="remounted" />); });
    expect(readStatusMock).toHaveBeenCalledOnce();
  });

  it('offers a Pinokio Astrid only Pinokio\u2019s Update in the bottom-left notice', async () => {
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 3, identity: { managed_by: 'pinokio', release: 3 } } });
    hostedCheckMock.mockResolvedValue({
      release: 3, app: 'app-a', servedRelease: 5, servedApp: 'app-b', behind: true, managedBy: 'pinokio',
      resolution: { installedRelease: 3, servedRelease: 5, requiredRelease: 4, requiredReason: 'security fix', releaseBehind: true },
    });
    // The status is read once per page load, so this page load starts from a fresh module.
    vi.resetModules();
    const { QuietUpdateNotice: PinokioPageNotice } = await import('./QuietUpdateNotice.tsx');
    render(<PinokioPageNotice connection={{ isConnected: true, managedByPinokio: true } as never} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const notice = await screen.findByTestId('quiet-update-notice');

    expect(notice).toHaveTextContent('This update is required: security fix');
    expect(notice).toHaveTextContent('Update in Pinokio');
    expect(notice.querySelector('code')).toBeNull();
    for (const name of ['Copy instructions for your agent', 'Copy for your agent', 'Copy command', 'See updates', 'Update now']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(notice.textContent).not.toContain('Run it yourself');
  });

  it('sits under the editor tour\u2019s dimming shield, inert, while the tour runs', async () => {
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 3 } });
    hostedCheckMock.mockResolvedValue({
      release: 3, app: 'app-a', servedRelease: 4, servedApp: 'app-b', behind: true,
      resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true },
    });
    vi.resetModules();
    const { QuietUpdateNotice: TourPageNotice } = await import('./QuietUpdateNotice.tsx');
    const { startEditorTour, exitEditorTour } = await import('@/shared/state/editorTourStore.ts');
    const { UI_Z_LAYERS } = await import('@/shared/lib/uiLayers.ts');
    render(<TourPageNotice connection={{ isConnected: true, managedByPinokio: false } as never} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const notice = await screen.findByTestId('quiet-update-notice');
    expect(notice).toHaveClass('z-[100110]');
    expect(notice.style.zIndex).toBe('');
    expect(notice).not.toHaveAttribute('inert');
    act(() => startEditorTour());
    expect(Number(notice.style.zIndex)).toBeLessThan(UI_Z_LAYERS.EDITOR_TOUR_SHIELD);
    expect(notice).toHaveAttribute('inert');
    act(() => exitEditorTour());
    expect(notice.style.zIndex).toBe('');
    expect(notice).not.toHaveAttribute('inert');
  });
});
