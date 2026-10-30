// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';
import { useAppEventListener } from '@/shared/lib/typedEvents.ts';
import { installCommand } from './copy.ts';

function mountWithEventCapture(resolution: ReturnType<typeof resolveUpdate>) {
  const onOpen = vi.fn();
  function Capture() {
    useAppEventListener('openSettings', onOpen);
    return <UpdateResolutionActions resolution={resolution} />;
  }
  render(<Capture />);
  return onOpen;
}

describe('update resolution Settings actions', () => {
  it('routes a soft update nudge to the expanded Updates destination and preserves the URL hash', () => {
    window.history.replaceState({}, '', '/tools/video-editor?project=film#edit');
    const onOpen = mountWithEventCapture(resolveUpdate({ installedRelease: 1, servedRelease: 2, releaseBehind: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
    expect(window.location.search).toContain('project=film');
    expect(window.location.hash).toBe('#edit');
  });

  it('keeps a hard card action in place and adds Details to the same Settings destination', () => {
    const onOpen = mountWithEventCapture(resolveUpdate({ compatibility: { kind: 'schema', detail: 'Update required' }, installType: 'pinokio' }));
    expect(screen.getByText('Update in Pinokio')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
  });

  it('shows the install update command for fully-local installs', () => {
    mountWithEventCapture(resolveUpdate({ compatibility: { kind: 'schema', detail: 'Update required' }, installType: 'fully-local' }));
    expect(screen.getByRole('code')).toHaveTextContent(installCommand('update'));
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  });
});
