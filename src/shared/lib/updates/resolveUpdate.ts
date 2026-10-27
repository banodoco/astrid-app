import type { RuntimeCompatibilityError } from '@/integrations/runtime/client.ts';

export type UpdateAction = {
  readonly label: string;
  readonly destination?: 'settings-updates';
  readonly command?: string;
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
  readonly primaryUpdateLabel?: string;
  readonly installType?: 'pinokio' | 'source' | 'fully-local' | 'installer';
  readonly command?: string;
  readonly realError?: string;
}

const settingsAction: UpdateAction = { label: 'Update now', destination: 'settings-updates' };
const commandActions = (input: UpdateResolutionInput): Pick<UpdateResolution, 'primary' | 'secondary'> => ({
  primary: { label: 'Copy for your agent' },
  secondary: { label: 'Run it yourself', ...(input.command ? { command: input.command } : {}) },
});

/** The sole update decision point. Conditions are intentionally ordered to match CONTRACTS K6. */
export function resolveUpdate(input: UpdateResolutionInput): UpdateResolution {
  if (input.runtime) return { card: 'not-running', title: 'Astrid isn’t running', body: input.failure ?? 'Start Astrid Runtime to continue.', primary: { label: 'Start Astrid' }, secondary: { label: 'Repair' } };
  if (input.pageStale) return { card: 'reload', title: 'Editor updated', body: 'Reload this page to use the latest editor.', primary: { label: 'Reload' }, secondary: null };
  if (input.compatibility?.kind === 'identity') return { card: 'identity', title: 'Restart Astrid', body: 'An older Astrid is still running. Restart the selected Runtime, then reconnect.', primary: null, secondary: null };
  if (input.installedRelease !== undefined && input.servedRelease !== undefined && input.installedRelease > input.servedRelease) {
    return { card: 'newer', title: null, body: 'Astrid on this computer is newer than astrid.haus; a fix is on its way.', primary: null, secondary: null };
  }
  if (input.compatibility?.kind === 'schema') {
    const commands = commandActions(input);
    if (input.installType === 'pinokio') return { card: 'update', title: 'Update Astrid', body: input.compatibility.detail, primary: { label: 'Update in Pinokio' }, secondary: null };
    if (input.installType === 'source') return { card: 'update', title: 'Update Astrid', body: input.compatibility.detail, primary: { label: 'update your checkouts' }, secondary: null };
    return { card: 'update', title: 'Update Astrid', body: input.compatibility.detail,
      primary: input.updateNowAvailable ? { label: input.primaryUpdateLabel ?? 'Update now', destination: 'settings-updates' } : commands.primary,
      secondary: input.updateNowAvailable ? commands.primary : commands.secondary };
  }
  if (input.midSessionSchemaMismatch) {
    const commands = commandActions(input);
    return { card: 'mid-session', title: 'Editor updated', body: 'Update Astrid, then reload when your draft is safe.',
      primary: input.updateNowAvailable ? settingsAction : commands.primary,
      secondary: input.updateNowAvailable ? commands.primary : commands.secondary };
  }
  if (input.requiredRelease !== undefined && input.installedRelease !== undefined && input.installedRelease < input.requiredRelease) {
    const commands = commandActions(input);
    return { card: 'update', title: 'Update Astrid', body: `This update is required: ${input.requiredReason ?? 'A required update is available.'}`, primary: input.updateNowAvailable ? settingsAction : commands.primary, secondary: commands.secondary };
  }
  if (input.releaseBehind) return { card: 'notice', title: 'Update available', body: 'A newer release of Astrid is available.', primary: settingsAction, secondary: null };
  if (input.realError || input.compatibility) return { card: 'error', title: 'Could not connect to Astrid', body: input.realError ?? input.compatibility?.detail ?? 'An unexpected error occurred.', primary: null, secondary: null };
  return { card: 'none', title: null, body: null, primary: null, secondary: null };
}
