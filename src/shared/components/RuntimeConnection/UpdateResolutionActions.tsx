import { Button } from '@/shared/components/ui/button.tsx';
import type { UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { CopyInstallCommand } from './CopyInstallCommand.tsx';
import { dispatchAppEvent } from '@/shared/lib/typedEvents.ts';
import type { InstallerUpdateView } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { useGuardedReload } from '@/shared/lib/updates/draftSafeReload.ts';

function openUpdates() {
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

  const commandOptions = actions.some((action) => action.label === 'Copy for your agent' || action.label === 'Run it yourself');
  const route = actions.find((action) => action.destination === 'settings-updates');
  const installSpecific = actions.find((action) => action.label === 'Update in Pinokio' || action.label === 'update your checkouts');
  const reload = actions.find((action) => action.label === 'Reload');
  const execute = actions.find((action) => action.execute === 'installer-update');
  const localCommand = actions.find((action) => action.label === 'Run it yourself')?.command;

  return <div className="space-y-2">
    {reload && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={guarded.pending} onClick={() => void guarded.reload()}>{reload.label}</Button>}
    {execute && operation?.available && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={operation.pending} onClick={() => void operation.start()}>{operation.pending ? 'Updating Astrid…' : execute.label}</Button>}
    {route && <Button type="button" variant="retro-secondary" size="retro-sm" data-destination={route.destination} onClick={openUpdates}>{route.label}</Button>}
    {(resolution.card === 'update' || resolution.card === 'notice') && <Button type="button" variant="link" size="sm" onClick={openUpdates}>Details</Button>}
    {installSpecific && <p className="text-sm font-medium">{installSpecific.label}</p>}
    {commandOptions && <CopyInstallCommand mode="update" localCommand={localCommand} />}
    {operation?.pending && <p role="status">Update in progress. Astrid may disconnect while it restarts.</p>}
    {operation?.error && <p role="alert">{operation.error}</p>}
    {operation?.restartRequired && <p role="status">Astrid restarted. Reload when your drafts can be saved.</p>}
    {operation?.fresh && !operation.error && operation.status?.result && !operation.pending && <p role="status">{operation.status.result}</p>}
    {!reload && operation?.fresh && !operation.error && (operation.restartRequired || operation.status?.state === 'terminal' && ['updated', 'rolled_back'].includes(operation.status.outcome ?? '')) && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={guarded.pending} onClick={() => void guarded.reload()}>Reload</Button>}
    {guarded.error && <p role="alert">{guarded.error}</p>}
  </div>;
}
