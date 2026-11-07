// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomeFlow } from '@/app/onboarding/WelcomeFlow.tsx';
import { AstridStatusSection } from '@/shared/components/SettingsModal/sections/AstridStatusSection.tsx';
import { RuntimeConnectionPanel } from './RuntimeConnectionPanel.tsx';
import { connectionFor } from './connectionFixture.ts';
import { RUNTIME_CONNECTION_COPY as COPY } from './copy.ts';

const mocks = vi.hoisted(() => ({ clipboard: vi.fn() }));
vi.mock('@/shared/lib/browser/clipboard.ts', () => ({ writeClipboardTextSafe: mocks.clipboard }));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/RuntimeConnectionProvider.tsx')>()),
  useRuntimeConnection: () => connectionFor({ status: 'not_running' }),
}));
vi.mock('@/shared/lib/updates/useInstallerUpdate.ts', () => ({
  useInstallerUpdate: () => ({ installType: 'installer', health: { identity: { managed_by: null } } }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('done2', () => {
  it('the Setup block preserves consent and surface-specific choices', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Chrome/131.0.0.0 Safari/537.36');
    mocks.clipboard.mockReset().mockResolvedValue(true);
    const standard = 'curl -fsSL https://astrid.haus/install | sh -s -- --yes';
    const settings = 'curl -fsSL https://astrid.haus/install | sh -s -- --update';
    const surfaces = [
      { render: () => render(<WelcomeFlow entry="setup" />), command: standard },
      { render: () => render(<RuntimeConnectionPanel connection={connectionFor({ status: 'not_running' })} />), command: standard },
      { render: () => render(<AstridStatusSection isOpen />), command: settings },
    ];

    for (const surface of surfaces) {
      localStorage.clear();
      sessionStorage.clear();
      const view = surface.render();
      const setup = within(await screen.findByRole('region', { name: 'Astrid setup' }));
      const checkbox = setup.getByRole('checkbox', { name: "I've already set up Astrid" });
      // Exercise both wordings, regardless of the surface's initial remembered state.
      for (const alreadySetUp of [false, true]) {
        if ((checkbox as HTMLInputElement).checked !== alreadySetUp) fireEvent.click(checkbox);
        expect(setup.getByText(alreadySetUp ? 'Start Astrid' : 'Recommended setup')).toBeInTheDocument();
        expect(setup.getByText(surface.command, { selector: 'pre code' }).textContent).toBe(surface.command);
        mocks.clipboard.mockClear();
        fireEvent.click(setup.getByRole('button', { name: /^(Copy command|Command copied)$/ }));
        await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledTimes(1));
        expect(mocks.clipboard).toHaveBeenLastCalledWith(surface.command);
        mocks.clipboard.mockClear();
        fireEvent.click(setup.getByRole('button', { name: new RegExp(`^(Copy instructions for your agent|${COPY.agent.copied.replace('.', '\\.')})$`) }));
        await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledTimes(1));
        const instructions = mocks.clipboard.mock.calls[0][0] as string;
        expect(instructions.split('\n')).toContain(surface.command);
        if (alreadySetUp) expect(instructions).not.toContain('May I install Astrid with these setup choices?');
        else expect(instructions).toContain('May I install Astrid with these setup choices?');
      }
      view.unmount();
    }
  });
});
