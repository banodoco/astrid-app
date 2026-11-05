import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { COPY_FOR_AGENT_ACTION } from '@/shared/lib/updates/resolveUpdate.ts';
import { CopyCommandRow, CopyFallback, useCopyAction } from './CopyInstallCommand.tsx';
import { fetchDiagnosticsReport, saveDiagnosticsReport } from './diagnosticsDownload.ts';
import { DIAGNOSTICS_FALLBACK_COPY, RUNTIME_CONNECTION_COPY } from './copy.ts';

/** The copy-for-your-agent and run-it-yourself instructions shown when Runtime diagnostics cannot be downloaded. */
export function DiagnosticsFallback({ className }: { readonly className?: string }) {
  const agentCopy = useCopyAction(DIAGNOSTICS_FALLBACK_COPY.agent);
  const copied = agentCopy.status === 'copied';
  const { agent } = RUNTIME_CONNECTION_COPY;
  return <div className={className}>
    <p>{DIAGNOSTICS_FALLBACK_COPY.intro}</p>
    <div>
      <Button type="button" variant="retro-secondary" size="retro-sm" className="gap-1.5" onClick={() => void agentCopy.copy()}>
        <span aria-live="polite">{copied ? agent.copied : COPY_FOR_AGENT_ACTION}</span>
        {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
      </Button>
    </div>
    {agentCopy.status === 'failed' && <CopyFallback text={DIAGNOSTICS_FALLBACK_COPY.agent} label={COPY_FOR_AGENT_ACTION} />}
    <div className="space-y-1.5 text-left">
      <p className="text-xs font-medium text-foreground">Run it yourself</p>
      <CopyCommandRow command={DIAGNOSTICS_FALLBACK_COPY.command} label={agent.commandCopy} copiedLabel={agent.commandCopied} />
    </div>
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
