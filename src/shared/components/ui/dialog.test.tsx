import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './dialog';

describe('Dialog', () => {
  it('renders title, description, and close control when open', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByText('Dialog title')).toBeInTheDocument();
    expect(screen.getByText('Dialog description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('supports trigger asChild and opens via onOpenChange', () => {
    const onOpenChange = vi.fn();

    render(
      <Dialog onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <button type="button">Open dialog</button>
        </DialogTrigger>
      </Dialog>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(onOpenChange).toHaveBeenCalled();
  });

  it('allows an existing page gallery to remain interactive for a non-modal dialog', () => {
    const onDragStart = vi.fn();

    render(
      <>
        <div data-testid="bottom-gallery" draggable onDragStart={onDragStart}>
          Existing gallery
        </div>
        <Dialog open modal={false} disablePointerDismissal>
          <DialogContent modal={false} showBackdrop={false}>
            <DialogTitle>Shot editor</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );

    expect(document.querySelector('[data-dialog-backdrop]')).toBeNull();
    fireEvent.dragStart(screen.getByTestId('bottom-gallery'));
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });
});
