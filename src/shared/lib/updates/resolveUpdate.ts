import type { RuntimeCompatibilityError } from '@/integrations/runtime/client.ts';
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
};

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
  readonly installType?: 'pinokio' | 'source' | 'fully-local' | 'installer';
  readonly command?: string;
  readonly realError?: string;
}

const settingsAction: UpdateAction = { label: 'Update now', destination: 'settings-updates' };
/** A fully local install updates its own checkout; the installer would leave that checkout behind. */
const FULLY_LOCAL_UPDATE_COMMAND = 'npm run update';
const commandActions = (input: UpdateResolutionInput): Pick<UpdateResolution, 'primary' | 'secondary'> => ({
  primary: { label: 'Copy for your agent' },
  secondary: { label: 'Run it yourself', ...(input.command ? { command: input.command } : {}) },
});

type ActionContext = 'page' | 'settings';

function updateActions(input: UpdateResolutionInput, context: ActionContext, softRelease = false): Pick<UpdateResolution, 'primary' | 'secondary'> {
  if (input.installType === 'pinokio') return { primary: { label: 'Update in Pinokio' }, secondary: null };
  if (input.installType === 'source') return { primary: { label: SOURCE_SCHEMA_MISMATCH_ACTION }, secondary: null };
  if (input.installType === 'fully-local') {
    const runIt: UpdateAction = { label: 'Run it yourself', command: FULLY_LOCAL_UPDATE_COMMAND };
    if (context === 'page') return { primary: settingsAction, secondary: softRelease ? null : runIt };
    return { primary: { label: 'Copy for your agent' }, secondary: runIt };
  }
  if (input.installType === 'installer' && input.updateNowAvailable) return { primary: { label: 'Update now', execute: 'installer-update' }, secondary: commandActions(input).primary };
  if (softRelease) {
    if (context === 'page') return { primary: settingsAction, secondary: null };
    return commandActions(input);
  }
  return commandActions(input);
}

/** The sole update decision point. Conditions are intentionally ordered to match CONTRACTS K6. */
export function resolveUpdate(input: UpdateResolutionInput, context: ActionContext = 'page'): UpdateResolution {
  if (input.runtime) return { card: 'not-running', title: 'Astrid isn’t running', body: input.failure ?? 'Start Astrid Runtime to continue.', primary: { label: 'Start Astrid' }, secondary: { label: 'Repair' } };
  if (input.pageStale) return { card: 'reload', title: 'Editor updated', body: 'Reload this page to use the latest editor.', primary: { label: 'Reload' }, secondary: null };
  if (input.compatibility?.kind === 'identity') return { card: 'identity', title: 'Restart Astrid', body: 'An older Astrid is still running. Restart the selected Runtime, then reconnect.', primary: null, secondary: null };
  if (input.installedRelease !== undefined && input.servedRelease !== undefined && input.installedRelease > input.servedRelease) {
    return { card: 'newer', title: null, body: 'Astrid on this computer is newer than astrid.haus; a fix is on its way.', primary: null, secondary: null };
  }
  if (input.compatibility?.kind === 'schema') {
    return { card: 'update', title: 'Update Astrid', body: input.compatibility.detail, ...updateActions(input, context) };
  }
  if (input.midSessionSchemaMismatch) {
    return { card: 'mid-session', title: 'Editor updated', body: 'Update Astrid, then reload when your drafts can be saved.',
      ...updateActions(input, context) };
  }
  if (input.requiredRelease !== undefined && input.installedRelease !== undefined && input.installedRelease < input.requiredRelease) {
    return { card: 'update', title: 'Update Astrid', body: `This update is required: ${input.requiredReason ?? 'A required update is available.'}`, ...updateActions(input, context) };
  }
  if (input.releaseBehind) {
    return { card: 'notice', title: 'Update available', body: 'A newer release of Astrid is available.', ...updateActions(input, context, true) };
  }
  if (input.realError || input.compatibility) return { card: 'error', title: 'Could not connect to Astrid', body: input.realError ?? input.compatibility?.detail ?? 'An unexpected error occurred.', primary: null, secondary: null };
  return { card: 'none', title: null, body: null, primary: null, secondary: null };
}
