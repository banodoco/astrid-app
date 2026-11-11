import manifest from './asset-manifest.json';

/** Immutable public files; no runtime connection or generation credentials are required. */
export const EDITOR_TOUR_ASSET_BASE_URL = `${import.meta.env.BASE_URL}astrid/onboarding/lantern-valley-14s-v1/`;
export const EDITOR_TOUR_ASSET_MANIFEST = manifest;

export function tourSaveData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

export interface EditorTourMediaSlot {
  url: string;
  width: number;
  height: number;
  durationSeconds?: number;
  previewDurationSeconds?: number;
  mediaType?: string;
  sha256?: string;
}

export interface EditorTourMedia {
  /** Matching first and last captures from the Three.js guide. */
  frames: readonly [EditorTourMediaSlot, EditorTourMediaSlot];
  /** Four Qwen reference frames at 0, 6.5, 10 and 13 seconds. */
  stills: readonly [EditorTourMediaSlot, EditorTourMediaSlot, EditorTourMediaSlot, EditorTourMediaSlot];
  /** Native H3 source; the timeline trims it to the 14-second guide. */
  video: EditorTourMediaSlot;
  /** The Three.js motion guide render: step 1's clip, an ordinary media clip. */
  guide: EditorTourMediaSlot;
}

export function editorTourAssetUrl(filename: string): string {
  return `${EDITOR_TOUR_ASSET_BASE_URL}${filename}`;
}

function slot(name: Exclude<keyof typeof manifest.assets, 'world'>): EditorTourMediaSlot {
  const asset = manifest.assets[name];
  return Object.freeze({ ...asset, url: editorTourAssetUrl(asset.filename) });
}

export const EDITOR_TOUR_MEDIA: EditorTourMedia = Object.freeze({
  frames: [slot('frame1'), slot('frame4')] as const,
  stills: [slot('still1'), slot('still2'), slot('still3'), slot('still4')] as const,
  video: { ...slot('video'), previewDurationSeconds: manifest.durationSeconds },
  guide: slot('guide'),
});
