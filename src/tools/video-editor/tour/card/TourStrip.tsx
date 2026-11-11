import type { CSSProperties } from 'react';
import { EDITOR_TOUR_MEDIA, type EditorTourMediaSlot } from '../tourMedia';
import { TourMedia, type TourMediaKind } from './TourMedia';
import { cn } from '@/shared/components/ui/contracts/cn.ts';

const NODES: ReadonlyArray<{ kind: TourMediaKind; slot: EditorTourMediaSlot }> = [
  { kind: 'frame', slot: EDITOR_TOUR_MEDIA.frames[0] },
  { kind: 'still', slot: EDITOR_TOUR_MEDIA.stills[0] },
  { kind: 'video', slot: EDITOR_TOUR_MEDIA.video },
];

const VIDEO_REST = EDITOR_TOUR_MEDIA.stills[EDITOR_TOUR_MEDIA.stills.length - 1];

const delay = (ms: number) => ({ '--tour-delay': `${ms}ms` }) as CSSProperties;

/**
 * The finale's chain, lit link by link once the card has glided in: a node's border flashes and stays lit,
 * then the line to the next node draws across and the next one lights as it connects. The lengths match
 * `.editor-tour-light` and `.editor-tour-draw` in TourCard.css.
 */
const LIGHT_START_MS = 200;
const LIGHT_STEP_MS = 580;
const LIGHT_MS = 480;
const DRAW_MS = 380;
const lightAt = (index: number) => LIGHT_START_MS + index * LIGHT_STEP_MS;
/** The line into node `index` lands just as that node starts to light. */
const drawAt = (index: number) => lightAt(index) + 50 - DRAW_MS;
/** The finale card's entrance: the last node's flash. */
export const TOUR_FINALE_ENTRANCE_MS = lightAt(NODES.length - 1) + LIGHT_MS;

/**
 * Agent → open models → output. Steps up to `filled` show their media; the newest one arrives with the
 * card (its connector draws in, then the thumbnail fades up); later steps wait as empty frames (`medium` is the same at the large strip's size, for a tablet's card). The large strip
 * (the finale) is the whole chain lit in the accent, played in by the card's entrance and at rest once it settles.
 */
export function TourStrip({ filled, labels, size = 'compact', playing = false, wrapLabels = false }: {
  filled: 1 | 2 | 3;
  labels: readonly [string, string, string];
  size?: 'compact' | 'medium' | 'large';
  /** The video step plays once and holds its final frame (large strip only). */
  playing?: boolean;
  /** Let long labels take two lines (a phone's finale), instead of running past their node. */
  wrapLabels?: boolean;
}) {
  const large = size === 'large';
  const big = size !== 'compact';
  return (
    <ol className="flex items-start" aria-label={labels.join(', then ')}>
      {NODES.map((node, index) => {
        const reached = index < filled;
        const newest = !large && index === filled - 1;
        const lit = large && reached;
        return (
          <li key={node.kind} className={cn('flex items-start', index > 0 && 'flex-1')}>
            {index > 0 && (
              <span aria-hidden="true" className={cn('relative h-px flex-1 bg-border', large ? 'mt-[27px]' : big ? 'mx-2 mt-[27px]' : 'mx-2 mt-4')}>
                {lit ? (
                  <span data-tour-lit="line" className="editor-tour-draw absolute inset-x-0 -top-px h-[3px] origin-left bg-primary" style={delay(drawAt(index))} />
                ) : (
                  reached && <span className={cn('absolute inset-0 origin-left bg-primary/60', newest && 'editor-tour-grow')} style={delay(500)} />
                )}
              </span>
            )}
            <span className={cn('flex flex-col items-center gap-1.5', big ? 'w-24' : 'w-14')}>
              <span className="relative block">
                <span
                  className={cn(
                    'relative block overflow-hidden rounded-[5px]',
                    big ? 'h-[54px] w-24' : 'h-8 w-14',
                    reached ? 'bg-muted shadow-sm ring-1 ring-border' : 'border border-dashed border-border',
                    newest && 'ring-primary/70',
                  )}
                >
                  {reached && (
                    <span className={cn('absolute inset-0', newest && 'editor-tour-fade')} style={delay(800)}>
                      {node.kind === 'video' && !(large && playing)
                        // At rest the video shows where the flight ends (the town), so it never repeats the still beside it.
                        ? <TourMedia slot={VIDEO_REST} kind="still" />
                        : <TourMedia slot={node.slot} kind={node.kind} poster={EDITOR_TOUR_MEDIA.stills[0].displayUrl ?? EDITOR_TOUR_MEDIA.stills[0].url} playing={large && playing && node.kind === 'video'} />}
                    </span>
                  )}
                </span>
                {lit && (
                  <span
                    aria-hidden="true"
                    data-tour-lit="node"
                    className="editor-tour-light pointer-events-none absolute -inset-px rounded-[6px] border-2 border-primary"
                    style={delay(lightAt(index))}
                  />
                )}
              </span>
              <span className={cn('text-xs', wrapLabels ? 'w-24 text-center leading-tight' : 'whitespace-nowrap leading-none', large || reached ? 'text-foreground' : 'text-muted-foreground')}>
                {labels[index]}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
