import { useLayoutEffect } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { setRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { CopyInstallCommand } from './CopyInstallCommand.tsx';
import { CopyRefusedInstructions } from './CopyRefusedInstructions.tsx';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers.ts';
import { RUNTIME_CONNECTION_COPY as COPY, withCommandShell, withOrigin } from './copy.ts';
import { useRuntimeRestartWatch } from './useRuntimeRestartWatch.ts';
import { QuietUpdateNotice } from './QuietUpdateNotice.tsx';
import { DownloadDiagnosticsButton } from './DownloadDiagnosticsButton.tsx';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { useGuardedReload } from '@/shared/lib/updates/draftSafeReload.ts';
import { installerUpdateStatusMessage } from '@/shared/lib/updates/updateOperation.ts';

export interface RuntimeConnectionPillProps {
  readonly connection: RuntimeConnectionValue;
  /** Override for tests; reloading the page is how the person picks up the restarted Astrid. */
  readonly onReload?: () => void;
  /** Overrides for tests of the restart watch; the defaults are the production interval and `fetch`. */
  readonly restartCheckIntervalMs?: number;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Fixed bottom-right with a 16px gutter; on a phone it sits above the floating lock/gallery toolbar. */
const CARD_CLASS = 'fixed bottom-20 right-4 w-[calc(100%-2rem)] max-w-sm space-y-3 rounded-2xl border border-border bg-card p-5 text-center text-card-foreground shadow-md sm:bottom-4';

const CARD_STYLE = { zIndex: UI_Z_LAYERS.RUNTIME_RECOVERY_CARD } as const;

function CardText({ title, sentence }: { title: string; sentence: string }) {
  return (
    <div className="space-y-1">
      <h2 className="font-serif font-theme-heading text-base text-foreground">{title}</h2>
      <p className="text-balance text-sm text-muted-foreground">{sentence}</p>
    </div>
  );
}

/**
 * What the connected page says about Astrid, bottom-right. While Astrid is up it says nothing visible: the
 * editor already shows the project, and a "Connected" badge went stale the moment Astrid stopped. Three cards replace it:
 * "Astrid is busy" (answering late, clears itself), "Astrid stopped" (it clears itself when Astrid is back) and "Astrid restarted" (Reload). The editor stays mounted with
 * its draft either way. Renders nothing while not connected (the gate shows the panel then).
 */
export function RuntimeConnectionPill({
  connection,
  onReload = () => window.location.reload(),
  restartCheckIntervalMs,
  fetchImpl,
}: RuntimeConnectionPillProps) {
  const operation = useInstallerUpdate(connection);
  const guarded = useGuardedReload(onReload);
  const restart = useRuntimeRestartWatch(connection.isConnected, { intervalMs: restartCheckIntervalMs, fetchImpl, confirmPermission: connection.confirmPermission });
  const cardShowing = connection.isConnected && restart !== 'ok';

  // The editor's own technical messages about the same failure stay quiet while the card is the one thing to read.
  // A layout effect, so the flag flips in the same commit that shows the card: no frame shows both.
  useLayoutEffect(() => {
    setRecoveryCardShowing(cardShowing);
    return () => setRecoveryCardShowing(false);
  }, [cardShowing]);

  if (!connection.isConnected) return null;

  if (restart === 'ok') {
    return (
      <><div data-testid="runtime-connection-status" data-state="connected" className="sr-only">
        {COPY.connected.sentence}
      </div><QuietUpdateNotice connection={connection} /></>
    );
  }

  if (restart === 'busy') {
    return (
      <div data-testid="runtime-connection-status" data-state="busy" role="status" className={CARD_CLASS} style={CARD_STYLE}>
        <CardText title={COPY.busy.title} sentence={COPY.busy.sentence} />
        <DownloadDiagnosticsButton />
      </div>
    );
  }

  if (restart === 'stopped') {
    const pinokioManaged = connection.managedByPinokio === true;
    return (
      <div data-testid="runtime-connection-status" data-state="stopped" role="alert" className={CARD_CLASS} style={CARD_STYLE}>
        <CardText title={COPY.stopped.title} sentence={pinokioManaged ? COPY.stopped.pinokioSentence : withCommandShell(COPY.stopped.sentence)} />
        {!pinokioManaged && <CopyInstallCommand mode="install" />}
      </div>
    );
  }

  if (restart === 'refused') {
    return (
      <div data-testid="runtime-connection-status" data-state="refused" role="alert" className={CARD_CLASS} style={CARD_STYLE}>
        <CardText title={COPY.refused.title} sentence={withOrigin(COPY.refused.sentence, window.location.origin)} />
        <CopyRefusedInstructions />
      </div>
    );
  }

  return (
    <div data-testid="runtime-connection-status" data-state="restarted" role="alert" className={CARD_CLASS} style={CARD_STYLE}>
      <CardText title={COPY.restarted.title} sentence={COPY.restarted.sentence} />
      {operation.pending && <p role="status">Update in progress. Checking its result…</p>}
      {operation.fresh && installerUpdateStatusMessage(operation.status) && <p role="status">{installerUpdateStatusMessage(operation.status)}</p>}
      {operation.error && <p role="alert">Could not confirm the update status. Download diagnostics before trying again.</p>}
      <Button type="button" className="w-full sm:w-auto" disabled={guarded.pending} onClick={() => void guarded.reload()}>{COPY.restarted.reload}</Button>
      {guarded.error && <p role="alert">{guarded.error}</p>}
    </div>
  );
}
