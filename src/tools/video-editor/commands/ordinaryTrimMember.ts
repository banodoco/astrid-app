import type { CommandRecord, EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  captureClipTrim,
  executeClipTrim,
  type ClipTrimArgs,
  type ClipTrimBasis,
} from './clipTrimCapture.ts';
import { assertFiniteJson, copy, ClipMoveError, equal, freezeJson } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

/**
 * The ordinary member reuses the native capture. That source owns trim units,
 * precision, registry reads, and the guarded Agent command record.
 */
export type OrdinaryTrimPayload = {
  readonly in_s?: number | null;
  readonly out_s?: number | null;
};

/** A raw App member; endpoints are source seconds, not timeline milliseconds. */
export type OrdinaryTrimOperation = {
  readonly op: 'clip.trim';
  readonly target: string;
  readonly payload: OrdinaryTrimPayload;
};

export type OrdinaryTrimMemberBasis = Readonly<{
  readonly operation: OrdinaryTrimOperation;
  readonly select: string;
  readonly trim: ClipTrimBasis;
}>;

export type OrdinaryTrimMemberResult = Readonly<{
  readonly operation: OrdinaryTrimOperation;
  readonly command: EditCommand;
  readonly bundle: AuthoredBundle;
  readonly record: CommandRecord;
}>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOperation(operation: unknown, select?: string): asserts operation is OrdinaryTrimOperation {
  if (!isObject(operation) || Object.keys(operation).some((key) => !['op', 'target', 'payload'].includes(key))
    || operation.op !== 'clip.trim' || typeof operation.target !== 'string' || !operation.target
    || operation.target.includes('/') || !isObject(operation.payload)
    || Object.keys(operation.payload).some((key) => key !== 'in_s' && key !== 'out_s')) {
    throw new ClipMoveError('ordinary clip.trim requires a closed source-window payload');
  }
  if (select !== undefined && select !== `parent/clip:${operation.target}`) {
    throw new ClipMoveError('ordinary clip.trim target must retain its reserved parent clip identity', 'identity_conflict');
  }
  for (const key of ['in_s', 'out_s'] as const) {
    if (!Object.prototype.hasOwnProperty.call(operation.payload, key)) continue;
    const value = operation.payload[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ClipMoveError(`ordinary clip.trim ${key} must be a finite source-second value or null`, 'unsupported_timing');
    }
  }
}

function args(payload: OrdinaryTrimPayload): ClipTrimArgs {
  return { in_s: payload.in_s ?? null, out_s: payload.out_s ?? null };
}

function withOrdinal(
  operation: OrdinaryTrimOperation,
  prepared: ReturnType<typeof executeClipTrim>,
  ordinal: number,
): OrdinaryTrimMemberResult {
  prepared.record.ordinal = ordinal;
  prepared.record.derived_writes.forEach((write) => { write.cause = ordinal; });
  return Object.freeze({ operation, ...prepared });
}

/** Capture one raw trim member before any local preview or submission. */
export function captureOrdinaryTrimMember(
  bundle: AuthoredBundle,
  operation: OrdinaryTrimOperation,
): OrdinaryTrimMemberBasis {
  assertFiniteJson(bundle);
  assertFiniteJson(operation);
  assertOperation(operation);
  const select = `parent/clip:${operation.target}`;
  const trim = captureClipTrim(bundle, select, args(operation.payload));
  return freezeJson({ operation: copy(operation), select, trim });
}

/** Finish only the immutable native basis captured for this operation. */
export function finishOrdinaryTrimMember(
  basis: unknown,
  ordinal = 0,
): OrdinaryTrimMemberResult {
  assertFiniteJson(basis);
  if (!isObject(basis) || !isObject(basis.operation) || typeof basis.select !== 'string'
    || !isObject(basis.trim)) {
    throw new ClipMoveError('incomplete ordinary clip.trim basis');
  }
  assertOperation(basis.operation, basis.select);
  const trim = basis.trim as ClipTrimBasis;
  if (!isObject(trim.command) || trim.command.select !== basis.select || trim.command.op !== 'clip.trim'
    || !equal(trim.command.args, args(basis.operation.payload))) {
    throw new ClipMoveError('ordinary clip.trim basis command does not match its operation', 'capture_mismatch');
  }
  const prepared = executeClipTrim(trim.bundle, trim.command);
  return withOrdinal(basis.operation, prepared, ordinal);
}

/** Re-execute an Agent clip.trim command, retaining its original guards. */
export function executeOrdinaryTrimMember(
  bundle: AuthoredBundle,
  command: EditCommand,
  ordinal = 0,
) {
  const prepared = executeClipTrim(bundle, command);
  prepared.record.ordinal = ordinal;
  prepared.record.derived_writes.forEach((write) => { write.cause = ordinal; });
  return prepared;
}
