import { describe, expect, it } from 'vitest';

import { TimelineNotFoundError } from '@/tools/video-editor/index.ts';
import {
  EditorTourWriteError,
  createEditorTourDataProvider,
} from './tourDataProvider.ts';
import { EDITOR_TOUR_TIMELINE_ID, createEditorTourTimeline } from './tourStages.ts';

describe('createEditorTourDataProvider', () => {
  it('is non-persistent', () => {
    const provider = createEditorTourDataProvider();
    expect(provider.persistenceEnabled).toBe(false);
  });

  it('loads the empty one-track timeline, as a fresh clone each call', async () => {
    const provider = createEditorTourDataProvider();
    const first = await provider.loadTimeline(EDITOR_TOUR_TIMELINE_ID);
    expect(first.config).toEqual(createEditorTourTimeline());
    expect(first.config.tracks).toHaveLength(1);
    expect(first.config.clips).toEqual([]);

    // Mutating one returned clone must not leak into the next load.
    first.config.clips.push({ id: 'leak', track: 'x', at: 0, clipType: 'hold' } as never);
    first.config.tracks![0].label = 'mutated';
    const second = await provider.loadTimeline(EDITOR_TOUR_TIMELINE_ID);
    expect(second.config).toEqual(createEditorTourTimeline());
    expect(second.config).not.toBe(first.config);
  });

  it('loads the asset registry', async () => {
    const provider = createEditorTourDataProvider();
    const registry = await provider.loadAssetRegistry(EDITOR_TOUR_TIMELINE_ID);
    expect(Object.keys(registry.assets).sort()).toEqual([
      'tour-guide',
      'tour-still-end',
      'tour-still-mid-1',
      'tour-still-mid-2', 'tour-still-start', 'tour-video',
    ]);
  });

  it('throws TimelineNotFoundError for an unknown timeline id', async () => {
    const provider = createEditorTourDataProvider();
    await expect(provider.loadTimeline('nope')).rejects.toBeInstanceOf(TimelineNotFoundError);
    await expect(provider.loadAssetRegistry('nope')).rejects.toBeInstanceOf(TimelineNotFoundError);
  });

  it('rejects saveTimeline with EditorTourWriteError', async () => {
    const provider = createEditorTourDataProvider();
    await expect(provider.saveTimeline(EDITOR_TOUR_TIMELINE_ID, createEditorTourTimeline(), 1))
      .rejects.toBeInstanceOf(EditorTourWriteError);
  });

  it('resolves asset urls to themselves', async () => {
    const provider = createEditorTourDataProvider();
    expect(await provider.resolveAssetUrl('data:image/svg+xml,abc')).toBe('data:image/svg+xml,abc');
    expect(await provider.resolveAssetUrl('https://example.com/a.mp4')).toBe('https://example.com/a.mp4');
  });
});
