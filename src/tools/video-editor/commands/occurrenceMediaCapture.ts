import type {
  AgentSelection, AgentState, EditCommand, JSON, MediaSelection, VerifiedMedia,
} from '@/integrations/runtime/timeline-commit-types.ts';
import {
  assertFiniteJson, ClipMoveError, copy, equal, freezeJson, has, MoveRecording, object,
} from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

type ObjectValue = { [key: string]: JSON };
type Row = ObjectValue;
type OccurrenceMediaBasis = {
  readonly bundle: AuthoredBundle;
  readonly command: EditCommand;
  readonly verifiedMedia: readonly VerifiedMedia[];
};

const CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;
const RELATIONS = ['on', 'fixed_start', 'until', 'until_film_end', 'for', 'cut', 'sequence', 'sequence_index',
  'sequence_fit', 'orphan', 'formulas'];
const MAP_FIELDS = [['placement', 'start_ms'], ['at_ms'], ['duration_ms'], ['source_offset'], ['speed'], ['track'],
  ['placement', 'track'], ['time_map'], ['timeMap'], ['enabled'], ['active'], ['disabled'], ['hidden'], ['deleted']];

const active = (row: Row): boolean => row.enabled !== false && row.active !== false
  && !['disabled', 'hidden', 'deleted'].some((key) => row[key] === true);

function rawIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('/') && !value.includes('::');
}

function number(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new ClipMoveError(`${label} requires a finite ${positive ? 'positive ' : ''}number`, 'unsupported_timing');
  }
  return value;
}

function rate(value: JSON | undefined): [bigint, bigint] {
  if (value == null) return [30n, 1n];
  if (object(value) && equal(Object.keys(value).sort(), ['denominator', 'numerator'])) {
    if (!Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)) {
      throw new ClipMoveError('invalid rational fps', 'unsupported_timing');
    }
    const numerator = BigInt(number(value.numerator, 'fps numerator', true));
    const denominator = BigInt(number(value.denominator, 'fps denominator', true));
    let a = numerator, b = denominator;
    while (b) [a, b] = [b, a % b];
    return [numerator / a, denominator / a];
  }
  const [mantissa, exponent = '0'] = String(number(value, 'fps', true)).split('e');
  const scale = (mantissa.split('.')[1]?.length ?? 0) - Number(exponent);
  const numerator = BigInt(mantissa.replace('.', '')) * (scale < 0 ? 10n ** BigInt(-scale) : 1n);
  const denominator = scale > 0 ? 10n ** BigInt(scale) : 1n;
  let a = numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  return [numerator / a, denominator / a];
}

function selectionValue(
  key: string, owner: string, members: string[], boundaries = members,
): AgentSelection {
  return { key, query_version: 1, owner, members: [...members], order: [...members], boundaries: [...boundaries],
    policy: 'guard-membership' };
}

function recordRead(ctx: MoveRecording, ref: string, path: string[], state: AgentState): void {
  const read = { ref, path, state };
  if (!ctx.command.reads!.some((prior) => equal(prior, read))) ctx.command.reads!.push(copy(read));
}

function present(value: JSON): AgentState {
  return { state: 'present', value: copy(value) };
}

function occurrenceStart(row: Row): number {
  const placement = has(row, 'placement') ? row.placement : undefined;
  if (placement !== undefined && !object(placement)) {
    throw new ClipMoveError('occurrence placement must be an object', 'unsupported_map');
  }
  const start = object(placement) && has(placement, 'start_ms') ? placement.start_ms : undefined;
  const fallback = has(row, 'at_ms') ? row.at_ms : undefined;
  if (start != null && fallback != null) {
    const startMs = number(start, 'placement.start_ms');
    const fallbackMs = number(fallback, 'at_ms');
    if (Math.abs(startMs - fallbackMs) > Math.max(1e-9, 1e-9 * Math.max(Math.abs(startMs), Math.abs(fallbackMs)))) {
      throw new ClipMoveError('contradictory occurrence start codecs', 'unsupported_timing');
    }
  }
  return number(start != null ? start : (fallback != null ? fallback : 0), 'occurrence start') / 1000;
}

function collectionShape(ctx: MoveRecording, owner: string, kind: 'clip' | 'track'): AgentState {
  const config = ctx.state.config(owner);
  const key = `${kind}s`;
  if (!Array.isArray(config[key])) throw new ClipMoveError('structural edit requires an authored entity collection', 'identity_conflict');
  return present({ members: present([]) });
}

function rows(ctx: MoveRecording, owner: string, kind: 'clip' | 'track'): Row[] {
  const value = ctx.state.config(owner)[`${kind}s`];
  if (!Array.isArray(value) || value.some((row) => !object(row) || !rawIdentity(row.id))
    || new Set(value.map((row) => object(row) ? row.id : null)).size !== value.length) {
    throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
  }
  return value as Row[];
}

function selectCollection(ctx: MoveRecording, owner: string, kind: 'occurrence' | 'clip' | 'track'): string[] {
  const key = `collection.${kind}s`;
  let members: string[];
  let state: AgentState;
  if (kind === 'occurrence') {
    const placements = ctx.state.bundle.placements;
    if (placements.some((row) => !object(row) || !rawIdentity(row.occurrence_id))
      || new Set(placements.map((row) => object(row) ? row.occurrence_id : null)).size !== placements.length) {
      throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
    }
    members = placements.map((row) => `occurrence:${row.occurrence_id}`);
    state = present({ container: 'array' });
    recordRead(ctx, 'parent/collection:occurrence', [], state);
  } else {
    const values = rows(ctx, owner, kind);
    members = values.map((row) => `${owner}/${kind}:${row.id}`);
    state = collectionShape(ctx, owner, kind);
    recordRead(ctx, `${owner}/collection:${kind}`, [], state);
    recordRead(ctx, owner, ['occurrence_id'], ctx.state.get(owner, ['occurrence_id']));
    recordRead(ctx, `${owner}/shot`, ['shot_id'], ctx.state.get(`${owner}/shot`, ['shot_id']));
  }
  const selection = selectionValue(key, kind === 'occurrence' ? 'parent' : owner, members);
  if (!ctx.command.selections!.some((prior) => equal(prior, selection))) {
    ctx.command.selections!.push(selection);
    if (kind !== 'occurrence') ctx.bind(`collection.owner:${key}`, owner);
  }
  return members;
}

function selectPlacementOwners(ctx: MoveRecording, owner: string): string[] {
  const row = ctx.state.entity(owner);
  if (!row) throw new ClipMoveError('missing occurrence owner', 'identity_conflict');
  const shot = row.shot_id;
  if (!rawIdentity(shot)) throw new ClipMoveError('missing occurrence source identity', 'identity_conflict');
  const members = ctx.state.bundle.placements
    .filter((candidate) => object(candidate) && candidate.shot_id === shot)
    .map((candidate) => `occurrence:${candidate.occurrence_id}`);
  const selection = selectionValue('placement.owners', owner, members, [`shot:${shot}`]);
  if (!ctx.command.selections!.some((prior) => equal(prior, selection))) ctx.command.selections!.push(selection);
  return members;
}

function assetState(ctx: MoveRecording, ref: string): AgentState {
  const split = ref.lastIndexOf('/asset:');
  const owner = ref.slice(0, split), identity = ref.slice(split + '/asset:'.length);
  const registry = ctx.state.config(owner).registry;
  if (!object(registry) || !object(registry.assets)) throw new ClipMoveError('media edit requires an authored asset registry');
  return has(registry.assets, identity) ? present(registry.assets[identity]) : { state: 'absent' };
}

function readAsset(ctx: MoveRecording, ref: string): AgentState {
  const state = assetState(ctx, ref);
  recordRead(ctx, ref, [], state);
  return state;
}

function selectionPin(value: unknown): asserts value is MediaSelection {
  if (!object(value) || !equal(Object.keys(value).sort(), ['asset', 'catalog_digest', 'generation_id', 'object_id', 'variant_id'])
    || !['asset', 'generation_id', 'variant_id'].every((key) => typeof value[key] === 'string' && value[key].length > 0)
    || !['object_id', 'catalog_digest'].every((key) => typeof value[key] === 'string'
      && /^sha256:[0-9a-f]{64}$/.test(value[key] as string))) {
    throw new ClipMoveError('media requires a closed immutable five-field selection');
  }
}

function verified(pin: MediaSelection, inputs: readonly VerifiedMedia[]): { value: VerifiedMedia; kind: 'image' | 'video' } {
  const matches = inputs.filter((input) => equal(input.selection, pin));
  if (!matches.length || matches.some((input) => !equal(input, matches[0]))) {
    throw new ClipMoveError('media edit requires exact Runtime-verified media input', 'dependency_changed');
  }
  const value = matches[0];
  const kind = typeof value.media_type === 'string' && value.media_type.includes('/')
    ? value.media_type.split('/')[0] : '';
  if ((kind !== 'image' && kind !== 'video') || !Number.isInteger(value.size) || value.size <= 0) {
    throw new ClipMoveError('media edit requires verified image/video metadata', 'unsupported_media');
  }
  if (kind === 'video') number(value.duration_seconds, 'intrinsic duration', true);
  return { value, kind };
}

function owner(ctx: MoveRecording, ref: string): { owner: string; limit: number } {
  if (typeof ref !== 'string' || !/^occurrence:(?!.*::)[^/]+$/.test(ref)) {
    throw new ClipMoveError('media edit requires explicit occurrence/raw child ownership');
  }
  selectCollection(ctx, 'parent', 'occurrence');
  ctx.read(ref, ['occurrence_id']);
  ctx.read(`${ref}/shot`, ['shot_id']);
  for (const path of MAP_FIELDS) ctx.read(ref, path);
  const row = ctx.state.occurrence(ref);
  occurrenceStart(row);
  if (!active(row) || typeof row.source_offset === 'boolean' || typeof row.speed === 'boolean'
    || (row.source_offset != null && row.source_offset !== 0)
    || (row.speed != null && row.speed !== 1) || row.time_map != null || row.timeMap != null) {
    throw new ClipMoveError('media edit requires an active translation-only occurrence', 'unsupported_map');
  }
  const limit = number(row.duration_ms, 'occurrence.duration_ms', true) / 1000;
  const fps = rate(ctx.read('parent', ['config', 'output', 'fps']));
  if (!equal(rate(ctx.read(`${ref}/source`, ['output', 'fps'])), fps)) {
    throw new ClipMoveError('parent and child fps differ', 'unsupported_timing');
  }
  if (ctx.read(`${ref}/source`, ['source_window']) != null) {
    throw new ClipMoveError('internal source_window is unsupported', 'unsupported_map');
  }
  ctx.bind('media.owner', ref);
  return { owner: ref, limit };
}

function validateClip(ctx: MoveRecording, ownerRef: string, row: Row, limit: number, kind: 'image' | 'video', input: VerifiedMedia): void {
  if ((row.clipType !== 'media' && row.clipType !== kind) || !rawIdentity(row.asset)) {
    throw new ClipMoveError('media edit requires one matching media clip');
  }
  if (['asset_id', 'media_id', 'object_id', 'clip_type'].some((key) => has(row, key))) {
    throw new ClipMoveError('media edit requires one asset selector');
  }
  for (const key of ['time_map', 'timeMap', 'clips', 'children', 'from_ms', 'to_ms', 'at_ms', 'duration', 'duration_ms',
    'source', 'sourceURL', 'sourceUrl', 'source_url', 'src', 'source_uuid', 'anchor']) {
    if (row[key] != null) throw new ClipMoveError(`media edit does not support ${key}`, 'unsupported_timing');
  }
  if (row.transition != null) throw new ClipMoveError('media edit does not support transition', 'unsupported_timing');
  const app = row.app, nested = object(app) ? app.astrid : null;
  for (const container of [row, app, nested]) {
    if (container != null && !object(container)) throw new ClipMoveError('intent container must be object or null');
    if (object(container) && [...RELATIONS, 'beats', 'word', 'words', 'transcript', 'source_id', 'standin', 'standin_intent']
      .some((key) => container[key] != null)) throw new ClipMoveError('media edit requires literal child timing', 'unsupported_timing');
  }
  const at = number(row.at, 'clip.at');
  const hold = number(row.hold, 'clip.hold', true);
  const speed = number(row.speed == null ? 1 : row.speed, 'clip.speed', true);
  if (at < 0 || at + hold / speed > limit) throw new ClipMoveError('child interval exceeds occurrence', 'occurrence_boundary');
  if (kind === 'image') {
    if (speed !== 1 || row.from != null || row.to != null) {
      throw new ClipMoveError('image requires hold without a source window', 'unsupported_timing');
    }
  } else {
    const left = number(row.from, 'clip.from'), right = number(row.to, 'clip.to');
    if (left < 0 || right <= left || right - left !== hold || right > number(input.duration_seconds, 'intrinsic duration', true)) {
      throw new ClipMoveError('source window differs from hold or exceeds media', 'unsupported_timing');
    }
  }
  const trackRef = `${ownerRef}/track:${row.track}`;
  selectCollection(ctx, ownerRef, 'track');
  const track = ctx.read(trackRef, []);
  if (!object(track) || track.kind !== 'visual' || (has(track, 'role') && track.role !== 'output') || !active(track)) {
    throw new ClipMoveError('media edit requires an active raw visual child track');
  }
  ctx.bind('media.track', trackRef);
}

function createAsset(ctx: MoveRecording, ownerRef: string, identity: string, value: Row): void {
  ctx.read(ownerRef, ['occurrence_id']);
  ctx.read(`${ownerRef}/shot`, ['shot_id']);
  const ref = `${ownerRef}/asset:${identity}`;
  const before = readAsset(ctx, ref);
  if (before.state !== 'absent') throw new ClipMoveError('created identity is occupied', 'identity_collision');
  ctx.command.expect![`${ref}::`] = before;
  ctx.command.authorship![`${ref}::`] = 'direct';
  const after = present(value);
  ctx.record.writes.push({ ref, path: [], before, after });
  ctx.record.created.push({ ref, kind: 'asset', owner: ownerRef });
  ctx.command.created!.push(ref);
  const registry = ctx.state.config(ownerRef).registry as Row;
  (registry.assets as Row)[identity] = copy(value);
}

function createChild(ctx: MoveRecording, ownerRef: string, row: Row): void {
  rows(ctx, ownerRef, 'clip');
  ctx.read(ownerRef, ['occurrence_id']);
  ctx.read(`${ownerRef}/shot`, ['shot_id']);
  ctx.bind('create.owner', ownerRef);
  selectCollection(ctx, ownerRef, 'clip');
  const ref = `${ownerRef}/clip:${row.id}`;
  const before = ctx.read(ref, []);
  if (before !== undefined) throw new ClipMoveError('created identity is occupied', 'identity_collision');
  const absent: AgentState = { state: 'absent' };
  ctx.command.expect![`${ref}::`] = absent;
  ctx.command.authorship![`${ref}::`] = 'direct';
  const after = present(row);
  ctx.record.writes.push({ ref, path: [], before: absent, after });
  ctx.record.created.push({ ref, kind: 'clip', owner: ownerRef });
  ctx.command.created!.push(ref);
  ctx.state.config(ownerRef).clips = [...(ctx.state.config(ownerRef).clips as JSON[]), copy(row)];
}

function registry(ctx: MoveRecording, ownerRef: string, pin: MediaSelection, kind: 'image' | 'video'): void {
  if (!rawIdentity(pin.asset)) throw new ClipMoveError('media requires a reserved raw asset alias');
  const config = ctx.state.config(ownerRef);
  const value = config.registry;
  if (!object(value) || !object(value.assets)) throw new ClipMoveError('media edit requires an authored asset registry');
  const ref = `${ownerRef}/asset:${pin.asset}`;
  const expected = { media_id: pin.object_id, type: kind, generationId: pin.generation_id, variantId: pin.variant_id } as Row;
  const entry = readAsset(ctx, ref);
  if (entry.state === 'absent') createAsset(ctx, ownerRef, pin.asset, expected);
  else if (!equal(entry, present(expected))) throw new ClipMoveError('existing registry binding differs from exact selection', 'dependency_changed');
  ctx.record.dependencies.push({ key: 'media.new', kind: 'media', pin: copy(pin), policy: 'exact' });
}

function validateEnvelope(command: EditCommand): asserts command is EditCommand {
  if (command.schema_version !== 1 || command.op !== 'occurrence.add-media' || command.version !== '1'
    || typeof command.select !== 'string' || !object(command.args)
    || !equal(Object.keys(command.args).sort(), ['media', 'row'])
    || !equal(command.intent, { ownership: 'occurrence' })) {
    throw new ClipMoveError('unsupported occurrence media command');
  }
}

export function executeOccurrenceAddMedia(
  bundle: AuthoredBundle, supplied: EditCommand, inputs: readonly VerifiedMedia[],
) {
  assertFiniteJson(bundle); assertFiniteJson(supplied); assertFiniteJson(inputs);
  if (!Array.isArray(inputs) || inputs.some((input) => !object(input))) {
    throw new ClipMoveError('media capture requires detached verified inputs');
  }
  validateEnvelope(supplied);
  const pin = supplied.args.media;
  selectionPin(pin);
  const ctx = new MoveRecording(bundle, copy(supplied));
  const { owner: ownerRef, limit } = owner(ctx, supplied.select!);
  const placementOwners = selectPlacementOwners(ctx, ownerRef);
  if (placementOwners.length !== 1 || placementOwners[0] !== ownerRef) {
    throw new ClipMoveError('shared authored placement is unsupported', 'unsupported_ownership');
  }
  ctx.read(`${ownerRef}/source`, ['app', 'astrid', 'pool']);
  ctx.read('parent', ['config', 'pinnedShotGroups']);
  selectCollection(ctx, ownerRef, 'clip');
  const row = supplied.args.row;
  if (!object(row) || !rawIdentity(row.id) || !rawIdentity(row.track) || typeof row.clipType !== 'string' || !row.clipType.length) {
    throw new ClipMoveError('add requires a reserved raw child and track');
  }
  const { value, kind } = verified(pin, inputs);
  if (row.asset !== pin.asset) throw new ClipMoveError('child asset must equal the reserved selection alias');
  validateClip(ctx, ownerRef, row, limit, kind, value);
  registry(ctx, ownerRef, pin, kind);
  createChild(ctx, ownerRef, row);
  for (const key of CLAIMS) {
    if (has(supplied, key) && !equal(supplied[key], ctx.command[key])) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

export function captureOccurrenceAddMedia(
  bundle: AuthoredBundle, ownerRef: string, row: Row, media: MediaSelection, inputs: readonly VerifiedMedia[],
): OccurrenceMediaBasis {
  const command: EditCommand = { schema_version: 1, op: 'occurrence.add-media', version: '1', select: ownerRef,
    args: { row: copy(row), media: copy(media) }, intent: { ownership: 'occurrence' } };
  const result = executeOccurrenceAddMedia(bundle, command, inputs);
  return freezeJson({ bundle: copy(bundle), command: result.command, verifiedMedia: copy(inputs) });
}

export function finishOccurrenceAddMedia(basis: unknown) {
  assertFiniteJson(basis);
  if (!object(basis) || !object(basis.bundle) || !object(basis.command) || !Array.isArray(basis.verifiedMedia)) {
    throw new ClipMoveError('incomplete occurrence.add-media basis');
  }
  const command = basis.command;
  if (!CLAIMS.every((key) => has(command, key))) {
    throw new ClipMoveError('incomplete occurrence.add-media basis');
  }
  return executeOccurrenceAddMedia(basis.bundle as AuthoredBundle, command as EditCommand,
    basis.verifiedMedia as VerifiedMedia[]);
}
