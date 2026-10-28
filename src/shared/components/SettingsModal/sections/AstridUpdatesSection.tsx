import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { UpdateResolutionActions } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';
import { DIAGNOSTICS_FALLBACK_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { fetchDiagnosticsReport } from '@/shared/components/RuntimeConnection/diagnosticsDownload.ts';
import { resolveUpdate, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { checkHostedUpdate, checkLocalUpdate, type UpdateStatus } from '@/shared/lib/updates/updateStatus.ts';
import { APP_BUILD } from '@/shared/lib/updates/appBuildWatch.ts';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { pageLocalUpdate } from '@/shared/lib/updates/updateOperation.ts';
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
  const local = import.meta.env.VITE_ASTRID_LOCAL_UPDATE_STATUS === '1';
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
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'astrid-diagnostics.txt';
    link.click();
    URL.revokeObjectURL(url);
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
      let base: UpdateResolution = resolveUpdate({ installType, updateNowAvailable: false });
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
        base = resolveUpdate({ ...next.resolution, installType, updateNowAvailable: false }, 'settings');
      }
      if (local) base = resolveUpdate({ ...next.resolution, installType, updateNowAvailable: false }, 'settings');
      setStatus(next);
      setResolution(base);
      setState('ready');
    } catch (cause) {
      setStatus(null);
      setResolution(null);
      setError(cause instanceof Error ? cause.message : 'Update status could not be checked.');
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
  const currentResolution = currentStatus ? resolveUpdate({ ...currentStatus.resolution, pageStale, installType, updateNowAvailable: operation.available }, 'settings') : resolution;
  const reportResult = diagnostics.match(/^Last update result: (.*)$/m)?.[1];
  const lastResult = operation.error ? 'Update status could not be confirmed.' : operation.status?.result ?? reportResult ?? 'No update has run yet.';

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
        {state === 'checking' ? 'Checking for updates…' : state === 'error' ? error : currentResolution?.card === 'newer' ? currentResolution.body : currentStatus?.behind ? `Update available · release ${currentStatus.servedRelease}` : 'Astrid is up to date'}
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
        {diagnosticsError && <div className="mt-2 space-y-2">
          <p>{DIAGNOSTICS_FALLBACK_COPY.intro}</p>
          <div><Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void navigator.clipboard?.writeText(DIAGNOSTICS_FALLBACK_COPY.agent)}>Copy for your agent</Button></div>
          <p>Run it yourself: <code>{DIAGNOSTICS_FALLBACK_COPY.command}</code></p>
        </div>}
      </div>
    </div>
  </section>;
}
