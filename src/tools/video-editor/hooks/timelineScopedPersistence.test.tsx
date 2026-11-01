// @vitest-environment jsdom
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { bindTimelinePersistenceHandoff, TimelinePersistenceHandoffContext, type TimelinePersistenceHandoff, type TimelinePersistenceBinding } from './timelineLocalSaveHandoff.ts';
import { useTimelinePersistence } from './useTimelinePersistence.ts';
import { TimelineEventBus } from './useTimelineEventBus.ts';
import { createInteractionState } from '../lib/interaction-state.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import type { DataProvider } from '../data/DataProvider.ts';

vi.mock('@/tools/video-editor/compositions/TimelineRenderer.tsx', () => ({
  invalidateReferencedTimelineCache: vi.fn(),
}));
beforeEach(() => { vi.stubGlobal('indexedDB', createFakeIndexedDB()); });

it.each(['forged', 'provider', 'timeline', 'projection'] as const)(
  'refuses a %s context handoff in mounted persistence without invoking a writer', async (kind) => {
    const capture = vi.fn(async () => {});
    const flush = vi.fn(async () => ({ configVersion: 2 }));
    const forged: TimelinePersistenceHandoff = { capture, flush };
    const provider: DataProvider = {
      loadTimeline: vi.fn(), loadAssetRegistry: vi.fn(), saveTimeline: vi.fn(async () => 2),
      resolveAssetUrl: (file) => file,
    };
    const binding = kind === 'forged' ? forged as unknown as TimelinePersistenceBinding
      : kind === 'projection' ? { provider, timelineId: 'mounted-popup' }
      : bindTimelinePersistenceHandoff(kind === 'provider' ? { ...provider } : provider,
        kind === 'timeline' ? 'another-popup' : 'mounted-popup', forged);
    const data = await buildTimelineData(createDefaultTimelineConfig(), { assets: {} }, async file => file, 1);
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <TimelinePersistenceHandoffContext.Provider value={binding}>
          {children}
        </TimelinePersistenceHandoffContext.Provider>
      </QueryClientProvider>
    );
    const options = { provider, timelineId: 'mounted-popup', dataRef: { current: data },
      eventBus: new TimelineEventBus(), commitData: vi.fn(), selectedClipIdRef: { current: null },
      selectedTrackIdRef: { current: null }, editSeqRef: { current: 1 }, savedSeqRef: { current: 0 },
      configVersionRef: { current: 1 }, lastSavedSignatureRef: { current: '' },
      interactionStateRef: { current: createInteractionState() } };
    const hook = renderHook(() => useTimelinePersistence(options), { wrapper });
    try {
      act(() => { hook.result.current.scheduleSave(data); });
      await act(async () => {
        await expect(hook.result.current.flushPendingSave()).rejects.toThrow('Scoped timeline save binding');
      });
      expect(capture).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(provider.saveTimeline).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  },
);
