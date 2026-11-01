import type { PropsWithChildren } from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TimelineRenderer } from './TimelineRenderer';
import { partitionTrackGroups } from './partitionTrackGroups';
import { INSTALLED_ASTRID_ELEMENT_HOST } from '@/tools/video-editor/runtime/astrid-element-components';
import type { ResolvedTimelineConfig, TrackDefinition } from '@/tools/video-editor/types/index.ts';

vi.mock('remotion', () => ({
  delayRender: () => 0,
  continueRender: () => {},
  AbsoluteFill: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
  Sequence: ({ children }: PropsWithChildren) => <>{children}</>,
  useCurrentFrame: () => 0,
  useRemotionEnvironment: () => ({ isRendering: false, isClientSideRendering: false }),
}));
vi.mock('./VisualClip.tsx', () => ({
  VisualClipSequence: ({ clip }: { clip: { id: string } }) => <div data-testid={clip.id} />,
}));
vi.mock('./EffectLayerSequence.tsx', () => ({
  EffectLayerSequence: ({ clip, children }: PropsWithChildren<{ clip: { id: string } }>) => <div data-testid={clip.id}>{children}</div>,
}));
vi.mock('./AudioAnalysisProvider.tsx', () => ({ AudioAnalysisProvider: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock('./AudioTrack.tsx', () => ({ AudioTrack: ({ track }: { track: TrackDefinition }) => <div data-testid={track.id} /> }));

function track(id: string, group?: string, extras: Partial<TrackDefinition> = {}): TrackDefinition {
  return { id, kind: 'visual', label: id, ...(group ? { app: { group: { id: group, sourceTrack: id.split('~')[1] } } } : {}), ...extras };
}

const config: ResolvedTimelineConfig = {
  output: { resolution: '1920x1080', fps: 30, file: 'groups.mp4' },
  tracks: [
    track('above'),
    track('first~fx', 'first'),
    track('first~blend', 'first', { blendMode: 'screen', opacity: 0.4, scale: 1.2 }),
    track('first~plate', 'first'),
    track('same-row'),
    track('second~fx', 'second'),
    track('second~plate', 'second'),
    track('below'),
    track('audio', undefined, { kind: 'audio' }),
  ],
  clips: [
    { id: 'above-clip', track: 'above', clipType: 'media', at: 0, hold: 1 },
    { id: 'first-fx', track: 'first~fx', clipType: 'effect-layer', at: 0, hold: 1 },
    { id: 'first-blend', track: 'first~blend', clipType: 'media', at: 0, hold: 1 },
    { id: 'first-plate', track: 'first~plate', clipType: 'media', at: 0, hold: 1 },
    { id: 'same-clip', track: 'same-row', clipType: 'media', at: 0, hold: 1 },
    { id: 'second-fx', track: 'second~fx', clipType: 'effect-layer', at: 0, hold: 1 },
    { id: 'second-plate', track: 'second~plate', clipType: 'media', at: 0, hold: 1 },
    { id: 'below-clip', track: 'below', clipType: 'media', at: 0, hold: 1 },
  ],
  registry: {},
};

function preview(value = config) {
  return render(<TimelineRenderer config={value} astridElementHost={INSTALLED_ASTRID_ELEMENT_HOST} />);
}

describe('shot track partitioning', () => {
  it('preserves paint order and groups only contiguous occurrence tracks', () => {
    const tracks = [track('loose'), track('one~type', 'one'), track('one~plate', 'one'), track('other'), track('one~suffix', 'one')];
    expect(partitionTrackGroups(tracks)).toEqual([
      { id: undefined, tracks: [tracks[0]] },
      { id: 'one', tracks: tracks.slice(1, 3) },
      { id: undefined, tracks: [tracks[3]] },
      { id: 'one', tracks: [tracks[4]] },
    ]);
    expect(partitionTrackGroups([])).toEqual([]);
  });
});

describe('TimelineRenderer shot isolation', () => {
  it('keeps each transparent isolated stack at its row, with inner blends/opacity/scale and effect layers scoped to that shot', () => {
    const { container } = preview();
    const first = container.querySelector<HTMLElement>('[data-shot-group="first"]')!;
    const second = container.querySelector<HTMLElement>('[data-shot-group="second"]')!;
    expect(first).toHaveStyle({ isolation: 'isolate' });
    expect(second).toHaveStyle({ isolation: 'isolate' });
    expect(first.style.backgroundColor).toBe('');
    expect(second.style.backgroundColor).toBe('');
    expect(within(first).getByTestId('first-fx')).toContainElement(screen.getByTestId('first-plate'));
    expect(within(first).getByTestId('first-fx')).toContainElement(screen.getByTestId('first-blend'));
    expect(first).not.toContainElement(screen.getByTestId('below-clip'));
    expect(first).not.toContainElement(screen.getByTestId('same-clip'));
    expect(first).not.toContainElement(second);
    expect(within(second).getByTestId('second-fx')).toContainElement(screen.getByTestId('second-plate'));
    expect(second).not.toContainElement(screen.getByTestId('below-clip'));
    expect(second).not.toContainElement(first);
    expect(screen.getByTestId('first-blend').parentElement).toHaveStyle({ mixBlendMode: 'screen', opacity: '0.4', transform: 'scale(1.2)' });
    const markers = Array.from(container.querySelectorAll('[data-testid]')).map((element) => element.getAttribute('data-testid'));
    expect(markers).toEqual(['below-clip', 'second-fx', 'second-plate', 'same-clip', 'first-fx', 'first-plate', 'first-blend', 'above-clip', 'audio']);
    expect(screen.getByTestId('audio').closest('[data-shot-group]')).toBeNull();
  });

  it('lets a parent effect layer wrap the completed shot groups', () => {
    preview({
      ...config,
      tracks: [track('parent-fx'), ...config.tracks],
      clips: [{ id: 'parent-effect', track: 'parent-fx', clipType: 'effect-layer', at: 0, hold: 1 }, ...config.clips],
    });
    expect(screen.getByTestId('parent-effect')).toContainElement(screen.getByTestId('first-plate'));
    expect(screen.getByTestId('parent-effect')).toContainElement(screen.getByTestId('second-plate'));
    expect(screen.getByTestId('parent-effect')).toContainElement(screen.getByTestId('below-clip'));
    expect(screen.getByTestId('parent-effect')).not.toContainElement(screen.getByTestId('audio'));
  });

  it('adds no opaque fill for an empty shot group', () => {
    const { container } = preview({ ...config, clips: [] });
    const groups = container.querySelectorAll<HTMLElement>('[data-shot-group]');
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.childElementCount).toBe(0);
      expect(group.style.backgroundColor).toBe('');
      expect(group).toHaveStyle({ isolation: 'isolate' });
    }
  });
});
