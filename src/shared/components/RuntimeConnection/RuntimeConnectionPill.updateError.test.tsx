// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CONNECTED_REALM, connectionFor } from './connectionFixture.ts';

vi.mock('./useRuntimeRestartWatch.ts', () => ({ useRuntimeRestartWatch: () => 'restarted' }));
vi.mock('@/shared/lib/updates/useInstallerUpdate.ts', () => ({
  useInstallerUpdate: () => ({ pending: false, fresh: false, error: 'Could not check Astrid update status.', status: null }),
}));

const { RuntimeConnectionPill } = await import('./RuntimeConnectionPill.tsx');

describe('the restarted card when the update status could not be confirmed', () => {
  it('offers the Download diagnostics it asks for', () => {
    render(<RuntimeConnectionPill connection={connectionFor({ status: 'connected', realm: CONNECTED_REALM })} onReload={vi.fn()} />);
    expect(screen.getByText('Could not confirm the update status. Download diagnostics before trying again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeInTheDocument();
  });
});
