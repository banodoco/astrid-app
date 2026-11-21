import { useState, type ReactNode } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import type { SaveBarInput } from '../hooks/saveBar.ts';

function formatSince(since: string): string {
  const date = new Date(since);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The only surface for unsaved work: the reason, and the two ways out. Every state offers both. */
export function SaveBar({ bar, onTryAgain, onDiscard, children, actions, className = '', restore = false }: {
  bar: SaveBarInput;
  onTryAgain?: () => void | Promise<void>;
  onDiscard?: () => void | Promise<void>;
  /** Custom message/actions let legacy recovery surfaces share this single alert shell. */
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  restore?: boolean;
}) {
  const [running, setRunning] = useState(false);
  // Both buttons wait while either action runs: a long reload must read as working, not as a dead button.
  const run = (action: () => void | Promise<void>) => {
    if (running) return;
    try {
      const result = action();
      if (result) {
        setRunning(true);
        void result.catch(() => {}).finally(() => setRunning(false));
      }
    } catch {
      // The action reports its own failure and leaves the controls available.
    }
  };
  const since = bar.since ? formatSince(bar.since) : '';
  const tone = className.includes('bg-muted')
    ? 'border-border bg-muted/40 text-foreground'
    : bar.kind === 'refused'
    ? 'border-destructive/40 bg-destructive/10 text-destructive'
    : 'border-amber-500/40 bg-amber-500/10';
  return (
    <div role="alert" data-save-bar={bar.kind} aria-busy={running} className={`flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2 text-sm ${tone} ${className}`}>
      {children ?? <span>{bar.headline}{since ? ` Since ${since}.` : ''}</span>}
      {actions ?? <div className="flex items-center gap-2">
        {bar.action === 'none' ? null
          : onTryAgain ? <Button type="button" size="sm" variant={restore ? 'default' : 'outline'} disabled={running}
              onClick={() => run(onTryAgain)}>{restore ? 'Restore' : 'Try again'}</Button> : null}
        {onDiscard ? <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => run(onDiscard)}>Discard</Button> : null}
      </div>}
    </div>
  );
}
