import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AlertDialog, AlertDialogContent } from '@/shared/components/ui/alert-dialog.tsx';
import { AlertTriangle, Check, Copy, LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card.tsx';
import { writeClipboardTextSafe } from '@/shared/lib/browser/clipboard.ts';
import { ASTRID_APP_LOCAL_DEV_COMMAND } from '@/shared/lib/localAstridRuntime.ts';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { useRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { RuntimeAuthenticationError, RuntimeCompatibilityError, RuntimeUnavailableError } from '@/integrations/runtime/client.ts';
import { describeFailure, healthCheckCommand, RUNTIME_CONNECTION_COPY, runtimeLogDirectory } from '@/shared/components/RuntimeConnection/copy.ts';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { usePageStale } from './AppBuildProvider.tsx';
import { detectPlatform } from '@/shared/hooks/platformInstall/platformDetection.ts';
import { useRuntimeConnectionSafe } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';

export interface RuntimeConnectorRecoveryBannerProps {
  readonly retrying?: boolean;
  readonly error: Error;
  readonly onRetry: () => void | Promise<void>;
  /** Concise explanation of which workspace check failed. */
  readonly failureSummary?: string | null;
  /** Current route identity, when the editor has one. */
  readonly projectId?: string | null;
  readonly timelineId?: string | null;
  /** A configured, non-secret Runtime URL when the host knows it. */
  readonly connectionUrl?: string | null;
}

function safeConnectionUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function buildWorkspaceRestartBrief({
  error,
  connectionUrl,
  projectId,
  timelineId,
}: { error: unknown; connectionUrl?: string | null; projectId?: string | null; timelineId?: string | null }): string {
  const diagnostic = (typeof error === 'string' ? error.trim() : describeFailure(error).summary)
    || 'The editor cannot reach its configured Astrid Runtime.';
  const safeUrl = safeConnectionUrl(connectionUrl);
  const platform = detectPlatform();
  const pageOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
  return [
    'Please restore this editor’s existing Astrid Runtime connection.',
    'Keep the current installation, Runtime profile, data root, workspace files, credentials, and agent instructions. Do not reset, reinstall, create a new data root, or switch to the bundled demo bridge.',
    `Restart the existing app process through its local launcher (${ASTRID_APP_LOCAL_DEV_COMMAND}) from the same Astrid App checkout. If the Runtime is managed separately, restart that existing Runtime with its current command, profile, and data root; inspect the existing configuration instead of guessing a path.`,
    ...(projectId || timelineId ? [`Preserve the current editor route identity: project ${projectId || '(unknown)'}, timeline ${timelineId || '(unknown)'}.`] : []),
    `Current editor diagnostic: ${diagnostic}`,
    ...(safeUrl ? [`Configured editor origin for the workspace connection: ${safeUrl}`] : []),
    `Service logs are named service-<name>.log under ${runtimeLogDirectory(platform)}.`,
    ...(safeUrl ? [`Check Runtime health: \`${healthCheckCommand(safeUrl, pageOrigin, platform)}\`.`] : []),
    'Verify that the same configured Runtime is healthy, editor project and timeline discovery return the same selections, and the existing configured agent responds without changing its instructions. Leave the existing processes available after verification.',
  ].join('\n\n');
}

const QUIET_RETRY_MS = 3000;

/**
 * A popup over whatever is behind it (the editor keeps its layout), not dismissable while the connection is down.
 * While it shows, it quietly retries every few seconds so a Runtime restart heals without a click.
 */
// Initial focus goes to Retry, not the first tabbable element (the diagnostic summary).
function RecoveryOverlay({ onRetry, retryRef, children, quietRetry = true }: { quietRetry?: boolean; onRetry: () => void | Promise<void>; retryRef: RefObject<HTMLButtonElement | null>; children: ReactNode }) {
  const latestRetry = useRef(onRetry);
  const inFlight = useRef(false);
  useEffect(() => {
    latestRetry.current = onRetry;
  });
  useEffect(() => {
    if (!quietRetry) return undefined;
    const timer = setInterval(() => {
      if (inFlight.current) return;
      inFlight.current = true;
      void Promise.resolve()
        .then(() => latestRetry.current())
        .catch(() => undefined)
        .finally(() => { inFlight.current = false; });
    }, QUIET_RETRY_MS);
    return () => clearInterval(timer);
  }, [quietRetry]);
  return (
    <AlertDialog open onOpenChange={() => undefined}>
      <AlertDialogContent
        backdropClassName="bg-black/55"
        className="max-h-[85vh] max-w-2xl gap-0 overflow-y-auto border-0 bg-transparent p-0 shadow-none"
        data-testid="runtime-connector-alert"
        initialFocus={retryRef}
      >
        {children}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One recovery surface for typed connector failures and discovery diagnostics. */
export function RuntimeConnectorRecoveryBanner({
  retrying = false,
  error,
  onRetry,
  failureSummary,
  projectId,
  timelineId,
  connectionUrl,
}: RuntimeConnectorRecoveryBannerProps) {
  const [briefCopyFailed, setBriefCopyFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const safeUrl = safeConnectionUrl(connectionUrl);
  const hosted = runtimeOrigin() !== '';
  const pageStale = usePageStale();
  const operation = useInstallerUpdate(useRuntimeConnectionSafe());
  const failure = describeFailure(error);
  const restartBrief = buildWorkspaceRestartBrief({ error, connectionUrl: safeUrl, projectId, timelineId });
  const authenticationFailed = error instanceof RuntimeAuthenticationError;
  const updateResolution = resolveUpdate({ ...operation.releaseStatus?.resolution, runtime: error instanceof RuntimeUnavailableError ? 'unreachable' : undefined, pageStale, compatibility: error instanceof RuntimeCompatibilityError ? error : undefined, installType: operation.installType, updateNowAvailable: operation.available, updateReason: operation.updateReason });
  const schemaUpdate = updateResolution.card === 'update';
  const typedFailure = authenticationFailed || error instanceof RuntimeCompatibilityError || error instanceof RuntimeUnavailableError && (error.failureKind === "admission" || error.failureKind === "storage");
  const visibleFailureSummary = failureSummary?.trim()
    || (!hosted ? failure.summary : null)
    || 'The editor could not complete workspace discovery.';

  const copyRestartInstructions = async () => {
    const copied = await writeClipboardTextSafe(restartBrief);
    // The brief is for the agent; it is shown only as a fallback when copying fails.
    setBriefCopyFailed(!copied);
    setCopyStatus(copied
      ? 'Restart instructions copied. Paste them into your agent.'
      : 'Clipboard access is unavailable. Copy the brief from the field below.');
  };

  const retryRef = useRef<HTMLButtonElement>(null);
  const recoveryCardShowing = useRecoveryCardShowing();
  if (hosted && recoveryCardShowing) return null;
  const titles = RUNTIME_CONNECTION_COPY.connectorFailure;
  const title = authenticationFailed
    ? titles.authentication
    : error instanceof RuntimeCompatibilityError
      ? updateResolution.title ?? titles.unavailable
      : error instanceof RuntimeUnavailableError && error.failureKind === "admission"
        ? titles.admission
        : error instanceof RuntimeUnavailableError && error.failureKind === "storage"
          ? titles.storage
          : titles.unavailable;
  const action = 'recoveryAction' in error && typeof error.recoveryAction === 'string'
    ? error.recoveryAction
    : 'Retry the connection to your configured Astrid Runtime.';
  if (updateResolution.card === 'newer') return <div role="status" data-testid="runtime-connector-alert" className="fixed left-1/2 top-16 z-[100110] -translate-x-1/2 rounded-xl border bg-background p-4 shadow-xl">{updateResolution.body}</div>;
  if (updateResolution.card === 'reload') return (
    <div role="alert" data-testid="runtime-connector-alert" className="fixed left-1/2 top-16 z-[100110] w-[min(56rem,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-border bg-background p-4 shadow-xl sm:flex sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:max-w-sm">
        <p className="text-sm font-medium text-foreground">{updateResolution.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{updateResolution.body}</p>
      </div>
      <div className="mt-3 w-full sm:mt-0 sm:max-w-sm"><UpdateResolutionActions resolution={updateResolution} operation={operation} /></div>
    </div>
  );
  if (schemaUpdate) return (
    <div role="alert" data-testid="runtime-connector-alert" className="fixed left-1/2 top-16 z-[100110] w-[min(56rem,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-border bg-background p-4 shadow-xl sm:flex sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:max-w-sm">
        <p className="text-sm font-medium text-foreground">Update Astrid</p>
        <p className="mt-1 text-xs text-muted-foreground">{updateResolution.body} Your draft and undo history stay open.</p>
      </div>
      <div className="mt-3 w-full sm:mt-0 sm:max-w-sm"><UpdateResolutionActions resolution={updateResolution} operation={operation} /></div>
    </div>
  );
  if (hosted) return (
    <RecoveryOverlay onRetry={onRetry} retryRef={retryRef} quietRetry={!authenticationFailed}>
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background p-6 shadow-lg" role="alert">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{typedFailure ? title : RUNTIME_CONNECTION_COPY.loadFailed.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{error instanceof RuntimeCompatibilityError && updateResolution.card === 'identity' ? updateResolution.body : typedFailure ? action : RUNTIME_CONNECTION_COPY.loadFailed.sentence}</p>
      </div>
      <Button ref={retryRef} type="button" size="sm" variant="outline" onClick={() => void onRetry()} disabled={retrying}>
        {retrying ? RUNTIME_CONNECTION_COPY.loadFailed.retrying : RUNTIME_CONNECTION_COPY.loadFailed.button}
      </Button>
    </div>
    </RecoveryOverlay>
  );

  return (
    <RecoveryOverlay onRetry={onRetry} retryRef={retryRef}>
      <Card className="w-full min-w-0 border-border/80 shadow-lg" role="alert">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription className="max-w-prose text-sm leading-6">
            {action} Your current project, timeline selection and drafts will be kept.
          </CardDescription>
          <p className="mt-2 break-words rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground" data-testid="workspace-connection-summary">
            {visibleFailureSummary}
          </p>
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium">Show full connection error</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2" data-testid="workspace-connection-diagnostic">
              {error.message.trim() || 'No additional connection error details were provided.'}
            </pre>
          </details>
          {safeUrl && <p className="break-all text-xs text-muted-foreground">Configured editor origin: <code>{safeUrl}</code></p>}
        </CardHeader>
        <CardContent className="space-y-4">
          <Button ref={retryRef} type="button" className="h-auto min-h-10 w-full whitespace-normal py-2 sm:w-auto" onClick={() => void onRetry()} disabled={retrying}>
            {retrying ? <LoaderCircle aria-hidden="true" className="mr-2 h-4 w-4 shrink-0 animate-spin" /> : <RotateCcw aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />}
            {retrying ? 'Retrying Runtime connection…' : 'Retry Runtime connection'}
          </Button>

          <div className="grid gap-3 border-t border-border/70 pt-4 sm:grid-cols-2">
            <section className="min-w-0 rounded-lg border border-border/70 p-3">
              <h2 className="text-sm font-medium">Use your coding agent</h2>
              <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">Copy the diagnostic and restart instructions, then paste them into your coding agent.</p>
              <Button type="button" variant="outline" className="mt-2 h-auto min-h-10 w-full whitespace-normal py-2 leading-5" onClick={() => void copyRestartInstructions()}>
                {copyStatus.startsWith('Restart instructions copied') ? <Check aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" /> : <Copy aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />}
                Copy restart instructions
              </Button>
              {copyStatus && <p role="status" className="mt-2 text-xs text-muted-foreground">{copyStatus}</p>}
              {briefCopyFailed && <>
                <label className="mt-2 block text-xs font-medium" htmlFor="workspace-restart-brief">Restart brief</label>
                <textarea id="workspace-restart-brief" aria-label="Restart brief" readOnly rows={8} value={restartBrief} className="mt-1 w-full resize-y rounded-md border border-border bg-background p-2 text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onFocus={(event) => event.currentTarget.select()} />
              </>}
            </section>

            <section className="min-w-0 rounded-lg border border-border/70 p-3">
              <h2 className="text-sm font-medium">Use your terminal</h2>
              <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">Use the existing startup configuration so the app returns to the same Runtime and data.</p>
              <ol id="workspace-manual-restart-steps" className="mt-3 list-decimal space-y-2 pl-4 text-xs leading-5 text-muted-foreground">
                <li>Return to the same Astrid App checkout and terminal used to start this app. Restart its existing local launcher with <code className="rounded bg-muted px-1 py-0.5 text-foreground">{ASTRID_APP_LOCAL_DEV_COMMAND}</code>.</li>
                <li>If Astrid Runtime is a separate process, restart that same Runtime with its current command, profile, and data-root configuration. Keep the existing install and data location.</li>
                <li>Wait for the Runtime to become ready, then choose <strong className="font-medium text-foreground">Retry connection</strong> here and confirm the same project, timeline, and configured agent return.</li>
              </ol>
              <p className="mt-3 text-[11px] leading-4 text-muted-foreground">Do not reset or reinstall the workspace, change its data root, or replace its credentials.</p>
            </section>
          </div>
        </CardContent>
      </Card>
    </RecoveryOverlay>
  );
}
