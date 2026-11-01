import { describe, expect, it } from 'vitest';

import fixture from './shotComposition.fixture.json';
import orderFixture from './shotTrackOrder.fixture.json';
import { collectBuiltInKnownIds, collectExtensionDeclaredIds, scanExportConfig } from '@/tools/video-editor/runtime/exportGuard.ts';
import mediaProjectionFixture from './occurrenceMediaProjection.fixture.json';
import { createShotCompositionAdapter, type PreparedShotComposition } from './shotCompositionAdapter.ts';
import { createAudioReactiveColourFixtures } from '@/test/fakeRuntimeSeed.mjs';
import {
  CanonicalCompositionProjectionError,
  managedOutputMatchesOccurrence,
  projectCanonicalComposition,
} from './shotCompositionProjection.ts';
import { timelineContentExtentMs } from './shotCompositionTiming.ts';
import { boundCanonicalClipToOccurrence } from '@/tools/video-editor/lib/canonicalRenderBounds.ts';
import { getClipTimelineDuration } from '@/tools/video-editor/lib/config-utils.ts';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types/index.ts';

const prepared = createShotCompositionAdapter({ load: async () => fixture }).prepare(fixture);

describe('audio-reactive local bridge fixture projection', () => {
  it('preserves output settings and resolves the selected source audio asset', () => {
    const fixtures = createAudioReactiveColourFixtures({ assetSrcBaseUrl: 'http://127.0.0.1:22217' });
    const composition = createShotCompositionAdapter({ load: async () => fixtures.shotComposition }).prepare(fixtures.shotComposition);
    const projection = projectCanonicalComposition(composition, {
      ...fixtures.config,
      registry: fixtures.registry.assets,
    } as ResolvedTimelineConfig);

    expect(projection.config.output).toMatchObject({ resolution: '640x360', fps: 30 });
    const audioClip = projection.config.clips.find((clip) => clip.id === 'audio_source');
    expect(audioClip?.assetEntry).toMatchObject({
      media_id: 'fixture-media-audio',
      src: 'http://127.0.0.1:22217/audio-reactive-colour-tone.wav',
      type: 'audio/wav',
    });
  });
});

function withOccurrenceRevision(
  source: PreparedShotComposition,
  occurrenceIndex: number,
  edit: (timeline: Record<string, unknown>) => Record<string, unknown>,
): PreparedShotComposition {
  const occurrences = source.occurrences.map((occurrence, index) => {
    if (index !== occurrenceIndex) return occurrence;
    const internal = occurrence.revision.internal_timeline_revision as Record<string, unknown>;
    return {
      ...occurrence,
      revision: {
        ...occurrence.revision,
        internal_timeline_revision: {
          ...internal,
          timeline: edit({ ...(internal.timeline as Record<string, unknown>) }),
        },
      },
    };
  });
  return { ...source, occurrences };
}

describe('canonical shot-composition downstream projection', () => {
  it('projects Runtime images as native stills without changing the source or admitting unknown clip types', () => {
    const source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [
        { id: 'still', clipType: 'image', asset: 'alpha-image', track: 'video', at: 0, hold: 2, opacity: 0.7, x: 12 },
        { id: 'unknown', clipType: 'unknown-custom', track: 'video', at: 2, hold: 1 },
      ],
    }));
    const sourceBefore = JSON.stringify(source);
    const projection = projectCanonicalComposition(source);
    const still = projection.config.clips.find((clip) => clip.id === 'occ-1:still');

    expect(still).toMatchObject({ clipType: 'hold', at: 0, hold: 2, opacity: 0.7, x: 12 });
    expect(still?.assetEntry).toBeDefined();
    expect(JSON.stringify(source)).toBe(sourceBefore);
    const guard = scanExportConfig(projection.config, collectBuiltInKnownIds(), collectExtensionDeclaredIds([]));
    expect(guard.unknownClipTypes).toEqual(['unknown-custom']);
  });

  it('preserves fixture layer order and properties inside the occurrence while merging audio lanes', () => {
    const composition = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      tracks: orderFixture.shot_tracks,
    }));
    const projection = projectCanonicalComposition(composition, {
      output: { resolution: '1280x720', fps: 30, file: 'canonical.mp4' },
      tracks: orderFixture.film_tracks.map((track) => ({ ...track, kind: track.kind === 'audio' ? 'audio' as const : 'visual' as const })),
      clips: [], registry: {},
    });
    // The joined Timeline model isolates child visuals by occurrence; shared
    // parent layer names must not collapse the child's authored stack.
    expect(projection.config.tracks.map((track) => track.id)).toEqual([
      'occ-1~chrome', 'occ-1~type', 'occ-1~fx', 'occ-1~sprite', 'occ-1~plate',
      'occ-1~video', 'occ-1~audio', 'occ-2~video', 'occ-3~video', 'occ-4~video', 'occ-5~video',
      'picture', 'sprite', 'plate', 'vo', 'music', 'sfx', 'audio',
    ]);
    expect(projection.config.tracks.find((track) => track.id === 'occ-1~fx')).toMatchObject({
      ...orderFixture.shot_tracks.find((track) => track.id === 'fx')!,
      id: 'occ-1~fx', app: { group: { id: 'occ-1', sourceTrack: 'fx' } },
    });
    const audioIds = new Set([...orderFixture.film_tracks, ...orderFixture.shot_tracks]
      .filter(track => track.kind === 'audio').map(track => track.id));
    expect(projection.config.tracks.filter(track => track.kind === 'audio').map(track => track.id))
      .toEqual([...orderFixture.expected_order.filter(id => audioIds.has(id)), 'audio']);
  });

  it('keeps overlapping missing-row occurrences in occurrence order within one fallback block', () => {
    const composition = {
      ...prepared,
      occurrences: prepared.occurrences.slice(0, 2).map((occurrence, index) => ({
        ...occurrence, atMs: 0, durationMs: 2000, trackId: `missing-row-${index}`,
      })),
    };
    const projection = projectCanonicalComposition(composition, {
      output: { resolution: '1920x1080', fps: 30, file: 'fallback.mp4' },
      tracks: [{ id: 'parent', kind: 'visual', label: 'Parent' }],
      clips: [], registry: {},
    });
    expect(projection.config.tracks.filter((track) => track.kind === 'visual').map((track) => track.id))
      .toEqual(['occ-1~video', 'occ-2~video', 'parent']);
    expect(projection.warnings).toEqual(composition.occurrences.map((occurrence) => ({
      severity: 'warning', code: 'timeline-patch/target-not-found',
      message: `shot-layering: track "${occurrence.trackId}" not found — placing occurrence "${occurrence.occurrenceId}" at top of stack`,
    })));
    expect(projection.config.clips.filter((clip) => clip.track.endsWith('~video')).map((clip) => clip.at))
      .toEqual([0, 0]);
  });

  const collisionTimingCases = [
    {
      name: 'inherited trim', raw: { from: 0.125, to: 2.125 }, durationMs: 2000, extentMs: 2000,
      visual: { from: 0.475, to: 2.475, hold: undefined, speed: 1.5 },
      audio: { from: 0.125, to: 2.125, hold: undefined, speed: undefined },
    },
    {
      name: 'inherited hold', raw: { from: 0.125, hold: 4 }, durationMs: 4000, extentMs: 4000,
      visual: { from: 0.475, to: undefined, hold: 4, speed: 1.5 },
      audio: { from: 0.125, to: undefined, hold: 4, speed: undefined },
    },
    {
      name: 'explicit trim speed', raw: { from: 0.125, to: 4.125, speed: 2 }, durationMs: 4000, extentMs: 2000,
      visual: { from: 0.475, to: 4.475, hold: undefined, speed: 2 },
      audio: { from: 0.125, to: 4.125, hold: undefined, speed: 2 },
    },
    {
      name: 'explicit hold speed', raw: { from: 0.125, hold: 4, speed: 2 }, durationMs: 4000, extentMs: 2000,
      visual: { from: 0.475, to: undefined, hold: 4, speed: 2 },
      audio: { from: 0.125, to: undefined, hold: 4, speed: 2 },
    },
  ];

  it.each(collisionTimingCases)('uses a child visual declaration over parent audio for $name', ({ raw, visual, durationMs, extentMs }) => {
    const child = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      tracks: [{ id: 'video', kind: 'visual', label: 'Child' }],
      clips: [{ id: 'collision', asset: 'alpha-image', clipType: 'media', track: 'video', at: 0, ...raw }],
    }));
    const composition = { ...child, occurrences: [{
      ...child.occurrences[0], sourceOffsetMs: 350, speed: 1.5,
    }] };
    const projection = projectCanonicalComposition(composition, {
      output: { resolution: '1920x1080', fps: 30, file: 'collision.mp4' },
      tracks: [{ id: 'video', kind: 'audio', label: 'Parent' }], clips: [], registry: {},
    });
    const clip = projection.config.clips[0];
    expect(clip).toMatchObject({
      id: 'occ-1:collision', track: 'occ-1~video', at: 0,
      app: { canonicalTiming: {
        sourceOffsetMs: 350, occurrenceSpeed: 1.5, speed: visual.speed, durationMs,
        occurrenceStartMs: 0, occurrenceDurationMs: extentMs, storedOccurrenceDurationMs: 2000,
      } },
    });
    expect({ from: clip.from, to: clip.to, hold: clip.hold, speed: clip.speed }).toStrictEqual(visual);
    expect(getClipTimelineDuration(clip)).toBeCloseTo(durationMs / 1000 / visual.speed, 6);
  });

  it.each(collisionTimingCases)('uses a child audio declaration over parent visual for $name', ({ raw, audio, durationMs, extentMs }) => {
    const child = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      tracks: [{ id: 'video', kind: 'audio', label: 'Child audio' }],
      clips: [{ id: 'collision', asset: 'alpha-image', clipType: 'media', track: 'video', at: 0, ...raw }],
    }));
    const composition = { ...child, occurrences: [{
      ...child.occurrences[0], sourceOffsetMs: 350, speed: 1.5,
    }] };
    const projection = projectCanonicalComposition(composition, {
      output: { resolution: '1920x1080', fps: 30, file: 'collision.mp4' },
      tracks: [{ id: 'video', kind: 'visual', label: 'Parent' }], clips: [], registry: {},
    });
    expect(projection.config.tracks).toEqual([
      { id: 'video', kind: 'visual', label: 'Parent' },
      { id: 'occ-1~video', kind: 'audio', label: 'Child audio' },
    ]);
    const clip = projection.config.clips[0];
    expect(clip).toMatchObject({
      id: 'occ-1:collision', track: 'occ-1~video', at: 0,
      app: { canonicalTiming: {
        sourceOffsetMs: 350, occurrenceSpeed: 1.5, speed: audio.speed ?? 1, durationMs,
        occurrenceStartMs: 0, occurrenceDurationMs: extentMs, storedOccurrenceDurationMs: 2000,
      } },
    });
    expect({ from: clip.from, to: clip.to, hold: clip.hold, speed: clip.speed }).toStrictEqual(audio);
    expect(getClipTimelineDuration(clip)).toBeCloseTo(durationMs / 1000 / (audio.speed ?? 1), 6);
  });

  it.each([false, true])('keeps undeclared visual tracks local when another occurrence declares audio (reverse %s)', (reverse) => {
    let source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline, tracks: [],
      clips: [{ id: 'visual', asset: 'alpha-image', clipType: 'media', track: 'shared', at: 0, from: 0, to: 2 }],
    }));
    source = withOccurrenceRevision(source, 1, (timeline) => ({
      ...timeline, tracks: [{ id: 'shared', kind: 'audio' }],
      clips: [{ id: 'audio', asset: 'alpha-image', clipType: 'media', track: 'shared', at: 0, from: 0, to: 2 }],
    }));
    const occurrences = source.occurrences.slice(0, 2).map((occurrence, index) => ({
      ...occurrence, atMs: index * 10000, trackId: 'picture', sourceOffsetMs: 350, speed: 1.5,
    }));
    const projection = projectCanonicalComposition({ ...source, occurrences: reverse ? occurrences.reverse() : occurrences }, {
      output: { resolution: '1920x1080', fps: 30, file: 'independent.mp4' },
      tracks: [{ id: 'picture', kind: 'visual', label: 'Picture' }], clips: [], registry: {},
    });
    expect(projection.config.tracks.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 'occ-1~shared', kind: 'visual' }, { id: 'picture', kind: 'visual' }, { id: 'shared', kind: 'audio' },
    ]);
    expect(projection.config.clips.find((clip) => clip.id === 'occ-1:visual')).toMatchObject({
      track: 'occ-1~shared', from: 0.35, to: 2.35, speed: 1.5,
    });
    const audio = projection.config.clips.find((clip) => clip.id === 'occ-2:audio');
    expect(audio).toMatchObject({ track: 'shared', from: 0, to: 2 });
    expect(audio?.speed).toBeUndefined();
  });

  it.each([
    { transform: { opacity: 0.5 } },
    { transform: { x: 0 } },
    { transform: { cropAnything: 0 } },
    { transform: { scale: 1.2 } },
    { opacity: 0.5 },
  ])('refuses picture-changing shot placement %j', (placement) => {
    const graph = structuredClone(fixture);
    Object.assign(graph.occurrences[0], placement);
    const composition = createShotCompositionAdapter({ load: async () => graph }).prepare(graph);

    expect(() => projectCanonicalComposition(composition)).toThrow(CanonicalCompositionProjectionError);
    try {
      projectCanonicalComposition(composition);
    } catch (error) {
      expect(error).toMatchObject({ code: 'unsupported_placement', occurrenceId: 'occ-1' });
    }
  });

  it.each([
    { transform: {} },
    { transform: { futureHint: 'preserve' } },
    { transform: { opacity: 1 } },
    { transform: { scale: 1 } },
    { opacity: 1 },
  ])('accepts no-op or opaque shot placement %j', (placement) => {
    const graph = structuredClone(fixture);
    Object.assign(graph.occurrences[0], placement);
    const composition = createShotCompositionAdapter({ load: async () => graph }).prepare(graph);

    expect(() => projectCanonicalComposition(composition)).not.toThrow();
  });

  it('applies placement timing to visual media and keeps occurrence timing metadata-only for audio', () => {
    const graph = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    const vector = mediaProjectionFixture;
    const occurrences = graph.occurrences as Array<Record<string, unknown>>;
    Object.assign(occurrences[0]!, vector.occurrence);
    Object.assign(occurrences[1]!, vector.next_occurrence);
    const revision = graph.shot_revisions.find((item) => item.shot_id === 'shot-alpha' && item.revision_id === 'rev-a')!;
    const timeline = revision.internal_timeline_revision.timeline as Record<string, unknown>;
    timeline.tracks = vector.tracks;
    timeline.clips = vector.clips;
    revision.assets = vector.assets as typeof revision.assets;

    const parentClip = vector.parent_clip;
    const parentConfig = {
      output: { resolution: '1280x720', fps: 30, file: 'canonical.mp4' },
      tracks: [{ id: 'parent-visual-lane', kind: 'visual' as const, label: 'Shots' }],
      clips: [parentClip] as ResolvedTimelineConfig['clips'],
      registry: { 'standalone-source': { file: 'standalone.png', type: 'image/png' } },
    } as ResolvedTimelineConfig;
    const composition = createShotCompositionAdapter({ load: async () => graph }).prepare(graph);
    const projection = projectCanonicalComposition(composition, parentConfig);
    const projected = new Map(
      projection.config.clips
        .filter((clip) => clip.id.startsWith('occ-1:'))
        .map((clip) => [clip.id.slice('occ-1:'.length), clip]),
    );

    for (const [id, expected] of Object.entries(vector.expected)) {
      const clip = projected.get(id)!;
      expect(clip).toBeDefined();
      expect(clip).toMatchObject({
        at: expected.at,
        from: expected.from,
        ...(expected.to === undefined ? {} : { to: expected.to }),
        ...(expected.hold === undefined ? {} : { hold: expected.hold }),
        ...(expected.speed === undefined ? {} : { speed: expected.speed }),
      });
      expect(getClipTimelineDuration(clip)).toBeCloseTo(expected.timeline_duration, 6);
    }
    expect(projected.get('audio-track-inherited')?.speed).toBeUndefined();
    expect(projected.get('audio-asset-inferred')?.speed).toBeUndefined();
    expect(projected.get('audio-clip-type-inferred')?.speed).toBeUndefined();
    expect(projected.get('audio-track-inherited')?.app?.canonicalTiming)
      .toMatchObject({ sourceOffsetMs: 350, occurrenceSpeed: 1.5, speed: 1 });
    expect(projected.get('visual-trim-inherited')?.app?.canonicalTiming).toMatchObject({ sourceOffsetMs: 350, speed: 1.5 });
    expect(projection.config.registry['occ-1:lane-audio-source'] ?? projection.config.registry['lane-audio-source'])
      .toMatchObject({ media_id: 'object-lane-audio-source', type: 'audio/wav' });
    expect(projection.config.clips.find((clip) => clip.id === 'parent-standalone')).toMatchObject(parentClip);
    expect(timeline.clips).toEqual(vector.clips);
  });

  it('keeps authored visual properties in the occurrence block and audio on merged lanes', () => {
    const shotTracks = [
      { id: 'chrome', kind: 'visual', label: 'Chrome', opacity: 0.8 },
      { id: 'type', kind: 'visual', label: 'Type', scale: 1.2 },
      { id: 'fx', kind: 'visual', label: 'Fx', blend: 'screen', opacity: 0.7 },
      { id: 'sprite', kind: 'visual', label: 'Sprite' },
      { id: 'plate', kind: 'visual', label: 'Plate' },
      { id: 'vo', kind: 'audio', label: 'VO' },
      { id: 'sfx', kind: 'audio', label: 'Sfx', volume: 0.6 },
      { id: 'audio', kind: 'audio', label: 'Audio' },
    ];
    const composition = withOccurrenceRevision(prepared, 0, (timeline) => ({ ...timeline, tracks: shotTracks }));
    const projection = projectCanonicalComposition(composition, {
      output: { resolution: '1280x720', fps: 30, file: 'canonical.mp4' },
      tracks: [
        { id: 'picture', kind: 'visual', label: 'Picture' },
        { id: 'sprite', kind: 'visual', label: 'Sprite' },
        { id: 'plate', kind: 'visual', label: 'Plate' },
        { id: 'vo', kind: 'audio', label: 'VO' },
        { id: 'music', kind: 'audio', label: 'Music' },
      ],
      clips: [], registry: {},
    });
    expect(projection.config.tracks.map((track) => track.id)).toEqual([
      'occ-1~chrome', 'occ-1~type', 'occ-1~fx', 'occ-1~sprite', 'occ-1~plate',
      'occ-1~video', 'occ-2~video', 'occ-3~video', 'occ-4~video', 'occ-5~video',
      'picture', 'sprite', 'plate', 'vo', 'music', 'sfx', 'audio',
    ]);
    expect(projection.config.tracks.find((track) => track.id === 'occ-1~fx')).toMatchObject({
      ...shotTracks.find((track) => track.id === 'fx'),
      id: 'occ-1~fx', app: { group: { id: 'occ-1', sourceTrack: 'fx' } },
    });
    expect(projection.config.tracks.find((track) => track.id === 'sfx')).toMatchObject(shotTracks[6]);
  });

  it('attaches one frame-domain seam report to the canonical config shared by preview and export', () => {
    const projection = projectCanonicalComposition(prepared);
    const contract = projection.config.app?.visualSeamContract as Record<string, unknown> | undefined;
    const report = contract?.report as Record<string, unknown> | undefined;

    expect(contract).toMatchObject({ version: 1, mode: 'enforced' });
    expect(report).toMatchObject({ version: 1, fps: 30, guardFrames: 2 });
    expect(Array.isArray(report?.boundaries)).toBe(true);
    expect(report?.opaqueElements).toEqual([]);
    expect(report).toEqual((projectCanonicalComposition(prepared).config.app?.visualSeamContract as Record<string, unknown>).report);
  });

  it('preserves frame-level seam intent while refreshing canonical report metadata', () => {
    const projection = projectCanonicalComposition(prepared, {
      output: { resolution: '1920x1080', fps: 30, file: 'intent.mp4' },
      tracks: [],
      clips: [],
      registry: {},
      app: {
        visualSeamContract: {
          intents: { '1259': 'synchronized' },
          customDisclosure: 'kept',
        },
      },
    });
    expect(projection.config.app?.visualSeamContract).toMatchObject({
      version: 1,
      mode: 'enforced',
      intents: { '1259': 'synchronized' },
      customDisclosure: 'kept',
    });
  });

  it('preserves authored child cue metadata through canonical projection', () => {
    const graph = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: (timeline.clips as Array<Record<string, unknown>>).map((clip, index) => index === 0 ? {
        ...clip,
        elementRef: { id: 'element-child-1', kind: 'effect', revision: 'fx-r2' },
        effects: { blur: 0.4 },
        transition: { type: 'crossfade', duration: 0.25 },
        entrance: { type: 'fade', duration: 0.5 },
        exit: { type: 'fade', duration: 0.25 },
        keyframes: { x: [{ time: 0, value: 0, interpolation: 'linear' }, { time: 1, value: 10, interpolation: 'linear' }] },
      } : clip),
    }));
    const projection = projectCanonicalComposition(graph);
    expect(projection.config.clips.find((clip) => clip.id === 'occ-1:alpha-video')).toMatchObject({
      elementRef: { id: 'element-child-1', kind: 'effect', revision: 'fx-r2' },
      effects: { blur: 0.4 },
      transition: { type: 'crossfade', duration: 0.25 },
      entrance: { type: 'fade', duration: 0.5 },
      exit: { type: 'fade', duration: 0.25 },
      keyframes: { x: [{ time: 0, value: 0, interpolation: 'linear' }, { time: 1, value: 10, interpolation: 'linear' }] },
    });
  });

  it('keeps plate resolution and text data available to the renderer', () => {
    const graph = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [
        ...(timeline.clips as Array<Record<string, unknown>>),
        {
          id: 'title',
          clip_type: 'text',
          track: 'video',
          at_ms: 0,
          duration_ms: 1000,
          text: { content: 'A text clip', fontSize: 64 },
        },
      ],
    }));
    graph.occurrences[0] = {
      ...graph.occurrences[0],
      revision: {
        ...graph.occurrences[0].revision,
        assets: graph.occurrences[0].revision.assets.map((asset) => ({
          ...asset,
          resolution: asset.asset_id === 'alpha-image' ? '1536x1024' : asset.resolution,
        })),
      },
    };

    const projection = projectCanonicalComposition(graph);
    const plate = projection.config.clips.find((clip) => clip.id === 'occ-1:alpha-video');
    const title = projection.config.clips.find((clip) => clip.id === 'occ-1:title');

    expect(projection.config.output.resolution).toBe('1920x1080');
    expect(projection.config.registry['alpha-image']?.resolution).toBe('1536x1024');
    expect(plate?.assetEntry?.resolution).toBe('1536x1024');
    expect(title).toMatchObject({
      clipType: 'text',
      text: { content: 'A text clip', fontSize: 64 },
    });
  });

  it('leaves an unset volume unset instead of freezing the effective value', () => {
    const graph = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    for (const occurrence of graph.occurrences) {
      delete (occurrence as Record<string, unknown>).gain;
      delete (occurrence as Record<string, unknown>).muted;
    }
    const projection = projectCanonicalComposition(
      createShotCompositionAdapter({ load: async () => graph }).prepare(graph),
    );
    const projected = projection.config.clips.filter((clip) => clip.id.startsWith('occ-'));
    expect(projected.length).toBeGreaterThan(0);
    // The fixture authors no volume or gain anywhere.
    for (const clip of projected) expect(clip.volume).toBeUndefined();
  });

  it('projects occurrence timing and source/audio controls without legacy group or shot clips', () => {
    const graph = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    graph.occurrences[0] = {
      ...graph.occurrences[0],
      source_offset: 350,
      speed: 1.5,
      gain: 0.65,
      muted: true,
    };
    const projection = projectCanonicalComposition(
      createShotCompositionAdapter({ load: async () => graph }).prepare(graph),
      {
        output: { resolution: '1280x720', fps: 24, file: 'canonical.mp4' },
        tracks: [
          { id: 'frame', kind: 'visual', label: 'Frame' },
          { id: 'picture', kind: 'visual', label: 'Shots' },
        ],
        clips: [
          { id: 'parent-overlay', at: 0, track: 'frame', clipType: 'media', hold: 120, asset: 'frame-asset' },
          { id: 'legacy-shot', at: 0, track: 'picture', clipType: 'shot', hold: 2 },
        ],
        registry: {
          'frame-asset': { file: 'frame.png', type: 'image/png' },
        },
      },
    );
    const first = projection.config.clips.find((clip) => clip.id === 'occ-1:alpha-video');
    expect(first).toMatchObject({
      at: 0,
      speed: 1.5,
      from: 0.35,
      volume: 0,
      hold: 2,
      app: { canonicalTiming: { sourceOffsetMs: 350, speed: 1.5, gain: 0.65, muted: true } },
    });
    expect(first?.app).toMatchObject({
      canonical: {
        projectId: 'project-001',
        parentDocumentId: 'document-primary',
        occurrenceId: 'occ-1',
        shotId: 'shot-alpha',
        revisionId: 'rev-a',
        internalTimelineRevisionId: 'timeline-alpha-a',
        outputIdentity: 'project/project-001/document/document-primary/occurrence/occ-1/output/final-video',
      },
    });
    expect(JSON.stringify(projection.config)).not.toContain('pinnedShotGroups');
    expect(JSON.stringify(projection.config)).not.toContain('"clipType":"shot"');
    expect(projection.config.clips.some((clip) => clip.id === 'parent-overlay')).toBe(true);
    expect(projection.config.clips.some((clip) => clip.id === 'legacy-shot')).toBe(false);
    expect(projection.config.tracks.map((track) => track.id)).toEqual(expect.arrayContaining(['frame', 'picture']));
    expect(projection.config.registry['frame-asset']).toMatchObject({ file: 'frame.png' });
    expect(first?.assetEntry).toMatchObject({
      file: 'object-alpha-image',
      media_id: 'object-alpha-image',
      src: '/api/astrid/v1/objects/object-alpha-image',
    });
  });

  it.each([undefined, 'output'] as const)('keeps child Source visuals in their occurrence with sibling role %s', (role) => {
    const normalized = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      tracks: [
        { id: 'source-video', kind: 'visual', label: 'Interview', role: 'source' },
        { id: 'video', kind: 'visual', label: 'Output cut', ...(role ? { role } : {}) },
      ],
      clips: [
        { id: 'long-source', asset: 'missing-source', clipType: 'media', track: 'source-video', at_ms: 0, duration_ms: 90000 },
        { id: 'short-output', asset: 'alpha-image', clipType: 'media', track: 'video', at_ms: 0, duration_ms: 10000 },
      ],
    }));
    const projection = projectCanonicalComposition(normalized, {
      output: { resolution: '1280x720', fps: 30, file: 'canonical.mp4' },
      tracks: [
        { id: 'video', kind: 'visual', label: 'Parent source', role: 'source' },
        { id: 'overlay', kind: 'visual', label: 'Overlay' },
      ],
      clips: [{ id: 'parent-source', at: 0, track: 'video', asset: 'missing-parent', hold: 90 }],
      registry: {},
    });

    expect(projection.config.clips.map((clip) => clip.id)).toEqual(expect.arrayContaining([
      'occ-2:alpha-video',
      'occ-2:alpha-audio',
      'occ-3:alpha-video-b',
      'occ-4:beta-video',
      'occ-5:alpha-copy-video',
      'occ-1:short-output',
      'occ-1:long-source',
    ]));
    expect(projection.config.clips).toHaveLength(7);
    expect(projection.config.clips.find((clip) => clip.id === 'occ-1:long-source'))
      .toMatchObject({ track: 'occ-1~source-video', hold: 4 });
    expect(projection.config.clips.some((clip) => clip.id === 'parent-source')).toBe(false);
    expect(projection.config.tracks.find((track) => track.id === 'occ-1~source-video')).toMatchObject({
      kind: 'visual', role: 'output', app: { group: { id: 'occ-1', sourceTrack: 'source-video' } },
    });
    expect(projection.config.tracks.find((track) => track.id === 'occ-1~video')).toMatchObject({ kind: 'visual' });
    expect(projection.config.tracks.find((track) => track.id === 'occ-1~video')?.role).toBe(role);
    expect(projection.config.clips.find((clip) => clip.id === 'occ-1:short-output')?.hold).toBe(4);
    expect(projection.config.clips.find((clip) => clip.id === 'occ-1:short-output')?.app?.canonicalTiming)
      .toMatchObject({ occurrenceDurationMs: 4000 });
    expect(projection.config.registry).not.toHaveProperty('missing-source');
    expect(projection.config.registry).not.toHaveProperty('missing-parent');
    expect((normalized.occurrences[0].revision.internal_timeline_revision as {
      timeline: { tracks: unknown[] };
    }).timeline.tracks).toEqual([
      { id: 'source-video', kind: 'visual', label: 'Interview', role: 'source' },
      { id: 'video', kind: 'visual', label: 'Output cut', ...(role ? { role } : {}) },
    ]);
  });

  it('classifies parent Source ownership before filtering tracks, even when a child reuses the ID', () => {
    const composition: PreparedShotComposition = {
      ...prepared,
      occurrences: prepared.occurrences.map((occurrence, index) => index === 0
        ? { ...occurrence, trackId: 'video' }
        : index === 1 ? { ...occurrence, trackId: 'output-lane' } : occurrence),
    };
    const projection = projectCanonicalComposition(composition, {
      output: { resolution: '1280x720', fps: 30, file: 'canonical.mp4' },
      tracks: [
        { id: 'video', kind: 'visual', label: 'Parent source', role: 'source' },
        { id: 'output-lane', kind: 'visual', label: 'Parent output', role: 'output' },
      ],
      clips: [{ id: 'parent-source', at: 0, track: 'video', asset: 'parent-source-asset', hold: 60 }],
      registry: { 'parent-source-asset': { file: 'parent-source-object', type: 'image/png' } },
    });

    expect(projection.config.clips.some((clip) => clip.id.startsWith('occ-1:'))).toBe(false);
    expect(projection.config.clips.some((clip) => clip.id === 'occ-2:alpha-video')).toBe(true);
    expect(projection.config.clips.some((clip) => clip.id === 'parent-source')).toBe(false);
    expect(projection.config.tracks.find((track) => track.id === 'occ-2~video')).toMatchObject({ kind: 'visual' });
    expect(projection.config.tracks.find((track) => track.id === 'occ-2~video')?.role).not.toBe('source');
    expect(projection.config.registry).not.toHaveProperty('parent-source-asset');
    expect(projection.config.app?.canonicalComposition).toMatchObject({ occurrenceIds: ['occ-2', 'occ-3', 'occ-4', 'occ-5'] });
  });

  it('keeps linked occurrences distinct while retaining their shared revision identity', () => {
    const projection = projectCanonicalComposition(prepared);
    const first = projection.config.clips.find((clip) => clip.id === 'occ-1:alpha-video');
    const linked = projection.config.clips.find((clip) => clip.id === 'occ-2:alpha-video');
    expect(first?.app?.canonical).toMatchObject({ occurrenceId: 'occ-1', revisionId: 'rev-a' });
    expect(linked?.app?.canonical).toMatchObject({ occurrenceId: 'occ-2', revisionId: 'rev-a' });
    expect(projection.occurrenceIdentities.get('occ-1')).not.toBe(projection.occurrenceIdentities.get('occ-2'));
    expect(projection.occurrenceIdentities.get('occ-1')?.revisionId)
      .toBe(projection.occurrenceIdentities.get('occ-2')?.revisionId);
  });

  it('keeps selected asset keys scoped to each occurrence when immutable revisions bind different objects', () => {
    const source: PreparedShotComposition = {
      ...prepared,
      occurrences: prepared.occurrences.map((occurrence, index) => index !== 1 ? occurrence : {
        ...occurrence,
        revisionId: 'rev-a-revised',
        revision: {
          ...occurrence.revision,
          revision_id: 'rev-a-revised',
          assets: (occurrence.revision.assets as Array<Record<string, unknown>>).map((asset) => (
            asset.asset_id === 'alpha-image' ? { ...asset, object_id: 'object-revised-alpha-image' } : asset
          )),
        },
      }),
    };
    const projection = projectCanonicalComposition(source);
    const first = projection.config.clips.find((clip) => clip.id === 'occ-1:alpha-video');
    const revised = projection.config.clips.find((clip) => clip.id === 'occ-2:alpha-video');
    expect(first?.asset).not.toBe(revised?.asset);
    expect(first?.assetEntry?.file).toBe('object-alpha-image');
    expect(revised?.assetEntry?.file).toBe('object-revised-alpha-image');
    expect(source.occurrences[0]?.revision.assets).toEqual(prepared.occurrences[0]?.revision.assets);
  });

  it('preserves parent clip media when a child uses the same asset key for a different object', () => {
    const projection = projectCanonicalComposition(prepared, {
      output: { resolution: '1920x1080', fps: 30, file: 'test.mp4' },
      tracks: [{ id: 'parent', kind: 'visual' }],
      clips: [{ id: 'parent-image', at: 0, track: 'parent', asset: 'alpha-image', hold: 1 }],
      registry: { 'alpha-image': { file: 'object-parent-image', media_id: 'object-parent-image', type: 'image' } },
    });
    const parent = projection.config.clips.find((clip) => clip.id === 'parent-image');
    const child = projection.config.clips.find((clip) => clip.id === 'occ-1:alpha-video');
    expect(parent?.assetEntry?.file).toBe('object-parent-image');
    expect(child?.assetEntry?.file).toBe('object-alpha-image');
    expect(parent?.asset).not.toBe(child?.asset);
  });

  it('scopes a reused asset alias by occurrence only when its pinned objects differ', () => {
    const source: PreparedShotComposition = {
      ...prepared,
      occurrences: prepared.occurrences.map((occurrence) => {
        if (occurrence.occurrenceId !== 'occ-3') return occurrence;
        return {
          ...occurrence,
          revision: {
            ...occurrence.revision,
            runtime_playback_assets: [{
              asset_id: 'alpha-image',
              object_id: 'object-alpha-image-take-2',
              digest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
              media_type: 'image/png',
            }],
          },
        };
      }),
    };

    const projection = projectCanonicalComposition(source);
    const first = projection.config.clips.find((clip) => clip.id === 'occ-1:alpha-video');
    const secondCut = projection.config.clips.find((clip) => clip.id === 'occ-3:alpha-video-b');

    expect(first).toMatchObject({ asset: 'canonical:occ-1:alpha-image', assetEntry: { file: 'object-alpha-image' } });
    expect(secondCut).toMatchObject({ asset: 'canonical:occ-3:alpha-image', assetEntry: { file: 'object-alpha-image-take-2' } });
    expect(projection.config.registry).toHaveProperty('canonical:occ-1:alpha-image');
    expect(projection.config.registry).toHaveProperty('canonical:occ-3:alpha-image');
    expect(projection.config.registry['alpha-image']).toBeUndefined();
  });

  it('clips an overlong child to the occurrence in the parent projection', () => {
    const source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [{
        id: 'overlong-child',
        asset: 'alpha-image',
        clipType: 'image',
        track: 'video',
        at: 0,
        hold: 5,
      }],
    }));
    const parentClip = projectCanonicalComposition(source).config.clips.find((clip) => clip.id === 'occ-1:overlong-child');
    const localClip = projectCanonicalComposition(source, undefined, { clampToOccurrenceDuration: false }).config.clips.find((clip) => clip.id === 'occ-1:overlong-child');

    // The child has 5s of content, but occ-2 starts at 4s on the same
    // parent lane, so the parent projection is half-open at 4s.
    expect(parentClip?.hold).toBe(4);
    expect(localClip?.hold).toBe(5);
  });

  it('caps content-derived occurrence duration at the next same-lane cut', () => {
    const source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [{
        id: 'contiguous-overlong-child',
        asset: 'alpha-image',
        clipType: 'image',
        track: 'video',
        at: 0,
        hold: 5,
      }],
    }));
    const clip = projectCanonicalComposition(source).config.clips.find(
      (candidate) => candidate.id === 'occ-1:contiguous-overlong-child',
    );

    expect(clip).toMatchObject({ at: 0, hold: 4 });
    expect(clip?.app?.canonicalTiming).toMatchObject({ occurrenceDurationMs: 4000 });
  });

  it.each([0.5, 2])('applies playback speed once for video/audio and keeps clipping idempotent at speed %s', (speed) => {
    const source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      tracks: [
        { id: 'video', kind: 'visual' },
        { id: 'audio', kind: 'audio' },
      ],
      clips: [
        { id: 'video-source', asset: 'alpha-image', clipType: 'media', track: 'video', at_ms: 0, hold: 4, speed },
        { id: 'audio-source', asset: 'alpha-image', clipType: 'media', track: 'audio', at_ms: 0, hold: 4, speed },
      ],
    }));
    const singleOccurrence = { ...source, occurrences: [source.occurrences[0]!] };
    const projected = projectCanonicalComposition(singleOccurrence, undefined, { clampToOccurrenceDuration: false });
    const expectedTimelineDuration = 4 / speed;

    const internal = source.occurrences[0]?.revision.internal_timeline_revision as Record<string, unknown> | undefined;
    expect(timelineContentExtentMs(internal?.timeline)).toBe(expectedTimelineDuration * 1000);
    for (const clip of projected.config.clips) {
      expect(clip.hold).toBe(4);
      expect(getClipTimelineDuration(clip)).toBe(expectedTimelineDuration);
      const boundedOnce = boundCanonicalClipToOccurrence({
        ...clip,
        app: { ...clip.app, canonicalTiming: { ...clip.app?.canonicalTiming, occurrenceDurationMs: expectedTimelineDuration * 1000 } },
      });
      const boundedTwice = boundedOnce && boundCanonicalClipToOccurrence(boundedOnce);
      expect(boundedOnce?.hold).toBe(4);
      expect(boundedTwice?.hold).toBe(4);
      expect(boundedTwice && getClipTimelineDuration(boundedTwice)).toBe(expectedTimelineDuration);
    }

    // The persisted child timeline remains in source units across a graph
    // prepare/project round trip; speed is still applied exactly once.
    const serialized = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    const occurrenceRevisionId = source.occurrences[0]!.revisionId;
    const sourceTimeline = internal?.timeline;
    serialized.shot_revisions = serialized.shot_revisions.map((revision) => revision.revision_id === occurrenceRevisionId
      ? {
          ...revision,
          internal_timeline_revision: {
            ...revision.internal_timeline_revision,
            timeline: sourceTimeline as typeof revision.internal_timeline_revision.timeline,
          },
        }
      : revision);
    const roundTrip = createShotCompositionAdapter({ load: async () => serialized }).prepare(serialized);
    const projectedAgain = projectCanonicalComposition({ ...roundTrip, occurrences: [roundTrip.occurrences[0]!] }, undefined, { clampToOccurrenceDuration: false });
    expect(projectedAgain.config.clips.map((clip) => clip.hold)).toEqual([4, 4]);
  });

  it('preserves editor-form seconds and child trim windows when flattening a shot', () => {
    const source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [{
        id: 'editor-form-frame',
        asset: 'alpha-image',
        clipType: 'image',
        track: 'video',
        at: 0.5,
        from: 12.25,
        to: 12.75,
        x: 10,
        y: 20,
        width: 640,
        height: 360,
      }],
    }));
    const projection = projectCanonicalComposition(source);
    const clip = projection.config.clips.find((candidate) => candidate.id === 'occ-1:editor-form-frame');

    expect(clip).toMatchObject({
      at: 0.5,
      from: 12.25,
      to: 12.75,
      x: 10,
      y: 20,
      width: 640,
      height: 360,
    });
    expect(clip?.hold).toBeUndefined();
  });

  it('skips null and malformed revision assets while projecting valid assets', () => {
    const source: PreparedShotComposition = {
      ...prepared,
      occurrences: prepared.occurrences.map((candidate, index) => index === 0
        ? {
            ...candidate,
            revision: {
              ...candidate.revision,
              assets: [
                null,
                { asset_id: 'malformed-asset' },
                ...(candidate.revision.assets as Array<Record<string, unknown>>),
              ],
            },
          }
        : candidate),
    };

    const projection = projectCanonicalComposition(source);

    expect(projection.config.registry['alpha-image']).toMatchObject({
      file: 'object-alpha-image',
    });
    expect(projection.config.registry).not.toHaveProperty('malformed-asset');
  });

  it('uses canonical asset media kinds when the parent registry omitted them', () => {
    const source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [{
        id: 'child-video',
        asset: 'child-video-asset',
        clipType: 'media',
        track: 'video',
        at: 0,
        from: 0,
        to: 1,
      }],
    }));
    const occurrence = source.occurrences[0]!;
    const withVideoAsset: PreparedShotComposition = {
      ...source,
      occurrences: source.occurrences.map((candidate, index) => index === 0
        ? {
            ...candidate,
            revision: {
              ...candidate.revision,
              assets: [
                ...(candidate.revision.assets as Array<Record<string, unknown>>),
                {
                  asset_id: 'child-video-asset',
                  object_id: 'object-child-video',
                  digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
                  role: 'video',
                  source: { type: 'video' },
                },
              ],
            },
          }
        : candidate),
    };
    const projection = projectCanonicalComposition(withVideoAsset, {
      output: { resolution: '1280x720', fps: 24, file: 'canonical.mp4' },
      tracks: [{ id: 'video', kind: 'visual', label: 'Video' }],
      clips: [],
      registry: {
        'child-video-asset': { file: 'stale-image.png', type: 'image/png' },
      },
    });
    const clip = projection.config.clips.find((candidate) => candidate.id === `${occurrence.occurrenceId}:child-video`);

    expect(clip?.assetEntry).toMatchObject({ type: 'video', file: 'object-child-video' });
  });

  it('projects normalized revision assets with their canonical media kind', () => {
    const source: PreparedShotComposition = {
      ...prepared,
      occurrences: prepared.occurrences.map((candidate, index) => index === 0
        ? {
            ...candidate,
            revision: {
              ...candidate.revision,
              assets: [
                ...(candidate.revision.assets as Array<Record<string, unknown>>),
                {
                  asset_id: 'alpha-audio',
                  object_id: 'object-alpha-audio',
                  digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
                  role: 'audio',
                  scope: { project_id: 'project-001' },
                },
              ],
            },
          }
        : candidate),
    };
    const projection = projectCanonicalComposition(source, {
      output: { resolution: '1280x720', fps: 24, file: 'canonical.mp4' },
      tracks: [{ id: 'audio', kind: 'audio', label: 'Audio' }],
      clips: [],
      registry: {},
    });
    const clip = projection.config.clips.find((candidate) => candidate.id === 'occ-1:alpha-audio');

    expect(clip?.assetEntry).toMatchObject({
      file: 'object-alpha-audio',
      media_id: 'object-alpha-audio',
      type: 'audio',
      src: '/api/astrid/v1/objects/object-alpha-audio',
    });
  });

  it('preserves a valid existing media kind and URL for an untyped canonical asset', () => {
    const source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [{
        id: 'existing-video',
        asset: 'existing-video-asset',
        clipType: 'media',
        track: 'video',
        at: 0,
        from: 0,
        to: 1,
      }],
    }));
    const withUntypedAsset: PreparedShotComposition = {
      ...source,
      occurrences: source.occurrences.map((candidate, index) => index === 0
        ? {
            ...candidate,
            revision: {
              ...candidate.revision,
              assets: [
                ...(candidate.revision.assets as Array<Record<string, unknown>>),
                {
                  asset_id: 'existing-video-asset',
                  object_id: 'object-existing-video',
                  digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
                  role: 'source',
                },
              ],
            },
          }
        : candidate),
    };
    const projection = projectCanonicalComposition(withUntypedAsset, {
      output: { resolution: '1280x720', fps: 24, file: 'canonical.mp4' },
      tracks: [{ id: 'video', kind: 'visual', label: 'Video' }],
      clips: [],
      registry: {
        'existing-video-asset': {
          file: 'object-existing-video',
          media_id: 'object-existing-video',
          src: '/existing-video.mp4',
          type: 'video/mp4',
        },
      },
    });
    const clip = projection.config.clips.find((candidate) => candidate.id === 'occ-1:existing-video');

    expect(clip?.assetEntry).toMatchObject({
      type: 'video/mp4',
      file: 'object-existing-video',
      src: '/existing-video.mp4',
    });
  });

  it('does not inherit a media kind from an unrelated object with the same asset id', () => {
    const source = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [{
        id: 'replaced-video',
        asset: 'replaced-video-asset',
        clipType: 'media',
        track: 'video',
        at: 0,
        from: 0,
        to: 1,
      }],
    }));
    const withUntypedReplacement: PreparedShotComposition = {
      ...source,
      occurrences: source.occurrences.map((candidate, index) => index === 0
        ? {
            ...candidate,
            revision: {
              ...candidate.revision,
              assets: [
                ...(candidate.revision.assets as Array<Record<string, unknown>>),
                {
                  asset_id: 'replaced-video-asset',
                  object_id: 'object-replaced-video',
                  digest: 'sha256:6666666666666666666666666666666666666666666666666666666666666666',
                  role: 'source',
                },
              ],
            },
          }
        : candidate),
    };
    const projection = projectCanonicalComposition(withUntypedReplacement, {
      output: { resolution: '1280x720', fps: 24, file: 'canonical.mp4' },
      tracks: [{ id: 'video', kind: 'visual', label: 'Video' }],
      clips: [],
      registry: {
        'replaced-video-asset': {
          file: 'stale-object',
          media_id: 'stale-object',
          src: '/stale-video.mp4',
          type: 'video/mp4',
        },
      },
    });
    const clip = projection.config.clips.find((candidate) => candidate.id === 'occ-1:replaced-video');

    expect(clip?.assetEntry).toMatchObject({
      type: 'image',
      file: 'object-replaced-video',
    });
    expect(clip?.assetEntry?.src).not.toBe('/stale-video.mp4');
  });

  it('rejects missing dependencies before downstream projection', () => {
    const contract = {
      ...prepared.contract,
      shot_revisions: prepared.contract.shot_revisions.filter((revision) => revision.shot_id !== 'shot-beta'),
    };
    expect(() => projectCanonicalComposition({ ...prepared, contract })).toThrowError(
      expect.objectContaining({ code: 'missing_dependency' }),
    );
  });

  it('rejects unsupported deeper nesting and blank child output', () => {
    const nested = withOccurrenceRevision(prepared, 0, (timeline) => ({
      ...timeline,
      clips: [{ ...(timeline.clips as Array<Record<string, unknown>>)[0], clip_type: 'shot' }],
    }));
    expect(() => projectCanonicalComposition(nested)).toThrowError(
      expect.objectContaining({ code: 'unsupported_nesting' }),
    );

    const blank = withOccurrenceRevision(prepared, 0, (timeline) => ({ ...timeline, clips: [] }));
    expect(() => projectCanonicalComposition(blank)).toThrowError(
      expect.objectContaining({ code: 'blank_child_output' }),
    );
    expect(() => projectCanonicalComposition(blank)).toThrow(CanonicalCompositionProjectionError);
  });

  it('matches managed outputs only to occurrence-qualified metadata', () => {
    const occurrence = prepared.occurrences[0]!;
    expect(managedOutputMatchesOccurrence({ provenance: { output_identity: occurrence.outputIdentity } }, occurrence)).toBe(true);
    expect(managedOutputMatchesOccurrence({ provenance: { occurrence_id: 'occ-2' } }, occurrence)).toBe(false);
    expect(managedOutputMatchesOccurrence({ shot_id: occurrence.shotId }, occurrence)).toBe(false);
  });
});
