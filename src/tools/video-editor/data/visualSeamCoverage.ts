import type {ResolvedTimelineClip, ResolvedTimelineConfig, TrackDefinition} from '@/tools/video-editor/types/index.ts';

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim().length > 0 ? value : undefined;
const clipType = (clip: ResolvedTimelineClip): string => text(clip.clipType) ?? 'media';

export function visualSeamSourceTrack(track: TrackDefinition | undefined, fallback = ''): string {
  return text(record(track?.app?.group)?.sourceTrack) ?? track?.id ?? fallback;
}

function declaredPictureTracks(config: ResolvedTimelineConfig): Set<string> {
  const value = record(record(config.app)?.visualSeamContract)?.pictureTracks;
  return new Set(Array.isArray(value) ? value.filter((track): track is string => typeof track === 'string') : []);
}
const MEDIA_CLIP_TYPES = new Set(['media', 'video', 'image']);

/**
 * True only when the data says the clip covers the whole frame opaquely: a
 * picture clip (media with an asset, or any clip on a declared picture track)
 * with no sub-frame geometry and full opacity. Custom elements of unknown
 * geometry require the explicit picture-track opt-in.
 */
export function coversFrame(clip: ResolvedTimelineClip, track: TrackDefinition | undefined, config: ResolvedTimelineConfig): boolean {
  if (track?.kind !== 'visual' || track.role === 'source') return false;
  if (!declaredPictureTracks(config).has(visualSeamSourceTrack(track))
    && !(MEDIA_CLIP_TYPES.has(clipType(clip)) && text(clip.asset))) return false;
  if ((finite(clip.opacity) ?? 1) < 1 || (finite(track.opacity) ?? 1) < 1) return false;
  const [outW, outH] = String(config.output.resolution).split('x').map(Number);
  const full = (value: unknown, size: number | undefined) => {
    const n = finite(value);
    return n === undefined || !size || n >= size;
  };
  return full(clip.width, outW) && full(clip.height, outH);
}
