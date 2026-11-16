// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from './PreviewPanel';

const state = vi.hoisted(() => ({
  data: {data: {rows: [], meta: {}}, resolvedConfig: {}, trackScaleMap: {}, compositionSize: {width: 1280, height: 720}, deviceClass: 'desktop', interactionMode: 'select', gestureOwner: 'none'},
  playback: {playerContainerRef: {current: null}, currentTime: 0},
}));
vi.mock('@/tools/video-editor/hooks/timelineStore.ts', () => ({
  useTimelineDataSelector: (select: (value: typeof state.data) => unknown) => select(state.data),
  useTimelinePlaybackSelector: (select: (value: typeof state.playback) => unknown) => select(state.playback),
  useTimelineOpsSelector: (select: (value: object) => unknown) => select({}),
}));
vi.mock('@/tools/video-editor/hooks/usePerfDiagnostics.ts', () => ({useRenderDiagnostic: vi.fn()}));
vi.mock('@/shared/dev/useRenderBudget.ts', () => ({useRenderBudget: vi.fn()}));
vi.mock('./OverlayEditor.tsx', () => ({default: () => null}));

describe('preview reading-surface boundary', () => {
  it('keeps one bounded card around the picture and transparent inner surrounds', () => {
    const {container} = render(<PreviewPanel surface={{hasConfig: true, slotRef: vi.fn(), portal: null}} showOverlayEditor={false} />);
    const panel = screen.getByRole('region', {name: 'Preview panel'});
    expect(panel).toHaveClass('bg-card/95');
    const surface = screen.getByTestId('video-editor-preview-surface');
    expect(surface.parentElement).toHaveClass('bg-transparent');
    expect(container.querySelectorAll('.bg-card\\/95')).toHaveLength(1);
    expect(panel.style.opacity).toBe('');
    expect(panel.style.filter).toBe('');
  });
});

it('shows a transient authored canvas migration status', () => {
  Object.assign(state.data.data, {output: {resolution: '1280x720'}, migrationIssues: [{message: 'Materialized canvas from timeline settings.', details: {kind: 'canvas', source: 'theme_overrides.visual.canvas'}}]});
  try {
    render(<PreviewPanel surface={{hasConfig: true, slotRef: vi.fn(), portal: null}} showOverlayEditor={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Canvas 1280 × 720 from timeline settings.');
  } finally {
    delete (state.data.data as {migrationIssues?: unknown}).migrationIssues;
  }
});
