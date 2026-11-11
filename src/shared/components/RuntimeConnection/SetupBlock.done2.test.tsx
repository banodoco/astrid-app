// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AstridStatusSection } from '@/shared/components/SettingsModal/sections/AstridStatusSection.tsx';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';
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
  it('the Setup block preserves consent and surface-specific choices, and update surfaces render none', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Chrome/131.0.0.0 Safari/537.36');
    mocks.clipboard.mockReset().mockResolvedValue(true);
    const standard = 'curl -fsSL https://astrid.haus/install | sh -s -- --yes';
    const settings = 'curl -fsSL https://astrid.haus/install | sh -s -- --update';
    // Install surfaces keep the Setup block. Settings' status section and the update cards no longer render one (UR-3).
    const surfaces = [
      { render: () => render(<RuntimeConnectionPanel connection={connectionFor({ status: 'not_running' })} />), command: standard },
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
        // Set up already: the plain install line, no saved choice flags.
        const expected = alreadySetUp ? 'curl -fsSL https://astrid.haus/install | sh' : surface.command;
        expect(setup.getByText(expected, { selector: 'pre code' }).textContent).toBe(expected);
        mocks.clipboard.mockClear();
        fireEvent.click(setup.getByRole('button', { name: /^(Copy command|Command copied)$/ }));
        await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledTimes(1));
        expect(mocks.clipboard).toHaveBeenLastCalledWith(expected);
        mocks.clipboard.mockClear();
        fireEvent.click(setup.getByRole('button', { name: new RegExp(`^(Copy instructions for your agent|${COPY.agent.copied.replace('.', '\\.')})$`) }));
        await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledTimes(1));
        const instructions = mocks.clipboard.mock.calls[0][0] as string;
        expect(instructions.split('\n')).toContain(expected);
        // Existing-install surfaces (update, Settings) keep saved choices: no consent question for them.
        const existingSurface = surface.command.endsWith('--update');
        if (alreadySetUp || existingSurface) expect(instructions).not.toContain('May I install Astrid');
        else expect(instructions).toContain('May I install Astrid with these setup choices?');
      }
      view.unmount();
    }

    // Update surfaces: no Setup region, checkbox or --update command. The update card's plain install line has its own copy button.
    const updateSurfaces = [
      { name: 'the Settings status section', render: () => render(<AstridStatusSection isOpen />), ready: () => screen.findByRole('status') },
      { name: 'the update card', render: () => render(<UpdateResolutionActions resolution={resolveUpdate({ installType: 'installer', updateReason: 'autostart-off' })} />), ready: () => screen.findByRole('code') },
    ];
    for (const surface of updateSurfaces) {
      localStorage.clear();
      sessionStorage.clear();
      const view = surface.render();
      await surface.ready();
      expect(screen.queryByRole('region', { name: 'Astrid setup' }), surface.name).toBeNull();
      expect(screen.queryByRole('checkbox', { name: "I've already set up Astrid" }), surface.name).toBeNull();
      expect(screen.queryByText(settings, { selector: 'pre code' }), surface.name).toBeNull();
      view.unmount();
    }
  });
});
