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
  Object.assign(state.data.data, {output: {resolution: '1280x720'}, migrationIssues: [{message: 'Using the timeline canvas setting in memory; it has not been written to output.', details: {kind: 'canvas', source: 'theme_overrides.visual.canvas'}}]});
  try {
    render(<PreviewPanel surface={{hasConfig: true, slotRef: vi.fn(), portal: null}} showOverlayEditor={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Canvas is not stated in timeline output; using 1280 × 720 from timeline settings. It has not been written to output.');
  } finally {
    delete (state.data.data as {migrationIssues?: unknown}).migrationIssues;
  }
});

it('shows transient child framing findings with occurrence context', () => {
  const finding = {scope: 'child' as const, occurrenceId: 'shot-1', shotId: 'shot', revisionId: 'rev', kind: 'scale-bake' as const, trackId: 'video', clipId: 'clip', before: {x: 0}, after: {x: 480}};
  render(<PreviewPanel surface={{hasConfig: true, slotRef: vi.fn(), portal: null, placementFindings: [finding]}} showOverlayEditor={false} />);
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Preview uses legacy framing in 1 shot.');
  expect(status).toHaveAttribute('title', expect.stringContaining('shot-1'));
  expect(status).toHaveAttribute('title', expect.stringContaining('480'));
});

it('describes an editor-resolved legacy canvas without claiming it was authored', () => {
  Object.assign(state.data.data, {output: {resolution: '1280x720'}, migrationIssues: [{message: 'Using the editor-resolved canvas in memory; it has not been written to the timeline.', details: {kind: 'canvas', source: 'app-resolved'}}]});
  try {
    render(<PreviewPanel surface={{hasConfig: true, slotRef: vi.fn(), portal: null}} showOverlayEditor={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Canvas is not stated on this timeline; using 1280 × 720 from the editor default. It has not been written.');
  } finally {
    delete (state.data.data as {migrationIssues?: unknown}).migrationIssues;
  }
});

it('identifies the editor theme when it resolved an unstated canvas', () => {
  Object.assign(state.data.data, {config: {theme: '2rp'}, output: {resolution: '1920x1080'}, migrationIssues: [{details: {kind: 'canvas', source: 'app-resolved'}}]});
  try {
    render(<PreviewPanel surface={{hasConfig: true, slotRef: vi.fn(), portal: null}} showOverlayEditor={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Canvas is not stated on this timeline; using 1920 × 1080 from the editor theme. It has not been written.');
  } finally {
    delete (state.data.data as {migrationIssues?: unknown}).migrationIssues;
    delete (state.data.data as {config?: unknown}).config;
  }
});
