import { persistedTranscriptItems, type TranscriptReferences } from '../data/typed/projectTranscript.ts';
import type {
  TimelineAction,
  TimelineEffect as EditorTimelineEffect,
  TimelineRow,
} from '@/tools/video-editor/types/timeline-canvas.ts';
import {
  getClipSourceDuration,
  getConfigSignature,
  getStableConfigSignature,
  resolveTimelineConfig as resolveTimelineConfigShared,
  type UrlResolver,
} from '@/tools/video-editor/lib/config-utils.ts';
import { TIMELINE_CLIP_FIELDS } from '@/tools/video-editor/lib/serialize.ts';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';
import {
  withDefaultTimelineOutput,
} from '@/tools/video-editor/lib/defaults.ts';
import type {
  AssetMissingRequest,
  AssetResolver,
} from '@/tools/video-editor/data/AssetResolver.ts';
import type { DataLaneView, SourceFrozenDataItem } from '@/tools/video-editor/data/typed/envelope.ts';
import { canonicalJsonStringify } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import type {
  AssetRegistry,
  ClipType,
  ResolvedTimelineConfig,
  TimelineClip,
  TimelineConfig,
  TimelineOutput,
  TrackDefinition,
  TrackKind,
} from '@/tools/video-editor/types/index.ts';
import {
  canonicalizeTimelinePair,
  cloneTimelineExtras,
  projectTimelineTracksForDisplay,
  serializeTimelineConfigSnapshot,
} from '@/tools/video-editor/lib/timeline-domain.ts';
import { buildAssetReferenceMap } from '@/tools/video-editor/lib/asset-registry.ts';
import { snapToFrameGrid } from '@/tools/video-editor/lib/time-grid.ts';
import { deriveClipNameBasis, isExplicitClipLabel } from '@/tools/video-editor/lib/clipDisplayNames.ts';

export interface ClipMeta {
  asset?: string;
  track: string;
  clipType?: ClipType;
  /** Persisted only when a user or agent set it (see `assembleTimelineData`); never the derived display name. */
  label?: string;
  /** Derived, never persisted: what the clip is called on screen (explicit label, else asset name, else "Image 2"). */
  displayName?: string;
  from?: number;
  to?: number;
  speed?: number;
  hold?: number;
  volume?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  cropTop?: number;
  cropBottom?: number;
  cropLeft?: number;
  cropRight?: number;
  opacity?: number;
  text?: TimelineClip['text'];
  entrance?: TimelineClip['entrance'];
  exit?: TimelineClip['exit'];
  continuous?: TimelineClip['continuous'];
  transition?: TimelineClip['transition'];
  elementRef?: TimelineClip['elementRef'];
  effects?: TimelineClip['effects'];
  params?: TimelineClip['params'];
  pool_id?: TimelineClip['pool_id'];
  clip_order?: TimelineClip['clip_order'];
  source_uuid?: TimelineClip['source_uuid'];
  generation?: TimelineClip['generation'];
  app?: TimelineClip['app'];
  keyframes?: TimelineClip['keyframes'];
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export type ClipOrderMap = Record<string, string[]>;

export type TimelineEditProjection =
  | { kind: 'accepted'; head: { revisionId: string; publicationId: string } }
  | { kind: 'local'; base: { revisionId: string; publicationId: string }; generation: number };

export interface TimelineData {
  config: TimelineConfig;
  configVersion: number;
  head?: import('../data/DataProvider.ts').TimelineHeadRevision;
  /** Fact about this displayed snapshot; never part of authored config. */
  editProjection?: TimelineEditProjection;
  registry: AssetRegistry;
  resolvedConfig: ResolvedTimelineConfig;
  rows: TimelineRow[];
  meta: Record<string, ClipMeta>;
  effects: Record<string, EditorTimelineEffect>;
  assetMap: Record<string, string>;
  output: TimelineOutput;
  tracks: TrackDefinition[];
  clipOrder: ClipOrderMap;
  signature: string;
  stableSignature: string;
  /**
   * Duration-neutral typed-data lanes (, dataKind V1).
   * Evidence/visualization state only — never an input to duration
   * computation, `configToRows`, or export scanning (design:
   * decisions/astrid-editor-data-lanes.md §Three-layer split). Default is
   * the frozen `EMPTY_DATA_LANES`; producers swap it via `mergeDataLanes`.
   */
  dataLanes: DataLaneView[];
  /**
   * V2 persistence plane: persisted SOURCE items
   * carried from `LoadedTimeline.bundle.itemsBySchemaRef` so lanes can
   * repaint after reload. Canonical source state — serialized in the bundle
   * alongside configs, never an input to duration computation; render-side assembly
   * (`useDataLanes`) remaps them into `dataLanes`. Absent when the provider
   * loaded no bundle.
   */
  sourceItemsBySchemaRef?: Readonly<Record<string, readonly SourceFrozenDataItem[]>>;
  transcriptReferences?: TranscriptReferences;
}

const ASSET_COLORS: Record<string, string> = {
  'output-composition': '#e06c75',
  'venn-diagram': '#61afef',
  'demo-one': '#98c379',
  'demo-two': '#c678dd',
  'example-video': '#56b6c2',
  'example-image1': '#d19a66',
  'example-image2': '#e5c07b',
  input: '#61afef',
};

const TIMELINE_TIME_PRECISION = 4;
const TIMELINE_TIME_FACTOR = 10 ** TIMELINE_TIME_PRECISION;
/**
 * Serialization precision for persisted times. 4 decimals keeps configs tidy
 * and still round-trips the frame grid exactly: |value − k/fps| ≤ 5e-5, so
 * `round(value·fps)` recovers `k` for any real fps (error ≤ 5e-5·fps ≪ 0.5).
 */
export const roundTimelineTime = (value: number): number => Math.round(value * TIMELINE_TIME_FACTOR) / TIMELINE_TIME_FACTOR;

const effectIdForClip = (clipId: string): string => `effect-${clipId}`;
const clonePinnedShotGroups = (
  pinnedShotGroups: TimelineConfig['pinnedShotGroups'],
): TimelineConfig['pinnedShotGroups'] => pinnedShotGroups?.map((group) => ({
  shotId: group.shotId,
  name: group.name,
  trackId: group.trackId,
  clipIds: [...group.clipIds],
  mode: group.mode,
  videoAssetKey: group.videoAssetKey,
  imageClipSnapshot: group.imageClipSnapshot?.map((snapshot) => ({
    ...snapshot,
    meta: { ...snapshot.meta },
  })),
  poolGenerationIds: group.poolGenerationIds ? [...group.poolGenerationIds] : undefined,
  derivedFrom: group.derivedFrom ? { ...group.derivedFrom } : undefined,
}));

const getClipDurationSeconds = (clip: TimelineClip): number => {
  return getClipSourceDuration(clip) / (clip.speed ?? 1);
};

const getDefaultClipMeta = (clip: TimelineClip): ClipMeta => {
  return {
    asset: clip.asset,
    track: clip.track,
    clipType: clip.clipType,
    label: clip.label,
    from: clip.from,
    to: clip.to,
    speed: clip.speed,
    hold: clip.hold,
    volume: clip.volume,
    x: clip.x,
    y: clip.y,
    width: clip.width,
    height: clip.height,
    cropTop: clip.cropTop,
    cropBottom: clip.cropBottom,
    cropLeft: clip.cropLeft,
    cropRight: clip.cropRight,
    opacity: clip.opacity,
    text: clip.text,
    entrance: clip.entrance,
    exit: clip.exit,
    continuous: clip.continuous,
    transition: clip.transition,
    elementRef: clip.elementRef,
    effects: clip.effects,
    params: clip.params,
    pool_id: clip.pool_id,
    clip_order: clip.clip_order,
    source_uuid: clip.source_uuid,
    generation: clip.generation,
    app: clip.app,
    keyframes: clip.keyframes,
  };
};

const resolveAssetUrl = (file: string): string => {
  if (/^https?:\/\//.test(file)) {
    return file;
  }

  const normalized = file.replace(/\\/g, '/').replace(/^\/+/, '');
  return `/${normalized}`;
};

const buildAssetMap = (registry: AssetRegistry): Record<string, string> => {
  return buildAssetReferenceMap(registry);
};

export const resolveTimelineConfig = async (
  config: TimelineConfig,
  registry: AssetRegistry,
  urlResolver?: UrlResolver,
): Promise<ResolvedTimelineConfig> => {
  return resolveTimelineConfigShared(config, registry, urlResolver ?? resolveAssetUrl);
};

export const configToRows = (
  config: TimelineConfig,
): Pick<TimelineData, 'rows' | 'meta' | 'effects' | 'clipOrder' | 'tracks'> => {
  const clipOrder: ClipOrderMap = Object.fromEntries(
    (config.tracks ?? []).map((track) => [track.id, []]),
  );
  const effects: Record<string, EditorTimelineEffect> = {};
  const meta: Record<string, ClipMeta> = {};
  const rowsByTrack = new Map<string, TimelineAction[]>();

  for (const track of config.tracks ?? []) {
    rowsByTrack.set(track.id, []);
  }

  for (const clip of config.clips) {
    const clipId = clip.id;

    clipOrder[clip.track] ??= [];
    clipOrder[clip.track].push(clipId);
    effects[effectIdForClip(clipId)] = { id: effectIdForClip(clipId) };
    meta[clipId] = getDefaultClipMeta(clip);

    const action: TimelineAction = {
      id: clipId,
      start: clip.at,
      end: clip.at + getClipDurationSeconds(clip),
      effectId: effectIdForClip(clipId),
    };

    rowsByTrack.get(clip.track)?.push(action);
  }

  return {
    rows: (config.tracks ?? []).map((track) => ({
      id: track.id,
      actions: rowsByTrack.get(track.id) ?? [],
    })),
    meta,
    effects,
    clipOrder,
    tracks: config.tracks ?? [],
  };
};

export const rowsToConfig = (
  rows: TimelineRow[],
  meta: Record<string, ClipMeta>,
  output: TimelineOutput,
  clipOrder: ClipOrderMap,
  tracks: TrackDefinition[],
  pinnedShotGroups?: TimelineConfig['pinnedShotGroups'],
  extras?: Pick<TimelineConfig, 'clips' | 'theme' | 'theme_overrides' | 'generation_defaults' | 'app'>,
): TimelineConfig => {
  const actionMap = new Map<string, TimelineAction>();
  const trackActionIds: Record<string, string[]> = Object.fromEntries(tracks.map((track) => [track.id, []]));
  const authoredClips = new Map((extras?.clips ?? []).map((clip) => [clip.id, clip] as const));
  const retainedClips = new Map<string, TimelineClip>();

  for (const row of rows) {
    for (const action of row.actions) {
      if (action.id.startsWith('uploading-')) continue;
      const clipMeta = meta[action.id];
      if (!clipMeta) {
        continue;
      }

      actionMap.set(action.id, action);
      trackActionIds[row.id] ??= [];
      trackActionIds[row.id].push(action.id);
    }
  }

  const clips: TimelineClip[] = [];
  for (const track of tracks) {
    const baseOrder = (clipOrder[track.id] ?? []).filter((clipId) => actionMap.has(clipId));
    const appendedIds = (trackActionIds[track.id] ?? []).filter((clipId) => !baseOrder.includes(clipId));

    for (const clipId of [...baseOrder, ...appendedIds]) {
      const action = actionMap.get(clipId);
      const clipMeta = meta[clipId];
      if (!action || !clipMeta) {
        continue;
      }

      // Frame-grid snap at the commit funnel: every `'rows'` edit (drag,
      // resize, nudge, delete, drop) passes through here, and only locally
      // produced edits do — remote/accepted data re-enters as a config, not as
      // rows, so it is never re-quantized. See `lib/time-grid.ts` for the
      // policy and the ~24% one-frame gap/overlap rate this closes.
      const fps = output.fps;
      const roundedStart = roundTimelineTime(snapToFrameGrid(action.start, fps));
      const roundedEnd = roundTimelineTime(snapToFrameGrid(action.end, fps));

      const authoredClip = authoredClips.get(clipId);
      if (authoredClip) {
        const originalMeta = getDefaultClipMeta(authoredClip);
        const unchangedMeta = (Object.keys(originalMeta) as (keyof ClipMeta)[]).every((field) =>
          field === 'label' || field === 'track'
          || canonicalJsonStringify({ value: originalMeta[field] }) === canonicalJsonStringify({ value: clipMeta[field] }));
        if (unchangedMeta && roundTimelineTime(action.end - action.start) === roundTimelineTime(getClipDurationSeconds(authoredClip))) {
          // Rows are a display projection. A move must carry the raw clip,
          // including opaque fields and absent/null source values, unchanged.
          const retained = {
            ...structuredClone(authoredClip),
            at: action.start === authoredClip.at ? authoredClip.at : roundedStart,
            track: track.id,
          };
          if (Object.prototype.hasOwnProperty.call(authoredClip, 'label')
            && clipMeta.label === undefined && clipMeta.displayName === authoredClip.label) {
            delete retained.label;
          }
          retainedClips.set(clipId, retained);
        }
      }
      const nextClip: Partial<TimelineClip> = {
        id: clipId,
        at: roundedStart,
        track: track.id,
        clipType: clipMeta.clipType,
        asset: clipMeta.asset,
        from: clipMeta.from,
        to: clipMeta.to,
        speed: clipMeta.speed,
        hold: clipMeta.hold,
        volume: clipMeta.volume,
        x: clipMeta.x,
        y: clipMeta.y,
        width: clipMeta.width,
        height: clipMeta.height,
        cropTop: clipMeta.cropTop,
        cropBottom: clipMeta.cropBottom,
        cropLeft: clipMeta.cropLeft,
        cropRight: clipMeta.cropRight,
        opacity: clipMeta.opacity,
        text: clipMeta.text,
        entrance: clipMeta.entrance,
        exit: clipMeta.exit,
        continuous: clipMeta.continuous,
        transition: clipMeta.transition,
        elementRef: clipMeta.elementRef,
        effects: clipMeta.effects,
        params: clipMeta.params,
        pool_id: clipMeta.pool_id,
        clip_order: clipMeta.clip_order,
        source_uuid: clipMeta.source_uuid,
        generation: clipMeta.generation,
        app: clipMeta.app,
        keyframes: clipMeta.keyframes,
      };

      // A raw label equal to the current display name is a legacy derived
      // value; do not resurrect it after the assembly policy has healed it.
      const legacyDerivedLabel = authoredClip
        && Object.prototype.hasOwnProperty.call(authoredClip, 'label')
        && clipMeta.label === undefined
        && clipMeta.displayName === authoredClip.label;
      if (authoredClip && Object.prototype.hasOwnProperty.call(authoredClip, 'label') && !legacyDerivedLabel) {
        nextClip.label = authoredClip.label;
      } else if (!authoredClip && clipMeta.label !== undefined) {
        nextClip.label = clipMeta.label;
      }

      if (typeof clipMeta.hold === 'number') {
        nextClip.hold = roundTimelineTime(roundedEnd - roundedStart);
        delete nextClip.from;
        delete nextClip.to;
        delete nextClip.speed;
      } else {
        const speed = clipMeta.speed ?? 1;
        const from = roundTimelineTime(clipMeta.from ?? 0);
        nextClip.from = from;
        nextClip.to = roundTimelineTime(getSourceTime({ from, start: roundedStart, speed }, roundedEnd));
      }

      const serializedClip: Partial<TimelineClip> = {
        id: nextClip.id,
        at: nextClip.at,
        track: nextClip.track,
      };

      if (nextClip.asset !== undefined) {
        serializedClip.asset = nextClip.asset;
      }

      for (const field of TIMELINE_CLIP_FIELDS) {
        if (field in serializedClip) {
          continue;
        }

        const value = nextClip[field];
        if (value !== undefined) {
          serializedClip[field] = value as never;
        }
      }

      clips.push(serializedClip as TimelineClip);
    }
  }

  const config: TimelineConfig = {
    output: { ...output },
    tracks: tracks.map((track) => ({ ...track })),
    clips,
    ...(extras ? cloneTimelineExtras(extras) : {}),
  };
  if (pinnedShotGroups && pinnedShotGroups.length > 0) {
    config.pinnedShotGroups = clonePinnedShotGroups(pinnedShotGroups);
  }
  const serialized = serializeTimelineConfigSnapshot(config).config;
  return {
    ...serialized,
    clips: serialized.clips.map((clip) => retainedClips.get(clip.id) ?? clip),
  };
};

/**
 * Shared frozen-empty lane plane. Every assembled TimelineData starts here;
 * lane producers replace it wholesale (never mutate) via `mergeDataLanes`.
 */
const EMPTY_DATA_LANES: DataLaneView[] = [];
Object.freeze(EMPTY_DATA_LANES);

interface AssembleTimelineDataParams {
  config: TimelineConfig;
  configVersion: number;
  head?: import('../data/DataProvider.ts').TimelineHeadRevision;
  registry: AssetRegistry;
  resolvedConfig: ResolvedTimelineConfig;
  output: TimelineOutput;
  assetMap: Record<string, string>;
  /** Bundle-sourced SOURCE items to carry onto the assembled TimelineData. */
  sourceItemsBySchemaRef?: Readonly<Record<string, readonly SourceFrozenDataItem[]>>;
  transcriptReferences?: TranscriptReferences;
}

/**
 * Assembles TimelineData from already-derived inputs.
 * The provided config must already be migrated to the canonical flat-track shape.
 */
export const assembleTimelineData = ({
  config,
  configVersion,
  head,
  registry,
  resolvedConfig,
  assetMap,
  sourceItemsBySchemaRef,
  transcriptReferences,
}: AssembleTimelineDataParams): TimelineData => {
  // `serializeForDisk` intentionally strips `output` (it is derived render
  // state, not persisted), and the provider load path re-materializes it via
  // `withDefaultTimelineOutput`. Rebuild paths (commits, poll sync, save
  // recovery) assemble TimelineData directly and MUST apply the same defaults
  // when `output` is absent: otherwise `output` collapses to `{}` and
  // consumers like `useDerivedTimeline`'s `parseResolution(output.resolution)`
  // crash on `undefined` (or a JSON `null` from a partial payload). Filling
  // defaults also keeps `config`'s stable signature consistent with the
  // bridge-normalized config, preventing phantom poll diffs ("fake edits")
  // and spurious 409 version conflicts. Configs that already carry a valid
  // `resolution` pass through verbatim (identity preserved).
  const outputMissingResolution = config.output?.resolution == null;
  const canonicalConfig = outputMissingResolution ? withDefaultTimelineOutput(config) : config;
  const canonicalOutput = outputMissingResolution ? canonicalConfig.output : resolvedConfig.output;
  const canonicalResolvedConfig = outputMissingResolution
    ? { ...resolvedConfig, output: canonicalOutput }
    : resolvedConfig;
  const nameBasis = deriveClipNameBasis(
    canonicalResolvedConfig.clips,
    canonicalResolvedConfig.registry,
    canonicalResolvedConfig.tracks,
  );
  const displayNames = nameBasis.shown;
  const resolvedClips = canonicalResolvedConfig.clips.map((clip) => ({
    ...clip,
  })).map((clip, index) => {
    const label = displayNames.get(canonicalResolvedConfig.clips[index].id);
    if (label === undefined || label === canonicalResolvedConfig.clips[index].label) {
      return clip;
    }
    // Display labels are derived view data. Keep them available to consumers
    // without making them part of the resolved JSON identity.
    Object.defineProperty(clip, 'label', {
      value: label,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return clip;
  });
  canonicalResolvedConfig.clips = resolvedClips;
  const rowData = configToRows(canonicalConfig);
  // The derived name is a view, kept in `displayName` so that saving rows never writes it back as `label`
  // (a saved `label` reads as user-set and would stick after the asset changes). `meta.label` keeps only a
  // label the derivation actually used and that is not just the name the clip would get anyway; this also
  // heals timelines saved before this rule (a label equal to the current derived name is treated as unset,
  // as are junk labels such as the asset id).
  for (const [clipId, displayName] of displayNames) {
    const clipMeta = rowData.meta[clipId];
    if (!clipMeta) continue;
    const label = isExplicitClipLabel(clipMeta.label, clipId, nameBasis) ? clipMeta.label : undefined;
    rowData.meta[clipId] = { ...clipMeta, label, displayName };
  }

  return {
    config: canonicalConfig,
    configVersion,
    ...(head ? { head } : {}),
    registry,
    resolvedConfig: canonicalResolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap,
    output: canonicalOutput,
    tracks: rowData.tracks,
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(canonicalResolvedConfig),
    stableSignature: transcriptReferences || (sourceItemsBySchemaRef && Object.values(sourceItemsBySchemaRef).some((items) => items.length > 0))
      ? canonicalJsonStringify({ config: canonicalConfig, registry, sourceItemsBySchemaRef: persistedTranscriptItems(sourceItemsBySchemaRef ?? {}), ...(transcriptReferences ? {transcriptReferences} : {}) })
      : getStableConfigSignature(canonicalConfig, registry),
    dataLanes: EMPTY_DATA_LANES,
    // Persisted-source plane rides as DATA (never prebuilt lanes — views
    // derive at assembly, render-side). `dataLanes` stays frozen-empty here.
    ...(sourceItemsBySchemaRef ? { sourceItemsBySchemaRef } : {}),
    ...(transcriptReferences ? {transcriptReferences} : {}),
  };
};

export const buildTimelineData = async (
  config: TimelineConfig,
  registry: AssetRegistry,
  urlResolver?: UrlResolver,
  configVersion = 1,
  sourceItemsBySchemaRef?: Readonly<Record<string, readonly SourceFrozenDataItem[]>>,
  head?: import('../data/DataProvider.ts').TimelineHeadRevision,
  transcriptReferences?: TranscriptReferences,
): Promise<TimelineData> => {
  const canonical = canonicalizeTimelinePair(config, registry);
  const displayConfig = projectTimelineTracksForDisplay(canonical.config);
  const resolvedConfig = await resolveTimelineConfig(displayConfig, canonical.registry, urlResolver);

  return assembleTimelineData({
    config: displayConfig,
    configVersion,
    head,
    registry: canonical.registry,
    resolvedConfig,
    output: { ...canonical.config.output },
    assetMap: buildAssetMap(canonical.registry),
    sourceItemsBySchemaRef,
    transcriptReferences,
  });
};

function isAssetResolverArg(value: unknown): value is AssetResolver {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as { resolveAssetUrl?: unknown }).resolveAssetUrl === 'function'
  );
}

/**
 * Build a TimelineData using the resolver-hook contract (`onResolve`,
 * `onMissing`). Used for refresh paths and unit tests that exercise the
 * pluggable resolver lifecycle. Production load paths can keep calling
 * `buildTimelineData(config, registry, urlResolver, configVersion)`.
 */
export const buildTimelineDataWithResolver = async (
  config: TimelineConfig,
  registry: AssetRegistry,
  resolver: AssetResolver,
  configVersion = 1,
  timelineId?: string,
  sourceItemsBySchemaRef?: Readonly<Record<string, readonly SourceFrozenDataItem[]>>,
  head?: import('../data/DataProvider.ts').TimelineHeadRevision,
  transcriptReferences?: TranscriptReferences,
): Promise<TimelineData> => {
  const canonical = canonicalizeTimelinePair(config, registry);
  const displayConfig = projectTimelineTracksForDisplay(canonical.config);

  const urlResolver: UrlResolver = (file, entry, assetId) => {
    const resolutionToken = file || entry?.media_id || assetId || '';
    if (resolver.onResolve) {
      return resolver.onResolve({ file: resolutionToken, entry, assetId, timelineId });
    }
    return resolver.resolveAssetUrl(resolutionToken);
  };

  const resolvedConfig = await resolveTimelineConfig(displayConfig, canonical.registry, urlResolver);

  // Surface missing-asset references through the resolver lifecycle so
  // the host can render a tombstone / retry path.
  if (resolver.onMissing) {
    const registeredAssets = canonical.registry.assets ?? {};
    for (const clip of canonical.config.clips) {
      if (!clip.asset) continue;
      const entry = registeredAssets[clip.asset];
      if (!entry) {
        const missingRequest: AssetMissingRequest = {
          assetId: clip.asset,
          reason: 'missing_asset',
          clipId: clip.id,
          timelineId,
          clip,
          config: canonical.config,
          registry: canonical.registry,
        };
        // Fire-and-forget — host listens.
        await resolver.onMissing(missingRequest);
      }
    }
  }

  return assembleTimelineData({
    config: displayConfig,
    configVersion,
    head,
    registry: canonical.registry,
    resolvedConfig,
    output: { ...canonical.config.output },
    assetMap: buildAssetMap(canonical.registry),
    sourceItemsBySchemaRef,
    transcriptReferences,
  });
};

export function loadTimelineJsonFromProvider(
  provider: DataProvider,
  timelineIdOrResolver: string | AssetResolver,
  resolverOrTimelineId?: UrlResolver | string,
  legacyUrlResolver?: UrlResolver,
  poll = false,
): Promise<TimelineData> {
  // New shape: (provider, assetResolver, timelineId)
  if (isAssetResolverArg(timelineIdOrResolver)) {
    const assetResolver = timelineIdOrResolver;
    const timelineId = String(resolverOrTimelineId ?? '');
    return (async () => {
      const loaded = provider.saveTimelineAtHead && provider.loadReferencedTimeline
        ? await provider.loadReferencedTimeline(timelineId, { poll })
        : await Promise.all([provider.loadTimeline(timelineId, { poll }), provider.loadAssetRegistry(timelineId, { poll })])
            .then(([timeline, registry]) => ({ timeline, registry, resolveAssetUrl: undefined }));
      const { timeline: loadedTimeline, registry } = loaded;
      const snapshotResolve = loaded.resolveAssetUrl;
      // A head-aware provider's resolver belongs to this exact config/registry
      // pair. The host resolver can depend on a separate registry query that
      // is still pending (or belongs to the previous head). Keep the missing
      // lifecycle hook, but resolve this load entirely against its snapshot.
      const loadResolver: AssetResolver = snapshotResolve ? {
        ...assetResolver,
        resolveAssetUrl: snapshotResolve,
        onResolve: ({ file }) => snapshotResolve(file),
      } : assetResolver;
      // E4 seam 4/5: the loaded bundle's SOURCE items ride into assembly
      // data so lanes repaint after reload (views still derive render-side).
      return buildTimelineDataWithResolver(
        loadedTimeline.config,
        registry,
        loadResolver,
        loadedTimeline.configVersion,
        timelineId,
        loadedTimeline.bundle?.itemsBySchemaRef,
        loadedTimeline.head,
        loadedTimeline.bundle?.transcriptReferences,
      );
    })();
  }

  // Legacy shape: (provider, timelineId, urlResolver?)
  const timelineId = timelineIdOrResolver as string;
  const explicitUrlResolver = (resolverOrTimelineId as UrlResolver | undefined)
    ?? legacyUrlResolver
    ?? null;
  return (async () => {
    const loaded = provider.saveTimelineAtHead && provider.loadReferencedTimeline
      ? await provider.loadReferencedTimeline(timelineId, { poll })
      : await Promise.all([provider.loadTimeline(timelineId, { poll }), provider.loadAssetRegistry(timelineId, { poll })])
          .then(([timeline, registry]) => ({ timeline, registry, resolveAssetUrl: undefined }));
    const { timeline: loadedTimeline, registry } = loaded;
    // Runtime loads return a resolver bound to the exact immutable timeline
    // snapshot. Prefer it over DataProvider.resolveAssetUrl, whose legacy
    // implementation reads mutable activeRegistry state populated by a
    // separate request and can therefore lag the head we just loaded.
    const urlResolver = loaded.resolveAssetUrl
      ?? explicitUrlResolver
      ?? ((file: string) => provider.resolveAssetUrl(file));
    return buildTimelineData(
      loadedTimeline.config,
      registry,
      urlResolver,
      loadedTimeline.configVersion,
      loadedTimeline.bundle?.itemsBySchemaRef,
      loadedTimeline.head,
      loadedTimeline.bundle?.transcriptReferences,
    );
  })();
}

export async function loadTranscript(
  providerOrResolver: DataProvider | AssetResolver,
  assetKey: string,
  timelineId?: string,
): Promise<TranscriptSegment[]> {
  // Resolver-aware path: prefer onProfileLoad if installed.
  if (
    typeof (providerOrResolver as AssetResolver).onProfileLoad === 'function'
  ) {
    const resolver = providerOrResolver as AssetResolver;
    const profile = await resolver.onProfileLoad?.({ assetId: assetKey, timelineId });
    return profile?.transcript?.segments ?? [];
  }

  // Legacy path: provider.loadAssetProfile(assetId) or resolver.loadAssetProfile.
  const legacy = (providerOrResolver as { loadAssetProfile?: (id: string) => Promise<{ transcript?: { segments?: TranscriptSegment[] } } | null> }).loadAssetProfile;
  const profile = legacy ? await legacy(assetKey) : null;
  return profile?.transcript?.segments ?? [];
}

export function getAssetColor(asset: string): string {
  return ASSET_COLORS[asset] ?? '#abb2bf';
}

export function getSourceTime(clip: { from: number; start: number; speed: number }, time: number): number {
  return clip.from + (time - clip.start) * clip.speed;
}

export function inferTrackType(filePath: string): TrackKind {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (['.mp4', '.webm', '.mov'].includes(ext)) {
    return 'visual';
  }

  if (['.mp3', '.wav', '.aac', '.m4a'].includes(ext)) {
    return 'audio';
  }

  return 'visual';
}

export function preserveUploadingClips(source: TimelineData, target: TimelineData): TimelineData {
  const uploadingMeta: Record<string, ClipMeta> = {};
  const uploadingActions: Record<string, TimelineAction[]> = {};
  let found = false;
  for (const row of source.rows) {
    for (const action of row.actions) {
      if (action.id.startsWith('uploading-') && source.meta[action.id]) {
        uploadingActions[row.id] ??= [];
        uploadingActions[row.id].push(action);
        uploadingMeta[action.id] = source.meta[action.id];
        found = true;
      }
    }
  }
  if (!found) return target;

  const nextRows = target.rows.map((row) => {
    const extras = uploadingActions[row.id]?.filter(
      (extra) => !row.actions.some((action) => action.id === extra.id),
    );
    return extras && extras.length > 0 ? { ...row, actions: [...row.actions, ...extras] } : row;
  });
  return { ...target, rows: nextRows, meta: { ...target.meta, ...uploadingMeta } };
}

export function getNextClipId(meta: Record<string, ClipMeta>): string {
  let max = -1;
  for (const id of Object.keys(meta)) {
    const match = id.match(/^clip-(\d+)$/);
    if (match) {
      max = Math.max(max, Number.parseInt(match[1], 10));
    }
  }
  return `clip-${max + 1}`;
}

export function createEffectLayerClipMeta(trackId: string): ClipMeta {
  return {
    track: trackId,
    clipType: 'effect-layer',
    hold: 5,
  };
}
