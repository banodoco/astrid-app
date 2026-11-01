import type { CanonicalDocument } from '@/integrations/runtime/timeline-commit-types.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import { copy } from './clipMovePrimitives.ts';
import { toOutboxJson, type OutboxHead, type OutboxPlacementContinuation, type OutboxScope } from './commitOutbox.ts';
import { readNativePlacementCapture } from './nativePlacementCapture.ts';
import { createPlacementRequester, type PlacementCaptureContext } from './placementRequester.ts';

/** Captures into the session's existing payload shape, with no optimistic image preview. */
export function createSessionPlacementRequester(options: Parameters<typeof createPlacementRequester>[0]) {
  const readOriginal = async (original: OutboxPlacementContinuation) =>
    copy(original.input.readClosure) as unknown as { head: OutboxHead; savedCanonicalDocument: CanonicalDocument };
  return createPlacementRequester({ ...options, deferCommit: true,
    capture: Object.assign(async (original: OutboxPlacementContinuation, scope: OutboxScope, context?: PlacementCaptureContext) => {
      if (!context) throw new Error('Requester effect context is unavailable');
      const { commands, bundle } = await readNativePlacementCapture(original, scope, context, readOriginal);
      if (commands.length !== 1 || (commands[0].op !== 'placement.create'
        && !(commands[0].op === 'occurrence.add-media' && (commands[0].args.row as { clipType?: string })?.clipType === 'image'))) {
        throw new Error('Automatic editor placement currently supports occurrence images only');
      }
      await context.check();
      context.assertCurrent();
      const source = await readOriginal(original);
      const before = await authoringBundleFromDocument(source.savedCanonicalDocument);
      await context.check();
      context.assertCurrent();
      return toOutboxJson({ commands, before, after: bundle, preview: null,
        displayBasis: { head: source.head, canonicalDocument: source.savedCanonicalDocument } });
    }, { requesterContext: true as const }),
  });
}
