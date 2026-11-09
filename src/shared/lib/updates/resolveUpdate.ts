import type { RuntimeCompatibilityError } from '@/integrations/runtime/client.ts';
import { FIRST_SELF_UPDATE_RELEASE, INSTALLER_UPDATE_REASON_MESSAGES, type InstallerUpdateReason } from '@/integrations/runtime/installerUpdateReasons.ts';
import { SOURCE_SCHEMA_MISMATCH_ACTION } from '../../../integrations/runtime/runtime-update-contract.mjs';

export type UpdateAction = {
  readonly label: string;
  readonly destination?: 'settings-updates';
  readonly execute?: 'installer-update' | 'local-update';
  /** Shown but not startable: a busy Astrid offers Update now disabled while its lock is held. */
  readonly disabled?: boolean;
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
  /** The Runtime's `self_update`. Missing reads as not able to update itself. */
  readonly selfUpdate?: boolean;
  readonly installType?: InstallType;
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
export const COPY_FOR_AGENT_ACTION = 'Copy instructions for your agent';
export const RUN_IT_YOURSELF_ACTION = 'Run it yourself';
export const RELOAD_ACTION = 'Reload';

const settingsAction: UpdateAction = { label: 'See updates', destination: 'settings-updates' };
const COPY_FOR_AGENT: UpdateAction = { label: COPY_FOR_AGENT_ACTION };
/** The direct-install update: the agent brief and the install line's update command. Every direct install, fully local included, uses it. */
const COMMAND_ACTIONS: Pick<UpdateResolution, 'primary' | 'secondary'> = { primary: COPY_FOR_AGENT, secondary: { label: RUN_IT_YOURSELF_ACTION } };
/** A busy Astrid keeps Update now visible but disabled, with no command: the reason line says why. */
const BUSY_ACTIONS: Pick<UpdateResolution, 'primary' | 'secondary'> = { primary: { label: 'Update now', execute: 'installer-update', disabled: true }, secondary: null };

type ActionContext = 'page' | 'settings';

/** Pinokio and source checkouts each have one way to update; every other install shares the direct-install actions. */
function updateActions(input: UpdateResolutionInput, context: ActionContext, softRelease = false): Pick<UpdateResolution, 'primary' | 'secondary'> {
  if (input.installType === 'pinokio') return { primary: { label: UPDATE_IN_PINOKIO_ACTION }, secondary: null };
  if (input.installType === 'source') return { primary: { label: SOURCE_SCHEMA_MISMATCH_ACTION }, secondary: null };
  if (input.updateReason === 'recovery-needed' && input.installType === 'installer' && input.updateNowAvailable) {
    return { primary: { label: 'Update', execute: 'installer-update' }, secondary: null };
  }
  // A fully local install updates its own checkout through the launcher, and only when its status reports self_update.
  if (input.installType === 'fully-local' && input.updateNowAvailable) return { primary: { label: 'Update now', execute: 'local-update' }, secondary: COPY_FOR_AGENT };
  if (input.installType === 'installer' && input.updateNowAvailable) return { primary: { label: 'Update now', execute: 'installer-update' }, secondary: COPY_FOR_AGENT };
  if (softRelease && context === 'page') return { primary: settingsAction, secondary: null };
  return COMMAND_ACTIONS;
}

/** An installer install older than the first self-updating release, behind the served release, with no reason of its own. */
function selfUpdateTooOld(input: UpdateResolutionInput): boolean {
  return input.installType === 'installer' && input.selfUpdate !== true && input.updateNowAvailable !== true
    && (input.updateReason === undefined || input.updateReason === 'self-update-unavailable' || input.updateReason === 'self-update-too-old')
    && input.installedRelease !== undefined && input.servedRelease !== undefined
    && input.installedRelease < FIRST_SELF_UPDATE_RELEASE && input.installedRelease < input.servedRelease;
}

/** The sole update decision point. Conditions are intentionally ordered to match CONTRACTS K6. */
export function resolveUpdate(input: UpdateResolutionInput, context: ActionContext = 'page'): UpdateResolution {
  if (input.runtime) return { card: 'not-running', title: 'Astrid isn’t running', body: input.failure ?? 'Start Astrid Runtime to continue.', primary: { label: 'Start Astrid' }, secondary: { label: 'Repair' } };
  if (input.pageStale) return { card: 'reload', title: 'Editor updated', body: 'Reload this page to use the latest editor.', primary: { label: 'Reload' }, secondary: null };
  if (input.compatibility?.kind === 'identity') return { card: 'identity', title: 'Restart Astrid', body: 'An older Astrid is still running. Restart the selected Runtime, then reconnect.', primary: null, secondary: null };
  // A source checkout has no release: its startup identity is fixed at 0, so the release rules (newer, required, behind) never apply.
  const releaseRules = input.installType !== 'source';
  // An installed release newer than served shows no action, whatever the installer reason says.
  if (releaseRules && input.installedRelease !== undefined && input.servedRelease !== undefined && input.installedRelease > input.servedRelease) {
    return { card: 'newer', title: null, body: 'Astrid on this computer is newer than astrid.haus; a fix is on its way.', primary: null, secondary: null };
  }
  // A release before the first self-updating one cannot report why it can't update itself; its release says why.
  // A reason the Runtime did report wins; only the generic fallback is replaced.
  // A required update keeps its precedence (an update card with the command, its reason first); otherwise the page
  // routes to Settings like any release notice, and Settings shows the command.
  if (selfUpdateTooOld(input)) {
    const required = input.requiredRelease !== undefined && input.installedRelease! < input.requiredRelease;
    return {
      card: required ? 'update' : 'notice',
      title: `Release ${input.servedRelease} is ready`,
      body: `${required ? `This update is required: ${input.requiredReason ?? 'A required update is available.'} ` : ''}You have Release ${input.installedRelease}. ${INSTALLER_UPDATE_REASON_MESSAGES['self-update-too-old']}`,
      ...(required ? COMMAND_ACTIONS : updateActions(input, context, true)),
      updateReason: 'self-update-too-old',
    };
  }
  // A setup refusal on an install that is already current has no update to offer: it shows no card and no command.
  const current = input.installedRelease !== undefined && input.servedRelease !== undefined && input.installedRelease >= input.servedRelease;
  const silentWhenCurrent = current && (input.updateReason === 'autostart-off' || input.updateReason === 'unsupported-service-manager' || input.updateReason === 'windows-upgrade-unsupported');
  // A fully local install shows only the source line its launcher reports; its other refusals follow the release rules.
  const sourceLocal = input.installType === 'fully-local' && input.updateReason === 'source';
  if (input.updateReason && (input.installType === 'installer' || sourceLocal) && !silentWhenCurrent) {
    // A recovery or repair is an update card. Without an in-app update the reason is the one line and the command is the path;
    // A source checkout has its own update route, not the installer command. autostart-off takes the command path with its own card.
    const card = input.updateReason === 'recovery-needed' || input.updateReason === 'needs-repair';
    const noAction = input.updateReason === 'source';
    // Only recovery-needed still starts the update. Every other reason is a refusal, so Update now is not offered with it even when
    // self_update is true: the reason's line and the command are the path.
    const actions = noAction ? { primary: null, secondary: null }
      : input.updateReason === 'recovery-needed' && input.updateNowAvailable ? updateActions(input, context)
      : input.updateReason === 'busy' ? BUSY_ACTIONS
      : COMMAND_ACTIONS;
    return {
      card: card ? 'update' : 'notice',
      title: card ? 'Update Astrid' : 'Update unavailable',
      body: INSTALLER_UPDATE_REASON_MESSAGES[input.updateReason],
      ...actions,
      updateReason: input.updateReason,
    };
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
