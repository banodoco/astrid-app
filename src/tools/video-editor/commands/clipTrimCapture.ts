import type { EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  assertFiniteJson,
  AuthoredState,
  ClipMoveError,
  copy,
  equal,
  freezeJson,
  has,
  MoveRecording,
  object,
} from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

export { ClipMoveError as ClipTrimError } from './clipMovePrimitives.ts';
export type { AuthoredBundle } from './clipMovePrimitives.ts';

export type ClipTrimArgs = {
  readonly in_s?: number | null;
  readonly out_s?: number | null;
};

export type ClipTrimBasis = {
  readonly bundle: AuthoredBundle;
  readonly command: EditCommand;
};

const SOURCE_FIELDS = [
  'sourceURL', 'sourceUrl', 'source_url', 'src', 'source_uuid', 'source', 'source_window',
  'source_offset', 'anchor', 'animation', 'animations', 'keyframes', 'curves',
] as const;
const CLIP_FIELDS = [
  'id', 'at', 'at_ms', 'track', 'asset', 'asset_id', 'media_id', 'object_id', 'clipType', 'clip_type',
  'enabled', 'active', 'disabled', 'hidden', 'deleted', 'from', 'to', 'from_ms', 'to_ms', 'hold',
  'duration', 'duration_ms', 'speed', 'time_map', 'timeMap', 'clips', 'children',
] as const;
const PARAM_FIELDS = ['animation', 'animations', 'keyframes', 'curves'] as const;
const INTENT_KEYS = new Set([
  'on', 'until', 'for', 'cut', 'layer', 'why', 'why_layers', 'deliberate', 'deliberate_hold',
  'formulas', 'segment', 'words', 'text', 'gap_after_s', 'beats', 'beats_label', 'slot',
  'replaces', 'standin', 'standin_intent', 'sequence', 'sequence_index', 'sequence_fit', 'orphan',
]);

function number(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new ClipMoveError(`${label} must be a finite ${positive ? 'positive ' : ''}number`, 'unsupported_timing');
  }
  return value;
}

// Trim uses Python round(binary64, 6), with an exact inward floor at the file end.
// Decode the nonnegative input itself: value * 1e6 can erase a tie or fraction.
function rounded(value: number, inward = false): number {
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  const bits = bytes.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const significand = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const shift = exponent ? exponent - 1075 : -1074;
  const scaled = significand * 1_000_000n;
  const numerator = shift >= 0 ? scaled << BigInt(shift) : scaled;
  const denominator = shift >= 0 ? 1n : 1n << BigInt(-shift);
  let units = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  if (!inward && (twiceRemainder > denominator ||
    twiceRemainder === denominator && units % 2n !== 0n)) units++;
  // Parse the exact decimal rational once, avoiding Number(units) / 1e6 double rounding.
  return Number(`${units}e-6`);
}

function present(value: unknown): value is JSON {
  return value !== null && value !== undefined;
}

function validArgs(args: unknown): args is Record<string, JSON> {
  return object(args) && Object.keys(args).every((key) => key === 'in_s' || key === 'out_s');
}

function clearIntent(app: JSON | undefined): JSON | undefined {
  const holder: { app?: JSON } = { app: object(app) ? copy(app) : undefined };
  for (const clearedKey of ['until', 'for']) {
    const cleared = object(holder.app) ? holder.app : {};
    holder.app = cleared;
    const nested = object(cleared.astrid) ? cleared.astrid : {};
    if (!object(cleared.astrid)) cleared.astrid = nested;
    for (const key of INTENT_KEYS) {
      if (!has(nested, key) && has(cleared, key)) {
        nested[key] = cleared[key];
        delete cleared[key];
      }
    }
    delete nested[clearedKey];
    if (Object.keys(nested).length === 0) delete cleared.astrid;
    if (Object.keys(cleared).length === 0) delete holder.app;
  }
  return holder.app;
}

function trim(bundle: AuthoredBundle, command: EditCommand) {
  const ref = command.select;
  if (typeof ref !== 'string' || !/^parent\/clip:[^/]+$/.test(ref) || ref.includes('::')) {
    throw new ClipMoveError('clip.trim v1 requires a literal parent clip identity');
  }
  if (command.schema_version !== 1 || command.op !== 'clip.trim' || command.version !== '1' ||
    !validArgs(command.args) || !equal(command.intent ?? {}, {})) {
    throw new ClipMoveError('unsupported clip.trim v1 command');
  }
  for (const key of ['in_s', 'out_s'] as const) {
    const value = command.args[key];
    if (value !== null && value !== undefined) number(value, `args.${key}`);
  }

  const ctx = new MoveRecording(bundle, { ...copy(command), intent: {} });
  const identity = ctx.read(ref, ['id']);
  if (identity === undefined || identity === null) {
    throw new ClipMoveError('trim target disappeared', 'identity_conflict');
  }
  const clip: Record<string, JSON | undefined> = {};
  for (const key of [...CLIP_FIELDS, ...SOURCE_FIELDS]) {
    clip[key] = ctx.read(ref, [key]);
  }
  for (const key of [
    'at_ms', 'from_ms', 'to_ms', 'duration', 'duration_ms', 'time_map', 'timeMap', 'clips', 'children',
    ...SOURCE_FIELDS,
  ]) {
    if (present(clip[key])) {
      throw new ClipMoveError(`clip.trim v1 does not support ${key}`, 'unsupported_timing');
    }
  }
  for (const key of PARAM_FIELDS) {
    if (present(ctx.read(ref, ['params', key]))) {
      throw new ClipMoveError(`clip.trim v1 does not support params.${key}`, 'unsupported_timing');
    }
  }

  const app = ctx.read(ref, ['app']);
  if (present(app) && !object(app)) throw new ClipMoveError('trim intent container must be object or null');
  const nested = object(app) && object(app.astrid) ? app.astrid : undefined;
  if (object(app) && present(app.astrid) && !object(app.astrid)) {
    throw new ClipMoveError('trim intent container must be object or null');
  }
  for (const [prefix, container] of [
    [[], clip],
    [['app'], object(app) ? app : undefined],
    [['app', 'astrid'], nested],
  ] as [string[], Record<string, JSON> | undefined][]) {
    for (const key of [
      'on', 'fixed_start', 'until', 'until_film_end', 'for', 'cut', 'sequence', 'sequence_index',
      'sequence_fit', 'orphan', 'formulas', 'anchor', 'standin', 'standin_intent', 'animation',
      'animations',
    ]) {
      const value = prefix.length === 0 ? ctx.read(ref, [key]) : container?.[key];
      if (key === 'fixed_start' && (value === undefined || value === null || value === true)) continue;
      if (key === 'for' && prefix.length > 0 && present(value)) {
        number(value, 'for', true);
      } else if (present(value)) {
        throw new ClipMoveError(`clip.trim v1 does not support ${key}`, 'unsupported_timing');
      }
    }
  }

  if (clip.clipType !== undefined && clip.clipType !== null && clip.clipType !== 'media' ||
    clip.clip_type !== undefined && clip.clip_type !== null && clip.clip_type !== 'media') {
    throw new ClipMoveError('clip.trim applies to media clips');
  }
  const asset = clip.asset;
  if (typeof asset !== 'string' || !asset || present(clip.asset_id) || present(clip.media_id) || present(clip.object_id)) {
    throw new ClipMoveError('clip.trim requires the current registry asset identity');
  }
  const start = number(clip.at, 'clip.at');
  if (start < 0) throw new ClipMoveError('clip.trim requires a non-negative literal start');
  if (present(clip.hold)) number(clip.hold, 'clip.hold', true);
  if (clip.speed !== undefined && clip.speed !== null) number(clip.speed, 'clip.speed', true);

  const source: Record<string, JSON> = {};
  for (const key of [
    'media_id', 'object_id', 'digest', 'content_digest', 'type', 'duration', 'duration_ms',
    'duration_seconds', 'source', 'source_window', 'time_map', 'timeMap',
  ]) {
    source[key] = ctx.read('parent/registry', ['assets', asset, key]) ?? null;
  }
  if (['source', 'source_window', 'time_map', 'timeMap'].some((key) => present(source[key]))) {
    throw new ClipMoveError('clip.trim v1 does not support a mapped media source', 'unsupported_map');
  }
  const limit = number(source.duration, 'registry source duration', true);
  const endpoints: number[] = [];
  const endpointSpecs: Array<readonly [string, 'in_s' | 'out_s', number]> = [
    ['from', 'in_s', 0], ['to', 'out_s', limit],
  ];
  for (const [key, arg, fallback] of endpointSpecs) {
    const current = clip[key] === undefined || clip[key] === null ? fallback : number(clip[key], `clip.${key}`);
    const value = command.args[arg];
    endpoints.push(value === undefined || value === null ? current : number(value, `args.${arg}`));
  }
  const [sourceIn, sourceOut] = endpoints;
  if (sourceIn < 0 || sourceOut > limit || sourceOut <= sourceIn) {
    throw new ClipMoveError(`source range must fit inside the file (0–${limit} s)`);
  }
  const appliedIn = rounded(sourceIn);
  const nearestOut = rounded(sourceOut);
  const appliedOut = nearestOut > limit ? rounded(limit, true) : nearestOut;
  if (appliedOut <= appliedIn) {
    throw new ClipMoveError('source range collapses at authored precision');
  }
  const hold = rounded(appliedOut - appliedIn);
  if (hold <= 0) {
    throw new ClipMoveError('source range collapses at authored precision');
  }
  ctx.dependency('trim.source', 'entity', { asset, source });
  ctx.bind('trim.target', ref, ['trim.source']);
  const writes: Array<readonly [string, number]> = [
    ['from', appliedIn], ['to', appliedOut], ['hold', hold],
  ];
  for (const [key, value] of writes) {
    ctx.write(ref, [key], value);
  }
  const cleared = clearIntent(app);
  if (cleared === undefined) ctx.clear(ref, ['app']);
  else ctx.write(ref, ['app'], cleared);
  ctx.compile();
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function assertCaptureClaims(bundle: AuthoredBundle, command: EditCommand, actual: EditCommand): void {
  for (const key of ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const) {
    if (!has(command, key)) continue;
    let matches = equal(command[key], actual[key]);
    if (key === 'reads' && Array.isArray(command.reads) && Array.isArray(actual.reads)) {
      const state = new AuthoredState(bundle);
      matches = command.reads.length === actual.reads.length && command.reads.every((claimed, index) => {
        const read = actual.reads![index];
        return claimed.ref === read.ref && equal(claimed.path, read.path) &&
          (equal(claimed.state, read.state) || (read.ref.endsWith('/shot') && state.matches(read.ref, read.path, claimed.state)));
      });
    }
    if (!matches) throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
  }
}

export function executeClipTrim(bundle: AuthoredBundle, command: EditCommand) {
  assertFiniteJson(bundle);
  assertFiniteJson(command);
  const result = trim(bundle, command);
  assertCaptureClaims(bundle, command, result.command);
  Object.assign(result.command, copy(command), { intent: result.command.intent });
  return result;
}

export function captureClipTrim(bundle: AuthoredBundle, select: string, args: ClipTrimArgs = {}): ClipTrimBasis {
  assertFiniteJson(bundle);
  const snapshot = copy(bundle);
  const command: EditCommand = {
    schema_version: 1,
    op: 'clip.trim',
    version: '1',
    select,
    args: { in_s: args.in_s ?? null, out_s: args.out_s ?? null },
    intent: {},
  };
  const result = executeClipTrim(snapshot, command);
  return freezeJson({ bundle: snapshot, command: result.command });
}
