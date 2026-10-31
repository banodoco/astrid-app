import { INSTALLER_UPDATE_REASON_MESSAGES, type InstallerUpdateReason, type RuntimeCompatibilityError } from '@/integrations/runtime/client.ts';
import { SOURCE_SCHEMA_MISMATCH_ACTION } from '../../../integrations/runtime/runtime-update-contract.mjs';

export type UpdateAction = {
  readonly label: string;
  readonly destination?: 'settings-updates';
  readonly command?: string;
  readonly execute?: 'installer-update';
};

export type UpdateResolution = {
  readonly card: 'not-running' | 'reload' | 'identity' | 'newer' | 'update' | 'mid-session' | 'notice' | 'error' | 'none';
  readonly title: string | null;
  readonly body: string | null;
  readonly primary: UpdateAction | null;
  readonly secondary: UpdateAction | null;
  readonly updateReason?: InstallerUpdateReason;
};

export type InstallType = 'pinokio' | 'source' | 'fully-local' | 'installer';

export interface UpdateResolutionInput {
  readonly runtime?: 'unreachable' | 'failed';
  readonly failure?: string;
  readonly pageStale?: boolean;
  readonly compatibility?: Pick<RuntimeCompatibilityError, 'kind' | 'detail'>;
  readonly installedRelease?: number;
  readonly servedRelease?: number;
  readonly requiredRelease?: number;
  readonly requiredReason?: string;
  readonly releaseBehind?: boolean;
  readonly midSessionSchemaMismatch?: boolean;
  readonly updateNowAvailable?: boolean;
  readonly installType?: InstallType;
  readonly command?: string;
  readonly realError?: string;
  readonly updateReason?: InstallerUpdateReason;
}

/**
 * The one install-type rule, shared by the page and the installer hook. Pinokio and a fully local page come from the
 * mode. Only the Runtime's identity (`managed_by`) can say `source`; `originless` is a page with no separate Runtime origin.
 */
export function installTypeOf(managedBy: string | null | undefined, mode: { managedByPinokio?: boolean | null; local?: boolean; originless?: boolean }): InstallType {
  if (mode.managedByPinokio || managedBy === 'pinokio') return 'pinokio';
  if (mode.local) return 'fully-local';
  return mode.originless || managedBy === 'source' ? 'source' : 'installer';
}

/** Action labels the UI matches on; the source label is owned by the Runtime contract. */
export const UPDATE_IN_PINOKIO_ACTION = 'Update in Pinokio';
export const COPY_FOR_AGENT_ACTION = 'Copy for your agent';
export const RUN_IT_YOURSELF_ACTION = 'Run it yourself';
export const RELOAD_ACTION = 'Reload';

const settingsAction: UpdateAction = { label: 'Update now', destination: 'settings-updates' };
const COPY_FOR_AGENT: UpdateAction = { label: COPY_FOR_AGENT_ACTION };
const commandActions = (input: UpdateResolutionInput): Pick<UpdateResolution, 'primary' | 'secondary'> => ({
  primary: COPY_FOR_AGENT,
  secondary: { label: RUN_IT_YOURSELF_ACTION, ...(input.command ? { command: input.command } : {}) },
});

type ActionContext = 'page' | 'settings';

function updateActions(input: UpdateResolutionInput, context: ActionContext, softRelease = false): Pick<UpdateResolution, 'primary' | 'secondary'> {
  if (input.installType === 'pinokio') return { primary: { label: UPDATE_IN_PINOKIO_ACTION }, secondary: null };
  if (input.installType === 'source') return { primary: { label: SOURCE_SCHEMA_MISMATCH_ACTION }, secondary: null };
  if (input.updateReason === 'recovery-needed' && input.installType === 'installer' && input.updateNowAvailable) {
    return { primary: { label: 'Update', execute: 'installer-update' }, secondary: null };
  }
  // The editor does not perform updates for a fully local install; give the same install command guidance as other local users.
  if (input.installType === 'fully-local') return commandActions(input);
  if (input.installType === 'installer' && input.updateNowAvailable) return { primary: { label: 'Update now', execute: 'installer-update' }, secondary: COPY_FOR_AGENT };
  if (softRelease && context === 'page') return { primary: settingsAction, secondary: null };
  return commandActions(input);
}

/** The sole update decision point. Conditions are intentionally ordered to match CONTRACTS K6. */
export function resolveUpdate(input: UpdateResolutionInput, context: ActionContext = 'page'): UpdateResolution {
  if (input.runtime) return { card: 'not-running', title: 'Astrid isn’t running', body: input.failure ?? 'Start Astrid Runtime to continue.', primary: { label: 'Start Astrid' }, secondary: { label: 'Repair' } };
  if (input.pageStale) return { card: 'reload', title: 'Editor updated', body: 'Reload this page to use the latest editor.', primary: { label: 'Reload' }, secondary: null };
  if (input.compatibility?.kind === 'identity') return { card: 'identity', title: 'Restart Astrid', body: 'An older Astrid is still running. Restart the selected Runtime, then reconnect.', primary: null, secondary: null };
  if (input.updateReason && input.installType === 'installer') {
    return {
      card: input.updateReason === 'recovery-needed' ? 'update' : 'notice',
      title: input.updateReason === 'recovery-needed' ? 'Update Astrid' : 'Update unavailable',
      body: INSTALLER_UPDATE_REASON_MESSAGES[input.updateReason],
      ...(input.updateReason === 'recovery-needed' ? updateActions(input, context) : { primary: null, secondary: null }),
      updateReason: input.updateReason,
    };
  }
  // A source checkout has no release: its startup identity is fixed at 0, so the release rules (newer, required, behind) never apply.
  const releaseRules = input.installType !== 'source';
  if (releaseRules && input.installedRelease !== undefined && input.servedRelease !== undefined && input.installedRelease > input.servedRelease) {
    return { card: 'newer', title: null, body: 'Astrid on this computer is newer than astrid.haus; a fix is on its way.', primary: null, secondary: null };
  }
  if (input.compatibility?.kind === 'schema') {
    return { card: 'update', title: 'Update Astrid', body: input.compatibility.detail, ...updateActions(input, context) };
  }
  if (input.midSessionSchemaMismatch) {
    return { card: 'mid-session', title: 'Editor updated', body: 'Update Astrid, then reload when your drafts can be saved.',
      ...updateActions(input, context) };
  }
  if (releaseRules && input.requiredRelease !== undefined && input.installedRelease !== undefined && input.installedRelease < input.requiredRelease) {
    return { card: 'update', title: 'Update Astrid', body: `This update is required: ${input.requiredReason ?? 'A required update is available.'}`, ...updateActions(input, context) };
  }
  if (releaseRules && input.releaseBehind) {
    return { card: 'notice', title: 'Update available', body: 'A newer release of Astrid is available.', ...updateActions(input, context, true) };
  }
  if (input.realError || input.compatibility) return { card: 'error', title: 'Could not connect to Astrid', body: input.realError ?? input.compatibility?.detail ?? 'An unexpected error occurred.', primary: null, secondary: null };
  return { card: 'none', title: null, body: null, primary: null, secondary: null };
}
