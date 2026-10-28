import { useEffect, useState } from 'react';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { loadPageUpdateStatus, resolvePageUpdateStatus } from './pageUpdateStatus.ts';
import type { UpdateResolution } from './resolveUpdate.ts';
import type { UpdateStatus } from './updateStatus.ts';

export interface PageUpdateResolution {
  readonly status: UpdateStatus;
  readonly resolution: UpdateResolution;
}

/** The page's update status and its resolution, from the one per-page status read. Null until that read succeeds, and on pages with no status. */
export function usePageUpdateResolution(connection: Pick<RuntimeConnectionValue, 'isConnected' | 'managedByPinokio'> | null | undefined): PageUpdateResolution | null {
  const connected = connection?.isConnected ?? false;
  const managedByPinokio = connection?.managedByPinokio ?? false;
  const [page, setPage] = useState<PageUpdateResolution | null>(null);
  useEffect(() => {
    if (!connected) return undefined;
    let active = true;
    void loadPageUpdateStatus().then((status) => {
      if (!active || !status) return;
      setPage({ status, resolution: resolvePageUpdateStatus(status, managedByPinokio) });
    });
    return () => { active = false; };
  }, [connected, managedByPinokio]);
  return page;
}
