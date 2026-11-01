import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS } from '@/integrations/runtime/contract-metadata.ts';
import { type RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { type SetupChecks } from '@/shared/components/RuntimeConnection/SetupStatusLine.tsx';
import { RUNTIME_CONNECTION_COPY as COPY, withBrowser, withOrigin } from '@/shared/components/RuntimeConnection/copy.ts';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import type { InstallType, UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';

interface ConnectionStatus {
  readonly title: string;
  readonly detail?: string;
  /** Onboarding's Runtime and Workspace marks; left out while the browser's permission is the step, as nothing is checked then. */
  readonly checks?: SetupChecks;
  /** The one step this page can take itself: asking the browser for permission. */
  readonly connect?: boolean;
  /** Which part of Astrid on this computer is older than this page; the update routes belong under the status. */
  readonly outOfDate?: 'runtime' | 'chat';
  readonly updateResolution?: UpdateResolution;
}

const REACHED: SetupChecks = { runtime: 'pass', workspace: 'pass', ready: true };
/** The provider keeps looking until Astrid answers, so these spin rather than fail. */
const LOOKING: SetupChecks = { runtime: 'checking', workspace: 'checking', ready: false };

/** The caller supplies the install type from the Runtime's identity (`installTypeOf`), never from the connection alone. */
function schemaUpdateStatus(checks: SetupChecks, installType: InstallType): ConnectionStatus {
  const resolution = resolveUpdate({ compatibility: { kind: 'schema', detail: COPY.updateNeeded.sentence }, installType });
  return { title: resolution.title ?? COPY.updateNeeded.title, detail: resolution.body ?? COPY.updateNeeded.sentence, checks, outOfDate: 'runtime', updateResolution: resolution };
}

/** Same digests the Runtime client accepts: anything else, and the page can't open a session with this Astrid. */
function needsUpdate(schemaDigest: string | null): boolean {
  return schemaDigest !== null && !(RUNTIME_ACCEPTED_SCHEMA_DIGESTS as readonly string[]).includes(schemaDigest);
}

/** Each gate state's title and one line: the connection screens' own words, without their buttons and guides. */
export function connectionStatus(connection: RuntimeConnectionValue, installType: InstallType): ConnectionStatus {
  const { state } = connection;
  switch (state.status) {
    case 'connected':
      if (needsUpdate(connection.schemaDigest)) {
        return schemaUpdateStatus(REACHED, installType);
      }
      // The Runtime itself is fine; only the chat service is older than this page.
      if (connection.localServiceOutOfDate) {
        return { title: COPY.connected.sentence, detail: COPY.chatNeedsUpdate, checks: REACHED, outOfDate: 'chat' };
      }
      return {
        title: COPY.connected.sentence,
        detail: connection.realmName ? `Workspace: ${connection.realmName}` : undefined,
        checks: REACHED,
      };
    case 'connecting':
      return { title: COPY.connecting.sentence, checks: LOOKING };
    case 'needs_permission':
      if (connection.isChecking) {
        return { title: withBrowser(COPY.permission.pending.title), detail: withBrowser(COPY.permission.pending.sentence) };
      }
      return { title: withBrowser(COPY.permission.title), detail: withBrowser(COPY.permission.sentence), connect: true };
    case 'blocked':
      // The steps, not the reason: the title already says what is wrong.
      return { title: withBrowser(COPY.blocked.title), detail: COPY.blocked.steps.join(' ') };
    case 'phone':
      return { title: COPY.phone.title, detail: COPY.phone.sentence };
    case 'unsupported':
      return { title: COPY.unsupported.title, detail: COPY.unsupported.sentence };
    case 'browser_update_needed':
      return { title: withBrowser(COPY.browserUpdateNeeded.title), detail: withBrowser(COPY.browserUpdateNeeded.sentence) };
    case 'restart':
      return { title: COPY.restarted.title, detail: COPY.restarted.sentence, checks: LOOKING };
    case 'update_needed':
      return schemaUpdateStatus(LOOKING, installType);
    case 'refused':
      return { title: COPY.refused.title, detail: withOrigin(COPY.refused.sentence, window.location.origin), checks: LOOKING };
    case 'not_running':
      return { title: COPY.notRunning.title, detail: COPY.notRunning.sentence, checks: LOOKING };
  }
}
