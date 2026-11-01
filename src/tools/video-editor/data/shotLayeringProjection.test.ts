import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import layeringFixture from './shot-layering-v1.fixture.json';
import compositionFixture from './shotComposition.fixture.json';
import { createShotCompositionAdapter } from './shotCompositionAdapter.ts';
import { CanonicalCompositionProjectionError, projectCanonicalComposition } from './shotCompositionProjection.ts';
import { projectOutputTimelineConfig } from './timelineOutputProjection.ts';
import { coversFrame, visualSeamSourceTrack } from './visualSeamCoverage.ts';
import type { ResolvedTimelineConfig, TimelineClip } from '@/tools/video-editor/types/index.ts';
import { getClipTimelineDuration } from '@/tools/video-editor/lib/config-utils.ts';

// Exact shared Agent/Runtime fixture bytes.
const canonicalPath = 'conformance/fixtures/shot-layering-v1.json';
const canonicalSha256 = '4900be369f31bd03736b7eadaf2f8595a7ce48df5218296d405162cb13cfc16c';

type LayeringCase = typeof layeringFixture.cases[number];

function projectCase(testCase: LayeringCase, app?: ResolvedTimelineConfig['app']) {
  const composition = createShotCompositionAdapter({ load: async () => testCase.input }).prepare(testCase.input);
  const parent = testCase.input.parent_composition.config;
  const base: ResolvedTimelineConfig = {
    output: { resolution: '1920x1080', fps: 30, file: 'layers.mp4' },
    tracks: parent.tracks.map((track) => ({ label: track.id, ...track, kind: track.kind as 'visual' | 'audio' })),
    clips: parent.clips.map((clip) => ({
      ...clip, clipType: clip.clip_type, asset: clip.asset_id, at: clip.at_ms / 1000, hold: clip.duration_ms / 1000,
    })),
    registry: parent.registry.assets as ResolvedTimelineConfig['registry'],
    app,
  };
  return projectCanonicalComposition(composition, base);
}

describe('shared Runtime shot-layering projection cases', () => {
  it('keeps an exact-byte Runtime fixture copy with a pinned canonical hash', () => {
    const bytes = readFileSync(resolve('src/tools/video-editor/data/shot-layering-v1.fixture.json'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(canonicalSha256);
    // A Runtime checkout is optional for standalone App tests, as with other
    // colocated projection fixtures. Qualification also compares canonical bytes.
    const checkout = process.env.ASTRID_RUNTIME_CHECKOUT;
    if (checkout) {
      const file = resolve(checkout, canonicalPath);
      if (existsSync(file)) expect(bytes.equals(readFileSync(file))).toBe(true);
    }
    const canonicalFile = process.env.SHOT_LAYERING_CANONICAL_FIXTURE;
    if (canonicalFile) {
      expect(bytes.equals(readFileSync(canonicalFile))).toBe(true);
    }
  });

  it('retains parent-lane gap admission and authored pauses between separate groups', () => {
    const testCase = layeringFixture.cases.find((entry) => entry.id === 'two-shots-one-row')!;
    const report = (app?: ResolvedTimelineConfig['app']) => projectCase(testCase, app).config.app?.visualSeamContract as {
      report: { structuralIssues: string[]; blocked: boolean };
    };
    expect(report().report.structuralIssues).toHaveLength(1);
    expect(report().report.blocked).toBe(true);
    const gaps = [{ kind: 'pause', track: 'picture', startFrame: 60, endFrame: 75 }];
    expect(report({ visualSeamContract: { gaps } }).report.structuralIssues).toEqual([]);
    expect(report({ visualSeamContract: { gaps: [{ ...gaps[0], endFrame: 76 }] } }).report.blocked).toBe(true);
  });

  it('keeps canonical Source visuals eligible for output and source-track seam mapping', () => {
    const testCase = layeringFixture.cases.find((entry) => entry.id === 'film-picture-over-type')!;
    const { config } = projectCase(testCase);
    const track = config.tracks.find((entry) => entry.id === 'occ-vision~source-plate');
    const clip = config.clips.find((entry) => entry.id === 'occ-vision:vision-source-plate')!;
    expect(track).toMatchObject({
      role: 'output', app: { group: { id: 'occ-vision', sourceTrack: 'source-plate' } },
    });
    expect(clip).toMatchObject({
      track: 'occ-vision~source-plate', asset: 'vision-footage', assetEntry: { file: 'object-vision-footage' },
    });
    expect(coversFrame(clip, track, config)).toBe(true);
    expect(visualSeamSourceTrack(track)).toBe('source-plate');
    const output = projectOutputTimelineConfig(config);
    expect(output.excludedClipIds).toEqual([]);
    expect(output.config.clips).toContainEqual(clip);
    expect(testCase.input.shot_revisions[0].internal_timeline_revision.timeline.tracks)
      .toContainEqual({ id: 'source-plate', kind: 'visual', role: 'source' });
  });

  it.each(['child-audio-parent-visual', 'child-visual-parent-audio'])('preserves App playback timing for %s', (caseId) => {
    const testCase = layeringFixture.cases.find((entry) => entry.id === caseId)!;
    const { config } = projectCase(testCase);
    const visual = caseId === 'child-visual-parent-audio';
    // App derives the occurrence extent from child content (4s); the shared
    // fixture's stored 2s placement remains provenance, not a playback cap.
    const expected = [
      { id: 'trim-inherited', from: visual ? 0.475 : 0.125, to: visual ? 2.475 : 2.125, hold: undefined, speed: visual ? 1.5 : undefined, durationMs: 2000, timelineDuration: visual ? 2 / 1.5 : 2 },
      { id: 'hold-inherited', from: visual ? 0.475 : 0.125, to: undefined, hold: 4, speed: visual ? 1.5 : undefined, durationMs: 4000, timelineDuration: visual ? 4 / 1.5 : 4 },
      { id: 'trim-child-speed', from: visual ? 0.475 : 0.125, to: visual ? 4.475 : 4.125, hold: undefined, speed: 2, durationMs: 4000, timelineDuration: 2 },
      { id: 'hold-child-speed', from: visual ? 0.475 : 0.125, to: undefined, hold: 4, speed: 2, durationMs: 4000, timelineDuration: 2 },
      { id: 'compatible-audio', from: 0.125, to: 2.125, hold: undefined, speed: undefined, durationMs: 2000, timelineDuration: 2 },
    ];
    for (const { id, durationMs, timelineDuration, ...timing } of expected) {
      const clip = config.clips.find((entry) => entry.id === `occ-collision:${id}`)!;
      expect(clip).toBeDefined();
      expect(clip.at).toBe(1);
      expect({ from: clip.from, to: clip.to, hold: clip.hold, speed: clip.speed }).toStrictEqual(timing);
      expect(getClipTimelineDuration(clip)).toBeCloseTo(timelineDuration, 6);
      expect(clip.app?.canonicalTiming).toStrictEqual({
        sourceOffsetMs: 350, occurrenceSpeed: 1.5, speed: timing.speed ?? 1,
        gain: 1, muted: false, durationMs, occurrenceTrackId: 'picture',
        occurrenceStartMs: 1000, occurrenceDurationMs: 4000, storedOccurrenceDurationMs: 2000,
      });
    }
    expect(config.clips.find((clip) => clip.id === 'parent-clip')).toMatchObject({ at: 0.5, hold: 1, track: 'shared' });
  });

  it.each(layeringFixture.cases)('$id', (testCase) => {
    const before = JSON.stringify(testCase);
    const projection = projectCase(testCase);
    const { config } = projection;
    const trackIds = new Set(config.tracks.map((track) => track.id));
    expect(trackIds.size).toBe(config.tracks.length);
    expect(config.clips.every((clip) => trackIds.has(clip.track))).toBe(true);
    expect(config.tracks.map((track) => track.id)).toEqual(testCase.expected.track_order);
    if ('track_kinds' in testCase.expected) {
      expect(Object.fromEntries(config.tracks.map((track) => [track.id, track.kind])))
        .toEqual(testCase.expected.track_kinds);
    }
    expect(config.tracks.filter((track) => track.app?.group).map(({ id, app, role }) => ({ id, app, ...(role ? { role } : {}) })))
      .toEqual(testCase.expected.group_tracks);
    expect(projection.warnings).toEqual(testCase.expected.warnings);
    expect(config.app?.canonicalComposition).toMatchObject({ warnings: testCase.expected.warnings });
    expect(Object.fromEntries(config.clips.map((clip) => [
      projection.clipIdentities.get(clip.id)?.rawClipId ?? clip.id, clip.track,
    ]))).toEqual(testCase.expected.clip_tracks);
    for (const parentTrack of testCase.input.parent_composition.config.tracks) {
      expect(config.tracks.find((track) => track.id === parentTrack.id)).toMatchObject(parentTrack);
    }
    for (const occurrence of testCase.input.occurrences) {
      const shot = testCase.input.shot_revisions.find((revision) => revision.shot_id === occurrence.shot_id && revision.revision_id === occurrence.revision_id)!;
      const timeline = shot.internal_timeline_revision.timeline;
      const group = config.tracks.filter((track) => (track.app?.group as { id: string } | undefined)?.id === occurrence.occurrence_id);
      const indices = group.map((track) => config.tracks.indexOf(track));
      expect(indices).toEqual(indices.map((_, index) => indices[0] + index));
      for (const rawClip of timeline.clips) {
        const clip = config.clips.find((entry) => entry.id === `${occurrence.occurrence_id}:${rawClip.id}`)!;
        expect(clip).toBeDefined();
        // Trim/speed collision vectors have exact App timing assertions above.
        if (!('from' in rawClip)) {
          expect(clip).toMatchObject({ at: (occurrence.at_ms + rawClip.at_ms) / 1000, hold: rawClip.duration_ms / 1000 });
        }
        if (rawClip.track === 'audio') {
          expect(clip.track).toBe('audio');
          expect(clip.volume).toBeUndefined();
          expect(clip.speed).toBeUndefined();
          expect(config.tracks.filter((track) => track.id === 'audio')).toHaveLength(1);
          expect(config.tracks.find((track) => track.id === 'audio')?.app?.group).toBeUndefined();
        }
      }
    }
    if ('transparent_windows_ms' in testCase.expected) {
      for (const [start, end] of testCase.expected.transparent_windows_ms) {
        const groupIds = new Set(testCase.expected.group_tracks.map((track) => track.id));
        const visuals = config.clips.filter((clip) => groupIds.has(clip.track));
        expect(visuals.some((clip) => clip.at * 1000 < end && (clip.at + (clip.hold ?? 0)) * 1000 > start)).toBe(false);
      }
    }
    expect(JSON.stringify(testCase)).toBe(before);
  });
});

const placementMessage = 'Shot opacity and transforms are not supported yet. Remove them from the shot placement to render this timeline.';

describe('shot placement compositing admission', () => {
  it.each([{ transform: { opacity: 0.5 } }, { transform: { x: 0 } }, { transform: { scale: 1.2 } }, { transform: { cropLeft: 0 } }, { opacity: 0 }])('refuses picture-changing %j', (placement) => {
    const graph = structuredClone(compositionFixture);
    Object.assign(graph.occurrences[0], placement);
    const composition = createShotCompositionAdapter({ load: async () => graph }).prepare(graph);
    expect(() => projectCanonicalComposition(composition)).toThrow(placementMessage);
    try { projectCanonicalComposition(composition); } catch (error) {
      expect(error).toBeInstanceOf(CanonicalCompositionProjectionError);
      expect(error).toMatchObject({ code: 'unsupported_placement', occurrenceId: 'occ-1' });
    }
  });

  it.each([{}, { transform: {} }, { transform: { futureHint: 'preserve' } }, { transform: { opacity: 1 } }, { transform: { scale: 1 } }, { opacity: 1 }, { transform: null, opacity: null }, { transform: '', opacity: '' }, { transform: [], opacity: {} }])('accepts no-op %j and keeps child opacity', (placement) => {
    const graph = structuredClone(compositionFixture);
    Object.assign(graph.occurrences[0], placement);
    const composition = createShotCompositionAdapter({ load: async () => graph }).prepare(graph);
    const first = composition.occurrences[0];
    const timeline = first.revision.internal_timeline_revision as { timeline: { tracks: unknown[] } };
    const local = {
      ...composition,
      occurrences: [{ ...first, revision: { ...first.revision, internal_timeline_revision: {
        timeline: { ...timeline.timeline, clips: [{ id: 'child', clipType: 'media', track: 'video', at: 0, hold: 1, opacity: 0.4, width: 100 }] },
      } } }],
    };
    const child = projectCanonicalComposition(local).config.clips[0] as TimelineClip;
    expect(child).toMatchObject({ opacity: 0.4, width: 100, track: 'occ-1~video' });
  });
});
