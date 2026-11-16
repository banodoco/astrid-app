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
