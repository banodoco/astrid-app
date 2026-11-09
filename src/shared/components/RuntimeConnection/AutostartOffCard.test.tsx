// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { connectionFor } from './connectionFixture.ts';
import { RuntimeConnectionPanel } from './RuntimeConnectionPanel.tsx';
import { INSTALLER_UPDATE_REASON_MESSAGES } from '@/integrations/runtime/installerUpdateReasons.ts';

vi.mock('@/shared/components/RuntimeConnection/AppBuildProvider.tsx', () => ({ usePageStale: () => false }));
vi.mock('@/shared/lib/updates/useInstallerUpdate.ts', () => ({
  useInstallerUpdate: () => ({ installType: 'installer', available: true, updateReason: 'autostart-off', health: { identity: { managed_by: null } } }),
}));

describe('autostart-off card on the page', () => {
  it('shows the reason sentence once, directly above the agent action and the command', () => {
    render(<RuntimeConnectionPanel connection={connectionFor({ status: 'update_needed' }, { managedByPinokio: false })} />);
    const shown = screen.getAllByText(INSTALLER_UPDATE_REASON_MESSAGES['autostart-off']);
    expect(shown).toHaveLength(1);
    const agent = screen.getByRole('button', { name: 'Copy instructions for your agent' });
    expect(shown[0].compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(shown[0].compareDocumentPosition(screen.getByRole('code')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
