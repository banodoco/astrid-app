// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultTimelineConfig } from '@/tools/video-editor/lib/defaults';
import { shouldAcceptPolledData } from '@/tools/video-editor/lib/timeline-save-utils';
import { createInteractionState } from '@/tools/video-editor/lib/interaction-state';
import { getTimelinePollRejectionReason, isTimelinePollIdle, usePollSync } from '@/tools/video-editor/hooks/usePollSync';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider';
import { buildTimelineData, type TimelineData } from '@/tools/video-editor/lib/timeline-data';

function getLegacyPollRejectionReason(input: {
  editSeq: number;
  savedSeq: number;
  pendingOps: number;
  polledConfigVersion: number;
  currentConfigVersion: number;
  polledStableSignature: string;
  lastSavedStableSignature: string;
}): string | null {
  if (input.savedSeq < input.editSeq) {
    return 'unsaved edits';
  }

  if (input.pendingOps > 0) {
    return 'pending ops';
  }

  if (input.polledConfigVersion < input.currentConfigVersion) {
    return 'stale version';
  }

  if (
    !shouldAcceptPolledData(
      input.editSeq,
      input.savedSeq,
      input.pendingOps,
      input.polledStableSignature,
      input.lastSavedStableSignature,
    )
  ) {
    return input.polledConfigVersion === input.currentConfigVersion ? 'own echo' : 'signature match';
  }

  return null;
}

describe('usePollSync helpers', () => {
  it('adopts a same-publication poll with a different opaque output field', async () => {
    const head = { projectId: 'project', timelineId: 'timeline', headRevisionId: 'r1', headPublicationId: 'p1' };
    const config = createDefaultTimelineConfig();
    const registry = { assets: {} };
    const output = (value: number) => ({ ...config.output, extension: { value } });
    const mounted = await buildTimelineData({ ...config, output: output(0) }, registry, undefined, 1, undefined, head);
    const polled = await buildTimelineData({ ...config, output: output(1) }, registry, undefined, 1, undefined, head);
    expect(polled.stableSignature).not.toBe(mounted.stableSignature);
    const commitData = vi.fn();
    const provider: DataProvider = {
      loadTimeline: vi.fn(), saveTimeline: vi.fn(), saveTimelineAtHead: vi.fn(),
      loadAssetRegistry: vi.fn(), resolveAssetUrl: vi.fn(),
    };
    const hook = renderHook(() => usePollSync({
      queries: { timelineQuery: { data: polled, isLoading: false }, assetRegistryQuery: { data: undefined } },
      provider,
      commitData,
      dataRef: { current: mounted },
      selectedClipIdRef: { current: null },
      selectedTrackIdRef: { current: null },
      editSeqRef: { current: 0 },
      pendingOpsRef: { current: 0 },
      savedSeqRef: { current: 0 },
      configVersionRef: { current: mounted.configVersion },
      headRevisionRef: { current: head },
      lastSavedSignatureRef: { current: mounted.stableSignature },
      isSavingRef: { current: false },
      interactionStateRef: { current: createInteractionState() },
    }));
    try {
      await vi.waitFor(() => expect(commitData).toHaveBeenCalledWith(polled,
        { save: false, skipHistory: true, updateLastSavedSignature: true }));
    } finally {
      hook.unmount();
    }
  });

  it('does not adopt a remote update checked while the recovery draft banner is active', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(async (file: string) => file),
    };
    const interactionStateRef = { current: createInteractionState() };
    const currentData = { configVersion: 1, stableSignature: 'view-sig' } as unknown as TimelineData;
    const dataRef = { current: currentData as TimelineData | null };
    const commitData = vi.fn();
    const options = (polledData: TimelineData) => ({
      queries: {
        timelineQuery: { data: polledData, isLoading: false },
        assetRegistryQuery: { data: undefined },
      },
      provider,
      commitData,
      dataRef,
      selectedClipIdRef: { current: null },
      selectedTrackIdRef: { current: null },
      editSeqRef: { current: 0 },
      pendingOpsRef: { current: 0 },
      savedSeqRef: { current: 0 },
      configVersionRef: { current: 1 },
      lastSavedSignatureRef: { current: 'saved-sig' },
      isSavingRef: { current: false },
      interactionStateRef,
      recoveryActiveRef: { current: true },
    });
    const firstSnapshot = {
      configVersion: 2,
      stableSignature: 'first-snapshot',
      signature: 'first-snapshot',
    } as unknown as TimelineData;
    const remoteUpdate = {
      configVersion: 3,
      stableSignature: 'remote-update',
      signature: 'remote-update',
    } as unknown as TimelineData;

    const hook = renderHook(({ data }) => usePollSync(options(data)), { initialProps: { data: firstSnapshot } });
    hook.rerender({ data: remoteUpdate });
    await new Promise((resolve) => window.setTimeout(resolve, 5));

    expect(dataRef.current).toBe(currentData);
    expect(commitData).not.toHaveBeenCalled();
  });

  it('preserves legacy poll decisions except for the intentional save-in-flight rejection', () => {
    const editSeqValues = [2, 4];
    const savedSeqValues = [1, 2, 4, 6];
    const pendingOpsValues = [0, 1];
    const isSavingValues = [false, true];
    const configVersions = [
      { polledConfigVersion: 7, currentConfigVersion: 7 },
      { polledConfigVersion: 8, currentConfigVersion: 7 },
      { polledConfigVersion: 6, currentConfigVersion: 7 },
    ];
    const signatures = [
      { polledStableSignature: 'saved-sig', lastSavedStableSignature: 'saved-sig' },
      { polledStableSignature: 'remote-sig', lastSavedStableSignature: 'saved-sig' },
    ];

    for (const editSeq of editSeqValues) {
      for (const savedSeq of savedSeqValues) {
        for (const pendingOps of pendingOpsValues) {
          for (const isSaving of isSavingValues) {
            for (const versionState of configVersions) {
              for (const signatureState of signatures) {
                const nextReason = getTimelinePollRejectionReason({
                  editSeq,
                  savedSeq,
                  pendingOps,
                  isSaving,
                  ...versionState,
                  ...signatureState,
                });
                const legacyReason = getLegacyPollRejectionReason({
                  editSeq,
                  savedSeq,
                  pendingOps,
                  ...versionState,
                  ...signatureState,
                });
                const expectedReason = isSaving && savedSeq >= editSeq && pendingOps === 0
                  ? 'saving'
                  : legacyReason;

                expect(nextReason).toBe(expectedReason);
              }
            }
          }
        }
      }
    }
  });

  it('default-rejects polls while a save is in flight even if other idle conditions are true', () => {
    expect(isTimelinePollIdle({
      editSeq: 4,
      savedSeq: 4,
      pendingOps: 0,
      isSaving: true,
    })).toBe(false);

    expect(getTimelinePollRejectionReason({
      editSeq: 4,
      savedSeq: 4,
      pendingOps: 0,
      isSaving: true,
      polledConfigVersion: 8,
      currentConfigVersion: 7,
      polledStableSignature: 'remote-sig',
      lastSavedStableSignature: 'saved-sig',
    })).toBe('saving');
  });

  it('rejects polls while an interaction (drag/resize) is active', () => {
    // Even when the timeline would otherwise be idle and the poll signature is fresh,
    // an active interaction must defer the conflict reload.
    expect(isTimelinePollIdle({
      editSeq: 4,
      savedSeq: 4,
      pendingOps: 0,
      isSaving: false,
      interactionActive: true,
    })).toBe(false);

    expect(getTimelinePollRejectionReason({
      editSeq: 4,
      savedSeq: 4,
      pendingOps: 0,
      isSaving: false,
      interactionActive: true,
      polledConfigVersion: 8,
      currentConfigVersion: 7,
      polledStableSignature: 'remote-sig',
      lastSavedStableSignature: 'saved-sig',
    })).toBe('interaction active');
  });

  it('defers parent polling while a nested canonical shot draft is active', () => {
    expect(isTimelinePollIdle({
      editSeq: 4,
      savedSeq: 4,
      pendingOps: 0,
      isSaving: false,
      canonicalShotDraftActive: true,
    })).toBe(false);

    expect(getTimelinePollRejectionReason({
      editSeq: 4,
      savedSeq: 4,
      pendingOps: 0,
      isSaving: false,
      canonicalShotDraftActive: true,
      polledConfigVersion: 8,
      currentConfigVersion: 7,
      polledStableSignature: 'remote-sig',
      lastSavedStableSignature: 'saved-sig',
    })).toBe('canonical shot draft active');
  });

  it('accepts polls when interaction is no longer active', () => {
    expect(isTimelinePollIdle({
      editSeq: 4,
      savedSeq: 4,
      pendingOps: 0,
      isSaving: false,
      interactionActive: false,
    })).toBe(true);

    expect(getTimelinePollRejectionReason({
      editSeq: 4,
      savedSeq: 4,
      pendingOps: 0,
      isSaving: false,
      interactionActive: false,
      polledConfigVersion: 8,
      currentConfigVersion: 7,
      polledStableSignature: 'remote-sig',
      lastSavedStableSignature: 'saved-sig',
    })).toBeNull();
  });

  it('uses configVersion as the reconnect cursor and suppresses a duplicate committed read', () => {
    const base = {
      editSeq: 2,
      savedSeq: 2,
      pendingOps: 0,
      isSaving: false,
      interactionActive: false,
      polledStableSignature: 'remote-v2',
      lastSavedStableSignature: 'local-v1',
    };

    expect(getTimelinePollRejectionReason({
      ...base,
      polledConfigVersion: 2,
      currentConfigVersion: 1,
    })).toBeNull();

    expect(getTimelinePollRejectionReason({
      ...base,
      polledConfigVersion: 2,
      currentConfigVersion: 2,
      polledStableSignature: 'remote-v2',
      lastSavedStableSignature: 'remote-v2',
    })).toBe('own echo');

    expect(getTimelinePollRejectionReason({
      ...base,
      polledConfigVersion: 1,
      currentConfigVersion: 2,
    })).toBe('stale version');

    expect(getTimelinePollRejectionReason({
      ...base,
      editSeq: 3,
      savedSeq: 2,
      polledConfigVersion: 3,
      currentConfigVersion: 2,
    })).toBe('unsaved edits');
  });

  it('keeps configVersionRef pinned to the accepted local base version while a remote payload is still deferred', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(async (file: string) => file),
    };
    const interactionState = createInteractionState();
    interactionState.drag = true;
    const interactionStateRef = { current: interactionState };
    const configVersionRef = { current: 3 };
    const commitData = vi.fn();
    const polledData = {
      configVersion: 7,
      stableSignature: 'remote-sig',
      signature: 'remote-sig',
    } as unknown as TimelineData;

    renderHook(() => usePollSync({
      queries: {
        timelineQuery: {
          data: polledData,
          isLoading: false,
        },
        assetRegistryQuery: {
          data: undefined,
        },
      },
      provider,
      commitData,
      dataRef: { current: null },
      selectedClipIdRef: { current: null },
      selectedTrackIdRef: { current: null },
      editSeqRef: { current: 4 },
      pendingOpsRef: { current: 0 },
      savedSeqRef: { current: 4 },
      configVersionRef,
      lastSavedSignatureRef: { current: 'saved-sig' },
      isSavingRef: { current: false },
      interactionStateRef,
    }));

    await Promise.resolve();

    expect(configVersionRef.current).toBe(3);
    expect(commitData).not.toHaveBeenCalled();
  });
});

  it('accepts a fresh version-0 timeline (initial configVersionRef is 0, not 1)', () => {
    // Regression: useTimelineSave initialized configVersionRef to 1, so a fresh
    // bridge timeline at config_version 0 was rejected as 'stale version' and
    // the editor never became ready ("Timeline data is not ready.").
    const idle = { editSeq: 0, savedSeq: 0, pendingOps: 0, isSaving: false };
    expect(getTimelinePollRejectionReason({
      ...idle,
      polledConfigVersion: 0,
      currentConfigVersion: 0,
      polledStableSignature: 'fresh-sig',
      lastSavedStableSignature: '',
    })).toBeNull();

    // Sanity: an older local ref still rejects a lower polled version.
    expect(getTimelinePollRejectionReason({
      ...idle,
      polledConfigVersion: 0,
      currentConfigVersion: 1,
      polledStableSignature: 'fresh-sig',
      lastSavedStableSignature: '',
    })).toBe('stale version');
  });

describe('usePollSync — diverged freeze (plan-v5 B4)', () => {
  it('does not adopt remote data while diverged (409)', async () => {
    const provider: DataProvider = {
      loadTimeline: vi.fn(),
      saveTimeline: vi.fn(),
      loadAssetRegistry: vi.fn(),
      resolveAssetUrl: vi.fn(async (file: string) => file),
    };
    const interactionStateRef = { current: createInteractionState() };
    const configVersionRef = { current: 3 };
    const commitData = vi.fn();
    const polledData = {
      configVersion: 7,
      stableSignature: 'remote-sig',
      signature: 'remote-sig',
    } as unknown as TimelineData;

    renderHook(() => usePollSync({
      queries: {
        timelineQuery: { data: polledData, isLoading: false },
        assetRegistryQuery: { data: undefined },
      },
      provider,
      commitData,
      dataRef: { current: null },
      selectedClipIdRef: { current: null },
      selectedTrackIdRef: { current: null },
      editSeqRef: { current: 4 },
      pendingOpsRef: { current: 0 },
      savedSeqRef: { current: 4 },
      configVersionRef,
      lastSavedSignatureRef: { current: 'saved-sig' },
      isSavingRef: { current: false },
      interactionStateRef,
      isConflictExhaustedRef: { current: true },
    }));

    await Promise.resolve();
    await Promise.resolve();

    // Diverged: the remote payload must not be adopted or committed.
    expect(configVersionRef.current).toBe(3);
    expect(commitData).not.toHaveBeenCalled();
  });
});
