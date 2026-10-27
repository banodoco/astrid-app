import { useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { APP_BUILD, fetchBuildInfo } from '@/shared/lib/updates/appBuildWatch.ts';

export function DownloadDiagnosticsButton() {
  const [unavailable, setUnavailable] = useState(false);
  const download = async () => {
    try {
      const build = await fetchBuildInfo(fetch);
      const query = new URLSearchParams();
      const appBuild = APP_BUILD || build?.app;
      if (appBuild) query.set('app_build', appBuild);
      if (build) query.set('app_release', String(build.release));
      const response = await fetch(`${runtimeApiBase()}/v1/diagnostics${query.size ? `?${query}` : ''}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) { setUnavailable(true); return; }
      const payload = await response.json() as { report?: unknown };
      if (typeof payload.report !== 'string') { setUnavailable(true); return; }
      const url = URL.createObjectURL(new Blob([payload.report], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'astrid-diagnostics.txt';
      link.click();
      URL.revokeObjectURL(url);
      setUnavailable(false);
    } catch { setUnavailable(true); }
  };
  return <div className="space-y-2">
    <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void download()}>Download diagnostics</Button>
    {unavailable && <div className="space-y-2 text-left text-sm">
      <p>Runtime could not answer. You can still collect diagnostics.</p>
      <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void navigator.clipboard?.writeText('Run astrid-runtime doctor and read the log directory named in its report.')}>Copy for your agent</Button>
      <p>Run it yourself: <code>astrid-runtime doctor &gt; astrid-diagnostics.txt</code></p>
    </div>}
  </div>;
}
