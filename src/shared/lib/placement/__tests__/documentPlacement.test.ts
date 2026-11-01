import { describe, expect, it } from 'vitest';

import type { TimelineConfig } from '@/tools/video-editor/types/index';
import {
  batchUpdateFramesInDocument,
  clipIdForEntry,
  placeGenerationInDocument,
  placementEntryId,
  readPlacements,
  removeEntryFromDocument,
} from '../documentPlacement';

function emptyConfig(): TimelineConfig {
  return {
    output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips: [],
  };
}

function doc() {
  return {
    config: emptyConfig(),
    registry: { assets: {} as Record<string, { file?: string; src?: string; type?: string; duration?: number; generationId?: string }> },
  };
}

const MEDIA = { mediaRef: 'media-1', displaySrc: '/api/astrid/projects/p/media/media-1/content', mimeType: 'image/png' };

describe('documentPlacement — pure document ops', () => {
  it('auto-position places a clip appended after the group and registers the asset', () => {
    const d = doc();
    const first = placeGenerationInDocument(d, { shotId: 'shot-1', generationId: 'gen-a', ...MEDIA });
    const second = placeGenerationInDocument(d, { shotId: 'shot-1', generationId: 'gen-b', ...{ ...MEDIA, mediaRef: 'media-2' } });

    expect(first.timelineFrame).toBe(0);
    // hold 4s @30fps ⇒ frames 0..119 ⇒ next auto frame is 120
    expect(second.timelineFrame).toBe(120);
    expect(d.config.clips).toHaveLength(2);
    expect(d.config.pinnedShotGroups?.[0]?.clipIds).toEqual([
      clipIdForEntry(first.entryId),
      clipIdForEntry(second.entryId),
    ]);
    expect(d.registry.assets['gen:gen-a']?.generationId).toBe('gen-a');
    const placements = readPlacements(d.config, d.registry).get('shot-1');
    expect(placements?.map((p) => p.generationId)).toEqual(['gen-a', 'gen-b']);
  });

  it('pooled placement adds membership without a clip', () => {
    const d = doc();
    const placed = placeGenerationInDocument(d, { shotId: 's', generationId: 'g', ...MEDIA, timelineFrame: null });
    expect(placed.timelineFrame).toBeNull();
    expect(d.config.clips).toHaveLength(0);
    expect(d.config.pinnedShotGroups?.[0]?.poolGenerationIds).toEqual(['g']);
    expect(readPlacements(d.config, d.registry).get('s')?.[0]?.timelineFrame).toBeNull();
  });

  it('explicit frame lands exactly; collisions shift to the next free frame', () => {
    const d = doc();
    placeGenerationInDocument(d, { shotId: 's', generationId: 'a', ...MEDIA, timelineFrame: 5 });
    const collided = placeGenerationInDocument(d, { shotId: 's', generationId: 'b', ...MEDIA, timelineFrame: 5 });
    expect(collided.timelineFrame).toBe(6);
    expect(readPlacements(d.config, d.registry).get('s')?.map((p) => p.timelineFrame)).toEqual([5, 6]);
  });

  it('re-placing the same (shot, generation) replaces rather than duplicates', () => {
    const d = doc();
    placeGenerationInDocument(d, { shotId: 's', generationId: 'a', ...MEDIA, timelineFrame: 0 });
    const replaced = placeGenerationInDocument(d, { shotId: 's', generationId: 'a', ...MEDIA, timelineFrame: 9 });
    expect(replaced.timelineFrame).toBe(9);
    expect(d.config.clips).toHaveLength(1);
    expect(readPlacements(d.config, d.registry).get('s')).toHaveLength(1);
  });

  it('removeEntryFromDocument drops clip and pool slot but keeps the registry asset', () => {
    const d = doc();
    const placed = placeGenerationInDocument(d, { shotId: 's', generationId: 'a', ...MEDIA });
    removeEntryFromDocument(d, placed.entryId);
    expect(d.config.clips).toHaveLength(0);
    expect(d.config.pinnedShotGroups?.[0]?.clipIds).toHaveLength(0);
    expect(d.registry.assets['gen:a']).toBeDefined();
    expect(readPlacements(d.config, d.registry).get('s')).toHaveLength(0);
  });

  it('batch frame updates promote pooled entries and never overwrite a peer frame', () => {
    const d = doc();
    const a = placeGenerationInDocument(d, { shotId: 's', generationId: 'a', ...MEDIA, timelineFrame: null });
    const b = placeGenerationInDocument(d, { shotId: 's', generationId: 'b', ...MEDIA, timelineFrame: 10 });
    const [movedA] = batchUpdateFramesInDocument(d, 's', [
      { entryId: a.entryId, timelineFrame: 10 },
      { entryId: b.entryId, timelineFrame: 2 },
    ]);
    // Collision rule: a requested frame held by a peer shifts to the next
    // free frame — never an overwrite.
    expect(movedA.timelineFrame).toBe(11);
  });

  it('entry ids are deterministic per (shot, generation)', () => {
    expect(placementEntryId('shot-x', 'gen-9')).toBe(placementEntryId('shot-x', 'gen-9'));
  });

  it('auto-position uses only the selected shot extent, even on a shared lane', () => {
    const d = doc();
    placeGenerationInDocument(d, { shotId: 'sibling', generationId: 'long', ...MEDIA, timelineFrame: 900 });
    placeGenerationInDocument(d, { shotId: 'target', generationId: 'first', ...MEDIA, timelineFrame: 30 });
    const appended = placeGenerationInDocument(d, { shotId: 'target', generationId: 'second', ...MEDIA });

    expect(appended.timelineFrame).toBe(150);
    expect(readPlacements(d.config, d.registry).get('sibling')?.[0]?.timelineFrame).toBe(900);
  });

  it('a new shot inherits the first existing group lane without creating a track', () => {
    const d = doc();
    d.config.tracks!.push({ id: 'V2', kind: 'visual', label: 'V2' });
    d.config.pinnedShotGroups = [{ shotId: 'existing', trackId: 'V2', clipIds: [], poolGenerationIds: [] }];
    const tracks = structuredClone(d.config.tracks);
    const placed = placeGenerationInDocument(d, { shotId: 'new', generationId: 'g', ...MEDIA });

    expect(d.config.clips.find((clip) => clip.id === clipIdForEntry(placed.entryId))?.track).toBe('V2');
    expect(d.config.tracks).toEqual(tracks);
  });

  it('shared video placement keeps the four-second hold even when the media is longer', () => {
    const d = doc();
    const placed = placeGenerationInDocument(d, {
      shotId: 's', generationId: 'video', mediaRef: 'video.mp4', mimeType: 'video/mp4', duration: 9,
    });
    const next = placeGenerationInDocument(d, { shotId: 's', generationId: 'image', ...MEDIA });

    expect(d.config.clips.find((clip) => clip.id === clipIdForEntry(placed.entryId)))
      .toMatchObject({ clipType: 'media', at: 0, hold: 4, asset: 'gen:video' });
    expect(d.registry.assets['gen:video']).toMatchObject({ type: 'video/mp4', duration: 9 });
    expect(next.timelineFrame).toBe(120);
  });

  it('collision shifting tests start frames rather than the whole occupied interval', () => {
    const d = doc();
    placeGenerationInDocument(d, { shotId: 's', generationId: 'a', ...MEDIA, timelineFrame: 0 });
    const overlapping = placeGenerationInDocument(d, { shotId: 's', generationId: 'b', ...MEDIA, timelineFrame: 30 });
    const shifted = placeGenerationInDocument(d, { shotId: 's', generationId: 'c', ...MEDIA, timelineFrame: 30 });

    expect(overlapping.timelineFrame).toBe(30);
    expect(shifted.timelineFrame).toBe(31);
    expect(d.config.clips).toHaveLength(3);
  });
});
