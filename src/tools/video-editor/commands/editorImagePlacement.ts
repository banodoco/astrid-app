import type { CreateTaskOptions } from '@/shared/lib/taskCreation/createTask.ts';
import type { ImageGenerationPlacement, ImagePlacementTarget } from '@/shared/lib/taskCreation/imageGeneration.ts';
import type { TaskCreationRequest } from '@/shared/lib/taskCreation/types.ts';
import type { TimelineCommandBasis } from '../data/DataProvider.ts';
import { captureAutoBasis } from './autoCapture.ts';
import { AuthoredState, copy, equal, type AuthoredBundle } from './clipMovePrimitives.ts';
import type { ClaimedOutbox, OutboxJson, OutboxPlacementContinuation, OutboxScope } from './commitOutbox.ts';
import type { RuntimeOperation } from '@/integrations/runtime/operationHost.ts';

export const IMAGE_PLACEMENT_UNAVAILABLE = 'Automatic placement is unavailable: the editor operation host/session binding is not qualified. Keep this draft, or uncheck placement to generate for manual use.';
export type EditorImagePlacementHost = {
  client: NonNullable<CreateTaskOptions['client']>;
  operation?: RuntimeOperation;
  taskEventsReady?(): Promise<void>;
  subscribe?(changed: () => void): () => void;
  isCurrentIdentity(scope: OutboxScope): boolean;
  /** Retires the operation when the Provider's editor lifetime ends. */
  retire?(): void;
};

/** Uses the editor's existing claim and accepted closure; no ambient editor authority. */
export function createEditorImagePlacement(options: {
  scope: OutboxScope;
  host?: EditorImagePlacementHost;
  current(): { box: ClaimedOutbox; basis: TimelineCommandBasis; bundle: AuthoredBundle };
  ready?(): void;
  reserved?(): Promise<void>;
}): ImageGenerationPlacement {
  const scope = Object.freeze({ ...options.scope });
  function assertCurrent(box: ClaimedOutbox) {
    box.assertActive();
    if (!options.host || options.host.isCurrentIdentity(scope) !== true) {
      throw new Error(IMAGE_PLACEMENT_UNAVAILABLE);
    }
    if (options.current().box !== box) throw new Error('Original editor command owner changed');
  }
  let pending: { target: ImagePlacementTarget; id: string; key: string; clipId: string } | undefined;
  return {
    projectId: scope.projectId,
    ...(!options.host ? { unavailableReason: IMAGE_PLACEMENT_UNAVAILABLE } : {}),
    async prepare(target: ImagePlacementTarget) {
      if (!options.host) throw new Error(IMAGE_PLACEMENT_UNAVAILABLE);
      const { box, basis, bundle } = options.current();
      assertCurrent(box);
      await options.host.taskEventsReady?.();
      assertCurrent(box);
      options.ready?.();
      if (!/^occurrence:[^/]+$/.test(target.ownerRef) || target.ownerRef.includes('::')
        || !target.lane || /\/|::/.test(target.lane)) throw new Error('Choose an explicit raw occurrence and lane');
      const savedTarget = copy(target);
      const record = await box.read();
      assertCurrent(box);
      if (!equal(record.scope, scope) || record.intents.length || record.pending) {
        throw new Error('Acknowledge earlier timeline work before preparing placement');
      }
      const retained = record.placementContinuations?.filter((item) => !item.placement?.accepted && !item.placement?.cancelled) ?? [];
      if (retained.length > 1) throw new Error('Recover the original placement before generating again');
      let original: OutboxPlacementContinuation | undefined = retained[0];
      if (original && (original.conflict !== undefined || original.input.ownerRef !== target.ownerRef
        || original.input.lane !== target.lane || original.input.anchor !== target.anchor)) {
        throw new Error('Saved placement approval differs; retain the original draft for recovery');
      }
      const candidate = original ? undefined
        : pending ?? { target: savedTarget, id: crypto.randomUUID(), key: crypto.randomUUID(), clipId: crypto.randomUUID() };
      if (!original && pending && !equal(pending.target, savedTarget)) {
        throw new Error('Retain the original placement draft before changing its target');
      }
      const head = copy(original?.input.head ?? basis.head);
      const policy = original?.input.policy ?? {
        autoApprove: true, ownership: 'occurrence', owner: target.ownerRef, clipId: candidate!.clipId,
        mode: 'completion', anchor: target.anchor, preferredTrack: target.lane,
        fallbackAt: null, fallbackTrack: target.lane, duration: 5,
      };
      if (!original) {
        captureAutoBasis(bundle, policy as Parameters<typeof captureAutoBasis>[1]);
        const state = new AuthoredState(bundle);
        const occurrence = state.occurrence(target.ownerRef);
        const home = occurrence.placement && typeof occurrence.placement === 'object' && !Array.isArray(occurrence.placement)
          ? occurrence.placement.track : occurrence.track;
        if (target.lane !== home && !state.entity(`${target.ownerRef}/track:${target.lane}`, true)) {
          throw new Error('The selected raw lane does not exist in this occurrence');
        }
      }
      if (!original) pending ??= candidate;
      const id = original?.id ?? candidate!.id;
      const key = original?.input.request.key ?? candidate!.key;
      const readClosure = original?.input.readClosure ?? { head, savedCanonicalDocument: copy(basis.canonicalDocument) } as unknown as OutboxJson;
      return {
        client: options.host.client,
        ...(original ? { preparedRequest: JSON.parse(original.input.request.body) as TaskCreationRequest } : {}),
        reservation: {
          key,
          assertCurrent: () => assertCurrent(box),
          async admitted(task) {
            assertCurrent(box);
            if (!original || task.project_id !== scope.projectId || !task.run_id) throw new Error('Original placement task locator is unavailable');
            await box.recordPlacementTask(id, original.input.request, { projectId: scope.projectId, taskId: task.id, runId: task.run_id },
              () => assertCurrent(box));
            assertCurrent(box);
          },
          async reserve(request) {
            assertCurrent(box);
            const admission = JSON.parse(request.body) as TaskCreationRequest;
            const effect = admission.settlement_effect;
            if (admission.project !== scope.projectId || admission.capability_id !== 'generation.generate_image'
              || admission.spec.family !== 'generation.generate_image' || admission.spec.params.count !== 1
              || !('effect_type' in effect) || effect.effect_type !== 'generation.publish_v1'
              || effect.target_id !== scope.projectId || effect.payload.modality !== 'image'
              || effect.payload.groups.length !== 1 || effect.payload.groups[0].selectors.length !== 1) {
              throw new Error('Automatic placement requires exactly one requested image/output');
            }
            const group = effect.payload.groups[0], selected = group.selectors[0];
            if (selected.ordinal !== 0) throw new Error('Automatic placement requires the explicitly requested output');
            if (original && !equal(original.input.request, request)) throw new Error('Saved task bytes/key cannot change');
            const current = options.current();
            if (!original && (!equal(current.basis.head, head) || !equal(current.basis.canonicalDocument, basis.canonicalDocument))) {
              throw new Error('Accepted timeline basis changed; retain the generation draft');
            }
            original = await box.reservePlacementAdmission(id, original?.input ?? {
              request, head, readClosure, ownerRef: savedTarget.ownerRef, anchor: savedTarget.anchor,
              lane: savedTarget.lane, fallback: { at: null, track: savedTarget.lane }, policy,
              output: { group_key: group.group_key, variant_key: selected.variant_key, output_port: selected.output_port, ordinal: selected.ordinal },
              autoApprove: true, createdIds: [(policy as { clipId: string }).clipId],
            }, () => assertCurrent(box));
            assertCurrent(box);
            await options.reserved?.();
          },
          settled: async () => { await options.reserved?.(); },
        },
      };
    },
  };
}
