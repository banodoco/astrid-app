import { useEffect, useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { UpdateResolutionActions } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';
import { resolveUpdate, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { checkHostedUpdate, checkLocalUpdate, type UpdateStatus } from '@/shared/lib/updates/updateStatus.ts';
import { APP_BUILD } from '@/shared/lib/updates/appBuildWatch.ts';
import { fetchDiagnosticsReport } from '@/shared/components/RuntimeConnection/diagnosticsDownload.ts';

type CheckState = 'checking' | 'ready' | 'error';

function shortBuild(build: string): string {
  return /^[0-9a-f]{8,}$/i.test(build) ? build.slice(0, 7) : build;
}

export function AstridUpdatesSection({ isOpen }: { readonly isOpen: boolean }) {
  const connection = useRuntimeConnection();
  const local = import.meta.env.VITE_ASTRID_LOCAL_UPDATE_STATUS === '1';
  const hosted = runtimeOrigin() !== '';
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

  const installType = connection.managedByPinokio ? 'pinokio'
    : local ? 'fully-local' : hosted ? 'installer' : 'source';

  const check = async () => {
    setState('checking');
    setError('');
    try {
      let next: UpdateStatus;
      let base: UpdateResolution = resolveUpdate({ installType, updateNowAvailable: false });
      if (local) {
        next = await checkLocalUpdate();
      } else {
        if (!connection.isConnected) throw new Error('Connect to Astrid before checking its release.');
        const current = await new AstridRuntimeClient().readStatus();
        next = await checkHostedUpdate(current.health);
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

  return <section id="settings-updates" aria-labelledby="astrid-updates-title" className="mb-6 rounded-lg border p-4">
    <h2 id="astrid-updates-title" className="text-base font-semibold">Updates</h2>
    <dl className="mt-3 space-y-1 text-sm">
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Release</dt><dd>{status ? `Release ${status.release}` : '—'}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">App build</dt><dd title={status?.app || APP_BUILD || undefined}>{status?.app || APP_BUILD ? shortBuild(status?.app || APP_BUILD) : '—'}</dd></div>
    </dl>
    <div className="mt-3 space-y-2">
      <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void check()} disabled={state === 'checking'}>
        {state === 'checking' ? 'Checking for updates…' : 'Check for updates'}
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {state === 'checking' ? 'Checking for updates…' : state === 'error' ? error : resolution?.card === 'newer' ? resolution.body : status?.behind ? `Update available · release ${status.servedRelease}` : 'Astrid is up to date'}
      </p>
      {state === 'ready' && resolution?.title && <div className="text-sm"><p className="font-medium">{resolution.title}</p>{resolution.body && <p className="text-muted-foreground">{resolution.body}</p>}</div>}
      {state === 'ready' && resolution && resolution.card !== 'none' && <UpdateResolutionActions resolution={resolution} />}
      <div className="border-t pt-2 text-sm">
        <p><span className="text-muted-foreground">Last result:</span> {diagnostics.match(/^Last update result: (.*)$/m)?.[1] || 'No update has run yet.'}</p>
        <details className="mt-1"><summary className="cursor-pointer underline">View log</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{diagnostics.match(/Installer transaction log:\n([\s\S]*?)\nRetained back-end copies:/)?.[1] || 'No update log yet.'}</pre></details>
        <Button type="button" variant="retro-secondary" size="retro-sm" className="mt-2" onClick={() => void downloadDiagnostics()}>Download diagnostics</Button>
        {diagnosticsError && <div className="mt-2 space-y-2">
          <p>Runtime could not answer. You can still collect diagnostics:</p>
          <div><Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void navigator.clipboard?.writeText('Run `astrid-runtime doctor` and read the log directory named in the report.')}>Copy for your agent</Button></div>
          <p>Run it yourself: <code>astrid-runtime doctor &gt; astrid-diagnostics.txt</code></p>
        </div>}
      </div>
    </div>
  </section>;
}
