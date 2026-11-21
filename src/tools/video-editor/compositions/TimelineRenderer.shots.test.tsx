// @vitest-environment jsdom
//
// Regression tests for the shot-boundary playback blink fix.
//
// Previously ShotClipSequence cleared `childConfig` and asynchronously
// reloaded the referenced timeline on EVERY mount, so crossing a shot
// boundary during playback flashed the dark "Loading shot…" placeholder.
// The fix caches resolved child configs per (provider, timelineId) with:
//   - promise dedup for repeated/concurrent loads
//   - synchronous cache reuse on remount (useSyncExternalStore first-render)
//   - explicit invalidation after a child save
//   - premounting so the next shot is mounted before the boundary

import type { FC, PropsWithChildren } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TimelineRenderer,
  invalidateReferencedTimelineCache,
} from '@/tools/video-editor/compositions/TimelineRenderer';
import type { DataProvider, LoadedReferencedTimeline } from '@/tools/video-editor/data/DataProvider.ts';
import {
  VideoEditorRuntimeContext,
  type VideoEditorRuntimeContextValue,
} from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types';
import type {
  AstridElementComponentProps,
  AstridElementHost,
} from '@/tools/video-editor/runtime/astrid-element-host.ts';

const mockSequenceState = vi.hoisted(() => ({ frame: 0, windowing: false, width: 1920, height: 1080 }));

vi.mock('remotion', async () => {
  return {
    delayRender: () => 0,
    continueRender: () => {},
    AbsoluteFill: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
      <div data-testid="absolute-fill" {...props}>{children}</div>
    ),
    Sequence: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
      const from = typeof props.from === 'number' ? props.from : 0;
      const duration = typeof props.durationInFrames === 'number' ? props.durationInFrames : Infinity;
      const premountFor = typeof props.premountFor === 'number' ? props.premountFor : 0;
      const frame = mockSequenceState.frame;
      const active = frame >= from && frame < from + duration;
      const mounted = !mockSequenceState.windowing || (
        frame >= from - premountFor && frame < from + duration
      );
      if (!mounted) return null;
      return (
        <div
          data-testid="sequence"
          data-from={from}
          data-duration={duration}
          data-premount-for={premountFor}
          data-active={String(active)}
          style={active ? undefined : { display: 'none' }}
        >
          {children}
        </div>
      );
    },
    useCurrentFrame: () => mockSequenceState.frame,
    useVideoConfig: () => ({width: mockSequenceState.width, height: mockSequenceState.height, fps: 30}),
    useRemotionEnvironment: () => ({ isRendering: false, isClientSideRendering: false }),
  };
});

// The child timeline's clips render through VisualClipSequence; replace it
// with a marker so tests can assert the cached child config actually mounts.
vi.mock('@/tools/video-editor/compositions/VisualClip.tsx', () => ({
  VisualClipSequence: ({clip}: {clip: {x?: number; width?: number; fit?: string}}) => <div data-testid="child-shot-content" data-x={clip.x} data-width={clip.width} data-fit={clip.fit}>child-shot-content</div>,
}));

vi.mock('@/tools/video-editor/compositions/AudioAnalysisProvider', () => ({
  AudioAnalysisProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));

const CHILD_MARKER = 'child-shot-content';

const makeAstridHost = (identity: 'A' | 'B'): AstridElementHost => ({
  // The renderer resolves an element only when the host declares its descriptor.
  descriptors: [
    { id: 'host-probe', kind: 'effect', revision: 'probe-v1', componentPath: 'host-probe/component.tsx' },
  ],
  sequenceRegistry: {},
  resolveComponent: (elementId, kind) => {
    if (elementId !== 'host-probe' || kind !== 'effect') return undefined;
    const HostProbe: FC<AstridElementComponentProps> = () => (
      <div data-testid={`host-probe-${identity}`}>{identity}</div>
    );
    return HostProbe;
  },
  resolveSequenceClipEntry: () => undefined,
  describeClipCapability: () => undefined,
});

const HOST_A = makeAstridHost('A');
const HOST_B = makeAstridHost('B');

const childConfig = (): ResolvedTimelineConfig => ({
  output: { resolution: '1920x1080', fps: 30, file: 'child.mp4' },
  tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
  clips: [
    { id: 'child-clip-1', clipType: 'hold', track: 'V1', at: 0, hold: 1, params: {} },
  ],
  registry: {},
});

const hostProbeConfig = (): ResolvedTimelineConfig => ({
  output: { resolution: '1920x1080', fps: 30, file: 'host-probe.mp4' },
  tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
  clips: [{
    id: 'host-probe-clip',
    clipType: 'host-probe',
    track: 'V1',
    at: 0,
    hold: 1,
    params: {},
    elementRef: { id: 'host-probe', kind: 'effect', revision: 'probe-v1' },
  }],
  registry: {},
});

const nestedShotConfig = (timelineDocumentId: string): ResolvedTimelineConfig => ({
  output: { resolution: '1920x1080', fps: 30, file: 'nested-shot.mp4' },
  tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
  clips: [{
    id: 'nested-shot',
    clipType: 'shot',
    track: 'V1',
    at: 0,
    hold: 1,
    params: { timeline_document_id: timelineDocumentId },
  }],
  registry: {},
});

const parentConfig = (timelineDocumentId: string, clipId = 'shot-1'): ResolvedTimelineConfig => ({
  output: { resolution: '1920x1080', fps: 30, file: 'parent.mp4' },
  tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
  clips: [
    {
      id: clipId,
      clipType: 'shot',
      track: 'V1',
      at: 0,
      hold: 2,
      params: { timeline_document_id: timelineDocumentId },
    },
  ],
  registry: {},
});

type Deferred = {
  promise: Promise<LoadedReferencedTimeline>;
  resolve: (value: LoadedReferencedTimeline) => void;
};

const makeDeferred = (): Deferred => {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<LoadedReferencedTimeline>((res) => { resolve = res; });
  return { promise, resolve };
};

const makeProvider = (options: { load: (timelineId: string) => Promise<LoadedReferencedTimeline> }) => {
  const loadSpy = vi.fn(options.load);
  const provider = { loadReferencedTimeline: loadSpy } as unknown as DataProvider;
  return { provider, loadSpy };
};

const loadedChild = (): LoadedReferencedTimeline => ({
  timeline: { config: childConfig() as never, configVersion: 1 },
  registry: { assets: {} } as never,
  resolveAssetUrl: async (file: string) => file,
});

const renderShot = (
  provider: DataProvider,
  timelineId = 'child-timeline',
  options: {
    contextHost?: AstridElementHost | null;
    explicitHost?: AstridElementHost;
  } = {},
) => {
  const contextValue = {
    provider,
    ...(options.contextHost === null
      ? {}
      : { astridElementHost: options.contextHost ?? HOST_A }),
  } as unknown as VideoEditorRuntimeContextValue;
  return render(
    <VideoEditorRuntimeContext.Provider value={contextValue}>
      <TimelineRenderer
        config={parentConfig(timelineId)}
        astridElementHost={options.explicitHost}
      />
    </VideoEditorRuntimeContext.Provider>,
  );
};

describe('ShotClipSequence referenced-timeline cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockSequenceState.frame = 0;
    mockSequenceState.windowing = false;
  });

  it('keeps explicit host B through two nested shot levels instead of switching to context host A', async () => {
    const { provider } = makeProvider({
      load: async (timelineId) => ({
        timeline: {
          config: (timelineId === 'child-level-1'
            ? nestedShotConfig('child-level-2')
            : hostProbeConfig()) as never,
          configVersion: 1,
        },
        registry: { assets: {} } as never,
        resolveAssetUrl: async (file: string) => file,
      }),
    });

    renderShot(provider, 'child-level-1', { contextHost: HOST_A, explicitHost: HOST_B });

    expect(await screen.findByTestId('host-probe-B')).toBeInTheDocument();
    expect(screen.queryByTestId('host-probe-A')).toBeNull();
  });

  it('retains context host A through nested shots when there is no explicit override', async () => {
    const { provider } = makeProvider({ load: async () => ({
      ...loadedChild(),
      timeline: { config: hostProbeConfig() as never, configVersion: 1 },
    }) });

    renderShot(provider, 'context-host-child', { contextHost: HOST_A });

    expect(await screen.findByTestId('host-probe-A')).toBeInTheDocument();
    expect(screen.queryByTestId('host-probe-B')).toBeNull();
  });

  it('renders nested content with explicit host B when the provider context has no host', async () => {
    const { provider } = makeProvider({ load: async () => ({
      ...loadedChild(),
      timeline: { config: hostProbeConfig() as never, configVersion: 1 },
    }) });

    renderShot(provider, 'provider-only-child', { contextHost: null, explicitHost: HOST_B });

    expect(await screen.findByTestId('host-probe-B')).toBeInTheDocument();
  });

  it('updates the cached nested timeline when the explicit host changes without remounting', async () => {
    const { provider } = makeProvider({ load: async () => ({
      ...loadedChild(),
      timeline: { config: hostProbeConfig() as never, configVersion: 1 },
    }) });
    const view = renderShot(provider, 'host-rerender-child', {
      contextHost: HOST_A,
      explicitHost: HOST_A,
    });

    expect(await screen.findByTestId('host-probe-A')).toBeInTheDocument();

    view.rerender(
      <VideoEditorRuntimeContext.Provider value={{
        provider,
        astridElementHost: HOST_A,
      } as unknown as VideoEditorRuntimeContextValue}>
        <TimelineRenderer
          config={parentConfig('host-rerender-child')}
          astridElementHost={HOST_B}
        />
      </VideoEditorRuntimeContext.Provider>,
    );

    expect(await screen.findByTestId('host-probe-B')).toBeInTheDocument();
    expect(screen.queryByTestId('host-probe-A')).toBeNull();
  });

  it('fails loudly when neither runtime context nor props provide an Astrid host', () => {
    const { provider } = makeProvider({ load: async () => loadedChild() });

    expect(() => renderShot(provider, 'missing-host-child', { contextHost: null })).toThrow(
      'TimelineRenderer requires an explicit AstridElementHost',
    );
    mockSequenceState.frame = 0;
    mockSequenceState.windowing = false;
  });

  it('deduplicates repeated sequential mounts: one load, second mount synchronous', async () => {
    const deferred = makeDeferred();
    const { provider, loadSpy } = makeProvider({ load: () => deferred.promise });

    const first = renderShot(provider);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // Resolve the first load.
    await act(async () => {
      deferred.resolve(loadedChild());
    });
    await waitFor(() => {
      expect(screen.getByText(CHILD_MARKER)).toBeTruthy();
    });
    first.unmount();

    // Remount with the SAME provider: served from cache, no second load.
    const second = renderShot(provider);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    // Synchronous reuse: the child content is present immediately, without
    // a loading placeholder frame.
    expect(screen.getByText(CHILD_MARKER)).toBeTruthy();
    expect(screen.queryByTestId('shot-preview-loading')).toBeNull();
    second.unmount();
  });

  it('deduplicates concurrent mounts sharing one in-flight load', async () => {
    const deferred = makeDeferred();
    const { provider, loadSpy } = makeProvider({ load: () => deferred.promise });

    const a = renderShot(provider, 'shared-child');
    const b = renderShot(provider, 'shared-child');

    expect(loadSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve(loadedChild());
    });
    await waitFor(() => {
      expect(screen.getAllByText(CHILD_MARKER)).toHaveLength(2);
    });
    a.unmount();
    b.unmount();
  });

  it('no loading placeholder when crossing a primed shot boundary (cached config reused synchronously)', async () => {
    const deferred = makeDeferred();
    const { provider, loadSpy } = makeProvider({ load: () => deferred.promise });

    // Prime: mount once and let the load settle.
    const priming = renderShot(provider);
    await act(async () => {
      deferred.resolve(loadedChild());
    });
    await waitFor(() => {
      expect(screen.getByText(CHILD_MARKER)).toBeTruthy();
    });
    priming.unmount();

    // Remount (simulates the playhead crossing back into a primed shot):
    // the cached child config must be reused on the FIRST render — the
    // loading placeholder must never appear.
    const remounted = renderShot(provider);
    expect(screen.queryByTestId('shot-preview-loading')).toBeNull();
    expect(screen.getByText(CHILD_MARKER)).toBeTruthy();
    expect(loadSpy).toHaveBeenCalledTimes(1);
    remounted.unmount();
  });

  it('sequences premount so the next shot mounts before the boundary', async () => {
    const deferred = makeDeferred();
    const { provider } = makeProvider({ load: () => deferred.promise });

    renderShot(provider);
    await act(async () => {
      deferred.resolve(loadedChild());
    });
    await waitFor(() => {
      expect(screen.getByText(CHILD_MARKER)).toBeTruthy();
    });

    const sequence = screen.getByTestId('sequence');
    expect(sequence.getAttribute('data-premount-for')).toBe('60'); // fps 30 * 2
  });

  it('keeps nested child content mounted while hidden before a canonical shot boundary', async () => {
    const { provider, loadSpy } = makeProvider({ load: async () => loadedChild() });
    mockSequenceState.frame = 29;
    mockSequenceState.windowing = true;

    const contextValue = { provider } as unknown as VideoEditorRuntimeContextValue;
    const config: ResolvedTimelineConfig = {
      ...parentConfig('canonical-child'),
      clips: [{
        id: 'canonical-shot',
        clipType: 'shot',
        track: 'V1',
        at: 1,
        hold: 1,
        params: { timeline_document_id: 'canonical-child' },
        app: { canonicalTiming: { start: 1, duration: 1 } },
      } as never],
    };
    const view = render(
      <VideoEditorRuntimeContext.Provider value={contextValue}>
        <TimelineRenderer astridElementHost={HOST_A} config={config} />
      </VideoEditorRuntimeContext.Provider>,
    );

    const marker = await screen.findByTestId('child-shot-content');
    const hiddenPremount = screen.getAllByTestId('sequence').find((sequence) => (
      sequence.contains(marker) && sequence.getAttribute('data-premount-for') === '60'
    ));
    expect(hiddenPremount).toBeTruthy();
    expect(hiddenPremount?.getAttribute('data-premount-for')).toBe('60');
    expect(hiddenPremount?.getAttribute('data-active')).toBe('false');
    expect((hiddenPremount as HTMLElement).style.display).toBe('none');
    expect(loadSpy).toHaveBeenCalledTimes(1);

    mockSequenceState.frame = 30;
    view.rerender(
      <VideoEditorRuntimeContext.Provider value={contextValue}>
        <TimelineRenderer astridElementHost={HOST_A} config={config} />
      </VideoEditorRuntimeContext.Provider>,
    );
    expect(screen.getByTestId('child-shot-content')).toBe(marker);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidates a specific timeline after a save so the next mount reloads fresh data', async () => {
    let loadCount = 0;
    const deferred = makeDeferred();
    const { provider, loadSpy } = makeProvider({
      load: () => {
        loadCount += 1;
        return deferred.promise;
      },
    });

    const mounted = renderShot(provider);
    await act(async () => {
      deferred.resolve(loadedChild());
    });
    await waitFor(() => {
      expect(screen.getByText(CHILD_MARKER)).toBeTruthy();
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);

    act(() => {
      invalidateReferencedTimelineCache(provider, 'child-timeline');
    });

    // After invalidation the same mounted component re-kicks the load.
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(2);
    });

    // And a later remount shares the fresh in-flight load rather than stale
    // data or a third duplicate request.
    mounted.unmount();
    const fresh = renderShot(provider);
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(2);
    });
    expect(loadCount).toBe(2);
    fresh.unmount();
  });

  it('a failed load falls back to the placeholder and retries on a later mount', async () => {
    const { provider, loadSpy } = makeProvider({
      load: () => Promise.reject(new Error('child missing')),
    });

    const first = renderShot(provider);
    await waitFor(() => {
      expect(screen.getByTestId('shot-preview-loading')).toBeTruthy();
    });
    first.unmount();

    // The failed entry was dropped: a remount retries the load.
    const second = renderShot(provider);
    expect(loadSpy).toHaveBeenCalledTimes(2);
    second.unmount();
  });
});

it('refuses a legacy referenced shot whose child canvas differs from the Player before drawing', async () => {
  const child = childConfig();
  mockSequenceState.width = 1280;
  mockSequenceState.height = 720;
  child.tracks[0].scale = 2;
  child.clips[0] = {...child.clips[0], x: 0, y: 0, width: 1920, height: 1080};
  const {provider} = makeProvider({load: async () => ({timeline: {config: child, configVersion: 1}, registry: {assets: {}}, resolveAssetUrl: async file => file})});
  renderShot(provider, 'different-canvas');
  const alert = await screen.findByTestId('shot-preview-unsupported-canvas');
  expect(alert).toHaveTextContent("Shot clip 'shot-1'");
  expect(alert).toHaveTextContent('different-canvas');
  expect(alert).toHaveTextContent('output.resolution');
  expect(screen.queryByTestId('child-shot-content')).toBeNull();
  mockSequenceState.width = 1920;
  mockSequenceState.height = 1080;
});


it('normalizes a same-canvas legacy child once before nesting it', async () => {
  const child = childConfig();
  child.tracks[0].scale = 2;
  child.clips[0] = {...child.clips[0], clipType: 'media', asset: 'a', x: 0, y: 0, width: 1920, height: 1080};
  const original = structuredClone(child);
  const {provider} = makeProvider({load: async () => ({timeline: {config: child, configVersion: 1}, registry: {assets: {a: {file: 'a.png', type: 'image/png', resolution: '1920x1080'}}}, resolveAssetUrl: async file => file})});
  renderShot(provider, 'same-canvas');
  const marker = await screen.findByTestId('child-shot-content');
  expect(marker).toHaveAttribute('data-x', '480');
  expect(marker).toHaveAttribute('data-width', '960');
  expect(marker).toHaveAttribute('data-fit', 'cover');
  expect(child).toEqual(original);
});
