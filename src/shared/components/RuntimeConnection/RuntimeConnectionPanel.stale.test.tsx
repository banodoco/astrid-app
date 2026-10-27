import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConnectionPanel } from './RuntimeConnectionPanel.tsx';
import { connectionFor } from './connectionFixture.ts';

vi.mock('./AppBuildProvider.tsx', () => ({ usePageStale: () => true }));

afterEach(cleanup);

describe('stale page connection card', () => {
  it('replaces a schema update card with the hard Reload action', () => {
    render(<RuntimeConnectionPanel connection={connectionFor({ status: 'update_needed' })} />);
    expect(screen.getByRole('heading', { name: 'Editor updated' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Update Astrid' })).toBeNull();
  });
});
