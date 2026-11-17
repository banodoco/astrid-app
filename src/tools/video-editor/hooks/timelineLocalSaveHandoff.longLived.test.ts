// A timeline stored by a real project (distilled from "Almost Ready": no `output`, no track `role`,
// clips not sorted by `at`, picture track first with no clips yet) must accept the ordinary gestures.
import { describe, expect, it } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox.ts';
import { createLocalSaveSession } from '../commands/localSaveSession.ts';
import { applyPreparedMediaCommand } from '../commands/media.ts';
import { createDefaultTimelineConfig, withDefaultTimelineOutput } from '../lib/defaults.ts';
import { withHeldClipSourceFields } from '../lib/serialize.ts';
import { buildTimelineData, rowsToConfig } from '../lib/timeline-data.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { createTimelineLocalSaveHandoff, type TimelineSaveSource } from './timelineLocalSaveHandoff.ts';
import distilled from './__fixtures__/almostReadyDistilled.json';

const BASIS_REFUSAL = 'gesture read basis differs from the original local authoring input';

async function mount(stored: { config: Record<string, unknown>; registry: AssetRegistry }) {
  const head = { projectId: 'project-commit', timelineId: 'timeline-commit', headRevisionId: 'r0', headPublicationId: 'p0' };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { children: false }).data.canonical_document;
  const config = structuredClone(stored.config);
  document.parent_revision.payload = { config, clips: structuredClone(config.clips), registry: structuredClone(stored.registry) } as never;
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  // The same load the editor performs (useTimelineSave prepareDisplay).
  const built = await buildTimelineData({ ...config, ...withDefaultTimelineOutput(config as never) } as TimelineConfig, stored.registry);
  const source: TimelineSaveSource = { config: built.config, registry: built.registry, head };
  const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
  const scope = { realmId: 'realm', actorId: 'actor', projectId: head.projectId, timelineId: head.timelineId };
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_k, work) => work() });
  const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(document), outboxes, send: async () => { throw new Error('no send'); },
    loadLatest: async () => initial, changed: () => {}, prepareDisplay: async () => { throw new Error('no adoption'); } } as never);
  const handoff = createTimelineLocalSaveHandoff({ initial, source, session, adopted: (() => {}) as never });
  return { built, source, handoff, session };
}

const dropCommand = (trackId: string) => ({ type: 'place-prepared-media' as const, payload: { at: 0, trackId, asset: {
  assetKey: 'import-image', mediaType: 'image' as const, durationSeconds: null, source: 'registered' as const,
  entry: { file: 'import.png', type: 'image/png' }, mediaSelection: { asset: 'import-image', generation_id: 'g', variant_id: 'v',
    object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'b'.repeat(64)}` } } } });

async function drop(env: Awaited<ReturnType<typeof mount>>, trackId: string, unselectedMedia = false) {
  const command = dropCommand(trackId);
  if (unselectedMedia) delete (command.payload.asset as { mediaSelection?: unknown }).mediaSelection;
  const prepared = applyPreparedMediaCommand(env.built, command)!;
  const clipId = prepared.commandResult!.detail!.clipId as string;
  const capture = () => env.handoff.capture({ ...env.source, config: prepared.nextData.config, registry: prepared.nextData.registry },
    { kind: 'prepared-media', config: env.source.config, registry: env.source.registry, clipId, command });
  return { prepared, capture };
}

function pathsThatDiffer(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) pathsThatDiffer((a as never)[key], (b as never)[key], `${path}/${key}`, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

describe('long-lived stored timeline through the local save handoff', () => {
  it('the loaded editor config matches the stored one except for the defaulted output (basis is not the problem)', async () => {
    const env = await mount(distilled as never);
    expect(pathsThatDiffer(distilled.config, env.source.config).map(line => line.split(':')[0])).toEqual(['/output']);
    await env.session.dispose();
  });

  it('accepts an ordinary image drop onto the first visual track', async () => {
    const env = await mount(distilled as never);
    const { prepared, capture } = await drop(env, 'picture');
    console.log('stored clip order:', distilled.config.clips.map(clip => clip.id).join(','));
    console.log('editor next order:', prepared.nextData.config.clips.map(clip => clip.id).join(','));
    await expect(capture()).resolves.toBeUndefined();
    await env.session.dispose();
  });

  it('accepts a drop on a freshly built timeline whose later tracks are empty', async () => {
    const { output: _o, ...config } = createDefaultTimelineConfig();
    const env = await mount({ config, registry: { assets: {} } } as never);
    await expect((await drop(env, 'V1')).capture()).resolves.toBeUndefined();
    await env.session.dispose();
  });

  it('accepts the same drop on a freshly built timeline once a later track (A1) has a clip: order, not legacy shape', async () => {
    const { output: _o, ...config } = createDefaultTimelineConfig();
    const env = await mount({ config: { ...config, clips: [{ id: 'a-1', track: 'A1', at: 0, clipType: 'hold', hold: 2, asset: 'x' }] },
      registry: { assets: { x: { file: 'x.png', type: 'image/png' } } } } as never);
    await expect((await drop(env, 'V1')).capture()).resolves.toBeUndefined();
    await env.session.dispose();
  });

  it('a clip move on the stored timeline is accepted', async () => {
    const env = await mount(distilled as never);
    const rows = structuredClone(env.built.rows);
    for (const row of rows) for (const action of row.actions) if (action.id === 'vo-N19-0') { action.start += 1; action.end += 1; }
    const moved = withHeldClipSourceFields(rowsToConfig(rows, env.built.meta, env.built.output, env.built.clipOrder, env.built.tracks,
      env.built.config.pinnedShotGroups, env.built.config), env.built.meta);
    await expect(env.handoff.capture({ ...env.source, config: moved },
      { kind: 'move', clipId: 'vo-N19-0', trackId: 'vo', config: env.source.config, registry: env.source.registry })).resolves.toBeUndefined();
    await env.session.dispose();
  });

  it('after a refused drop leaves its clip in the editor, the next move is refused as a basis mismatch (the cascade)', async () => {
    const env = await mount(distilled as never);
    const { prepared, capture } = await drop(env, 'picture', true);
    await capture().catch(() => undefined);
    // The editor state still holds the dropped clip (draft retained); the user now moves another clip.
    const stale = prepared.nextData;
    const rows = structuredClone(stale.rows);
    for (const row of rows) for (const action of row.actions) if (action.id === 'vo-N19-0') { action.start += 1; action.end += 1; }
    const moved = withHeldClipSourceFields(rowsToConfig(rows, stale.meta, stale.output, stale.clipOrder, stale.tracks, stale.config.pinnedShotGroups, stale.config), stale.meta);
    await expect(env.handoff.capture({ ...env.source, config: moved },
      { kind: 'move', clipId: 'vo-N19-0', trackId: 'vo', config: stale.config, registry: stale.registry })).rejects.toThrow(BASIS_REFUSAL);
    await env.session.dispose();
  });
});
