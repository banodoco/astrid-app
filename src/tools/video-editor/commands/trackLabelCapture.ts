import type { EditCommand, TrackSetArgs } from '@/integrations/runtime/timeline-commit-types.ts';
import { ClipMoveError, MoveRecording, assertFiniteJson, copy, equal, freezeJson, has, object } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

export type TrackLabelArgs = TrackSetArgs & ({ values: { label: string }; clear: [] }
  | { values: Record<string, never>; clear: ['label'] });
export type TrackLabelBasis = { readonly bundle: AuthoredBundle; readonly command: EditCommand };

const CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;

function assertArgs(args: unknown): asserts args is TrackLabelArgs {
  if (!object(args) || !equal(Object.keys(args).sort(), ['clear', 'values']) || !object(args.values) ||
    !((equal(Object.keys(args.values), ['label']) && typeof args.values.label === 'string' && equal(args.clear, [])) ||
      (equal(args.values, {}) && equal(args.clear, ['label'])))) {
    throw new ClipMoveError('track label requires a string value or an explicit label clear');
  }
}

// Agent 77b1f0f7 _scalar_commands.py::track_set, restricted to parent labels.
function apply(bundle: AuthoredBundle, supplied: EditCommand) {
  const ref = supplied.select;
  if (supplied.schema_version !== 1 || supplied.op !== 'track.set' || supplied.version !== '1' ||
    typeof ref !== 'string' || !/^parent\/track:[^/]+$/.test(ref) || ref.includes('::')) {
    throw new ClipMoveError('track label requires an explicit parent/track:<raw-id> identity');
  }
  if (has(supplied, 'intent') && !equal(supplied.intent, {})) {
    throw new ClipMoveError('track label has no intention overrides');
  }
  assertArgs(supplied.args);
  if (!object(bundle.parent) || !object(bundle.parent.config)) {
    throw new ClipMoveError('track label requires an authored parent config');
  }
  if (!object(bundle.base_parent)) {
    throw new ClipMoveError('track label requires the original parent source pin');
  }
  const ctx = new MoveRecording(bundle, { ...supplied, intent: {} });
  if (ctx.read(ref, ['id']) == null) {
    throw new ClipMoveError('scalar target disappeared', 'identity_conflict');
  }
  ctx.dependency('scalar.images', 'entity', { parent: copy(bundle.base_parent) });
  ctx.bind('scalar.target', ref, ['scalar.images']);
  if (typeof supplied.args.values.label === 'string') ctx.write(ref, ['label'], supplied.args.values.label);
  else ctx.clear(ref, ['label']);
  for (const key of CLAIMS) {
    if (has(supplied, key) && !equal(supplied[key], ctx.command[key])) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
  // Only a local label preview. Agent owns compilation and the accepted record.
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

/** Capture raw authored state before preview; use the previous local bundle for dependent edits. */
export function captureTrackLabel(bundle: AuthoredBundle, select: string): TrackLabelBasis {
  assertFiniteJson(bundle);
  assertFiniteJson(select);
  const snapshot = copy(bundle);
  // Clear records the original presence without choosing or coercing a new label.
  const { command } = apply(snapshot, { schema_version: 1, op: 'track.set', version: '1', select,
    args: { values: {}, clear: ['label'] } });
  return freezeJson({ bundle: snapshot, command });
}

/** Finish against the original portable basis, without an ACK or refreshed display document. */
export function finishTrackLabel(basis: unknown, args: TrackLabelArgs) {
  assertFiniteJson(basis);
  assertFiniteJson(args);
  assertArgs(args);
  if (!object(basis) || !object(basis.bundle) || !object(basis.command) ||
    !CLAIMS.every((key) => has(basis.command as object, key))) {
    throw new ClipMoveError('incomplete track label basis');
  }
  return apply(basis.bundle as AuthoredBundle, { ...copy(basis.command as EditCommand), args: copy(args) });
}
