// Long-lived stored timelines (anonymised real documents in __fixtures__/corpus: several tracks, clips on later
// tracks, shots, a stored clip order that differs from the track order, a document whose clips are stored only at
// the top level) must accept every ordinary gesture on every track and clip. The save handoff proves each
// gesture's declared effect by id, whatever order the editor serialises its rows in.
import { describe, expect, it } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox.ts';
import { createLocalSaveSession } from '../commands/localSaveSession.ts';
import { applyPreparedMediaCommand } from '../commands/media.ts';
import { withDefaultTimelineOutput } from '../lib/defaults.ts';
import { splitClipAtPlayhead } from '../lib/editor-utils.ts';
import { recalcActionEnd } from '../lib/clip-editing-utils.ts';
import { withHeldClipSourceFields } from '../lib/serialize.ts';
import { buildTimelineData, rowsToConfig, type ClipMeta } from '../lib/timeline-data.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { createTimelineLocalSaveHandoff, isTimelineAuthoringRefusal, type TimelineGestureReadBasis, type TimelineSaveSource } from './timelineLocalSaveHandoff.ts';

interface StoredDocument { config: Record<string, unknown>; clips?: Array<Record<string, unknown>>; registry: AssetRegistry; occurrences: Array<Record<string, unknown>> }
const corpus = Object.entries(import.meta.glob('./__fixtures__/corpus/*.json', { eager: true, import: 'default' }) as Record<string, StoredDocument>)
  .map(([path, document]) => ({ name: path.split('/').pop()!, document }));

async function mount(stored: StoredDocument) {
  const head = { projectId: 'project-commit', timelineId: 'timeline-commit', headRevisionId: 'r0', headPublicationId: 'p0' };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { children: false }).data.canonical_document;
  document.parent_revision.payload = structuredClone(stored) as never;
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  // Every occurrence is backed by the exact shot and internal timeline images the Runtime closure requires.
  for (const [index, occurrence] of stored.occurrences.entries()) {
    const internalId = `internal-${index}`;
    const internalPayload = { tracks: [{ id: 'v1', kind: 'visual', label: 'Track' }], clips: [] };
    const shotPayload = { name: 'Shot', internal_timeline_revision_id: internalId, timing: { duration_ms: 1000 }, assets: [] };
    const shot = { shot_id: occurrence.shot_id as string, revision_id: occurrence.shot_revision_id as string, internal_timeline_revision_id: internalId,
      content_digest: fixtureDigest(shotPayload), payload: shotPayload };
    const internal = { timeline_id: `internal-timeline-${index}`, revision_id: internalId, content_digest: fixtureDigest(internalPayload), payload: internalPayload };
    document.shot_revisions.push(shot as never);
    document.internal_timeline_revisions.push(internal as never);
    document.dependency_manifest.shots.push({ shot_id: shot.shot_id, revision_id: shot.revision_id, internal_timeline_revision_id: internalId, content_digest: shot.content_digest });
    document.dependency_manifest.internal_timelines.push({ timeline_id: internal.timeline_id, revision_id: internalId, content_digest: internal.content_digest });
  }
  // The same load the editor performs (useTimelineSave prepareDisplay).
  const config = { ...structuredClone(stored.config), ...(stored.config.clips ? {} : { clips: structuredClone(stored.clips) }) };
  const built = await buildTimelineData({ ...config, ...withDefaultTimelineOutput(config as never) } as TimelineConfig, structuredClone(stored.registry));
  const source: TimelineSaveSource = { config: built.config, registry: built.registry, head };
  const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
  const scope = { realmId: 'realm', actorId: 'actor', projectId: head.projectId, timelineId: head.timelineId };
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_k, work) => work() });
  const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(document), outboxes, send: async () => { throw new Error('no send'); },
    loadLatest: async () => initial, changed: () => {}, prepareDisplay: async () => { throw new Error('no adoption'); } } as never);
  const handoff = createTimelineLocalSaveHandoff({ initial, source, session, adopted: (() => {}) as never });
  return { built, source, handoff, session, stored: document.parent_revision.payload as unknown as StoredDocument };
}
type Env = Awaited<ReturnType<typeof mount>>;

const ids = (rows: unknown) => (rows as Array<{ id: string }>).map(row => row.id);
const storedClips = (stored: StoredDocument) => (stored.config.clips ?? stored.clips) as Array<Record<string, unknown>>;
const writtenClips = (env: Env) => {
  const payload = env.session.getDocument().parent_revision.payload as unknown as StoredDocument;
  return (payload.config.clips ?? payload.clips) as Array<Record<string, unknown>>;
};

/** The editor's own serialisation of a rows edit: the stored clips come back grouped by track. */
function rowsEdit(env: Env, clipId: string, edit: (action: { start: number; end: number }, meta: ClipMeta) => Partial<ClipMeta>) {
  const rows = structuredClone(env.built.rows);
  const meta = structuredClone(env.built.meta);
  let patch: Partial<ClipMeta> = {};
  for (const row of rows) for (const action of row.actions) if (action.id === clipId) {
    patch = edit(action, meta[clipId]);
    meta[clipId] = { ...meta[clipId], ...patch };
    action.end = recalcActionEnd(action as never, meta[clipId]);
  }
  const config = withHeldClipSourceFields(rowsToConfig(rows, meta, env.built.output, env.built.clipOrder, env.built.tracks,
    env.built.config.pinnedShotGroups, env.built.config), meta);
  return { config, patch };
}
const basisOf = (env: Env) => ({ config: env.source.config, registry: env.source.registry });
const timing = (patch: Partial<ClipMeta>) => Object.fromEntries(Object.entries(patch).filter(([key]) => ['from', 'to', 'hold', 'speed'].includes(key)));

function gestures(env: Env, clipId: string) {
  const clip = env.built.config.clips.find(item => item.id === clipId)!;
  const length = (typeof clip.hold === 'number' ? clip.hold : (clip.to ?? 0) - (clip.from ?? 0)) / (clip.speed ?? 1);
  const delta = Math.max(0.04, Math.min(0.25, length / 4));
  const trimEnd = () => {
    const { config, patch } = rowsEdit(env, clipId, (_action, meta) => typeof meta.hold === 'number'
      ? { hold: meta.hold - delta } : { to: (meta.to ?? 0) - delta * (meta.speed ?? 1) });
    return { next: config, basis: { kind: 'trim', clipId, patch: timing(patch), ...basisOf(env) } as TimelineGestureReadBasis };
  };
  const trimStart = () => {
    const { config, patch } = rowsEdit(env, clipId, (action, meta) => {
      action.start += delta;
      return typeof meta.hold === 'number' ? { hold: meta.hold - delta } : { from: (meta.from ?? 0) + delta * (meta.speed ?? 1) };
    });
    return { next: config, basis: { kind: 'trim', clipId, patch: timing(patch), ...basisOf(env) } as TimelineGestureReadBasis };
  };
  const move = () => {
    const { config } = rowsEdit(env, clipId, (action) => { action.start += 1; action.end += 1; return {}; });
    return { next: config, basis: { kind: 'move', clipId, trackId: clip.track, ...basisOf(env) } as TimelineGestureReadBasis };
  };
  const split = () => {
    const time = clip.at + length / 2;
    const result = splitClipAtPlayhead(structuredClone(env.built.config) as never, clipId, time);
    return { next: result.config as unknown as TimelineConfig, split: result.nextSelectedClipId,
      basis: { kind: 'split', clipId, timeSeconds: time, ...basisOf(env) } as TimelineGestureReadBasis };
  };
  return { trimEnd, trimStart, move, split };
}

const dropCommand = (trackId: string, selected = true) => ({ type: 'place-prepared-media' as const, payload: { at: 0, trackId, asset: {
  assetKey: 'import-image', mediaType: 'image' as const, durationSeconds: null, source: 'registered' as const,
  entry: { file: 'import.png', type: 'image/png' }, ...(selected ? { mediaSelection: { asset: 'import-image', generation_id: 'g', variant_id: 'v',
    object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'b'.repeat(64)}` } } : {}) } } });

function drop(env: Env, trackId: string, selected = true) {
  const command = dropCommand(trackId, selected);
  const prepared = applyPreparedMediaCommand(env.built, command)!;
  const clipId = prepared.commandResult!.detail!.clipId as string;
  const capture = () => env.handoff.capture({ ...env.source, config: prepared.nextData.config, registry: prepared.nextData.registry },
    { kind: 'prepared-media', config: env.source.config, registry: env.source.registry, clipId, command });
  return { prepared, clipId, capture };
}

describe('anonymised long-lived corpus is a faithful stand-in', () => {
  it('has the shapes the guards used to trip on', () => {
    expect(corpus.map(item => item.name)).toEqual(['doc-a.json', 'doc-b.json', 'doc-c.json']);
    for (const { document } of corpus) {
      expect(document.config.tracks as unknown[]).toHaveLength(9);
      expect(document.occurrences.length).toBeGreaterThan(0);
    }
    // Clips only at the top level (no config.clips), and a stored order that differs from the track order.
    expect(corpus[1].document.config).not.toHaveProperty('clips');
    const trackOrder = (document: StoredDocument) => ids(document.config.tracks);
    const orderMismatch = corpus.some(({ document }) => {
      const order = trackOrder(document);
      const positions = storedClips(document).map(clip => order.indexOf(clip.track as string));
      return positions.some((position, index) => index > 0 && position < positions[index - 1]);
    });
    expect(orderMismatch).toBe(true);
  });
});

describe.each(corpus)('$name through the local save handoff', ({ document }) => {
  const clipIds = storedClips(document).map(clip => clip.id as string);
  const trackIds = ids(document.config.tracks);
  const shotTracks = new Set(document.occurrences.map(occurrence => occurrence.track as string));

  it('loads as the stored document (basis is not the problem)', async () => {
    const env = await mount(document);
    expect(ids(env.source.config.clips).sort()).toEqual([...clipIds].sort());
    await env.session.dispose();
  });

  it.each(clipIds)('move %s is accepted and written in stored order', async (clipId) => {
    const env = await mount(document);
    const { next, basis } = gestures(env, clipId).move();
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).resolves.toBeUndefined();
    expect(ids(writtenClips(env))).toEqual(clipIds);
    expect(writtenClips(env).find(clip => clip.id === clipId)!.at).toBe(next.clips.find(clip => clip.id === clipId)!.at);
    await env.session.dispose();
  });

  it.each(clipIds)('trim the end of %s is accepted on a document with shots', async (clipId) => {
    const env = await mount(document);
    const { next, basis } = gestures(env, clipId).trimEnd();
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).resolves.toBeUndefined();
    expect(ids(writtenClips(env))).toEqual(clipIds);
    await env.session.dispose();
  });

  it.each(clipIds)('trim the start of %s is accepted on a document with shots', async (clipId) => {
    const env = await mount(document);
    const { next, basis } = gestures(env, clipId).trimStart();
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).resolves.toBeUndefined();
    expect(ids(writtenClips(env))).toEqual(clipIds);
    await env.session.dispose();
  });

  it.each(clipIds)('split %s is accepted on a document with shots', async (clipId) => {
    const env = await mount(document);
    const { next, basis, split } = gestures(env, clipId).split();
    expect(split).toBeTruthy();
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).resolves.toBeUndefined();
    expect(ids(writtenClips(env)).filter(id => !clipIds.includes(id))).toEqual([split]);
    expect(ids(writtenClips(env)).filter(id => clipIds.includes(id))).toEqual(clipIds);
    await env.session.dispose();
  });

  it.each(trackIds)('rename track %s is accepted', async (trackId) => {
    const env = await mount(document);
    const next = structuredClone(env.source.config);
    next.tracks.find(track => track.id === trackId)!.label = 'Renamed';
    await expect(env.handoff.capture({ ...env.source, config: next },
      { kind: 'track-label', trackId, label: 'Renamed', ...basisOf(env) })).resolves.toBeUndefined();
    await env.session.dispose();
  });

  const visual = (document.config.tracks as Array<{ id: string; kind: string }>).filter(track => track.kind === 'visual').map(track => track.id);
  it.each(visual)('image drop on track %s is accepted, or refused by name when the track holds shots', async (trackId) => {
    const env = await mount(document);
    const { capture, clipId } = drop(env, trackId);
    if (shotTracks.has(trackId)) {
      await expect(capture()).rejects.toThrow("Can't drop onto a track that holds shots yet");
    } else {
      await expect(capture()).resolves.toBeUndefined();
      const written = ids(writtenClips(env));
      expect(written.slice(0, -1)).toEqual(clipIds);
      expect(written.at(-1)).toBe(clipId);
    }
    await env.session.dispose();
  });

  it('a refusal changes nothing, and the next gesture on the last confirmed state is accepted', async () => {
    const env = await mount(document);
    const plain = visual.find(trackId => !shotTracks.has(trackId)) ?? visual[0];
    const before = structuredClone(env.session.getDocument());
    await expect(drop(env, plain, false).capture()).rejects.toThrow("was not picked from the project's media");
    expect(env.session.getDocument()).toEqual(before);
    const { next, basis } = gestures(env, clipIds[0]).move();
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).resolves.toBeUndefined();
    await env.session.dispose();
  });
});

describe('what stays protected', () => {
  it('a move that also changes another clip is refused', async () => {
    const { document } = corpus[0];
    const env = await mount(document);
    const [first, second] = storedClips(document).map(clip => clip.id as string);
    const { next, basis } = gestures(env, first).move();
    next.clips.find(clip => clip.id === second)!.at += 3;
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).rejects.toThrow('This edit would change more than the clip you selected');
    await env.session.dispose();
  });

  it('a trim that also edits another track\'s clip is refused', async () => {
    const { document } = corpus[0];
    const env = await mount(document);
    const clips = storedClips(document);
    const selected = clips[0];
    const other = clips.find(clip => clip.track !== selected.track)!;
    const { next, basis } = gestures(env, selected.id as string).trimEnd();
    next.clips.find(clip => clip.id === other.id)!.at += 3;
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).rejects.toThrow('This trim would change more than the clip you selected');
    await env.session.dispose();
  });

  it('a trim that also shifts a sibling on the same track is refused (overlap resolution never moves siblings)', async () => {
    const { document } = corpus[0];
    const clips = storedClips(document);
    const selected = clips.find(clip => clips.filter(item => item.track === clip.track).length > 1)!;
    const sibling = clips.find(clip => clip.track === selected.track && clip.id !== selected.id)!;
    const env = await mount(document);
    const { next, basis } = gestures(env, selected.id as string).trimEnd();
    next.clips.find(clip => clip.id === sibling.id)!.at += 3;
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).rejects.toThrow('This trim would change more than the clip you selected');
    await env.session.dispose();
  });

  it('a trim whose same-track sibling is pinned in a shot group and also moves is refused', async () => {
    const { document } = corpus[0];
    const clips = storedClips(document);
    const selected = clips.find(clip => clips.filter(item => item.track === clip.track).length > 1)!;
    const sibling = clips.find(clip => clip.track === selected.track && clip.id !== selected.id)!;
    const pinned = structuredClone(document);
    pinned.config.pinnedShotGroups = [{ shotId: 'shot-01', trackId: selected.track as string, clipIds: [sibling.id as string] }];
    const env = await mount(pinned);
    const { next, basis } = gestures(env, selected.id as string).trimEnd();
    next.clips.find(clip => clip.id === sibling.id)!.at += 0.5;
    const refused = env.handoff.capture({ ...env.source, config: next }, basis);
    await expect(refused).rejects.toThrow('This trim would change more than the clip you selected');
    expect(isTimelineAuthoringRefusal(await refused.catch(error => error))).toBe(true);
    expect(writtenClips(env).find(clip => clip.id === sibling.id)!.at).toBe(sibling.at);
    await env.session.dispose();
  });

  it.each(corpus)('a trim that also sets another field of the selected clip is refused ($name)', async ({ document }) => {
    const env = await mount(document);
    const clipId = storedClips(document)[0].id as string;
    const { next, basis } = gestures(env, clipId).trimEnd();
    Object.assign(next.clips.find(clip => clip.id === clipId)!, { volume: 0.123, text: 'injected' });
    const refused = env.handoff.capture({ ...env.source, config: next }, basis);
    await expect(refused).rejects.toThrow('This trim would change more than the clip you selected');
    expect(isTimelineAuthoringRefusal(await refused.catch(error => error))).toBe(true);
    await env.session.dispose();
  });

  it.each(corpus)('a split whose halves change a non-timing field is refused ($name)', async ({ document }) => {
    for (const half of ['edited', 'created'] as const) {
      const env = await mount(document);
      const clipId = storedClips(document)[0].id as string;
      const { next, basis, split } = gestures(env, clipId).split();
      next.clips.find(clip => clip.id === (half === 'edited' ? clipId : split))!.volume = 0.123;
      await expect(env.handoff.capture({ ...env.source, config: next }, basis)).rejects.toThrow('This split would change more than the clip you selected');
      await env.session.dispose();
    }
  });

  it('a track rename on a top-level-clips document whose mounted source has no clips is refused and keeps the parent clips', async () => {
    const { document } = corpus[1];
    const full = await mount(document);
    const config = { ...structuredClone(document.config), clips: [] };
    const built = await buildTimelineData({ ...config, ...withDefaultTimelineOutput(config as never) } as TimelineConfig, structuredClone(document.registry));
    const source: TimelineSaveSource = { config: built.config, registry: built.registry, head: full.source.head };
    const handoff = createTimelineLocalSaveHandoff({ initial: { head: { revisionId: 'r0', publicationId: 'p0' },
      canonicalDocument: full.session.getDocument() as never }, source, session: full.session, adopted: (() => {}) as never });
    const next = structuredClone(source.config);
    const trackId = next.tracks[0].id;
    next.tracks[0].label = 'Renamed';
    const refused = handoff.capture({ ...source, config: next }, { kind: 'track-label', trackId, label: 'Renamed', config: source.config, registry: source.registry });
    await expect(refused).rejects.toThrow('parent clips are not present in the mounted source');
    // A mounted-source problem is not a refusal of this one edit.
    expect(isTimelineAuthoringRefusal(await refused.catch(error => error))).toBe(false);
    expect((full.session.getDocument().parent_revision.payload as unknown as StoredDocument).clips).toEqual(document.clips);
    await full.session.dispose();
  });

  it('a drop that also changes a registry entry is refused', async () => {
    const { document } = corpus[0];
    const env = await mount(document);
    const plain = (document.config.tracks as Array<{ id: string; kind: string }>).find(track => track.kind === 'visual' && !document.occurrences.some(o => o.track === track.id))!;
    const { prepared, clipId } = drop(env, plain.id);
    const registry = structuredClone(prepared.nextData.registry);
    const first = Object.keys(registry.assets).find(key => key !== 'import-image')!;
    registry.assets[first] = { ...registry.assets[first], file: 'other.png' };
    const command = dropCommand(plain.id);
    await expect(env.handoff.capture({ ...env.source, config: prepared.nextData.config, registry },
      { kind: 'prepared-media', config: env.source.config, registry: env.source.registry, clipId, command }))
      .rejects.toThrow('would alter more than the asset you picked');
    await env.session.dispose();
  });

  it('a stale head is still refused', async () => {
    const { document } = corpus[0];
    const env = await mount(document);
    const { next, basis } = gestures(env, storedClips(document)[0].id as string).move();
    await expect(env.handoff.capture({ ...env.source, config: next, head: { ...env.source.head!, headRevisionId: 'other' } }, basis))
      .rejects.toThrow('original verified authoring head is unavailable');
    await env.session.dispose();
  });

  it('a clip in a pinned shot group still refuses trim and split on a document with shots', async () => {
    const { document } = corpus[0];
    const clipId = storedClips(document)[0].id as string;
    const pinned = structuredClone(document);
    pinned.config.pinnedShotGroups = [{ trackId: (storedClips(document)[0].track as string), clipIds: [clipId] }];
    const env = await mount(pinned);
    const { next, basis } = gestures(env, clipId).trimEnd();
    await expect(env.handoff.capture({ ...env.source, config: next }, basis)).rejects.toThrow("Can't trim or split a clip that belongs to a pinned shot group");
    await env.session.dispose();
  });

  it('an edit that names no gesture on a document with shots is still refused', async () => {
    const { document } = corpus[0];
    const env = await mount(document);
    const { next } = gestures(env, storedClips(document)[0].id as string).trimEnd();
    await expect(env.handoff.capture({ ...env.source, config: next })).rejects.toThrow('This edit is not supported yet for a timeline that has shots');
    await env.session.dispose();
  });
});
