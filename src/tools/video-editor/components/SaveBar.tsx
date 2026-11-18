import { Button } from '@/shared/components/ui/button.tsx';
import type { SaveBarInput } from '../hooks/saveBar.ts';

function formatSince(since: string): string {
  const date = new Date(since);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The only surface for unsaved work: the reason, and the two ways out. Every state offers both. */
export function SaveBar({ bar, onTryAgain, onDiscard }: {
  bar: SaveBarInput;
  onTryAgain: () => void;
  onDiscard: () => void;
}) {
  const since = bar.since ? formatSince(bar.since) : '';
  const tone = bar.kind === 'refused'
    ? 'border-destructive/40 bg-destructive/10 text-destructive'
    : 'border-amber-500/40 bg-amber-500/10';
  return (
    <div role="alert" data-save-bar={bar.kind} className={`flex items-center justify-between gap-3 border-b px-3 py-2 text-sm ${tone}`}>
      <span>{bar.headline}{since ? ` Since ${since}.` : ''}</span>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onTryAgain}>Try again</Button>
        <Button type="button" size="sm" variant="outline" onClick={onDiscard}>Discard</Button>
      </div>
    </div>
  );
}
