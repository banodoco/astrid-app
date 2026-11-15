// @vitest-environment jsdom
import { cloneElement } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppEventListener } from '@/shared/lib/typedEvents.ts';
import { ASTRID_STATUS_COPY } from '@/shared/components/SettingsModal/sections/astridStatusCopy.ts';

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

  it('keeps a required update to one line, with its reason and actions behind Show how', async () => {
    const reason = 'This update fixes problems that could keep a rented machine billing after a job, or lose a finished result.';
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 12 } });
    hostedCheckMock.mockResolvedValue({
      release: 12, app: 'app-a', servedRelease: 13, servedApp: 'app-b', behind: true,
      resolution: { installedRelease: 12, servedRelease: 13, requiredRelease: 13, requiredReason: reason, releaseBehind: true },
    });
    vi.resetModules();
    const { QuietUpdateNotice: RequiredPageNotice } = await import('./QuietUpdateNotice.tsx');
    render(<RequiredPageNotice connection={{ isConnected: true, managedByPinokio: false } as never} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const notice = await screen.findByTestId('quiet-update-notice');

    // Compact: only the summary line (title, Required, Show how) is visible; the reason and every action are collapsed.
    const disclosure = within(notice).getByTestId('required-update-reason');
    expect(disclosure.tagName).toBe('DETAILS');
    expect(disclosure).not.toHaveAttribute('open');
    const summary = disclosure.querySelector('summary')!;
    expect(notice.children).toHaveLength(1);
    expect(summary).toHaveTextContent('Update Astrid Required Show how');
    for (const text of ['Update Astrid', 'Required', 'Show how']) {
      const element = within(notice).getByText(text);
      expect(element).toBeVisible();
      expect(element.closest('summary')).toBe(summary);
    }
    const reasonLine = within(notice).getByText(`This update is required: ${reason}`);
    const collapsed = ['Copy instructions for your agent', 'Run it yourself', 'Details'].map((text) => within(notice).getByText(text));
    expect(reasonLine).not.toBeVisible();
    for (const element of collapsed) expect(element).not.toBeVisible();

    // Reachable: one click reveals the reason and the unchanged actions.
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute('open');
    expect(reasonLine).toBeVisible();
    for (const element of collapsed) expect(element).toBeVisible();
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

describe('required notice while an update is under way', () => {
  afterEach(() => { vi.doUnmock('@/shared/lib/updates/useInstallerUpdate.ts'); });

  /** A fresh page load whose shared update operation is in the given state, so the remount keeps reading the same state. */
  async function requiredPage(state: Record<string, unknown>) {
    readStatusMock.mockResolvedValue({ health: { status: 'ok', release: 12 } });
    hostedCheckMock.mockResolvedValue({
      release: 12, app: 'app-a', servedRelease: 13, servedApp: 'app-b', behind: true,
      resolution: { installedRelease: 12, servedRelease: 13, requiredRelease: 13, requiredReason: 'security fix', releaseBehind: true },
    });
    vi.resetModules();
    vi.doMock('@/shared/lib/updates/useInstallerUpdate.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/shared/lib/updates/useInstallerUpdate.ts')>()),
      useInstallerUpdate: () => ({
        releaseStatus: null, installType: 'installer', available: false, updateReason: undefined, updated: null,
        pending: false, error: null, restartRequired: false, fresh: true, status: null, start: vi.fn(), refresh: vi.fn(), ...state,
      }),
    }));
    const { QuietUpdateNotice: Notice } = await import('./QuietUpdateNotice.tsx');
    const element = <Notice connection={{ isConnected: true, managedByPinokio: false } as never} />;
    const mount = async () => {
      const view = render(element);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      return { view, element, notice: await screen.findByTestId('quiet-update-notice') };
    };
    return mount;
  }

  it.each([
    ['failed to start', { error: 'Astrid could not start the update. Check its status before trying again.' }, 'Astrid could not start the update. Check its status before trying again.'],
    ['failed', { status: { state: 'terminal', outcome: 'failed' } }, ASTRID_STATUS_COPY.repairDescription],
    ['in progress', { pending: true }, 'Update in progress. Astrid may disconnect while it restarts.'],
    ['needing a restart', { restartRequired: true }, 'Astrid restarted. Reload when your drafts can be saved.'],
  ] as const)('opens, without a click, for an update %s, and again after a remount', async (_label, state, line) => {
    const mount = await requiredPage(state);
    for (const pass of ['first mount', 'remount']) {
      const { view, notice } = await mount();
      const disclosure = within(notice).getByTestId('required-update-reason');
      expect(disclosure, pass).toHaveAttribute('open');
      expect(within(notice).getByText(line)).toBeVisible();
      view.unmount();
    }
  });

  it('stays collapsed while idle, and again after a remount', async () => {
    const mount = await requiredPage({});
    for (const pass of ['first mount', 'remount']) {
      const { view, notice } = await mount();
      expect(within(notice).getByTestId('required-update-reason'), pass).not.toHaveAttribute('open');
      expect(within(notice).getByText('Copy instructions for your agent')).not.toBeVisible();
      view.unmount();
    }
  });

  it('keeps the user\u2019s own toggle when the update state changes afterwards', async () => {
    const state: Record<string, unknown> = {};
    const mount = await requiredPage(state);
    const { view, element, notice } = await mount();
    const disclosure = within(notice).getByTestId('required-update-reason');
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The user opens it, then closes it again.
    fireEvent.click(disclosure.querySelector('summary')!);
    await settle();
    expect(disclosure).toHaveAttribute('open');
    fireEvent.click(disclosure.querySelector('summary')!);
    await settle();
    expect(disclosure).not.toHaveAttribute('open');
    // An update starting afterwards does not reopen what the user closed.
    state.pending = true;
    view.rerender(cloneElement(element));
    await settle();
    expect(within(notice).getByText('Update in progress. Astrid may disconnect while it restarts.')).toBeInTheDocument();
    expect(disclosure).not.toHaveAttribute('open');
  });
});
