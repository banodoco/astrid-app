import type { EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import { AuthoredState, ClipMoveError, MoveRecording, assertFiniteJson, copy, equal, freezeJson, has, object } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

export { ClipMoveError } from './clipMovePrimitives.ts';
export type { AuthoredBundle } from './clipMovePrimitives.ts';

// Built-in clip.move v1, ported from Agent sdk/timeline/capture.py::move.
// The recorder supplies metadata; this recipe supplies only reads and authored writes.
const INTENT = { ripple: 'none', anchor: 'fixed', position: 'absolute' } as const;
const moveIntent = (select: string): EditCommand['intent'] => select.startsWith('occurrence:')
  ? { ...INTENT, ownership: 'occurrence' } : { ...INTENT };
const CLIP_FIELDS = ['id', 'at', 'at_ms', 'track', 'asset', 'asset_id', 'media_id', 'object_id',
  'clipType', 'clip_type', 'enabled', 'active', 'disabled', 'hidden', 'deleted',
  'from', 'to', 'from_ms', 'to_ms', 'hold', 'duration', 'duration_ms', 'speed', 'time_map', 'timeMap', 'clips', 'children'];
const RELATIONS = ['on', 'fixed_start', 'until', 'until_film_end', 'for', 'cut', 'sequence',
  'sequence_index', 'sequence_fit', 'orphan', 'formulas'];
const MAP_FIELDS = [['placement', 'start_ms'], ['at_ms'], ['duration_ms'], ['source_offset'],
  ['speed'], ['track'], ['placement', 'track'], ['time_map'], ['timeMap'],
  ['enabled'], ['active'], ['disabled'], ['hidden'], ['deleted']];

export function number(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new ClipMoveError(`${label} must be a finite ${positive ? 'positive ' : ''}number`, 'unsupported_timing');
  }
  return value;
}

function decimal(value: number): [bigint, bigint] {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const digits = mantissa.replace('.', '');
  const scale = (mantissa.split('.')[1]?.length ?? 0) - Number(exponent);
  return scale >= 0 ? [BigInt(digits), 10n ** BigInt(scale)] : [BigInt(digits) * 10n ** BigInt(-scale), 1n];
}

export function rate(value: JSON | undefined): [bigint, bigint] {
  let n: bigint, d: bigint;
  if (value == null) return [30n, 1n];
  if (object(value) && equal(Object.keys(value).sort(), ['denominator', 'numerator'])) {
    if (!Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)) {
      throw new ClipMoveError('fps rational requires safe integer numerator/denominator');
    }
    n = BigInt(number(value.numerator, 'fps numerator', true));
    d = BigInt(number(value.denominator, 'fps denominator', true));
  } else [n, d] = decimal(number(value, 'fps', true));
  let a = n, b = d;
  while (b) [a, b] = [b, a % b];
  if (!Number.isSafeInteger(Number(n / a)) || !Number.isSafeInteger(Number(d / a))) {
    throw new ClipMoveError('fps fraction exceeds browser JSON integer precision', 'unsupported_timing');
  }
  return [n / a, d / a];
}

// Convert the exact quantized Fraction to binary64 with one nearest-even rounding,
// including rates whose decimal denominator exceeds the exact Number integer range.
export function fractionNumber(n: bigint, d: bigint): number {
  if (n === 0n) return 0;
  let exponent = n.toString(2).length - d.toString(2).length;
  if (exponent >= 0 ? n < (d << BigInt(exponent)) : (n << BigInt(-exponent)) < d) exponent--;
  const shift = (exponent < -1022 ? 1074 : 52 - exponent);
  const numerator = shift >= 0 ? n << BigInt(shift) : n;
  const denominator = shift >= 0 ? d : d << BigInt(-shift);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n !== 0n)) quotient++;
  return Number(quotient) * 2 ** -shift;
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-9, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));

function duration(clip: Record<string, JSON>): number {
  const speed = clip.speed == null ? 1 : number(clip.speed, 'clip.speed', true);
  const at = has(clip, 'at') ? number(clip.at, 'clip.at') : number(clip.at_ms, 'clip.at_ms') / 1000;
  if (at < 0) throw new ClipMoveError('clip.move v1 does not support a clipped negative start', 'unsupported_timing');
  if (has(clip, 'at') && has(clip, 'at_ms') && !close(at, number(clip.at_ms, 'clip.at_ms') / 1000)) {
    throw new ClipMoveError('contradictory at/at_ms timing codecs', 'unsupported_timing');
  }
  const lengths: number[] = [];
  if (typeof clip.hold === 'number') lengths.push(number(clip.hold, 'hold') / speed);
  else if (clip.from != null && clip.to != null) lengths.push((number(clip.to, 'to') - number(clip.from, 'from')) / speed);
  if (clip.duration != null) lengths.push(number(clip.duration, 'duration') / speed);
  if (clip.duration_ms != null) lengths.push(number(clip.duration_ms, 'duration_ms') / 1000 / speed);
  if (!lengths.length || lengths[0] <= 0 || lengths.some((length) => !Number.isFinite(length) || !close(length, lengths[0]))) {
    throw new ClipMoveError('move needs an unambiguous positive authored duration/window', 'unsupported_timing');
  }
  return lengths[0];
}

export function occurrenceStart(row: Record<string, JSON>): number {
  if (row.placement != null && !object(row.placement)) throw new ClipMoveError('occurrence placement must be an object', 'unsupported_map');
  const placement = row.placement as Record<string, JSON> | undefined;
  const start = placement?.start_ms;
  const fallback = row.at_ms;
  if (start != null && fallback != null && !close(number(start, 'placement.start_ms'), number(fallback, 'at_ms'))) {
    throw new ClipMoveError('contradictory occurrence start codecs', 'unsupported_timing');
  }
  return number(start ?? fallback ?? 0, 'occurrence start') / 1000;
}

function move(bundle: AuthoredBundle, command: EditCommand) {
  if (command.schema_version !== 1 || command.op !== 'clip.move' || command.version !== '1' ||
    !equal(Object.keys(command.args), ['on'])) {
    throw new ClipMoveError('unsupported clip.move v1 command');
  }
  const ref = command.select;
  if (typeof ref !== 'string' || ref.includes('::') || !/^(parent|occurrence:[^/]+)\/clip:[^/]+$/.test(ref)) {
    throw new ClipMoveError('clip.move requires a stable scoped clip identity');
  }
  const owner = ref.slice(0, ref.lastIndexOf('/'));
  const intent = moveIntent(ref);
  if (!equal({ ...intent, ...command.intent }, intent)) throw new ClipMoveError('unsupported clip.move v1 intention');
  const ctx = new MoveRecording(bundle, { ...command, intent });
  if (!equal(ctx.select('move.target', owner, [ref]), [ref])) throw new ClipMoveError('move target disappeared', 'identity_conflict');
  for (const key of CLIP_FIELDS) ctx.read(ref, [key]);
  const clip = ctx.state.entity(ref)!;
  for (const key of ['time_map', 'timeMap', 'clips', 'children', 'from_ms', 'to_ms']) {
    if (clip[key] != null) throw new ClipMoveError(`clip.move v1 does not support ${key}`, 'unsupported_map');
  }
  for (const path of [['app'], ['app', 'astrid']]) {
    const state = ctx.state.get(ref, path);
    if (state.state === 'present' && object(state.value)) continue;
    const value = ctx.read(ref, path);
    if (value != null) throw new ClipMoveError('intent container must be object or null');
  }
  for (const prefix of [['app'], ['app', 'astrid']]) {
    for (const key of RELATIONS) {
      const value = ctx.read(ref, [...prefix, key]);
      if (['sequence', 'sequence_index', 'sequence_fit', 'formulas'].includes(key) && value != null && !equal(value, {})) {
        throw new ClipMoveError(`clip.move v1 does not support ${key}`, 'unsupported_timing');
      }
    }
  }
  if (typeof clip.track !== 'string' || !clip.track) throw new ClipMoveError('move requires a referenced track');
  const trackRef = `${owner}/track:${clip.track}`;
  for (const key of ['id', 'kind', 'role', 'enabled', 'active', 'disabled', 'hidden', 'deleted']) ctx.read(trackRef, [key]);
  if (!ctx.state.entity(trackRef, true)) throw new ClipMoveError('move track disappeared', 'identity_conflict');
  ctx.bind('move.track', trackRef);
  ctx.bind('move.owner', owner);
  const asset = has(clip, 'asset') ? clip.asset : clip.asset_id;
  const sourceDependencies: string[] = [];
  if (asset != null) {
    // Canonical authored asset selectors are strings; aliases from display data are not accepted.
    if (typeof asset !== 'string') throw new ClipMoveError('move requires a canonical asset identity');
    const source: Record<string, JSON> = {};
    for (const key of ['media_id', 'object_id', 'digest', 'content_digest', 'type', 'duration', 'duration_ms', 'duration_seconds', 'source']) {
      source[key] = ctx.read(`${owner}/registry`, ['assets', asset, key]) ?? null;
    }
    ctx.dependency('move.source', 'entity', { ref: `${owner}/registry`, asset, source });
    sourceDependencies.push('move.source');
  }
  const fps = rate(ctx.read('parent', ['config', 'output', 'fps']));
  if (owner !== 'parent') {
    const childFps = ctx.read(`${owner}/source`, ['output', 'fps']);
    if (childFps != null && !equal(rate(childFps), fps)) throw new ClipMoveError('parent and child fps differ', 'unsupported_timing');
  }
  ctx.dependency('move.quantization', 'time-map', { numerator: Number(fps[0]), denominator: Number(fps[1]), rounding: 'half-toward-positive-infinity' });
  const on = number(command.args.on, 'on');
  if (on < 0) throw new ClipMoveError('on must not be negative');
  const frame = number(Math.floor(on * fractionNumber(fps[0], fps[1]) + 0.5), 'frame');
  const quantized = number(fractionNumber(BigInt(frame) * fps[1], fps[0]), 'quantized start');
  const length = duration(clip);
  let origin = 0;
  if (owner !== 'parent') {
    ctx.read(owner, ['occurrence_id']);
    ctx.read(`${owner}/shot`, ['shot_id']);
    const row = ctx.state.occurrence(owner);
    for (const path of MAP_FIELDS) ctx.read(owner, path);
    if (row.time_map != null || row.timeMap != null ||
      (row.source_offset != null && row.source_offset !== 0) || (row.speed != null && row.speed !== 1)) {
      throw new ClipMoveError('clip.move v1 requires a translation-only occurrence map', 'unsupported_map');
    }
    origin = occurrenceStart(row);
    const lane = object(row.placement) && has(row.placement, 'track') ? row.placement.track : row.track;
    if (typeof lane === 'string') {
      for (const key of ['id', 'kind', 'role', 'enabled', 'active', 'disabled', 'hidden', 'deleted']) {
        ctx.read(`parent/track:${lane}`, [key]);
      }
    }
    let nextStart = Infinity;
    for (const other of ctx.select('move.blockers', owner)) {
      for (const path of [['placement', 'start_ms'], ['at_ms'], ['track'], ['placement', 'track'],
        ['enabled'], ['active'], ['disabled'], ['hidden'], ['deleted']]) ctx.read(other, path);
      const start = occurrenceStart(ctx.state.occurrence(other));
      if (other !== owner && start > origin) nextStart = Math.min(nextStart, start);
    }
    if (quantized + length > nextStart + 1e-9) throw new ClipMoveError('moved interval crosses the next occurrence', 'occurrence_boundary');
  }
  const local = number(quantized - origin, 'local start');
  if (local < 0) throw new ClipMoveError('moved interval precedes its occurrence', 'occurrence_boundary');
  const pin: Record<string, JSON> = { parent: copy(bundle.base_parent ?? {}) };
  if (owner !== 'parent') {
    const mapping = bundle.source_mapping;
    const shots = object(mapping) && object(mapping.shots) ? mapping.shots : {};
    pin.source = copy(shots[String(ctx.state.occurrence(owner).shot_id)] ?? {});
  }
  ctx.dependency('move.images', 'entity', pin);
  ctx.bind('move.target', ref, ['move.images', 'move.quantization', ...sourceDependencies]);
  const msOnly = has(clip, 'at_ms') && !has(clip, 'at');
  ctx.write(ref, [msOnly ? 'at_ms' : 'at'], number(msOnly ? local * 1000 : local, 'authored start'));
  if (has(clip, 'at') && has(clip, 'at_ms')) ctx.write(ref, ['at_ms'], number(local * 1000, 'at_ms'));
  ctx.object(ref, ['app']);
  ctx.object(ref, ['app', 'astrid']);
  for (const prefix of [['app'], ['app', 'astrid']]) {
    for (const key of ['on', 'until', 'until_film_end']) ctx.clear(ref, [...prefix, key]);
  }
  ctx.write(ref, ['app', 'astrid', 'fixed_start'], true);
  ctx.write(ref, ['app', 'astrid', 'for'], length);
  ctx.compile();
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record, previewAt: quantized };
}

/** Local authored execution only. Runtime/Agent remains the accepted compiler and rebase authority. */
export function executeClipMove(bundle: AuthoredBundle, command: EditCommand) {
  assertFiniteJson(bundle);
  assertFiniteJson(command);
  const result = move(bundle, command);
  for (const key of ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const) {
    let matches = equal(command[key], result.command[key]);
    if (key === 'reads' && Array.isArray(command.reads)) {
      const actual = result.command.reads!;
      const state = new AuthoredState(bundle);
      matches = command.reads.length === actual.length && command.reads.every((claimed, index) => {
        const read = actual[index];
        return claimed.ref === read.ref && equal(claimed.path, read.path) &&
          (equal(claimed.state, read.state) || (read.ref.endsWith('/shot') && state.matches(read.ref, read.path, claimed.state)));
      });
    }
    if (has(command, key) && !matches) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
  Object.assign(result.command, copy(command), { intent: result.command.intent });
  return result;
}

// Local capture data, never a wire field. Both values survive the UI port's JSON clone.
export type ClipMoveBasis = { readonly bundle: AuthoredBundle; readonly command: EditCommand };

/** Freeze original reads before preview. Pass the previous local result.bundle for dependent B. */
export function captureClipMove(bundle: AuthoredBundle, select: string): ClipMoveBasis {
  assertFiniteJson(bundle);
  const snapshot = copy(bundle);
  const state = new AuthoredState(snapshot);
  const target = state.entity(select)!;
  const owner = select.slice(0, select.lastIndexOf('/'));
  const current = has(target, 'at') ? number(target.at, 'clip.at') : number(target.at_ms, 'clip.at_ms') / 1000;
  const origin = owner === 'parent' ? 0 : occurrenceStart(state.occurrence(owner));
  const { command } = move(snapshot, { schema_version: 1, op: 'clip.move', version: '1', select,
    args: { on: current + origin }, intent: moveIntent(select) });
  return freezeJson({ bundle: snapshot, command });
}

/** Drop supplies absolute global seconds. No ACK or refreshed document enters this operation. */
export function finishClipMove(basis: unknown, on: number) {
  assertFiniteJson(basis);
  if (!object(basis)) throw new ClipMoveError('incomplete clip move basis');
  const { bundle, command } = basis;
  if (!object(bundle) || !object(command) ||
    !['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created']
      .every((key) => has(command, key))) {
    throw new ClipMoveError('incomplete clip move basis');
  }
  return executeClipMove(bundle as AuthoredBundle, { ...copy(command as EditCommand), args: { on } });
}
