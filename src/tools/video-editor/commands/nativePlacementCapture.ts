import type { CanonicalDocument, MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import { captureAutoBasis, finishAutoCapture, type AutoCaptureBasis } from './autoCapture.ts';
import { copy, equal, freezeJson, object } from './clipMovePrimitives.ts';
import type { OutboxHead, OutboxPlacementContinuation, OutboxScope } from './commitOutbox.ts';
import type { PlacementCaptureContext } from './placementRequester.ts';

// The host decodes its ORIGINAL readClosure: an inline saved document or its
// pinned raw-read callback. loadTimelineCommandBasis refreshes head and is unsuitable.
export type OriginalPlacementRead = (
  original: OutboxPlacementContinuation, scope: OutboxScope,
) => Promise<{ head: OutboxHead; savedCanonicalDocument: CanonicalDocument }>;

async function checked<T>(context: PlacementCaptureContext, read: () => Promise<T>): Promise<T> {
  await context.check();
  context.assertCurrent();
  try { return await read(); }
  finally {
    await context.check();
    context.assertCurrent();
  }
}

/** Read/capture stage only. Its result grants no task authority or commit permission. */
export async function readNativePlacementCapture(original: OutboxPlacementContinuation, scope: OutboxScope,
  context: PlacementCaptureContext, readOriginal: OriginalPlacementRead) {
  const saved = freezeJson(copy(original)), savedScope = Object.freeze({ ...scope });
  const input = saved.input;
  // Only this explicit native policy shape is supported. Opaque legacy policies
  // stay saved for manual review; no approval is inferred from a task or editor.
  if (!object(input.policy)) throw new Error('Original native automatic approval is unavailable');
  const approval = input.policy as AutoCaptureBasis['approval'];
  const completion = approval.mode === 'completion';
  if (input.autoApprove !== true || approval.autoApprove !== input.autoApprove
    || approval.owner !== input.ownerRef || !equal(approval.anchor, input.anchor)
    || !equal(completion ? approval.preferredTrack : null, input.lane)
    || !equal(completion ? { at: approval.fallbackAt, track: approval.fallbackTrack } : null, input.fallback)
    || !equal([approval.clipId], input.createdIds)) {
    throw new Error('Original native approval differs from saved requester bindings');
  }
  if (!saved.taskLocator || saved.taskLocator.projectId !== scope.projectId) throw new Error('Original task locator is unavailable');
  const pin = saved.mediaPin;
  if (!object(pin) || !equal(Object.keys(pin).sort(), ['asset', 'catalog_digest', 'generation_id', 'object_id', 'variant_id'])
    || Object.values(pin).some((value) => typeof value !== 'string' || !value)) {
    throw new Error('Exact completed five-field media selection is unavailable');
  }
  const media = pin as MediaSelection;
  if (!context.client.getProjectVerifiedMedia) throw new Error('Same-host getProjectVerifiedMedia binding is unavailable');
  const source = await checked(context, () => readOriginal(saved, savedScope));
  // Detach the host result before another await; the existing opener preserves
  // raw revision images and does not resolve heads or rehash their payloads.
  const { head, savedCanonicalDocument: document } = copy(source);
  if (!equal(head, input.head) || document.project_id !== scope.projectId || document.timeline_id !== scope.timelineId
    || document.parent_revision.revision_id !== input.head.revisionId) {
    throw new Error('Original document scope/base differs from saved requester approval');
  }
  const bundle = await checked(context, () => authoringBundleFromDocument(document));
  const basis = captureAutoBasis(bundle, approval);
  const verified = await checked(context, () => context.client.getProjectVerifiedMedia!(savedScope.projectId, copy(media)));
  context.assertCurrent();
  return finishAutoCapture(basis, media, verified);
}

/** Requester callback; exact selected media is rechecked at Runtime acceptance. */
export function createNativePlacementCapture(readOriginal: OriginalPlacementRead) {
  const capture = async (original: OutboxPlacementContinuation, scope: OutboxScope, context?: PlacementCaptureContext) => {
    if (!context) throw new Error('Requester effect context is unavailable');
    const { commands } = await readNativePlacementCapture(original, scope, context, readOriginal);
    context.assertCurrent();
    return { commands };
  };
  return Object.assign(capture, { requesterContext: true as const });
}
