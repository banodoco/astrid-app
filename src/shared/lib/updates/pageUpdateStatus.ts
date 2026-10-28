import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { checkHostedUpdate, checkLocalUpdate, type UpdateStatus } from './updateStatus.ts';
import { installTypeOf, resolveUpdate, type InstallType, type UpdateResolution } from './resolveUpdate.ts';

/** The fully local page reads its status from the launcher. Read on each use, so the value is never fixed at import. */
export function localUpdateStatus(): boolean {
  return import.meta.env.VITE_ASTRID_LOCAL_UPDATE_STATUS === '1';
}

let pageStatusPromise: Promise<UpdateStatus | null> | null = null;

/** One update-status request per page load, shared by the notice and Settings indicator. A page with neither a launcher nor a Runtime origin has none. */
export function loadPageUpdateStatus(): Promise<UpdateStatus | null> {
  if (!localUpdateStatus() && runtimeOrigin() === '') return Promise.resolve(null);
  if (!pageStatusPromise) {
    pageStatusPromise = (async () => {
      try {
        if (localUpdateStatus()) return await checkLocalUpdate();
        const health = await new AstridRuntimeClient().readInstallerUpdateHealth();
        return await checkHostedUpdate(health);
      } catch {
        return null;
      }
    })();
  }
  return pageStatusPromise;
}

/** The page's install type from its mode and the Runtime's identity; a page with no separate Runtime origin is `originless`. */
export function pageInstallType(managedBy: string | null | undefined, managedByPinokio: boolean | null | undefined): InstallType {
  return installTypeOf(managedBy, { managedByPinokio, local: localUpdateStatus(), originless: runtimeOrigin() === '' });
}

/** The page's install type comes from the connection and the Runtime's identity in the same status, never the connection alone. */
export function resolvePageUpdateStatus(status: UpdateStatus, managedByPinokio: boolean | null | undefined): UpdateResolution {
  return resolveUpdate({ ...status.resolution, installType: pageInstallType(status.managedBy, managedByPinokio), updateNowAvailable: false });
}
