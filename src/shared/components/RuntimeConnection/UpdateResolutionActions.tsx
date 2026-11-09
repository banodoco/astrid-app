import { useSyncExternalStore } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { COPY_FOR_AGENT_ACTION, RELOAD_ACTION, RUN_IT_YOURSELF_ACTION, UPDATE_IN_PINOKIO_ACTION, type InstallType, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { SOURCE_SCHEMA_MISMATCH_ACTION } from '@/integrations/runtime/runtime-update-contract.mjs';
import { CopyCommandRow, CopyInstallCommand } from './CopyInstallCommand.tsx';
import { ASTRID_COMMANDS, RUNTIME_CONNECTION_COPY } from './copy.ts';
import { detectPlatform } from '@/shared/hooks/platformInstall/platformDetection.ts';
import { dispatchAppEvent } from '@/shared/lib/typedEvents.ts';
import type { InstallerUpdateView } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { useGuardedReload } from '@/shared/lib/updates/draftSafeReload.ts';
import { installerUpdateFailed, installerUpdateLine, pageLocalUpdate } from '@/shared/lib/updates/updateOperation.ts';
import { INSTALLER_UPDATE_REASON_MESSAGES, SELF_UPDATE_TOO_OLD_STEPS } from '@/integrations/runtime/installerUpdateReasons.ts';
import { ASTRID_STATUS_COPY } from '@/shared/components/SettingsModal/sections/astridStatusCopy.ts';


/** Opens Settings on its Updates tab; the header and the update cards share this route. */
export function openUpdatesSettings() {
  const url = new URL(window.location.href);
  url.searchParams.set('settings', 'updates');
  window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  dispatchAppEvent('openSettings', { tab: 'updates' });
}

/**
 * Render only the actions selected by K6; source and Pinokio must never fall through to installer commands.
 * `context` is where the actions sit: Settings is the Details destination, so it never links to itself.
 */
export function UpdateResolutionActions({ resolution, operation, context = 'page', installType }: { readonly resolution: UpdateResolution; readonly operation?: InstallerUpdateView; readonly context?: 'page' | 'settings'; readonly installType?: InstallType }) {
  const guarded = useGuardedReload();
  const localUpdate = pageLocalUpdate();
  const localState = useSyncExternalStore(localUpdate.subscribe, localUpdate.getSnapshot, localUpdate.getSnapshot);
  const actions = [resolution.primary, resolution.secondary].filter((action) => action !== null);
  const installerPath = (operation?.installType ?? installType ?? (operation ? 'installer' : undefined)) === 'installer';
  // A failed in-app update's next action is the plain install line, the same repair line a degraded install shows.
  const failedInstall = installerPath && installerUpdateFailed(operation);
  if (actions.length === 0 && localState.phase === 'idle' && resolution.updateReason !== 'autostart-off' && !operation?.pending && !operation?.status?.result && !operation?.error && !failedInstall) return null;

  const commandOptions = actions.some((action) => action.label === COPY_FOR_AGENT_ACTION || action.label === RUN_IT_YOURSELF_ACTION);
  const route = actions.find((action) => action.destination === 'settings-updates');
  const installSpecific = actions.find((action) => action.label === UPDATE_IN_PINOKIO_ACTION || action.label === SOURCE_SCHEMA_MISMATCH_ACTION);
  const reload = actions.find((action) => action.label === RELOAD_ACTION);
  const execute = actions.find((action) => action.execute === 'installer-update');
  const executeLocal = actions.find((action) => action.execute === 'local-update');
  // Details opens Settings Updates; a card whose action already goes there (See updates) does not repeat it.
  const details = context === 'page' && !route && (resolution.card === 'update' || resolution.card === 'notice') && !resolution.updateReason;
  const statusLine = installerUpdateLine(operation?.status, resolution.updateReason);
  const plainInstallCommand = detectPlatform() === 'windows' ? ASTRID_COMMANDS.windows : ASTRID_COMMANDS.macLinux;
  const startUpdate = async () => {
    const validate = await guarded.flush();
    if (validate) await operation?.start(validate);
  };

  // A fully local install updates through its launcher. Drafts are saved first; a rolled-back editor is replaced too, so both outcomes reload.
  const updateLocally = async () => {
    if (!await guarded.flush()) return;
    const outcome = await localUpdate.start();
    if (outcome.phase === 'done' && outcome.status !== 'up-to-date') await guarded.reload();
  };

  return <div className="space-y-2">
    {reload && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={guarded.pending} onClick={() => void guarded.reload()}>{reload.label}</Button>}
    {execute && (operation?.available || execute.disabled) && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={execute.disabled === true || operation?.pending === true || guarded.pending} onClick={() => void startUpdate()}>{operation.pending ? 'Updating Astrid…' : execute.label}</Button>}
    {executeLocal && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={localState.phase === 'running' || guarded.pending} onClick={() => void updateLocally()}>{localState.phase === 'running' ? 'Updating Astrid…' : executeLocal.label}</Button>}
    {localState.phase === 'running' && <p role="status">Update in progress. Astrid may disconnect while it restarts.</p>}
    {localState.phase === 'done' && <p role="status">{localState.message}</p>}
    {localState.phase === 'done' && localState.status !== 'up-to-date' && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={guarded.pending} onClick={() => void guarded.reload()}>{RELOAD_ACTION}</Button>}
    {(localState.phase === 'failed' || localState.phase === 'refused') && <p role="alert">{localState.message}</p>}
    {route && <Button type="button" variant="retro-secondary" size="retro-sm" data-destination={route.destination} onClick={openUpdatesSettings}>{route.label}</Button>}
    {details && <Button type="button" variant="link" size="sm" onClick={openUpdatesSettings}>Details</Button>}
    {installSpecific && <p className="text-sm font-medium">{installSpecific.label}</p>}
    {/* The generic line only when no reason explains why this Astrid can't update itself. */}
    {commandOptions && installerPath && !execute && !resolution.updateReason && <p className="text-sm">{INSTALLER_UPDATE_REASON_MESSAGES['self-update-unavailable']}</p>}
    {commandOptions && <CopyInstallCommand mode="update" agentLabel={COPY_FOR_AGENT_ACTION} plain={resolution.updateReason === 'needs-repair'} />}
    {commandOptions && resolution.updateReason === 'self-update-too-old' && <p className="text-sm">{SELF_UPDATE_TOO_OLD_STEPS}</p>}
    {resolution.updateReason === 'autostart-off' && <div className="space-y-2">
      <p className="text-sm">Run this command, then start Astrid:</p>
      {/* The plain install line, not --update: it respects autostart off, so the saved choice is kept. */}
      <CopyCommandRow command={plainInstallCommand} label={RUNTIME_CONNECTION_COPY.agent.commandCopy} copiedLabel={RUNTIME_CONNECTION_COPY.agent.commandCopied} />
    </div>}
    {operation?.pending && <p role="status">Update in progress. Astrid may disconnect while it restarts.</p>}
    {operation?.error && <p role="alert">{operation.error}</p>}
    {operation?.restartRequired && <p role="status">Astrid restarted. Reload when your drafts can be saved.</p>}
    {operation?.fresh && !operation.error && statusLine && !operation.pending && <p role="status">{statusLine}</p>}
    {failedInstall && <div className="space-y-2">
      <p className="text-sm">{ASTRID_STATUS_COPY.repairDescription}</p>
      <CopyCommandRow command={plainInstallCommand} label={RUNTIME_CONNECTION_COPY.agent.commandCopy} copiedLabel={RUNTIME_CONNECTION_COPY.agent.commandCopied} />
    </div>}
    {!reload && operation?.fresh && !operation.error && (operation.restartRequired || operation.status?.state === 'terminal' && ['updated', 'rolled_back'].includes(operation.status.outcome ?? '')) && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={guarded.pending} onClick={() => void guarded.reload()}>{RELOAD_ACTION}</Button>}
    {guarded.error && <p role="alert">{guarded.error}</p>}
  </div>;
}
