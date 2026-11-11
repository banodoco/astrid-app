import manifest from './asset-manifest.json';

/** Immutable public files; no runtime connection or generation credentials are required. */
export const EDITOR_TOUR_ASSET_BASE_URL = `${import.meta.env.BASE_URL}astrid/onboarding/lantern-valley-14s-v1/`;
export const EDITOR_TOUR_ASSET_MANIFEST = manifest;

export function tourSaveData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

export interface EditorTourMediaSlot {
  /** The original file: what the demo timeline's asset registry names. */
  url: string;
  width: number;
  height: number;
  durationSeconds?: number;
  previewDurationSeconds?: number;
  mediaType?: string;
  sha256?: string;
  /** The same picture at source size as a small WebP (an image's own picture, a video's first frame). Show this, not `url`. */
  displayUrl?: string;
  /** A 320 px WebP of the same picture, for anything drawn small (clip thumbnails, card visuals, gallery tiles). */
  thumbUrl?: string;
  /**
   * Videos only: H.264 Main renditions with no audio track and the index first, for a plain muted `<video>`.
   * `small` is 540p (phones); `large` keeps the source size. Both are the 14 s the timeline shows.
   */
  playback?: { readonly small: string; readonly large: string };
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

type AssetName = keyof typeof manifest.assets;
const derived = (name: AssetName): string => editorTourAssetUrl(manifest.assets[name].filename);

function slot(name: Exclude<AssetName, 'world'>, extra: Partial<EditorTourMediaSlot> = {}): EditorTourMediaSlot {
  const asset = manifest.assets[name];
  return Object.freeze({ ...asset, url: editorTourAssetUrl(asset.filename), ...extra });
}

const still = (n: 1 | 2 | 3 | 4) => slot(`still${n}`, { displayUrl: derived(`still${n}Display`), thumbUrl: derived(`still${n}Thumb`) });
const frame1 = { displayUrl: derived('frame1Display'), thumbUrl: derived('frame1Thumb') };

export const EDITOR_TOUR_MEDIA: EditorTourMedia = Object.freeze({
  frames: [slot('frame1', frame1), slot('frame4')] as const,
  stills: [still(1), still(2), still(3), still(4)] as const,
  video: slot('video', {
    previewDurationSeconds: manifest.durationSeconds,
    displayUrl: derived('videoPoster'), thumbUrl: derived('videoThumb'),
    playback: { small: derived('video540'), large: derived('video768') },
  }),
  // The guide's first frame is the first source capture.
  guide: slot('guide', { ...frame1, playback: { small: derived('guide540'), large: derived('guide720') } }),
});

/** The file a tour `<video>` plays: the 540p rendition on a phone or when the browser asks to save data. */
export function tourPlaybackUrl(media: EditorTourMediaSlot, small: boolean): string {
  return (small ? media.playback?.small : media.playback?.large) ?? media.url;
}
