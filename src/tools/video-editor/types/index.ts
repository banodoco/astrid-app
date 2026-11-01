// Re-export the canonical shared types so Astrid App and Banodoco agree at
// the boundary. Astrid App keeps richer locally-typed shapes for editor-internal use
// (ResolvedTimelineConfig, ClipMeta, etc.) — only the persisted on-disk shape
// must match the shared schema.
export type {
  TimelineConfig as SharedTimelineConfig,
  TimelineClip as SharedTimelineClip,
  ThemeOverrides as SharedThemeOverrides,
  TimelineOutput as SharedTimelineOutput,
  AssetEntry as SharedAssetEntry,
  Theme as SharedTheme,
} from '@banodoco/timeline-schema';

export type TimelineEffect = {
  fade_in?: number;
  fade_out?: number;
};

export type ParameterType =
  | 'number'
  | 'select'
  | 'boolean'
  | 'color'
  | 'audio-binding';

export type AudioBindingValue = {
  source: 'bass' | 'mid' | 'treble' | 'amplitude';
  min: number;
  max: number;
};

export type ParameterOption = {
  label: string;
  value: string;
};

export type ParameterDefinition = {
  name: string;
  label: string;
  description: string;
  type: ParameterType;
  default?: number | string | boolean | AudioBindingValue;
  min?: number;
  max?: number;
  step?: number;
  options?: ParameterOption[];
  /** Minimum string length (StandardSchema `minLength`). */
  minLength?: number;
  /** Maximum string length (StandardSchema `maxLength`). */
  maxLength?: number;
  /** Regex pattern constraint (StandardSchema `pattern`). */
  pattern?: string;
};

export type ParameterSchema = ParameterDefinition[];

export type TrackKind = 'visual' | 'audio';
export type TrackRole = 'output' | 'source';
export type TrackFit = 'cover' | 'contain' | 'manual';
export type TrackBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'soft-light'
  | 'hard-light';
// clipType is widened to a string at the schema level.
// The closed union of built-in clip types is retained as BUILTIN_CLIP_TYPES for
// call sites that still narrow against the legacy four. Effect-id / theme-id
// validation against a registry is deferred; the editor's placeholder fallback
// for unknown clipTypes renders as a placeholder.
export { BUILTIN_CLIP_TYPES, type BuiltinClipType } from '@/sdk/video/timeline/clipTypes.ts';
export type ClipType = string;

export type TrackDefinition = {
  id: string;
  kind: TrackKind;
  label: string;
  /** Source lanes stay authored and visible but are excluded from output. */
  role?: TrackRole;
  scale?: number;
  fit?: TrackFit;
  opacity?: number;
  volume?: number;
  muted?: boolean;
  blendMode?: TrackBlendMode;
  app?: Record<string, unknown>;
};

export type ClipEntrance = {
  type: string;
  duration: number;
  intensity?: number;
  params?: Record<string, unknown>;
};

export type ClipExit = {
  type: string;
  duration: number;
  intensity?: number;
  params?: Record<string, unknown>;
};

export type ClipContinuous = {
  type: string;
  intensity?: number;
  params?: Record<string, unknown>;
};

export type ClipTransition = {
  type: string;
  duration: number;
  /** Content-digested Astrid element revision when the transition is registered. */
  revision?: string;
  params?: Record<string, unknown>;
};

/** Stable, revision-pinned reference for an Astrid-backed visual element. */
export type TimelineElementRef = {
  /** Optional owning pack; omitted refs use the Astrid registry winner. */
  packId?: string;
  id: string;
  kind: 'effect' | 'animation' | 'transition';
  revision: string;
};

export type TextAlignment = 'left' | 'center' | 'right';

export type TextClipData = {
  content: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  align?: TextAlignment;
  bold?: boolean;
  italic?: boolean;
};

// Keyframe interpolation mode — mirrors the SDK KeyframeInterpolation type.
export type KeyframeInterpolation = 'linear' | 'hold';

// A single keyframe stored as JSON-serializable timeline data on a clip.
export type ClipKeyframe = {
  /** Time in seconds. */
  time: number;
  /** JSON-serializable value (number | string | boolean). */
  value: number | string | boolean;
  /** Interpolation mode from this keyframe to the next. */
  interpolation: KeyframeInterpolation;
};

// Timeline-resident live binding metadata. Runtime samples remain
// provider-scoped and must never be persisted in these shapes.
export type TimelineLiveSourceKind =
  | 'webcam'
  | 'microphone'
  | 'midi'
  | 'serial'
  | 'bluetooth'
  | 'generated'
  | 'screen-capture'
  | 'audio-device'
  | 'osc'
  | 'custom';

export type TimelineLiveSourceStatus =
  | 'inactive'
  | 'activating'
  | 'active'
  | 'error'
  | 'disposed'
  | 'orphaned';

export type TimelineLiveBindingResolutionStatus =
  | 'active'
  | 'inactive'
  | 'missing'
  | 'disposed'
  | 'orphaned'
  | 'partiallyBaked'
  | 'resolved'
  | 'malformed';

export type TimelineLiveSamplingMode = 'latest' | 'time' | 'frame' | 'sequence';

export type TimelineLiveBakeRange = {
  start?: number;
  end?: number;
  startFrame?: number;
  endFrame?: number;
  startSample?: number;
  endSample?: number;
  takeId?: string;
};

export type TimelineLiveDeterministicRefKind =
  | 'asset'
  | 'keyframe'
  | 'automation'
  | 'clip'
  | 'sidecar'
  | 'render-material'
  | 'deterministic-capture';

export type TimelineLiveDeterministicRef = {
  kind: TimelineLiveDeterministicRefKind;
  ref: string;
  range?: TimelineLiveBakeRange;
  metadata?: Record<string, unknown>;
};

export type TimelineLiveBakeMetadata = {
  status?: 'unbaked' | 'partial' | 'complete';
  bakedRanges?: TimelineLiveBakeRange[];
  unresolvedRanges?: TimelineLiveBakeRange[];
  deterministicRefs?: TimelineLiveDeterministicRef[];
};

export type TimelineLiveBinding = {
  bindingId: string;
  sourceId: string;
  sourceKind: TimelineLiveSourceKind;
  channelId?: string;
  targetParamName?: string;
  targetEffectId?: string;
  targetPath?: string;
  ownerExtensionId?: string;
  sampling?: {
    mode: TimelineLiveSamplingMode;
    frameOffset?: number;
    timeOffsetMs?: number;
  };
  sourceStatus?: TimelineLiveSourceStatus;
  resolutionStatus?: TimelineLiveBindingResolutionStatus;
  bake?: TimelineLiveBakeMetadata;
  deterministicRefs?: TimelineLiveDeterministicRef[];
  placeholder?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type TimelineLiveClipMetadata = {
  bindings?: TimelineLiveBinding[];
};

export type TimelineLiveUniformBindingMappingKind =
  | 'scalar'
  | 'vector'
  | 'fft-bin'
  | 'rms-amplitude'
  | 'onset-event'
  | 'frame-ref'
  | 'material-ref';

export type TimelineLiveUniformVectorComponent = 'x' | 'y' | 'z' | 'w';

export type TimelineLiveUniformBindingMapping =
  | {
      kind: 'scalar';
      uniform: string;
      sourcePath?: string;
      scale?: number;
      offset?: number;
    }
  | {
      kind: 'vector';
      uniform: string;
      components: TimelineLiveUniformVectorComponent[];
      sourcePaths?: string[];
    }
  | {
      kind: 'fft-bin';
      uniform: string;
      bin: number;
      fftSize?: number;
      smoothing?: number;
    }
  | {
      kind: 'rms-amplitude';
      uniform: string;
      windowMs?: number;
      scale?: number;
    }
  | {
      kind: 'onset-event';
      uniform: string;
      threshold?: number;
      decayMs?: number;
    }
  | {
      kind: 'frame-ref';
      uniform: string;
      ref: TimelineLiveDeterministicRef;
    }
  | {
      kind: 'material-ref';
      uniform: string;
      ref: TimelineLiveDeterministicRef;
    };

export type TimelineLiveUniformBinding = {
  bindingId: string;
  sourceId: string;
  sourceKind: TimelineLiveSourceKind;
  channelId?: string;
  targetMaterialId?: string;
  targetParamName?: string;
  targetPath?: string;
  mapping: TimelineLiveUniformBindingMapping;
  metadata?: Record<string, unknown>;
};

// Host-owned shader metadata persisted on the timeline. V1 stores one
// clip-local shader in clip.app.shader and one postprocess shader in
// config.app.shaderPostprocess.
export type TimelineShaderScope = 'clip' | 'postprocess';

export type TimelineShaderUniformValues = Record<string, unknown>;
export type TimelineShaderKeyframeValue = number | string | boolean | number[];
export type TimelineShaderKeyframe = {
  time: number;
  value: TimelineShaderKeyframeValue;
  interpolation: KeyframeInterpolation;
};
export type TimelineShaderUniformKeyframes = Record<string, TimelineShaderKeyframe[]>;

export type TimelineShaderTextureRef = {
  kind: 'clip-frame' | 'static-image-asset' | 'live-generated-frame';
  ref?: string;
};

export type TimelineShaderTextureValues = Record<string, TimelineShaderTextureRef>;

export type TimelineShaderBaseMetadata = {
  extensionId: string;
  contributionId: string;
  shaderId: string;
  label?: string;
  uniforms?: TimelineShaderUniformValues;
  keyframes?: TimelineShaderUniformKeyframes;
  textures?: TimelineShaderTextureValues;
  enabled?: boolean;
  sourceHash?: string;
  metadata?: Record<string, unknown>;
};

export type TimelineClipShaderMetadata = TimelineShaderBaseMetadata & {
  scope: 'clip';
};

export type TimelinePostprocessShaderMetadata = TimelineShaderBaseMetadata & {
  scope: 'postprocess';
};

export type TimelineClipAppMetadata = Record<string, unknown> & {
  shader?: TimelineClipShaderMetadata;
};

export type TimelineConfigAppMetadata = Record<string, unknown> & {
  shaderPostprocess?: TimelinePostprocessShaderMetadata;
  timelineDataLanePlacement?: import('@/tools/video-editor/lib/timeline-row-layout.ts').TimelineDataLanePlacement;
};

export type TimelineClip = {
  id: string;
  enabled?: boolean;
  active?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  deleted?: boolean;
  at: number;
  track: string;
  clipType?: ClipType;
  /** Human-readable clip label (extension-authored "Shot N" names). */
  label?: string;
  asset?: string;
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
  text?: TextClipData;
  entrance?: ClipEntrance;
  exit?: ClipExit;
  continuous?: ClipContinuous;
  transition?: ClipTransition;
  /** Optional Astrid element identity; legacy clips remain valid without it. */
  elementRef?: TimelineElementRef;
  effects?: TimelineEffect[] | Record<string, number>;
  // Schema-lift fields. All optional; existing timelines without them
  // round-trip unchanged. `params` carries effect/theme parameter blobs;
  // `pool_id` / `clip_order` are Banodoco-arrangement provenance fields.
  params?: Record<string, unknown>;
  pool_id?: string;
  clip_order?: number;
  source_uuid?: string;
  generation?: Record<string, unknown>;
  app?: TimelineClipAppMetadata;
  // Host-owned keyframes keyed by parameter name.
  // Each parameter maps to an ordered array of keyframes.
  keyframes?: Record<string, ClipKeyframe[]>;
};

export type TimelineOutput = {
  resolution: string;
  fps: number;
  file: string;
  background?: string | null;
  background_scale?: number | null;
};

export type CustomEffectEntry = {
  code: string;
  category?: 'entrance' | 'exit' | 'continuous';
};

export type PinnedShotImageClipSnapshot = {
  clipId: string;
  assetKey?: string;
  start?: number;
  end?: number;
  meta: {
    clipType?: ClipType;
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
    text?: TextClipData;
    entrance?: ClipEntrance;
    exit?: ClipExit;
    continuous?: ClipContinuous;
    transition?: ClipTransition;
    effects?: TimelineEffect[] | Record<string, number>;
    params?: Record<string, unknown>;
    pool_id?: string;
    clip_order?: number;
    source_uuid?: string;
    generation?: Record<string, unknown>;
    keyframes?: Record<string, ClipKeyframe[]>;
  };
};

// `clipIds` is ordered left-to-right by each clip's live `at` and must be rebuilt whenever group membership or ordering changes.
export type PinnedShotGroup = {
  shotId: string;
  /** Human-readable shot name stored in the document (never joined from a second authority). */
  name?: string;
  trackId: string;
  clipIds: string[];
  mode?: 'images' | 'video';
  videoAssetKey?: string;
  imageClipSnapshot?: PinnedShotImageClipSnapshot[];
  /**
   * Pooled (unpositioned) generation members: shot members not yet placed as clips.
   */
  poolGenerationIds?: string[];
  /** Source group lineage for a document-native deep-copy duplicate. */
  derivedFrom?: {
    shotId: string;
    trackId: string;
  };
};

// Theme overrides and generation defaults blocks. Open-shaped on
// purpose — concrete schemas land with theme registry packages.
export type ThemeOverrides = {
  visual?: Record<string, unknown>;
  generation?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  pacing?: Record<string, unknown>;
};

export type GenerationDefaults = Record<string, unknown>;

export type TimelineConfig = {
  output: TimelineOutput;
  clips: TimelineClip[];
  tracks?: TrackDefinition[];
  /** Authored timeline effects, applied to child clips by the shot render projection. */
  effects?: TimelineClip['effects'];
  pinnedShotGroups?: PinnedShotGroup[];
  // Schema-lift fields. All optional. `theme` is a slug that
  // resolves against the theme registry at render time; `theme_overrides`
  // deep-merges onto the resolved theme; `generation_defaults` carries
  // pipeline-wide generation knobs.
  theme?: string;
  theme_overrides?: ThemeOverrides;
  generation_defaults?: GenerationDefaults;
  app?: TimelineConfigAppMetadata;
};

// ---------------------------------------------------------------------------
// Asset metadata — host-owned shapes + extension namespace
// ---------------------------------------------------------------------------

export type AssetMetadataIntegrity = {
  sha256?: string;
  md5?: string;
  crc32?: string;
};

export type AssetMetadataGPS = {
  latitude?: number;
  longitude?: number;
  altitude?: number;
  horizontalAccuracy?: number;
  timestamp?: string;
};

export type AssetMetadataConsent = {
  modelRelease?: boolean;
  propertyRelease?: boolean;
  rightsHolder?: string;
  license?: string;
  usageTerms?: string;
};

export type AssetMetadataProvenance = {
  importTimestamp?: string;
  importOperationId?: string;
  sourceUrl?: string;
  sourceProvider?: string;
  importedBy?: string;
  originalFilename?: string;
};

export type AssetMetadataEnrichmentClaim = {
  claimId: string;
  parserId: string;
  timestamp: string;
  field?: string;
  summary?: string;
  /** SDK deferred-enrichment identity and lifecycle fields. */
  assetId?: string;
  kind?: string;
  status?: 'pending' | 'claimed' | 'resolving' | 'resolved' | 'failed' | 'expired';
  extensionId?: string;
  contributionId?: string;
  updatedAt?: string;
  diagnostic?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
};

export type AssetMetadataEnrichment = {
  pending?: number;
  failed?: number;
  claims?: AssetMetadataEnrichmentClaim[];
};

export type AssetMetadata = {
  integrity?: AssetMetadataIntegrity;
  gps?: AssetMetadataGPS;
  consent?: AssetMetadataConsent;
  provenance?: AssetMetadataProvenance;
  enrichment?: AssetMetadataEnrichment;
  extensions?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

export type AssetRegistryEntry = {
  /** Optional legacy/source locator; managed Astrid media may use media_id only. */
  file?: string;
  /** Human-readable source metadata used for timeline clip labels. */
  original_name?: string;
  original_filename?: string;
  filename?: string;
  name?: string;
  title?: string;
  prompt?: string;
  /** Stable project-owned media identity used by the Astrid bridge byte route. */
  media_id?: string;
  /** Astrid media handle (sha256 or ref/run lineage) the entry was resolved from. */
  handle?: string;
  /** Astrid-owned provenance of the entry; kept verbatim by the App. */
  source?: unknown;
  /** Pixel executor report carried beside a pixel asset; shape owned by Astrid. */
  pixel_provenance?: unknown;
  url?: string;
  etag?: string;
  content_sha256?: string;
  url_expires_at?: string;
  type?: string;
  duration?: number;
  resolution?: string;
  fps?: number;
  origin?: 'immutable-public' | 'refreshable-from-generation' | 'opaque-foreign';
  derivedFrom?: {
    assetId?: string;
    content_sha256?: string;
    role: 'thumbnail' | 'proxy' | 'render-output';
  };
  generationId?: string;
  variantId?: string;
  thumbnailUrl?: string;
  metadata?: AssetMetadata;
};

export type AssetRegistry = {
  assets: Record<string, AssetRegistryEntry>;
};

export type ResolvedAssetRegistryEntry = AssetRegistryEntry & {
  src: string;
};

export type ResolvedTimelineClip = TimelineClip & {
  assetEntry?: ResolvedAssetRegistryEntry;
};

export type ResolvedTimelineConfig = {
  output: TimelineOutput;
  tracks: TrackDefinition[];
  clips: ResolvedTimelineClip[];
  registry: Record<string, ResolvedAssetRegistryEntry>;
  theme?: string;
  theme_overrides?: ThemeOverrides;
  generation_defaults?: GenerationDefaults;
  app?: TimelineConfigAppMetadata;
  /** Parent-level effects carried through the resolver's `...config` spread; read by the seam intent and shot projection. */
  effects?: TimelineClip['effects'];
};

export type TimelineCompositionProps = {
  config?: ResolvedTimelineConfig;
  preview?: boolean;
};

// ---------------------------------------------------------------------------
// Deterministic Capture — host/editor-owned contracts
// ---------------------------------------------------------------------------
// These types define the frozen V1 deterministic capture profiles. Concrete
// table bodies are host/editor-owned and must not be re-exported through the
// public SDK. The public SDK only gains the `deterministic-capture` bake-target
// discriminant.

/** Frozen V1 deterministic capture profiles. */
export type DeterministicCaptureProfileV1 =
  | 'seed'
  | 'event'
  | 'scalar'
  | 'structured-motion-curve';

/**
 * Collision policy for event-table entries that share a (targetPath, mappedTime)
 * pair. Only `replace`, `merge-first-wins`, `merge-last-wins`, and `reject` are
 * allowed.
 */
export type CaptureCollisionPolicy =
  | 'replace'
  | 'merge-first-wins'
  | 'merge-last-wins'
  | 'reject';

/** Provenance metadata for a deterministic capture. */
export type DeterministicCaptureProvenance = {
  /** Extension that produced this capture. */
  producerExtensionId?: string;
  /** Version of the producer at capture time. */
  producerVersion?: string;
  /** ISO 8601 timestamp when the capture was created. */
  capturedAt: string;
  /** Stable identifier for the capture session. */
  sessionId?: string;
  /** Opaque provenance tags. */
  tags?: string[];
};

/**
 * Route constraints carried by a deterministic capture. Reuses the existing
 * RenderRoute vocabulary. Unknown constraints should block acceptance.
 */
export type DeterministicCaptureRouteConstraint =
  | 'preview'
  | 'browser-export'
  | 'worker-export'
  | 'sidecar-export';

/** Rejection rules for deterministic capture validation. */
export type DeterministicCaptureRejectionRule =
  | 'missing-provenance'
  | 'bad-content-hash'
  | 'unsupported-profile'
  | 'unsupported-event-type'
  | 'unsupported-interpolation'
  | 'bad-route-constraint'
  | 'deferred-profile'
  | 'malformed-value-ref';

/** A rejection produced by deterministic capture validation. */
export type DeterministicCaptureRejection = {
  rule: DeterministicCaptureRejectionRule;
  message: string;
  detail?: Record<string, unknown>;
};

/**
 * A validated reference to a baked deterministic value within a capture body.
 * References are produced by capture validation and consumed by conversion
 * and export guard code.
 */
export type BakedValueRef = {
  /** The capture that produced this value. */
  captureId: string;
  /** Profile of the source capture. */
  profile: DeterministicCaptureProfileV1;
  /** SHA-256 content hash of the capture body (hex-encoded). */
  contentHash: string;
  /** SHA-256 provenance hash of the capture metadata (hex-encoded). */
  provenanceHash: string;
  /** Route constraints from the capture. */
  routeConstraints: DeterministicCaptureRouteConstraint[];
  /** The path to the value within the capture body (e.g. "events[3].value"). */
  valuePath: string;
  /** Determinism posture at reference time. */
  determinism: 'deterministic' | 'preview-only' | 'process-dependent';
};

/**
 * The top-level deterministic capture container. Every capture carries a frozen
 * V1 profile discriminant, provenance, a content hash, route constraints, and
 * exactly one of the four V1 table shapes as its body.
 */
export type DeterministicCapture = {
  /** Unique capture identifier. */
  captureId: string;
  /** Frozen V1 profile discriminant. */
  profile: DeterministicCaptureProfileV1;
  /** Provenance metadata. */
  provenance: DeterministicCaptureProvenance;
  /** SHA-256 content hash of the serialized body (hex-encoded). */
  contentHash: string;
  /** Route constraints for this capture. */
  routeConstraints: DeterministicCaptureRouteConstraint[];
  /** Determinism posture. */
  determinism: 'deterministic' | 'preview-only' | 'process-dependent';
  /** Opaque extension metadata. */
  metadata?: Record<string, unknown>;
  /** The capture body — exactly one of the four V1 table shapes. */
  body: DeterministicCaptureTableV1;
};

/**
 * Union of the four frozen V1 capture table shapes. No deferred profile
 * candidates or concrete table body implementations are exported through
 * the public SDK.
 */
export type DeterministicCaptureTableV1 =
  | CaptureSeedTableV1
  | CaptureEventTableV1
  | CaptureScalarTableV1
  | CaptureStructuredMotionCurveV1;

// ── V1 Table Shapes ────────────────────────────────────────────────────────

/** V1 seed table — a single seed value for deterministic generation. */
export type CaptureSeedTableV1 = {
  profile: 'seed';
  /** The seed value (string or number). */
  seed: string | number;
  /** Optional label describing the seed's purpose. */
  label?: string;
};

/** A single timed event in a V1 event table. */
export type CaptureEventV1 = {
  /** Stable event identifier. */
  eventId: string;
  /** Time in seconds. */
  time: number;
  /** Target parameter path (e.g. "params.opacity"). */
  targetPath: string;
  /** The value at this event. */
  value: number | string | boolean;
  /** Interpolation from this event to the next. */
  interpolation: KeyframeInterpolation;
  /** Per-event collision policy override (falls back to table default). */
  collisionPolicy?: CaptureCollisionPolicy;
  /** Optional event metadata. */
  metadata?: Record<string, unknown>;
};

/** V1 event table — timed events with target paths, values, and collision policy. */
export type CaptureEventTableV1 = {
  profile: 'event';
  /** Ordered array of timed events. */
  events: CaptureEventV1[];
  /** Default collision policy applied when not overridden per-event. */
  defaultCollisionPolicy: CaptureCollisionPolicy;
};

/** A single scalar entry mapping a parameter path to a value. */
export type CaptureScalarEntryV1 = {
  /** Target parameter path. */
  targetPath: string;
  /** The scalar value. */
  value: number | string | boolean;
  /** Optional label. */
  label?: string;
};

/** V1 scalar table — parameter path → scalar value mappings. */
export type CaptureScalarTableV1 = {
  profile: 'scalar';
  /** Parameter path → scalar value entries. */
  entries: CaptureScalarEntryV1[];
};

/** A single keyframe in a V1 structured motion curve. */
export type CaptureCurveKeyframeV1 = {
  /** Time in seconds. */
  time: number;
  /** Value at this keyframe. */
  value: number;
  /** Interpolation from this keyframe to the next (falls back to curve default). */
  interpolation?: KeyframeInterpolation;
};

/** V1 structured motion curve — keyframe-based motion curve on a parameter. */
export type CaptureStructuredMotionCurveV1 = {
  profile: 'structured-motion-curve';
  /** Target parameter path. */
  targetPath: string;
  /** Ordered keyframes defining the curve. */
  keyframes: CaptureCurveKeyframeV1[];
  /** Default interpolation used between keyframes unless overridden. */
  defaultInterpolation: KeyframeInterpolation;
};
