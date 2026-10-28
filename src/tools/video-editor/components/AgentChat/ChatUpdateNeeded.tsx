import { CopyInstallCommand } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';
import { RUNTIME_CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { BRIDGE_CONTRACT_VERSION_MISMATCH_CODE } from '@/tools/video-editor/data/bridgeContract.ts';

/** A chat reply from this computer's Astrid that no longer matches what this page expects: an out-of-date service. */
export function isChatUpdateError(error: unknown): error is BridgeRouteError {
  return error instanceof BridgeRouteError && error.code === BRIDGE_CONTRACT_VERSION_MISMATCH_CODE;
}

/**
 * The shared "Update Astrid" screen content, shown in place of a raw bridge error in chat. The raw message stays one click away under Details
 * for anyone debugging.
 */
export function ChatUpdateNeeded({ detail }: { readonly detail: string }) {
  return (
    <div className="space-y-2 text-left text-foreground">
      <p className="font-medium">{RUNTIME_CONNECTION_COPY.chatNeedsUpdate}</p>
      <CopyInstallCommand mode="update" />
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">Details</summary>
        <p className="mt-1 break-words">{detail}</p>
      </details>
    </div>
  );
}
