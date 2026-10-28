import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeCompatibilityError } from '@/integrations/runtime/client.ts';
import { RuntimeConnectorRecoveryBanner } from './RuntimeConnectorRecoveryBanner.tsx';

vi.mock('./AppBuildProvider.tsx', () => ({ usePageStale: () => true }));

afterEach(cleanup);

describe('stale page resolver action', () => {
  it('shows Reload and no Update action for a schema mismatch', () => {
    render(<RuntimeConnectorRecoveryBanner error={new RuntimeCompatibilityError('schema', 'Schema mismatch', '/api/runtime')} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Editor updated');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByText('Update Astrid')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull();
  });
});
