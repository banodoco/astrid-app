import { useRuntimeConnectionSafe } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { CopyInstallCommand } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';
import { RUNTIME_CONNECTION_COPY, updateNeededSentence } from '@/shared/components/RuntimeConnection/copy.ts';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { BRIDGE_CONTRACT_VERSION_MISMATCH_CODE } from '@/tools/video-editor/data/bridgeContract.ts';

/** A chat reply from this computer's Astrid that no longer matches what this page expects: an out-of-date service. */
export function isChatUpdateError(error: unknown): error is BridgeRouteError {
  return error instanceof BridgeRouteError && error.code === BRIDGE_CONTRACT_VERSION_MISMATCH_CODE;
}

/**
 * How chat's out-of-date cards say to update. A Pinokio Astrid has one way, Pinokio's own Update button: its sentence and
 * no command. Every other install gets the install line's update command, with the agent-brief sentence when asked.
 */
export function ChatUpdateCommand({ withSentence = false }: { readonly withSentence?: boolean }) {
  // Optional consumer: chat also renders in editor harnesses without the connection gate, and no connection means no
  // Pinokio provenance, so the install line is the right default there.
  const pinokio = useRuntimeConnectionSafe()?.managedByPinokio === true;
  if (pinokio) return <p>{updateNeededSentence(true)}</p>;
  return <>
    {withSentence && <p>{updateNeededSentence(false)}</p>}
    <CopyInstallCommand mode="update" />
  </>;
}

/**
 * The shared "Update Astrid" screen content, shown in place of a raw bridge error in chat. The raw message stays one click away under Details
 * for anyone debugging.
 */
export function ChatUpdateNeeded({ detail }: { readonly detail: string }) {
  const copy = RUNTIME_CONNECTION_COPY.updateNeeded;
  return (
    <div className="space-y-2 text-left text-foreground">
      <p>{RUNTIME_CONNECTION_COPY.chatNeedsUpdate}</p>
      <p className="font-medium">{copy.title}</p>
      <ChatUpdateCommand withSentence />
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">Details</summary>
        <p className="mt-1 break-words">{detail}</p>
      </details>
    </div>
  );
}
