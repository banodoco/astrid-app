import { expect } from '@playwright/test';
import type { CanonicalDocument, CommitRead, HeadPin } from '../../../../src/integrations/runtime/timeline-commit-types.ts';
import { ASTRID_ELEMENT_CATALOG } from '../../../../vendor/astrid-browser/astrid/packs/rendering/elements/catalog.ts';

type JsonObject = Record<string, unknown>;
type DocumentPatchPost = { key: string; body: Record<string, any> };
type DocumentPatchBranch = 'catalog' | 'params';

function object(value: unknown, label: string): JsonObject {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  expect(Object.keys(value).sort(), `${label} keys`).toEqual([...keys].sort());
}

function state(row: JsonObject, key: string): CommitRead['state'] {
  return Object.hasOwn(row, key)
    ? { state: 'present', value: row[key] as never }
    : { state: 'absent' };
}

function sourceClips(document: CanonicalDocument): { parent: JsonObject; config: JsonObject; path: string[]; rows: JsonObject[] } {
  const parent = object(document.parent_revision.payload, 'parent payload');
  const config = object(parent.config, 'parent config');
  const topLevelClips = !Object.hasOwn(config, 'clips') && Array.isArray(parent.clips);
  const rows = (topLevelClips ? parent.clips : config.clips) as Array<JsonObject>;
  expect(Array.isArray(rows), 'authored parent clips').toBe(true);
  return { parent, config, path: topLevelClips ? ['clips'] : ['config', 'clips'], rows };
}

function readField(row: JsonObject, path: string[], key: string): CommitRead {
  return { kind: 'field', ref: 'parent', path: [...path, `id:${String(row.id)}`, key], state: state(row, key) };
}

function amBurstRef(): JsonObject {
  const entry = ASTRID_ELEMENT_CATALOG.find((candidate) => candidate.id === 'am-burst'
    && candidate.kind === 'effect' && candidate.packId === 'astrid_motion');
  expect(entry, 'authoritative am-burst catalog entry').toBeTruthy();
  return { id: entry!.id, kind: entry!.kind, packId: entry!.packId, revision: entry!.revision };
}

function clipDuration(row: JsonObject): number {
  const from = row.from;
  const to = row.to;
  const speed = typeof row.speed === 'number' && Number.isFinite(row.speed) && row.speed > 0 ? row.speed : 1;
  const sourceDuration = typeof row.hold === 'number' && Number.isFinite(row.hold)
    ? Math.max(0, row.hold)
    : typeof from === 'number' && Number.isFinite(from)
    && typeof to === 'number' && Number.isFinite(to) && to > from
    ? to - from
    : row.hold;
  expect(typeof sourceDuration, 'selected clip duration').toBe('number');
  expect(Number.isFinite(sourceDuration), 'selected clip duration').toBe(true);
  return (sourceDuration as number) / speed;
}

function expectedElementClipId(rows: JsonObject[], elementId: string, at: number): string {
  const base = `element-${elementId}-${Math.round(at * 1000)}`;
  if (!rows.some((row) => row.id === base)) return base;
  let suffix = 2;
  while (rows.some((row) => row.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function expectedCatalogInsert(original: CanonicalDocument, selectedId: string, id: string): JsonObject {
  const { config, rows } = sourceClips(original);
  const selected = rows.find((row) => String(row.id) === selectedId);
  expect(selected, `authored selected clip ${selectedId}`).toBeTruthy();
  const tracks = config.tracks;
  expect(Array.isArray(tracks), 'authored tracks').toBe(true);
  const track = typeof selected!.track === 'string' && (tracks as Array<JsonObject>).some((candidate) => candidate.id === selected!.track)
    ? selected!.track
    : (tracks as Array<JsonObject>).find((candidate) => candidate.kind === 'visual')?.id
      ?? (tracks as Array<JsonObject>)[0]?.id ?? 'elements';
  expect(typeof selected!.at, 'selected clip position').toBe('number');
  expect(id).toBe(expectedElementClipId(rows, 'am-burst', selected!.at as number));
  return {
    id,
    at: selected!.at,
    track,
    clipType: 'am-burst',
    hold: clipDuration(selected!),
    elementRef: amBurstRef(),
  };
}

export function documentReads(document: CanonicalDocument, branch: DocumentPatchBranch, selectedId: string): CommitRead[] {
  const { config, path, rows } = sourceClips(document);
  const order = rows.map((row) => String(row.id));
  expect(order.every(Boolean), 'authored clip identities').toBe(true);
  const reads: CommitRead[] = [{ kind: 'collection', ref: 'parent', path, members: [...order].sort(), order }];
  for (const row of rows) {
    reads.push(readField(row, path, 'id'));
    if (String(row.id) !== selectedId) continue;
    const keys = branch === 'catalog'
      ? ['clipType', 'hold', 'from', 'to', 'speed', 'track', 'at']
      : ['elementRef', 'params'];
    for (const key of keys) reads.push(readField(row, path, key));
  }
  if (branch === 'catalog') {
    reads.push({ kind: 'field', ref: 'parent', path: ['config', 'tracks'], state: state(config, 'tracks') });
  }
  return reads;
}

function assertRequestEnvelope(post: DocumentPatchPost, before: HeadPin, reads: CommitRead[], label: string, intent: string): JsonObject {
  expect(post.key).toMatch(/\S/);
  const body = post.body;
  expect(Object.keys(body).sort()).toEqual(['api_version', 'base_publication_id', 'base_revision_id', 'commands', 'dry_run', 'label', 'merge', 'project_id', 'reads', 'source', 'steps', 'timeline_id'].sort());
  expect(body.api_version).toBe(1);
  expect(body.project_id).toEqual(expect.any(String));
  expect(body.timeline_id).toEqual(expect.any(String));
  expect(body.base_revision_id).toBe(before.revision_id);
  expect(body.base_publication_id).toBe(before.publication_id);
  expect(body.label).toBe(label);
  expect(body.merge).toBe('atomic');
  expect(body.reads).toEqual(reads);
  expect(body.dry_run).toBe(false);
  expect(body.source).toEqual({ via: 'app' });
  expect(body.commands).toHaveLength(1);
  expect(body.steps).toHaveLength(1);
  const command = object(body.commands[0], 'document patch command');
  exactKeys(command, ['args', 'created', 'op', 'schema_version', 'select', 'version'], 'document patch command');
  expect(command.schema_version).toBe(1);
  expect(command.op).toBe('doc.patch');
  expect(command.version).toBe('1');
  expect(command.select).toBeNull();
  const args = object(command.args, 'document patch args');
  exactKeys(args, ['changes'], 'document patch args');
  const step = object(body.steps[0], 'document patch step');
  exactKeys(step, ['command_ordinals', 'id', 'intent', 'label', 'patch', 'reads', 'tags'], 'document patch step');
  expect(step.id).toEqual(expect.any(String));
  expect(step.label).toBe(label);
  expect(step.intent).toBe(intent);
  expect(step.tags).toEqual([]);
  expect(step.command_ordinals).toEqual([0]);
  expect(step.reads).toEqual(reads);
  expect(step.patch).toEqual(args.changes);
  return command;
}

export function assertCatalogDocumentPatch(post: DocumentPatchPost, before: HeadPin, original: CanonicalDocument, selectedId: string): void {
  expect(post.body.project_id).toBe(original.project_id);
  expect(post.body.timeline_id).toBe(original.timeline_id);
  const reads = documentReads(original, 'catalog', selectedId);
  const command = assertRequestEnvelope(post, before, reads, 'Edit timeline', 'timeline.apply_element');
  expect(command.created).toEqual([expect.stringMatching(/^parent\/clip:.+$/)]);
  const changes = command.args.changes;
  expect(changes).toHaveLength(1);
  const insert = object(changes[0], 'catalog list insert');
  const { rows } = sourceClips(original);
  const order = rows.map((row) => String(row.id));
  exactKeys(insert, ['after_id', 'before', 'id', 'op', 'order_before', 'path', 'ref', 'value'], 'catalog list insert');
  expect(insert.op).toBe('list.insert');
  expect(insert.ref).toBe('parent');
  expect(insert.path).toEqual(['clips']);
  expect(insert.before).toEqual({ state: 'absent' });
  expect(insert.order_before).toEqual(order);
  expect(insert.after_id).toBe(order.at(-1));
  expect(insert.id).toBe(expectedElementClipId(rows, 'am-burst', Number((rows.find((row) => String(row.id) === selectedId)!).at)));
  expect(insert.value).toEqual(expectedCatalogInsert(original, selectedId, String(insert.id)));
  expect(command.created).toEqual([`parent/clip:${String(insert.id)}`]);
  expect((bodyStep(post).patch as unknown[])).toEqual(changes);
}

export function assertParamsDocumentPatch(post: DocumentPatchPost, before: HeadPin, original: CanonicalDocument, selectedId: string): void {
  expect(post.body.project_id).toBe(original.project_id);
  expect(post.body.timeline_id).toBe(original.timeline_id);
  const reads = documentReads(original, 'params', selectedId);
  const command = assertRequestEnvelope(post, before, reads, 'Edit timeline', 'timeline.update_element');
  expect(command.created).toEqual([]);
  const changes = command.args.changes;
  expect(changes).toHaveLength(1);
  expect(changes[0]).toEqual({ op: 'set', ref: 'parent', path: ['clips', `id:${selectedId}`, 'params', 'bob'], before: { state: 'absent' }, value: 12 });
  expect(bodyStep(post).patch).toEqual(changes);
}

function bodyStep(post: DocumentPatchPost): JsonObject {
  return object(post.body.steps[0], 'document patch step');
}

export function assertInverseRequestV2(post: DocumentPatchPost, before: HeadPin, targetPublication: string): void {
  expect(post.key).toMatch(/\S/);
  const body = post.body;
  expect(Object.keys(body).sort()).toEqual(['api_version', 'base_publication_id', 'base_revision_id', 'commands', 'dry_run', 'label', 'merge', 'project_id', 'source', 'steps', 'timeline_id'].sort());
  expect(body.api_version).toBe(1);
  expect(body.project_id).toEqual(expect.any(String));
  expect(body.timeline_id).toEqual(expect.any(String));
  expect(body.base_revision_id).toBe(before.revision_id);
  expect(body.base_publication_id).toBe(before.publication_id);
  expect(body.label).toBe('Undo timeline');
  expect(body.merge).toBe('fields');
  expect(body.dry_run).toBe(false);
  expect(body.source).toEqual({ via: 'app' });
  expect(Object.hasOwn(body, 'reads')).toBe(false);
  expect(body.commands).toHaveLength(1);
  const command = object(body.commands[0], 'inverse command');
  exactKeys(command, ['args', 'op', 'schema_version', 'select', 'version'], 'inverse command');
  expect(command).toEqual({ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [targetPublication] } });
  expect(body.steps).toHaveLength(1);
  const step = object(body.steps[0], 'inverse step');
  exactKeys(step, ['command_ordinals', 'id', 'intent', 'label', 'patch', 'tags'], 'inverse step');
  expect(step.id).toEqual(expect.any(String));
  expect(step.label).toBe('Undo timeline');
  expect(step.intent).toBe('Undo timeline');
  expect(step.tags).toEqual([]);
  expect(step.command_ordinals).toEqual([0]);
  expect(step.patch).toEqual([]);
}
