import type { TrackDefinition } from '@/tools/video-editor/types/index.ts';

export type VisualTrackGroup = { id?: string; tracks: TrackDefinition[] };

/** Preserve paint order; only contiguous tracks with the same group share a stack. */
export function partitionTrackGroups(tracks: readonly TrackDefinition[]): VisualTrackGroup[] {
  const groups: VisualTrackGroup[] = [];
  for (const track of tracks) {
    const group = track.app?.group as { id?: unknown } | undefined;
    const id = typeof group?.id === 'string' && group.id.length > 0 ? group.id : undefined;
    const previous = groups[groups.length - 1];
    if (id && previous?.id === id) previous.tracks.push(track);
    else groups.push({ id, tracks: [track] });
  }
  return groups;
}
