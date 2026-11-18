// @vitest-environment jsdom
import {render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {FirstFrameCover} from './RemotionPreview.tsx';

describe('first frame cover', () => {
  it('keeps a pending image covered, then reveals the decoded video canvas at the current frame and disconnects', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const getCurrentFrame = () => 156;
    const view = render(<FirstFrameCover settling={false} getCurrentFrame={getCurrentFrame}><img src="/pending.png" alt="pending" /></FirstFrameCover>);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(screen.getByTestId('preview-first-frame-cover')).not.toHaveClass('opacity-0');
    view.rerender(<FirstFrameCover settling={false} getCurrentFrame={getCurrentFrame}><span data-preview-decoded-frame="true" data-preview-presented-frame="155" /><canvas /></FirstFrameCover>);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByTestId('preview-first-frame-cover')).not.toHaveClass('opacity-0');
    view.rerender(<FirstFrameCover settling={false} getCurrentFrame={getCurrentFrame}><span data-preview-decoded-frame="true" data-preview-presented-frame="156" /><canvas /></FirstFrameCover>);
    await waitFor(() => expect(screen.getByTestId('preview-first-frame-cover')).toHaveClass('opacity-0'));
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();
  });
});

it('keeps a video-only canvas covered until the current frame is decoded', async () => {
  const currentFrame = () => 12;
  const view = render(<FirstFrameCover settling={false} getCurrentFrame={currentFrame}><span data-preview-decoded-frame="false" /><canvas /></FirstFrameCover>);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(screen.getByTestId('preview-first-frame-cover')).not.toHaveClass('opacity-0');
  view.rerender(<FirstFrameCover settling={false} getCurrentFrame={currentFrame}><span data-preview-decoded-frame="true" data-preview-presented-frame="12" /><canvas /></FirstFrameCover>);
  await waitFor(() => expect(screen.getByTestId('preview-first-frame-cover')).toHaveClass('opacity-0'));
});
