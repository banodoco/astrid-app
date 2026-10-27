import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { checkHostedUpdate, checkLocalUpdate, type UpdateStatus } from './updateStatus.ts';
import { resolveUpdate, type UpdateResolution } from './resolveUpdate.ts';

let pageStatusPromise: Promise<UpdateStatus | null> | null = null;

/** One update-status request per page load, shared by the notice and Settings indicator. */
export function loadPageUpdateStatus(local: boolean): Promise<UpdateStatus | null> {
  if (!pageStatusPromise) {
    pageStatusPromise = (async () => {
      try {
        if (local) return await checkLocalUpdate();
        const current = await new AstridRuntimeClient().readStatus();
        return await checkHostedUpdate(current.health);
      } catch {
        return null;
      }
    })();
  }
  return pageStatusPromise;
}

export function resolvePageUpdateStatus(status: UpdateStatus, installType: 'pinokio' | 'source' | 'fully-local' | 'installer'): UpdateResolution {
  return resolveUpdate({ ...status.resolution, installType, updateNowAvailable: false });
}
