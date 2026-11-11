import React from 'react';
import { cn } from '@/shared/components/ui/contracts/cn';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';

interface GenerationsPaneFrameProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
  /** Pane height in px. */
  height: number;
  /** Left inset in px: the Shots pane's width when it is locked. */
  left: number;
  /** Right inset in px: the Tasks pane's width when it is locked. */
  right: number;
  /** The sliding pane's transform class (`translate-y-0` open, `translate-y-full` closed). */
  transformClass: string;
  zIndex?: number;
}

/**
 * The Generations pane's outer box: fixed to the bottom edge between the locked side panes, with the pane's own
 * surface, border, shadow and slide transition. Props only, so the first-run tour draws the same frame.
 */
export const GenerationsPaneFrame = React.forwardRef<HTMLDivElement, GenerationsPaneFrameProps>(
  ({ height, left, right, transformClass, zIndex = UI_Z_LAYERS.GENERATIONS_PANE, className, ...rest }, ref) => (
    <div
      {...rest}
      ref={ref}
      style={{
        height: `${height}px`,
        left: `${left}px`,
        right: `${right}px`,
        zIndex,
      }}
      className={cn(
        'fixed bottom-0 bg-zinc-900/95 border-t border-zinc-700 shadow-xl transform transition-[transform,left,right] duration-300 ease-smooth flex flex-col pointer-events-auto',
        transformClass,
        className,
      )}
    />
  ),
);
GenerationsPaneFrame.displayName = 'GenerationsPaneFrame';
