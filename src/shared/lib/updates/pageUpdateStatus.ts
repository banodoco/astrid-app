import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { checkHostedUpdate, checkLocalUpdate, type UpdateStatus } from './updateStatus.ts';
import { installTypeOf, resolveUpdate, type UpdateResolution } from './resolveUpdate.ts';

let pageStatusPromise: Promise<UpdateStatus | null> | null = null;

/** One update-status request per page load, shared by the notice and Settings indicator. */
export function loadPageUpdateStatus(local: boolean): Promise<UpdateStatus | null> {
  if (!pageStatusPromise) {
    pageStatusPromise = (async () => {
      try {
        if (local) return await checkLocalUpdate();
        const health = await new AstridRuntimeClient().readInstallerUpdateHealth();
        return await checkHostedUpdate(health);
      } catch {
        return null;
      }
    })();
  }
  return pageStatusPromise;
}

/** The page's install type comes from the connection and the Runtime's identity in the same status, never the connection alone. */
export function resolvePageUpdateStatus(status: UpdateStatus, mode: { managedByPinokio?: boolean | null; local: boolean }): UpdateResolution {
  return resolveUpdate({ ...status.resolution, installType: installTypeOf(status.managedBy, mode), updateNowAvailable: false });
}
