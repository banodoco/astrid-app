import type {ResolvedTimelineClip, ResolvedTimelineConfig} from '@/tools/video-editor/types/index.ts';
import {boundaryReport, type BoundaryDisclosure} from '../../../../vendor/astrid-browser/astrid/packs/local/rendering/elements/boundary';
import {cueIdentity, intentContext, relevantIntentOwners, opaqueActivationCues, type IntentOwner, type SeamIntent} from '../../../../vendor/astrid-browser/astrid/packs/local/rendering/elements/seam-intent';
import {timelineClipDurationMs} from './shotCompositionTiming.ts';
import {coversFrame, visualSeamSourceTrack} from './visualSeamCoverage.ts';

type Json = Record<string, unknown>;
const record = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const number = (v: unknown, fallback = 0): number => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
export type DisclosedOwner = IntentOwner & {lane?: string; clipId: string; ownerId: string; primary: boolean; disclosure: BoundaryDisclosure};
const NON_PICTURE = new Set(['effect-layer', 'frame-overlay', 'end-spanning-layer', 'text', 'audio']);

/** Closed metadata adapter shared by normal preflight and portable authoring.
 * Normal analysis uses resolved source metadata only and never reads registry. */
export function visualSeamOwners(config: ResolvedTimelineConfig, metadataOnly = false): DisclosedOwner[] {
  const fps = config.output.fps;
  const tracks = new Map(config.tracks.map(t => [t.id, t]));
  const owners: DisclosedOwner[] = [];
  const timelineEffects = new Set<string>();
  const add = (clip: Json, path: string[], clipId: string, ownerId: string, startFrame: number, endFrame: number,
    originFrame: number, source: string | null, sourceType: string, primary = false) => {
    owners.push({path, clip, clipId, ownerId, startFrame, endFrame, originFrame, source, primary,
      disclosure: boundaryReport({clip, fps, startFrame, endFrame, originFrame, path, source, sourceType})});
  };
  let extent = 1;
  for (const clip of config.clips) {
    if (clip.enabled === false || clip.active === false || clip.disabled === true || clip.hidden === true || clip.deleted === true) continue;
    const authored = record(clip);
    const canonical = record(clip.app?.canonical);
    const occurrence = typeof canonical.occurrenceId === 'string' ? canonical.occurrenceId : undefined;
    const id = typeof canonical.sourceClipId === 'string' ? canonical.sourceClipId
      : occurrence && clip.id.startsWith(`${occurrence}:`) ? clip.id.slice(occurrence.length + 1) : clip.id;
    const path = occurrence ? ['parent', String(canonical.parentDocumentId ?? 'timeline'), 'occurrence', occurrence, 'clip', id]
      : ['parent', 'timeline', 'clip', id];
    const at = authored.at_ms === undefined ? clip.at : number(authored.at_ms) / 1000;
    const start = Math.round(at * fps);
    const end = start + Math.max(1, Math.round(timelineClipDurationMs(clip) / 1000 * fps));
    extent = Math.max(extent, end / fps);
    const entry = record(clip.assetEntry ?? (!metadataOnly && clip.asset ? config.registry[clip.asset] : undefined));
    const source = ['content_sha256', 'object_id', 'media_id', 'digest', 'file'].map(k => entry[k]).find(v => typeof v === 'string');
    const binding = typeof source === 'string' ? source : null;
    const sourceType = String(entry.type ?? '');
    const scope = record(clip.app?.canonicalEffects);
    const local = Array.isArray(clip.effects) ? clip.effects.slice(0, number(scope.localCount, clip.effects.length)) : [];
    const track = tracks.get(clip.track);
    const sourceTrack = visualSeamSourceTrack(track, clip.track);
    const normalized = {...authored, track: sourceTrack, clipType: clip.clipType ?? 'media', at, speed: number(clip.speed, 1),
      ...(Array.isArray(scope.timeline) ? {effects: local} : {})};
    const elementKind = record(clip.elementRef).kind;
    // Runtime picture_clip (240d5bb): on a visual, non-source track (checked below) any clip type is picture except the auxiliary ones.
    const isPicture = !NON_PICTURE.has(normalized.clipType);
    add(normalized, path, clip.id, occurrence ?? clip.id, start, end, start, binding, sourceType,
      track?.kind === 'visual' && track.role !== 'source' && isPicture
        && !['effect', 'animation', 'transition'].includes(String(elementKind)));
    if (track?.app?.group) owners[owners.length - 1].lane = clip.track;
    local.forEach((raw, index) => {
      const effect = record(raw);
      const effectId = String(effect.id ?? index);
      add({...effect, id: effectId, clipType: effect.type ?? 'unknown', at, hold: (end - start) / fps,
        track: sourceTrack, params: effect.params ?? effect}, [...path, 'effect', effectId], clip.id, occurrence ?? clip.id,
      start, end, start, binding, sourceType);
    });
    if (Array.isArray(scope.timeline) && occurrence) {
      const timing = record(clip.app?.canonicalTiming);
      const offset = number(timing.occurrenceStartMs) / 1000;
      const upper = Math.round((offset + number(timing.occurrenceDurationMs) / 1000) * fps);
      scope.timeline.forEach((raw, index) => {
        const effect = record(raw);
        const effectId = String(effect.id ?? index);
        const key = JSON.stringify([occurrence, effectId]);
        if (timelineEffects.has(key)) return;
        timelineEffects.add(key);
        const at = offset + number(effect.at);
        const origin = Math.round(at * fps);
        const end = Math.min(upper, origin + Math.max(1, Math.round(number(effect.hold, upper / fps - offset) * fps)));
        add({...effect, id: effectId, clipType: effect.type ?? 'unknown', at,
          hold: effect.hold ?? upper / fps - offset, speed: 1, track: effect.track ?? 'fx'},
        path.slice(0, 4).concat('effect', effectId), clip.id, occurrence, Math.max(Math.round(offset * fps), origin), end, origin, null, '');
      });
    }
  }
  if (Array.isArray(config.effects)) config.effects.forEach((raw, index) => {
    const effect = record(raw);
    const id = String(effect.id ?? index);
    const at = number(effect.at);
    const start = Math.round(at * fps);
    const end = start + Math.max(1, Math.round(number(effect.hold, extent) / number(effect.speed, 1) * fps));
    add({...effect, id, clipType: effect.type ?? 'unknown', at, hold: effect.hold ?? extent, speed: number(effect.speed, 1), track: effect.track ?? 'fx'},
      ['parent', 'timeline', 'effect', id], id, id, start, end, start, null, '');
  });
  const frames = new Set<number>();
  const seenTracks = new Set<string>();
  for (const o of owners.filter(o => o.primary).sort((a, b) => a.startFrame - b.startFrame)) {
    const track = String(o.clip.track);
    if (seenTracks.has(track)) frames.add(o.startFrame);
    seenTracks.add(track);
  }
  for (const cue of opaqueActivationCues(owners, frames)) {
    owners.find(o => o.path === cue.path)!.disclosure.cues.push(cue);
  }
  // The persisted portable intent and diagnostic analysis must see the same
  // cues: an opaque overlay's start is not a picture-change risk.
  for (const owner of owners) {
    // Clip-local effects intentionally inherit their host clip's coverage, as
    // Runtime discloses them on the host span. Occurrence-wide effects reuse
    // that host clipId but have independent track/geometry and must classify
    // their own owner instead.
    const host = owner.path.includes('clip')
      ? config.clips.find(clip => clip.id === owner.clipId)
      : undefined;
    const ownerCoversFrame = host
      ? coversFrame(host, tracks.get(host.track), config)
      : coversFrame(owner.clip as ResolvedTimelineClip, tracks.get(String(owner.clip.track ?? '')), config);
    if (owner.disclosure.opaque.length > 0 && !ownerCoversFrame) {
      owner.disclosure = {...owner.disclosure, cues: owner.disclosure.cues.filter(cue => cue.kind !== 'activation')};
    }
  }
  return owners;
}

/** Select the same adjacent/furthest picture owners as Runtime. */
function boundaryOwners(owners: readonly DisclosedOwner[], frame: number): DisclosedOwner[] {
  const groups = new Map<string, DisclosedOwner[]>();
  for (const o of owners.filter(o => o.primary)) {
    const key = o.lane ?? String(o.clip.track);
    const group = groups.get(key) ?? [];
    group.push(o); groups.set(key, group);
  }
  const selected = new Set<DisclosedOwner>();
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
    let furthest: DisclosedOwner | undefined;
    for (const row of rows) {
      if (furthest && row.startFrame === frame) { selected.add(furthest); selected.add(row); }
      if (!furthest || row.endFrame > furthest.endFrame) furthest = row;
    }
  }
  return [...selected];
}

/** Runtime independently recomputes witnesses from the pinned closure. */
export function portableVisualSeamIntent(config: ResolvedTimelineConfig, frame: number, kind: SeamIntent['kind'], metadataOnly = false): SeamIntent {
  const owners = visualSeamOwners(config, metadataOnly);
  const nearby = owners.flatMap(o => o.disclosure.cues).filter(c => Math.abs(c.frame - frame) <= 2);
  const relevant = relevantIntentOwners(owners, boundaryOwners(owners, frame), nearby);
  return {contextVersion: 'visual-seam/v1', kind, frame,
    participants: kind === 'synchronized' ? nearby.map(cueIdentity).sort() : [],
    context: intentContext(config.output.fps, frame, relevant)};
}
