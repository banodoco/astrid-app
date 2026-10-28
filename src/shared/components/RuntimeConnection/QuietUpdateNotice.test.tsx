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
    expect(screen.getByTestId('quiet-update-notice')).toHaveTextContent('Update available · release 4');
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
    expect(window.location.hash).toBe('#edit');
    await act(async () => { view.rerender(<Capture id="remounted" />); });
    expect(readStatusMock).toHaveBeenCalledOnce();
  });
});
