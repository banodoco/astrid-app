import { useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { fetchDiagnosticsReport, saveDiagnosticsReport } from './diagnosticsDownload.ts';
import { DIAGNOSTICS_FALLBACK_COPY } from './copy.ts';

/** The copy-for-your-agent and run-it-yourself instructions shown when Runtime diagnostics cannot be downloaded. */
export function DiagnosticsFallback({ className }: { readonly className?: string }) {
  return <div className={className}>
    <p>{DIAGNOSTICS_FALLBACK_COPY.intro}</p>
    <div><Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void navigator.clipboard?.writeText(DIAGNOSTICS_FALLBACK_COPY.agent)}>Copy for your agent</Button></div>
    <p>Run it yourself: <code>{DIAGNOSTICS_FALLBACK_COPY.command}</code></p>
  </div>;
}

export function DownloadDiagnosticsButton() {
  const [unavailable, setUnavailable] = useState(false);
  const download = async () => {
    try {
      saveDiagnosticsReport(await fetchDiagnosticsReport(fetch));
      setUnavailable(false);
    } catch { setUnavailable(true); }
  };
  return <div className="space-y-2">
    <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => void download()}>Download diagnostics</Button>
    {unavailable && <DiagnosticsFallback className="space-y-2 text-left text-sm" />}
  </div>;
}
