import { describe, expect, it } from 'vitest';
import {
  getGenerationAssetDisplayMetadata,
  planAssetDropTarget,
  planDuplicateGenerationAssetRegistration,
  planFinalVideoGenerationAssetRegistration,
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

describe('planGenerationAssetRegistration catalog association', () => {
  const imageUrl = '/api/runtime/v1/objects/sha256%3Aabc';

  it('writes generationId and variantId together', () => {
    const planned = planGenerationAssetRegistration({ generationId: 'g', variantId: 'v', imageUrl });
    expect(planned).toMatchObject({ ok: true, assetEntry: { generationId: 'g', variantId: 'v' } });
  });

  it('writes neither id when the variant is unknown', () => {
    const planned = planGenerationAssetRegistration({ generationId: 'g', imageUrl });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.assetEntry).not.toHaveProperty('generationId');
      expect(planned.assetEntry).not.toHaveProperty('variantId');
    }
  });
});

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

describe('registry catalog association is both ids or neither', () => {
  const imageUrl = 'https://example.com/drop.png';

  function plannedEntry(input: Parameters<typeof planGenerationAssetRegistration>[0]) {
    const planned = planGenerationAssetRegistration(input);
    if (!planned.ok) throw new Error(`expected a registration plan, got ${planned.error}`);
    return planned.assetEntry;
  }

  it('gallery drop writes both ids when the dragged variant is known', () => {
    // MediaGalleryItem.toGenerationDragData sends generationId and variantId together.
    const entry = plannedEntry({
      generationId: 'gen-gallery',
      variantId: 'variant-gallery',
      variantType: 'image',
      imageUrl,
      mediaId: 'media-gallery',
    });
    expect(entry).toMatchObject({ generationId: 'gen-gallery', variantId: 'variant-gallery', media_id: 'media-gallery' });
  });

  it('shot image drop writes both ids from primary_variant_id', () => {
    const entry = plannedEntry({
      generationId: 'gen-shot',
      variantId: 'variant-shot',
      variantType: 'image',
      imageUrl,
    });
    expect(entry).toMatchObject({ generationId: 'gen-shot', variantId: 'variant-shot' });
  });

  it('shot image drop without a primary variant writes neither id', () => {
    const entry = plannedEntry({ generationId: 'gen-shot', variantType: 'image', imageUrl });
    expect(entry).not.toHaveProperty('generationId');
    expect(entry).not.toHaveProperty('variantId');
  });

  it('pinned group image drop writes both ids when the variant is known and neither when it is not', () => {
    // usePinnedGroupSync sends the same generation shape as the shot image drop.
    expect(plannedEntry({
      generationId: 'gen-pinned',
      variantId: 'variant-pinned',
      variantType: 'image',
      imageUrl,
    })).toMatchObject({ generationId: 'gen-pinned', variantId: 'variant-pinned' });
    const unresolved = plannedEntry({ generationId: 'gen-pinned', variantType: 'image', imageUrl });
    expect(unresolved).not.toHaveProperty('generationId');
    expect(unresolved).not.toHaveProperty('variantId');
  });

  it('final video drop writes neither id, because its id is a Runtime media object id', () => {
    const planned = planFinalVideoGenerationAssetRegistration({
      imageUrl: 'https://example.com/final.mp4',
      assetDurationSeconds: 12,
    });
    if (!planned.ok) throw new Error('expected a final video plan');
    expect(planned.assetEntry).not.toHaveProperty('generationId');
    expect(planned.assetEntry).not.toHaveProperty('variantId');
    expect(planned.assetEntry).toMatchObject({ type: 'video/mp4', duration: 12 });
  });

  it('file drop from a Runtime import writes both ids; a plain upload without a variant writes neither', () => {
    expect(plannedEntry({
      generationId: 'gen-upload',
      variantId: 'variant-upload',
      variantType: 'image',
      imageUrl,
      mediaId: 'sha256:file',
    })).toMatchObject({ generationId: 'gen-upload', variantId: 'variant-upload' });

    const plainUpload = plannedEntry({ variantType: 'image', imageUrl, metadata: { original_filename: 'still.png' } });
    expect(plainUpload).not.toHaveProperty('generationId');
    expect(plainUpload).not.toHaveProperty('variantId');
  });

  it('duplicate of a generation variant follows the same rule', () => {
    const sourceAssetEntry = { file: imageUrl, type: 'image/png' } as Parameters<typeof planDuplicateGenerationAssetRegistration>[0]['sourceAssetEntry'];
    expect(planDuplicateGenerationAssetRegistration({
      generationId: 'gen-dup',
      variantId: 'variant-dup',
      variantType: 'image',
      imageUrl,
      sourceAssetEntry,
    })).toMatchObject({ ok: true, assetEntry: { generationId: 'gen-dup', variantId: 'variant-dup' } });

    const unresolved = planDuplicateGenerationAssetRegistration({
      generationId: 'gen-dup',
      variantType: 'image',
      imageUrl,
      sourceAssetEntry,
    });
    expect(unresolved.ok && unresolved.assetEntry).not.toHaveProperty('generationId');
  });

  it('never writes a half association: generationId alone or variantId alone', () => {
    const generationOnly = plannedEntry({ generationId: 'gen-half', variantType: 'image', imageUrl });
    expect(generationOnly).not.toHaveProperty('generationId');
    const variantOnly = plannedEntry({ variantId: 'variant-half', variantType: 'image', imageUrl });
    expect(variantOnly).not.toHaveProperty('variantId');
  });
});
