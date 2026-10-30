import { Button } from '@/shared/components/ui/button.tsx';
import { COPY_FOR_AGENT_ACTION, RELOAD_ACTION, RUN_IT_YOURSELF_ACTION, UPDATE_IN_PINOKIO_ACTION, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { SOURCE_SCHEMA_MISMATCH_ACTION } from '@/integrations/runtime/runtime-update-contract.mjs';
import { CopyInstallCommand } from './CopyInstallCommand.tsx';
import { dispatchAppEvent } from '@/shared/lib/typedEvents.ts';
import type { InstallerUpdateView } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { useGuardedReload } from '@/shared/lib/updates/draftSafeReload.ts';
import { installerUpdateStatusMessage } from '@/shared/lib/updates/updateOperation.ts';

/** Opens Settings on its Updates tab; the header and the update cards share this route. */
export function openUpdatesSettings() {
  const url = new URL(window.location.href);
  url.searchParams.set('settings', 'updates');
  window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  dispatchAppEvent('openSettings', { tab: 'updates' });
}

/** Render only the actions selected by K6; source and Pinokio must never fall through to installer commands. */
export function UpdateResolutionActions({ resolution, operation }: { readonly resolution: UpdateResolution; readonly operation?: InstallerUpdateView }) {
  const guarded = useGuardedReload();
  const actions = [resolution.primary, resolution.secondary].filter((action) => action !== null);
  if (actions.length === 0 && !operation?.pending && !operation?.status?.result && !operation?.error) return null;

  const commandOptions = actions.some((action) => action.label === COPY_FOR_AGENT_ACTION || action.label === RUN_IT_YOURSELF_ACTION);
  const route = actions.find((action) => action.destination === 'settings-updates');
  const installSpecific = actions.find((action) => action.label === UPDATE_IN_PINOKIO_ACTION || action.label === SOURCE_SCHEMA_MISMATCH_ACTION);
  const reload = actions.find((action) => action.label === RELOAD_ACTION);
  const execute = actions.find((action) => action.execute === 'installer-update');
  const localCommand = actions.find((action) => action.label === RUN_IT_YOURSELF_ACTION)?.command;
  const startUpdate = async () => {
    if (await guarded.flush()) await operation?.start();
  };

  return <div className="space-y-2">
    {reload && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={guarded.pending} onClick={() => void guarded.reload()}>{reload.label}</Button>}
    {execute && operation?.available && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={operation.pending || guarded.pending} onClick={() => void startUpdate()}>{operation.pending ? 'Updating Astrid…' : execute.label}</Button>}
    {route && <Button type="button" variant="retro-secondary" size="retro-sm" data-destination={route.destination} onClick={openUpdatesSettings}>{route.label}</Button>}
    {(resolution.card === 'update' || resolution.card === 'notice') && !resolution.updateReason && <Button type="button" variant="link" size="sm" onClick={openUpdatesSettings}>Details</Button>}
    {installSpecific && <p className="text-sm font-medium">{installSpecific.label}</p>}
    {commandOptions && <CopyInstallCommand mode="update" localCommand={localCommand} />}
    {operation?.pending && <p role="status">Update in progress. Astrid may disconnect while it restarts.</p>}
    {operation?.error && <p role="alert">Could not confirm the update status. Download diagnostics before trying again.</p>}
    {operation?.restartRequired && <p role="status">Astrid restarted. Reload when your drafts can be saved.</p>}
    {operation?.fresh && !operation.error && installerUpdateStatusMessage(operation.status) && !operation.pending && <p role="status">{installerUpdateStatusMessage(operation.status)}</p>}
    {!reload && operation?.fresh && !operation.error && (operation.restartRequired || operation.status?.state === 'terminal' && ['updated', 'rolled_back'].includes(operation.status.outcome ?? '')) && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={guarded.pending} onClick={() => void guarded.reload()}>{RELOAD_ACTION}</Button>}
    {guarded.error && <p role="alert">{guarded.error}</p>}
  </div>;
}
