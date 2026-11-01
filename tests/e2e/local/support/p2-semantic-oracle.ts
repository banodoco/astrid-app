import { expect } from '@playwright/test';
import type { CanonicalDocument, CommitRequest, HeadPin } from '../../../../src/integrations/runtime/timeline-commit-types.ts';
import { buildTimelineData, getNextClipId } from '../../../../src/tools/video-editor/lib/timeline-data.ts';
import { trySnapToEdge } from '../../../../src/tools/video-editor/lib/coordinate-utils.ts';
import { withDefaultTimelineOutput } from '../../../../src/tools/video-editor/lib/defaults.ts';
import type { AssetRegistry, TimelineConfig } from '../../../../src/tools/video-editor/types/index.ts';

type JsonObject = Record<string, unknown>;

export type SemanticAddMediaOracle = {
  op: 'clip.add-media' | 'occurrence.add-media';
  owner: string;
  select: string;
  label: string;
  row: JsonObject;
  media: JsonObject;
};

export type SemanticCommitPost = {
  key: string;
  body: CommitRequest;
};

function object(value: unknown, label: string): JsonObject {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonObject;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): void {
  expect(Object.keys(object(value, label)).sort(), label).toEqual([...expected].sort());
}

function assetIds(container: unknown): Set<string> {
  if (container === undefined || container === null) return new Set();
  const registry = object(container, 'authored registry container').registry;
  if (registry === undefined) return new Set();
  const assets = object(registry, 'authored registry').assets;
  if (assets === undefined) return new Set();
  return new Set(Object.keys(object(assets, 'authored assets')));
}

function authoredContainer(before: CanonicalDocument, owner: string): JsonObject {
  const parent = before.parent_revision.payload as unknown as JsonObject;
  if (owner === 'parent') return parent;

  expect(owner).toMatch(/^occurrence:[^/]+$/);
  const occurrenceId = owner.slice('occurrence:'.length);
  const occurrences = parent.occurrences;
  expect(Array.isArray(occurrences), 'authored occurrences').toBe(true);
  const occurrence = (occurrences as Array<JsonObject>).find((row) => row.occurrence_id === occurrenceId);
  expect(occurrence, `authored occurrence ${occurrenceId}`).toBeTruthy();
  const shot = before.shot_revisions.find((candidate) => candidate.shot_id === occurrence!.shot_id
    && candidate.revision_id === occurrence!.shot_revision_id);
  expect(shot, `authored shot for ${owner}`).toBeTruthy();
  const internal = before.internal_timeline_revisions.find((candidate) => candidate.revision_id === shot!.internal_timeline_revision_id);
  expect(internal, `authored internal timeline for ${owner}`).toBeTruthy();
  return internal!.payload as JsonObject;
}

function authoredAssetIds(before: CanonicalDocument, owner: string): Set<string> {
  const container = authoredContainer(before, owner);
  const ids = assetIds(container);
  if (owner === 'parent') for (const id of assetIds(container.config)) ids.add(id);
  return ids;
}

/** Image drop defaults from buildAssetDropEdit; IDs come from the pregesture editor allocator. */
export async function expectedImageDropRow(
  before: CanonicalDocument, owner: string, asset: string, trackId: string, at: number,
): Promise<JsonObject> {
  const container = authoredContainer(before, owner);
  const config = owner === 'parent' ? object(container.config, 'authored parent config') : container;
  const rows = (container.clips ?? config.clips) as Array<JsonObject>;
  const tracks = (container.tracks ?? config.tracks) as Array<JsonObject>;
  expect(Array.isArray(rows), 'authored clips').toBe(true);
  expect(Array.isArray(tracks), 'authored tracks').toBe(true);
  const current = await buildTimelineData(
    withDefaultTimelineOutput({ ...structuredClone(config), clips: structuredClone(rows), tracks: structuredClone(tracks) } as unknown as TimelineConfig),
    structuredClone(container.registry ?? config.registry ?? { assets: {} }) as AssetRegistry,
  );
  const track = current.tracks.find((candidate) => candidate.id === trackId);
  expect(track?.kind, 'image drop visual track').toBe('visual');
  const ids = owner === 'parent' ? current.meta
    : Object.fromEntries(Object.keys(current.meta).map((id) => [`${owner.slice('occurrence:'.length)}:${id}`, {}]));
  return {
    id: getNextClipId(ids), at: trySnapToEdge(current.rows, trackId, at, 5).time,
    track: trackId, asset, clipType: 'hold', hold: 5, opacity: 1,
    ...(track!.fit === 'manual' ? { x: 100, y: 100, width: 320, height: 240 } : {}),
  };
}

/** Strict request oracle for the two semantic media-birth routes. */
export function assertSemanticAddMediaRequest(
  post: SemanticCommitPost,
  before: HeadPin,
  authored: CanonicalDocument,
  expected: SemanticAddMediaOracle,
): void {
  expect(post.key).toMatch(/\S/);
  const body = post.body;
  exactKeys(body, [
    'api_version', 'project_id', 'timeline_id', 'base_revision_id', 'base_publication_id',
    'commands', 'label', 'steps', 'merge', 'dry_run', 'source',
  ], 'semantic commit request');
  expect(body.api_version).toBe(1);
  expect(body.base_revision_id).toBe(before.revision_id);
  expect(body.base_publication_id).toBe(before.publication_id);
  expect(body.project_id).toBe(authored.project_id);
  expect(body.timeline_id).toBe(authored.timeline_id);
  expect(body.label).toBe(expected.label);
  expect(body.dry_run).toBe(false);
  expect(body.source).toEqual({ via: 'app' });
  expect(body.merge).toBe('fields');
  expect(body.commands).toHaveLength(1);
  expect(body.steps).toHaveLength(1);

  const command = body.commands[0]!;
  exactKeys(command, ['schema_version', 'op', 'version', 'select', 'args', 'intent', 'created'], 'semantic command');
  expect(command.schema_version).toBe(1);
  expect(command.op).toBe(expected.op);
  expect(command.version).toBe('1');
  expect(command.select).toBe(expected.select);
  expect(command.intent).toEqual(expected.op === 'clip.add-media' ? {} : { ownership: 'occurrence' });
  const args = object(command.args, `${expected.op} args`);
  exactKeys(args, ['media', 'row'], `${expected.op} args`);
  const row = expected.row;
  expect(args.row).toStrictEqual(row);
  const media = object(args.media, `${expected.op} media`);
  exactKeys(media, ['asset', 'catalog_digest', 'generation_id', 'object_id', 'variant_id'], `${expected.op} media`);
  expect(media).toStrictEqual(expected.media);

  const created = authoredAssetIds(authored, expected.owner).has(row.asset as string)
    ? [`${expected.owner}/clip:${row.id}`]
    : [`${expected.owner}/asset:${row.asset}`, `${expected.owner}/clip:${row.id}`];
  expect(command.created).toEqual(created);

  const step = body.steps[0]!;
  exactKeys(step, ['command_ordinals', 'id', 'intent', 'label', 'patch', 'tags'], 'semantic commit step');
  expect(step.id).toEqual(expect.any(String));
  expect(step.id).toMatch(/\S/);
  expect(step.label).toBe(expected.label);
  expect(step.intent).toBe(expected.label);
  expect(step.tags).toEqual([]);
  expect(step.command_ordinals).toEqual([0]);
  expect(step.patch).toEqual([]);
}
