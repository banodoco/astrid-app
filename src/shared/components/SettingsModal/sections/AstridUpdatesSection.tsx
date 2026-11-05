import { useEffect, useState } from 'react';
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
import { installerUpdateStatusMessage } from '@/shared/lib/updates/updateOperation.ts';
import { usePageStale } from '@/shared/components/RuntimeConnection/AppBuildProvider.tsx';
import { CollapsibleSection } from '@/shared/components/ui/composed/collapsible-section.tsx';

type CheckState = 'checking' | 'ready' | 'error';

function shortBuild(build: string): string {
  return /^[0-9a-f]{8,}$/i.test(build) ? build.slice(0, 7) : build;
}

export function AstridUpdatesSection({ isOpen }: { readonly isOpen: boolean }) {
  const connection = useRuntimeConnection();
  const operation = useInstallerUpdate(connection);
  const pageStale = usePageStale();
  const local = localUpdateStatus();
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
    try {
      saveDiagnosticsReport(report);
      setDiagnosticsError(false);
    } catch {
      setDiagnosticsError(true);
    }
  };

  const installType = operation.installType;

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
      setResolution(resolveUpdate({ ...next.resolution, installType, updateNowAvailable: false, updateReason: operation.updateReason }, 'settings'));
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
  const currentResolution = currentStatus ? resolveUpdate({ ...currentStatus.resolution, pageStale, installType: statusInstallType, updateNowAvailable: operation.available, updateReason: operation.updateReason }, 'settings') : resolution;
  const reportResult = diagnostics.match(/^Last update result: (.*)$/m)?.[1];
  const resultLabels: Record<string, string> = {
    updated: 'Astrid updated.',
    rolled_back: 'The update did not finish. Astrid was restored to its previous version.',
    failed: 'The update did not complete. Check diagnostics before trying again.',
    recovery_needed: 'Astrid needs recovery. Select Update to check the previous operation before continuing.',
  };
  const operationResult = installerUpdateStatusMessage(operation.status);
  // Without an in-app update there is no result to report, so the line is left out rather than saying so.
  const reportLabel = reportResult && reportResult !== 'none' ? resultLabels[reportResult] ?? 'An update result is available in the diagnostics log.' : null;
  const lastResult = operation.pending ? 'Update in progress. Checking its result…' : operation.error ? operation.error : operationResult ?? reportLabel;
  const operationMessage = operation.status && !operation.pending ? installerUpdateStatusMessage(operation.status) || null : null;
  const updateCard = currentResolution?.card === 'notice' || currentResolution?.card === 'update';
  const updateAvailable = Boolean(currentStatus) && updateCard;
  const statusLine = operationMessage
    || (state === 'checking' ? 'Checking for updates…'
      : state === 'error' ? error
        : currentResolution?.card === 'newer' ? currentResolution.body
          : updateAvailable && currentStatus ? `Update available: Release ${currentStatus.servedRelease} (current: Release ${currentStatus.release})`
            : currentStatus ? `Astrid is up to date (Release ${currentStatus.release})` : 'Astrid is up to date');
  // A plain release notice only restates the status line; a required or schema reason, or a Runtime's update reason, is the detail.
  const releaseNotice = currentResolution?.card === 'notice' && !currentResolution.updateReason;
  const detail = state === 'ready' && currentResolution?.body && currentResolution.card !== 'newer' && !releaseNotice ? currentResolution.body : null;
  const logText = operation.status?.result && reportResult !== operation.status.result
    ? 'The latest log is not available in diagnostics yet. Check again.'
    : diagnostics.match(/Installer transaction log:\n([\s\S]*?)\nRetained back-end copies:/)?.[1]?.trim() ?? '';

  return <section id="settings-updates" aria-labelledby="astrid-updates-title" className="mb-6 rounded-lg border p-4">
    <h2 id="astrid-updates-title" className="text-base font-semibold">Updates</h2>
    <div className="mt-3 space-y-3 text-sm">
      <p role="status" aria-live="polite" className={updateAvailable ? 'font-medium' : undefined}>{statusLine}</p>
      {state === 'ready' && currentResolution?.title && !updateCard && <p className="font-medium">{currentResolution.title}</p>}
      {detail && <p className="text-muted-foreground">{detail}</p>}
      {state === 'ready' && currentResolution && (currentResolution.card !== 'none' || operation.status?.state !== 'none') && <UpdateResolutionActions resolution={currentResolution} operation={operation} />}
      {!updateAvailable && <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => void check()} disabled={state === 'checking'}>Check for updates</Button>}
      {lastResult && lastResult !== statusLine && <p className="text-muted-foreground"><span>Last result:</span> <span>{lastResult}</span></p>}
    </div>
    <CollapsibleSection title="Diagnostics" className="mt-4" contentClassName="space-y-3 text-sm">
      <dl className="space-y-1">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">App build</dt><dd title={currentStatus?.app || APP_BUILD || undefined}>{currentStatus?.app || APP_BUILD ? shortBuild(currentStatus?.app || APP_BUILD) : '—'}</dd></div>
      </dl>
      {logText && <details><summary className="cursor-pointer underline">View log</summary>{operation.status?.log_path && <p>{operation.status.log_path}</p>}<pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{logText}</pre></details>}
      <div>
        <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void downloadDiagnostics()}>Download diagnostics</Button>
        {diagnosticsError && <DiagnosticsFallback className="mt-2 space-y-2" />}
      </div>
    </CollapsibleSection>
  </section>;
}
