import { Check, Copy } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { CopyFallback, useCopyAction } from './CopyInstallCommand.tsx';
import { RUNTIME_CONNECTION_COPY as COPY, refusedAgentInstructions } from './copy.ts';

/**
 * The one action of a refusal: hand a coding agent the check and the fix. Never an install, because Astrid is running;
 * a Pinokio Astrid's fix is Pinokio's own Update.
 */
export function CopyRefusedInstructions({ pinokio = false }: { readonly pinokio?: boolean }) {
  const instructions = refusedAgentInstructions(window.location.origin, runtimeApiBase(), pinokio);
  const copy = useCopyAction(instructions);
  const copied = copy.status === 'copied';
  return (
    <div className="space-y-2">
      <Button type="button" className="h-11 w-full justify-between rounded-xl px-4 text-sm" onClick={() => void copy.copy()}>
        <span aria-live="polite">{copied ? COPY.agent.copied : COPY.agent.copy}</span>
        {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
      </Button>
      {copy.status === 'failed' && <CopyFallback text={instructions} label={COPY.agent.copyFailed} />}
    </div>
  );
}
