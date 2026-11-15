import { useRef, useState, useSyncExternalStore } from 'react';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { usePageUpdateResolution } from '@/shared/lib/updates/usePageUpdateResolution.ts';
import { usePageStale } from './AppBuildProvider.tsx';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { RELOAD_ACTION, resolveUpdate, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { updatedLine } from '@/shared/lib/updates/liveUpdate.ts';
import { installerUpdateFailed, installerUpdateLine, pageLocalUpdate } from '@/shared/lib/updates/updateOperation.ts';
import type { InstallerUpdateView } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { useUnderEditorTour } from './useUnderEditorTour.ts';

type LocalUpdateState = ReturnType<ReturnType<typeof pageLocalUpdate>['getSnapshot']>;

/**
 * What the required card's status shows: `kind` says whether it needs attention (anything but idle opens the card), and
 * `fingerprint` changes whenever any status line, error or Reload the card would show changes.
 */
function updateAttention(operation: InstallerUpdateView, local: LocalUpdateState, decision: UpdateResolution | null) {
  const terminal = operation.fresh && !operation.error && operation.status?.state === 'terminal' ? operation.status.outcome : undefined;
  // The same condition UpdateResolutionActions offers its Reload under.
  const ownReload = [decision?.primary, decision?.secondary].some((action) => action?.label === RELOAD_ACTION);
  const reload = !ownReload && operation.fresh && !operation.error && (operation.restartRequired || terminal === 'updated' || terminal === 'rolled_back');
  const kind = operation.pending ? 'pending' : operation.error ? 'error' : installerUpdateFailed(operation) ? 'failed'
    : operation.restartRequired ? 'restart' : terminal === 'rolled_back' ? 'rolled-back' : terminal === 'updated' && reload ? 'updated-reload'
    : local.phase !== 'idle' ? `local-${local.phase}` : 'idle';
  const fingerprint = JSON.stringify([
    kind, operation.error ?? null, operation.status?.state ?? null, operation.status?.outcome ?? null, !!operation.restartRequired,
    local.phase, 'message' in local ? local.message : null, reload,
    operation.fresh ? installerUpdateLine(operation.status, decision?.updateReason) : null,
  ]);
  return { kind, fingerprint };
}

export function QuietUpdateNotice({ connection }: { readonly connection: RuntimeConnectionValue }) {
  const pageStale = usePageStale();
  const operation = useInstallerUpdate(connection);
  const page = usePageUpdateResolution(connection);
  const layer = useUnderEditorTour();
  const localUpdate = pageLocalUpdate();
  const localState = useSyncExternalStore(localUpdate.subscribe, localUpdate.getSnapshot, localUpdate.getSnapshot);
  // The user's own Show how toggle wins only while what the card shows is unchanged: any new status, error or Reload
  // (a retry failing again included) starts a new epoch, and the default opens the card for anything but idle.
  const [manual, setManual] = useState<{ readonly open: boolean; readonly epoch: number } | null>(null);
  const seen = useRef<{ fingerprint: string; epoch: number } | null>(null);

  const current = operation.releaseStatus;
  const decision = current ? resolveUpdate({ ...current.resolution, installType: operation.installType, updateNowAvailable: operation.available, updateReason: operation.updateReason }) : page?.resolution ?? null;
  const attention = updateAttention(operation, localState, decision);
  // A ref, not state: the epoch moves during render without scheduling another one.
  if (seen.current?.fingerprint !== attention.fingerprint) seen.current = { fingerprint: attention.fingerprint, epoch: (seen.current?.epoch ?? 0) + 1 };
  const epoch = seen.current.epoch;
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
  const open = manual?.epoch === epoch ? manual.open : attention.kind !== 'idle';
  const dot = <span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />;
  return <div role="status" data-testid="quiet-update-notice" style={layer.style} {...(layer.inert === undefined ? {} : { inert: layer.inert })} className={`fixed bottom-4 left-4 z-[100110] max-w-[min(28rem,calc(100%-2rem))] space-y-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-md${compactRequired ? ' max-h-[min(60vh,32rem)] overflow-y-auto' : ''}`}>
    {compactRequired
      // A toggle that doesn't match what was rendered is the user's; one React made itself is not.
      ? <details data-testid="required-update-reason" open={open} onToggle={(event) => { if (event.currentTarget.open !== open) setManual({ open: event.currentTarget.open, epoch }); }}>
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
