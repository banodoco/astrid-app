import type { CommandRecord, EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelinePatchOperation } from '@/sdk/video/timeline/patch.ts';
import {
  captureClipMove,
  executeClipMove,
  finishClipMove,
  type ClipMoveBasis,
} from './clipMoveCapture.ts';
import { assertFiniteJson, copy, ClipMoveError, freezeJson } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

/** The native consumer's closed absolute clip.move operation shape. */
export type OrdinaryMoveOperation = TimelinePatchOperation & {
  readonly op: 'clip.move';
  readonly payload: { readonly at: number };
};

export type OrdinaryMoveMemberBasis = Readonly<{
  readonly operation: OrdinaryMoveOperation;
  readonly select: string;
  readonly move: ClipMoveBasis;
}>;

export type OrdinaryMoveMemberResult = Readonly<{
  readonly operation: OrdinaryMoveOperation;
  readonly command: EditCommand;
  readonly bundle: AuthoredBundle;
  readonly record: CommandRecord;
  readonly previewAt: number;
}>;

function object(value: unknown): value is Record<string, JSON> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOperation(operation: unknown): asserts operation is OrdinaryMoveOperation {
  if (!object(operation) || operation.op !== 'clip.move' || typeof operation.target !== 'string' || !operation.target
    || !object(operation.payload) || Object.keys(operation.payload).length !== 1
    || !Object.prototype.hasOwnProperty.call(operation.payload, 'at')
    || typeof operation.payload.at !== 'number' || !Number.isFinite(operation.payload.at)
    || operation.payload.at < 0
    || (operation.order !== undefined && (typeof operation.order !== 'number' || !Number.isFinite(operation.order)))) {
    throw new ClipMoveError('ordinary clip.move requires one finite non-negative absolute at value');
  }
}

function result(
  operation: OrdinaryMoveOperation,
  prepared: ReturnType<typeof finishClipMove>,
  ordinal: number,
): OrdinaryMoveMemberResult {
  prepared.record.ordinal = ordinal;
  prepared.record.derived_writes.forEach((write) => { write.cause = ordinal; });
  return Object.freeze({ operation, ...prepared });
}

/** Capture the raw identity and Agent-authenticated basis before local preview. */
export function captureOrdinaryMoveMember(
  bundle: AuthoredBundle,
  operation: TimelinePatchOperation,
  select: string,
): OrdinaryMoveMemberBasis {
  assertFiniteJson(operation);
  assertOperation(operation);
  const move = captureClipMove(bundle, select);
  return freezeJson({ operation: copy(operation), select, move });
}

/** Finish against the original capture; no refreshed document or clamped target enters. */
export function finishOrdinaryMoveMember(
  basis: unknown,
  ordinal = 0,
): OrdinaryMoveMemberResult {
  assertFiniteJson(basis);
  if (!object(basis) || !object(basis.operation) || typeof basis.select !== 'string'
    || !object(basis.move)) {
    throw new ClipMoveError('incomplete ordinary clip.move basis');
  }
  assertOperation(basis.operation);
  const prepared = finishClipMove(basis.move, basis.operation.payload.at);
  return result(basis.operation, prepared, ordinal);
}

/** Re-execute the captured SDK command on a supplied authored bundle. */
export function executeOrdinaryMoveMember(
  bundle: AuthoredBundle,
  command: EditCommand,
  ordinal = 0,
) {
  const prepared = executeClipMove(bundle, command);
  prepared.record.ordinal = ordinal;
  prepared.record.derived_writes.forEach((write) => { write.cause = ordinal; });
  return prepared;
}
