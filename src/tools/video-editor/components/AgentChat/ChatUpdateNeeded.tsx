import { useRuntimeConnectionSafe } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { RUNTIME_CONNECTION_COPY, updateNeededSentence } from '@/shared/components/RuntimeConnection/copy.ts';
import { openUpdatesSettings } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';
import { Button } from '@/shared/components/ui/button.tsx';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { BRIDGE_CONTRACT_VERSION_MISMATCH_CODE } from '@/tools/video-editor/data/bridgeContract.ts';

/** A chat reply from this computer's Astrid that no longer matches what this page expects: an out-of-date service. */
export function isChatUpdateError(error: unknown): error is BridgeRouteError {
  return error instanceof BridgeRouteError && error.code === BRIDGE_CONTRACT_VERSION_MISMATCH_CODE;
}

/** The chat card's one action. Updates happen under Settings → Updates, so chat carries no install command of its own. */
const SEE_UPDATES_ACTION = 'See updates';

/**
 * The out-of-date card in chat, shown in place of a raw bridge error. Its title and sentence come from the shared update
 * decision over `updateNeededSentence`, and its action opens Settings → Updates. The raw message stays one click away under
 * Details for anyone debugging. Chat also renders without providers, so the connection is read optionally and nothing here is required.
 */
export function ChatUpdateNeeded({ detail }: { readonly detail: string }) {
  // No connection means no Pinokio provenance, so the non-Pinokio sentence is the right default there.
  const pinokio = useRuntimeConnectionSafe()?.managedByPinokio === true;
  const decision = resolveUpdate({ compatibility: { kind: 'schema', detail: updateNeededSentence(pinokio) } });
  return (
    <div className="space-y-2 text-left text-foreground">
      <p>{RUNTIME_CONNECTION_COPY.chatNeedsUpdate}</p>
      <p className="font-medium">{decision.title}</p>
      <p>{decision.body}</p>
      <Button type="button" variant="retro-secondary" size="retro-sm" onClick={openUpdatesSettings}>{SEE_UPDATES_ACTION}</Button>
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">Details</summary>
        <p className="mt-1 break-words">{detail}</p>
      </details>
    </div>
  );
}
