import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { buildTimelineData } from '../../lib/timeline-data.ts';
import { withDefaultTimelineOutput } from '../../lib/defaults.ts';
import { buildPlacePreparedMediaCommand } from '../../hooks/useAssetManagement.ts';
import { previewPreparedMediaCommand } from '../media.ts';
import { createCommitOutbox, toOutboxJson } from '../commitOutbox.ts';
import { createLocalSaveSession } from '../localSaveSession.ts';
import { createTimelineLocalSaveHandoff, type TimelineGestureReadBasis } from '../../hooks/timelineLocalSaveHandoff.ts';
import type { AssetRegistry } from '../../types/index.ts';
import { document } from '../__tests__/commitSessionEnvironment.ts';
import { producePreparedImageRequestFromPaths, type PreparedImageRequestInput } from './preparedImageRequestProducer.ts';
import { serializeTimelineConfigSnapshot } from '../../lib/timeline-domain.ts';
import type { TimelineConfig } from '../../types/index.ts';

const SYNTHETIC_SELECTION = {
  asset: 'synthetic-image',
  generation_id: 'synthetic-generation',
  variant_id: 'synthetic-variant',
  object_id: `sha256:${'1'.repeat(64)}`,
  catalog_digest: `sha256:${'2'.repeat(64)}`,
} as const;

function input(selection: typeof SYNTHETIC_SELECTION | undefined = SYNTHETIC_SELECTION): PreparedImageRequestInput {
  return {
    projectId: 'project-commit',
    timelineId: 'timeline-commit',
    head: { revisionId: 'r0', publicationId: 'p0' },
    canonicalDocument: document(),
    preparedAsset: {
      assetKey: 'synthetic-image', mediaType: 'image', durationSeconds: null, source: 'registered',
      entry: { file: 'synthetic-image.png', type: 'image/png' }, mediaSelection: selection as typeof SYNTHETIC_SELECTION,
    },
    placement: { trackId: 'V1', at: 2 },
  };
}

describe('prepared image request producer fixture', () => {
  it('exports the real App semantic request before authority acceptance and refuses missing or malformed selections', async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'app-prepared-image-'));
    const inputPath = join(directory, 'input.json');
    const outputPath = join(directory, 'output.json');
    const source = input();
    const tracks = [{ id: 'V1', kind: 'visual', role: 'output', opaque: [null, false] }];
    source.canonicalDocument.parent_revision.payload.config.tracks = structuredClone(tracks);
    source.canonicalDocument.parent_revision.payload.tracks = structuredClone(tracks);
    const original = JSON.stringify(source);
    // The UI serializer still refuses unknown authored keys before sanitizing.
    expect(() => serializeTimelineConfigSnapshot(source.canonicalDocument.parent_revision.payload.config as unknown as TimelineConfig))
      .toThrow("unexpected key 'opaque'");
    await writeFile(inputPath, JSON.stringify(source), 'utf8');

    await producePreparedImageRequestFromPaths(inputPath, outputPath);
    expect(await readFile(inputPath, 'utf8')).toBe(original);
    const exported = JSON.parse(await readFile(outputPath, 'utf8')) as {
      request: Record<string, unknown>; idempotency_key: string; request_body_sha256: string;
    };
    expect(exported.request).toMatchObject({
      api_version: 1, project_id: source.projectId, timeline_id: source.timelineId,
      base_revision_id: source.head.revisionId, base_publication_id: source.head.publicationId,
      label: 'Add media', steps: [{ label: 'Add media', intent: 'Add media', tags: [], command_ordinals: [0], patch: [] }],
      merge: 'fields', dry_run: false, source: { via: 'app' },
    });
    const command = (exported.request.commands as Array<Record<string, unknown>>)[0]!;
    expect(exported.request.commands).toHaveLength(1);
    expect(command).toMatchObject({ schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent', intent: {},
      created: ['parent/asset:synthetic-image', 'parent/clip:clip-0'], args: { media: SYNTHETIC_SELECTION } });
    expect((command.args as Record<string, unknown>).row).toMatchObject({
      id: 'clip-0', track: 'V1', at: 2, clipType: 'hold', hold: 5, asset: 'synthetic-image',
    });
    expect(exported.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(exported.request_body_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    const missing = input(undefined);
    delete (missing.preparedAsset as { mediaSelection?: unknown }).mediaSelection;
    const missingPath = join(directory, 'missing.json');
    const missingOutput = join(directory, 'missing-output.json');
    await writeFile(missingPath, JSON.stringify(missing), 'utf8');
    await expect(producePreparedImageRequestFromPaths(missingPath, missingOutput)).rejects.toThrow('mediaSelection');
    await expect(access(missingOutput)).rejects.toThrow();

    const malformed = input({ ...SYNTHETIC_SELECTION, object_id: 'not-a-digest' } as typeof SYNTHETIC_SELECTION);
    const malformedPath = join(directory, 'malformed.json');
    const malformedOutput = join(directory, 'malformed-output.json');
    await writeFile(malformedPath, JSON.stringify(malformed), 'utf8');
    await expect(producePreparedImageRequestFromPaths(malformedPath, malformedOutput)).rejects.toThrow('malformed');
    await expect(access(malformedOutput)).rejects.toThrow();
  });

  it.each(['valid', 'existing asset', 'asset alias', 'existing asset alias', 'forged asset', 'forged clip', 'existing clip', 'generic', 'child row', 'occurrence lane', 'placement lane', 'head', 'foreign timeline', 'gesture basis',
    'local child mutation', 'registry', 'missing selection', 'extra selection', 'wrong recipe', 'wrong command', 'track mutation',
    'additional row', 'bundle', 'unknown gesture', 'source mismatch', 'child selection', 'mirrors'] as const)('preserves a mixed raw parent closure and bounds the prepared recipe: %s', async (kind) => {
    const fixture = input();
    const closure = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { children: true }).data.canonical_document;
    const canonical = fixture.canonicalDocument;
    canonical.shot_revisions = structuredClone(closure.shot_revisions);
    canonical.internal_timeline_revisions = structuredClone(closure.internal_timeline_revisions);
    canonical.dependency_manifest = structuredClone(closure.dependency_manifest);
    const parent = canonical.parent_revision.payload;
    const existingAsset = kind === 'existing asset' || kind === 'existing asset alias';
    if (existingAsset) {
      (parent.registry.assets as Record<string, unknown>)[fixture.preparedAsset.assetKey] = structuredClone(fixture.preparedAsset.entry);
    }
    Object.assign((parent.config.tracks as Array<Record<string, unknown>>)[0], { opaque: [null, false] });
    parent.occurrences = structuredClone(closure.parent_revision.payload.occurrences);
    for (const occurrence of parent.occurrences as Array<Record<string, unknown>>) {
      occurrence.track = kind === 'placement lane' ? 'other' : 'picture';
      (occurrence.placement as Record<string, unknown>).track = 'picture';
    }
    (parent.config.tracks as unknown[]).push({ id: 'picture', kind: 'visual' });
    parent.tracks = structuredClone(parent.config.tracks);
    // The real IMAGE input owns clips at the parent root, with config.clips absent.
    delete parent.config.clips;
    canonical.parent_revision.content_digest = fixtureDigest(parent);
    const head = { projectId: fixture.projectId, timelineId: fixture.timelineId,
      headRevisionId: fixture.head.revisionId, headPublicationId: fixture.head.publicationId };
    const { bundle: _bundle, ...config } = parent.config;
    const loaded = { ...config, clips: structuredClone(parent.clips) } as unknown as TimelineConfig;
    const data = await buildTimelineData({ ...loaded, ...withDefaultTimelineOutput(loaded) },
      parent.registry as unknown as AssetRegistry);
    const source = { config: data.config, registry: data.registry, head };
    if (kind === 'asset alias' || kind === 'existing asset alias') Object.assign(fixture.preparedAsset, {
      mediaSelection: { ...fixture.preparedAsset.mediaSelection, asset: 'selected-image' },
    });
    const command = buildPlacePreparedMediaCommand({ prepared: fixture.preparedAsset, trackId: 'V1', time: 2,
      forceNewTrack: false, insertAtTop: false });
    const preview = previewPreparedMediaCommand(data, command)!;
    const row = preview.nextData.config.clips.at(-1)!;
    const next = { ...source, config: structuredClone(preview.nextData.config), registry: structuredClone(preview.nextData.registry) };
    const gesture: TimelineGestureReadBasis = structuredClone({ kind: 'prepared-media', config: source.config,
      registry: source.registry, clipId: row.id, command });
    const originalGesture = JSON.stringify(gesture);
    if (kind === 'source mismatch') source.config.clips[0].at = 99;
    if (kind === 'mirrors') parent.tracks = [];
    const initial = { head: fixture.head, canonicalDocument: canonical };
    const scope = { realmId: 'fixture', actorId: 'fixture', projectId: fixture.projectId, timelineId: fixture.timelineId };
    const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_key, work) => work() });
    const send = vi.fn();
    const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(canonical), outboxes, send,
      loadLatest: async () => initial, changed: () => {}, prepareDisplay: async () => { throw new Error('No acceptance in capture test'); } });
    const original = JSON.stringify(canonical);
    const handoff = createTimelineLocalSaveHandoff({ initial, source, session, adopted: () => { throw new Error('No adoption in capture test'); } });
    if (kind === 'child row') next.config.clips.unshift({ id: 'occ-0::clip', track: 'picture', at: 0, hold: 1 });
    if (kind === 'occurrence lane' || kind === 'placement lane') {
      next.config.clips.at(-1)!.track = 'picture';
    }
    if (kind === 'head') next.head = { ...head, headRevisionId: 'other' };
    if (kind === 'foreign timeline') next.head = { ...head, timelineId: 'other' };
    if (kind === 'gesture basis') gesture.config.clips[0].at = 99;
    if (kind === 'local child mutation') {
      const changed = structuredClone(canonical);
      changed.shot_revisions[0].payload.name = 'external mutation';
      vi.spyOn(session, 'getDocument').mockReturnValue(toOutboxJson(changed));
    }
    if (kind === 'registry') next.registry.assets.extra = { file: 'unselected.png', type: 'image/png' };
    if (kind === 'missing selection') delete (gesture.command.payload.asset as { mediaSelection?: unknown }).mediaSelection;
    if (kind === 'extra selection') Object.assign(gesture.command.payload.asset.mediaSelection!, { extra: 'unbound' });
    if (kind === 'wrong recipe') gesture.command.payload.replaceClipId = 'x';
    if (kind === 'wrong command') Object.assign(gesture.command, { type: 'swap' });
    if (kind === 'unknown gesture') Object.assign(gesture, { kind: 'unknown' });
    if (kind === 'child selection') gesture.clipId = 'occ-0::clip';
    if (kind === 'track mutation') next.config.tracks[0].label = 'changed';
    if (kind === 'additional row') next.config.clips.push({ ...row, id: 'extra' });
    if (kind === 'forged asset') next.config.clips.at(-1)!.asset = 'unselected-asset';
    if (kind === 'forged clip') gesture.clipId = 'unselected-clip';
    if (kind === 'existing clip') next.config.clips.at(-1)!.id = source.config.clips[0].id;
    const captureInput = JSON.stringify(next);
    const captureGesture = JSON.stringify(gesture);
    const captureDocument = structuredClone(session.getDocument());
    try {
      const capture = handoff.capture(kind === 'bundle' ? { ...next, bundle: { schema_version: 1, itemsBySchemaRef: {} } } : next,
        kind === 'generic' ? undefined : gesture);
      if (kind !== 'valid' && !existingAsset && kind !== 'asset alias') {
        const message = kind === 'existing clip' ? 'authored parent entity binding is ambiguous'
          : kind === 'generic' || kind === 'unknown gesture' || kind === 'occurrence lane' || kind === 'placement lane' ? 'child ownership/fork mapping'
          : kind === 'source mismatch' ? 'upstream source differs'
            : kind === 'mirrors' ? 'contradictory parent tracks mirror'
          : kind === 'head' || kind === 'foreign timeline' ? 'original verified authoring head'
            : kind === 'gesture basis' ? 'gesture read basis differs'
              : kind === 'local child mutation' ? 'local authored document changed'
                : kind === 'registry' ? 'registry changes exceed'
                  : kind === 'missing selection' || kind === 'extra selection' ? 'Runtime project media selection'
                    : kind === 'wrong recipe' ? 'ordinary image add'
                      : kind === 'wrong command' ? 'prepared media command is unavailable' : 'more than one ordinary parent clip';
        await expect(capture).rejects.toThrow(message);
        const [stored] = await outboxes.list(scope);
        expect(stored.intents).toEqual([]);
        expect(stored.pending).toBeUndefined();
        expect(send).not.toHaveBeenCalled();
        expect(session.getDocument()).toEqual(captureDocument);
      } else {
        await capture;
        const [stored] = await outboxes.list(scope);
        expect(stored.intents).toHaveLength(1);
        expect(stored.intents[0].payload).toHaveProperty('before', canonical);
        const captured = session.getDocument() as unknown as typeof canonical;
        const expected = structuredClone(canonical);
        expected.parent_revision.payload.clips = [...structuredClone(parent.clips), row];
        expected.parent_revision.payload.registry = structuredClone(next.registry);
        expect(JSON.stringify(captured)).toBe(JSON.stringify(expected));
        expect(captured.parent_revision.payload.config).not.toHaveProperty('clips');
        expect(stored.intents[0].payload).toHaveProperty('after', captured);
        expect(stored.intents[0].payload).toHaveProperty('commands', [{ schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent',
          args: { row, media: fixture.preparedAsset.mediaSelection }, intent: {}, created: [
            ...(existingAsset ? [] : ['parent/asset:synthetic-image']), `parent/clip:${row.id}`,
          ] }]);
        expect(JSON.stringify(gesture)).toBe(originalGesture);
      }
      expect(JSON.stringify(canonical)).toBe(original);
      expect(JSON.stringify(next)).toBe(captureInput);
      expect(JSON.stringify(gesture)).toBe(captureGesture);
    } finally { await session.dispose(); }
  });

});
