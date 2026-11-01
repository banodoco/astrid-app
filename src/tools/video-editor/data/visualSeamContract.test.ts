import { describe, expect, it } from 'vitest';

import type { ResolvedTimelineConfig } from '@/tools/video-editor/types/index.ts';
import {
  analyzeVisualSeams,
  assertVisualSeamAdmission,
  VisualSeamAdmissionError,
  withVisualSeamIntent,
} from './visualSeamContract.ts';

function config(clips: ResolvedTimelineConfig['clips'], app?: ResolvedTimelineConfig['app']): ResolvedTimelineConfig {
  return {
    output: { resolution: '1920x1080', fps: 30, file: 'seams.mp4' },
    tracks: [
      { id: 'video', kind: 'visual', label: 'Picture' },
      { id: 'fx', kind: 'visual', label: 'FX' },
    ],
    clips,
    registry: {},
    app,
  };
}

function media(id: string, at: number, hold: number, asset: string, extra: Partial<ResolvedTimelineConfig['clips'][number]> = {}) {
  return { id, at, hold, asset, track: 'video', clipType: 'media', ...extra };
}

describe('visual seam contract', () => {
  it('admits custom picture owners only on declared picture tracks, independently of continuity tracks', () => {
    const base = config([
      media('picture-a', 0, 1, 'a'),
      media('picture-b', 1, 1, 'b'),
      {id: 'plate', clipType: 'am-footage', track: 'plate', at: 0.9, hold: 0.2},
    ], {
      visualSeamContract: { mode: 'enforced', pictureTracks: ['plate'], continuityTracks: ['video'] },
    });
    base.tracks.push({id: 'plate', kind: 'visual', label: 'Plate'});

    const report = analyzeVisualSeams(base, {enforceIntent: true});

    expect(report.structuralIssues).toEqual([]);
    expect(report.opaqueElements).toEqual([expect.objectContaining({clipId: 'plate', clipType: 'am-footage'})]);
    expect(report.cues.some((cue) => cue.kind === 'activation' && cue.path.includes('plate'))).toBe(false);
    expect(report.boundaries[0]?.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({clipId: 'plate', behavior: 'opaque'}),
    ]));
  });

  it('uses authored continuityTracks for gap and overlap checks when no analysis override is supplied', () => {
    const base = config([
      media('picture-a', 0, 1, 'a', {label: 'Opening'}),
      media('picture-b', 2, 1, 'b', {label: 'Closing'}),
      {id: 'plate-a', clipType: 'am-footage', track: 'plate', at: 0, hold: 2},
      {id: 'plate-b', clipType: 'am-footage', track: 'plate', at: 1, hold: 2},
    ], {visualSeamContract: {pictureTracks: ['plate'], continuityTracks: ['video']}});
    base.tracks.push({id: 'plate', kind: 'visual', label: 'Plate'});

    const report = analyzeVisualSeams(base);

    expect(report.structuralIssues).toHaveLength(1);
    expect(report.structuralIssues[0]).toContain("0:02.0 · Gap on Picture between 'Opening' and 'Closing'");
  });

  it('uses frame ownership rather than float seconds for a contiguous hard cut', () => {
    const report = analyzeVisualSeams(config([
      media('shot-09', 0, 33.8, 'a'),
      media('shot-10', 33.8, 8.1666666667, 'b'),
    ]));

    expect(report.boundaries).toHaveLength(1);
    expect(report.boundaries[0]).toMatchObject({ frame: 1014, timeSeconds: 33.8, unacknowledgedRisk: false });
    expect(report.boundaries[0]?.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ clipId: 'shot-09', behavior: 'exits' }),
      expect.objectContaining({ clipId: 'shot-10', behavior: 'enters' }),
      expect.objectContaining({ clipId: 'shot-10', behavior: 'source-change' }),
    ]));
  });

  it('uses duration_ms and duration before hold/trim bounds, applying playback speed', () => {
    const durationMsClip = {
      ...media('duration-ms', 0, 1, 'a', { from: 0, to: 10, speed: 2 }),
      duration_ms: 4000,
    };
    const durationClip = {
      ...media('duration-seconds', 0, 1, 'a', { from: 0, to: 10, speed: 3 }),
      duration: 6,
    };

    for (const first of [durationMsClip, durationClip]) {
      const report = analyzeVisualSeams(config([
        first,
        media('next', 2, 1, 'b'),
      ]));

      expect(report.structuralIssues).toEqual([]);
      expect(report.boundaries[0]?.frame).toBe(60);
    }
  });

  it('reports a coincident opaque effect and preserves parent/child ownership and effect identity', () => {
    const report = analyzeVisualSeams(config([
      media('shot-10', 0, 41.9666666667, 'a', {
        app: { canonical: { parentDocumentId: 'timeline', occurrenceId: 'occ-10' } },
      }),
      media('shot-11', 41.9666666667, 4, 'b', {
        app: { canonical: { parentDocumentId: 'timeline', occurrenceId: 'occ-11' } },
      }),
      {
        id: 'fx-process-v3',
        at: 41.9666666667,
        hold: 0.5,
        track: 'fx',
        clipType: 'custom-process',
        elementRef: { id: 'fx-process-v3', kind: 'effect', revision: 'rev-1' },
      },
    ]));

    // An overlay effect of undisclosed timing is not a full-screen picture: it is not opaque and raises no warning.
    expect(report.boundaries[0]).toMatchObject({ frame: 1259, unacknowledgedRisk: false });
    expect(report.boundaries[0]?.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: 'occ-11', behavior: 'enters', path: ['parent', 'timeline', 'occurrence', 'occ-11', 'clip', 'shot-11'] }),
    ]));
    expect(report.boundaries[0]?.participants.some((item) => item.behavior === 'opaque')).toBe(false);
    expect(report.opaqueElements).toEqual([]);
  });

  it('does not flag overlay effects active across a cut, and analyses without loading media', () => {
    const source = config([
      media('a', 0, 2, 'a'),
      media('b', 2, 2, 'b'),
      {
        id: 'long-effect',
        at: 0.5,
        hold: 2,
        track: 'fx',
        clipType: 'custom-effect',
        elementRef: { id: 'wipe-v2', kind: 'effect', revision: 'rev-7', packId: 'pack-a' },
      },
    ]);
    const metadataOnly = new Proxy(source, {
      get(target, property, receiver) {
        if (property === 'registry') throw new Error('seam analysis must not access media registry entries');
        return Reflect.get(target, property, receiver);
      },
    });

    const report = analyzeVisualSeams(metadataOnly);
    expect(report.boundaries[0]).toMatchObject({ frame: 60, unacknowledgedRisk: false });
    expect(report.opaqueElements).toEqual([]);
  });

  it('does not treat adjacency between effect clips as structural picture continuity', () => {
    const report = analyzeVisualSeams(config([
      media('picture', 0, 3, 'picture'),
      {
        id: 'effect-a', at: 0, hold: 1, track: 'fx', clipType: 'custom-effect',
        elementRef: { id: 'wipe-a', kind: 'effect', revision: 'r1' },
      },
      {
        id: 'effect-b', at: 1 + (1 / 30), hold: 1, track: 'fx', clipType: 'custom-effect',
        elementRef: { id: 'wipe-b', kind: 'effect', revision: 'r1' },
      },
    ]));

    expect(report.structuralIssues).toEqual([]);
    expect(report.opaqueElements).toHaveLength(0);
  });

  it('honors explicit frame intent over implicit transition metadata and synchronized cues', () => {
    const base = config([
      media('a', 0, 2, 'a'),
      media('b', 2, 2, 'b', { transition: { type: 'crossfade', duration: 0.5 } }),
      { id: 'motion', at: 2, hold: 1, track: 'fx', clipType: 'media', entrance: {type: 'fade', duration: 0.5}, elementRef: { id: 'motion', kind: 'effect', revision: 'r1' } },
    ]);
    expect(analyzeVisualSeams(base).boundaries[0]).toMatchObject({ intent: 'transition', requiresIntent: true, unacknowledgedRisk: true });
    const synchronized = withVisualSeamIntent(base, 60, 'synchronized');
    expect(analyzeVisualSeams(synchronized).boundaries[0]).toMatchObject({ intent: 'synchronized', requiresIntent: false, unacknowledgedRisk: false });
    const explicitHardCut = withVisualSeamIntent(base, 60, 'hard-cut');
    expect(analyzeVisualSeams(explicitHardCut).boundaries[0]).toMatchObject({ intent: 'hard-cut', requiresIntent: true, unacknowledgedRisk: true });
    expect(() => assertVisualSeamAdmission(explicitHardCut, { enforceIntent: true })).toThrow(VisualSeamAdmissionError);
  });

  it('rejects structural gaps/overlaps and leaves media out of the analysis', () => {
    const report = analyzeVisualSeams(config([
      media('a', 0, 1, 'a'),
      media('b', 1 + (1 / 30), 1, 'b'),
      { id: 'overlay', at: 0, hold: 3, track: 'fx', clipType: 'effect-layer' },
    ]));
    expect(report.structuralIssues).toHaveLength(1);
    expect(() => assertVisualSeamAdmission(config([
      media('a', 0, 1, 'a'),
      media('b', 1 + (1 / 30), 1, 'b'),
    ]))).toThrow(VisualSeamAdmissionError);
  });

  it('requires explicit intent only when admission enforcement is requested', () => {
    const unsafe = config([
      media('a', 0, 2, 'a'),
      media('b', 2, 2, 'b'),
      { id: 'motion', at: 2, hold: 1, track: 'fx', clipType: 'media', entrance: {type: 'fade', duration: 0.5}, elementRef: { id: 'motion', kind: 'effect', revision: 'r1' } },
    ]);
    expect(analyzeVisualSeams(unsafe).boundaries[0]?.intent).toBeUndefined();
    expect(analyzeVisualSeams(unsafe).boundaries[0]?.unacknowledgedRisk).toBe(true);
    expect(() => assertVisualSeamAdmission(unsafe, { enforceIntent: true })).toThrow(VisualSeamAdmissionError);
    const acknowledged = withVisualSeamIntent(unsafe, 60, 'synchronized');
    expect(() => assertVisualSeamAdmission(acknowledged, { enforceIntent: true })).not.toThrow();
    expect(analyzeVisualSeams(acknowledged).boundaries[0]).toMatchObject({ intent: 'synchronized', requiresIntent: false, unacknowledgedRisk: false });
  });

  it('binds stored intent to the current boundary participants and leaves a second boundary untouched', () => {
    const original = config([
      media('a', 0, 2, 'a'),
      media('b', 2, 2, 'b'),
      { id: 'motion-a', at: 2, hold: 0.5, track: 'fx', clipType: 'media', entrance: {type: 'fade', duration: 0.5}, elementRef: { id: 'motion-a', kind: 'effect', revision: 'r1' } },
      media('c', 4, 2, 'c'),
      { id: 'motion-b', at: 4, hold: 0.5, track: 'fx', clipType: 'media', entrance: {type: 'fade', duration: 0.5}, elementRef: { id: 'motion-b', kind: 'effect', revision: 'r1' } },
    ]);
    const acknowledged = withVisualSeamIntent(original, 60, 'synchronized');
    const report = analyzeVisualSeams(acknowledged);
    expect(report.boundaries.find((boundary) => boundary.frame === 60)?.requiresIntent).toBe(false);
    expect(report.boundaries.find((boundary) => boundary.frame === 120)?.requiresIntent).toBe(true);
    const edited = {
      ...acknowledged,
      clips: acknowledged.clips.map((clip) => clip.id === 'motion-a' ? { ...clip, id: 'motion-a-edited' } : clip),
    };
    expect(analyzeVisualSeams(edited).boundaries.find((boundary) => boundary.frame === 60)?.requiresIntent).toBe(true);
  });

  it('stays metadata-only for a large synthetic seam matrix', () => {
    const clips = Array.from({ length: 500 }, (_, index) => media(
      `clip-${index}`,
      index * 1.0,
      1,
      `asset-${index}`,
    ));
    const metadataOnly = new Proxy(config(clips), {
      get(target, property, receiver) {
        if (property === 'registry') throw new Error('seam analysis must not access media registry entries');
        return Reflect.get(target, property, receiver);
      },
    });
    analyzeVisualSeams(metadataOnly);
    const report = analyzeVisualSeams(metadataOnly);
    expect(report.boundaries).toHaveLength(499);
  });

  it('does not flag same-track overlaps on overlay tracks, or mark custom overlay clips opaque', () => {
    const report = analyzeVisualSeams(config([
      media('picture-a', 0, 2, 'a'),
      {id: 'flap', clipType: 'am-flap', track: 'fx', at: 0.5, hold: 1, elementRef: {id: 'flap', kind: 'element'}},
      {id: 'c-skip-pill', clipType: 'am-pill', track: 'fx', at: 0.8, hold: 1, elementRef: {id: 'pill', kind: 'element'}, label: 'Skip'},
      {id: 'sprite-1', clipType: 'media', track: 'fx', asset: 's', at: 0.6, hold: 1, width: 200, height: 100},
      {id: 'sprite-2', clipType: 'media', track: 'fx', asset: 's', at: 0.7, hold: 1, width: 200, height: 100},
    ]));

    expect(report.structuralIssues).toEqual([]);
    expect(report.opaqueElements).toEqual([]);
    expect(report.warningCount).toBe(0);
  });

  it('reports overlapping full-frame picture clips in one plain line', () => {
    const report = analyzeVisualSeams(config([
      media('a', 0, 2, 'a', {label: 'Opening'}),
      media('b', 1.5, 2, 'b', {label: 'Plate'}),
    ]));

    expect(report.structuralIssues).toEqual(["0:01.5 · Two full-screen clips overlap on Picture: 'Opening' and 'Plate'"]);
    expect(report.blocked).toBe(true);
  });
});

describe('grouped source-track seam mapping', () => {
  function grouped(source: ResolvedTimelineConfig, occurrence = 'occ~private') {
    return {
      ...source,
      tracks: source.tracks.map((track) => ({ ...track, id: `${occurrence}~${track.id}`, app: { group: { id: occurrence, sourceTrack: track.id } } })),
      clips: source.clips.map((clip) => ({ ...clip, track: `${occurrence}~${clip.track}` })),
    };
  }

  it('maps authored continuity and picture policy through sourceTrack, without parsing ~ ids', () => {
    const source = config([
      { id: 'a', track: 'video', clipType: 'am-footage', at: 0, hold: 1 },
      { id: 'b', track: 'video', clipType: 'am-footage', at: 2, hold: 1 },
    ], { visualSeamContract: { continuityTracks: ['video'], pictureTracks: ['video'] } });
    const report = analyzeVisualSeams(grouped(source));
    expect(report.structuralIssues).toEqual(analyzeVisualSeams(source).structuralIssues);
    expect(report.structuralIssues).toHaveLength(1);
    expect(report.structuralIssues[0]).not.toContain('~');
    expect(analyzeVisualSeams(grouped(source), { continuityTracks: ['video'] }).structuralIssues).toEqual(report.structuralIssues);
  });

  it('honours source-track pause declarations inside a group', () => {
    const source = config([media('a', 0, 1, 'a'), media('b', 2, 1, 'b')], {
      visualSeamContract: { continuityTracks: ['video'], gaps: [{ kind: 'pause', track: 'video', startFrame: 30, endFrame: 60 }] },
    });
    expect(analyzeVisualSeams(grouped(source)).structuralIssues).toEqual([]);
  });

  it('keeps different occurrence lanes independent even when their source tracks overlap', () => {
    const first = grouped(config([media('a', 0, 2, 'a')]), 'one');
    const second = grouped(config([media('b', 1, 2, 'b')]), 'two');
    const combined = { ...first, tracks: [...first.tracks, ...second.tracks], clips: [...first.clips, ...second.clips] };
    expect(analyzeVisualSeams(combined).structuralIssues).toEqual([]);
  });

  it('keeps portable intent contexts stable across internal track renaming', () => {
    const source = config([media('a', 0, 1, 'a'), media('b', 1, 1, 'b')]);
    const authored = withVisualSeamIntent(source, 30, 'hard-cut');
    const projected = withVisualSeamIntent(grouped(source), 30, 'hard-cut');
    expect(projected.app?.visualSeamContract).toEqual(authored.app?.visualSeamContract);
  });
});
