// Gesture-less edits (no gestureBasis) on a document with shots. The by-id diff is admitted only when it is confined to
// parent clips that no shot pins and no shot sits or plays on, plus additive registry changes and track changes that only
// add a track or remove one that holds no shots and no clips. Anything else is refused as child ownership.
// Helpers are copied from timelineLocalSaveHandoff.corpus.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox.ts';
import { createLocalSaveSession } from '../commands/localSaveSession.ts';
import { withDefaultTimelineOutput } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import { emitTimelineSaveDiagnostic } from '../lib/timeline-diagnostics.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { createTimelineLocalSaveHandoff, type TimelineSaveSource } from './timelineLocalSaveHandoff.ts';

interface StoredDocument { config: Record<string, unknown>; clips?: Array<Record<string, unknown>>; registry: AssetRegistry; occurrences: Array<Record<string, unknown>> }
const corpus = Object.entries(import.meta.glob('./__fixtures__/corpus/*.json', { eager: true, import: 'default' }) as Record<string, StoredDocument>)
  .map(([path, document]) => ({ name: path.split('/').pop()!, document }));
// doc-b keeps its clips only at the top level. The corpus test pins that a gesture-less edit there stays refused
// (its two clip lists may contradict), so this rule is exercised on the documents that carry config.clips.
const shotCorpus = corpus.filter(item => item.name !== 'doc-b.json');

async function mount(stored: StoredDocument, internalPayload: unknown = { tracks: [{ id: 'v1', kind: 'visual', label: 'Track' }], clips: [] }) {
  const head = { projectId: 'project-commit', timelineId: 'timeline-commit', headRevisionId: 'r0', headPublicationId: 'p0' };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { children: false }).data.canonical_document;
  document.parent_revision.payload = structuredClone(stored) as never;
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  // Every occurrence is backed by the exact shot and internal timeline images the Runtime closure requires.
  for (const [index, occurrence] of stored.occurrences.entries()) {
    const internalId = `internal-${index}`;
    const shotPayload = { name: 'Shot', internal_timeline_revision_id: internalId, timing: { duration_ms: 1000 }, assets: [] };
    const shot = { shot_id: occurrence.shot_id as string, revision_id: occurrence.shot_revision_id as string, internal_timeline_revision_id: internalId,
      content_digest: fixtureDigest(shotPayload), payload: shotPayload };
    const internal = { timeline_id: `internal-timeline-${index}`, revision_id: internalId, content_digest: fixtureDigest(internalPayload), payload: structuredClone(internalPayload) };
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
  return { built, source, handoff, session };
}
type Env = Awaited<ReturnType<typeof mount>>;

const storedClips = (stored: StoredDocument) => (stored.config.clips ?? stored.clips) as Array<Record<string, unknown>>;
const writtenPayload = (env: Env) => env.session.getDocument().parent_revision.payload as unknown as StoredDocument;
const writtenClips = (env: Env) => {
  const payload = writtenPayload(env);
  return (payload.config.clips ?? payload.clips) as Array<Record<string, unknown>>;
};
const writtenTracks = (env: Env) => writtenPayload(env).config.tracks as Array<Record<string, unknown>>;

/** Everything a gesture-less edit must leave alone: shots, internal timelines, parent occurrences, and config outside clips/tracks. */
function shotState(env: Env) {
  const document = env.session.getDocument() as unknown as { shot_revisions: unknown; internal_timeline_revisions: unknown };
  const payload = writtenPayload(env);
  const { clips: _clips, tracks: _tracks, ...config } = payload.config;
  return {
    shot_revisions: JSON.stringify(document.shot_revisions),
    internal_timeline_revisions: JSON.stringify(document.internal_timeline_revisions),
    occurrences: JSON.stringify(payload.occurrences),
    configOutsideClipsAndTracks: JSON.stringify(config),
  };
}

/** Runs one capture with diagnostics on and reports whether it was admitted, or the refusal code it carried. */
async function captureOutcome(run: () => Promise<void>): Promise<{ admitted: true } | { admitted: false; code: unknown }> {
  vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
  try {
    const error = await run().then(() => undefined, (caught: unknown) => caught);
    if (error === undefined) return { admitted: true };
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    try {
      emitTimelineSaveDiagnostic('capture-rejected', () => ({ error }));
      return { admitted: false, code: (dispatch.mock.lastCall?.[0] as CustomEvent | undefined)?.detail?.errorCode };
    } finally {
      dispatch.mockRestore();
    }
  } finally {
    vi.unstubAllGlobals();
  }
}

async function admit(env: Env, next: TimelineConfig, registry: AssetRegistry = env.source.registry) {
  const before = shotState(env);
  expect(await captureOutcome(() => env.handoff.capture({ ...env.source, config: next, registry }))).toEqual({ admitted: true });
  expect(shotState(env)).toEqual(before);
}

async function refuse(env: Env, next: TimelineConfig, registry: AssetRegistry = env.source.registry) {
  const before = JSON.stringify(env.session.getDocument());
  expect(await captureOutcome(() => env.handoff.capture({ ...env.source, config: next, registry })))
    .toEqual({ admitted: false, code: 'child-ownership-unavailable' });
  expect(JSON.stringify(env.session.getDocument())).toBe(before);
}

const dropRow = (id: string, track: string, asset: string) => ({ id, track, at: 0, hold: 2, clipType: 'media', asset });

describe.each(shotCorpus)('$name: gesture-less edits on a document with shots', ({ document }) => {
  const shotTracks = new Set(document.occurrences.flatMap(occurrence => [occurrence.track, (occurrence.placement as { track?: string } | undefined)?.track])
    .filter((id): id is string => typeof id === 'string'));
  // Both corpus documents have a free visual track v2 (no occurrence, no clip) and clips only on non-shot tracks.
  const freeTrack = 'v2';
  const firstStored = storedClips(document)[0];

  describe('admitted', () => {
    it('deleting a clip', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const victim = next.clips[0].id;
      next.clips = next.clips.filter(clip => clip.id !== victim);
      await admit(env, next);
      expect(writtenClips(env).map(clip => clip.id)).not.toContain(victim);
      await env.session.dispose();
    });

    it('moving a clip across tracks onto a non-occurrence track', async () => {
      const env = await mount(document);
      expect(shotTracks.has(freeTrack)).toBe(false);
      const next = structuredClone(env.source.config);
      const moved = next.clips[0];
      moved.track = freeTrack;
      await admit(env, next);
      expect(writtenClips(env).find(clip => clip.id === moved.id)!.track).toBe(freeTrack);
      await env.session.dispose();
    });

    it('an inspector edit to a clip prop', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      next.clips[0].volume = 0.5;
      await admit(env, next);
      expect(writtenClips(env).find(clip => clip.id === next.clips[0].id)!.volume).toBe(0.5);
      await env.session.dispose();
    });

    it('dropping an already-registered asset onto a non-occurrence track', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const asset = Object.keys(env.source.registry.assets)[0];
      next.clips.push(dropRow('unnamed-drop', freeTrack, asset) as never);
      await admit(env, next);
      expect(writtenClips(env).at(-1)!.id).toBe('unnamed-drop');
      await env.session.dispose();
    });

    it('an additive registry entry', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const registry = structuredClone(env.source.registry);
      registry.assets['unnamed-new-asset'] = { file: 'unnamed.png', type: 'image/png' } as never;
      await admit(env, next, registry);
      expect(writtenPayload(env).registry.assets).toHaveProperty('unnamed-new-asset');
      await env.session.dispose();
    });

    it('appending an empty track', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      next.tracks.push({ id: 'v7', kind: 'visual', label: 'Spare' } as never);
      await admit(env, next);
      expect(writtenTracks(env).at(-1)!.id).toBe('v7');
      await env.session.dispose();
    });

    it('removing a track that holds no occurrence and no clip', async () => {
      const env = await mount(document);
      expect(storedClips(document).some(clip => clip.track === freeTrack)).toBe(false);
      const next = structuredClone(env.source.config);
      next.tracks = next.tracks.filter(track => track.id !== freeTrack);
      await admit(env, next);
      expect(writtenTracks(env).map(track => track.id)).not.toContain(freeTrack);
      await env.session.dispose();
    });
  });

  describe('refused with child-ownership-unavailable', () => {
    it('deleting a clip that a shot group pins', async () => {
      const pinned = structuredClone(document);
      pinned.config.pinnedShotGroups = [{ trackId: firstStored.track, clipIds: [firstStored.id] }];
      const env = await mount(pinned);
      const next = structuredClone(env.source.config);
      next.clips = next.clips.filter(clip => clip.id !== firstStored.id);
      await refuse(env, next);
      await env.session.dispose();
    });

    it('editing a clip that a shot group pins', async () => {
      const pinned = structuredClone(document);
      pinned.config.pinnedShotGroups = [{ trackId: firstStored.track, clipIds: [firstStored.id] }];
      const env = await mount(pinned);
      const next = structuredClone(env.source.config);
      next.clips.find(clip => clip.id === firstStored.id)!.volume = 0.5;
      await refuse(env, next);
      await env.session.dispose();
    });

    it('moving a clip onto an occurrence track', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const occurrenceTrack = document.occurrences[0].track as string;
      next.clips[0].track = occurrenceTrack;
      await refuse(env, next);
      await env.session.dispose();
    });

    it('dropping a registered asset onto an occurrence track', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const asset = Object.keys(env.source.registry.assets)[0];
      next.clips.push(dropRow('unnamed-drop', document.occurrences[0].track as string, asset) as never);
      await refuse(env, next);
      await env.session.dispose();
    });

    it('removing a registry asset', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const registry = structuredClone(env.source.registry);
      delete registry.assets[Object.keys(registry.assets)[0]];
      await refuse(env, next, registry);
      await env.session.dispose();
    });

    it('changing config.pinnedShotGroups', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      next.pinnedShotGroups = [{ trackId: firstStored.track, clipIds: [firstStored.id] }] as never;
      await refuse(env, next);
      await env.session.dispose();
    });

    it('changing config outside clips and registry (output)', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      next.output = { ...next.output, fps: 12 } as never;
      await refuse(env, next);
      await env.session.dispose();
    });

    it('removing an occurrence track', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const occurrenceTrack = document.occurrences[0].track as string;
      next.tracks = next.tracks.filter(track => track.id !== occurrenceTrack);
      await refuse(env, next);
      await env.session.dispose();
    });
  });
  // A shot with real child content: an audio child plays on the parent's own audio lane a3 and a second audio lane a9.
  const CHILD = { tracks: [{ id: 'v1', kind: 'visual', label: 'Track' }, { id: 'a3', kind: 'audio', label: 'Audio' }, { id: 'a9', kind: 'audio', label: 'Audio' }],
    clips: [{ id: 'child-a', track: 'a3', at: 0, hold: 1, clipType: 'media', asset: 'asset-shot-x' }] };
  const occurrenceId = document.occurrences[0].occurrence_id as string;
  const occurrenceTrack = document.occurrences[0].track as string;

  describe('a shot with child content', () => {
    it('refuses removing a parent audio lane a shot child plays on', async () => {
      const env = await mount(document, CHILD);
      const next = structuredClone(env.source.config);
      next.tracks = next.tracks.filter(track => track.id !== 'a3');
      await refuse(env, next);
      await env.session.dispose();
    });

    it('admits changing the settings of a parent audio lane a shot child plays on', async () => {
      const env = await mount(document, CHILD);
      const next = structuredClone(env.source.config);
      (next.tracks.find(track => track.id === 'a3') as Record<string, unknown>).muted = true;
      await admit(env, next);
      expect((writtenTracks(env).find(track => track.id === 'a3') as Record<string, unknown>).muted).toBe(true);
      await env.session.dispose();
    });

    it('refuses adding a track whose id a shot child already plays on', async () => {
      const env = await mount(document, CHILD);
      const next = structuredClone(env.source.config);
      next.tracks.push({ id: 'a9', kind: 'visual', label: 'Clash' } as never);
      await refuse(env, next);
      await env.session.dispose();
    });

    it('admits parent clip edits on a lane a shot child plays on: move on, move off, delete and inspector edit', async () => {
      let env = await mount(document, CHILD);
      let next = structuredClone(env.source.config);
      const moved = next.clips[0];
      moved.track = 'a3';
      await admit(env, next);
      expect(writtenClips(env).find(clip => clip.id === moved.id)!.track).toBe('a3');
      await env.session.dispose();
      // A parent clip already layered on the lane: move it off, edit it, delete it.
      const layered = structuredClone(document);
      const row = dropRow('layered', 'a3', Object.keys(document.registry.assets)[0]);
      (layered.config.clips as Array<Record<string, unknown>>).push(row);
      if (layered.clips) layered.clips.push(row);
      for (const edit of [
        (config: TimelineConfig) => { config.clips.find(clip => clip.id === 'layered')!.track = freeTrack; },
        (config: TimelineConfig) => { config.clips.find(clip => clip.id === 'layered')!.volume = 0.5; },
        (config: TimelineConfig) => { config.clips = config.clips.filter(clip => clip.id !== 'layered'); },
      ]) {
        env = await mount(layered, CHILD);
        next = structuredClone(env.source.config);
        edit(next);
        await admit(env, next);
        await env.session.dispose();
      }
    });

    it('still refuses a changed clip on a track that holds a shot, even with a shot lane present', async () => {
      const env = await mount(document, CHILD);
      const next = structuredClone(env.source.config);
      next.clips[0].track = occurrenceTrack;
      await refuse(env, next);
      await env.session.dispose();
    });

    it('refuses removing a parent track that a shot child clip names, whatever its kind', async () => {
      const env = await mount(document, { tracks: [{ id: 'v1', kind: 'visual', label: 'Track' }],
        clips: [{ id: 'child-v', track: 'v4', at: 0, hold: 1, clipType: 'media', asset: 'asset-shot-x' }] });
      const next = structuredClone(env.source.config);
      next.tracks = next.tracks.filter(track => track.id !== 'v4');
      await refuse(env, next);
      await env.session.dispose();
    });

    it('refuses a new registry key that a shot child already uses', async () => {
      const env = await mount(document, CHILD);
      const next = structuredClone(env.source.config);
      const registry = structuredClone(env.source.registry);
      registry.assets['asset-shot-x'] = { file: 'override.png', type: 'image/png' } as never;
      await refuse(env, next, registry);
      await env.session.dispose();
    });

    it('refuses a new clip copied from a shot child, by its identity and by its projected id', async () => {
      for (const row of [
        { ...dropRow('copy-by-identity', freeTrack, Object.keys(document.registry.assets)[0]),
          app: { canonical: { occurrenceId, rawClipId: 'child-a', clipRef: `occurrence:${occurrenceId}/clip:child-a` } } },
        dropRow(`${occurrenceId}:child-a`, freeTrack, Object.keys(document.registry.assets)[0]),
      ]) {
        const env = await mount(document, CHILD);
        const next = structuredClone(env.source.config);
        next.clips.push(row as never);
        await refuse(env, next);
        await env.session.dispose();
      }
    });
  });

  describe('the remaining predicate clauses', () => {
    it('refuses a pinned-group clip that sits on a free track (membership, not track)', async () => {
      const pinned = structuredClone(document);
      pinned.config.pinnedShotGroups = [{ shotId: 'shot-01', trackId: occurrenceTrack, clipIds: [firstStored.id] }];
      const env = await mount(pinned);
      expect(firstStored.track).not.toBe(occurrenceTrack);
      const next = structuredClone(env.source.config);
      next.clips.find(clip => clip.id === firstStored.id)!.volume = 0.5;
      await refuse(env, next);
      await env.session.dispose();
    });

    it('refuses editing a shot placeholder row on a free track', async () => {
      const placeholder = structuredClone(document);
      const row = { id: 'shot-ph', track: freeTrack, at: 0, hold: 1, clipType: 'shot' };
      (placeholder.config.clips as Array<Record<string, unknown>>).push(row);
      if (placeholder.clips) placeholder.clips.push(row);
      const env = await mount(placeholder);
      const next = structuredClone(env.source.config);
      next.clips.find(clip => clip.id === 'shot-ph')!.at = 1;
      await refuse(env, next);
      await env.session.dispose();
    });

    it('refuses reordering the existing tracks', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      next.tracks = [next.tracks[1], next.tracks[0], ...next.tracks.slice(2)];
      await refuse(env, next);
      await env.session.dispose();
    });

    it('admits changing track settings on any track: one no shot uses, and the track the shots sit on', async () => {
      for (const id of [freeTrack, occurrenceTrack]) {
        const env = await mount(document);
        const next = structuredClone(env.source.config);
        Object.assign(next.tracks.find(track => track.id === id) as Record<string, unknown>, { muted: true, volume: 0.5 });
        await admit(env, next);
        expect(writtenTracks(env).find(track => track.id === id)).toMatchObject({ muted: true, volume: 0.5 });
        await env.session.dispose();
      }
    });

    it('refuses changing what kind a track is', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      (next.tracks.find(track => track.id === freeTrack) as Record<string, unknown>).kind = 'audio';
      await refuse(env, next);
      await env.session.dispose();
    });

    it('admits moving a clip onto a track added in the same edit', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      next.tracks.push({ id: 'v7', kind: 'visual', label: 'New' } as never);
      next.clips[0].track = 'v7';
      await admit(env, next);
      expect(writtenClips(env).find(clip => clip.id === next.clips[0].id)!.track).toBe('v7');
      await env.session.dispose();
    });

    it('refuses a clip placed on a track that does not exist, including a shot projected lane', async () => {
      for (const lane of ['v-missing', `${occurrenceId}~v1`]) {
        const env = await mount(document);
        const next = structuredClone(env.source.config);
        next.clips[0].track = lane;
        await refuse(env, next);
        await env.session.dispose();
      }
    });

    it('refuses removing a track that still has clips on it', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const track = next.clips[0].track;
      next.tracks = next.tracks.filter(item => item.id !== track);
      await refuse(env, next);
      await env.session.dispose();
    });

    it('refuses changing an existing registry entry', async () => {
      const env = await mount(document);
      const next = structuredClone(env.source.config);
      const registry = structuredClone(env.source.registry);
      (registry.assets[Object.keys(registry.assets)[0]] as Record<string, unknown>).file = 'swapped.png';
      await refuse(env, next, registry);
      await env.session.dispose();
    });
  });
});
