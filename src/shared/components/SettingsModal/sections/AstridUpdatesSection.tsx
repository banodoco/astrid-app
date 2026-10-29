import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { UpdateResolutionActions } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';
import { DiagnosticsFallback } from '@/shared/components/RuntimeConnection/DownloadDiagnosticsButton.tsx';
import { fetchDiagnosticsReport, saveDiagnosticsReport } from '@/shared/components/RuntimeConnection/diagnosticsDownload.ts';
import { resolveUpdate, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { localUpdateStatus, pageInstallType } from '@/shared/lib/updates/pageUpdateStatus.ts';
import { checkHostedUpdate, checkLocalUpdate, type UpdateStatus } from '@/shared/lib/updates/updateStatus.ts';
import { APP_BUILD } from '@/shared/lib/updates/appBuildWatch.ts';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { installerUpdateStatusMessage, pageLocalUpdate } from '@/shared/lib/updates/updateOperation.ts';
import { useGuardedReload } from '@/shared/lib/updates/draftSafeReload.ts';
import { usePageStale } from '@/shared/components/RuntimeConnection/AppBuildProvider.tsx';

type CheckState = 'checking' | 'ready' | 'error';

function shortBuild(build: string): string {
  return /^[0-9a-f]{8,}$/i.test(build) ? build.slice(0, 7) : build;
}

export function AstridUpdatesSection({ isOpen }: { readonly isOpen: boolean }) {
  const connection = useRuntimeConnection();
  const operation = useInstallerUpdate(connection);
  const pageStale = usePageStale();
  const local = localUpdateStatus();
  const localUpdate = pageLocalUpdate();
  const localState = useSyncExternalStore(localUpdate.subscribe, localUpdate.getSnapshot, localUpdate.getSnapshot);
  const guarded = useGuardedReload();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [state, setState] = useState<CheckState>('checking');
  const [error, setError] = useState('');
  const [resolution, setResolution] = useState<UpdateResolution | null>(null);
  const [diagnostics, setDiagnostics] = useState('');
  const [diagnosticsError, setDiagnosticsError] = useState(false);

  const loadDiagnostics = async () => {
    try {
      const report = await fetchDiagnosticsReport(fetch);
      setDiagnostics(report);
      setDiagnosticsError(false);
      return report;
    } catch {
      setDiagnostics('');
      setDiagnosticsError(true);
      return '';
    }
  };

  const downloadDiagnostics = async () => {
    const report = diagnostics || await loadDiagnostics();
    if (!report) return;
    saveDiagnosticsReport(report);
  };

  const installType = operation.installType;

  const updateNow = async () => {
    const outcome = await localUpdate.start();
    // A rolled-back editor is also replaced, so both outcomes flush drafts first.
    if (outcome.phase === 'done' && outcome.status !== 'up-to-date') await guarded.reload();
  };

  const check = async () => {
    setState('checking');
    setError('');
    void operation.refresh();
    try {
      let next: UpdateStatus;
      if (local) {
        next = await checkLocalUpdate();
      } else {
        // A schema-incompatible Runtime can still expose authenticated health
        // and installer status without a workspace session. Older test and
        // embedded values fall back to the established connection signal.
        const canReadInstallerStatus = connection.isAuthenticated ?? connection.isConnected;
        if (!connection.isConnected && !(connection.state?.status === 'update_needed' && canReadInstallerStatus)) {
          throw new Error('Connect to Astrid before checking its release.');
        }
        const health = operation.health ?? await new AstridRuntimeClient().readInstallerUpdateHealth();
        next = await checkHostedUpdate(health);
      }
      setStatus(next);
      setResolution(resolveUpdate({ ...next.resolution, installType, updateNowAvailable: false }, 'settings'));
      setState('ready');
    } catch {
      setStatus(null);
      setResolution(null);
      setError(!connection.isConnected && connection.state?.status !== 'update_needed'
        ? 'Connect to Astrid before checking its release.'
        : 'Could not check Astrid update status. Check your connection and try again.');
      setState('error');
    }
  };

  useEffect(() => {
    if (isOpen) { void check(); void loadDiagnostics(); }
    // A fresh status is requested each time Settings opens; Check for updates invokes the same path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Status and diagnostics read the same producer-owned result. Refresh the
  // report when that result changes so View log never retains the prior run.
  const operationKey = `${operation.status?.operation_id ?? ''}:${operation.status?.state ?? ''}:${operation.status?.result ?? ''}`;
  useEffect(() => {
    if (isOpen && operation.status) void loadDiagnostics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, operationKey]);
  const currentStatus = operation.releaseStatus ?? status;
  // The status being shown carries the Runtime identity it was read from, so the install type does not wait for the operation's health.
  const statusInstallType = currentStatus ? pageInstallType(currentStatus.managedBy, connection.managedByPinokio) : installType;
  const currentResolution = currentStatus ? resolveUpdate({ ...currentStatus.resolution, pageStale, installType: statusInstallType, updateNowAvailable: operation.available }, 'settings') : resolution;
  const reportResult = diagnostics.match(/^Last update result: (.*)$/m)?.[1];
  const resultLabels: Record<string, string> = {
    none: 'No update has run yet.',
    updated: 'Astrid updated.',
    rolled_back: 'The update did not finish. Astrid was restored to its previous version.',
    failed: 'The update did not complete. Check diagnostics before trying again.',
    recovery_needed: 'Astrid needs repair. Download diagnostics and run the installer update command.',
  };
  const operationResult = installerUpdateStatusMessage(operation.status);
  const lastResult = operation.pending ? 'Update in progress. Checking its result…' : operation.error ? operation.error : operationResult ?? (reportResult ? resultLabels[reportResult] ?? 'An update result is available in the diagnostics log.' : 'No update has run yet.');
  const statusLine = operation.status?.state === 'recovery-needed'
    ? 'Astrid needs repair. Download diagnostics and run the installer update command.'
    : state === 'checking' ? 'Checking for updates…' : state === 'error' ? error : currentResolution?.card === 'newer' ? currentResolution.body : currentStatus && (currentResolution?.card === 'notice' || currentResolution?.card === 'update') ? `Update available · Release ${currentStatus.servedRelease}` : 'Astrid is up to date';

  return <section id="settings-updates" aria-labelledby="astrid-updates-title" className="mb-6 rounded-lg border p-4">
    <h2 id="astrid-updates-title" className="text-base font-semibold">Updates</h2>
    <dl className="mt-3 space-y-1 text-sm">
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Release</dt><dd>{currentStatus ? `Release ${currentStatus.release}` : '—'}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">App build</dt><dd title={currentStatus?.app || APP_BUILD || undefined}>{currentStatus?.app || APP_BUILD ? shortBuild(currentStatus?.app || APP_BUILD) : '—'}</dd></div>
    </dl>
    <div className="mt-3 space-y-2">
      <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void check()} disabled={state === 'checking'}>
        {state === 'checking' ? 'Checking for updates…' : 'Check for updates'}
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {statusLine}
      </p>
      {state === 'ready' && currentResolution?.title && <div className="text-sm"><p className="font-medium">{currentResolution.title}</p>{currentResolution.body && <p className="text-muted-foreground">{currentResolution.body}</p>}</div>}
      {state === 'ready' && installType === 'fully-local' && currentStatus?.behind && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={localState.phase === 'running'} onClick={() => void updateNow()}>{localState.phase === 'running' ? 'Updating Astrid…' : 'Update now'}</Button>}
      {localState.phase === 'running' && <p role="status">Update in progress. Astrid may disconnect while it restarts.</p>}
      {localState.phase === 'done' && <p role="status">{localState.message || (localState.status === 'up-to-date' ? 'Astrid is up to date.' : localState.status === 'recovered' ? 'The update did not finish, so Astrid went back to the previous version.' : 'Astrid updated.')}</p>}
      {localState.phase === 'done' && localState.status !== 'up-to-date' && <Button type="button" variant="retro-secondary" size="retro-sm" disabled={guarded.pending} onClick={() => void guarded.reload()}>Reload</Button>}
      {localState.phase === 'failed' && <p role="alert">{localState.message}</p>}
      {guarded.error && <p role="alert">{guarded.error}</p>}
      {localState.phase === 'refused' && <><p role="alert">{localState.message}</p><UpdateResolutionActions resolution={resolveUpdate({ installType: 'fully-local', releaseBehind: true }, 'settings')} /></>}
      {state === 'ready' && localState.phase !== 'refused' && currentResolution && (currentResolution.card !== 'none' || operation.status?.state !== 'none') && <UpdateResolutionActions resolution={currentResolution} operation={operation} />}
      <div className="border-t pt-2 text-sm">
        <p><span className="text-muted-foreground">Last result:</span> {lastResult}</p>
        <details className="mt-1"><summary className="cursor-pointer underline">View log</summary>{operation.status?.log_path && <p>{operation.status.log_path}</p>}<pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{operation.status?.result && reportResult !== operation.status.result ? 'The latest log is not available in diagnostics yet. Check again.' : diagnostics.match(/Installer transaction log:\n([\s\S]*?)\nRetained back-end copies:/)?.[1] || 'No update log yet.'}</pre></details>
        <Button type="button" variant="retro-secondary" size="retro-sm" className="mt-2" onClick={() => void downloadDiagnostics()}>Download diagnostics</Button>
        {diagnosticsError && <DiagnosticsFallback className="mt-2 space-y-2" />}
      </div>
    </div>
  </section>;
}
