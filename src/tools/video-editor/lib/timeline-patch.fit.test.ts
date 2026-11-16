import {describe, expect, it} from 'vitest';
import {compileTimelinePatch, validateTimelinePatch} from './timeline-patch';
import type {TimelineData} from './timeline-data';

describe('clip fit patch custody', () => {
  const makeData = (): TimelineData => ({
    config: {output: {resolution: '1280x720', fps: 30, file: 'out.mp4'}, tracks: [{id: 'V1', kind: 'visual', label: 'V1'}], clips: [{id: 'c', at: 0, track: 'V1', hold: 2, fit: 'cover'}]},
    clips: [{id: 'c', at: 0, track: 'V1', hold: 2, fit: 'cover'}], tracks: [{id: 'V1', kind: 'visual', label: 'V1'}],
    meta: {c: {track: 'V1', hold: 2, fit: 'cover'}}, clipOrder: {V1: ['c']}, output: {resolution: '1280x720', fps: 30, file: 'out.mp4'}, registry: {assets: {}}, configVersion: 1, resolvedConfig: {registry: {}},
  } as unknown as TimelineData);
  it('keeps fit edits in clip metadata and clears old fit on replacement', () => {
    const merge = compileTimelinePatch({version: 1, operations: [{op: 'clip.update', target: 'c', payload: {fit: 'contain'}}]}, makeData());
    expect(merge.valid).toBe(true);
    expect(merge.mutation?.metaUpdates?.c.fit).toBe('contain');
    const replace = compileTimelinePatch({version: 1, operations: [{op: 'clip.update', target: 'c', payload: {mode: 'replace', hold: 1}}]}, makeData());
    expect(replace.valid).toBe(true);
    expect(replace.mutation?.metaUpdates?.c.fit).toBeUndefined();
  });
  it('rejects an unsupported fit value', () => {
    expect(validateTimelinePatch({version: 1, operations: [{op: 'clip.update', target: 'c', payload: {fit: 'stretch'}}]}).valid).toBe(false);
  });
});

describe('new track placement custody', () => {
  const empty = () => ({config: {output: {resolution: '1280x720', fps: 30, file: 'out.mp4'}, tracks: [], clips: []}, clips: [], tracks: [], meta: {}, clipOrder: {}, output: {resolution: '1280x720', fps: 30, file: 'out.mp4'}, registry: {assets: {}}, configVersion: 1, resolvedConfig: {registry: {}}} as unknown as TimelineData);
  it.each([false, true])('keeps a new clip authored on a new track, scaled=%s', scaled => {
    const operations = [
      {op: 'track.add', target: 'V2', payload: {kind: 'visual', label: 'V2'}},
      ...(scaled ? [{op: 'track.update', target: 'V2', payload: {mode: 'replace', kind: 'visual', label: 'V2', scale: 2, fit: 'contain'}}] : []),
      {op: 'clip.add', target: 'c', payload: {track: 'V2', at: 0, clipType: 'media'}},
      {op: 'clip.update', target: 'c', payload: {asset: 'a', hold: 1, x: 0, y: 10, width: 640, height: 360, cropLeft: 0.1}},
    ];
    const result = compileTimelinePatch({version: 1, operations} as never, empty());
    expect(result.valid).toBe(true);
    expect(result.nextData?.config.clips[0]).toMatchObject({x: 0, y: 10, width: 640, height: 360, cropLeft: 0.1});
    expect(result.nextData?.config.clips[0]).not.toHaveProperty('fit');
    expect(result.nextData?.config.tracks?.[0]).toMatchObject({app: {scaleAppliesToPositionedClips: true, clipPlacementVersion: 1}, ...(scaled ? {scale: 2, fit: 'contain'} : {})});
  });
  it('stamps tracks auto-created by clip insertion and movement', () => {
    const add = compileTimelinePatch({version: 1, operations: [{op: 'clip.add', target: 'c', payload: {track: 'V2', at: 0, clipType: 'media'}}, {op: 'clip.update', target: 'c', payload: {hold: 1, x: 0}}]}, empty());
    expect(add.valid).toBe(true);
    expect(add.nextData?.config.tracks?.[0].app).toMatchObject({scaleAppliesToPositionedClips: true, clipPlacementVersion: 1});
    expect(add.nextData?.config.clips[0]).not.toHaveProperty('fit');
    const move = compileTimelinePatch({version: 1, operations: [{op: 'clip.move', target: 'c', payload: {track: 'V3', at: 0}}]}, add.nextData!);
    expect(move.valid).toBe(true);
    expect(move.nextData?.config.tracks?.find(track => track.id === 'V3')?.app).toMatchObject({scaleAppliesToPositionedClips: true, clipPlacementVersion: 1});
  });
});

it('refuses malformed supplied markers rather than restoring previous markers', () => {
  const data = {config: {output: {resolution: '1280x720', fps: 30, file: 'out.mp4'}, tracks: [{id: 'V1', kind: 'visual', label: 'V1', app: {scaleAppliesToPositionedClips: true, clipPlacementVersion: 1}}], clips: []}, clips: [], tracks: [{id: 'V1', kind: 'visual', label: 'V1', app: {scaleAppliesToPositionedClips: true, clipPlacementVersion: 1}}], meta: {}, clipOrder: {V1: []}, output: {resolution: '1280x720', fps: 30, file: 'out.mp4'}, registry: {assets: {}}, configVersion: 1, resolvedConfig: {registry: {}}} as unknown as TimelineData;
  expect(() => compileTimelinePatch({version: 1, operations: [{op: 'track.update', target: 'V1', payload: {mode: 'replace', kind: 'visual', label: 'V1', app: {scaleAppliesToPositionedClips: 'invalid'}}}]}, data)).toThrow(/V1.*scaleAppliesToPositionedClips/);
});
