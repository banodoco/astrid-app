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

export { ClipMoveError } from './clipMovePrimitives.ts';
export type { AuthoredBundle } from './clipMovePrimitives.ts';

type ScalarValue = Record<string, JSON>;
type ScalarClear = Array<'hold' | 'asset' | 'transition' | 'elementRef'>;
type ScalarArgs = { values: ScalarValue; clear: ScalarClear };
const MISSING = Symbol('missing');
type RawValue = typeof MISSING | JSON;

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

function timelineDuration(clip: ScalarValue): number {
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
  for (const [key, scale] of [['duration', 1], ['duration_ms', 1000] ] as const) {
    if (clip[key] != null) lengths.push(number(clip[key], key) / scale / speed);
  }
  if (!lengths.length || lengths[0] <= 0 ||
    lengths.some((length) => !Number.isFinite(length) || !close(length, lengths[0]))) {
    throw new ClipMoveError('move needs an unambiguous positive authored duration/window', 'unsupported_timing');
  }
  return lengths[0];
}

function clipStartFrame(clip: ScalarValue, fps: number): number {
  return Math.floor(number(clip.at, 'clip.at') * number(fps, 'fps', true) + 0.5);
}

function clipEndFrame(clip: ScalarValue, fps: number): number {
  const start = clipStartFrame(clip, fps);
  const frames = Math.max(1, Math.floor(timelineDuration(clip) * fps + 0.5));
  return start + frames;
}

function occurrenceStart(row: ScalarValue): number {
  if (row.placement != null && !object(row.placement)) {
    throw new ClipMoveError('occurrence placement must be an object', 'unsupported_map');
  }
  const placement = row.placement as ScalarValue | undefined;
  const start = placement?.start_ms;
  const fallback = row.at_ms;
  if (start != null && fallback != null &&
    !close(number(start, 'placement.start_ms'), number(fallback, 'at_ms'))) {
    throw new ClipMoveError('contradictory occurrence start codecs', 'unsupported_timing');
  }
  return number(start ?? fallback ?? 0, 'occurrence start') / 1000;
}

function target(ctx: MoveRecording, command: EditCommand): string {
  const ref = command.select;
  if (typeof ref !== 'string' || !/^(?:parent|occurrence:[^/]+)\/clip:[^/]+$/.test(ref) || ref.includes('::')) {
    throw new ClipMoveError('clip.set requires a parent or occurrence clip identity');
  }
  const owner = ref.slice(0, ref.lastIndexOf('/'));
  if (ctx.read(ref, ['id']) === undefined) {
    throw new ClipMoveError('scalar target disappeared', 'identity_conflict');
  }
  const pin: ScalarValue = { parent: copy(ctx.state.bundle.base_parent ?? {}) };
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
  const selector = ['asset', 'asset_id', 'media_id', 'object_id']
    .find((key) => has(row, key));
  const selected = selector ? row[selector] : undefined;
  if ((selector === 'asset' || selector === 'asset_id') && typeof selected === 'string') {
    const registry = `${ref.slice(0, ref.lastIndexOf('/'))}/registry`;
    for (const key of ['media_id', 'object_id', 'digest', 'content_digest']) {
      ctx.read(registry, ['assets', selected, key]);
    }
  }
}

function raw(row: ScalarValue, key: string): RawValue {
  return has(row, key) ? row[key] : MISSING;
}

function sameRaw(left: RawValue, right: RawValue): boolean {
  return left === MISSING || right === MISSING ? left === right : equal(left, right);
}

function transitionRevision(value: RawValue): RawValue {
  return object(value) ? raw(value, 'revision') : MISSING;
}

function validateNoReferenceTransition(row: ScalarValue, transition: ScalarValue): void {
  const existing = raw(row, 'transition');
  if (raw(row, 'elementRef') !== MISSING || raw(row, 'element_ref') !== MISSING ||
    !object(existing) || existing.type !== transition.type ||
    !sameRaw(transitionRevision(existing), transitionRevision(transition))) {
    throw new ClipMoveError('transition SET without elementRef requires the existing raw identity');
  }
}

function transitionWithRawParams(row: ScalarValue, transition: ScalarValue): ScalarValue {
  const existing = raw(row, 'transition');
  const next = object(existing) ? copy(existing) : {};
  for (const key of Object.keys(transition)) next[key] = transition[key];

  const existingParams = object(existing) ? raw(existing, 'params') : MISSING;
  const requestedParams = raw(transition, 'params');
  if (requestedParams === MISSING) {
    if (existingParams !== MISSING) next.params = copy(existingParams);
  } else if (requestedParams === null) {
    if ((object(existingParams) && Object.keys(existingParams).length > 0) ||
      (existingParams !== MISSING && existingParams !== null && !object(existingParams))) {
      throw new ClipMoveError('transition params null would remove existing parameters');
    }
    next.params = null;
  } else if (object(requestedParams)) {
    const base = object(existingParams) ? existingParams : {};
    next.params = { ...copy(base), ...copy(requestedParams) };
  }
  return next;
}

function transitionClearPair(ctx: MoveRecording, ref: string): void {
  const references: Array<[string, JSON]> = [];
  for (const key of ['elementRef', 'element_ref']) {
    const state = ctx.state.get(ref, [key]);
    if (state.state === 'present') references.push([key, state.value]);
  }
  if (!references.length) return;

  const transition = ctx.state.get(ref, ['transition']);
  const value = transition.state === 'present' ? transition.value : undefined;
  if (!object(value) || typeof value.type !== 'string') {
    throw new ClipMoveError('transition remove requires a matching transition identity');
  }
  for (const [, selected] of references) {
    if (!object(selected) || selected.kind !== 'transition'
      || selected.id !== value.type || !sameRaw(transitionRevision(selected), transitionRevision(value))) {
      throw new ClipMoveError('transition remove refuses a mismatched element reference');
    }
  }
}

function changes(command: EditCommand): ScalarArgs {
  if (!object(command.args) || !has(command.args, 'values') || !has(command.args, 'clear') ||
    !equal(Object.keys(command.args).sort(), ['clear', 'values'])) {
    throw new ClipMoveError('clip.set requires only values and clear arguments');
  }
  const values = command.args.values;
  const clear = command.args.clear;
  if (!object(values) || !Array.isArray(clear) || (!Object.keys(values).length && !clear.length)) {
    throw new ClipMoveError('clip.set requires at least one requested field');
  }
  if (Object.keys(values).some((key) => key !== 'hold' && key !== 'transition' && key !== 'elementRef')) {
    throw new ClipMoveError('clip.set only supports hold, transition, and elementRef values');
  }
  if (clear.some((key) => key !== 'hold' && key !== 'asset' && key !== 'transition' && key !== 'elementRef') ||
    new Set(clear).size !== clear.length) {
    throw new ClipMoveError('clip.set clear contains an unsupported or repeated field');
  }
  if (Object.keys(values).some((key) => clear.includes(key as ScalarClear[number]))) {
    throw new ClipMoveError('a scalar key cannot be both set and cleared');
  }
  if (has(values, 'hold')) number(values.hold, 'hold', true);
  if (has(values, 'transition')) validateTransition(values.transition);
  if (has(values, 'elementRef')) validateTransitionRef(values.elementRef);
  return { values: values as ScalarValue, clear: clear as ScalarClear };
}

function validateTransitionRef(value: JSON): void {
  if (!object(value) || !equal(Object.keys(value).sort(), ['id', 'kind', 'revision', ...(has(value, 'packId') ? ['packId'] : [])].sort())
    || value.kind !== 'transition' || typeof value.id !== 'string' || !value.id
    || typeof value.revision !== 'string' || !value.revision
    || (has(value, 'packId') && (typeof value.packId !== 'string' || !value.packId))) {
    throw new ClipMoveError('transition requires an exact selected element reference');
  }
}

function validateTransition(value: JSON): asserts value is ScalarValue {
  if (!object(value) || typeof value.type !== 'string' || !value.type
    || typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0
    || (has(value, 'params') && value.params !== null && !object(value.params))) {
    throw new ClipMoveError('transition requires a non-empty type, positive duration, and object or null params');
  }
  if (['id', 'durationFrames', 'align', 'incomingPolicy'].some((key) => has(value, key))) {
    throw new ClipMoveError('transition contains a compiled-only field');
  }
  assertFiniteJson(value);
}

function authoredStart(row: ScalarValue): number {
  if (has(row, 'at')) return number(row.at, 'clip.at');
  if (has(row, 'at_ms')) return number(row.at_ms, 'clip.at_ms') / 1000;
  throw new ClipMoveError('transition requires explicit clip starts', 'unsupported_timing');
}

function transitionPredecessor(ctx: MoveRecording, ref: string, duration: number): void {
  const owner = ref.slice(0, ref.lastIndexOf('/'));
  const targetRow = ctx.state.entity(ref);
  if (!targetRow || typeof targetRow.track !== 'string' || !targetRow.track) {
    throw new ClipMoveError('transition requires an owning track');
  }
  const config = ctx.state.config(owner);
  const clips = Array.isArray(config.clips) ? config.clips.filter(object) : [];
  const ordered = clips
    .filter((row) => row.track === targetRow.track && typeof row.id === 'string')
    .map((row, index) => ({ row, index, ref: `${owner}/clip:${row.id}` }))
    .sort((left, right) => authoredStart(left.row) - authoredStart(right.row) || left.index - right.index);
  const targetIndex = ordered.findIndex((item) => item.ref === ref);
  if (targetIndex <= 0) throw new ClipMoveError('transition requires an adjacent predecessor on the same track');
  const predecessor = ordered[targetIndex - 1]!;
  const selection = {
    key: 'transition.predecessor', query_version: 1, owner: ref,
    members: [predecessor.ref], order: ordered.map((item) => item.ref),
    boundaries: [`${owner}/track:${targetRow.track}`], policy: 'guard-membership' as const,
  };
  if (!ctx.command.selections!.some((existing) => equal(existing, selection))) ctx.command.selections!.push(selection);

  for (const neighbor of [predecessor.ref, ref]) {
    for (const key of CLIP_FIELDS) ctx.read(neighbor, [key]);
    ctx.read(neighbor, ['transition']);
    clipBasis(ctx, neighbor);
    for (const prefix of [[], ['app'], ['app', 'astrid']]) {
      for (const key of RELATIONS) ctx.read(neighbor, [...prefix, key]);
    }
  }
  ctx.read(`${owner}/track:${targetRow.track}`, ['id']);
  const fps = rate(ctx.read('parent', ['config', 'output', 'fps']));
  const fpsNumber = fractionNumber(fps[0], fps[1]);
  const frames = duration * fpsNumber;
  if (!Number.isFinite(frames) || frames < 0.5 || frames >= 2 ** 53 - 0.5) {
    throw new ClipMoveError('transition requires positive safe whole frames', 'unsupported_timing');
  }
  const predecessorDuration = timelineDuration(predecessor.row);
  const targetDuration = timelineDuration(targetRow);
  if (Math.abs(authoredStart(predecessor.row) + predecessorDuration - authoredStart(targetRow)) >= 0.001) {
    throw new ClipMoveError('transition requires adjacent clips on the same track');
  }
  if (frames > Math.min(predecessorDuration, targetDuration) * fpsNumber + 0.0001) {
    throw new ClipMoveError('transition duration exceeds the shorter adjacent clip');
  }
}

function holdExtent(ctx: MoveRecording, ref: string, values: ScalarValue, clear: ScalarClear): void {
  const owner = ref.slice(0, ref.lastIndexOf('/'));
  for (const key of CLIP_FIELDS) ctx.read(ref, [key]);
  const row = copy(ctx.state.entity(ref)!);
  for (const key of ['time_map', 'timeMap', 'clips', 'children', 'from_ms', 'to_ms']) {
    if (row[key] != null) throw new ClipMoveError(`clip.set does not support ${key}`, 'unsupported_timing');
  }
  for (const prefix of [[], ['app'], ['app', 'astrid']]) {
    for (const key of RELATIONS) {
      const value = ctx.read(ref, [...prefix, key]);
      if (value != null && key !== 'fixed_start') {
        throw new ClipMoveError(`clip.set hold does not support ${key}`, 'unsupported_timing');
      }
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
  if (owner === 'parent') return;
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
}

function setClip(bundle: AuthoredBundle, command: EditCommand) {
  if (command.schema_version !== 1 || command.op !== 'clip.set' || command.version !== '1') {
    throw new ClipMoveError('unsupported clip.set v1 command');
  }
  if (command.intent !== undefined && !equal(command.intent, {})) {
    throw new ClipMoveError('unsupported clip.set v1 intention');
  }
  const ctx = new MoveRecording(bundle, { ...command, intent: {} });
  const ref = target(ctx, command);
  const { values, clear } = changes(command);
  clipBasis(ctx, ref);
  if (clear.includes('elementRef')) {
    if (!clear.includes('transition')) {
      throw new ClipMoveError('elementRef clear requires transition clear');
    }
    transitionClearPair(ctx, ref);
  }
  const row = ctx.state.entity(ref)!;
  if (has(values, 'elementRef') && !has(values, 'transition')) {
    throw new ClipMoveError('elementRef requires transition SET');
  }
  if (has(values, 'transition')) {
    const transition = values.transition as ScalarValue;
    if (has(values, 'elementRef')) {
      const selected = values.elementRef;
      validateTransitionRef(selected);
      const selectedRef = selected as ScalarValue;
      if (selectedRef.id !== transition.type ||
        !sameRaw(transitionRevision(selectedRef), transitionRevision(transition))) {
        throw new ClipMoveError('transition requires its matching selected reference');
      }
    } else {
      validateNoReferenceTransition(row, transition);
    }
    transitionPredecessor(ctx, ref, number(transition.duration, 'transition.duration', true));
  }
  if (clear.includes('asset') && ['asset_id', 'media_id', 'object_id'].some((key) => has(row, key))) {
    throw new ClipMoveError('asset clear cannot expose another media selector', 'invalid_edit_command');
  }
  const asset = has(row, 'asset') ? row.asset : row.asset_id;
  if (typeof asset === 'string') {
    ctx.read(`${ref.slice(0, ref.lastIndexOf('/'))}/registry`, ['assets', asset, 'content_sha256']);
  }
  if (has(values, 'hold') || clear.includes('hold')) holdExtent(ctx, ref, values, clear);
  for (const key of Object.keys(values).sort()) {
    const value = key === 'transition'
      ? transitionWithRawParams(row, values[key] as ScalarValue)
      : values[key];
    ctx.write(ref, [key], value);
  }
  if (has(values, 'elementRef') && has(row, 'element_ref')) ctx.clear(ref, ['element_ref']);
  for (const key of [...clear].sort()) {
    ctx.clear(ref, [key]);
    if (key === 'elementRef' && has(row, 'element_ref')) ctx.clear(ref, ['element_ref']);
  }
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

export type ClipSetResult = ReturnType<typeof setClip>;

/** Local authored execution only; Runtime/Agent remains the acceptance authority. */
export function executeClipSet(bundle: AuthoredBundle, command: EditCommand, ordinal = 0): ClipSetResult {
  assertFiniteJson(bundle);
  assertFiniteJson(command);
  const result = setClip(bundle, command);
  verifyCapturedFields(bundle, command, result.command);
  result.record.ordinal = ordinal;
  result.record.derived_writes.forEach((write) => { write.cause = ordinal; });
  Object.assign(result.command, copy(command), { intent: result.command.intent });
  return result;
}

export type ClipSetBatchResult = {
  bundle: AuthoredBundle;
  commands: EditCommand[];
  records: ClipSetResult['record'][];
};

export function executeClipSetBatch(bundle: AuthoredBundle, commands: EditCommand[]): ClipSetBatchResult {
  let current = copy(bundle);
  const output: ClipSetBatchResult = { bundle: current, commands: [], records: [] };
  commands.forEach((command, ordinal) => {
    const result = executeClipSet(current, command, ordinal);
    current = result.bundle;
    output.commands.push(result.command);
    output.records.push(result.record);
  });
  output.bundle = current;
  return output;
}

/** Capture original raw claims on the supplied authored bundle. */
export function captureClipSet(
  bundle: AuthoredBundle,
  select: string,
  options: { values?: ScalarValue; clear?: ScalarClear } = {},
): EditCommand {
  assertFiniteJson(bundle);
  const values = copy(options.values ?? {});
  const clear = [...(options.clear ?? [])];
  const snapshot = copy(bundle);
  const command: EditCommand = {
    schema_version: 1,
    op: 'clip.set',
    version: '1',
    select,
    args: { values, clear },
    intent: {},
  };
  return freezeJson(executeClipSet(snapshot, command).command);
}

/** Explicit removal helper; media assignment stays on occurrence.swap-media. */
export function captureClipClear(
  bundle: AuthoredBundle,
  select: string,
  field: 'hold' | 'asset' | 'transition',
): EditCommand {
  return captureClipSet(bundle, select, { clear: [field] });
}
