import type { EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  AuthoredState,
  ClipMoveError,
  MoveRecording,
  assertFiniteJson,
  copy,
  equal,
  freezeJson,
  has,
  object,
} from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

/** The fields accepted by Agent's existing clip.set command. */
export type OrdinaryScalarClear = 'hold' | 'asset' | 'transition';
export type OrdinaryScalarValues = { hold?: number };
export type OrdinaryScalarOptions = {
  values?: OrdinaryScalarValues;
  clear?: readonly OrdinaryScalarClear[];
};

/** A raw, already-resolved member for a later atomic generic batch. */
export type OrdinaryScalarMember = OrdinaryScalarOptions & { select: string };

export type OrdinaryScalarResult = ReturnType<typeof executeClear>;
export type OrdinaryScalarBatchResult = {
  bundle: AuthoredBundle;
  commands: EditCommand[];
  records: OrdinaryScalarResult['record'][];
};

const CLIP_REF = /^(?:parent|occurrence:[^/]+)\/clip:[^/]+$/;
const CLEAR_FIELDS: readonly OrdinaryScalarClear[] = ['hold', 'asset', 'transition'];
const CLIP_FIELDS = [
  'id', 'at', 'at_ms', 'track', 'asset', 'asset_id', 'media_id', 'object_id',
  'clipType', 'clip_type', 'enabled', 'active', 'disabled', 'hidden', 'deleted',
  'from', 'to', 'from_ms', 'to_ms', 'hold', 'duration', 'duration_ms', 'speed',
  'time_map', 'timeMap', 'clips', 'children',
];
const RELATIONS = [
  'on', 'fixed_start', 'until', 'until_film_end', 'for', 'cut', 'sequence',
  'sequence_index', 'sequence_fit', 'orphan', 'formulas',
];
const MAP_FIELDS = [
  ['placement', 'start_ms'], ['at_ms'], ['duration_ms'], ['source_offset'],
  ['speed'], ['track'], ['placement', 'track'], ['time_map'], ['timeMap'],
  ['enabled'], ['active'], ['disabled'], ['hidden'], ['deleted'],
];

function number(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new ClipMoveError(`${label} must be a finite ${positive ? 'positive ' : ''}number`, 'unsupported_timing');
  }
  return value;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
}

function decimal(value: number): [bigint, bigint] {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const digits = mantissa.replace('.', '');
  const scale = (mantissa.split('.')[1]?.length ?? 0) - Number(exponent);
  return scale >= 0
    ? [BigInt(digits), 10n ** BigInt(scale)]
    : [BigInt(digits) * 10n ** BigInt(-scale), 1n];
}

function rate(value: JSON | undefined): [bigint, bigint] {
  let numerator: bigint;
  let denominator: bigint;
  if (value == null) return [30n, 1n];
  if (object(value) && equal(Object.keys(value).sort(), ['denominator', 'numerator'])) {
    if (!Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)) {
      throw new ClipMoveError('fps rational requires safe integer numerator/denominator');
    }
    numerator = BigInt(number(value.numerator, 'fps numerator', true));
    denominator = BigInt(number(value.denominator, 'fps denominator', true));
  } else {
    [numerator, denominator] = decimal(number(value, 'fps', true));
  }
  let a = numerator;
  let b = denominator;
  while (b) [a, b] = [b, a % b];
  if (!Number.isSafeInteger(Number(numerator / a)) || !Number.isSafeInteger(Number(denominator / a))) {
    throw new ClipMoveError('fps fraction exceeds browser JSON integer precision', 'unsupported_timing');
  }
  return [numerator / a, denominator / a];
}

function fractionNumber(numerator: bigint, denominator: bigint): number {
  if (numerator === 0n) return 0;
  let exponent = numerator.toString(2).length - denominator.toString(2).length;
  if (exponent >= 0
    ? numerator < (denominator << BigInt(exponent))
    : (numerator << BigInt(-exponent)) < denominator) exponent--;
  const shift = exponent < -1022 ? 1074 : 52 - exponent;
  const scaledNumerator = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const scaledDenominator = shift >= 0 ? denominator : denominator << BigInt(-shift);
  let quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  if (remainder * 2n > scaledDenominator ||
    (remainder * 2n === scaledDenominator && quotient % 2n !== 0n)) quotient++;
  return Number(quotient) * 2 ** -shift;
}

function timelineDuration(clip: Record<string, JSON>): number {
  const speed = clip.speed == null ? 1 : number(clip.speed, 'clip.speed', true);
  const at = has(clip, 'at')
    ? number(clip.at, 'clip.at')
    : number(clip.at_ms, 'clip.at_ms') / 1000;
  if (!has(clip, 'at') && !has(clip, 'at_ms')) {
    throw new ClipMoveError('move requires an explicit authored start', 'unsupported_timing');
  }
  if (at < 0) throw new ClipMoveError('clip.set does not support a clipped negative start', 'unsupported_timing');
  if (has(clip, 'at') && has(clip, 'at_ms') &&
    !close(at, number(clip.at_ms, 'clip.at_ms') / 1000)) {
    throw new ClipMoveError('contradictory at/at_ms timing codecs', 'unsupported_timing');
  }
  const lengths: number[] = [];
  if (typeof clip.hold === 'number' && typeof clip.hold !== 'boolean') {
    lengths.push(number(clip.hold, 'hold') / speed);
  } else if (clip.from != null && clip.to != null) {
    lengths.push((number(clip.to, 'to') - number(clip.from, 'from')) / speed);
  }
  for (const [key, scale] of [['duration', 1], ['duration_ms', 1000]] as const) {
    if (clip[key] != null) lengths.push(number(clip[key], key) / scale / speed);
  }
  if (!lengths.length || lengths[0] <= 0 ||
    lengths.some((length) => !Number.isFinite(length) || !close(length, lengths[0]))) {
    throw new ClipMoveError('move needs an unambiguous positive authored duration/window', 'unsupported_timing');
  }
  return lengths[0];
}

function clipStartFrame(clip: Record<string, JSON>, fps: number): number {
  return Math.floor(number(clip.at, 'clip.at') * number(fps, 'fps', true) + 0.5);
}

function clipEndFrame(clip: Record<string, JSON>, fps: number): number {
  const start = clipStartFrame(clip, fps);
  const frames = Math.max(1, Math.floor(timelineDuration(clip) * fps + 0.5));
  return start + frames;
}

function occurrenceStart(row: Record<string, JSON>): number {
  if (row.placement != null && !object(row.placement)) {
    throw new ClipMoveError('occurrence placement must be an object', 'unsupported_map');
  }
  const placement = row.placement as Record<string, JSON> | undefined;
  const start = placement?.start_ms;
  const fallback = row.at_ms;
  if (start != null && fallback != null &&
    !close(number(start, 'placement.start_ms'), number(fallback, 'at_ms'))) {
    throw new ClipMoveError('contradictory occurrence start codecs', 'unsupported_timing');
  }
  return number(start ?? fallback ?? 0, 'occurrence start') / 1000;
}

function holdExtent(ctx: MoveRecording, ref: string, values: Record<string, JSON>, clear: readonly OrdinaryScalarClear[]): [string[][], number] {
  const owner = ref.slice(0, ref.lastIndexOf('/'));
  const durationPaths: string[][] = [];
  for (const key of CLIP_FIELDS) ctx.read(ref, [key]);
  const row = copy(ctx.state.entity(ref)!);
  for (const key of ['time_map', 'timeMap', 'clips', 'children', 'from_ms', 'to_ms']) {
    if (row[key] != null) throw new ClipMoveError(`clip.set does not support ${key}`, 'unsupported_timing');
  }
  for (const prefix of [[], ['app'], ['app', 'astrid']]) {
    for (const key of RELATIONS) {
      const value = ctx.read(ref, [...prefix, key]);
      if (value == null || (key === 'fixed_start' && typeof value === 'boolean')) continue;
      if (key === 'for') {
        if (!close(number(value, 'for', true), timelineDuration(row))) {
          throw new ClipMoveError('clip.set hold conflicts with static for', 'unsupported_timing');
        }
        durationPaths.push([...prefix, key]);
        continue;
      }
      throw new ClipMoveError(`clip.set hold does not support ${key}`, 'unsupported_timing');
    }
  }
  if (has(values, 'hold')) row.hold = values.hold;
  if (clear.includes('hold')) {
    delete row.hold;
    if (row.from == null || row.to == null) {
      throw new ClipMoveError('hold clear requires a surviving source window', 'unsupported_timing');
    }
  }
  const duration = timelineDuration(row);
  row.at = has(row, 'at') ? row.at : number(row.at_ms ?? 0, 'at_ms') / 1000;
  const fps = rate(ctx.read('parent', ['config', 'output', 'fps']));
  const fpsNumber = fractionNumber(fps[0], fps[1]);
  const end = clipEndFrame(row, fpsNumber);
  ctx.dependency('clip.set.quantization', 'time-map', {
    numerator: Number(fps[0]),
    denominator: Number(fps[1]),
    rounding: 'half-toward-positive-infinity',
  });
  if (owner === 'parent') return [durationPaths, duration];
  const childFps = ctx.read(`${owner}/source`, ['output', 'fps']);
  if (childFps != null && !equal(rate(childFps), fps)) {
    throw new ClipMoveError('parent and child fps differ', 'unsupported_timing');
  }
  for (const path of MAP_FIELDS) ctx.read(owner, path);
  const occurrence = ctx.state.occurrence(owner);
  if (occurrence.time_map != null || occurrence.timeMap != null ||
    (typeof occurrence.speed === 'boolean') || (occurrence.speed != null && occurrence.speed !== 1) ||
    (typeof occurrence.source_offset === 'boolean') ||
    (occurrence.source_offset != null && occurrence.source_offset !== 0)) {
    throw new ClipMoveError('clip.set requires a translation-only occurrence', 'unsupported_map');
  }
  const origin = occurrenceStart(occurrence);
  const extent = occurrence.duration_ms;
  if (extent == null) throw new ClipMoveError('clip.set requires an explicit occurrence extent', 'unsupported_timing');
  let limit = origin + number(extent, 'occurrence.duration_ms', true) / 1000;
  for (const other of ctx.select('move.blockers', owner)) {
    for (const path of [['placement', 'start_ms'], ['at_ms'], ['track'], ['placement', 'track'],
      ['enabled'], ['active'], ['disabled'], ['hidden'], ['deleted']]) ctx.read(other, path);
    const start = occurrenceStart(ctx.state.occurrence(other));
    if (other !== owner && start > origin) limit = Math.min(limit, start);
  }
  const boundary = clipStartFrame({ at: limit - origin, hold: 1 }, fpsNumber);
  if (number(row.at, 'clip.at') < 0 || number(row.at, 'clip.at') + duration > limit - origin + 1e-9 || end > boundary) {
    throw new ClipMoveError('clip.set interval crosses occurrence boundary', 'occurrence_boundary');
  }
  return [durationPaths, duration];
}

type OrdinaryScalarCommandArgs = {
  readonly values: OrdinaryScalarValues;
  readonly clear: readonly OrdinaryScalarClear[];
};

function scalarArgs(command: EditCommand): OrdinaryScalarCommandArgs {
  if (command.schema_version !== 1 || command.op !== 'clip.set' || command.version !== '1'
    || (command.intent !== undefined && !equal(command.intent, {}))
    || !object(command.args) || !object(command.args.values) || !Array.isArray(command.args.clear)
    || !equal(Object.keys(command.args).sort(), ['clear', 'values'])) {
    throw new ClipMoveError('unsupported clip.set v1 scalar member');
  }
  const values = command.args.values;
  const clear = command.args.clear;
  const hasHold = Object.prototype.hasOwnProperty.call(values, 'hold');
  const hold = values.hold;
  if (Object.keys(values).some((key) => key !== 'hold') ||
    Object.keys(values).some((key) => clear.includes(key)) ||
    clear.some((key) => typeof key !== 'string' || !CLEAR_FIELDS.includes(key as OrdinaryScalarClear)) ||
    new Set(clear).size !== clear.length || (!Object.keys(values).length && !clear.length)) {
    throw new ClipMoveError('clip.set scalar member contains an unsupported field');
  }
  const typedValues: OrdinaryScalarValues = {};
  if (hasHold) {
    if (typeof hold !== 'number' || !Number.isFinite(hold) || hold <= 0) {
      throw new ClipMoveError('hold must be a finite positive number', 'unsupported_timing');
    }
    typedValues.hold = hold;
  }
  return {
    values: typedValues,
    clear: clear.filter((key): key is OrdinaryScalarClear => typeof key === 'string'),
  };
}

function target(ctx: MoveRecording, ref: string): string {
  if (!CLIP_REF.test(ref) || ref.includes('::')) {
    throw new ClipMoveError('clip.set requires a parent or occurrence clip identity');
  }
  const owner = ref.slice(0, ref.lastIndexOf('/'));
  if (ctx.read(ref, ['id']) === undefined) {
    throw new ClipMoveError('scalar target disappeared', 'identity_conflict');
  }
  const pin: Record<string, JSON> = { parent: copy(ctx.state.bundle.base_parent ?? {}) };
  if (owner !== 'parent') {
    ctx.read(owner, ['occurrence_id']);
    ctx.read(`${owner}/shot`, ['shot_id']);
    const shot = ctx.state.occurrence(owner).shot_id;
    const mapping = object(ctx.state.bundle.source_mapping) ? ctx.state.bundle.source_mapping : {};
    const shots = object(mapping.shots) ? mapping.shots : {};
    pin.source = copy(shots[String(shot)] ?? {});
    ctx.bind('scalar.owner', owner);
  }
  ctx.dependency('scalar.images', 'entity', pin);
  ctx.bind('scalar.target', ref, ['scalar.images']);
  return ref;
}

function clipBasis(ctx: MoveRecording, ref: string): void {
  for (const key of ['clipType', 'clip_type', 'asset', 'asset_id', 'media_id', 'object_id', 'elementRef', 'element_ref']) {
    ctx.read(ref, [key]);
  }
  const row = ctx.state.entity(ref)!;
  const selector = ['asset', 'asset_id', 'media_id', 'object_id'].find((key) => has(row, key));
  const selected = selector ? row[selector] : undefined;
  if ((selector === 'asset' || selector === 'asset_id') && typeof selected === 'string') {
    const registry = `${ref.slice(0, ref.lastIndexOf('/'))}/registry`;
    for (const key of ['media_id', 'object_id', 'digest', 'content_digest']) {
      ctx.read(registry, ['assets', selected, key]);
    }
  }
}

function executeClear(bundle: AuthoredBundle, command: EditCommand) {
  const { values, clear } = scalarArgs(command);
  const ctx = new MoveRecording(bundle, { ...command, intent: {} });
  const ref = target(ctx, command.select!);
  clipBasis(ctx, ref);
  const row = ctx.state.entity(ref)!;
  if (clear.includes('asset') && ['asset_id', 'media_id', 'object_id'].some((key) => has(row, key))) {
    throw new ClipMoveError('asset clear cannot expose another media selector', 'invalid_edit_command');
  }
  const asset = has(row, 'asset') ? row.asset : row.asset_id;
  if (typeof asset === 'string') {
    ctx.read(`${ref.slice(0, ref.lastIndexOf('/'))}/registry`, ['assets', asset, 'content_sha256']);
  }
  const [durationPaths, duration] = has(values, 'hold') || clear.includes('hold')
    ? holdExtent(ctx, ref, { ...values }, clear)
    : [[], 0];
  for (const path of durationPaths) ctx.write(ref, path, duration);
  for (const key of Object.keys(values).sort()) {
    if (key !== 'hold' || values.hold === undefined) {
      throw new ClipMoveError('clip.set scalar member contains an unsupported field');
    }
    ctx.write(ref, [key], values.hold);
  }
  for (const key of [...clear].sort()) ctx.clear(ref, [key]);
  ctx.compile();
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function verifyCapturedFields(bundle: AuthoredBundle, command: EditCommand, actual: EditCommand): void {
  for (const key of ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const) {
    let matches = equal(command[key], actual[key]);
    if (key === 'reads' && Array.isArray(command.reads)) {
      const state = new AuthoredState(bundle);
      matches = command.reads.length === (actual.reads?.length ?? 0) && command.reads.every((claimed, index) => {
        const read = actual.reads![index];
        return claimed.ref === read.ref && equal(claimed.path, read.path) &&
          (equal(claimed.state, read.state) ||
            (read.ref.endsWith('/shot') && state.matches(read.ref, read.path, claimed.state)));
      });
    }
    if (has(command, key) && !matches) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
}

/** Execute one captured scalar command against authored state. */
export function executeOrdinaryScalarMember(
  bundle: AuthoredBundle,
  command: EditCommand,
  ordinal = 0,
): OrdinaryScalarResult {
  assertFiniteJson(bundle);
  assertFiniteJson(command);
  const normalized = executeClear(bundle, command);
  verifyCapturedFields(bundle, command, normalized.command);
  normalized.record.ordinal = ordinal;
  normalized.record.derived_writes.forEach((write) => { write.cause = ordinal; });
  Object.assign(normalized.command, copy(command), { intent: normalized.command.intent });
  return normalized;
}

/** Capture a scalar value or explicit clear on an already-resolved raw clip. */
export function captureOrdinaryScalarMember(
  bundle: AuthoredBundle,
  member: OrdinaryScalarMember,
): EditCommand {
  const values = copy(member.values ?? {});
  const clear = [...(member.clear ?? [])];
  scalarArgs({ schema_version: 1, op: 'clip.set', version: '1', select: member.select,
    args: { values, clear }, intent: {} });
  assertFiniteJson(bundle);
  const command: EditCommand = { schema_version: 1, op: 'clip.set', version: '1', select: member.select,
    args: { values, clear }, intent: {} };
  return freezeJson(executeOrdinaryScalarMember(copy(bundle), command).command);
}

/** Capture an explicit clear without accepting null/sentinel SET values. */
export function captureOrdinaryScalarClear(
  bundle: AuthoredBundle,
  select: string,
  field: OrdinaryScalarClear,
): EditCommand {
  return captureOrdinaryScalarMember(bundle, { select, clear: [field] });
}

/** Execute a sequential scalar batch against one immutable input bundle. */
export function executeOrdinaryScalarBatch(
  bundle: AuthoredBundle,
  commands: EditCommand[],
): OrdinaryScalarBatchResult {
  let current = copy(bundle);
  const result: OrdinaryScalarBatchResult = { bundle: current, commands: [], records: [] };
  commands.forEach((command, ordinal) => {
    const executed = executeOrdinaryScalarMember(current, command, ordinal);
    current = executed.bundle;
    result.commands.push(executed.command);
    result.records.push(executed.record);
  });
  result.bundle = current;
  return result;
}
