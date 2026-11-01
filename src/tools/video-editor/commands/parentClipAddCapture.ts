import type { AgentState, EditCommand, JSON, MediaSelection, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import { ClipMoveError, MoveRecording, assertFiniteJson, copy, equal, freezeJson, has, object } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

type Row = Record<string, JSON>;

const MEDIA_SELECTION_KEYS = ['asset', 'catalog_digest', 'generation_id', 'object_id', 'variant_id'];
const MEDIA_CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;
const MEDIA_RELATIONS = ['on', 'fixed_start', 'until', 'until_film_end', 'for', 'cut', 'sequence',
  'sequence_index', 'sequence_fit', 'orphan', 'formulas'];

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('/') && !value.includes('::');
}

function mediaNumber(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new ClipMoveError(`${label} must be a finite ${positive ? 'positive ' : ''}number`, 'unsupported_timing');
  }
  return value;
}

function mediaRate(value: unknown): void {
  if (value == null) return;
  if (object(value) && equal(Object.keys(value).sort(), ['denominator', 'numerator'])) {
    const numerator = value.numerator, denominator = value.denominator;
    if (typeof numerator !== 'number' || typeof denominator !== 'number' ||
      !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) {
      throw new ClipMoveError('fps rational must be positive', 'unsupported_timing');
    }
    return;
  }
  mediaNumber(value, 'fps', true);
}

function validateMediaSelection(value: unknown): asserts value is MediaSelection {
  if (!object(value) || !equal(Object.keys(value).sort(), [...MEDIA_SELECTION_KEYS].sort()) ||
    !['asset', 'generation_id', 'variant_id'].every((key) => typeof value[key] === 'string' && value[key].length > 0) ||
    !['object_id', 'catalog_digest'].every((key) => typeof value[key] === 'string' &&
      /^sha256:[0-9a-f]{64}$/.test(value[key] as string))) {
    throw new ClipMoveError('media requires a closed immutable five-field selection');
  }
}

function verifiedMedia(pin: MediaSelection, inputs: readonly VerifiedMedia[]): { value: VerifiedMedia; kind: 'image' | 'video' } {
  const matches = inputs.filter((input) => equal(input.selection, pin));
  if (!matches.length || matches.some((input) => !equal(input, matches[0]))) {
    throw new ClipMoveError('media edit requires exact Runtime-verified media input', 'dependency_changed');
  }
  const value = matches[0];
  const kind = typeof value.media_type === 'string' && value.media_type.includes('/')
    ? value.media_type.split('/')[0] : '';
  if (kind !== 'image' && kind !== 'video' || !Number.isInteger(value.size) || value.size <= 0) {
    throw new ClipMoveError('media edit requires verified image/video metadata', 'unsupported_media');
  }
  if (kind === 'video') mediaNumber(value.duration_seconds, 'intrinsic duration', true);
  return { value, kind };
}

function mediaRead(ctx: MoveRecording, ref: string, value: AgentState): void {
  const read = { ref, path: [], state: copy(value) };
  if (!ctx.command.reads!.some((prior) => equal(prior, read))) ctx.command.reads!.push(read);
}

export function readParentMediaAsset(ctx: MoveRecording, alias: string): void {
  const registry = ctx.state.entity('parent/registry')!;
  const assets = object(registry.assets) ? registry.assets : {};
  mediaRead(ctx, `parent/asset:${alias}`, has(assets, alias)
    ? { state: 'present', value: copy(assets[alias]) } : { state: 'absent' });
}

function mediaTagged(container: JSON | undefined, key: string): AgentState {
  if (!object(container) || !has(container, key)) return { state: 'absent' };
  const value = container[key];
  return { state: 'present', value: Array.isArray(value) ? [] : object(value) ? {} : copy(value) };
}

function mediaCollectionShape(bundle: AuthoredBundle, kind: 'track' | 'occurrence' | 'asset' | 'clip'): JSON {
  const parent = bundle.parent;
  const config = object(parent.config) ? parent.config : {};
  if (kind === 'occurrence') return { container: 'array' };
  if (kind === 'asset') {
    const direct = object(parent.registry) ? parent.registry : parent.registry;
    const nested = object(config.registry) ? config.registry : config.registry;
    return {
      '0': { registry: mediaTagged(parent, 'registry'), assets: mediaTagged(direct, 'assets') },
      '1': { registry: mediaTagged(config, 'registry'), assets: mediaTagged(nested, 'assets') },
    };
  }
  const shape: Record<string, JSON> = { members: mediaTagged(config, `${kind}s`) };
  if (kind === 'track' || kind === 'clip') shape.config = mediaTagged(parent, 'config');
  if (kind === 'clip') shape.payload_members = mediaTagged(parent, 'clips');
  return shape;
}

function mediaRows(bundle: AuthoredBundle, kind: 'track' | 'clip'): JSON[] {
  const parent = bundle.parent;
  const config = object(parent.config) ? parent.config : {};
  const direct = parent.clips, mirror = config.clips;
  if (kind === 'clip') {
    if (Array.isArray(direct) && Array.isArray(mirror) && !equal(direct, mirror)) {
      throw new ClipMoveError('divergent parent clip mirrors', 'identity_conflict');
    }
    if (!Array.isArray(direct) && !Array.isArray(mirror)) {
      throw new ClipMoveError('structural edit requires an authored entity collection', 'identity_conflict');
    }
    return (Array.isArray(direct) && (direct.length > 0 || !Array.isArray(mirror) || mirror.length === 0)
      ? direct : mirror) as JSON[];
  }
  if (!Array.isArray(config.tracks)) throw new ClipMoveError('structural edit requires an authored entity collection', 'identity_conflict');
  return config.tracks;
}

export function mediaSelection(ctx: MoveRecording, key: 'collection.tracks' | 'collection.occurrences' | 'collection.clips' | 'collection.clips.after', after?: string): string[] {
  const kind = key === 'collection.tracks' ? 'track' : key.startsWith('collection.clips') ? 'clip' : 'occurrence';
  mediaRead(ctx, `parent/collection:${kind}`, { state: 'present', value: mediaCollectionShape(ctx.state.bundle, kind) });
  const rows = kind === 'occurrence' ? ctx.state.bundle.placements : mediaRows(ctx.state.bundle, kind);
  const ids = rows.map((row) => object(row) ? row[kind === 'occurrence' ? 'occurrence_id' : 'id'] : undefined);
  if (ids.some((id) => !identity(id)) || new Set(ids).size !== ids.length) {
    throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
  }
  const members = ids.map((id) => kind === 'occurrence' ? `occurrence:${id}` : `parent/${kind}:${id}`);
  ctx.command.selections!.push({ key, query_version: 1, owner: 'parent', members: after ? [after] : [...members],
    order: [...members], boundaries: after ? members.slice(members.indexOf(after), members.indexOf(after) + 2) : [...members],
    policy: 'guard-membership' });
  return members;
}

function mediaRegistry(ctx: MoveRecording, alias: string, pin: MediaSelection, kind: 'image' | 'video'): void {
  if (!identity(alias)) throw new ClipMoveError('media requires a reserved raw asset alias');
  const parent = ctx.state.bundle.parent;
  const config = object(parent.config) ? parent.config : {};
  const direct = has(parent, 'registry') ? parent.registry : undefined;
  const nested = has(config, 'registry') ? config.registry : undefined;
  for (const registry of [direct, nested]) {
    if (registry != null && (!object(registry) || (has(registry, 'assets') && !object(registry.assets)))) {
      throw new ClipMoveError('media edit requires an authored asset registry', 'identity_conflict');
    }
  }
  if (direct != null && nested != null && !equal(direct, nested)) {
    throw new ClipMoveError('parent.registry conflicts with parent.config.registry', 'identity_conflict');
  }
  mediaRead(ctx, 'parent/collection:asset', { state: 'present', value: mediaCollectionShape(ctx.state.bundle, 'asset') });
  const path = has(parent, 'registry') || !has(config, 'registry') ? ['registry'] : ['config', 'registry'];
  ctx.object('parent', path);
  ctx.object('parent', [...path, 'assets']);
  // Equal parent registry mirrors are one effective registry. Record the
  // container creation once, then materialize it in both authored mirrors.
  if (path.length === 1 && object(config.registry) && !has(config.registry, 'assets')) {
    ctx.state.set('parent', ['config', 'registry', 'assets'], { state: 'present', value: {} });
  }
  const registry = (path.length === 1 ? parent.registry : config.registry) as Record<string, JSON>;
  const assetMap = registry.assets as Record<string, JSON>;
  const ref = `parent/asset:${alias}`;
  const before: AgentState = has(assetMap, alias) ? { state: 'present', value: copy(assetMap[alias]) } : { state: 'absent' };
  mediaRead(ctx, ref, before);
  const expected: JSON = { media_id: pin.object_id, type: kind, generationId: pin.generation_id, variantId: pin.variant_id };
  const entry = before.state === 'present' ? before.value : undefined;
  if (before.state === 'present' && (!object(entry) ||
    Object.entries(expected).some(([key, value]) => entry[key] !== value) ||
    (has(entry, 'catalog_digest') && entry.catalog_digest !== pin.catalog_digest))) {
    throw new ClipMoveError('existing registry binding differs from exact selection', 'dependency_changed');
  }
  if (before.state === 'absent') {
    if (!has(ctx.command.expect!, `${ref}::`)) ctx.command.expect![`${ref}::`] = before;
    ctx.command.authorship![`${ref}::`] = 'direct';
    const after: AgentState = { state: 'present', value: copy(expected) };
    ctx.record.writes.push({ ref, path: [], before, after });
    if (object(parent.registry)) (parent.registry.assets as Record<string, JSON>)[alias] = copy(expected);
    if (object(config.registry)) (config.registry.assets as Record<string, JSON>)[alias] = copy(expected);
    ctx.record.created.push({ ref, kind: 'asset', owner: 'parent' });
    ctx.command.created!.push(ref);
  }
  ctx.dependency('media.new', 'media', pin);
}

/** Read a parent selection, or check an exact Runtime selection against main's binding. */
export function parentClipMediaSelection(bundle: AuthoredBundle, clipId: string, selected?: MediaSelection): MediaSelection {
  const rows = mediaRows(bundle, 'clip');
  const matches = rows.filter((candidate) => object(candidate) && candidate.id === clipId);
  const row = matches.length === 1 ? matches[0] : undefined;
  if (!object(row) || typeof row.asset !== 'string' || !identity(row.asset)) {
    throw new ClipMoveError('parent media swap requires an exact authored target clip', 'identity_conflict');
  }
  const registry = parentMediaRegistry(bundle);
  const entry = object(registry.assets) ? registry.assets[row.asset] : undefined;
  if (!object(entry)) throw new ClipMoveError('parent media swap requires an authored registry binding', 'dependency_changed');
  const selection = selected ?? {
    asset: row.asset,
    generation_id: entry.generationId,
    variant_id: entry.variantId,
    object_id: entry.media_id,
    catalog_digest: entry.catalog_digest,
  };
  validateMediaSelection(selection);
  if (selection.asset !== row.asset || selection.object_id !== entry.media_id ||
    (has(entry, 'generationId') && selection.generation_id !== entry.generationId) ||
    (has(entry, 'variantId') && selection.variant_id !== entry.variantId)) {
    throw new ClipMoveError('old registry binding differs from selection', 'dependency_changed');
  }
  return copy(selection);
}

function parentMediaRegistry(bundle: AuthoredBundle): Row {
  const parent = bundle.parent;
  if (parent.config != null && !object(parent.config)) throw new ClipMoveError('parent.config must be an object');
  const config = object(parent.config) ? parent.config : {};
  for (const container of [parent, config]) {
    if (has(container, 'registry') && (!object(container.registry) ||
      (has(container.registry, 'assets') && !object(container.registry.assets)))) {
      throw new ClipMoveError('media edit requires an authored asset registry');
    }
  }
  if (has(parent, 'registry') && has(config, 'registry') && !equal(parent.registry, config.registry)) {
    throw new ClipMoveError('parent.registry conflicts with parent.config.registry');
  }
  return (parent.registry ?? config.registry ?? { assets: {} }) as Row;
}

function swapRegistry(ctx: MoveRecording, alias: string, pin: MediaSelection, kind: 'image' | 'video', create = false): void {
  if (!identity(alias)) throw new ClipMoveError('media requires a reserved raw asset alias');
  const registry = parentMediaRegistry(ctx.state.bundle);
  mediaRead(ctx, 'parent/collection:asset', { state: 'present', value: mediaCollectionShape(ctx.state.bundle, 'asset') });
  if (!object(registry.assets)) throw new ClipMoveError('media edit requires an authored asset registry');
  const assets = registry.assets;
  const ref = `parent/asset:${alias}`;
  const before: AgentState = has(assets, alias) ? { state: 'present', value: copy(assets[alias]) } : { state: 'absent' };
  const entry = before.state === 'present' ? before.value : undefined;
  if (entry !== undefined && !object(entry)) throw new ClipMoveError('asset binding must be an object');
  mediaRead(ctx, ref, before);
  const expected = { media_id: pin.object_id, type: kind, generationId: pin.generation_id, variantId: pin.variant_id };
  if (create && before.state === 'absent') {
    ctx.command.expect![`${ref}::`] = before;
    ctx.command.authorship![`${ref}::`] = 'direct';
    ctx.record.writes.push({ ref, path: [], before, after: { state: 'present', value: copy(expected) } });
    const parent = ctx.state.bundle.parent;
    const config = object(parent.config) ? parent.config : {};
    for (const registry of [parent.registry, config.registry]) {
      if (object(registry) && object(registry.assets)) registry.assets[alias] = copy(expected);
    }
    ctx.record.created.push({ ref, kind: 'asset', owner: 'parent' });
    ctx.command.created!.push(ref);
  } else if (!object(entry) || (create ? !equal(entry, expected) :
    entry.media_id !== pin.object_id || entry.type !== kind ||
    Object.entries(expected).some(([key, value]) => has(entry, key) && entry[key] !== value))) {
    throw new ClipMoveError('registry binding differs from exact selection', 'dependency_changed');
  }
  if (!create && object(entry) &&
    ['object_id', 'digest', 'content_digest', 'content_sha256', 'file', 'path', 'local_path', 'src', 'source', 'format']
      .some((key) => has(entry, key))) {
    throw new ClipMoveError('unsupported old registry identity codec', 'unsupported_media');
  }
  ctx.dependency(create ? 'media.new' : 'media.old', 'media', pin);
}

function validateParentMediaCommand(command: EditCommand, afterAnchor = false): { row: Row; media: MediaSelection } {
  const fields = ['schema_version', 'op', 'version', 'select', 'args', 'intent', 'rationale', 'group_id', ...MEDIA_CLAIMS];
  if (Object.keys(command).some((key) => !fields.includes(key)) ||
    (has(command, 'rationale') && typeof command.rationale !== 'string') ||
    (has(command, 'group_id') && (typeof command.group_id !== 'string' || !command.group_id))) {
    throw new ClipMoveError('clip.add-media requires the closed EditCommand envelope');
  }
  if (command.schema_version !== 1 || command.op !== 'clip.add-media' || command.version !== '1' || (afterAnchor
      ? typeof command.select !== 'string' || !/^parent\/clip:(?!.*::)[^/]+$/.test(command.select)
      : command.select !== 'parent') ||
    !object(command.args) || !equal(Object.keys(command.args).sort(), ['media', 'row'].sort()) || !object(command.args.row)) {
    throw new ClipMoveError('clip.add-media requires parent ownership and row/media args');
  }
  if (command.intent !== undefined && !equal(command.intent, {})) throw new ClipMoveError('unsupported operation intention policy');
  validateMediaSelection(command.args.media);
  const row = command.args.row;
  if (!identity(row.id) || !identity(row.track) || typeof row.clipType !== 'string' || !row.clipType ||
    typeof row.asset !== 'string' || !identity(row.asset)) {
    throw new ClipMoveError('clip.add-media requires stable raw clip and asset identities');
  }
  // Raw after-anchor video rows may carry the source's absent/null hold; the
  // raw-window validator derives its duration from the source window below.
  // Zero and non-video rows remain strict there, as do ordinary births.
  if (afterAnchor && row.hold != null) mediaNumber(row.hold, 'clip.hold', true);
  return { row, media: command.args.media };
}

function validateParentMediaSwapCommand(command: EditCommand): { ref: string; oldMedia: MediaSelection; media: MediaSelection } {
  const fields = ['schema_version', 'op', 'version', 'select', 'args', 'intent', 'rationale', 'group_id', ...MEDIA_CLAIMS];
  if (Object.keys(command).some((key) => !fields.includes(key)) ||
    (has(command, 'rationale') && typeof command.rationale !== 'string') ||
    (has(command, 'group_id') && (typeof command.group_id !== 'string' || !command.group_id))) {
    throw new ClipMoveError('clip.swap-media requires the closed EditCommand envelope');
  }
  if (command.schema_version !== 1 || command.op !== 'clip.swap-media' || command.version !== '1' ||
    typeof command.select !== 'string' || !/^parent\/clip:(?!.*::)[^/]+$/.test(command.select) ||
    !object(command.args) || !equal(Object.keys(command.args).sort(), ['media', 'old_media'].sort())) {
    throw new ClipMoveError('clip.swap-media requires one explicit raw parent clip and two media selections');
  }
  if (!equal(command.intent, { ownership: 'parent' })) throw new ClipMoveError('clip.swap-media requires parent ownership');
  validateMediaSelection(command.args.old_media);
  validateMediaSelection(command.args.media);
  return { ref: command.select, oldMedia: command.args.old_media, media: command.args.media };
}

function validateMediaRow(
  ctx: MoveRecording, row: Row, kind: 'image' | 'video', inputs: readonly VerifiedMedia[],
  rawWindow = false,
): void {
  if (row.clipType !== 'media' && row.clipType !== kind ||
    ['asset_id', 'media_id', 'object_id', 'clip_type'].some((key) => has(row, key))) {
    throw new ClipMoveError('media edit requires one matching media clip');
  }
  for (const key of ['time_map', 'timeMap', 'clips', 'children', 'from_ms', 'to_ms', 'at_ms', 'duration', 'duration_ms',
    'source', 'sourceURL', 'sourceUrl', 'source_url', 'src', 'source_uuid', 'anchor']) {
    if (row[key] != null) throw new ClipMoveError(`media edit does not support ${key}`, 'unsupported_timing');
  }
  const app = row.app, nested = object(app) ? app.astrid : undefined;
  for (const container of [row, app, nested]) {
    if (container != null && !object(container)) throw new ClipMoveError('intent container must be object or null');
    if (object(container) && [...MEDIA_RELATIONS, 'beats', 'word', 'words', 'transcript', 'source_id', ...(rawWindow ? ['standin', 'standin_intent'] : [])]
      .some((key) => container[key] != null)) throw new ClipMoveError('media edit requires literal child timing', 'unsupported_timing');
  }
  if (!rawWindow && row.transition != null) throw new ClipMoveError('media edit does not support transition', 'unsupported_timing');
  const at = mediaNumber(row.at, 'clip.at');
  const hold = mediaNumber(rawWindow && row.hold == null && kind === 'video'
    ? mediaNumber(row.to, 'clip.to') - mediaNumber(row.from, 'clip.from') : row.hold, 'clip.hold', true);
  const speed = row.speed == null ? 1 : mediaNumber(row.speed, 'clip.speed', true);
  if (at < 0) throw new ClipMoveError('clip.at must be non-negative', 'unsupported_timing');
  if (kind === 'image') {
    if (speed !== 1 || row.from != null || row.to != null) throw new ClipMoveError('image requires hold without a source window', 'unsupported_timing');
  } else {
    const from = rawWindow && row.from == null ? 0 : mediaNumber(row.from, 'clip.from');
    const to = rawWindow && row.to == null ? from + hold : mediaNumber(row.to, 'clip.to');
    if (from < 0 || to <= from || to - from !== hold || inputs.some((input) => to > mediaNumber(input.duration_seconds, 'intrinsic duration', true))) {
      throw new ClipMoveError('source window differs from hold or exceeds media', 'unsupported_timing');
    }
  }
  const trackRef = `parent/track:${row.track}`;
  mediaSelection(ctx, 'collection.tracks');
  const track = ctx.read(trackRef, []);
  if (!object(track) || track.kind !== 'visual' || (has(track, 'role') && track.role !== 'output') ||
    track.enabled === false || track.active === false || ['disabled', 'hidden', 'deleted'].some((key) => track[key] === true)) {
    throw new ClipMoveError('media edit requires an active raw visual track', 'unsupported_ownership');
  }
  ctx.bind('media.track', trackRef);
}

function compileParentClipMirror(ctx: MoveRecording): void {
  const parent = ctx.state.bundle.parent;
  const config = ctx.state.config('parent');
  if (Array.isArray(parent.clips) && Array.isArray(config.clips)) {
    const before = ctx.state.get('parent', ['config', 'clips']);
    const after: AgentState = { state: 'present', value: copy(parent.clips) };
    if (!equal(before, after)) {
      ctx.record.derived_writes.push({ ref: 'parent', path: ['config', 'clips'], before, after, cause: 0 });
      ctx.state.set('parent', ['config', 'clips'], after);
    }
  }
}

/** Local authored execution of Agent clip.add-media; Runtime remains the authority for media selection. */
export function executeParentClipAddMedia(
  bundle: AuthoredBundle, command: EditCommand, inputs: readonly VerifiedMedia[],
  prepareAfterAnchor?: (ctx: MoveRecording) => string[],
) {
  assertFiniteJson(bundle);
  assertFiniteJson(command);
  assertFiniteJson(inputs);
  if (!Array.isArray(inputs) || inputs.some((input) => !object(input))) {
    throw new ClipMoveError('media capture requires detached verified inputs');
  }
  const { row, media } = validateParentMediaCommand(command, prepareAfterAnchor !== undefined);
  const { value, kind } = verifiedMedia(media, inputs);
  const ctx = new MoveRecording(bundle, { ...copy(command), intent: {} });
  ctx.command.intent = {};
  ctx.command.resolved = [];
  mediaRate(ctx.read('parent', ['config', 'output', 'fps']));
  if (ctx.read('parent/source', ['source_window']) != null) {
    throw new ClipMoveError('parent source_window is unsupported', 'unsupported_map');
  }
  ctx.bind('media.owner', 'parent');
  validateMediaRow(ctx, row, kind, [value], prepareAfterAnchor !== undefined);
  for (const occurrence of mediaSelection(ctx, 'collection.occurrences')) {
    for (const path of [['placement', 'track'], ['track']]) {
      if (ctx.read(occurrence, path) === row.track) {
        throw new ClipMoveError('track is the lane of an occurrence-owned shot', 'unsupported_ownership');
      }
    }
  }
  mediaRegistry(ctx, row.asset as string, media, kind);
  const ordered = prepareAfterAnchor?.(ctx);
  if (ordered) compileParentClipMirror(ctx);
  const members = ordered ?? mediaSelection(ctx, 'collection.clips');
  const ref = `parent/clip:${row.id}`;
  if (members.includes(ref)) throw new ClipMoveError('created identity is occupied', 'identity_collision');
  ctx.read(ref, []);
  ctx.command.expect![`${ref}::`] = { state: 'absent' };
  ctx.command.authorship![`${ref}::`] = 'direct';
  ctx.record.writes.push({ ref, path: [], before: { state: 'absent' }, after: { state: 'present', value: copy(row) } });
  ctx.record.created.push({ ref, kind: 'clip', owner: 'parent' });
  ctx.command.created!.push(ref);
  const parent = ctx.state.bundle.parent;
  const config = ctx.state.config('parent');
  const direct = parent.clips, mirror = config.clips;
  const rows = Array.isArray(direct) && (direct.length > 0 || !Array.isArray(mirror) || mirror.length === 0)
    ? direct : mirror;
  if (!Array.isArray(rows)) throw new ClipMoveError('structural edit requires an authored entity collection', 'identity_conflict');
  if (ordered) rows.splice(ordered.indexOf(command.select!) + 1, 0, copy(row));
  else rows.push(copy(row));
  if (!ordered) compileParentClipMirror(ctx);
  ctx.compile();
  for (const key of MEDIA_CLAIMS) {
    if (has(command, key) && !equal(command[key], ctx.command[key])) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
  Object.assign(ctx.command, copy(command), { intent: {} });
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

/** Local authored execution of Agent clip.swap-media; only the raw asset binding changes. */
export function executeParentClipSwapMedia(
  bundle: AuthoredBundle, command: EditCommand, inputs: readonly VerifiedMedia[],
) {
  assertFiniteJson(bundle);
  assertFiniteJson(command);
  assertFiniteJson(inputs);
  if (!Array.isArray(inputs) || inputs.some((input) => !object(input))) {
    throw new ClipMoveError('media capture requires detached verified inputs');
  }
  const { ref, oldMedia, media } = validateParentMediaSwapCommand(command);
  const previous = verifiedMedia(oldMedia, inputs);
  const { value, kind } = verifiedMedia(media, inputs);
  if (previous.kind !== kind) throw new ClipMoveError('media swap preserves media kind', 'unsupported_media');
  const ctx = new MoveRecording(bundle, copy(command));
  // Private014 carrier; the unactivated public013 DTO does not admit parent ownership.
  ctx.command.intent = { ownership: 'parent' } as unknown as EditCommand['intent'];
  ctx.bind('media.owner', 'parent');
  const members = mediaSelection(ctx, 'collection.clips');
  if (!members.includes(ref)) throw new ClipMoveError('missing raw parent clip identity', 'identity_conflict');
  const row = ctx.read(ref, []);
  if (!object(row)) throw new ClipMoveError('missing raw parent clip identity', 'identity_conflict');
  // Parent raw swaps preserve timing and transitions; both immutable sources
  // must cover the original window. Occurrence ownership is a separate recipe.
  validateMediaRow(ctx, row, kind, [previous.value, value], true);
  swapRegistry(ctx, row.asset as string, oldMedia, kind);
  swapRegistry(ctx, media.asset, media, kind, true);
  ctx.bind('media.target', ref, ['media.old', 'media.new']);
  ctx.write(ref, ['asset'], media.asset);
  ctx.compile();
  for (const key of MEDIA_CLAIMS) {
    if (has(command, key) && !equal(command[key], ctx.command[key])) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
  Object.assign(ctx.command, copy(command), { intent: { ownership: 'parent' } });
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

/** Caller reserves the clip/asset IDs and keeps the original verified selection for retry. */
export type ParentClipAddMediaBasis = {
  readonly bundle: AuthoredBundle;
  readonly command: EditCommand;
  readonly verifiedMedia: readonly VerifiedMedia[];
};

export function captureParentClipAddMedia(
  bundle: AuthoredBundle, row: Row, media: MediaSelection, inputs: readonly VerifiedMedia[],
): ParentClipAddMediaBasis {
  const command: EditCommand = { schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent',
    args: { row: copy(row), media: copy(media) }, intent: {} };
  const result = executeParentClipAddMedia(bundle, command, inputs);
  return freezeJson({ bundle: copy(bundle), command: result.command, verifiedMedia: copy(inputs) });
}

export function finishParentClipAddMedia(basis: unknown) {
  assertFiniteJson(basis);
  if (!object(basis) || !object(basis.bundle) || !object(basis.command) || !Array.isArray(basis.verifiedMedia) ||
    !MEDIA_CLAIMS.every((key) => has(basis.command as Row, key))) {
    throw new ClipMoveError('incomplete parent clip.add-media basis');
  }
  return executeParentClipAddMedia(
    basis.bundle as AuthoredBundle, basis.command as EditCommand, basis.verifiedMedia as VerifiedMedia[],
  );
}
