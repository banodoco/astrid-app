import type { CSSProperties, ReactNode } from 'react';
import { ArrowRight, Blocks, Play } from 'lucide-react';
import type { EditorTourVisual } from '../tourScript';
import { EDITOR_TOUR_MEDIA } from '../tourMedia';
import { TourMedia } from './TourMedia';
import { TourCompare } from './TourCompare';
import { cn } from '@/shared/components/ui/contracts/cn.ts';

const delay = (ms: number) => ({ '--tour-delay': `${ms}ms` }) as CSSProperties;

/**
 * One small picture per act, played once as the card arrives and then left at rest. `playing` is motion allowed (a video
 * plays); `entering` is the entrance itself playing (the comparison's sweep). Act 2's comparison is a control, so it is the one
 * picture assistive technology reaches, and it is a little taller so both halves read.
 */
export function TourVisual({ visual, labels, playing, entering = playing }: { visual: EditorTourVisual; labels: readonly [string, string]; playing: boolean; entering?: boolean }) {
  const compare = visual === 'frame-to-still';
  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-muted ring-1 ring-border/70', compare ? 'h-40' : 'h-32')} aria-hidden={compare ? undefined : 'true'}>
      {visual === 'extension' && <ExtensionToClip labels={labels} />}
      {compare && <TourCompare labels={labels} sweep={entering} />}
      {visual === 'still-to-video' && <StillToVideo labels={labels} playing={playing} />}
    </div>
  );
}

/** An extension tile sends its scene along to a clip on the timeline. */
function ExtensionToClip({ labels: [name, kind] }: { labels: readonly [string, string] }) {
  return (
    <div className="flex h-full items-center px-5">
      <div className="editor-tour-rise flex h-[84px] w-[84px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg bg-card text-card-foreground shadow-sm ring-1 ring-border" style={delay(200)}>
        <Blocks className="mb-0.5 h-5 w-5 text-primary" strokeWidth={1.75} />
        <span className="text-[11px] leading-none">{name}</span>
        <span className="text-[10px] leading-none text-muted-foreground">{kind}</span>
      </div>
      <div className="relative mx-3 flex h-px flex-1 items-center bg-muted-foreground/30">
        <span className="editor-tour-travel absolute left-full top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0" style={delay(480)} />
        <ArrowRight className="absolute -right-1 h-3 w-3 text-muted-foreground" strokeWidth={1.75} />
      </div>
      <div className="w-[148px] shrink-0">
        <div className="editor-tour-reveal relative aspect-video overflow-hidden rounded-md shadow-sm ring-1 ring-border" style={delay(860)}>
          <TourMedia slot={EDITOR_TOUR_MEDIA.frames[0]} kind="frame" />
        </div>
        <div className="editor-tour-grow mt-1.5 h-1.5 origin-left rounded-full bg-primary/70" style={delay(860)} />
      </div>
    </div>
  );
}

/** The start frame comes alive: the 14 s shot fades up over it and plays under a slow playhead. */
function StillToVideo({ labels: [model, length], playing }: { labels: readonly [string, string]; playing: boolean }) {
  return (
    <>
      <TourMedia slot={EDITOR_TOUR_MEDIA.stills[0]} kind="still" />
      <div className="editor-tour-fade absolute inset-0" style={delay(450)}>
        <TourMedia slot={EDITOR_TOUR_MEDIA.video} kind="video" poster={EDITOR_TOUR_MEDIA.stills[0].url} playing={playing} />
      </div>
      <Chip className="left-2 bottom-3 flex items-center gap-1">
        <Play className="h-2.5 w-2.5 fill-current" strokeWidth={0} />
        {model}
      </Chip>
      <Chip className="right-2 bottom-3 tabular-nums">{length}</Chip>
      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-background/40">
        {playing && <div className="editor-tour-playhead h-full bg-primary" />}
      </div>
    </>
  );
}

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={cn('absolute bottom-2 rounded px-1.5 py-0.5 text-[10px] leading-none text-foreground backdrop-blur-sm bg-background/80', className)}>
      {children}
    </span>
  );
}
