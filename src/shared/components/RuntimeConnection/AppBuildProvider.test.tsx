import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBuildProvider } from './AppBuildProvider.tsx';

vi.mock('@/shared/lib/updates/appBuildWatch.ts', () => ({ useAppBuildWatch: () => true }));

afterEach(cleanup);

describe('AppBuildProvider stale-build notice', () => {
  it('stays above an interactive editor surface and reloads directly when clicked', () => {
    const reload = vi.fn();
    render(
      <AppBuildProvider reload={reload}>
        <div data-testid="editor-surface" className="fixed inset-0 z-[100100]">Editor</div>
      </AppBuildProvider>,
    );

    const notice = screen.getByRole('status');
    const editor = screen.getByTestId('editor-surface');
    expect(notice).toHaveClass('z-[100110]');
    expect(editor).toHaveClass('z-[100100]');
    expect(notice).toHaveTextContent('Editor updated · Reload');
    const reloadButton = screen.getByRole('button', { name: 'Reload' });
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledOnce();
  });
});
