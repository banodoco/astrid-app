import type { CommandBatch, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import { DEFAULT_OUTPUT, DEFAULT_VIDEO_TRACKS } from '../lib/defaults.ts';
import { ClipMoveError, MoveRecording, assertFiniteJson, copy, equal, object, type AuthoredBundle } from './clipMovePrimitives.ts';

const EMPTY = { config: { clips: [], tracks: [] }, registry: {}, clips: [] };

// Agent 6efc8150 native_initialize.py and _recording.py::create, bounded to App defaults.
export function captureBootstrap(bundle: AuthoredBundle, input: { name: string; slug: string; output: JSON; tracks: JSON }) {
  assertFiniteJson(bundle);
  assertFiniteJson(input);
  if (!equal(Object.keys(input).sort(), ['name', 'output', 'slug', 'tracks'])
    || typeof input.name !== 'string' || typeof input.slug !== 'string' || !input.slug
    || !equal(input.output, DEFAULT_OUTPUT) || !equal(input.tracks, DEFAULT_VIDEO_TRACKS)) {
    throw new ClipMoveError('Bootstrap requires the supported authored App defaults');
  }
  if (!equal(bundle.parent, EMPTY) || !equal(bundle.placements, []) || !equal(bundle.shots, {})) {
    throw new ClipMoveError('timeline.init requires the pristine empty bootstrap', 'not_pristine');
  }
  const init = new MoveRecording(bundle, { schema_version: 1, op: 'timeline.init', version: '1', select: 'parent',
    args: { name: input.name, slug: input.slug, output: copy(input.output) }, intent: {} });
  init.command.resolved = [];
  init.read('parent', []);
  for (const path of [['config', 'output'], ['name'], ['slug'], ['registry', 'assets']]) init.read('parent', path);
  init.write('parent', ['config', 'output'], input.output);
  init.write('parent', ['name'], input.name);
  init.write('parent', ['slug'], input.slug);
  init.write('parent', ['registry', 'assets'], {});
  let after = init.state.bundle;
  const records = [init.record];
  for (const row of input.tracks as Array<{ [key: string]: JSON }>) {
    const ctx = new MoveRecording(after, { schema_version: 1, op: 'track.create', version: '1', select: 'parent',
      args: { row: copy(row) }, intent: {} });
    ctx.command.resolved = [];
    const config = ctx.state.bundle.parent.config;
    if (!object(config) || !Array.isArray(config.tracks)) throw new ClipMoveError('Missing authored track collection');
    const members = config.tracks.map((track) => `parent/track:${(track as { id: string }).id}`);
    ctx.command.selections!.push({ key: 'track.create', query_version: 1, owner: 'parent',
      members, order: [...members], boundaries: [...members], policy: 'guard-membership' });
    const ref = `parent/track:${row.id}`;
    if (ctx.read(ref, []) !== undefined) throw new ClipMoveError('Created identity is occupied', 'identity_collision');
    // Whole-entity creation is the native recorded write, not a config.tracks replacement.
    ctx.command.expect![`${ref}::`] = { state: 'absent' };
    ctx.command.authorship![`${ref}::`] = 'direct';
    ctx.command.created!.push(ref);
    ctx.record.writes.push({ ref, path: [], before: { state: 'absent' }, after: { state: 'present', value: copy(row) } });
    ctx.record.created.push({ ref, kind: 'track', owner: 'parent' });
    config.tracks.push(copy(row));
    ctx.record.ordinal = records.length;
    records.push(ctx.record);
    after = ctx.state.bundle;
  }
  return { commands: records.map((record) => record.command) as CommandBatch, bundle: after, records };
}
