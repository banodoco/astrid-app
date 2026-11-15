import { useState, useSyncExternalStore } from 'react';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { usePageUpdateResolution } from '@/shared/lib/updates/usePageUpdateResolution.ts';
import { usePageStale } from './AppBuildProvider.tsx';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { updatedLine } from '@/shared/lib/updates/liveUpdate.ts';
import { installerUpdateFailed, pageLocalUpdate } from '@/shared/lib/updates/updateOperation.ts';
import { useUnderEditorTour } from './useUnderEditorTour.ts';

export function QuietUpdateNotice({ connection }: { readonly connection: RuntimeConnectionValue }) {
  const pageStale = usePageStale();
  const operation = useInstallerUpdate(connection);
  const page = usePageUpdateResolution(connection);
  const layer = useUnderEditorTour();
  const localUpdate = pageLocalUpdate();
  const localState = useSyncExternalStore(localUpdate.subscribe, localUpdate.getSnapshot, localUpdate.getSnapshot);
  // The user's own Show how toggle wins for the update state it was made in; a new state (a failure after a run, say)
  // falls back to the default, which opens the card while an update runs, fails or needs a restart.
  const [manual, setManual] = useState<{ readonly open: boolean; readonly kind: string } | null>(null);

  const current = operation.releaseStatus;
  const decision = current ? resolveUpdate({ ...current.resolution, installType: operation.installType, updateNowAvailable: operation.available, updateReason: operation.updateReason }) : page?.resolution ?? null;
  // An update that just finished under this page says so briefly, then the page is simply up to date.
  if (operation.updated) {
    return <div role="status" data-testid="update-finished-notice" className="fixed bottom-4 left-4 z-[100110] max-w-[min(28rem,calc(100%-2rem))] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-md">
      <span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />{updatedLine(operation.updated)}
    </div>;
  }
  if (pageStale || !decision || (decision.card !== 'notice' && decision.card !== 'update')) return null;
  // A required update (K6 rule 6) uses this same card, with its own title and reason.
  // The manifest's required update is one line collapsed, like the optional notice, so it doesn't cover editor controls;
  // "Show how" reveals its reason and the full actions, unchanged, in a card capped below most of the editor.
  // Other update cards (schema, recovery, repair) keep their title, reason and actions in view.
  const compactRequired = decision.card === 'update' && decision.required === true;
  const updateKind = operation.pending ? 'pending' : operation.error ? 'error' : installerUpdateFailed(operation) ? 'failed'
    : operation.restartRequired ? 'restart' : localState.phase !== 'idle' ? `local-${localState.phase}` : 'idle';
  const open = manual?.kind === updateKind ? manual.open : updateKind !== 'idle';
  const dot = <span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />;
  return <div role="status" data-testid="quiet-update-notice" style={layer.style} {...(layer.inert === undefined ? {} : { inert: layer.inert })} className={`fixed bottom-4 left-4 z-[100110] max-w-[min(28rem,calc(100%-2rem))] space-y-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-md${compactRequired ? ' max-h-[min(60vh,32rem)] overflow-y-auto' : ''}`}>
    {compactRequired
      // A toggle that doesn't match what was rendered is the user's; one React made itself is not.
      ? <details data-testid="required-update-reason" open={open} onToggle={(event) => { if (event.currentTarget.open !== open) setManual({ open: event.currentTarget.open, kind: updateKind }); }}>
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden"><span className="font-medium">{dot}{decision.title}</span> <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Required</span> <span className="ml-1 text-xs text-muted-foreground underline underline-offset-2">Show how</span></summary>
        <div className="mt-2 space-y-2">
          <p className="text-muted-foreground">{decision.body}</p>
          <UpdateResolutionActions resolution={decision} operation={operation} />
        </div>
      </details>
      : <>
        {decision.card === 'update'
          ? <div className="space-y-1"><span className="font-medium">{dot}{decision.title}</span><p className="text-muted-foreground">{decision.body}</p></div>
          : <span>{dot}Update available: Release {current?.servedRelease ?? page?.status.servedRelease}</span>}
        <UpdateResolutionActions resolution={decision} operation={operation} />
      </>}
  </div>;

}
