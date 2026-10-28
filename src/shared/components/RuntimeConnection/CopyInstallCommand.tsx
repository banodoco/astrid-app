import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { writeClipboardTextSafe } from '@/shared/lib/browser/clipboard.ts';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import type { ServiceStatus } from '@/integrations/runtime/generated.ts';
import { detectPlatform } from '@/shared/hooks/platformInstall/platformDetection.ts';
import { agentInstructions, installCommand, localUpdateInstructions, RUNTIME_CONNECTION_COPY, UPDATE_ROUTES, withCommandShell, type CommandMode } from './copy.ts';

export interface CopyInstallCommandProps {
  /** `install` for setup/repair and `update` for an incompatible Astrid. */
  readonly mode?: CommandMode;
  readonly services?: readonly ServiceStatus[];
  /** A fully local install updates its checkout with this command instead of the installer. */
  readonly localCommand?: string;
}

type CopyStatus = 'idle' | 'copied' | 'failed';
const COPIED_MS = 2000;

/** Each action owns its feedback so copying a command cannot claim the agent brief was copied. */
export function useCopyAction(text: string) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const resetRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetRef.current !== null) window.clearTimeout(resetRef.current);
  }, []);
  const copy = async () => {
    const copied = await writeClipboardTextSafe(text);
    if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    setStatus(copied ? 'copied' : 'failed');
    resetRef.current = copied ? window.setTimeout(() => {
      resetRef.current = null;
      setStatus('idle');
    }, COPIED_MS) : null;
  };
  return { status, copy };
}

export function CopyFallback({ text, label }: { text: string; label: string }) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { fieldRef.current?.select(); }, [text]);
  return (
    <div className="space-y-2">
      <p role="status" className="text-sm text-muted-foreground">{RUNTIME_CONNECTION_COPY.agent.copyFailed}</p>
      <textarea
        ref={fieldRef}
        readOnly
        rows={6}
        value={text}
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
        className="w-full resize-y rounded-md border border-border bg-background p-2 text-left text-xs leading-5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

/** A selectable command with the shared copy action and a selected-text fallback if clipboard access fails. */
export function CopyCommandRow({ command, label, copiedLabel = label }: { readonly command: string; readonly label: string; readonly copiedLabel?: string }) {
  const commandCopy = useCopyAction(command);
  return <>
    <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-background/70 py-1 pl-3 pr-1">
      <pre className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-5 text-foreground"><code>{command}</code></pre>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground" aria-label={commandCopy.status === 'copied' ? copiedLabel : label} title={label} onClick={() => void commandCopy.copy()}>
        {commandCopy.status === 'copied' ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
      </Button>
    </div>
    {commandCopy.status === 'failed' && <CopyFallback text={command} label={label} />}
  </>;
}

/**
 * Agent handoff first, as the one primary action; the manual command is the quiet alternative under it, with its own
 * copy action. Nothing else: the card around it says what the instructions are for.
 */
export function CopyInstallCommand({ mode = 'install', services, localCommand }: CopyInstallCommandProps) {
  const copy = RUNTIME_CONNECTION_COPY.agent;
  const localBuild = runtimeOrigin() === '';
  const fullyLocal = localCommand !== undefined;
  const instructions = fullyLocal ? localUpdateInstructions(localCommand, window.location.origin) : agentInstructions(mode, window.location.origin, localBuild, services);
  const command = fullyLocal ? localCommand : installCommand(mode);
  const agentCopy = useCopyAction(instructions);
  const agentCopied = agentCopy.status === 'copied';

  return (
    <div className="w-full space-y-4">
      <div className="space-y-2">
        {detectPlatform() === 'windows' && <p className="text-xs text-muted-foreground">{RUNTIME_CONNECTION_COPY.windowsBeta}</p>}
        <Button type="button" className="h-11 w-full justify-between rounded-xl px-4 text-sm" onClick={() => void agentCopy.copy()}>
          <span aria-live="polite">{agentCopied ? copy.copied : copy.copy}</span>
          {agentCopied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
        </Button>
        {agentCopy.status === 'failed' && <CopyFallback text={instructions} label={copy.copyFailed} />}
      </div>
      <div className="space-y-1.5 text-left">
        <p className="text-xs font-medium text-foreground">Run it yourself</p>
        <p className="text-xs text-muted-foreground">{withCommandShell(fullyLocal ? copy.terminalAlternativeLocal : mode === 'update' ? copy.terminalAlternativeUpdate : copy.terminalAlternative)}</p>
        <CopyCommandRow command={command} label={copy.commandCopy} copiedLabel={copy.commandCopied} />
        {mode === 'update' && localBuild && !fullyLocal && <p className="pt-1 text-xs text-muted-foreground">{UPDATE_ROUTES.source}</p>}
      </div>
    </div>
  );
}
