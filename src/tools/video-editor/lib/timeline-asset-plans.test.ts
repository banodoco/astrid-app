import { describe, expect, it } from 'vitest';
import {
  getGenerationAssetDisplayMetadata,
  planAssetDropTarget,
  planGenerationAssetRegistration,
} from './timeline-asset-plans.ts';
import type { TimelineData } from './timeline-data.ts';

function plannerData(overrides: Partial<Pick<TimelineData, 'tracks' | 'rows'>> = {}): TimelineData {
  return {
    tracks: [
      { id: 'V1', kind: 'visual', label: 'V1' },
      { id: 'V2', kind: 'visual', label: 'V2' },
      { id: 'V3', kind: 'visual', label: 'V3' },
    ],
    rows: [
      { id: 'V1', actions: [] },
      { id: 'V2', actions: [{ id: 'existing', start: 0, end: 20, effectId: 'effect-existing' }] },
      { id: 'V3', actions: [] },
    ],
    ...overrides,
  } as TimelineData;
}

describe('planGenerationAssetRegistration content type', () => {
  it('reads the MIME type from metadata so a Runtime video is not registered as a still image', () => {
    // Runtime generation rows carry their MIME type (e.g. video/mp4) in metadata.content_type.
    const withType = planGenerationAssetRegistration({
      generationId: 'g',
      variantType: 'image',
      imageUrl: '/api/runtime/v1/objects/sha256%3Aabc',
      metadata: { content_type: 'video/mp4' },
    });
    expect(withType).toMatchObject({ ok: true, assetEntry: { type: 'video/mp4' } });

    const withoutType = planGenerationAssetRegistration({
      generationId: 'g',
      variantType: 'image',
      imageUrl: '/api/runtime/v1/objects/sha256%3Aabc',
    });
    expect(withoutType).toMatchObject({ ok: true, assetEntry: { type: 'image/png' } });
  });

  it('keeps generation names on the asset registry entry for timeline labels', () => {
    const planned = planGenerationAssetRegistration({
      generationId: 'g',
      variantType: 'video',
      imageUrl: '/api/runtime/v1/objects/sha256%3Aabc',
      metadata: {
        original_filename: 'camera/clip.mp4',
        prompt: 'A slow pan over a valley',
      },
    });

    expect(planned).toMatchObject({
      ok: true,
      assetEntry: {
        original_filename: 'camera/clip.mp4',
        prompt: 'A slow pan over a valley',
      },
    });
  });

  it('collects original filename, display name, and prompt from generation records', () => {
    expect(getGenerationAssetDisplayMetadata({
      name: 'Mountain pass',
      metadata: { title: 'Opening shot' },
      params: {
        prompt: 'A slow pan across a valley',
        extra: { original_filename: 'camera/valley.mp4' },
      },
    })).toEqual({
      original_filename: 'camera/valley.mp4',
      name: 'Mountain pass',
      title: 'Opening shot',
      prompt: 'A slow pan across a valley',
    });
  });
});

describe('planAssetDropTarget occurrence raw-track policy', () => {
  it('keeps an occupied captured visual track instead of snapping or allocating V3', () => {
    const result = planAssetDropTarget({
      current: plannerData(),
      assetKind: 'visual',
      trackId: 'V2',
      selectedTrackId: 'V2',
      time: 0,
      duration: 5,
      placementPolicy: { kind: 'occurrence-raw-track', trackId: 'V2' },
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, trackId: 'V2', preparedCurrent: expect.any(Object) }));
    if (result.ok) expect(result.snappedTime).toBeUndefined();
  });

  it.each([
    ['missing', 'missing', undefined],
    ['wrong kind', 'A1', [{ id: 'A1', kind: 'audio', label: 'A1' }]],
    ['inactive', 'V2', [{ id: 'V2', kind: 'visual', label: 'V2', active: false }]],
    ['disabled', 'V2', [{ id: 'V2', kind: 'visual', label: 'V2', disabled: true }]],
  ] as const)('refuses a %s captured track locally', (_name, trackId, tracks) => {
    const result = planAssetDropTarget({
      current: plannerData(tracks === undefined ? {} : { tracks: tracks as TimelineData['tracks'] }),
      assetKind: 'visual',
      trackId,
      selectedTrackId: trackId,
      time: 0,
      duration: 5,
      placementPolicy: { kind: 'occurrence-raw-track', trackId },
    });

    expect(result).toEqual({ ok: false, error: 'preserved_track_unavailable' });
  });

  it('refuses a stale placement when the captured track and explicit target disagree', () => {
    const result = planAssetDropTarget({
      current: plannerData(),
      assetKind: 'visual',
      trackId: 'V1',
      selectedTrackId: 'V2',
      time: 0,
      duration: 5,
      placementPolicy: { kind: 'occurrence-raw-track', trackId: 'V2' },
    });

    expect(result).toEqual({ ok: false, error: 'preserved_track_unavailable' });
  });
});
