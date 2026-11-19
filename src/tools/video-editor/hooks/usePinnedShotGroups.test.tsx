import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePinnedGroupSync } from './usePinnedShotGroups';
import { planGenerationAssetRegistration } from '@/tools/video-editor/lib/timeline-asset-plans.ts';

type Store = Record<string, unknown> & {
  config: { output: unknown; clips: unknown[]; pinnedShotGroups?: unknown[] };
  rows: Array<{ id: string; actions: unknown[] }>;
  meta: Record<string, unknown>;
  clipOrder: Record<string, string[]>;
  registry: { assets: Record<string, Record<string, unknown>> };
  tracks: unknown[];
};

function makeStore(): Store {
  return {
    config: {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      clips: [],
      pinnedShotGroups: [{ shotId: 'shot-1', trackId: 'V1', clipIds: ['clip-0'], mode: 'images' }],
    },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    rows: [{ id: 'V1', actions: [{ id: 'clip-0', start: 0, end: 5, effectId: 'effect-clip-0' }] }],
    meta: { 'clip-0': { track: 'V1' } },
    clipOrder: { V1: ['clip-0'] },
    registry: { assets: {} },
  };
}

const shots = [{
  id: 'shot-1',
  name: 'Shot 1',
  images: [
    // Resolves to a primary variant: associated as both ids.
    {
      generation_id: 'gen-a',
      timeline_frame: 0,
      primary_variant_id: 'variant-a',
      imageUrl: 'https://example.com/a.png',
      thumbUrl: 'https://example.com/a-thumb.png',
      contentType: 'image/png',
      type: 'image',
    },
    // No primary variant: has no catalog association to store.
    {
      generation_id: 'gen-b',
      timeline_frame: 1,
      primary_variant_id: null,
      imageUrl: 'https://example.com/b.png',
      thumbUrl: 'https://example.com/b-thumb.png',
      contentType: 'image/png',
      type: 'image',
    },
  ],
}];

describe('usePinnedGroupSync convergence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('commits nothing on the second pass over a group that has a variant-less image', () => {
    const dataRef = { current: makeStore() as never as Record<string, unknown> & Store };
    const applyEdit = vi.fn((edit: {
      rows: Store['rows'];
      metaUpdates?: Record<string, unknown>;
      metaDeletes?: string[];
      clipOrderOverride: Store['clipOrder'];
      registryOverride: Store['registry'];
      pinnedShotGroupsOverride: unknown[];
    }) => {
      // Commit the edit the way the timeline store does: the next pass reads it back.
      const current = dataRef.current;
      const meta = { ...current.meta, ...(edit.metaUpdates ?? {}) };
      for (const clipId of edit.metaDeletes ?? []) delete meta[clipId];
      dataRef.current = {
        ...current,
        rows: edit.rows,
        meta,
        clipOrder: edit.clipOrderOverride,
        registry: edit.registryOverride,
        config: { ...current.config, pinnedShotGroups: edit.pinnedShotGroupsOverride },
      } as never;
    });

    // Mirrors the real registration path: the planner decides what the entry stores.
    const registerGenerationAsset = vi.fn((generation: {
      generationId: string;
      variantId?: string;
      variantType: string;
      imageUrl: string;
      thumbUrl?: string;
      metadata?: Record<string, unknown>;
    }) => {
      const plan = planGenerationAssetRegistration(generation);
      if (!plan.ok) return null;
      dataRef.current.registry.assets[plan.assetId] = plan.assetEntry as Record<string, unknown>;
      return plan.assetId;
    });

    const args = (data: unknown) => ({
      data,
      dataRef,
      applyEdit,
      shots,
      registerGenerationAsset,
      debounceMs: 0,
    }) as never;

    const { rerender } = renderHook(
      ({ data }: { data: unknown }) => usePinnedGroupSync(args(data)),
      { initialProps: { data: dataRef.current } },
    );

    // First pass: the stored clip is replaced by the one associable image.
    act(() => { vi.runOnlyPendingTimers(); });
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(dataRef.current.config.pinnedShotGroups).toEqual([
      expect.objectContaining({ shotId: 'shot-1', mode: 'images', clipIds: [expect.any(String)] }),
    ]);

    // Second pass, as the effect would re-run after the commit: zero commits.
    rerender({ data: dataRef.current });
    act(() => { vi.runOnlyPendingTimers(); });
    expect(applyEdit).toHaveBeenCalledTimes(1);
  });
});
