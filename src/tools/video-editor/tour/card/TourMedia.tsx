import { useEffect, useRef, useState } from 'react';
import type { EditorTourMediaSlot } from '../tourMedia';
import { cn } from '@/shared/components/ui/contracts/cn.ts';

export type TourMediaKind = 'frame' | 'still' | 'video';

/**
 * A tour image or video, cover-fitted to its box. Until a slot has a file it draws the valley in the
 * theme's own colours: faceted hills for the Three.js frame, soft ones for the still and the video.
 */
export function TourMedia({ slot, kind, className, playing = false, poster }: {
  slot: EditorTourMediaSlot;
  kind: TourMediaKind;
  className?: string;
  /** Videos only: play muted; pausing or reaching the end holds the current frame. */
  playing?: boolean;
  /** Videos only: shown until the video has a frame (its source still). */
  poster?: string;
}) {
  const fill = cn('absolute inset-0 h-full w-full object-cover', className);
  if (!slot.url) return <ValleyArt faceted={kind === 'frame'} className={fill} />;
  // The card is small: it shows the slot's WebP derivative and plays its 540p rendition, never the multi-megabyte original.
  if (kind === 'video') return <TourVideo key={slot.url} end={slot.previewDurationSeconds} url={slot.playback?.small ?? slot.url} poster={poster} playing={playing} className={fill} />;
  return <img className={fill} src={slot.displayUrl ?? slot.url} alt="" draggable={false} decoding="async" />;
}

function TourVideo({ url, poster, playing, className, end }: { end?: number; url: string; poster?: string; playing: boolean; className: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (!playing || video.ended || (end !== undefined && video.currentTime >= end)) return video.pause();
    // Autoplay can be refused (a muted video rarely is); the first frame is a fine resting state.
    void video.play()?.catch(() => undefined);
  }, [playing, end]);
  return <>
    {poster && !ready && <img className={className} src={poster} alt="" decoding="async" />}
    <video ref={ref} className={className} style={poster && !ready ? { opacity: 0 } : undefined}
      onLoadedData={() => setReady(true)} onPlaying={() => setReady(true)} onError={() => setReady(false)}
      src={url} poster={poster} muted playsInline onTimeUpdate={(event) => {
    if (end && event.currentTarget.currentTime >= end) {
      event.currentTarget.pause();
      if (event.currentTarget.currentTime > end) event.currentTarget.currentTime = end;
    }
  }} preload="auto" aria-hidden="true" />
  </>;
}

function ValleyArt({ faceted, className }: { faceted: boolean; className: string }) {
  const far = faceted ? 'M0 56 L34 40 L60 47 L92 32 L126 45 L160 36 L160 90 L0 90 Z' : 'M0 54 C28 40 48 46 74 40 S124 30 160 42 L160 90 L0 90 Z';
  const near = faceted ? 'M0 74 L30 63 L64 69 L102 56 L138 65 L160 60 L160 90 L0 90 Z' : 'M0 72 C32 60 60 68 96 60 S140 58 160 64 L160 90 L0 90 Z';
  return (
    <svg className={cn('bg-muted text-foreground', className)} viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <circle cx="118" cy="22" r="8" className="fill-card" />
      <path d={far} className="fill-current opacity-[0.14]" />
      <path d={near} className="fill-current opacity-[0.24]" />
      {[[48, 52], [70, 45], [84, 50], [99, 41]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" className="fill-primary" />)}
    </svg>
  );
}
