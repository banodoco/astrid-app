import { useEffect, useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { UpdateResolutionActions } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';
import { CopyCommandRow } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';
import { DiagnosticsFallback } from '@/shared/components/RuntimeConnection/DownloadDiagnosticsButton.tsx';
import { fetchDiagnosticsReport, saveDiagnosticsReport } from '@/shared/components/RuntimeConnection/diagnosticsDownload.ts';
import { ASTRID_COMMANDS, RUNTIME_CONNECTION_COPY, updateNeededSentence } from '@/shared/components/RuntimeConnection/copy.ts';
import { detectPlatform } from '@/shared/hooks/platformInstall/platformDetection.ts';
import { resolveUpdate, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { localUpdateStatus, pageInstallType } from '@/shared/lib/updates/pageUpdateStatus.ts';
import { checkHostedUpdate, checkLocalUpdate, type UpdateStatus } from '@/shared/lib/updates/updateStatus.ts';
import { APP_BUILD } from '@/shared/lib/updates/appBuildWatch.ts';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { installerUpdateStatusMessage } from '@/shared/lib/updates/updateOperation.ts';
import { usePageStale } from '@/shared/components/RuntimeConnection/AppBuildProvider.tsx';
import { astridOutOfDate } from './ConnectionSection.tsx';
import { ASTRID_STATUS_COPY } from './astridStatusCopy.ts';
import { SettingsDetail, SettingsDisclosureRow, SettingsRow, SettingsSection, SettingsValue } from '../SettingsLayout.tsx';

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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [downloadTried, setDownloadTried] = useState(false);

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
    setDownloadTried(true);
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
  // An Astrid older than this page is an update even when its release is current (a source checkout, or only chat is
  // old): this section is the one place to act on it, so it becomes the update card with this install's one path.
  const outOfDate = astridOutOfDate(connection);
  const compatibilityFor = (type: typeof installType) => outOfDate
    ? { kind: 'schema' as const, detail: updateNeededSentence(type === 'pinokio', outOfDate === 'chat') }
    : undefined;

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
      setResolution(resolveUpdate({ ...next.resolution, compatibility: compatibilityFor(installType), installType, updateNowAvailable: false, updateReason: operation.updateReason }, 'settings'));
      setState('ready');
    } catch {
      setStatus(null);
      // Without a release reading, an Astrid known to be older than this page still gets its update card.
      const compatibility = compatibilityFor(installType);
      if (compatibility) {
        setResolution(resolveUpdate({ compatibility, installType, updateNowAvailable: false }, 'settings'));
        setState('ready');
        return;
      }
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
  // report when that result changes so the update log never shows the prior run.
  const operationKey = `${operation.status?.operation_id ?? ''}:${operation.status?.state ?? ''}:${operation.status?.result ?? ''}`;
  useEffect(() => {
    if (isOpen && operation.status) void loadDiagnostics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, operationKey]);
  const currentStatus = operation.releaseStatus ?? status;
  // The status being shown carries the Runtime identity it was read from, so the install type does not wait for the operation's health.
  const statusInstallType = currentStatus ? pageInstallType(currentStatus.managedBy, connection.managedByPinokio) : installType;
  const compatibility = compatibilityFor(statusInstallType);
  const currentResolution = currentStatus ? resolveUpdate({ ...currentStatus.resolution, pageStale, compatibility, installType: statusInstallType, updateNowAvailable: operation.available, updateReason: operation.updateReason }, 'settings') : resolution;
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
  const updateAvailable = (Boolean(currentStatus) || Boolean(compatibility)) && updateCard;
  // A degraded direct install repairs with the plain install line, which has no --update. A source checkout has no such line here.
  const services = operation.health?.services ?? [];
  // An available update already offers Update now and its command, so the repair row waits until none is offered.
  const repairNeeded = installType === 'installer' && !updateAvailable && (operation.health?.status === 'degraded' || services.some((service) => service.state === 'failed'));
  const repairCommand = detectPlatform() === 'windows' ? ASTRID_COMMANDS.windows : ASTRID_COMMANDS.macLinux;
  // An old Astrid with no newer release to name (a source checkout has none) is titled by its card instead.
  const releaseLine = currentStatus && (!compatibility || statusInstallType !== 'source' && currentStatus.servedRelease > currentStatus.release);
  const statusLine = operationMessage
    || (state === 'checking' ? 'Checking for updates…'
      : state === 'error' ? error
        : currentResolution?.card === 'newer' ? currentResolution.body
          : updateAvailable && currentStatus && releaseLine ? `Update available: Release ${currentStatus.servedRelease}`
            : updateAvailable && currentResolution?.title ? currentResolution.title
            : currentStatus ? `Astrid is up to date (Release ${currentStatus.release})` : 'Astrid is up to date');
  // A plain release notice only restates the status line; a required or schema reason, or a Runtime's update reason, is the detail.
  const releaseNotice = currentResolution?.card === 'notice' && !currentResolution.updateReason;
  // A Runtime reason is already the status line, so its sentence is not repeated as the detail.
  const detail = state === 'ready' && currentResolution?.body && currentResolution.card !== 'newer' && !releaseNotice && currentResolution.body !== operationMessage ? currentResolution.body : null;
  // A card other than an update (reload, restart, error) names itself above its sentence; an update is the status line.
  const heading = state === 'ready' && currentResolution?.title && !updateCard ? currentResolution.title : null;
  const actionsFor = state === 'ready' && currentResolution && (currentResolution.card !== 'none' || operation.status?.state !== 'none') ? currentResolution : null;
  // Once the report is wanted (a download, or the detail opened) and Astrid could not give it.
  const diagnosticsFallback = diagnosticsError && (diagnosticsOpen || downloadTried);
  const logText = operation.status?.result && reportResult !== operation.status.result
    ? 'The latest log is not available in diagnostics yet. Check again.'
    : diagnostics.match(/Installer transaction log:\n([\s\S]*?)\nRetained back-end copies:/)?.[1]?.trim() ?? '';

  const appBuild = currentStatus?.app || APP_BUILD;

  return <SettingsSection id="settings-updates" title="Updates">
    <SettingsRow
      label={<p role="status" aria-live="polite">{statusLine}</p>}
      description={(heading || detail) && <>
        {heading && <p className="font-medium text-foreground">{heading}</p>}
        {detail && <p>{detail}</p>}
      </>}
      action={!updateAvailable && <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void check()} disabled={state === 'checking'}>Check for updates</Button>}
    >
      {actionsFor && <UpdateResolutionActions resolution={actionsFor} operation={operation} context="settings" />}
      {lastResult && lastResult !== statusLine && <p className="text-muted-foreground">Last result: {lastResult}</p>}
    </SettingsRow>
    {repairNeeded && <SettingsRow
      label={<p className="font-medium text-foreground">{ASTRID_STATUS_COPY.repairTitle}</p>}
      description={ASTRID_STATUS_COPY.repairDescription}
    >
      <CopyCommandRow command={repairCommand} label={RUNTIME_CONNECTION_COPY.agent.commandCopy} copiedLabel={RUNTIME_CONNECTION_COPY.agent.commandCopied} />
    </SettingsRow>}
    <SettingsDisclosureRow
      label="Diagnostics"
      description="The app build and update log, and a report to share if something goes wrong."
      open={diagnosticsOpen}
      onOpenChange={setDiagnosticsOpen}
      action={<Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void downloadDiagnostics()}>Download diagnostics</Button>}
      notice={diagnosticsFallback && <DiagnosticsFallback className="space-y-2" />}
    >
      <dl className="space-y-1.5">
        {/* The status line names the installed release when Astrid is up to date; with an update it names the new one. */}
        {updateAvailable && currentStatus && <SettingsValue label="Installed" value={`Release ${currentStatus.release}`} />}
        <SettingsValue label="App build" value={appBuild ? shortBuild(appBuild) : '—'} title={appBuild || undefined} />
      </dl>
      {logText && <SettingsDetail title="Update log">
        {operation.status?.log_path && <p className="mb-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{operation.status.log_path}</p>}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs">{logText}</pre>
      </SettingsDetail>}
    </SettingsDisclosureRow>
  </SettingsSection>;
}
