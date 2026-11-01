import type { CommandRecord, EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
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

type JsonObject = Record<string, JSON>;

export type ElementOverlayCreateArgs = {
  row: JsonObject;
  track?: JsonObject;
};

export type ElementOverlayBasis = {
  readonly bundle: AuthoredBundle;
  readonly commands: readonly EditCommand[];
};

export type ElementOverlayResult = {
  commands: EditCommand[];
  bundle: AuthoredBundle;
  records: CommandRecord[];
};

const CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;
const RELATIONS = ['on', 'until', 'until_film_end', 'cut', 'formulas', 'sequence', 'sequence_index',
  'sequence_fit', 'sequence_shape_from', 'segment', 'words', 'beats', 'slot', 'replaces', 'standin',
  'standin_for', 'intended', 'group', 'duck'];
const UNSUPPORTED_MEDIA_KEYS = ['asset', 'asset_id', 'media_id', 'object_id'];
const UNSUPPORTED_TIMING_KEYS = ['sourceURL', 'sourceUrl', 'source_url', 'src', 'source_uuid', 'source',
  'from', 'to', 'from_ms', 'to_ms', 'at_ms', 'duration', 'duration_ms', 'time_map', 'timeMap', 'clips',
  'children', 'clip_type', 'anchor'];

function assertParentBundle(bundle: AuthoredBundle): void {
  if (!object(bundle.parent) || !object(bundle.parent.config) || !object(bundle.base_parent)) {
    throw new ClipMoveError('element overlay requires an authored parent source pin');
  }
}

function parentConfig(bundle: AuthoredBundle): JsonObject {
  const config = bundle.parent.config;
  if (!object(config)) throw new ClipMoveError('element overlay requires an authored parent source pin');
  return config;
}

function assertParentSelect(select: unknown, kind: 'clip' | 'track'): asserts select is string {
  if (typeof select !== 'string' || select.includes('::') ||
    !new RegExp(`^parent/${kind}:[^/]+$`).test(select)) {
    throw new ClipMoveError(`element overlay requires a stable parent/${kind} identity`);
  }
}

function presence(value: unknown): { state: 'absent' } | { state: 'present'; value: JSON } {
  return value === undefined ? { state: 'absent' } : { state: 'present', value: copy(value as JSON) };
}

function collectionPresence(value: unknown): { state: 'absent' } | { state: 'present'; value: JSON } {
  if (value === undefined) return { state: 'absent' };
  return { state: 'present', value: Array.isArray(value) ? [] : object(value) ? {} : copy(value as JSON) };
}

function collectionRows(bundle: AuthoredBundle, kind: 'clip' | 'track'): JSON[] {
  const parent = bundle.parent;
  const config = parentConfig(bundle);
  const key = `${kind}s`;
  const direct = parent[key];
  const configured = config[key];
  if (direct !== undefined && !Array.isArray(direct)) throw new ClipMoveError('authored collection must be an array');
  if (configured !== undefined && !Array.isArray(configured)) throw new ClipMoveError('authored collection must be an array');
  if (kind === 'clip' && Array.isArray(direct) && Array.isArray(configured) && !equal(direct, configured)) {
    throw new ClipMoveError('divergent parent clip mirrors', 'identity_conflict');
  }
  const rows = Array.isArray(direct) &&
    (!Array.isArray(configured) || direct.length > 0 || configured.length === 0) ? direct : configured;
  if (!Array.isArray(rows)) throw new ClipMoveError('structural edit requires an authored entity collection');
  return rows;
}

function collectionShape(bundle: AuthoredBundle, kind: 'clip' | 'occurrence'): JsonObject {
  if (kind === 'occurrence') return { container: 'array' };
  const parent = bundle.parent;
  const config = parentConfig(bundle);
  return {
    members: collectionPresence(config.clips),
    config: collectionPresence(config),
    payload_members: collectionPresence(parent.clips),
  };
}

function appendRead(ctx: MoveRecording, ref: string, path: string[], state: { state: 'absent' } | { state: 'present'; value: JSON }): void {
  const read = { ref, path, state };
  if (!ctx.command.reads!.some((other) => equal(read, other))) ctx.command.reads!.push(copy(read));
}

function appendSelection(ctx: MoveRecording, key: string, owner: string, members: string[], order = members): void {
  ctx.command.selections!.push({
    key, query_version: 1, owner, members: [...members], order: [...order], boundaries: [...order],
    policy: 'guard-membership',
  });
}

function resetRecordingClaims(ctx: MoveRecording): void {
  ctx.command.resolved = [];
  ctx.command.reads = [];
  ctx.command.selections = [];
  ctx.command.expect = {};
  ctx.command.authorship = {};
  ctx.command.bindings = {};
  ctx.command.created = [];
  ctx.record.reads = ctx.command.reads;
  ctx.record.selections = ctx.command.selections;
}

function assertSubmittedClaims(supplied: EditCommand, actual: EditCommand): void {
  for (const key of CLAIMS) {
    if (has(supplied, key) && !equal(supplied[key], actual[key])) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
}

function appendCreated(ctx: MoveRecording, ref: string, kind: 'clip' | 'track', row: JsonObject): void {
  const before = { state: 'absent' } as const;
  const after = { state: 'present', value: copy(row) } as const;
  ctx.command.expect![`${ref}::`] = before;
  ctx.command.authorship![`${ref}::`] = 'direct';
  ctx.record.writes.push({ ref, path: [], before, after });
  ctx.command.created!.push(ref);
  ctx.record.created.push({ ref, kind, owner: 'parent' });
}

function appendRow(bundle: AuthoredBundle, kind: 'clip' | 'track', row: JsonObject): void {
  const parent = bundle.parent;
  const config = parentConfig(bundle);
  const key = `${kind}s`;
  const direct = parent[key];
  const configured = config[key];
  const rows = Array.isArray(direct) &&
    (!Array.isArray(configured) || direct.length > 0 || configured.length === 0) ? direct : configured;
  if (!Array.isArray(rows)) throw new ClipMoveError('structural edit requires an authored entity collection');
  rows.push(copy(row));
}

function mirrorParentClips(ctx: MoveRecording, before: JSON[], after: JSON[], ordinal: number): void {
  const parent = ctx.state.bundle.parent;
  const config = parentConfig(ctx.state.bundle);
  if (!Array.isArray(parent.clips) || !Array.isArray(config.clips)) return;
  const current = ctx.state.get('parent', ['config', 'clips']);
  const next = { state: 'present', value: copy(after) } as const;
  if (equal(current, next)) return;
  ctx.record.derived_writes.push({ ref: 'parent', path: ['config', 'clips'], before: current, after: next, cause: ordinal });
  ctx.state.set('parent', ['config', 'clips'], next);
  void before;
}

function applyTrackCreate(bundle: AuthoredBundle, supplied: EditCommand, ordinal: number): { command: EditCommand; bundle: AuthoredBundle; record: CommandRecord } {
  assertParentBundle(bundle);
  if (supplied.schema_version !== 1 || supplied.op !== 'track.create' || supplied.version !== '1' ||
    !object(supplied.args) || !equal(Object.keys(supplied.args), ['row']) ||
    (supplied.intent !== undefined && !equal(supplied.intent, {})) || !object(supplied.args.row)) {
    throw new ClipMoveError('unsupported track.create v1 command');
  }
  const row = supplied.args.row as JsonObject;
  if (typeof row.id !== 'string' || typeof row.kind !== 'string' || row.id.includes('/') || row.id.includes('::')) {
    throw new ClipMoveError('track.create requires a stable authored track row');
  }
  const ref = `parent/track:${row.id}`;
  if (supplied.select !== 'parent') throw new ClipMoveError('track.create requires parent ownership');
  if (new AuthoredState(bundle).entity(ref, true) !== undefined) {
    throw new ClipMoveError('created identity is occupied', 'identity_conflict');
  }
  const ctx = new MoveRecording(bundle, { ...copy(supplied), intent: {} });
  resetRecordingClaims(ctx);
  appendRead(ctx, ref, [], { state: 'absent' });
  appendSelection(ctx, 'track.create', 'parent', []);
  appendRow(ctx.state.bundle, 'track', row);
  appendCreated(ctx, ref, 'track', row);
  ctx.record.ordinal = ordinal;
  assertSubmittedClaims(supplied, ctx.command);
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function assertLiteralOverlayRow(row: unknown): asserts row is JsonObject {
  if (!object(row) || typeof row.id !== 'string' || !row.id || row.id.includes('/') || row.id.includes('::') ||
    typeof row.clipType !== 'string' || !row.clipType || typeof row.track !== 'string' || !row.track ||
    typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at < 0 ||
    typeof row.hold !== 'number' || !Number.isFinite(row.hold) || row.hold <= 0) {
    throw new ClipMoveError('overlay row requires literal id, clipType, track, at and hold');
  }
  if (['media', 'image', 'video', 'audio'].includes(row.clipType.toLowerCase())) {
    throw new ClipMoveError(`clip.add v1 does not support ${row.clipType}`, 'unsupported_media');
  }
  for (const key of UNSUPPORTED_MEDIA_KEYS) {
    if (has(row, key)) throw new ClipMoveError(`clip.add v1 does not support ${key}`, 'unsupported_media');
  }
  for (const key of UNSUPPORTED_TIMING_KEYS) {
    if (row[key] !== undefined && row[key] !== null) throw new ClipMoveError(`clip.add v1 does not support ${key}`, 'unsupported_timing');
  }
  if (row.speed !== undefined && row.speed !== 1) throw new ClipMoveError('clip.add v1 requires literal hold timing without speed changes', 'unsupported_timing');
  for (const container of [row, row.app, object(row.app) ? row.app.astrid : undefined]) {
    if (!object(container)) continue;
    for (const key of [...RELATIONS, 'anchor', 'standin', 'standin_intent']) {
      if (container[key] !== undefined && container[key] !== null) throw new ClipMoveError(`clip.add v1 does not support ${key}`, 'unsupported_timing');
    }
  }
  const element = row.elementRef ?? row.element_ref;
  if (!object(element) || typeof element.id !== 'string' || !element.id || typeof element.kind !== 'string' ||
    !element.kind || typeof element.revision !== 'string' || !element.revision) {
    throw new ClipMoveError('overlay row requires an exact literal element reference');
  }
  if ([row.elementRef, row.element_ref].some((candidate) => object(candidate) && has(candidate, 'packId'))) {
    throw new ClipMoveError('selected project pack capture requires authoritative Agent schema capture');
  }
  assertFiniteJson(row);
}

function activeVisualOutput(track: JsonObject | undefined): boolean {
  return !!track && track.kind === 'visual' && (track.role === undefined || track.role === 'output') &&
    track.enabled !== false && track.active !== false && !['disabled', 'hidden', 'deleted'].some((key) => track[key] === true);
}

function applyClipAdd(bundle: AuthoredBundle, supplied: EditCommand, ordinal: number): { command: EditCommand; bundle: AuthoredBundle; record: CommandRecord } {
  assertParentBundle(bundle);
  if (supplied.schema_version !== 1 || supplied.op !== 'clip.add' || supplied.version !== '1' || supplied.select !== 'parent' ||
    !object(supplied.args) || !equal(Object.keys(supplied.args), ['row']) ||
    (supplied.intent !== undefined && !equal(supplied.intent, {})) || !object(supplied.args.row)) {
    throw new ClipMoveError('unsupported clip.add v1 command');
  }
  const row = supplied.args.row as JsonObject;
  assertLiteralOverlayRow(row);
  const state = new AuthoredState(bundle);
  const trackRef = `parent/track:${row.track}`;
  const track = state.entity(trackRef, true);
  for (const key of ['id', 'kind', 'role', 'enabled', 'active', 'disabled', 'hidden', 'deleted']) {
    const value = track && has(track, key) ? track[key] : undefined;
    const read = presence(value);
    // The native recorder reads all track leaves, including absent leaves.
    // The command's actual bundle is authoritative, so no caller fields are inferred.
    void read;
  }
  if (!activeVisualOutput(track)) {
    if (!track) throw new ClipMoveError('clip.add destination track is missing', 'identity_conflict');
    throw new ClipMoveError('clip.add requires an active visual output track', 'identity_conflict');
  }
  const ctx = new MoveRecording(bundle, { ...copy(supplied), intent: {} });
  resetRecordingClaims(ctx);
  for (const key of ['id', 'kind', 'role', 'enabled', 'active', 'disabled', 'hidden', 'deleted']) ctx.read(trackRef, [key]);
  const rows = collectionRows(ctx.state.bundle, 'clip');
  const members = rows.map((value) => object(value) && typeof value.id === 'string' ? `parent/clip:${value.id}` : '');
  if (members.includes('')) throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
  appendRead(ctx, 'parent/collection:clip', [], { state: 'present', value: collectionShape(ctx.state.bundle, 'clip') });
  appendSelection(ctx, 'collection.clips', 'parent', members);
  const ref = `parent/clip:${row.id}`;
  appendRead(ctx, ref, [], { state: 'absent' });
  if (state.entity(ref, true) !== undefined) throw new ClipMoveError('created identity is occupied', 'identity_conflict');
  ctx.bind('add.track', trackRef);
  const before = copy(rows);
  appendRow(ctx.state.bundle, 'clip', row);
  appendCreated(ctx, ref, 'clip', row);
  mirrorParentClips(ctx, before, rows as JsonObject[], ordinal);
  ctx.record.ordinal = ordinal;
  assertSubmittedClaims(supplied, ctx.command);
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function readDependency(ctx: MoveRecording, ref: string, path: string[], message = 'clip.delete cannot prove declared semantic dependencies safe'): void {
  const value = ctx.read(ref, path);
  if (value !== undefined && value !== '' && !equal(value, {}) && !equal(value, [])) throw new ClipMoveError(message, 'unsupported_dependency');
}

function applyClipDelete(bundle: AuthoredBundle, supplied: EditCommand, ordinal: number): { command: EditCommand; bundle: AuthoredBundle; record: CommandRecord } {
  assertParentBundle(bundle);
  assertParentSelect(supplied.select, 'clip');
  if (supplied.schema_version !== 1 || supplied.op !== 'clip.delete' || supplied.version !== '1' ||
    !object(supplied.args) || Object.keys(supplied.args).length !== 0 ||
    (supplied.intent !== undefined && !equal(supplied.intent, {}))) {
    throw new ClipMoveError('unsupported clip.delete v1 command');
  }
  const ref = supplied.select;
  const state = new AuthoredState(bundle);
  const target = state.entity(ref, true);
  const rows = collectionRows(bundle, 'clip');
  const members = rows.map((value) => object(value) && typeof value.id === 'string' ? `parent/clip:${value.id}` : '');
  if (members.includes('')) throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
  if (!members.includes(ref)) throw new ClipMoveError('delete target disappeared', 'identity_conflict');
  if (!target) throw new ClipMoveError('delete target disappeared', 'identity_conflict');
  if (target.clipType === 'shot' || target.clip_type === 'shot') throw new ClipMoveError('clip.delete cannot remove legacy shot ownership', 'unsupported_ownership');
  if (target.clips !== undefined && target.clips !== null || target.children !== undefined && target.children !== null) {
    throw new ClipMoveError('clip.delete cannot remove nested clip ownership', 'unsupported_ownership');
  }
  const ctx = new MoveRecording(bundle, { ...copy(supplied), intent: {} });
  resetRecordingClaims(ctx);
  ctx.command.resolved = [ref];
  appendRead(ctx, 'parent/collection:clip', [], { state: 'present', value: collectionShape(ctx.state.bundle, 'clip') });
  appendSelection(ctx, 'collection.clips', 'parent', members);
  const original = ctx.read(ref, []);
  if (original === undefined) throw new ClipMoveError('delete target disappeared', 'identity_conflict');
  const occurrenceRows = Array.isArray(ctx.state.bundle.placements) ? ctx.state.bundle.placements : [];
  const occurrenceMembers = occurrenceRows.map((row) => object(row) && typeof row.occurrence_id === 'string' ? `occurrence:${row.occurrence_id}` : '');
  if (occurrenceMembers.includes('')) throw new ClipMoveError('missing or ambiguous occurrence identity', 'identity_conflict');
  appendRead(ctx, 'parent/collection:occurrence', [], { state: 'present', value: collectionShape(ctx.state.bundle, 'occurrence') });
  appendSelection(ctx, 'collection.occurrences', 'parent', occurrenceMembers);
  const owners = ['parent', ...occurrenceMembers];
  for (const owner of owners) {
    const configRef = owner === 'parent' ? 'parent' : `${owner}/source`;
    const prefix = owner === 'parent' ? ['config'] : [];
    readDependency(ctx, configRef, [...prefix, 'pinnedShotGroups']);
    for (const path of [prefix, [...prefix, 'app'], [...prefix, 'app', 'astrid']]) {
      for (const key of ['sequences', 'formulas', 'slots']) readDependency(ctx, configRef, [...path, key]);
    }
    const ownerRows = owner === 'parent' ? rows : (() => {
      try { return collectionRows(ctx.state.bundle, 'clip').filter(() => false); } catch { return []; }
    })();
    const ownerClips = owner === 'parent' ? ownerRows : (() => {
      const config = ctx.state.config(owner);
      return Array.isArray(config.clips) ? config.clips : [];
    })();
    for (const value of ownerClips) {
      if (!object(value) || typeof value.id !== 'string') throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
      const member = `${owner}/clip:${value.id}`;
      readDependency(ctx, member, ['transition']);
      for (const path of [[], ['astrid']]) for (const key of RELATIONS) readDependency(ctx, member, ['app', ...path, key]);
    }
  }
  const stagedRows = collectionRows(ctx.state.bundle, 'clip');
  const beforeRows = copy(stagedRows);
  const collection = stagedRows as JsonObject[];
  const index = collection.findIndex((value) => value.id === ref.slice('parent/clip:'.length));
  const removed = collection.splice(index, 1)[0]!;
  const before = { state: 'present', value: copy(removed) } as const;
  const after = { state: 'absent' } as const;
  ctx.command.expect![`${ref}::`] = before;
  ctx.command.authorship![`${ref}::`] = 'direct';
  ctx.record.writes.push({ ref, path: [], before, after });
  mirrorParentClips(ctx, beforeRows, collection, ordinal);
  ctx.record.ordinal = ordinal;
  assertSubmittedClaims(supplied, ctx.command);
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function applyCommand(bundle: AuthoredBundle, command: EditCommand, ordinal: number) {
  if (command.op === 'track.create') return applyTrackCreate(bundle, command, ordinal);
  if (command.op === 'clip.add') return applyClipAdd(bundle, command, ordinal);
  if (command.op === 'clip.delete') return applyClipDelete(bundle, command, ordinal);
  throw new ClipMoveError('unsupported element overlay command');
}

function trackRowFor(args: ElementOverlayCreateArgs): JsonObject | undefined {
  if (args.track === undefined) return undefined;
  if (!object(args.track) || typeof args.track.id !== 'string' || args.track.kind !== 'visual' ||
    (args.track.role !== undefined && args.track.role !== 'output')) {
    throw new ClipMoveError('new overlay track must be a visual output track');
  }
  return args.track;
}

export function captureElementOverlay(bundle: AuthoredBundle, args: ElementOverlayCreateArgs): ElementOverlayBasis {
  assertFiniteJson(bundle);
  assertFiniteJson(args);
  assertParentBundle(bundle);
  if (!object(args) || !object(args.row)) throw new ClipMoveError('element overlay requires a literal row');
  assertLiteralOverlayRow(args.row);
  const state = new AuthoredState(bundle);
  const trackRef = `parent/track:${args.row.track}`;
  const track = state.entity(trackRef, true);
  const snapshot = copy(bundle);
  const commands: EditCommand[] = [];
  let staged = snapshot;
  if (!track) {
    const trackRow = trackRowFor(args);
    if (!trackRow || trackRow.id !== args.row.track) throw new ClipMoveError('clip.add destination track is missing', 'identity_conflict');
    const trackCommand = applyTrackCreate(staged, {
      schema_version: 1, op: 'track.create', version: '1', select: 'parent', args: { row: copy(trackRow) }, intent: {},
    }, 0);
    commands.push(trackCommand.command);
    staged = trackCommand.bundle;
  } else if (!activeVisualOutput(track)) {
    throw new ClipMoveError('clip.add requires an active visual output track', 'identity_conflict');
  }
  const add = applyClipAdd(staged, {
    schema_version: 1, op: 'clip.add', version: '1', select: 'parent', args: { row: copy(args.row) }, intent: {},
  }, commands.length);
  commands.push(add.command);
  return freezeJson({ bundle: snapshot, commands });
}

export function finishElementOverlay(basis: unknown): ElementOverlayResult {
  assertFiniteJson(basis);
  if (!object(basis) || !object(basis.bundle) || !Array.isArray(basis.commands) || basis.commands.length === 0) {
    throw new ClipMoveError('incomplete element overlay capture basis');
  }
  return executeElementOverlay(basis.bundle as AuthoredBundle, basis.commands as EditCommand[]);
}

export function executeElementOverlay(bundle: AuthoredBundle, commands: readonly EditCommand[]): ElementOverlayResult {
  assertFiniteJson(bundle);
  assertFiniteJson(commands);
  if (!Array.isArray(commands) || commands.length === 0) throw new ClipMoveError('element overlay command batch is empty');
  let staged = copy(bundle);
  const applied: EditCommand[] = [];
  const records: CommandRecord[] = [];
  commands.forEach((command, index) => {
    const result = applyCommand(staged, command, index);
    staged = result.bundle;
    applied.push(result.command);
    records.push(result.record);
  });
  return { commands: applied, bundle: staged, records };
}

export function captureElementOverlayDelete(bundle: AuthoredBundle, select: string): ElementOverlayBasis {
  assertFiniteJson(bundle);
  assertFiniteJson(select);
  assertParentBundle(bundle);
  const snapshot = copy(bundle);
  const result = applyClipDelete(snapshot, {
    schema_version: 1, op: 'clip.delete', version: '1', select, args: {}, intent: {},
  }, 0);
  return freezeJson({ bundle: snapshot, commands: [result.command] });
}

export const captureOverlayDelete = captureElementOverlayDelete;
