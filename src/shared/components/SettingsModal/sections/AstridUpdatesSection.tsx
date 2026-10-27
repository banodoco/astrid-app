import { useEffect, useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { UpdateResolutionActions } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';
import { resolveUpdate, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { checkHostedUpdate, checkLocalUpdate, type UpdateStatus } from '@/shared/lib/updates/updateStatus.ts';
import { APP_BUILD } from '@/shared/lib/updates/appBuildWatch.ts';

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
        base = resolveUpdate({ ...next.resolution, installType, settingsSurface: true, updateNowAvailable: false });
      }
      if (local) base = resolveUpdate({ ...next.resolution, installType, settingsSurface: true, updateNowAvailable: false });
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
    if (isOpen) void check();
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
        <p><span className="text-muted-foreground">Last result:</span> No update has run yet.</p>
        <p className="mt-1"><span className="text-muted-foreground">View log:</span> No update log yet.</p>
      </div>
    </div>
  </section>;
}
