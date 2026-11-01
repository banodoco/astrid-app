import type { AgentState, CommandRecord, EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelinePatch, TimelinePatchOperation } from '@/sdk/video/timeline/patch.ts';
import { assembleTimelineData, type TimelineData } from '../lib/timeline-data.ts';
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

type Row = Record<string, JSON>;
const CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;
const CLIP_ADD_RELATIONS = ['on', 'fixed_start', 'until', 'until_film_end', 'for', 'cut', 'sequence',
  'sequence_index', 'sequence_fit', 'orphan', 'formulas'];
const DELETE_RELATIONS = ['on', 'until', 'until_film_end', 'cut', 'formulas', 'sequence', 'sequence_index',
  'sequence_fit', 'sequence_shape_from', 'segment', 'words', 'beats', 'slot', 'replaces', 'standin',
  'standin_for', 'intended', 'group', 'duck'];

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('/') && !value.includes('::');
}

function present(value: JSON): AgentState {
  return { state: 'present', value: copy(value) };
}

function tagged(container: unknown, key: string): AgentState {
  if (!object(container) || !has(container, key)) return { state: 'absent' };
  const value = container[key];
  return { state: 'present', value: Array.isArray(value) ? [] : object(value) ? {} : copy(value) };
}

function claimsMatch(command: EditCommand, actual: EditCommand): void {
  for (const key of CLAIMS) {
    if (has(command, key) && !equal(command[key], actual[key])) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
}

function trackCreate(bundle: AuthoredBundle, supplied: EditCommand) {
  if (supplied.schema_version !== 1 || supplied.op !== 'track.create' || supplied.version !== '1' ||
    supplied.select !== 'parent' || !equal(supplied.intent ?? {}, {}) || !object(supplied.args) ||
    !equal(Object.keys(supplied.args), ['row']) || !object(supplied.args.row)) {
    throw new ClipMoveError('track.create requires the parent owner and a row');
  }
  const row = supplied.args.row;
  if (!identity(row.id) || typeof row.kind !== 'string' || !row.kind) {
    throw new ClipMoveError('track.create requires a stable id and kind');
  }
  if (!object(bundle.parent) || !object(bundle.parent.config) || !Array.isArray(bundle.parent.config.tracks)) {
    throw new ClipMoveError('track.create requires an authored parent track collection', 'identity_conflict');
  }

  const ctx = new MoveRecording(bundle, { ...copy(supplied), intent: {} });
  ctx.command.resolved = [];
  const tracks = ctx.state.config('parent').tracks as JSON[];
  const members: string[] = [];
  for (const track of tracks) {
    if (!object(track) || !identity(track.id) || members.includes(`parent/track:${track.id}`)) {
      throw new ClipMoveError('missing or ambiguous parent track identity', 'identity_conflict');
    }
    members.push(`parent/track:${track.id}`);
  }
  ctx.command.selections!.push({ key: 'track.create', query_version: 1, owner: 'parent', members: [...members],
    order: [...members], boundaries: [...members], policy: 'guard-membership' });

  const ref = `parent/track:${row.id}`;
  const before = ctx.read(ref, []);
  if (before !== undefined) throw new ClipMoveError('created identity is occupied', 'identity_conflict');
  const absent: AgentState = { state: 'absent' };
  const after: AgentState = { state: 'present', value: copy(row) };
  ctx.command.expect![`${ref}::`] = absent;
  ctx.command.authorship![`${ref}::`] = 'direct';
  ctx.record.writes.push({ ref, path: [], before: absent, after });
  tracks.push(copy(row));
  ctx.command.created!.push(ref);
  ctx.record.created.push({ ref, kind: 'track', owner: 'parent' });
  claimsMatch(supplied, ctx.command);
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function validateClipAdd(command: EditCommand): Row {
  const allowed = ['schema_version', 'op', 'version', 'select', 'args', 'intent', 'rationale', 'group_id', ...CLAIMS];
  if (Object.keys(command).some((key) => !allowed.includes(key)) ||
    (has(command, 'rationale') && typeof command.rationale !== 'string') ||
    (has(command, 'group_id') && (typeof command.group_id !== 'string' || !command.group_id)) ||
    command.schema_version !== 1 || command.op !== 'clip.add' || command.version !== '1' ||
    command.select !== 'parent' || !object(command.args) || !equal(Object.keys(command.args), ['row']) ||
    !object(command.args.row) || (command.intent !== undefined && !equal(command.intent, {}))) {
    throw new ClipMoveError('clip.add requires the closed parent-owned command envelope');
  }
  const row = command.args.row;
  if (!identity(row.id) || !identity(row.track) || typeof row.clipType !== 'string' || !row.clipType ||
    typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at < 0 ||
    typeof row.hold !== 'number' || !Number.isFinite(row.hold) || row.hold <= 0) {
    throw new ClipMoveError('clip.add requires explicit stable id, track, clipType and literal at/hold seconds');
  }
  if (['media', 'image', 'video', 'audio'].includes(row.clipType.toLowerCase()) ||
    ['asset', 'asset_id', 'media_id', 'object_id'].some((key) => has(row, key))) {
    throw new ClipMoveError('clip.add does not support media clips or selectors', 'unsupported_media');
  }
  for (const key of ['sourceURL', 'sourceUrl', 'source_url', 'src', 'source_uuid', 'source',
    'from', 'to', 'from_ms', 'to_ms', 'at_ms', 'duration', 'duration_ms', 'time_map', 'timeMap',
    'clips', 'children', 'clip_type', 'anchor']) {
    if (row[key] != null) throw new ClipMoveError(`clip.add does not support ${key}`, 'unsupported_timing');
  }
  if (row.speed != null && row.speed !== 1) throw new ClipMoveError('clip.add requires literal hold timing', 'unsupported_timing');
  const app = row.app;
  if (app != null && !object(app)) throw new ClipMoveError('clip.add intent container must be object or null');
  const nested = object(app) ? app.astrid : undefined;
  if (nested != null && !object(nested)) throw new ClipMoveError('clip.add intent container must be object or null');
  for (const container of [row, app, nested]) {
    if (object(container) && [...CLIP_ADD_RELATIONS, 'anchor', 'standin', 'standin_intent']
      .some((key) => container[key] != null)) {
      throw new ClipMoveError('clip.add requires literal child timing', 'unsupported_timing');
    }
  }
  return row;
}

function clipAdd(bundle: AuthoredBundle, supplied: EditCommand) {
  const row = validateClipAdd(supplied);
  const ctx = new MoveRecording(bundle, { ...copy(supplied), intent: {} });
  ctx.command.resolved = [];
  const trackRef = `parent/track:${row.track}`;
  for (const key of ['id', 'kind', 'role', 'enabled', 'active', 'disabled', 'hidden', 'deleted']) {
    ctx.read(trackRef, [key]);
  }
  const track = ctx.state.entity(trackRef, true);
  if (!track) throw new ClipMoveError('clip.add destination track is missing', 'identity_conflict');
  if ((track.kind !== 'visual' && track.kind !== 'audio') || (has(track, 'role') && track.role !== 'output') ||
    track.enabled === false || track.active === false || ['disabled', 'hidden', 'deleted'].some((key) => track[key] === true)) {
    throw new ClipMoveError('clip.add requires an active output track');
  }
  ctx.bind('add.track', trackRef);

  const parent = ctx.state.bundle.parent;
  const config = ctx.state.config('parent');
  if (!object(config)) throw new ClipMoveError('collection owner must be an object', 'identity_conflict');
  const direct = parent.clips;
  const mirror = config.clips;
  if (Array.isArray(direct) && Array.isArray(mirror) && !equal(direct, mirror)) {
    throw new ClipMoveError('divergent parent clip mirrors', 'identity_conflict');
  }
  const rows = Array.isArray(direct) && (direct.length > 0 || !Array.isArray(mirror) || mirror.length === 0)
    ? direct : Array.isArray(mirror) ? mirror : [];
  if (!Array.isArray(direct) && !Array.isArray(mirror)) {
    throw new ClipMoveError('structural edit requires an authored entity collection', 'identity_conflict');
  }
  const ids = rows.map((item) => object(item) ? item.id : undefined);
  if (ids.some((id) => !identity(id)) || new Set(ids).size !== ids.length) {
    throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
  }
  const members = ids.map((id) => `parent/clip:${id}`);
  ctx.command.reads!.push({ ref: 'parent/collection:clip', path: [], state: { state: 'present', value: {
    members: tagged(config, 'clips'), config: tagged(parent, 'config'), payload_members: tagged(parent, 'clips'),
  } } });
  ctx.command.selections!.push({ key: 'collection.clips', query_version: 1, owner: 'parent', members: [...members],
    order: [...members], boundaries: [...members], policy: 'guard-membership' });

  const ref = `parent/clip:${row.id}`;
  if (members.includes(ref)) throw new ClipMoveError('created identity is occupied', 'identity_collision');
  const absent: AgentState = { state: 'absent' };
  const after: AgentState = { state: 'present', value: copy(row) };
  ctx.read(ref, []);
  ctx.command.expect![`${ref}::`] = absent;
  ctx.command.authorship![`${ref}::`] = 'direct';
  ctx.record.writes.push({ ref, path: [], before: absent, after });
  ctx.record.created.push({ ref, kind: 'clip', owner: 'parent' });
  ctx.command.created!.push(ref);
  rows.push(copy(row));
  if (Array.isArray(direct) && Array.isArray(mirror)) {
    const before = ctx.state.get('parent', ['config', 'clips']);
    const mirrorAfter: AgentState = { state: 'present', value: copy(direct) };
    if (!equal(before, mirrorAfter)) {
      ctx.record.derived_writes.push({ ref: 'parent', path: ['config', 'clips'], before, after: mirrorAfter, cause: 0 });
      ctx.state.set('parent', ['config', 'clips'], mirrorAfter);
    }
  }
  ctx.compile();
  claimsMatch(supplied, ctx.command);
  Object.assign(ctx.command, copy(supplied), { intent: {} });
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function collectionRows(state: AuthoredState, owner: string, kind: 'clip' | 'occurrence'): Row[] {
  if (kind === 'occurrence') {
    if (!Array.isArray(state.bundle.placements)) throw new ClipMoveError('invalid occurrence collection', 'identity_conflict');
    return state.bundle.placements as Row[];
  }
  const config = owner === 'parent' && has(state.bundle.parent, 'config')
    ? state.bundle.parent.config : state.config(owner);
  if (!object(config)) throw new ClipMoveError('collection owner must be an object', 'identity_conflict');
  if (owner === 'parent') {
    const payload = state.bundle.parent.clips;
    const mirror = config.clips;
    if (Array.isArray(payload) && Array.isArray(mirror) && !equal(payload, mirror)) {
      throw new ClipMoveError('divergent parent clip mirrors', 'identity_conflict');
    }
    if (Array.isArray(payload) && (payload.length > 0 || !Array.isArray(mirror) || mirror.length === 0)) {
      return payload as Row[];
    }
  }
  if (!Array.isArray(config.clips)) throw new ClipMoveError('structural edit requires an authored entity collection', 'identity_conflict');
  return config.clips as Row[];
}

function identityRows(state: AuthoredState, owner: string, kind: 'clip' | 'occurrence'): string[] {
  const rows = collectionRows(state, owner, kind);
  if (!rows.every(object)) throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
  const key = kind === 'clip' ? 'id' : 'occurrence_id';
  const refs = rows.map((row) => {
    const id = row[key];
    if (!identity(id)) throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
    return kind === 'clip' ? `${owner}/clip:${id}` : `occurrence:${id}`;
  });
  if (new Set(refs).size !== refs.length) throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
  return refs;
}

function readCollection(ctx: MoveRecording, owner: string, kind: 'clip' | 'occurrence'): void {
  const ref = `${owner}/collection:${kind}`;
  const state: AgentState = kind === 'occurrence'
    ? present({ container: 'array' })
    : (() => {
      const config = ctx.state.config(owner);
      const result: Record<string, AgentState> = { members: tagged(config, 'clips') };
      if (owner === 'parent') {
        result.config = tagged(ctx.state.bundle.parent, 'config');
        result.payload_members = tagged(ctx.state.bundle.parent, 'clips');
      }
      return present(result);
    })();
  const read = { ref, path: [], state };
  if (!ctx.command.reads!.some((other) => equal(other, read))) ctx.command.reads!.push(read);
}

function selectCollection(ctx: MoveRecording, owner: string, kind: 'clip' | 'occurrence'): string[] {
  readCollection(ctx, owner, kind);
  const members = identityRows(ctx.state, owner, kind);
  const selection = { key: `collection.${kind}s`, query_version: 1, owner, members: [...members], order: [...members],
    boundaries: [...members], policy: 'guard-membership' as const };
  if (!ctx.command.selections!.some((other) => equal(other, selection))) ctx.command.selections!.push(selection);
  if (owner !== 'parent') {
    ctx.read(owner, ['occurrence_id']);
    ctx.read(`${owner}/shot`, ['shot_id']);
    ctx.bind(`collection.owner:collection.${kind}s`, owner);
  }
  return members;
}

function unrelated(ctx: MoveRecording, ref: string, prefixes: string[][], keys: string[]): void {
  for (const prefix of prefixes) {
    for (const key of keys) {
      const value = ctx.read(ref, [...prefix, key]);
      if (value !== undefined && value !== null && value !== '' && !equal(value, {}) && !equal(value, [])) {
        throw new ClipMoveError('clip.delete cannot prove declared semantic dependencies safe', 'unsupported_dependency');
      }
    }
  }
}

function removeRoot(ctx: MoveRecording, ref: string): void {
  const before = ctx.state.get(ref, []);
  if (before.state !== 'present') throw new ClipMoveError('delete target disappeared', 'identity_conflict');
  ctx.command.expect![`${ref}::`] = before;
  ctx.command.authorship![`${ref}::`] = 'direct';
  ctx.record.writes.push({ ref, path: [], before, after: { state: 'absent' } });
  const owner = ref.slice(0, ref.lastIndexOf('/'));
  const id = ref.slice('parent/clip:'.length);
  const rows = collectionRows(ctx.state, owner, 'clip');
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) throw new ClipMoveError('delete target disappeared', 'identity_conflict');
  rows.splice(index, 1);
}

function clipDelete(bundle: AuthoredBundle, supplied: EditCommand) {
  const allowed = new Set(['schema_version', 'op', 'version', 'select', 'args', 'intent', 'rationale', 'group_id', ...CLAIMS]);
  if (Object.keys(supplied).some((key) => !allowed.has(key))
    || (has(supplied, 'rationale') && typeof supplied.rationale !== 'string')
    || (has(supplied, 'group_id') && (typeof supplied.group_id !== 'string' || !supplied.group_id))) {
    throw new ClipMoveError('clip.delete requires the closed EditCommand envelope');
  }
  if (typeof supplied.select !== 'string' || !/^parent\/clip:(?!.*::)[^/]+$/.test(supplied.select)) {
    throw new ClipMoveError('clip.delete v1 requires one parent clip identity', 'unsupported_ownership');
  }
  if (supplied.schema_version !== 1 || supplied.op !== 'clip.delete' || supplied.version !== '1' ||
    !object(supplied.args) || Object.keys(supplied.args).length !== 0 ||
    (has(supplied, 'intent') && !equal(supplied.intent, {}))) {
    throw new ClipMoveError('unsupported clip.delete v1 command');
  }
  const ref = supplied.select;
  const ctx = new MoveRecording(bundle, { ...copy(supplied), intent: {} });
  const members = selectCollection(ctx, 'parent', 'clip');
  if (!members.includes(ref)) throw new ClipMoveError('delete target disappeared', 'identity_conflict');
  ctx.read(ref, []);
  const row = ctx.state.entity(ref);
  if (!row) throw new ClipMoveError('delete target disappeared', 'identity_conflict');
  if (row.clipType === 'shot' || row.clip_type === 'shot') {
    throw new ClipMoveError('clip.delete cannot remove legacy shot ownership', 'unsupported_ownership');
  }
  if ((has(row, 'clips') && row.clips !== null) || (has(row, 'children') && row.children !== null)) {
    throw new ClipMoveError('clip.delete cannot remove nested clip ownership', 'unsupported_ownership');
  }

  const owners = ['parent', ...selectCollection(ctx, 'parent', 'occurrence')];
  for (const owner of owners) {
    const configRef = owner === 'parent' ? 'parent' : `${owner}/source`;
    const prefix = owner === 'parent' ? ['config'] : [];
    unrelated(ctx, configRef, [prefix], ['pinnedShotGroups']);
    unrelated(ctx, configRef, [prefix, [...prefix, 'app'], [...prefix, 'app', 'astrid']],
      ['sequences', 'formulas', 'slots']);
    for (const member of selectCollection(ctx, owner, 'clip')) {
      unrelated(ctx, member, [[]], ['transition']);
      unrelated(ctx, member, [['app'], ['app', 'astrid']], DELETE_RELATIONS);
    }
  }
  removeRoot(ctx, ref);
  ctx.compile();
  const parent = ctx.state.bundle.parent;
  const config = ctx.state.config('parent');
  if (Array.isArray(parent.clips) && parent.clips.length === 0 && Array.isArray(config.clips) && config.clips.length > 0) {
    const mirrorBefore = ctx.state.get('parent', ['config', 'clips']);
    const mirrorAfter: AgentState = { state: 'present', value: [] };
    ctx.record.derived_writes.push({ ref: 'parent', path: ['config', 'clips'], before: mirrorBefore, after: mirrorAfter, cause: 0 });
    ctx.state.set('parent', ['config', 'clips'], mirrorAfter);
  }
  claimsMatch(supplied, ctx.command);
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function commandFor(operation: TimelinePatchOperation): EditCommand {
  if (!identity(operation.target)) throw new ClipMoveError(`${operation.op} requires a stable target identity`);
  if (operation.op === 'clip.remove') {
    if (Object.keys(operation.payload ?? {}).length) throw new ClipMoveError('clip.remove does not accept a payload');
    return { schema_version: 1, op: 'clip.delete', version: '1', select: `parent/clip:${operation.target}`,
      args: {}, intent: {} };
  }
  if (!object(operation.payload)) throw new ClipMoveError(`${operation.op} requires an object payload`);
  if (operation.op === 'track.add') {
    if (has(operation.payload, 'id') && operation.payload.id !== operation.target) {
      throw new ClipMoveError('track.add target and row id differ', 'identity_conflict');
    }
    return { schema_version: 1, op: 'track.create', version: '1', select: 'parent',
      args: { row: { ...copy(operation.payload) as Row, id: operation.target } }, intent: {} };
  }
  if (operation.op === 'clip.add') {
    if (has(operation.payload, 'id') && operation.payload.id !== operation.target) {
      throw new ClipMoveError('clip.add target and row id differ', 'identity_conflict');
    }
    return { schema_version: 1, op: 'clip.add', version: '1', select: 'parent',
      args: { row: { ...copy(operation.payload) as Row, id: operation.target } }, intent: {} };
  }
  throw new ClipMoveError('unsupported ordinary structural operation');
}

function executeOne(bundle: AuthoredBundle, command: EditCommand) {
  if (command.op === 'track.create') return trackCreate(bundle, command);
  if (command.op === 'clip.add') return clipAdd(bundle, command);
  if (command.op === 'clip.delete') return clipDelete(bundle, command);
  throw new ClipMoveError(`unsupported native structural command ${command.op}`);
}

export class OrdinaryStructuralRefusal extends Error {}

function supported(operation: TimelinePatchOperation): boolean {
  if (!['track.add', 'clip.add', 'clip.remove'].includes(operation.op) || !identity(operation.target)) return false;
  return operation.op === 'clip.remove'
    ? operation.payload === undefined || (object(operation.payload) && Object.keys(operation.payload).length === 0)
    : object(operation.payload);
}

/** Captures one atomic structural batch; track birth and its clip consumers stay in one command array. */
export function captureOrdinaryStructuralBatch(bundle: AuthoredBundle, patch: TimelinePatch) {
  assertFiniteJson(bundle);
  assertFiniteJson(patch);
  if (!Number.isSafeInteger(patch.version) || patch.version < 0 || !patch.operations.length) {
    throw new OrdinaryStructuralRefusal('Native structural patch requires operations and a non-negative version');
  }
  const original = freezeJson(copy(patch));
  if (original.operations.some((operation) => !supported(operation))) {
    throw new OrdinaryStructuralRefusal('Native structural patch refuses unsupported or mixed members atomically');
  }
  const ordered = original.operations.map((operation, index) => ({ operation, index })).sort((a, b) => {
    if (a.operation.order === undefined) return b.operation.order === undefined ? a.index - b.index : 1;
    if (b.operation.order === undefined) return -1;
    return a.operation.order - b.operation.order || a.index - b.index;
  });
  let after = copy(bundle);
  const commands: EditCommand[] = [];
  const records: CommandRecord[] = [];
  try {
    for (const { operation } of ordered) {
      const result = executeOne(after, commandFor(operation));
      result.record.ordinal = commands.length;
      result.record.derived_writes.forEach((write) => { write.cause = commands.length; });
      after = result.bundle;
      commands.push(result.command);
      records.push(result.record);
    }
  } catch (error) {
    throw new OrdinaryStructuralRefusal(error instanceof Error ? error.message : String(error));
  }
  const preview: TimelinePatch = { version: original.version, source: 'timeline.native-structural',
    operations: ordered.map(({ operation }) => ({ ...operation, payload: operation.payload ? copy(operation.payload) : undefined })) };
  return freezeJson({ patch: original, commands, records, bundle: after, preview });
}

export function executeOrdinaryStructuralBatch(bundle: AuthoredBundle, commands: readonly EditCommand[]) {
  let after = copy(bundle);
  const records: CommandRecord[] = [];
  for (const [ordinal, command] of commands.entries()) {
    const result = executeOne(after, command);
    result.record.ordinal = ordinal;
    result.record.derived_writes.forEach((write) => { write.cause = ordinal; });
    after = result.bundle;
    records.push(result.record);
  }
  return { bundle: after, records };
}

/** Structural projection only updates the two authored collections and preserves all other display data. */
export function projectOrdinaryStructuralPreview(patch: TimelinePatch, current: TimelineData): TimelineData {
  if (patch.source !== 'timeline.native-structural') throw new Error('Invalid native structural patch preview');
  const config = copy(current.config);
  const resolvedConfig = copy(current.resolvedConfig);
  for (const operation of patch.operations) {
    for (const target of [config, resolvedConfig]) {
      if (operation.op === 'track.add') {
        target.tracks ??= [];
        target.tracks.push(Object.assign(
          { id: operation.target, kind: 'visual', label: '' } satisfies NonNullable<TimelineData['config']['tracks']>[number],
          copy(operation.payload ?? {}),
        ));
      } else if (operation.op === 'clip.add') {
        target.clips ??= [];
        target.clips.push(Object.assign(
          { id: operation.target, at: 0, track: '' } satisfies TimelineData['config']['clips'][number],
          copy(operation.payload ?? {}),
        ));
      } else if (operation.op === 'clip.remove') {
        target.clips = (target.clips ?? []).filter((row) => row.id !== operation.target);
      }
    }
  }
  return { ...current, ...assembleTimelineData({ ...current, config, resolvedConfig }), dataLanes: current.dataLanes };
}
