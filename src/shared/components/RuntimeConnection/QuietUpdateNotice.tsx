import { useEffect, useState } from 'react';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import type { UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { loadPageUpdateStatus, resolvePageUpdateStatus } from '@/shared/lib/updates/pageUpdateStatus.ts';
import { usePageStale } from './AppBuildProvider.tsx';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';

export function QuietUpdateNotice({ connection }: { readonly connection: RuntimeConnectionValue }) {
  const pageStale = usePageStale();
  const local = import.meta.env.VITE_ASTRID_LOCAL_UPDATE_STATUS === '1';
  const hosted = runtimeOrigin() !== '';
  const [resolution, setResolution] = useState<UpdateResolution | null>(null);
  const [release, setRelease] = useState<number | null>(null);

  useEffect(() => {
    if (!connection.isConnected || (!local && !hosted)) return;
    let active = true;
    const installType = connection.managedByPinokio ? 'pinokio' : local ? 'fully-local' : 'installer';
    void loadPageUpdateStatus(local).then((status) => {
      if (!active || !status) return;
      const decision = resolvePageUpdateStatus(status, installType);
      if (decision.card === 'notice') {
        setRelease(status.servedRelease);
        setResolution(decision);
      }
    });
    return () => { active = false; };
  }, [connection.isConnected, connection.managedByPinokio, hosted, local]);

  if (pageStale || !resolution || release === null) return null;
  return <div role="status" data-testid="quiet-update-notice" className="fixed bottom-4 left-4 z-[100110] max-w-[min(28rem,calc(100%-2rem))] space-y-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-md">
    <span><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />Update available · Release {release}</span>
    <UpdateResolutionActions resolution={resolution} />
  </div>;
}
