import type {
  ResolvedTimelineClip,
  ResolvedTimelineConfig,
  TrackDefinition,
} from '@/tools/video-editor/types/index.ts';
import { coversFrame, visualSeamSourceTrack } from './visualSeamCoverage.ts';
import { timelineClipDurationMs } from './shotCompositionTiming.ts';
import { portableVisualSeamIntent, visualSeamOwners, type DisclosedOwner } from './portableVisualSeamIntent.ts';
import type {SeamIntent} from '../../../../vendor/astrid-browser/astrid/packs/local/rendering/elements/seam-intent';
import {sameContext, pauseCovers} from '../../../../vendor/astrid-browser/astrid/packs/local/rendering/elements/seam-intent';
import type {BoundaryCue} from '../../../../vendor/astrid-browser/astrid/packs/local/rendering/elements/boundary';
import {transitionFrames} from '../../../../vendor/astrid-browser/astrid/packs/local/rendering/elements/boundary';

export const VISUAL_SEAM_CONTRACT_VERSION = 1 as const;

export type VisualSeamIntent = 'hard-cut' | 'transition' | 'synchronized';
type StoredVisualSeamIntent = VisualSeamIntent | Readonly<{
  kind: VisualSeamIntent;
  frame: number;
  participants: readonly string[];
  context: string;
  canonical?: SeamIntent;
}>;

export type VisualBoundaryBehavior =
  | 'continues'
  | 'enters'
  | 'exits'
  | 'source-change'
  | 'motion-start'
  | 'phase-change'
  | 'activation'
  | 'source-reset'
  | 'rate-change'
  | 'opaque';

export type VisualSeamParticipant = Readonly<{
  ownerId: string;
  path: readonly string[];
  behavior: VisualBoundaryBehavior;
  clipId: string;
  cue?: BoundaryCue;
}>;

export type VisualSeamBoundary = Readonly<{
  frame: number;
  timeSeconds: number;
  intent?: VisualSeamIntent;
  participants: readonly VisualSeamParticipant[];
  structuralIssues: readonly string[];
  unacknowledgedRisk: boolean;
  requiresIntent: boolean;
}>;

export type VisualSeamOpaqueElement = Readonly<{
  clipId: string;
  clipType: string;
  ownerId: string;
  path: readonly string[];
  startFrame: number;
  endFrame: number;
  reason: 'custom-clip-type' | 'element-ref' | 'unsupported-transition' | 'unsupported-timing';
  opaqueReasons?: readonly string[];
  elementRef?: Readonly<{
    id: string;
    kind: string;
    revision?: string;
    packId?: string;
  }>;
}>;

export type VisualSeamReport = Readonly<{
  version: typeof VISUAL_SEAM_CONTRACT_VERSION;
  fps: number;
  guardFrames: number;
  boundaries: readonly VisualSeamBoundary[];
  opaqueElements: readonly VisualSeamOpaqueElement[];
  structuralIssues: readonly string[];
  cues: readonly BoundaryCue[];
  warningCount: number;
  blocked: boolean;
  /** Preserves bounded diagnostics returned by an independently validating Runtime. */
  rawDiagnostics?: Readonly<Record<string, unknown>>;
}>;

export type VisualSeamAnalysisOptions = Readonly<{
  guardFrames?: number;
  /** Tracks whose picture continuity is structural. Overlay/effect tracks are not. */
  continuityTracks?: readonly string[];
  /** Turn an unacknowledged visual-risk warning into admission failure. */
  enforceIntent?: boolean;
}>;

export class VisualSeamAdmissionError extends Error {
  readonly code = 'visual_seam_admission_blocked' as const;
  readonly report: VisualSeamReport;

  constructor(message: string, report: VisualSeamReport) {
    super(message);
    this.name = 'VisualSeamAdmissionError';
    this.report = report;
  }
}

type JsonRecord = Record<string, unknown>;

type ClipSpan = Readonly<{
  clip: ResolvedTimelineClip;
  track: TrackDefinition | undefined;
  startFrame: number;
  endFrame: number;
  primary: boolean;
}>;

type Cue = Readonly<{
  frame: number;
  participant: VisualSeamParticipant;
}>;

type BoundaryCandidate = Readonly<{
  frame: number;
  intent?: VisualSeamIntent;
  participants: readonly VisualSeamParticipant[];
  structuralIssues: readonly string[];
}>;

const AUXILIARY_CLIP_TYPES = new Set([
  'effect-layer',
  'frame-overlay',
  'end-spanning-layer',
  'text',
  'audio',
]);

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function active(clip: ResolvedTimelineClip): boolean {
  return clip.enabled !== false
    && clip.active !== false
    && clip.disabled !== true
    && clip.hidden !== true
    && clip.deleted !== true;
}

function clipDurationSeconds(clip: ResolvedTimelineClip): number {
  return timelineClipDurationMs(clip) / 1000;
}

function clipType(clip: ResolvedTimelineClip): string {
  return text(clip.clipType) ?? 'media';
}

function isPrimaryVisualClip(
  clip: ResolvedTimelineClip,
  track: TrackDefinition | undefined,
): boolean {
  if (track?.kind !== 'visual' || track.role === 'source' || AUXILIARY_CLIP_TYPES.has(clipType(clip))) return false;
  // Runtime picture_clip (240d5bb): any other clip on a visual, non-source track is picture, whatever its type;
  // Runtime does not read a pictureTracks declaration either.
  return !['effect', 'animation', 'transition'].includes(String(record(clip.elementRef)?.kind));
}

export function timecode(seconds: number): string {
  const tenths = Math.round(Math.abs(seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${seconds < 0 ? '-' : ''}${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function clipLabel(clip: {label?: unknown; text?: {content?: unknown}}): string {
  return text(clip.label) ?? text(clip.text?.content) ?? 'Unlabeled clip';
}

export function formatVisualSeamFinding(
  frame: number,
  fps: number,
  finding: 'overlap' | 'gap',
  trackLabel: string,
  clipLabels: readonly string[],
): string {
  const clips = clipLabels.map((label) => `'${label}'`);
  const detail = finding === 'overlap'
    ? `Two full-screen clips overlap on ${trackLabel}: ${clips.join(' and ')}`
    : `Gap on ${trackLabel} between ${clips.join(' and ')}`;
  return `${timecode(frame / fps)} · ${detail}`;
}

function declaredTrackPolicy(config: ResolvedTimelineConfig, key: 'continuityTracks'): Set<string> | undefined {
  const contract = record(record(config.app)?.visualSeamContract);
  const value = contract?.[key];
  return Array.isArray(value)
    ? new Set(value.filter((track): track is string => typeof track === 'string'))
    : undefined;
}

function ownerPath(clip: ResolvedTimelineClip): { ownerId: string; path: readonly string[] } {
  const canonical = record(clip.app?.canonical);
  const occurrenceId = text(canonical?.occurrenceId);
  const parentDocumentId = text(canonical?.parentDocumentId);
  if (occurrenceId && parentDocumentId) {
    return {
      ownerId: occurrenceId,
      path: ['parent', parentDocumentId, 'occurrence', occurrenceId, 'clip', clip.id],
    };
  }
  return {
    ownerId: clip.id,
    path: ['track', clip.track, 'clip', clip.id],
  };
}

function participant(
  clip: ResolvedTimelineClip,
  behavior: VisualBoundaryBehavior,
): VisualSeamParticipant {
  const owner = ownerPath(clip);
  return Object.freeze({
    ownerId: owner.ownerId,
    path: owner.path,
    behavior,
    clipId: clip.id,
  });
}

function participantKey(value: VisualSeamParticipant): string {
  return `${value.path.join('/')}:${value.clipId}:${value.behavior}:${value.cue?.id ?? ''}:${value.cue?.frame ?? ''}`;
}

function intentContext(frame: number, participants: readonly VisualSeamParticipant[]): string {
  return `${frame}|${participants.filter((item) => item.behavior !== 'opaque').map(participantKey).sort().join('|')}`;
}

function explicitIntentAt(config: ResolvedTimelineConfig, frame: number, participants: readonly VisualSeamParticipant[], clips: readonly ResolvedTimelineClip[]): VisualSeamIntent | undefined {
  const app = record(config.app);
  const contract = record(app?.visualSeamContract);
  const intents = record(contract?.intents) ?? record(app?.visualSeamIntents);
  const candidate = intents?.[String(frame)] as StoredVisualSeamIntent | undefined;
  if (candidate && typeof candidate === 'object' && candidate.frame === frame
    && candidate.context === intentContext(frame, participants)
    && candidate.participants.every((key) => participants.some((item) => participantKey(item) === key))) {
    if ('canonical' in candidate) {
      const current = portableVisualSeamIntent(config, frame, candidate.kind, true);
      const stored = candidate.canonical;
      if (!stored || stored.contextVersion !== current.contextVersion || stored.frame !== frame || stored.kind !== candidate.kind
        || !sameContext(stored.context, current.context) || !Array.isArray(stored.participants)
        || stored.participants.some(id => !current.participants.includes(id))
        || current.participants.some(id => !stored.participants.includes(id))) return undefined;
    }
    return candidate.kind;
  }
  if (candidate && typeof candidate === 'object' && 'canonical' in candidate) return undefined;
  // A typed transition on a clip is itself an explicit authoring choice. Keep
  // it as a fallback so a persisted scoped declaration can override it.
  const incoming = clips.at(-1);
  if (incoming && Math.round(incoming.at * config.output.fps) === frame
    && transitionFrames(incoming.transition, config.output.fps) !== null) return 'transition';
  return undefined;
}

function intentCovers(intent: VisualSeamIntent | undefined, item: VisualSeamParticipant): boolean {
  if (!intent || item.behavior === 'opaque') return false;
  if (intent === 'hard-cut') return ['enters', 'exits', 'source-change'].includes(item.behavior);
  // Only synchronization grants extra disclosed behavior. A recognized
  // incoming transition owns its own pre-roll, not other authored cues.
  return intent === 'synchronized';
}

function opaqueElement(owner: DisclosedOwner): VisualSeamOpaqueElement {
  const clip = owner.clip as ResolvedTimelineClip;
  const elementRef = record(clip.elementRef);
  const elementId = text(elementRef?.id);
  const elementKind = text(elementRef?.kind);
  const elementRevision = text(elementRef?.revision);
  const packId = text(elementRef?.packId);
  return Object.freeze({
    clipId: owner.clipId,
    clipType: clipType(clip),
    ownerId: owner.ownerId,
    path: Object.freeze([...owner.path]),
    startFrame: owner.startFrame,
    endFrame: owner.endFrame,
    reason: owner.disclosure.opaque.includes('unknown effect timing') ? 'custom-clip-type'
      : elementRef ? 'element-ref'
      : owner.disclosure.opaque.includes('unsupported transition timing') ? 'unsupported-transition' : 'unsupported-timing',
    opaqueReasons: owner.disclosure.opaque,
    ...(elementId && elementKind ? {
      elementRef: Object.freeze({
        id: elementId,
        kind: elementKind,
        ...(elementRevision ? { revision: elementRevision } : {}),
        ...(packId ? { packId } : {}),
      }),
    } : {}),
  });
}

function dedupeParticipants(participants: readonly VisualSeamParticipant[]): VisualSeamParticipant[] {
  const seen = new Set<string>();
  return participants.filter((item) => {
    const key = participantKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function trackMap(config: ResolvedTimelineConfig): Map<string, TrackDefinition> {
  return new Map(config.tracks.map((track) => [track.id, track]));
}

function lowerBoundCue(cues: readonly Cue[], frame: number): number {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (cues[middle]!.frame < frame) low = middle + 1;
    else high = middle;
  }
  return low;
}

function cuesNearFrame(cues: readonly Cue[], frame: number, guardFrames: number): VisualSeamParticipant[] {
  const result: VisualSeamParticipant[] = [];
  const endFrame = frame + guardFrames;
  for (let index = lowerBoundCue(cues, frame - guardFrames); index < cues.length; index += 1) {
    const cue = cues[index]!;
    if (cue.frame > endFrame) break;
    result.push(cue.participant);
  }
  return result;
}

function buildSpans(config: ResolvedTimelineConfig): ClipSpan[] {
  const tracks = trackMap(config);
  const fps = finite(config.output.fps) && config.output.fps > 0 ? config.output.fps : 30;
  return config.clips
    .filter(active)
    .map((clip) => {
      const track = tracks.get(clip.track);
      const startFrame = Math.round(Math.max(0, clip.at) * fps);
      const durationFrames = Math.max(1, Math.round(clipDurationSeconds(clip) * fps));
      return {
        clip: track?.app?.group ? { ...clip, track: visualSeamSourceTrack(track, clip.track) } : clip,
        track,
        startFrame,
        endFrame: startFrame + durationFrames,
        primary: isPrimaryVisualClip(clip, track),
      };
    });
}

/** Compare completed shots on the parent lane, independently of their inner lanes. */
function withOccurrenceSpans(config: ResolvedTimelineConfig, spans: readonly ClipSpan[]): ClipSpan[] {
  const occurrences = new Map<string, ClipSpan>();
  for (const span of spans) {
    const groupId = text(record(span.track?.app?.group)?.id);
    const parentTrack = text(record(span.clip.app?.canonicalTiming)?.occurrenceTrackId);
    if (!groupId || !parentTrack || !span.primary || !coversFrame(span.clip, span.track, config)) continue;
    const previous = occurrences.get(groupId);
    if (previous) {
      occurrences.set(groupId, {
        ...previous,
        startFrame: Math.min(previous.startFrame, span.startFrame),
        endFrame: Math.max(previous.endFrame, span.endFrame),
      });
    } else {
      occurrences.set(groupId, {
        ...span,
        clip: { ...span.clip, track: parentTrack },
        track: { id: parentTrack, kind: 'visual', label: config.tracks.find((track) => track.id === parentTrack)?.label ?? parentTrack },
      });
    }
  }
  return [...spans, ...occurrences.values()];
}

function buildCues(spans: readonly ClipSpan[], owners: readonly DisclosedOwner[]): Cue[] {
  const cues: Cue[] = [];
  for (const span of spans) {
    if (span.track?.kind !== 'visual') continue;
    const clip = span.clip;
    if (span.primary) {
      cues.push({ frame: span.startFrame, participant: participant(clip, 'enters') });
      cues.push({ frame: span.endFrame, participant: participant(clip, 'exits') });
    }
  }
  for (const owner of owners) {
    for (const cue of owner.disclosure.cues) {
      cues.push({frame: cue.frame, participant: {ownerId: owner.ownerId, clipId: owner.clipId,
        path: owner.path, behavior: cue.kind, cue}});
    }
  }
  return cues;
}

function continuityTracksFor(
  spans: readonly ClipSpan[],
  options: VisualSeamAnalysisOptions,
  config: ResolvedTimelineConfig,
): Set<string> {
  if (options.continuityTracks) return new Set(options.continuityTracks);
  const authoredTracks = declaredTrackPolicy(config, 'continuityTracks');
  if (authoredTracks) return authoredTracks;
  const candidateTracks = new Set<string>();
  for (const span of spans) {
    if (span.primary && coversFrame(span.clip, span.track, config)) candidateTracks.add(visualSeamSourceTrack(span.track, span.clip.track));
  }
  return candidateTracks;
}

type VisualGapEdge = Readonly<{
  track: string;
  previousOccurrenceId: string;
  nextOccurrenceId: string;
  startFrame: number;
  endFrame: number;
}>;

function projectedOccurrenceId(id: string): string {
  const separator = id.indexOf(':');
  return separator < 0 ? '' : id.slice(0, separator);
}

function visualGapEdges(config: ResolvedTimelineConfig): VisualGapEdge[] {
  const spans = withOccurrenceSpans(config, buildSpans(config));
  const tracks = continuityTracksFor(spans, {}, config);
  const spansByTrack = new Map<string, ClipSpan[]>();
  for (const span of spans) {
    if (!span.primary || !span.track || !tracks.has(visualSeamSourceTrack(span.track, span.clip.track)) || !coversFrame(span.clip, span.track, config)) continue;
    const current = spansByTrack.get(span.track.id) ?? [];
    current.push(span);
    spansByTrack.set(span.track.id, current);
  }
  const gaps: VisualGapEdge[] = [];
  for (const spans of spansByTrack.values()) {
    spans.sort((left, right) => left.startFrame - right.startFrame || left.clip.id.localeCompare(right.clip.id));
    for (let index = 1; index < spans.length; index += 1) {
      const previous = spans[index - 1]!;
      const next = spans[index]!;
      gaps.push({
        track: visualSeamSourceTrack(next.track, next.clip.track),
        previousOccurrenceId: projectedOccurrenceId(previous.clip.id),
        nextOccurrenceId: projectedOccurrenceId(next.clip.id),
        startFrame: previous.endFrame,
        endFrame: next.startFrame,
      });
    }
  }
  return gaps;
}

/**
 * Move only existing pause declarations whose adjacent canonical clips are
 * stable across a shot edit. This keeps a pause attached to the same cut while
 * its surrounding content edges move, and leaves unrelated/new gaps undeclared.
 */
export function remapDeclaredVisualPauseEdges(
  previousConfig: ResolvedTimelineConfig,
  nextConfig: ResolvedTimelineConfig,
): readonly unknown[] | undefined {
  const nextApp = record(nextConfig.app);
  const nextContract = record(nextApp?.visualSeamContract);
  if (!Array.isArray(nextContract?.gaps)) return undefined;
  const previousGaps = record(record(previousConfig.app)?.visualSeamContract)?.gaps;
  const previousEdges = visualGapEdges(previousConfig);
  const nextEdges = visualGapEdges(nextConfig);
  let changed = false;
  const gaps = nextContract.gaps.flatMap((rawGap) => {
    const gap = record(rawGap);
    if (gap?.kind !== 'pause' || typeof gap.track !== 'string'
      || typeof gap.startFrame !== 'number' || !Number.isInteger(gap.startFrame)
      || typeof gap.endFrame !== 'number' || !Number.isInteger(gap.endFrame)) return [rawGap];
    const prior = Array.isArray(previousGaps)
      ? previousGaps.find((candidate) => {
          const priorGap = record(candidate);
          return priorGap?.kind === 'pause' && priorGap.track === gap.track
            && priorGap.startFrame === gap.startFrame && priorGap.endFrame === gap.endFrame;
        })
      : undefined;
    if (!prior) return [rawGap];
    const priorGap = record(prior)!;
    const anchoredEdge = previousEdges.find((edge) => edge.track === gap.track
      && edge.startFrame === priorGap.startFrame && edge.endFrame === priorGap.endFrame);
    if (!anchoredEdge) return [rawGap];
    const matchingEdges = nextEdges.filter((edge) => edge.track === anchoredEdge.track
      && edge.previousOccurrenceId === anchoredEdge.previousOccurrenceId
      && edge.nextOccurrenceId === anchoredEdge.nextOccurrenceId);
    const movedEdge = matchingEdges.length === 1 ? matchingEdges[0] : undefined;
    if (!movedEdge) return [rawGap];
    if (movedEdge.endFrame <= movedEdge.startFrame) {
      changed = true;
      return [];
    }
    if (movedEdge.startFrame === gap.startFrame && movedEdge.endFrame === gap.endFrame) return [rawGap];
    changed = true;
    return [{...gap, startFrame: movedEdge.startFrame, endFrame: movedEdge.endFrame}];
  });
  return changed ? gaps : nextContract.gaps;
}

export function analyzeVisualSeams(
  config: ResolvedTimelineConfig,
  options: VisualSeamAnalysisOptions = {},
): VisualSeamReport {
  const fps = finite(config.output.fps) && config.output.fps > 0 ? config.output.fps : 30;
  const requestedGuardFrames = finite(options.guardFrames);
  const guardFrames = Math.max(0, Math.floor(requestedGuardFrames ?? 2));
  const localSpans = buildSpans(config);
  const spans = withOccurrenceSpans(config, localSpans);
  const owners = visualSeamOwners(config, true);
  const ownerTracks = trackMap(config);
  const opaqueSpans = owners.filter(o => o.disclosure.opaque.length > 0)
    // Clip-local effects inherit their host clip's coverage. Occurrence-wide
    // effects reuse a child clipId but have independent track/geometry, so
    // classify those disclosed owners directly.
    .filter(o => {
      const host = o.path.includes('clip') ? config.clips.find(clip => clip.id === o.clipId) : undefined;
      return host
        ? coversFrame(host, ownerTracks.get(host.track), config)
        : coversFrame(o.clip as ResolvedTimelineClip, ownerTracks.get(String(o.clip.track ?? '')), config);
    })
    .sort((a, b) => a.startFrame - b.startFrame || a.clipId.localeCompare(b.clipId));
  const cues = buildCues(localSpans, owners).sort((left, right) => left.frame - right.frame);
  const opaqueElements = opaqueSpans.map(opaqueElement);
  const gaps = record(record(config.app)?.visualSeamContract)?.gaps;
  const continuityTracks = continuityTracksFor(spans, options, config);
  const candidates: BoundaryCandidate[] = [];
  const structuralIssues: string[] = [];
  const spansByTrack = new Map<string, ClipSpan[]>();
  for (const span of spans) {
    if (!span.primary || !continuityTracks.has(visualSeamSourceTrack(span.track, span.clip.track)) || !coversFrame(span.clip, span.track, config)) continue;
    const current = spansByTrack.get(span.track?.id ?? span.clip.track) ?? [];
    current.push(span);
    spansByTrack.set(span.track?.id ?? span.clip.track, current);
  }

  for (const [trackId, trackSpans] of spansByTrack) {
    trackSpans.sort((left, right) => left.startFrame - right.startFrame || left.clip.id.localeCompare(right.clip.id));
    for (let index = 1; index < trackSpans.length; index += 1) {
      const previous = trackSpans[index - 1]!;
      const next = trackSpans[index]!;
      const frame = next.startFrame;
      const delta = next.startFrame - previous.endFrame;
      // Every undeclared gap or overlap is structural regardless of the cue
      // guard. Explicit pause metadata is the only gap exemption.
      const gapDeclared = pauseCovers(gaps, visualSeamSourceTrack(next.track, trackId), previous.endFrame, next.startFrame);
      const transitionDuration = transitionFrames(next.clip.transition, fps);
      const transitionDeclared = delta < 0 && transitionDuration !== null && -delta <= transitionDuration
        && transitionDuration <= Math.min(previous.endFrame - previous.startFrame, next.endFrame - next.startFrame);
      const issues = delta !== 0 && !(delta > 0 && gapDeclared) && !(delta < 0 && transitionDeclared)
        ? [formatVisualSeamFinding(next.startFrame, fps, delta < 0 ? 'overlap' : 'gap', next.track?.label ?? 'Picture', [clipLabel(previous.clip), clipLabel(next.clip)])]
        : [];
      structuralIssues.push(...issues);
      const nearby = cuesNearFrame(cues, frame, guardFrames);
      const sourceChanged = previous.clip.asset !== next.clip.asset;
      const participants = dedupeParticipants([
        ...nearby,
        ...(sourceChanged ? [participant(next.clip, 'source-change')] : []),
      ]);
      const intent = explicitIntentAt(config, frame, participants, [previous.clip, next.clip]);
      candidates.push(Object.freeze({
        frame,
        ...(intent ? { intent } : {}),
        participants,
        structuralIssues: issues,
      }));
    }
  }

  candidates.sort((left, right) => left.frame - right.frame);
  const boundaries: VisualSeamBoundary[] = [];
  let nextOpaqueIndex = 0;
  let activeOpaque: typeof opaqueSpans = [];
  for (const candidate of candidates) {
    while (nextOpaqueIndex < opaqueSpans.length
      && opaqueSpans[nextOpaqueIndex]!.startFrame <= candidate.frame) {
      activeOpaque.push(opaqueSpans[nextOpaqueIndex]!);
      nextOpaqueIndex += 1;
    }
    activeOpaque = activeOpaque.filter(owner => owner.endFrame > candidate.frame);
    const participants = dedupeParticipants([
      ...candidate.participants,
      ...activeOpaque.map(owner => ({ownerId: owner.ownerId, clipId: owner.clipId, path: owner.path, behavior: 'opaque' as const})),
    ]);
    const knownRisk = participants.some(item => item.cue !== undefined);
    const uncoveredKnownRisk = participants.some((item) => (
      item.cue !== undefined
      && !intentCovers(candidate.intent, item)
    ));
    const opaqueRisk = participants.some((item) => item.behavior === 'opaque');
    boundaries.push(Object.freeze({
      frame: candidate.frame,
      timeSeconds: candidate.frame / fps,
      ...(candidate.intent ? { intent: candidate.intent } : {}),
      participants,
      structuralIssues: candidate.structuralIssues,
      unacknowledgedRisk: opaqueRisk || uncoveredKnownRisk,
      requiresIntent: knownRisk && uncoveredKnownRisk,
    }));
  }

  const warningCount = boundaries.filter((boundary) => boundary.unacknowledgedRisk).length;
  const blocked = structuralIssues.length > 0 || (options.enforceIntent === true && boundaries.some((boundary) => boundary.requiresIntent));
  return Object.freeze({
    version: VISUAL_SEAM_CONTRACT_VERSION,
    fps,
    guardFrames,
    boundaries: Object.freeze(boundaries.sort((left, right) => left.frame - right.frame)),
    opaqueElements: Object.freeze(opaqueElements),
    structuralIssues: Object.freeze(structuralIssues),
    cues: Object.freeze(owners.flatMap(o => o.disclosure.cues).sort((a, b) => a.frame - b.frame)),
    warningCount,
    blocked,
  });
}

export function assertVisualSeamAdmission(
  config: ResolvedTimelineConfig,
  options: VisualSeamAnalysisOptions = {},
): VisualSeamReport {
  const report = analyzeVisualSeams(config, options);
  if (report.blocked) {
    const firstIssue = report.structuralIssues[0]
      ?? `boundary at frame ${report.boundaries.find((boundary) => boundary.unacknowledgedRisk)?.frame ?? 'unknown'} has undeclared visual cues`;
    throw new VisualSeamAdmissionError(`Visual seam admission blocked: ${firstIssue}`, report);
  }
  return report;
}

export function withVisualSeamIntent(
  config: ResolvedTimelineConfig,
  frame: number,
  intent: VisualSeamIntent,
): ResolvedTimelineConfig {
  if (!Number.isInteger(frame) || frame < 0) throw new Error('visual seam intent frame must be a non-negative integer');
  // Authoring resolves source metadata once; subsequent analysis stays registry-free.
  config = {...config, clips: config.clips.map(clip => clip.asset && !clip.assetEntry
    ? {...clip, assetEntry: config.registry[clip.asset]} : clip)};
  const app = record(config.app) ?? {};
  const contract = record(app.visualSeamContract) ?? {};
  const intents = record(contract.intents) ?? {};
  const report = analyzeVisualSeams(config);
  const boundary = report.boundaries.find((item) => item.frame === frame);
  const participants = boundary?.participants ?? [];
  const scopedParticipants = intent === 'hard-cut'
    ? participants.filter((item) => item.behavior === 'enters' || item.behavior === 'exits' || item.behavior === 'source-change')
    : participants.filter((item) => item.behavior !== 'opaque');
  const keys = scopedParticipants.map(participantKey).sort();
  return {
    ...config,
    app: {
      ...app,
      visualSeamContract: {
        ...contract,
        version: VISUAL_SEAM_CONTRACT_VERSION,
        mode: 'enforced',
        intents: {
          ...intents,
          [String(frame)]: {
            kind: intent,
            frame,
            participants: keys,
            context: intentContext(frame, participants),
            canonical: portableVisualSeamIntent(config, frame, intent),
          } satisfies StoredVisualSeamIntent,
        },
      },
    },
  };
}

export function withVisualSeamPause(config: ResolvedTimelineConfig, track: string, startFrame: number, endFrame: number): ResolvedTimelineConfig {
  if (!config.tracks.some(t => visualSeamSourceTrack(t) === track && t.kind === 'visual')
    || !Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
    throw new Error('visual pause must name a picture track and a positive frame interval');
  }
  const app = record(config.app) ?? {};
  const contract = record(app.visualSeamContract) ?? {};
  const gaps = Array.isArray(contract.gaps) ? contract.gaps : [];
  return {...config, app: {...app, visualSeamContract: {...contract,
    gaps: [...gaps, {kind: 'pause', track, startFrame, endFrame}]}}};
}
