import { getAdmittedElementSelection, subscribeAdmittedElements } from '../runtime/admitted-elements';
import { AbsoluteFill, Sequence, useCurrentFrame, useRemotionEnvironment } from 'remotion';
import { Component, createContext, memo, useContext, useMemo, useSyncExternalStore, type ComponentType, type FC, type ReactNode } from 'react';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';
import { getAudioTracks, getVisualTracks } from '@/tools/video-editor/lib/editor-utils.ts';
import { getClipDurationInFrames, getTimelineDurationInFrames, resolveTimelineConfig, secondsToFrames } from '@/tools/video-editor/lib/config-utils.ts';
import { BUILTIN_CLIP_TYPES } from '@/sdk/video/timeline/clipTypes.ts';
import { clipSourceTime } from '../clip-types/sourceTime';
import {
  type ParameterSchema,
  type ResolvedTimelineClip,
  type ResolvedTimelineConfig,
  type TimelineConfig,
  type TrackDefinition,
} from '@/tools/video-editor/types/index.ts';
import { AudioTrack } from '@/tools/video-editor/compositions/AudioTrack.tsx';
import { AudioAnalysisProvider } from '@/tools/video-editor/compositions/AudioAnalysisProvider.tsx';
import { timelineNeedsAudioAnalysis } from '@/tools/video-editor/compositions/audio-analysis/audioAnalysisDemand.ts';
import { LocalFontFaces } from '@/tools/video-editor/compositions/LocalFontFaces.tsx';
import { partitionTrackGroups } from './partitionTrackGroups.ts';
import { EffectLayerSequence } from '@/tools/video-editor/compositions/EffectLayerSequence.tsx';
import { TextClipSequence } from '@/tools/video-editor/compositions/TextClip.tsx';
import { wrapWithClipEffects } from '@/tools/video-editor/effects/index.tsx';
import { useOptionalEffectRegistryContext } from '@/tools/video-editor/effects/registry/index.ts';
import { AudioReactiveColourSequence } from '@/tools/video-editor/compositions/AudioReactiveColour.tsx';
import { VisualClip, VisualClipSequence } from '@/tools/video-editor/compositions/VisualClip.tsx';
import { ClipTransition, clipSequenceTiming } from '@/tools/video-editor/compositions/ClipTransition.tsx';
import { UnknownClipPlaceholderSequence } from '@/tools/video-editor/compositions/UnknownClipPlaceholder.tsx';
import { resolveTimelineRenderTheme } from '@/tools/video-editor/compositions/installed-themes.ts';
import {
  getGeneratedRemotionModuleStatus,
  isGeneratedRemotionModuleClip,
} from '@/tools/video-editor/lib/generated-lanes.ts';
import { materializeResolvedSequenceConfig } from '@/tools/video-editor/sequences/materialize.ts';
import {
  ThemeProvider,
  useTheme,
  type RuntimeTheme,
} from '@banodoco/timeline-composition/theme-api';
import { requireAstridElementHost, type AstridElementHost, type AstridDynamicSequenceEntry as DynamicSequenceComponentEntry } from '@/tools/video-editor/runtime/astrid-element-host.ts';
import { useSequenceComponentRegistrySnapshot } from '@/tools/video-editor/sequences/SequenceComponentRegistryContext.tsx';
import { useClipTypeRegistrySnapshot } from '@/tools/video-editor/clip-types/ClipTypeRegistryContext.tsx';
import type {
  ClipRendererLiveBinding,
  ClipRendererLiveProps,
  ClipRendererProps,
  ClipTypeRegistryRecord,
} from '@/tools/video-editor/clip-types/ClipTypeRegistry.ts';
import { applyAutomationOverrides, resolveAnimatedParams } from '@/tools/video-editor/keyframes/index.ts';
import { VideoEditorRuntimeContext } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import {
  getTimelinePostprocessShader,
  scanTimelineLiveBindings,
  type TimelineLiveBindingRecord,
  type TimelineLiveSourceSnapshot,
} from '@/tools/video-editor/lib/timeline-domain.ts';
import type { LiveDataRegistry, LiveDataRegistrySnapshot } from '@/tools/video-editor/runtime/liveDataRegistry.ts';
import type { LiveChannelDescriptor, LiveChannelMetadata, LiveSample, LiveSource } from '@astrid/editor-sdk';
import { PostprocessShaderPreviewCanvas } from '@/tools/video-editor/shaders/preview/PostprocessShaderPreviewCanvas.tsx';
import { useShaderEffectRegistrySnapshot } from '@/tools/video-editor/shaders/registry/index.ts';
import { boundCanonicalConfigClips } from '@/tools/video-editor/lib/canonicalRenderBounds.ts';
import { resolveEndSpanningLayerPreviewParams } from '@/tools/video-editor/sequences/components/EndSpanningLayerSequence.tsx';
import { projectOutputTimelineConfig } from '@/tools/video-editor/data/timelineOutputProjection.ts';
import { mediaCrossOrigin } from '@/shared/lib/media/mediaCrossOrigin';

const AstridElementHostContext = createContext<AstridElementHost | null>(null);
const useAstridElementHost = () => requireAstridElementHost(useContext(AstridElementHostContext));
const resolveHostComponent = (host: AstridElementHost, ref: NonNullable<ResolvedTimelineClip['elementRef']>) => (
  host.descriptors.some(entry => entry.id === ref.id && entry.kind === ref.kind && entry.packId === ref.packId && entry.revision === ref.revision)
    ? host.resolveComponent(ref.id, ref.kind, ref.packId, ref.revision) : undefined
);

// EFFECT_REGISTRY dispatch.
//
// Mirrors `tools/remotion/src/HypeComposition.tsx:58-64` (lifted into
// `packages/timeline-composition/typescript/src/TimelineComposition.tsx`).
// Lookup chain for a clipType:
//
//   1. Astrid App-native built-ins (effect-layer, text, media, hold) — same as
//      pre-Sprint-5 behavior.
//   2. THEME_PACKAGE_REGISTRY (codegenned from installed
//      @banodoco/timeline-theme-* packages) — render the theme component.
//   3. Sprint-3 loud placeholder — defensive fallback when the theme
//      package isn't installed OR the clipType is unknown.
const isBuiltinClipType = (value: string | undefined): boolean => {
  if (typeof value !== 'string') {
    return true; // legacy clips with no clipType default to media-equivalent dispatch
  }
  if (value === 'image') return true;
  return (BUILTIN_CLIP_TYPES as readonly string[]).includes(value);
};

// Dynamic-aware sequence-component dispatch check. Built-in entries match
// SEQUENCE_COMPONENT_REGISTRY directly; DB-stored entries (clipType
// `custom:<name>`) match via the dynamic resolver. We accept any clipType
// that has a registry entry on either side and a browser-preview-capable
// capability descriptor.
const isSequenceComponentClipType = (
  host: AstridElementHost,
  value: string | undefined,
  dynamicEntries: readonly DynamicSequenceComponentEntry[],
): boolean => {
  if (typeof value !== 'string') return false;
  if (host.resolveSequenceClipEntry(value, dynamicEntries)) return true;
  return Object.prototype.hasOwnProperty.call(host.sequenceRegistry, value);
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/**
 * Resolved-child-config cache for nested `clipType: 'shot'` clips.
 *
 * Playback must not blink black at shot boundaries. ShotClipSequence clears
 * `childConfig` and reloads the referenced timeline asynchronously on every mount,
 * so the cache keeps the loaded timeline. The cache works at two levels:
 *
 * 1. `loadReferencedTimelineIntoCache` deduplicates: repeated and concurrent
 *    loads of the same (provider, timeline) pair share one in-flight promise,
 *    and the resolved config is memoized so remounts resolve synchronously.
 * 2. `useSyncExternalStore` exposes the cached value during the FIRST render,
 *    so a remount at a shot boundary reuses the cached child config without a
 *    loading-placeholder frame.
 *
 * Invalidation semantics:
 * - The cache key is the provider instance itself (WeakMap): a fresh provider
 *   (different editor document, session, or save target) never sees a stale
 *   entry.
 * - `invalidateReferencedTimelineCache` drops a specific timeline (after a
 *   child save) or the whole provider entry (no argument). The editor save
 *   path calls this so the next boundary crossing reloads fresh data.
 */
type ShotChildCacheEntry = {
  readonly subscribe: (listener: () => void) => () => void;
  /** Notify all subscribers (used after the entry resolves or is dropped). */
  readonly notify: () => void;
  /** Latest settled outcome: resolved config, or `null` when the load failed. */
  resolved: ResolvedTimelineConfig | null;
  settled: boolean;
};

const shotChildCacheByProvider = new WeakMap<object, Map<string, ShotChildCacheEntry>>();

const loadReferencedTimelineIntoCache = (
  provider: DataProvider,
  timelineId: string,
): ShotChildCacheEntry => {
  let byTimeline = shotChildCacheByProvider.get(provider);
  if (!byTimeline) {
    byTimeline = new Map();
    shotChildCacheByProvider.set(provider, byTimeline);
  }

  const listeners = new Set<() => void>();
  const entry: ShotChildCacheEntry = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
    resolved: null,
    settled: false,
  };
  // Register BEFORE kicking the load: concurrent mounts dedupe against this
  // entry from the moment creation starts.
  byTimeline.set(timelineId, entry);

  // Note: `promise` is intentionally not returned — dedup relies on the
  // entry living in the cache Map from the moment creation starts.
  provider.loadReferencedTimeline?.(timelineId).then(async ({ timeline, registry, resolveAssetUrl }) => {
    const resolved = await resolveTimelineConfig(timeline.config, registry, resolveAssetUrl);
    entry.resolved = resolved;
    entry.settled = true;
    entry.notify();
    return resolved;
  }).catch((error) => {
    // A missing child should not replace the whole parent preview with an
    // unsupported-clip banner. The slot remains empty until it is fixed;
    // the failed entry is dropped so a later mount can retry the load.
    console.error('[ShotClipSequence] referenced timeline load failed:', error);
    byTimeline.delete(timelineId);
    entry.settled = true;
    entry.notify();
    return null;
  });

  return entry;
};

export const invalidateReferencedTimelineCache = (
  provider: DataProvider,
  timelineId?: string,
): void => {
  const byTimeline = shotChildCacheByProvider.get(provider);
  if (!byTimeline) return;
  if (timelineId === undefined) {
    // Notify every subscriber before dropping, so components re-run their
    // getSnapshot (now a miss) and re-kick a fresh load on re-subscribe.
    for (const entry of byTimeline.values()) entry.notify();
    shotChildCacheByProvider.delete(provider);
    return;
  }
  const entry = byTimeline.get(timelineId);
  if (!entry) return;
  byTimeline.delete(timelineId);
  entry.notify();
};

const getShotChildSnapshot = (entry: ShotChildCacheEntry | null): ResolvedTimelineConfig | null => (
  entry?.settled ? entry.resolved : null
);

const ShotClipSequence: FC<{ clip: ResolvedTimelineClip; fps: number }> = ({ clip, fps }) => {
  const runtime = useContext(VideoEditorRuntimeContext);
  const timelineDocumentId = isRecord(clip.params) && typeof clip.params.timeline_document_id === 'string'
    ? clip.params.timeline_document_id
    : null;
  const durationInFrames = getClipDurationInFrames(clip, fps);
  const provider = runtime?.provider ?? null;

  // useSyncExternalStore reuses a settled cache entry synchronously on the
  // FIRST render — no effect round-trip, no loading placeholder on remount.
  // The subscribe callback also guarantees an entry exists: on a cache miss
  // it kicks off the (deduplicated) load and then subscribes to that entry,
  // so the arriving config triggers the re-render. Concurrent/repeated
  // mounts of the same (provider, timeline) pair share one entry.
  const childConfig = useSyncExternalStore(
    provider && timelineDocumentId && provider.loadReferencedTimeline
      ? (listener) => {
          const byTimeline = shotChildCacheByProvider.get(provider);
          let entry = byTimeline?.get(timelineDocumentId);
          if (!entry) {
            entry = loadReferencedTimelineIntoCache(provider, timelineDocumentId);
          }
          return entry.subscribe(listener);
        }
      : () => () => {},
    () => {
      if (!provider || !timelineDocumentId) return null;
      const existing = shotChildCacheByProvider.get(provider)?.get(timelineDocumentId);
      return existing ? getShotChildSnapshot(existing) : null;
    },
    () => null,
  );

  return (
    <Sequence
      key={clip.id}
      from={Math.max(0, Math.round(clip.at * fps))}
      durationInFrames={durationInFrames}
      // Premount the child renderer so its image/video elements are ready
      // before the playhead reaches this shot. Remotion keeps the premounted
      // subtree hidden until `from`, preserving canonical half-open timing.
      // Without this, the child timeline config is cached early but its media
      // still mounts on the boundary and can flash while loading/decoding.
      premountFor={Math.ceil(fps * 2)}
    >
      {childConfig ? (
        <TimelineRenderer config={childConfig} />
      ) : (
        <AbsoluteFill
          data-testid="shot-preview-loading"
          style={{
            alignItems: 'center',
            backgroundColor: '#0b0b0b',
            color: '#9ca3af',
            display: 'flex',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12,
            justifyContent: 'center',
          }}
        >
          Loading shot…
        </AbsoluteFill>
      )}
    </Sequence>
  );
};

const sortClipsByAt = (clips: ResolvedTimelineClip[]): ResolvedTimelineClip[] => {
  return [...clips].sort((left, right) => left.at - right.at);
};

const previewPremountFor = (fps: number): number => Math.ceil(fps * 2);

type ThemeEffectSequenceProps = {
  clip: ResolvedTimelineClip;
  fps: number;
  theme: RuntimeTheme;
  dynamicEntries: readonly DynamicSequenceComponentEntry[];
  predecessor?: ResolvedTimelineClip | null;
};

const resolveAstridComponentAssetEntry = (
  assetEntry: ResolvedTimelineClip['assetEntry'],
): ResolvedTimelineClip['assetEntry'] => (
  assetEntry?.src
    ? { ...assetEntry, file: assetEntry.src }
    : assetEntry
);

const ElementClipEffects: FC<{ clip: ResolvedTimelineClip; fps: number; children: ReactNode }> = ({ clip, fps, children }) => {
  const registry = useOptionalEffectRegistryContext();
  const content = <ClipTransition clip={clip} fps={fps}>{children}</ClipTransition>;
  const wrapped = wrapWithClipEffects(content, clip, getClipDurationInFrames(clip, fps), fps, registry?.snapshot);
  // The package applies `clip.opacity` to element clips; media and text apply it in their own body.
  if (clip.opacity === undefined || clip.opacity === 1) return <>{wrapped}</>;
  return <div style={{ position: 'absolute', inset: 0, opacity: Math.min(1, Math.max(0, clip.opacity)) }}>{wrapped}</div>;
};

const ThemePackageComponent: FC<{
  component: FC<{
    clip: ResolvedTimelineClip;
    params: unknown;
    theme: RuntimeTheme;
    fps: number;
    assetEntry?: ResolvedTimelineClip['assetEntry'];
  }>;
  clip: ResolvedTimelineClip;
  fps: number;
}> = ({ component: Component, clip, fps }) => {
  const theme = useTheme();
  // `file` is the persisted locator; `src` is the host-resolved browser URL.
  // Pack effects consume the component contract's `assetEntry.file`, so make
  // the resolved URL the file presented to them without mutating timeline data.
  const assetEntry = resolveAstridComponentAssetEntry(clip.assetEntry);
  return <Component clip={clip} params={clip.params} theme={theme} fps={fps} assetEntry={assetEntry} />;
};

const ThemeEffectSequence: FC<ThemeEffectSequenceProps> = ({ clip, fps, theme, dynamicEntries, predecessor }) => {
  const host = useAstridElementHost();
  // Dynamic-aware lookup: prefer DB-stored components for `custom:` clipTypes;
  // fall back to the static SEQUENCE_COMPONENT_REGISTRY for built-ins.
  const dynamicEntry = host.resolveSequenceClipEntry(clip.clipType, dynamicEntries);
  const staticEntry = clip.clipType ? host.sequenceRegistry[clip.clipType] : undefined;
  const Component = (dynamicEntry?.component ?? staticEntry?.component) as
    | FC<{
      clip: ResolvedTimelineClip;
      params: unknown;
      theme: RuntimeTheme;
      fps: number;
      assetEntry?: ResolvedTimelineClip['assetEntry'];
    }>
    | undefined;
  // Defensive: if neither registry has the component, fall back to the loud
  // placeholder. This is the second layer of the "loud placeholder"
  // safety net for clipTypes that *are* in the registry but somehow fail to
  // render.
  if (!Component) {
    return <UnknownClipPlaceholderSequence clip={clip} fps={fps} reason="unsupported" />;
  }
  const { from, effectiveDuration } = clipSequenceTiming(clip, fps, predecessor);
  return (
    <Sequence
      key={clip.id}
      from={from}
      durationInFrames={effectiveDuration}
      premountFor={dynamicEntry ? 0 : previewPremountFor(fps)}
    >
      <ThemeProvider value={theme}>
        <ElementClipEffects clip={clip} fps={fps}>
          <ThemePackageComponent component={Component} clip={clip} fps={fps} />
        </ElementClipEffects>
      </ThemeProvider>
    </Sequence>
  );
};

const AstridEffectPreviewSequence: FC<{
  clip: ResolvedTimelineClip;
  fps: number;
  theme: RuntimeTheme;
  assetEntry?: ResolvedTimelineClip['assetEntry'];
  resolvedAssets: ResolvedTimelineConfig['registry'];
  predecessor?: ResolvedTimelineClip | null;
  component?: ComponentType<{
    clip: ResolvedTimelineClip;
    params: Record<string, unknown>;
    theme: RuntimeTheme;
    fps: number;
    assetEntry?: ResolvedTimelineClip['assetEntry'];
  }>;
}> = ({ clip, fps, theme, assetEntry, resolvedAssets, component, predecessor }) => {
  const host = useAstridElementHost();
  const Component = component ?? (clip.elementRef
    ? resolveHostComponent(host, clip.elementRef)
    : undefined);
  const { from, effectiveDuration } = clipSequenceTiming(clip, fps, predecessor);
  if (!Component) return null;
  const ref = clip.elementRef;
  const owner = ref && host.descriptors.find(candidate => candidate.id === ref.id && candidate.kind === ref.kind
    && candidate.packId === ref.packId && candidate.revision === ref.revision);
  const params = owner?.packId === 'local' && owner.kind === 'effect' && owner.id === 'end-spanning-layer'
    ? resolveEndSpanningLayerPreviewParams(clip.params, resolvedAssets) : clip.params ?? {};
  return (
    <Sequence
      key={clip.id}
      from={from}
      durationInFrames={effectiveDuration}
      // Canonical child clips are flattened into the parent preview, so they
      // cannot rely on ShotClipSequence to prepare their media. In particular
      // an Astrid effect replacing a still must mount its own first frame
      // before its authored occurrence boundary.
      premountFor={previewPremountFor(fps)}
    >
      <ThemeProvider value={theme}>
        <ElementClipEffects clip={clip} fps={fps}>
          <Component
            clip={clip}
            params={params}
            theme={theme}
            fps={fps}
            assetEntry={resolveAstridComponentAssetEntry(assetEntry)}
          />
        </ElementClipEffects>
      </ThemeProvider>
    </Sequence>
  );
};

const AstridAnimationPreviewSequence: FC<{
  clip: ResolvedTimelineClip;
  track: TrackDefinition;
  fps: number;
  theme: RuntimeTheme;
  predecessor?: ResolvedTimelineClip | null;
}> = ({ clip, track, fps, theme, predecessor }) => {
  const host = useAstridElementHost();
  const Component = clip.elementRef
    ? resolveHostComponent(host, clip.elementRef)
    : undefined;
  const { from, effectiveDuration } = clipSequenceTiming(clip, fps, predecessor);
  if (!Component) return null;
  return (
    <Sequence
      key={clip.id}
      from={from}
      durationInFrames={effectiveDuration}
      premountFor={previewPremountFor(fps)}
    >
      <ThemeProvider value={theme}>
        <Component
          clip={clip}
          params={clip.params ?? {}}
          theme={theme}
          fps={fps}
          children={(
            <VisualClip
              clip={clip}
              track={track}
              fps={fps}
              predecessor={predecessor}
            />
          )}
        />
      </ThemeProvider>
    </Sequence>
  );
};

const GeneratedModulePlaceholderSequence: FC<{
  clip: ResolvedTimelineClip;
  fps: number;
  artifactId?: string | null;
  reason: string;
  detail: string;
}> = ({ clip, fps, artifactId, reason, detail }) => {
  const durationInFrames = getClipDurationInFrames(clip, fps);
  return (
    <Sequence
      key={clip.id}
      from={Math.max(0, Math.round(clip.at * fps))}
      durationInFrames={durationInFrames}
    >
      <AbsoluteFill
        data-testid="generated-module-placeholder"
        data-clip-id={clip.id}
        data-artifact-id={artifactId ?? undefined}
        data-placeholder-reason={reason}
        style={{
          backgroundColor: '#111827',
          borderTop: '2px solid #38bdf8',
          borderBottom: '2px solid #38bdf8',
          color: '#e0f2fe',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '12px 24px',
          textAlign: 'center',
          fontFamily: 'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace',
          fontSize: 14,
          lineHeight: 1.4,
          letterSpacing: '0.04em',
        }}
      >
        <div style={{ maxWidth: '80%', padding: '8px 16px', borderRadius: 4, background: 'rgba(0, 0, 0, 0.45)' }}>
          {detail}
        </div>
      </AbsoluteFill>
    </Sequence>
  );
};

// ---------------------------------------------------------------------------
// Extension clip renderer dispatch
// ---------------------------------------------------------------------------

/** Parse width and height from a resolution string like "1920x1080". */
function parseResolution(resolution: string): { width: number; height: number } {
  const parts = resolution.split('x');
  const w = parseInt(parts[0] ?? '1920', 10);
  const h = parseInt(parts[1] ?? '1080', 10);
  return { width: Number.isFinite(w) ? w : 1920, height: Number.isFinite(h) ? h : 1080 };
}

/**
 * Convert InterpolatedParam array to a plain Record for ClipRendererProps.
 */
function interpolatedParamsToRecord(
  params: ReadonlyArray<{ name: string; value: number | string | boolean }>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const p of params) {
    record[p.name] = p.value;
  }
  return record;
}

type LiveBindingRecordsByClip = ReadonlyMap<string, readonly TimelineLiveBindingRecord[]>;

const LIVE_BINDING_PLACEHOLDER_STATUSES = new Set([
  'inactive',
  'missing',
  'disposed',
  'orphaned',
  'partiallyBaked',
  'malformed',
]);

type LiveFramePlaceholderState =
  | 'inactive'
  | 'permission-pending'
  | 'pending'
  | 'refining'
  | 'cancelled'
  | 'error'
  | 'missing'
  | 'orphaned'
  | 'disposed'
  | 'partiallyBaked'
  | 'malformed';

type LiveFrameReadResult =
  | {
      kind: 'frame';
      sample: LiveSample;
      src: string;
      state: 'ready' | 'pending' | 'refining' | 'final';
      progress?: number;
    }
  | {
      kind: 'placeholder';
      state: LiveFramePlaceholderState;
      progress?: number;
      detail?: string;
    };

function groupLiveBindingRecordsByClip(
  records: readonly TimelineLiveBindingRecord[],
): LiveBindingRecordsByClip {
  const grouped = new Map<string, TimelineLiveBindingRecord[]>();
  for (const record of records) {
    const entries = grouped.get(record.clipId) ?? [];
    entries.push(record);
    grouped.set(record.clipId, entries);
  }
  return grouped;
}

function liveSourceSnapshotsFromRegistry(
  snapshot: LiveDataRegistrySnapshot | undefined,
): readonly TimelineLiveSourceSnapshot[] {
  if (!snapshot) return Object.freeze([]);
  return Object.freeze([
    ...snapshot.sources.map((source) => ({
      sourceId: source.id,
      kind: source.kind,
      status: source.status,
    })),
    ...snapshot.tombstones.map((tombstone) => ({
      sourceId: tombstone.id,
      kind: tombstone.kind,
      status: tombstone.status,
      ownerExtensionId: tombstone.extensionId,
    })),
  ]);
}

function deterministicRefsForRecord(record: TimelineLiveBindingRecord) {
  return Object.freeze([
    ...(record.binding.deterministicRefs ?? []),
    ...(record.binding.bake?.deterministicRefs ?? []),
  ]);
}

function toRendererLiveBinding(record: TimelineLiveBindingRecord): ClipRendererLiveBinding {
  return Object.freeze({
    bindingId: record.binding.bindingId,
    sourceId: record.binding.sourceId,
    channelId: record.binding.channelId,
    targetParamName: record.binding.targetParamName,
    status: record.status,
    binding: record.binding,
    deterministicRefs: deterministicRefsForRecord(record),
    diagnostics: Object.freeze(record.diagnostics.map((diagnostic) => Object.freeze({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      path: diagnostic.path,
    }))),
  });
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizedProgress(value: unknown): number | undefined {
  const numeric = numericValue(value);
  if (numeric === undefined) return undefined;
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function sampleDataRecord(sample: LiveSample | undefined): Record<string, unknown> | undefined {
  if (!sample) return undefined;
  return isRecord(sample.frame.data) ? sample.frame.data : undefined;
}

function sampleMetadataRecord(sample: LiveSample | undefined): Record<string, unknown> | undefined {
  if (!sample) return undefined;
  return isRecord(sample.frame.metadata) ? sample.frame.metadata : undefined;
}

function sampleFrameSrc(sample: LiveSample | undefined): string | undefined {
  const data = sampleDataRecord(sample);
  const metadata = sampleMetadataRecord(sample);
  return firstString(
    data?.src,
    data?.url,
    data?.dataUrl,
    data?.dataURL,
    data?.uri,
    metadata?.src,
    metadata?.url,
    metadata?.dataUrl,
    metadata?.dataURL,
    metadata?.uri,
  );
}

function sampleFrameState(sample: LiveSample | undefined): 'pending' | 'refining' | 'final' | 'cancelled' | 'error' | undefined {
  const data = sampleDataRecord(sample);
  const metadata = sampleMetadataRecord(sample);
  const raw = firstString(
    metadata?.state,
    metadata?.status,
    metadata?.phase,
    data?.state,
    data?.status,
    data?.phase,
  )?.toLowerCase();

  if (raw === 'pending' || raw === 'queued' || raw === 'requesting') return 'pending';
  if (raw === 'refining' || raw === 'refine' || raw === 'progress' || raw === 'processing') return 'refining';
  if (raw === 'final' || raw === 'ready' || raw === 'complete' || raw === 'completed') return 'final';
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  if (raw === 'error' || raw === 'failed' || raw === 'failure') return 'error';
  return undefined;
}

function sampleProgress(sample: LiveSample | undefined): number | undefined {
  const data = sampleDataRecord(sample);
  const metadata = sampleMetadataRecord(sample);
  return normalizedProgress(
    metadata?.progress
      ?? metadata?.percent
      ?? data?.progress
      ?? data?.percent,
  );
}

function bindingProgress(binding: TimelineLiveBindingRecord['binding']): number | undefined {
  const placeholder = isRecord(binding.placeholder) ? binding.placeholder : undefined;
  const metadata = isRecord(binding.metadata) ? binding.metadata : undefined;
  return normalizedProgress(
    placeholder?.progress
      ?? placeholder?.percent
      ?? metadata?.progress
      ?? metadata?.percent,
  );
}

function bindingPreviewHint(binding: TimelineLiveBindingRecord['binding']): string | undefined {
  const placeholder = isRecord(binding.placeholder) ? binding.placeholder : undefined;
  const metadata = isRecord(binding.metadata) ? binding.metadata : undefined;
  return firstString(
    placeholder?.kind,
    placeholder?.preview,
    placeholder?.reader,
    metadata?.preview,
    metadata?.previewReader,
    metadata?.reader,
    binding.targetParamName,
  )?.toLowerCase();
}

function clipPreviewHint(clip: ResolvedTimelineClip): string | undefined {
  const app = isRecord(clip.app) ? clip.app : undefined;
  if (app?.livePreview === true || clip.params?.livePreview === true) return 'frame';
  return firstString(
    app?.livePreview,
    app?.livePreviewReader,
    clip.params?.livePreview,
    clip.params?.livePreviewReader,
  )?.toLowerCase();
}

function shouldUseLiveFramePreview(
  clip: ResolvedTimelineClip,
  records: readonly TimelineLiveBindingRecord[],
): boolean {
  if (records.length === 0) return false;
  if (clip.clipType === 'live-frame-preview' || clip.clipType === 'live-visual-preview') return true;
  const clipHint = clipPreviewHint(clip);
  if (clipHint === 'frame' || clipHint === 'frame-preview' || clipHint === 'live-frame') return true;
  return records.some((record) => {
    const hint = bindingPreviewHint(record.binding);
    return (
      hint === 'frame'
      || hint === 'frame-preview'
      || hint === 'live-frame'
      || hint === 'src'
      || hint === 'image'
      || hint === 'video'
    );
  });
}

function sampleFrameIndex(sample: LiveSample): number | undefined {
  const data = sampleDataRecord(sample);
  const metadata = sampleMetadataRecord(sample);
  return numericValue(
    metadata?.frame
      ?? metadata?.frameIndex
      ?? metadata?.frameNumber
      ?? data?.frame
      ?? data?.frameIndex
      ?? data?.frameNumber,
  );
}

function resolveTimeSample(samples: readonly LiveSample[], targetTimestampMs: number): LiveSample | undefined {
  const ordered = [...samples].sort((left, right) => left.frame.timestamp - right.frame.timestamp);
  let best: LiveSample | undefined;
  for (const sample of ordered) {
    if (sample.frame.timestamp <= targetTimestampMs) {
      best = sample;
    }
  }
  return best ?? ordered[0];
}

function resolveLiveFrameSample(
  record: TimelineLiveBindingRecord,
  clip: ResolvedTimelineClip,
  fps: number,
  liveDataRegistry: LiveDataRegistry,
): LiveSample | undefined {
  const live = createClipRendererLiveProps([record], liveDataRegistry);
  const sourceId = record.binding.sourceId;
  const channelId = record.binding.channelId;
  const sampling = record.binding.sampling;

  if (sampling?.mode === 'sequence') {
    return live.readSampleAt(sourceId, sampling.frameOffset ?? 0, channelId);
  }

  if (sampling?.mode === 'frame') {
    const targetFrame = sampling.frameOffset ?? secondsToFrames(clip.at, fps);
    return live.readSamples(sourceId, channelId).find((sample) => sampleFrameIndex(sample) === targetFrame)
      ?? live.readSampleAt(sourceId, targetFrame, channelId);
  }

  if (sampling?.mode === 'time') {
    const targetTimestampMs = (clip.at * 1000) + (sampling.timeOffsetMs ?? 0);
    return resolveTimeSample(live.readSamples(sourceId, channelId), targetTimestampMs);
  }

  return live.readLatestSample(sourceId, channelId);
}

function resolveLiveFrameReadResult(
  records: readonly TimelineLiveBindingRecord[],
  clip: ResolvedTimelineClip,
  fps: number,
  liveDataRegistry: LiveDataRegistry | undefined,
): LiveFrameReadResult {
  const record = records[0];
  if (!record) {
    return { kind: 'placeholder', state: 'missing' };
  }

  const source = liveDataRegistry?.getSource(record.binding.sourceId);
  if (record.status === 'malformed') return { kind: 'placeholder', state: 'malformed' };
  if (record.status === 'missing') return { kind: 'placeholder', state: 'missing' };
  if (record.status === 'orphaned') return { kind: 'placeholder', state: 'orphaned' };
  if (record.status === 'disposed') return { kind: 'placeholder', state: 'disposed' };
  if (record.status === 'partiallyBaked') {
    return { kind: 'placeholder', state: 'partiallyBaked', progress: bindingProgress(record.binding) };
  }

  if (!liveDataRegistry || record.status !== 'active') {
    if (source?.permission?.state === 'prompt') {
      return { kind: 'placeholder', state: 'permission-pending', progress: bindingProgress(record.binding) };
    }
    if (source?.status === 'error' || source?.permission?.state === 'denied' || source?.permission?.state === 'unavailable') {
      return { kind: 'placeholder', state: 'error', detail: source.diagnostics[0]?.message };
    }
    return { kind: 'placeholder', state: 'inactive', progress: bindingProgress(record.binding) };
  }

  if (source?.status === 'error') {
    return { kind: 'placeholder', state: 'error', detail: source.diagnostics[0]?.message };
  }

  const sample = resolveLiveFrameSample(record, clip, fps, liveDataRegistry);
  if (!sample) {
    return { kind: 'placeholder', state: 'pending', progress: bindingProgress(record.binding) };
  }

  const state = sampleFrameState(sample);
  const progress = sampleProgress(sample) ?? bindingProgress(record.binding);
  if (state === 'cancelled') return { kind: 'placeholder', state: 'cancelled', progress };
  if (state === 'error') return { kind: 'placeholder', state: 'error', progress };

  const src = sampleFrameSrc(sample);
  if (!src) {
    return {
      kind: 'placeholder',
      state: state === 'refining' ? 'refining' : 'pending',
      progress,
    };
  }

  return {
    kind: 'frame',
    sample,
    src,
    state: state ?? 'ready',
    progress,
  };
}

function createClipRendererLiveProps(
  records: readonly TimelineLiveBindingRecord[],
  liveDataRegistry: LiveDataRegistry | undefined,
): ClipRendererLiveProps {
  const rendererBindings = Object.freeze(records.map(toRendererLiveBinding));
  const diagnostics = Object.freeze(rendererBindings.flatMap((binding) => binding.diagnostics));
  const activeRecords = records.filter((record) => record.status === 'active');

  const isActiveSourceBinding = (sourceId: string): boolean => (
    activeRecords.some((record) => record.binding.sourceId === sourceId)
  );

  const resolveChannelId = (sourceId: string, channelId?: string): LiveChannelDescriptor | undefined => {
    if (!liveDataRegistry || !isActiveSourceBinding(sourceId)) return undefined;
    if (channelId) {
      const channel = liveDataRegistry.getChannelMetadata(channelId as LiveChannelDescriptor);
      return channel?.sourceId === sourceId ? channel.channelId : undefined;
    }

    const boundChannelId = activeRecords.find((record) => (
      record.binding.sourceId === sourceId && typeof record.binding.channelId === 'string'
    ))?.binding.channelId;
    if (boundChannelId) {
      const channel = liveDataRegistry.getChannelMetadata(boundChannelId as LiveChannelDescriptor);
      if (channel?.sourceId === sourceId) return channel.channelId;
    }

    return liveDataRegistry.getSnapshot().channels.find((channel) => channel.sourceId === sourceId)?.channelId;
  };

  const getSource = (sourceId: string): LiveSource | undefined => {
    if (!liveDataRegistry || !isActiveSourceBinding(sourceId)) return undefined;
    return liveDataRegistry.getSource(sourceId);
  };

  const getChannelMetadata = (
    sourceId: string,
    channelId?: string,
  ): LiveChannelMetadata | undefined => {
    const resolvedChannelId = resolveChannelId(sourceId, channelId);
    return resolvedChannelId ? liveDataRegistry?.getChannelMetadata(resolvedChannelId) : undefined;
  };

  const readLatestSample = (sourceId: string, channelId?: string): LiveSample | undefined => {
    const resolvedChannelId = resolveChannelId(sourceId, channelId);
    return resolvedChannelId ? liveDataRegistry?.getLatestSample(resolvedChannelId) : undefined;
  };

  const readSampleAt = (
    sourceId: string,
    sequenceNumber: number,
    channelId?: string,
  ): LiveSample | undefined => {
    const resolvedChannelId = resolveChannelId(sourceId, channelId);
    return resolvedChannelId ? liveDataRegistry?.getSampleAt(resolvedChannelId, sequenceNumber) : undefined;
  };

  const readSamples = (sourceId: string, channelId?: string): readonly LiveSample[] => {
    const resolvedChannelId = resolveChannelId(sourceId, channelId);
    return resolvedChannelId ? liveDataRegistry?.getSamples(resolvedChannelId) ?? Object.freeze([]) : Object.freeze([]);
  };

  const getSampleCount = (sourceId: string, channelId?: string): number => {
    const resolvedChannelId = resolveChannelId(sourceId, channelId);
    return resolvedChannelId ? liveDataRegistry?.getSampleCount(resolvedChannelId) ?? 0 : 0;
  };

  return Object.freeze({
    bindings: rendererBindings,
    diagnostics,
    getSource,
    getChannelMetadata,
    readLatestSample,
    readSampleAt,
    readSamples,
    getSampleCount,
    resolveChannelId,
  });
}

const LiveBindingPlaceholderSequence: FC<{
  clip: ResolvedTimelineClip;
  fps: number;
  records: readonly TimelineLiveBindingRecord[];
}> = ({ clip, fps, records }) => {
  const durationInFrames = getClipDurationInFrames(clip, fps);
  const from = Math.max(0, secondsToFrames(clip.at, fps));
  const statuses = Array.from(new Set(records.map((record) => record.status))).join(',');
  const bindingIds = records.map((record) => record.binding.bindingId).join(',');
  return (
    <Sequence key={clip.id} from={from} durationInFrames={durationInFrames}>
      <AbsoluteFill
        data-testid="live-binding-placeholder"
        data-clip-id={clip.id}
        data-live-binding-status={statuses}
        data-live-binding-ids={bindingIds}
        style={{
          backgroundColor: '#3B1D0A',
          borderTop: '2px solid #FB923C',
          borderBottom: '2px solid #FB923C',
          color: '#FED7AA',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '12px 24px',
          textAlign: 'center',
          fontFamily: 'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace',
          fontSize: 14,
          lineHeight: 1.4,
          letterSpacing: '0.04em',
        }}
      >
        <div
          style={{
            maxWidth: '80%',
            padding: '8px 16px',
            borderRadius: 4,
            background: 'rgba(0, 0, 0, 0.45)',
          }}
        >
          Live binding unresolved: {statuses || 'unknown'}
        </div>
      </AbsoluteFill>
    </Sequence>
  );
};

const LiveFramePlaceholderBody: FC<{
  clip: ResolvedTimelineClip;
  records: readonly TimelineLiveBindingRecord[];
  result: Extract<LiveFrameReadResult, { kind: 'placeholder' }>;
}> = ({ clip, records, result }) => {
  const bindingIds = records.map((record) => record.binding.bindingId).join(',');
  return (
    <AbsoluteFill
      data-testid="live-frame-placeholder"
      data-clip-id={clip.id}
      data-live-frame-state={result.state}
      data-live-binding-ids={bindingIds}
      data-live-frame-progress={result.progress === undefined ? undefined : String(result.progress)}
      style={{
        backgroundColor: '#101828',
        borderTop: '2px solid #22c55e',
        borderBottom: '2px solid #22c55e',
        color: '#dcfce7',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '12px 24px',
        textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace',
        fontSize: 14,
        lineHeight: 1.4,
        letterSpacing: '0.04em',
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          padding: '8px 16px',
          borderRadius: 4,
          background: 'rgba(0, 0, 0, 0.45)',
        }}
      >
        Live frame preview: {result.state}
        {result.progress === undefined ? null : ` (${result.progress}%)`}
      </div>
    </AbsoluteFill>
  );
};

const LiveFramePreviewSequence: FC<{
  clip: ResolvedTimelineClip;
  fps: number;
  records: readonly TimelineLiveBindingRecord[];
  liveDataRegistry?: LiveDataRegistry;
}> = ({ clip, fps, records, liveDataRegistry }) => {
  const durationInFrames = getClipDurationInFrames(clip, fps);
  const from = Math.max(0, secondsToFrames(clip.at, fps));
  const result = resolveLiveFrameReadResult(records, clip, fps, liveDataRegistry);

  return (
    <Sequence key={clip.id} from={from} durationInFrames={durationInFrames}>
      {result.kind === 'placeholder' ? (
        <LiveFramePlaceholderBody clip={clip} records={records} result={result} />
      ) : (
        <AbsoluteFill
          data-testid="live-frame-preview"
          data-clip-id={clip.id}
          data-live-frame-state={result.state}
          data-live-frame-progress={result.progress === undefined ? undefined : String(result.progress)}
          data-live-frame-sequence={String(result.sample.sequenceNumber)}
          data-live-frame-timestamp={String(result.sample.frame.timestamp)}
          style={{ backgroundColor: 'black', overflow: 'hidden' }}
        >
          <img
            alt=""
            src={result.src}
            crossOrigin={mediaCrossOrigin(result.src)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        </AbsoluteFill>
      )}
    </Sequence>
  );
};

const UnsupportedPostprocessShaderExportBody: FC<{ shaderId: string }> = ({ shaderId }) => (
  <AbsoluteFill
    data-testid="unsupported-postprocess-shader-export"
    data-shader-id={shaderId}
    style={{
      pointerEvents: 'none',
      backgroundColor: 'rgba(17, 24, 39, 0.72)',
      borderTop: '2px solid #f97316',
      borderBottom: '2px solid #f97316',
      color: '#ffedd5',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '12px 24px',
      textAlign: 'center',
      fontFamily: 'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.4,
      letterSpacing: '0.04em',
      zIndex: 30,
    }}
  >
    <div
      style={{
        maxWidth: '80%',
        padding: '8px 16px',
        borderRadius: 4,
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      {`postprocess shader '${shaderId}' is browser-preview only; export requires a shader materializer that produces RenderMaterial`}
    </div>
  </AbsoluteFill>
);

/**
 * Error boundary that catches renderer crashes and shows a loud placeholder.
 * Extension renderers are trusted local code but may throw at runtime
 * (e.g. division by zero, invalid state). The boundary preserves the
 * guarantee that broken clips never silently vanish.
 */
class ExtensionRendererErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

/** Props for the ExtensionClipSequence host-side wrapper. */
interface ExtensionClipSequenceProps {
  clip: ResolvedTimelineClip;
  fps: number;
  registryRecord: ClipTypeRegistryRecord;
  resolution: string;
  /** All timeline clips (needed for automation override resolution). */
  allClips: readonly ResolvedTimelineClip[];
  liveBindingRecords: readonly TimelineLiveBindingRecord[];
  liveDataRegistry?: LiveDataRegistry;
}

/**
 * Wraps an extension-provided clip renderer in a Remotion <Sequence> with
 * host-interpolated keyframe params and automation overrides applied.
 *
 * The host computes interpolated parameter values via resolveAnimatedParams()
 * before passing them to the extension renderer, satisfying the rule that "extension
 * renderers must not implement timeline interpolation").
 *
 * Automation overrides are then applied via applyAutomationOverrides(),
 * which scans automation clips for matching target contribution IDs and
 * overrides the extension clip's parameters at the current time (
 * success criterion 9).
 *
 * Both are resolved at the CURRENT composition time, not at `clip.at`:
 * keyframe times are absolute timeline seconds (KeyframeInspector writes the
 * playhead time; live recording writes `timelineStartSeconds + offset`), so
 * evaluating at the clip's start froze every animated param at its first
 * value in preview and in browser export. This component sits outside its own
 * <Sequence>, so useCurrentFrame() here is the composition frame (an
 * EffectLayerSequence wrapping a lower track re-offsets its children back to
 * composition time, so this holds under effect layers too).
 *
 * If the renderer throws at runtime, the error boundary catches it and
 * displays a loud placeholder preserving the clip's duration and position.
 */
const ExtensionClipSequence: FC<ExtensionClipSequenceProps> = ({
  clip,
  fps,
  registryRecord,
  resolution,
  allClips,
  liveBindingRecords,
  liveDataRegistry,
}) => {
  const durationInFrames = getClipDurationInFrames(clip, fps);
  const from = Math.max(0, secondsToFrames(clip.at, fps));
  const { width, height } = parseResolution(resolution);
  const frame = useCurrentFrame();

  // Clamp the evaluation frame to the clip's own range. Inside the range this
  // is the identity; outside it Remotion renders nothing, and the constant
  // value keeps the memo below from recomputing on every frame of the
  // timeline for clips that are not on screen.
  const clampedFrame = Math.min(Math.max(frame, from), from + Math.max(0, durationInFrames - 1));
  const timeSeconds = clampedFrame / fps;

  // Compute host-interpolated params from keyframe data, then apply
  // automation overrides from automation clips targeting this extension clip.
  const interpolatedParams = useMemo(() => {
    const schema: ParameterSchema | undefined = registryRecord.schema as ParameterSchema | undefined;
    const keyframes = clip.keyframes ?? {};
    const rawParams = (clip.params as Record<string, unknown>) ?? {};
    let baseParams: Record<string, unknown>;
    if (!schema || schema.length === 0) {
      // No schema → pass raw params (no interpolation needed)
      baseParams = { ...rawParams };
    } else {
      const resolved = resolveAnimatedParams(keyframes, schema, timeSeconds);
      // Parameter resolution owns only declared animated values. Preserve
      // opaque source/package identity carried beside them.
      baseParams = { ...rawParams, ...interpolatedParamsToRecord(resolved) };
    }

    // Apply automation overrides
    if (clip.clipType) {
      return applyAutomationOverrides(
        allClips
          .filter((candidate): candidate is ResolvedTimelineClip & { clipType: string } => typeof candidate.clipType === 'string')
          .map((candidate) => ({
            clipType: candidate.clipType,
            params: candidate.params ? { ...candidate.params } : null,
          })),
        clip.clipType,
        baseParams,
        timeSeconds,
      );
    }
    return baseParams;
  }, [timeSeconds, clip.keyframes, clip.params, clip.clipType, registryRecord.schema, allClips]);

  const rendererProps: ClipRendererProps = {
    clipId: clip.id,
    clipTypeId: registryRecord.clipTypeId,
    time: timeSeconds,
    sourceTime: clipSourceTime(clip, timeSeconds),
    source: clip.app,
    params: interpolatedParams,
    width,
    height,
    live: createClipRendererLiveProps(liveBindingRecords, liveDataRegistry),
  };

  // Extension renderers are stored as `Record<string, unknown> | Function`.
  // We cast to FC<ClipRendererProps> since the registry contract guarantees
  // a React component.
  const Renderer = registryRecord.renderer as FC<ClipRendererProps>;

  const placeholder = (
    <UnknownClipPlaceholderSequence
      clip={clip}
      fps={fps}
      reason="unsupported"
    />
  );

  return (
    <Sequence key={clip.id} from={from} durationInFrames={durationInFrames}>
      <ExtensionRendererErrorBoundary fallback={placeholder}>
        <Renderer {...rendererProps} />
      </ExtensionRendererErrorBoundary>
    </Sequence>
  );
};

interface VisualTrackProps {
  track: TrackDefinition;
  clips: ResolvedTimelineClip[];
  renderConfig: ResolvedTimelineConfig;
  fps: number;
  theme: RuntimeTheme;
  resolution: string;
  /** All timeline clips (needed for automation override resolution). */
  allClips: readonly ResolvedTimelineClip[];
  liveBindingRecordsByClip: LiveBindingRecordsByClip;
  liveDataRegistry?: LiveDataRegistry;
}

// Lifted into a component so we can call useSequenceComponentRegistrySnapshot
// once per visual track. Keeps the dynamic-registry subscription out of the
// per-clip dispatch loop.
const VisualTrack: FC<VisualTrackProps> = ({
  track,
  clips,
  renderConfig,
  fps,
  theme,
  resolution,
  allClips,
  liveBindingRecordsByClip,
  liveDataRegistry,
}) => {
  const host = useAstridElementHost();
  const { entries: dynamicEntries } = useSequenceComponentRegistrySnapshot();
  const clipTypeRegistry = useClipTypeRegistrySnapshot();
  const sortedClips = sortClipsByAt(clips);
  if (sortedClips.length === 0) {
    return null;
  }

  // Track scale scales EVERYTHING on the track — one application point for the
  // whole subtree, so text/theme/extension clips and clips with position
  // overrides compose with it instead of silently escaping it (they used to:
  // only plain un-positioned media clips got a per-clip scale wrapper, so the
  // slider stopped working the moment a clip gained a position override).
  // Positioned clips' stored x/y/width/height are track-local under this
  // semantics; pre-existing positioned clips on scaled tracks were baked to
  // preserve their on-screen appearance (see `applyTrackScaleBakeMigration`
  // in `lib/timeline-domain.ts`). OverlayEditor mirrors this transform in
  // both directions so gizmo and render agree.
  const effectiveScale = track.scale ?? 1;
  return (
    <AbsoluteFill
      key={track.id}
      style={{
        opacity: track.opacity ?? 1,
        mixBlendMode: track.blendMode && track.blendMode !== 'normal' ? track.blendMode : undefined,
        ...(effectiveScale !== 1
          ? {
              transform: `scale(${effectiveScale})`,
              transformOrigin: 'center center',
              overflow: 'hidden',
            }
          : {}),
      }}
    >
      {sortedClips.map((clip, index) => {
        const liveBindingRecords = liveBindingRecordsByClip.get(clip.id) ?? Object.freeze([]);
        if (shouldUseLiveFramePreview(clip, liveBindingRecords)) {
          return (
            <LiveFramePreviewSequence
              key={clip.id}
              clip={clip}
              fps={fps}
              records={liveBindingRecords}
              liveDataRegistry={liveDataRegistry}
            />
          );
        }

        const livePlaceholderRecords = liveBindingRecords.filter((record) => (
          LIVE_BINDING_PLACEHOLDER_STATUSES.has(record.status)
        ));
        if (livePlaceholderRecords.length > 0) {
          return (
            <LiveBindingPlaceholderSequence
              key={clip.id}
              clip={clip}
              fps={fps}
              records={livePlaceholderRecords}
            />
          );
        }

        // Dynamic-aware capability lookup (FLAG-001/002). DB-stored sequence
        // components surface workerRender:false through this path.
        const descriptor = host.describeClipCapability(clip, dynamicEntries);

        if (clip.elementRef && clip.elementRef.kind !== 'transition') {
          const astridComponent = resolveHostComponent(host, clip.elementRef);
          if (astridComponent && clip.elementRef.kind === 'effect') {
            return (
              <AstridEffectPreviewSequence
                key={clip.id}
                clip={clip}
                fps={fps}
                theme={theme}
                assetEntry={clip.assetEntry}
                resolvedAssets={renderConfig.registry}
                predecessor={index > 0 ? sortedClips[index - 1] : null}
              />
            );
          }
          if (astridComponent && clip.elementRef.kind === 'animation') {
            return (
              <AstridAnimationPreviewSequence
                key={clip.id}
                clip={clip}
                track={track}
                fps={fps}
                theme={theme}
                predecessor={index > 0 ? sortedClips[index - 1] : null}
              />
            );
          }
          return (
            <GeneratedModulePlaceholderSequence
              key={clip.id}
              clip={clip}
              fps={fps}
              artifactId={clip.elementRef.id}
              reason="element_source_missing"
              detail={`Element ${clip.elementRef.id}@${clip.elementRef.revision} requires its exact admitted pack revision. Embedded source is preserved for migration and is not executed.`}
            />
          );
        }

        if (descriptor?.source === 'generated-module' || isGeneratedRemotionModuleClip(clip)) {
          const moduleStatus = getGeneratedRemotionModuleStatus(clip);
          return (
            <GeneratedModulePlaceholderSequence
              key={clip.id}
              clip={clip}
              fps={fps}
              artifactId={moduleStatus.kind === 'valid_module' ? moduleStatus.artifactId : null}
              reason={moduleStatus.kind === 'blocked_module' ? moduleStatus.reason : 'worker_only'}
              detail="This embedded Remotion element requires migration to an admitted pack. Its saved source is preserved and is not executed."
            />
          );
        }

        if (clip.clipType === 'effect-layer') {
          return null;
        }

        if (clip.clipType === 'text') {
          return <TextClipSequence key={clip.id} clip={clip} track={track} fps={fps} predecessor={index > 0 ? sortedClips[index - 1] : null} />;
        }

        if (clip.clipType === 'shot') {
          return <ShotClipSequence key={clip.id} clip={clip} fps={fps} />;
        }

        // First-party Astrid parity renderer. This is deliberately dispatched
        // before extension/unknown fallbacks so the frozen audio-reactive
        // colour contract uses the same component in preview and client
        // render/export.
        if (clip.clipType === 'audio-reactive-colour') {
          return <AudioReactiveColourSequence key={clip.id} clip={clip} fps={fps} />;
        }

        // Older Astrid-authored timelines identify first-party effects by
        // their clipType alone. Newer typed operations also carry an
        // elementRef, but requiring it here made valid legacy effects such as
        // scrolling-guide fall through to the unsupported placeholder even
        // though their checked-out Astrid component was bundled.
        if (!clip.elementRef && clip.clipType) {
          const astridEffect = host.resolveComponent(clip.clipType, 'effect');
          if (astridEffect) {
            return (
              <AstridEffectPreviewSequence
                key={clip.id}
                clip={clip}
                fps={fps}
                theme={theme}
                assetEntry={clip.assetEntry}
                resolvedAssets={renderConfig.registry}
                predecessor={index > 0 ? sortedClips[index - 1] : null}
                component={astridEffect}
              />
            );
          }
        }

        // EFFECT_REGISTRY dispatch if the clipType
        // is provided by an installed theme package OR a DB-stored
        // sequence component, render via the dynamic-aware registry entry.
        // Mirrors HypeComposition.tsx:58-64 with DB augmentation.
        if (isSequenceComponentClipType(host, clip.clipType, dynamicEntries)) {
          return (
            <ThemeEffectSequence
              key={clip.id}
              clip={clip}
              fps={fps}
              theme={theme}
              dynamicEntries={dynamicEntries}
              predecessor={index > 0 ? sortedClips[index - 1] : null}
            />
          );
        }

        // Extension clip renderer dispatch.
        // After built-ins and sequence components, before the loud
        // placeholder fallback. Looks up the clipTypeId in the
        // provider-scoped ClipTypeRegistry.
        // - Active record with a renderer → ExtensionClipSequence
        //   with host-interpolated params.
        // - Active record without a usable renderer → loud placeholder
        //   (missing renderer).
        // - Inactive / error record → loud placeholder.
        // - Not in registry → falls through to existing placeholder logic.
        // The error boundary inside ExtensionClipSequence catches
        // runtime renderer crashes and displays a placeholder too.
        if (clip.clipType) {
          const extensionRecord = clipTypeRegistry.get(clip.clipType);
          if (extensionRecord) {
            if (
              extensionRecord.status === 'active' &&
              typeof extensionRecord.renderer === 'function'
            ) {
              // Check renderability: if preview route is explicitly blocked,
              // show the placeholder instead of attempting render.
              const previewCap = extensionRecord.renderability.capabilities.find(
                (c) => c.route === 'preview',
              );
              if (previewCap && previewCap.status === 'blocked') {
                return (
                  <UnknownClipPlaceholderSequence
                    key={clip.id}
                    clip={clip}
                    fps={fps}
                    reason="unsupported"
                  />
                );
              }
              return (
                <ExtensionClipSequence
                  key={clip.id}
                  clip={clip}
                  fps={fps}
                  registryRecord={extensionRecord}
                  resolution={resolution}
                  allClips={allClips}
                  liveBindingRecords={liveBindingRecords}
                  liveDataRegistry={liveDataRegistry}
                />
              );
            }
            // Found in registry but not renderable: loud placeholder
            return (
              <UnknownClipPlaceholderSequence
                key={clip.id}
                clip={clip}
                fps={fps}
                reason="unsupported"
              />
            );
          }
        }

        if (descriptor?.capabilities.preview === 'placeholder') {
          return (
            <UnknownClipPlaceholderSequence
              key={clip.id}
              clip={clip}
              fps={fps}
              reason="unsupported"
            />
          );
        }

        // loud placeholder for unknown clipTypes that
        // are NOT in BUILTIN_CLIP_TYPES and NOT in the theme registry —
        // theme package missing, typo, or future clipType not yet
        // supported. Surfaces as a labeled band rather than a silent
        // black void.
        if (!isBuiltinClipType(clip.clipType)) {
          return (
            <UnknownClipPlaceholderSequence
              key={clip.id}
              clip={clip}
              fps={fps}
              reason="unsupported"
            />
          );
        }

        const predecessor = index > 0 ? sortedClips[index - 1] : null;
        return (
          <VisualClipSequence
            key={clip.id}
            clip={clip}
            track={track}
            fps={fps}
            predecessor={predecessor}
          />
        );
      })}
    </AbsoluteFill>
  );
};

const TimelineRendererBody: FC<{ config: ResolvedTimelineConfig }> = memo(({ config }) => {
  const host = useAstridElementHost();
  const { entries: dynamicSequenceEntries } = useSequenceComponentRegistrySnapshot();
  const clipTypeRegistry = useClipTypeRegistrySnapshot();
  const admission = useSyncExternalStore(subscribeAdmittedElements, getAdmittedElementSelection, getAdmittedElementSelection);
  const runtime = useContext(VideoEditorRuntimeContext);
  const environment = useRemotionEnvironment();
  const frame = useCurrentFrame();
  const liveDataRegistry = runtime?.liveDataRegistry;
  const liveRegistrySnapshot = useSyncExternalStore(
    (listener) => liveDataRegistry?.subscribe(listener).dispose ?? (() => {}),
    () => liveDataRegistry?.getSnapshot(),
    () => liveDataRegistry?.getSnapshot(),
  );
  const renderConfig = useMemo(() => {
    const outputConfig = projectOutputTimelineConfig(config).config;
    const materialized = materializeResolvedSequenceConfig(outputConfig);
    const boundedClips = boundCanonicalConfigClips(materialized.clips);
    return boundedClips.length === materialized.clips.length
      && boundedClips.every((clip, index) => clip === materialized.clips[index])
      ? materialized
      : { ...materialized, clips: boundedClips };
  }, [config]);
  const shaderSnapshot = useShaderEffectRegistrySnapshot();
  const fps = renderConfig.output.fps;
  const theme = useMemo(() => resolveTimelineRenderTheme(renderConfig), [renderConfig]);
  const runtimeTheme = useMemo<RuntimeTheme>(() => ({
    ...theme,
    color: theme.visual.color,
    type: theme.visual.type,
    motion: theme.visual.motion,
  }), [theme]);
  const visualTracks = useMemo(() => [...getVisualTracks(renderConfig)].reverse(), [renderConfig]);
  const audioTracks = useMemo(() => getAudioTracks(renderConfig), [renderConfig]);
  const totalDurationInFrames = useMemo(() => getTimelineDurationInFrames(renderConfig, fps), [renderConfig, fps]);
  const audioClips = useMemo(() => {
    const audioTrackIds = new Set(audioTracks.map((track) => track.id));
    return renderConfig.clips.filter((clip) => audioTrackIds.has(clip.track));
  }, [audioTracks, renderConfig.clips]);
  const audioTrackIds = useMemo(() => new Set(audioTracks.map((track) => track.id)), [audioTracks]);
  const needsAudioAnalysis = useMemo(() => timelineNeedsAudioAnalysis(
    renderConfig.clips.filter((clip) => !audioTrackIds.has(clip.track)),
    host.descriptors,
    dynamicSequenceEntries,
    clipTypeRegistry.records,
  ), [audioTrackIds, clipTypeRegistry.records, dynamicSequenceEntries, host.descriptors, renderConfig.clips]);
  const clipsByTrack = useMemo(() => {
    return renderConfig.clips.reduce<{
      regular: Record<string, ResolvedTimelineClip[]>;
      effectLayers: Record<string, ResolvedTimelineClip[]>;
      all: Record<string, ResolvedTimelineClip[]>;
    }>((groups, clip) => {
      groups.all[clip.track] ??= [];
      groups.all[clip.track].push(clip);
      if (clip.clipType === 'automation') {
        // Automation clips are data-only and do not produce visual output.
        // They are only processed for override resolution.
      } else if (clip.clipType === 'effect-layer' && !clip.elementRef && !isGeneratedRemotionModuleClip(clip)) {
        groups.effectLayers[clip.track] ??= [];
        groups.effectLayers[clip.track].push(clip);
      } else {
        groups.regular[clip.track] ??= [];
        groups.regular[clip.track].push(clip);
      }
      return groups;
    }, { regular: {}, effectLayers: {}, all: {} });
  }, [renderConfig]);
  // Memoized on purpose: this component re-renders on every frame during
  // playback (useCurrentFrame above), and `liveBindingRecordsByClip` is a
  // dependency of the `visualContent` memo. A fresh Map per frame invalidated
  // that memo and re-rendered every track and clip on every frame.
  const liveBindingRecordsByClip = useMemo(() => {
    const scan = scanTimelineLiveBindings(renderConfig as TimelineConfig, {
      sources: liveSourceSnapshotsFromRegistry(liveRegistrySnapshot),
    });
    return groupLiveBindingRecordsByClip(scan.bindings);
  }, [renderConfig, liveRegistrySnapshot]);
  const postprocessShader = useMemo(
    () => getTimelinePostprocessShader(renderConfig as TimelineConfig),
    [renderConfig],
  );
  const postprocessRecord = postprocessShader
    ? shaderSnapshot.get(postprocessShader.shaderId, postprocessShader.extensionId)
    : undefined;
  const { width: compositionWidth, height: compositionHeight } = parseResolution(renderConfig.output.resolution);
  const renderBrowserPostprocessPreview = Boolean(
    postprocessShader
    && postprocessShader.enabled !== false
    && postprocessRecord
    && !environment.isRendering
    && !environment.isClientSideRendering,
  );
  const renderUnsupportedPostprocessExport = Boolean(
    postprocessShader
    && postprocessShader.enabled !== false
    && (environment.isRendering || environment.isClientSideRendering),
  );

  const visualContent = useMemo(() => {
    const resolution = renderConfig.output.resolution;
    const renderTracks = (tracks: readonly TrackDefinition[], allClips: ResolvedTimelineClip[], initial: ReactNode[] = []): ReactNode[] => {
      // Keep ordinary tracks as keyed siblings so adding a row does not remount decoders.
      let accumulated = initial;
      for (const track of tracks) {
        const trackClips = clipsByTrack.regular[track.id] ?? [];
        const trackContent: ReactNode = trackClips.length > 0
          ? (
              <VisualTrack
                key={track.id}
                track={track}
                clips={trackClips}
                renderConfig={renderConfig}
                fps={fps}
                theme={runtimeTheme}
                resolution={resolution}
                allClips={allClips}
                liveBindingRecordsByClip={liveBindingRecordsByClip}
                liveDataRegistry={liveDataRegistry}
              />
            )
          : null;
        let lowerTrackContent = accumulated;
        const effectLayers = sortClipsByAt(clipsByTrack.effectLayers[track.id] ?? []);
        if (lowerTrackContent.length > 0 && effectLayers.length > 0) {
          for (const effectLayer of effectLayers) {
            lowerTrackContent = [
              <EffectLayerSequence key={`effect:${effectLayer.id}`} clip={effectLayer} fps={fps}>
                {lowerTrackContent}
              </EffectLayerSequence>,
            ];
          }
        }
        accumulated = trackContent ? [...lowerTrackContent, trackContent] : lowerTrackContent;
      }
      return accumulated;
    };
    let accumulated: ReactNode[] = [];
    const ungroupedClips = renderConfig.clips.filter((clip) => (
      !renderConfig.tracks.find((track) => track.id === clip.track)?.app?.group
    ));
    for (const group of partitionTrackGroups(visualTracks)) {
      if (group.id) {
        const ids = new Set(group.tracks.map((track) => track.id));
        const groupClips = renderConfig.clips.filter((clip) => ids.has(clip.track));
        accumulated.push(
          <AbsoluteFill key={`group:${group.id}`} data-shot-group={group.id} style={{ isolation: 'isolate' }}>
            {renderTracks(group.tracks, groupClips)}
          </AbsoluteFill>,
        );
      } else {
        // Parent effect layers may wrap the whole stack, including completed shots.
        accumulated = renderTracks(group.tracks, ungroupedClips, accumulated);
      }
    }

    return accumulated;
  // Component lookup reads the stable host's externally updated descriptor getter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    admission,
    clipsByTrack.effectLayers,
    clipsByTrack.regular,
    fps,
    liveBindingRecordsByClip,
    liveDataRegistry,
    renderConfig,
    runtimeTheme,
    visualTracks,
  ]);

  return (
    <AudioAnalysisProvider
      clips={audioClips}
      fps={fps}
      totalDurationInFrames={totalDurationInFrames}
      enabled={needsAudioAnalysis}
    >
      <LocalFontFaces />
      <AbsoluteFill style={{ backgroundColor: 'black', overflow: 'hidden' }}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
          <AbsoluteFill style={{ position: 'relative', overflow: 'hidden' }}>
            {visualContent}
            {renderUnsupportedPostprocessExport && postprocessShader ? (
              <UnsupportedPostprocessShaderExportBody shaderId={postprocessShader.shaderId} />
            ) : null}
            {renderBrowserPostprocessPreview && postprocessShader && postprocessRecord ? (
              <PostprocessShaderPreviewCanvas
                shader={postprocessShader}
                record={postprocessRecord}
                timeSeconds={frame / fps}
                frame={frame}
                width={compositionWidth}
                height={compositionHeight}
                testId="timeline-postprocess-shader-preview"
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  zIndex: 20,
                }}
              />
            ) : null}
          </AbsoluteFill>
        </AbsoluteFill>
        {audioTracks.map((track) => (
          <AudioTrack
            key={track.id}
            track={track}
            clips={clipsByTrack.all[track.id] ?? []}
            fps={fps}
          />
        ))}
      </AbsoluteFill>
    </AudioAnalysisProvider>
  );
});

export const TimelineRenderer: FC<{ config: ResolvedTimelineConfig; astridElementHost?: AstridElementHost }> = memo(({ config, astridElementHost }) => {
  const runtime = useContext(VideoEditorRuntimeContext);
  const inheritedHost = useContext(AstridElementHostContext);
  const host = requireAstridElementHost(astridElementHost ?? inheritedHost ?? runtime?.astridElementHost);
  return <AstridElementHostContext.Provider value={host}><TimelineRendererBody config={config} /></AstridElementHostContext.Provider>;
});
