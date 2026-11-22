// @vitest-environment jsdom

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  VideoEditorRuntimeProvider,
  type VideoEditorRuntimeContextValue,
} from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { buildPlacePreparedMediaCommand } from '@/tools/video-editor/hooks/useAssetManagement';
import { useAssetManagement } from './useAssetManagement';
import { RUNTIME_MEDIA_IMPORT_MAX_BYTES } from '@/tools/video-editor/data/AssetResolver.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';

const extractVideoMetadataMock = vi.fn();

vi.mock('@/shared/lib/media/videoMetadata.ts', () => ({
  extractVideoMetadata: (...args: unknown[]) => extractVideoMetadataMock(...args),
}));

function buildRuntimeValue(provider: Record<string, unknown>): VideoEditorRuntimeContextValue {
  return {
    provider: provider as VideoEditorRuntimeContextValue['provider'],
    assetResolver: { resolveAssetUrl: vi.fn() },
    auth: {} as VideoEditorRuntimeContextValue['auth'],
    project: {} as VideoEditorRuntimeContextValue['project'],
    shots: {} as VideoEditorRuntimeContextValue['shots'],
    mediaLightbox: {} as VideoEditorRuntimeContextValue['mediaLightbox'],
    agentChat: {} as VideoEditorRuntimeContextValue['agentChat'],
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
    telemetry: {} as VideoEditorRuntimeContextValue['telemetry'],
    timelineId: 'timeline-1',
    userId: null,
    extensions: {} as VideoEditorRuntimeContextValue['extensions'],
  };
}

function buildArgs() {
  return {
    dataRef: { current: null },
    selectedTrackId: null,
    selectedProjectId: 'runtime-project-id',
    selectClip: vi.fn(),
    setSelectedTrackId: vi.fn(),
    applyEdit: vi.fn(),
    patchRegistry: vi.fn(),
    uploadAsset: vi.fn(),
    invalidateAssetRegistry: vi.fn(),
    resolveAssetUrl: vi.fn(async (file: string) => file),
  };
}

function renderAssetManagement(provider: Record<string, unknown>) {
  return renderHook(() => useAssetManagement(buildArgs()), {
    wrapper: ({ children }) => (
      <VideoEditorRuntimeProvider value={buildRuntimeValue(provider)}>
        {children}
      </VideoEditorRuntimeProvider>
    ),
  });
}

describe('useAssetManagement Runtime media imports', () => {
  it('keeps generic registrations out of drop markers and releases an owned marker after placement', async () => {
    const dataRef = { current: await buildTimelineData(createDefaultTimelineConfig(), { assets: {} }) };
    const applyEdit = vi.fn();
    const patchRegistry = vi.fn((assetKey: string, entry: { file: string }) => {
      dataRef.current = { ...dataRef.current!, registry: { ...dataRef.current!.registry,
        assets: { ...dataRef.current!.registry.assets, [assetKey]: entry } } };
    });
    const { result } = renderHook(() => useAssetManagement({
      ...buildArgs(), dataRef: dataRef as never, applyEdit, patchRegistry,
    }), {
      wrapper: ({ children }) => (
        <VideoEditorRuntimeProvider value={buildRuntimeValue({ resolveAssetUrl: vi.fn() })}>
          {children}
        </VideoEditorRuntimeProvider>
      ),
    });
    const staticKey = result.current.registerGenerationAsset({
      generationId: 'gallery-generation', variantId: 'gallery-variant', variantType: 'image',
      assetId: 'gallery-asset', imageUrl: 'https://media.test/gallery.png',
      metadata: { content_type: 'image/png' },
    } as never);
    expect(staticKey).toBe('gallery-asset');
    const activeDrop = result.current.prepareGenerationAsset({
      generationId: 'drop-generation', variantId: 'drop-variant', variantType: 'image',
      assetId: 'drop-asset', imageUrl: 'https://media.test/drop.png',
      metadata: { content_type: 'image/png' },
    } as never)!;
    result.current.markGenerationAssetInFlight(activeDrop);
    act(() => { result.current.handleAssetDrop(activeDrop.assetKey, 'V1', 0, false, false, activeDrop); });
    expect(applyEdit).toHaveBeenCalledOnce();
    expect(applyEdit.mock.calls[0][0]).toMatchObject({ type: 'prepared-media', inFlight: { 'drop-asset': activeDrop.entry } });
    expect(applyEdit.mock.calls[0][0]).not.toHaveProperty('inFlight.gallery-asset');

    const laterDrop = result.current.prepareGenerationAsset({
      generationId: 'later-generation', variantId: 'later-variant', variantType: 'image',
      assetId: 'later-asset', imageUrl: 'https://media.test/later.png',
      metadata: { content_type: 'image/png' },
    } as never)!;
    act(() => { result.current.handleAssetDrop(laterDrop.assetKey, 'V1', 5, false, false, laterDrop); });
    expect(applyEdit).toHaveBeenCalledTimes(2);
    expect(applyEdit.mock.calls[1][0]).not.toHaveProperty('inFlight');

    const declinedDrop = result.current.prepareGenerationAsset({
      generationId: 'declined-generation', variantId: 'declined-variant', variantType: 'image',
      assetId: 'declined-asset', imageUrl: 'https://media.test/declined.png',
      metadata: { content_type: 'image/png' },
    } as never)!;
    result.current.markGenerationAssetInFlight(declinedDrop);
    const savedData = dataRef.current;
    dataRef.current = null;
    let placed = true;
    act(() => { placed = result.current.handleAssetDrop(declinedDrop.assetKey, 'V1', 10, false, false, declinedDrop); });
    expect(placed).toBe(false);
    dataRef.current = savedData;
    const erroredDrop = result.current.prepareGenerationAsset({
      generationId: 'errored-generation', variantId: 'errored-variant', variantType: 'image',
      assetId: 'errored-asset', imageUrl: 'https://media.test/errored.png', metadata: { content_type: 'image/png' },
    } as never)!;
    result.current.markGenerationAssetInFlight(erroredDrop);
    applyEdit.mockImplementationOnce(() => { throw new Error('edit dispatch failed'); });
    expect(() => result.current.handleAssetDrop(erroredDrop.assetKey, 'V1', 12, false, false, erroredDrop)).toThrow('edit dispatch failed');
    const afterDecline = result.current.prepareGenerationAsset({
      generationId: 'after-decline', variantId: 'after-decline-variant', variantType: 'image',
      assetId: 'after-decline-asset', imageUrl: 'https://media.test/after-decline.png',
      metadata: { content_type: 'image/png' },
    } as never)!;
    act(() => { result.current.handleAssetDrop(afterDecline.assetKey, 'V1', 15, false, false, afterDecline); });
    expect(applyEdit).toHaveBeenCalledTimes(4);
    expect(applyEdit.mock.calls[3][0]).not.toHaveProperty('inFlight');
  });

  it('releases a retargeted drop by its original key and keeps another concurrent marker', async () => {
    const dataRef = { current: await buildTimelineData(createDefaultTimelineConfig(), { assets: {} }) };
    dataRef.current = { ...dataRef.current, registry: { assets: { 'shared-key': { file: 'old.png', type: 'image/png' } } } };
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useAssetManagement({ ...buildArgs(), dataRef: dataRef as never, applyEdit }), {
      wrapper: ({ children }) => (
        <VideoEditorRuntimeProvider value={buildRuntimeValue({ resolveAssetUrl: vi.fn() })}>
          {children}
        </VideoEditorRuntimeProvider>
      ),
    });
    const hash = `sha256:${'a'.repeat(64)}`;
    const original = {
      assetKey: 'shared-key', mediaType: 'image', durationSeconds: null, source: 'registered',
      entry: { file: 'new.png', type: 'image/png', media_id: hash, generationId: 'g', variantId: 'v' },
      mediaSelection: { asset: 'shared-key', generation_id: 'g', variant_id: 'v', object_id: hash, catalog_digest: `sha256:${'b'.repeat(64)}` },
    } as never;
    const other = { assetKey: 'other-key', mediaType: 'image', durationSeconds: null, source: 'registered', entry: { file: 'other.png', type: 'image/png' } } as never;
    result.current.markGenerationAssetInFlight(original);
    result.current.markGenerationAssetInFlight(other);
    act(() => { result.current.handleAssetDrop('shared-key', 'V1', 0, false, false, original, 'uploading-placeholder'); });
    const firstGesture = applyEdit.mock.calls[0][1] as { gestureBasis: { command: { payload: { asset: { assetKey: string } } }; inFlight: Record<string, unknown> } };
    expect(firstGesture.gestureBasis.command.payload.asset.assetKey).not.toBe('shared-key');
    expect(Object.keys(firstGesture.gestureBasis.inFlight).sort()).toEqual(['other-key', 'shared-key']);

    const later = result.current.prepareGenerationAsset({
      generationId: 'later-generation', variantId: 'later-variant', variantType: 'image',
      assetId: 'later-key', imageUrl: 'https://media.test/later.png', metadata: { content_type: 'image/png' },
    } as never)!;
    act(() => { result.current.handleAssetDrop(later.assetKey, 'V1', 5, false, false, later); });
    const secondMutation = applyEdit.mock.calls[1][0] as { inFlight: Record<string, unknown> };
    expect(Object.keys(secondMutation.inFlight)).toEqual(['other-key']);
  });

  it('carries an authentic Runtime selection through preparation and placement without inventing one', async () => {
    const mediaSelection = {
      asset: 'sha256:image',
      generation_id: 'generation-image',
      variant_id: 'variant-image',
      object_id: 'sha256:object',
      catalog_digest: 'sha256:catalog',
    } as const;
    const prepareMediaImport = vi.fn().mockResolvedValue({
      provider: 'runtime',
      project: 'runtime-project-id',
      importOperationId: 'operation-image',
      generationId: 'generation-image',
      variantId: 'variant-image',
      assetId: 'sha256:image',
      entry: { file: 'https://runtime.test/image', type: 'image/png' },
      mediaSelection,
    });
    const { result } = renderAssetManagement({
      supportsDirectAssetUpload: true,
      prepareMediaImport,
      resolveAssetUrl: vi.fn(),
    });
    const image = new File(['image'], 'frame.png', { type: 'image/png' });
    let uploaded!: Awaited<ReturnType<typeof result.current.uploadImageGeneration>>;
    await act(async () => {
      uploaded = await result.current.uploadImageGeneration(image);
    });

    const prepared = result.current.prepareGenerationAsset(uploaded);
    expect(prepared?.mediaSelection).toBe(mediaSelection);
    expect(buildPlacePreparedMediaCommand({
      prepared: prepared!,
      selectedTrackId: 'V1',
      time: 0,
      forceNewTrack: false,
      insertAtTop: false,
    }).payload.asset.mediaSelection).toBe(mediaSelection);

    const unqualified = result.current.prepareGenerationAsset({
      ...uploaded,
      mediaImport: { ...uploaded.mediaImport!, mediaSelection: undefined },
    });
    expect(unqualified).not.toHaveProperty('mediaSelection');
  });

  it('uses one Runtime import identity for image and video drops', async () => {
    extractVideoMetadataMock.mockResolvedValue({ duration_seconds: 2.5 });
    const prepareMediaImport = vi.fn()
      .mockResolvedValueOnce({
        provider: 'runtime',
        project: 'runtime-project-id',
        importOperationId: 'operation-image',
        generationId: 'generation-image',
        variantId: 'variant-image',
        assetId: 'sha256:image',
        entry: { file: 'https://runtime.test/image', type: 'image/png' },
      })
      .mockResolvedValueOnce({
        provider: 'runtime',
        project: 'runtime-project-id',
        importOperationId: 'operation-video',
        generationId: 'generation-video',
        variantId: 'variant-video',
        assetId: 'sha256:video',
        entry: { file: 'https://runtime.test/video', type: 'video/mp4', duration: 2.5 },
      });
    const { result } = renderAssetManagement({
      supportsDirectAssetUpload: true,
      prepareMediaImport,
      resolveAssetUrl: vi.fn(),
    });

    const image = new File(['image'], 'frame.png', { type: 'image/png' });
    const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
    await act(async () => {
      await result.current.uploadImageGeneration(image);
      await result.current.uploadVideoGeneration(video);
    });

    expect(prepareMediaImport).toHaveBeenNthCalledWith(1, image, {
      filename: 'frame.png',
      mediaType: 'image/png',
    });
    expect(prepareMediaImport).toHaveBeenNthCalledWith(2, video, {
      filename: 'clip.mp4',
      mediaType: 'video/mp4',
      durationSeconds: 2.5,
    });
  });

  it('rejects an oversized Runtime import before invoking the provider', async () => {
    const prepareMediaImport = vi.fn();
    const { result } = renderAssetManagement({
      supportsDirectAssetUpload: true,
      prepareMediaImport,
      resolveAssetUrl: vi.fn(),
    });
    const oversizedImage = new File(['image'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(oversizedImage, 'size', { value: RUNTIME_MEDIA_IMPORT_MAX_BYTES + 1 });

    await expect(result.current.uploadImageGeneration(oversizedImage)).rejects.toThrow(
      'huge.png exceeds the Workspace Runtime media limit of 5 GiB',
    );
    expect(prepareMediaImport).not.toHaveBeenCalled();
  });

  it('fails closed for a direct Bridge provider instead of using the legacy generation writer', async () => {
    const { result } = renderAssetManagement({
      supportsDirectAssetUpload: true,
      resolveAssetUrl: vi.fn(),
    });
    const image = new File(['image'], 'frame.png', { type: 'image/png' });

    await expect(result.current.uploadImageGeneration(image)).rejects.toThrow(
      'This editor backend does not support Runtime image/video imports',
    );
  });

  it('fails closed for a provider without a Runtime media import for both images and videos', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderAssetManagement({ resolveAssetUrl: vi.fn() });
    const image = new File(['image'], 'frame.png', { type: 'image/png' });
    const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' });

    await expect(result.current.uploadImageGeneration(image)).rejects.toThrow(
      'This editor backend does not support Runtime image/video imports',
    );
    await expect(result.current.uploadVideoGeneration(video)).rejects.toThrow(
      'This editor backend does not support Runtime image/video imports',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
