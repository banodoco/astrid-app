import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {normalizeClipPlacementWithFindings} from '@banodoco/timeline-composition';

describe('placement authority', () => {
  it('uses package placement in preview, handles, track and canonicalization', () => {
    const source = (file: string) => readFileSync(`src/tools/video-editor/${file}`, 'utf8');
    expect(source('compositions/VisualClip.tsx')).toContain('resolveClipPlacement(');
    expect(source('components/PreviewPanel/OverlayEditor.tsx')).toContain('resolveClipPlacement(');
    expect(source('components/PreviewPanel/OverlayEditor.tsx')).toContain('resolveTrackTransform(');
    expect(source('compositions/TimelineRenderer.tsx')).toContain('resolveTrackTransform(');
    expect(source('lib/timeline-domain.ts')).toContain('normalizeClipPlacementWithFindings(');
    expect(source('compositions/VisualClip.tsx')).not.toContain('computeViewportMediaLayout(');
    expect(source('components/PreviewPanel/OverlayEditor.tsx')).not.toContain('scaleBoundsAboutCenter(');
  });
  it('exposes the installed normalizer and reports legacy changes', () => {
    const input = {output: {resolution: '1280x720', fps: 30, file: 'out.mp4'}, tracks: [{id: 'V1', kind: 'visual' as const}], clips: [{id: 'c', at: 0, track: 'V1', asset: 'a', x: 10}]};
    const result = normalizeClipPlacementWithFindings(input);
    expect(result.config.clips[0]).toMatchObject({x: 10, fit: 'cover'});
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({trackId: 'V1', clipId: 'c', kind: 'explicit-fit'})]));
    expect(input.clips[0]).not.toHaveProperty('fit');
  });
});
