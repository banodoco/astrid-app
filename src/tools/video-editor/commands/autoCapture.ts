import type { EditCommand, JSON, MediaSelection, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import { AuthoredState, ClipMoveError, MoveRecording, assertFiniteJson, copy, equal, freezeJson, has, object, type AuthoredBundle } from './clipMovePrimitives.ts';
import { fractionNumber, number, occurrenceStart, rate } from './clipMoveCapture.ts';

type Row = Record<string, JSON>;
type Approval = {
  autoApprove: true;
  owner: string;
  ownership: 'occurrence';
  clipId: string;
  anchor: string | null;
} & ({ mode: 'completion'; preferredTrack: string | null; fallbackAt: number | null;
  fallbackTrack: string | null; duration?: number | null }
  | { mode: 'shared'; frame: number | null });
export type AutoCaptureBasis = { readonly bundle: AuthoredBundle; readonly approval: Approval };

// Agent 80f5149631bb2b08c0569a2a53192e14442991e7 native_auto_placement,
// native_occurrence_media_commands and native_placement_commands. Inactive pure port;
// the requester owns task/output binding and persistence before task admission.
const MAP_FIELDS = [['placement', 'start_ms'], ['at_ms'], ['duration_ms'], ['source_offset'],
  ['speed'], ['track'], ['placement', 'track'], ['time_map'], ['timeMap'],
  ['enabled'], ['active'], ['disabled'], ['hidden'], ['deleted']];
const CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;
const PIN_FIELDS = ['asset', 'catalog_digest', 'generation_id', 'object_id', 'variant_id'] as const;
const active = (row: Row): boolean => row.enabled !== false && row.active !== false &&
  !['disabled', 'hidden', 'deleted'].some((key) => row[key] === true);
const rawId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('/') && !value.includes('::');

function verifiedInput(pin: MediaSelection, verified: VerifiedMedia): 'image' | 'video' {
  if (!object(pin) || !equal(Object.keys(pin).sort(), PIN_FIELDS) || !PIN_FIELDS.every((key) => typeof pin[key] === 'string' && pin[key]) ||
    !/^sha256:[a-f0-9]{64}$/.test(pin.object_id) || !/^sha256:[a-f0-9]{64}$/.test(pin.catalog_digest) || !rawId(pin.asset) ||
    !object(verified) || !equal(verified.selection, pin)) {
    throw new ClipMoveError('exact five-field Runtime verification is required', 'dependency_changed');
  }
  const kind = typeof verified.media_type === 'string' && verified.media_type.includes('/') ? verified.media_type.split('/')[0] : undefined;
  if ((kind !== 'image' && kind !== 'video') || !Number.isSafeInteger(verified.size) || verified.size <= 0) {
    throw new ClipMoveError('verified image/video metadata is required', 'unsupported_media');
  }
  if (kind === 'video') number(verified.duration_seconds, 'intrinsic duration', true);
  return kind;
}

function clips(state: AuthoredState, owner: string): Row[] {
  const rows = state.config(owner).clips;
  if (!Array.isArray(rows) || rows.some((row) => !object(row))) throw new ClipMoveError('authored clips are required');
  return rows as Row[];
}

function endFrame(clip: Row, origin: number, fps: number): number {
  const at = has(clip, 'at') ? number(clip.at, 'clip.at') : number(clip.at_ms, 'clip.at_ms') / 1000;
  const speed = clip.speed == null ? 1 : number(clip.speed, 'clip.speed', true);
  const length = typeof clip.hold === 'number' ? number(clip.hold, 'clip.hold')
    : number(clip.to ?? 0, 'clip.to') - number(clip.from ?? 0, 'clip.from');
  if (length < 0) throw new ClipMoveError('invalid source duration', 'unsupported_timing');
  return Math.floor((origin + at) * fps + 0.5) + Math.max(1, Math.floor(length / speed * fps + 0.5));
}

function ownerInputs(ctx: MoveRecording, owner: string): number {
  ctx.select('collection.occurrences', 'parent');
  ctx.read(owner, ['occurrence_id']);
  ctx.read(owner + '/shot', ['shot_id']);
  for (const path of MAP_FIELDS) ctx.read(owner, path);
  const row = ctx.state.occurrence(owner);
  occurrenceStart(row);
  if (!active(row) || ![undefined, null, 0].includes(row.source_offset as number | null | undefined) ||
    ![undefined, null, 1].includes(row.speed as number | null | undefined) || row.time_map != null || row.timeMap != null) {
    throw new ClipMoveError('active translation-only occurrence is required', 'unsupported_map');
  }
  const limit = number(row.duration_ms, 'occurrence.duration_ms', true) / 1000;
  const fps = rate(ctx.read('parent', ['config', 'output', 'fps']));
  if (!equal(rate(ctx.read(owner + '/source', ['output', 'fps'])), fps)) throw new ClipMoveError('parent and child fps differ', 'unsupported_timing');
  if (ctx.read(owner + '/source', ['source_window']) != null) throw new ClipMoveError('internal source_window is unsupported', 'unsupported_map');
  ctx.bind('media.owner', owner);
  return limit;
}

function exclusive(ctx: MoveRecording, owner: string): void {
  if (!equal(ctx.select('placement.owners', owner), [owner])) throw new ClipMoveError('shared authored placement is unsupported', 'unsupported_ownership');
}

function addMedia(ctx: MoveRecording, owner: string, row: Row, pin: MediaSelection, verified: VerifiedMedia, consumed: JSON): void {
  const limit = ownerInputs(ctx, owner);
  exclusive(ctx, owner);
  ctx.read(owner + '/source', ['app', 'astrid', 'pool']);
  ctx.read('parent', ['config', 'pinnedShotGroups']);
  const members = ctx.select('collection.clips', owner);
  if (!Array.isArray(consumed) || new Set(consumed).size !== consumed.length || consumed.some((id) => !rawId(id))) throw new ClipMoveError('invalid consumed identities');
  for (const id of consumed) {
    const ref = `${owner}/clip:${id}`;
    if (!members.includes(ref)) throw new ClipMoveError('consumed clip is absent', 'identity_conflict');
    for (const field of ['at', 'at_ms', 'track', 'hold', 'from', 'to', 'speed']) ctx.read(ref, [field]);
  }
  const kind = verifiedInput(pin, verified);
  // This executor accepts exactly the rows emitted by the two native builders.
  const keys = ['asset', 'at', 'clipType', 'hold', 'id', 'track', ...(kind === 'video' ? ['from', 'speed', 'to'] : [])].sort();
  if (!equal(Object.keys(row).sort(), keys) || row.clipType !== kind || row.asset !== pin.asset || !rawId(row.id)) throw new ClipMoveError('unsupported automatic birth row');
  const at = number(row.at, 'clip.at'), hold = number(row.hold, 'clip.hold', true);
  if (at < 0 || at + hold > limit) throw new ClipMoveError('child interval exceeds occurrence', 'occurrence_boundary');
  if (kind === 'video' && (row.from !== 0 || row.to !== hold || row.speed !== 1 || hold > verified.duration_seconds!)) {
    throw new ClipMoveError('source window exceeds verified media', 'unsupported_timing');
  }
  const track = `${owner}/track:${row.track}`;
  ctx.select('collection.tracks', owner);
  const value = ctx.read(track, []);
  if (!object(value) || value.kind !== 'visual' || (value.role ?? 'output') !== 'output' || !active(value)) throw new ClipMoveError('active raw visual child track is required');
  ctx.bind('media.track', track);
  const registry = ctx.state.config(owner).registry;
  if (!object(registry) || !object(registry.assets)) throw new ClipMoveError('authored asset registry is required');
  const binding = { media_id: pin.object_id, type: kind, generationId: pin.generation_id, variantId: pin.variant_id };
  const ref = `${owner}/asset:${pin.asset}`;
  const entry = ctx.read(ref, []);
  if (ctx.state.get(ref, []).state === 'absent') ctx.create(owner, 'asset', pin.asset, binding);
  else if (!equal(entry, binding)) throw new ClipMoveError('existing registry binding differs from exact selection', 'dependency_changed');
  ctx.dependency('media.new', 'media', pin);
  ctx.create(owner, 'clip', row.id as string, row);
}

/** Execute/replay the original birth; supplied guards must match, never refresh them. */
export function executeAutoBirth(bundle: AuthoredBundle, supplied: EditCommand, verified: VerifiedMedia) {
  assertFiniteJson(bundle);
  assertFiniteJson(supplied);
  assertFiniteJson(verified);
  const owner = supplied.select;
  if (supplied.schema_version !== 1 || supplied.version !== '1' || typeof owner !== 'string' || !/^occurrence:[^/]+$/.test(owner) || owner.includes('::') ||
    !['placement.create', 'occurrence.add-media'].includes(supplied.op) || (has(supplied, 'intent') && !equal(supplied.intent, { ownership: 'occurrence' }))) {
    throw new ClipMoveError('explicit occurrence automatic birth is required');
  }
  const original = new AuthoredState(bundle);
  for (const read of supplied.reads ?? []) {
    if (!original.matches(read.ref, read.path, read.state)) throw new ClipMoveError('original dependency changed', 'dependency_changed');
  }
  for (const selection of supplied.selections ?? []) {
    const probe = new MoveRecording(bundle, supplied);
    probe.select(selection.key as Parameters<MoveRecording['select']>[0], selection.owner, selection.members);
    if (!equal(probe.command.selections!.at(-1), selection)) throw new ClipMoveError('original selection changed', 'selection_changed');
  }
  const ctx = new MoveRecording(bundle, { ...supplied, intent: { ownership: 'occurrence' } });
  const args = supplied.args;
  const pin = args.media as MediaSelection;
  verifiedInput(pin, verified);
  const expectedKeys = supplied.op === 'placement.create' ? ['hold', 'id', 'media', 'on'] : ['media', 'row'];
  if (has(args, 'consumed')) expectedKeys.push('consumed');
  if (!equal(Object.keys(args).sort(), expectedKeys.sort())) throw new ClipMoveError('unsupported birth args');
  let row: Row;
  if (supplied.op === 'placement.create') {
    ownerInputs(ctx, owner);
    exclusive(ctx, owner);
    if (verifiedInput(pin, verified) !== 'image') throw new ClipMoveError('placement.create requires image media', 'unsupported_media');
    const occurrence = ctx.state.occurrence(owner);
    const home = object(occurrence.placement) && has(occurrence.placement, 'track') ? occurrence.placement.track : occurrence.track;
    if (typeof home !== 'string') throw new ClipMoveError('referenced lane is required', 'unsupported_timing');
    const [n, d] = rate(ctx.read('parent', ['config', 'output', 'fps']));
    const frame = Math.floor(number(args.on, 'on') * fractionNumber(n, d) + 0.5);
    const on = Math.sign(frame) * fractionNumber(BigInt(Math.abs(frame)) * d, n);
    row = { id: args.id, clipType: 'image', asset: pin.asset, track: home, at: on - occurrenceStart(occurrence), hold: args.hold };
  } else {
    if (!object(args.row)) throw new ClipMoveError('birth row is required');
    row = args.row;
  }
  addMedia(ctx, owner, row, pin, verified, args.consumed ?? []);
  ctx.compile();
  for (const key of CLAIMS) {
    if (has(supplied, key) && !equal(supplied[key], ctx.command[key])) throw new ClipMoveError(`submitted ${key} does not match authoritative capture`, 'capture_mismatch');
  }
  return { command: ctx.command, record: ctx.record, bundle: ctx.state.bundle };
}

/** Save before admission. The existing requester retains the remaining original task fields. */
export function captureAutoBasis(bundle: AuthoredBundle, approval: Approval): AutoCaptureBasis {
  assertFiniteJson(bundle);
  assertFiniteJson(approval);
  if (approval.autoApprove !== true || approval.ownership !== 'occurrence' || !/^occurrence:[^/]+$/.test(approval.owner) || approval.owner.includes('::') || !rawId(approval.clipId) ||
    (approval.anchor !== null && !rawId(approval.anchor)) || !['completion', 'shared'].includes(approval.mode)) {
    throw new ClipMoveError('original explicit automatic approval is required', 'unsupported_ownership');
  }
  if (approval.mode === 'completion') {
    for (const track of [approval.preferredTrack, approval.fallbackTrack]) if (track !== null && !rawId(track)) throw new ClipMoveError('saved raw lane is required');
    if (approval.fallbackAt !== null) number(approval.fallbackAt, 'fallback_at');
    if (approval.duration != null) number(approval.duration, 'duration', true);
  } else if (approval.frame !== null && !Number.isSafeInteger(approval.frame)) throw new ClipMoveError('frame must be an integer', 'unsupported_timing');
  new AuthoredState(bundle).occurrence(approval.owner);
  return freezeJson({ bundle: copy(bundle), approval: copy(approval) });
}

/** Resolve only on the saved original basis, with the exact completed-media read result. */
export function finishAutoCapture(basis: AutoCaptureBasis, media: MediaSelection, verified: VerifiedMedia) {
  const { bundle, approval: a } = captureAutoBasis(basis.bundle, basis.approval);
  assertFiniteJson(media);
  assertFiniteJson(verified);
  const kind = verifiedInput(media, verified);
  const state = new AuthoredState(bundle), occurrence = state.occurrence(a.owner);
  if (bundle.placements.filter((row) => row.shot_id === occurrence.shot_id).length !== 1) throw new ClipMoveError('shared authored placement is unsupported', 'unsupported_ownership');
  const origin = occurrenceStart(occurrence);
  const home = object(occurrence.placement) && has(occurrence.placement, 'track') ? occurrence.placement.track : occurrence.track;
  const [n, d] = rate((state.config('parent').output as Row | undefined)?.fps), fps = fractionNumber(n, d);
  const rows = clips(state, a.owner), found = rows.find((row) => a.anchor !== null && row.id === a.anchor);
  const consumed = a.mode === 'completion' && found ? [found.id] : a.mode === 'completion' && a.fallbackAt !== null ? [] : rows.map((row) => row.id);
  let lane: JSON | undefined, frame: number, resolution: string;
  const detail: Row = {};
  if (a.mode === 'completion') {
    lane = (found ? a.preferredTrack : a.fallbackTrack) || home;
    if (lane !== home && state.entity(`${a.owner}/track:${lane}`, true) === undefined) throw new ClipMoveError('saved placement track no longer exists', 'dependency_changed');
    if (found) { frame = endFrame(found, origin, fps); resolution = 'anchor-after'; }
    else if (a.fallbackAt !== null) { frame = Math.floor(a.fallbackAt * fps + 0.5); resolution = 'fallback-at'; }
    else {
      const ends = rows.filter((row) => row.track === lane).map((row) => endFrame(row, origin, fps));
      frame = ends.length ? Math.max(...ends) : Math.floor(origin * fps + 0.5); resolution = 'lane-end';
    }
  } else {
    const legacy = state.config('parent').pinnedShotGroups;
    if (legacy != null && !equal(legacy, [])) throw new ClipMoveError('legacy groups require recorded migration', 'migration_needed');
    const pool = state.get(a.owner + '/source', ['app', 'astrid', 'pool']);
    if (pool.state === 'present' && Array.isArray(pool.value) && pool.value.includes(media.asset)) throw new ClipMoveError('pool promotion requires the separate shot.pool port', 'dependency_unavailable');
    lane = found ? found.track : home;
    if (a.frame === null) {
      frame = rows.length ? Math.max(...rows.map((row) => endFrame(row, origin, fps))) : Math.floor(origin * fps + 0.5);
      resolution = 'append'; detail.extent_frame = frame;
    } else {
      const taken = new Set(rows.map((row) => Math.floor((origin + number(row.at, 'clip.at')) * fps + 0.5)));
      frame = Math.max(a.frame, 0);
      const skipped = [];
      while (taken.has(frame)) skipped.push(frame++);
      resolution = 'explicit'; detail.requested_frame = a.frame; detail.skipped = skipped;
    }
  }
  if (!Number.isSafeInteger(frame)) throw new ClipMoveError('frame exceeds browser precision', 'unsupported_timing');
  const on = Math.sign(frame) * fractionNumber(BigInt(Math.abs(frame)) * d, n);
  const length = a.mode === 'shared' ? 4 : kind === 'image' || a.duration == null ? 5 : a.duration;
  const args: Row = kind === 'image' && lane === home ? { id: a.clipId, on, hold: length, media }
    : { row: { id: a.clipId, clipType: kind, asset: media.asset, track: lane as JSON, at: on - origin, hold: length,
      ...(kind === 'video' ? { from: 0, to: length, speed: 1 } : {}) }, media };
  if (consumed.length) args.consumed = consumed;
  const executed = executeAutoBirth(bundle, { schema_version: 1, op: kind === 'image' && lane === home ? 'placement.create' : 'occurrence.add-media',
    version: '1', select: a.owner, args, intent: { ownership: 'occurrence' } }, verified);
  return { commands: [executed.command], records: [executed.record], bundle: executed.bundle,
    capture: { owner: a.owner, clip: a.clipId, kind, media: copy(media), anchor: { id: a.anchor, state: found ? 'present' : 'absent' },
      resolution, lane, consumed, fps: { numerator: Number(n), denominator: Number(d) }, ...detail, start_frame: frame, on, seconds: length } };
}
