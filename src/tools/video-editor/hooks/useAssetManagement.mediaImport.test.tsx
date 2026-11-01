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
