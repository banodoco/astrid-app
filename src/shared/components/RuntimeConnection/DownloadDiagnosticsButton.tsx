import { useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { fetchDiagnosticsReport } from './diagnosticsDownload.ts';
import { DIAGNOSTICS_FALLBACK_COPY } from './copy.ts';

export function DownloadDiagnosticsButton() {
  const [unavailable, setUnavailable] = useState(false);
  const download = async () => {
    try {
      const report = await fetchDiagnosticsReport(fetch);
      const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
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
      <p>{DIAGNOSTICS_FALLBACK_COPY.intro}</p>
      <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void navigator.clipboard?.writeText(DIAGNOSTICS_FALLBACK_COPY.agent)}>Copy for your agent</Button>
      <p>Run it yourself: <code>{DIAGNOSTICS_FALLBACK_COPY.command}</code></p>
    </div>}
  </div>;
}
