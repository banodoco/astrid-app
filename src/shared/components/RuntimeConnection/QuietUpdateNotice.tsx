import { useEffect, useState } from 'react';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import type { UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { loadPageUpdateStatus, resolvePageUpdateStatus } from '@/shared/lib/updates/pageUpdateStatus.ts';
import { usePageStale } from './AppBuildProvider.tsx';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';

export function QuietUpdateNotice({ connection }: { readonly connection: RuntimeConnectionValue }) {
  const pageStale = usePageStale();
  const operation = useInstallerUpdate(connection);
  const local = import.meta.env.VITE_ASTRID_LOCAL_UPDATE_STATUS === '1';
  const hosted = runtimeOrigin() !== '';
  const [resolution, setResolution] = useState<UpdateResolution | null>(null);
  const [release, setRelease] = useState<number | null>(null);

  useEffect(() => {
    if (!connection.isConnected || (!local && !hosted)) return;
    let active = true;
    void loadPageUpdateStatus(local).then((status) => {
      if (!active || !status) return;
      const decision = resolvePageUpdateStatus(status, { managedByPinokio: connection.managedByPinokio, local });
      if (decision.card === 'notice' || decision.card === 'update') {
        setRelease(status.servedRelease);
        setResolution(decision);
      }
    });
    return () => { active = false; };
  }, [connection.isConnected, connection.managedByPinokio, hosted, local]);

  const current = operation.releaseStatus;
  const decision = current ? resolveUpdate({ ...current.resolution, installType: operation.installType, updateNowAvailable: operation.available }) : resolution;
  if (pageStale || !decision || (decision.card !== 'notice' && decision.card !== 'update') || release === null && !current) return null;
  // A required update (K6 rule 6) uses this same card, with its own title and reason.
  const required = decision.card === 'update';
  return <div role="status" data-testid="quiet-update-notice" className="fixed bottom-4 left-4 z-[100110] max-w-[min(28rem,calc(100%-2rem))] space-y-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-md">
    {required
      ? <div className="space-y-1"><span className="font-medium"><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />{decision.title}</span><p className="text-muted-foreground">{decision.body}</p></div>
      : <span><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />Update available · Release {current?.servedRelease ?? release}</span>}
    <UpdateResolutionActions resolution={decision} operation={operation} />
  </div>;

}
