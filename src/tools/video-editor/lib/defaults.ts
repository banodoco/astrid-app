import {newTrackPlacementMarkers} from '@/tools/video-editor/lib/placement-markers.ts';
import { normalizeClipPlacementWithFindings, type PlacementMigrationFinding } from '@banodoco/timeline-composition';
import type { TimelineConfig, TrackDefinition } from '@/tools/video-editor/types/index.ts';
import { resolveTimelineRenderTheme } from '@/tools/video-editor/compositions/installed-themes.ts';

export const DEFAULT_VIDEO_TRACKS: TrackDefinition[] = [
  {
    id: 'V1',
    kind: 'visual',
    label: 'V1',
    scale: 1,
    fit: 'contain',
    opacity: 1,
    blendMode: 'normal',
    app: newTrackPlacementMarkers(),
  },
  {
    id: 'A1',
    kind: 'audio',
    label: 'A1',
    scale: 1,
    fit: 'contain',
    opacity: 1,
    blendMode: 'normal',
    app: newTrackPlacementMarkers(),
  },
];

export const DEFAULT_OUTPUT = {
  resolution: '1280x720',
  fps: 30,
  file: 'output.mp4',
  background: null as string | null,
  background_scale: null as number | null,
} as const;

export function createDefaultTimelineConfig(): TimelineConfig {
  // `theme`, `theme_overrides`, and `generation_defaults` are intentionally left absent here.
  // New timelines start with no theme bound (the editor renders without a theme registry).
  // They are populated once the user picks a theme.
  // Keeping them undefined preserves byte-equivalence for every existing
  // call site that snapshots a freshly-created config.
  return {
    output: { ...DEFAULT_OUTPUT },
    clips: [],
    tracks: DEFAULT_VIDEO_TRACKS.map((track) => ({ ...track, app: newTrackPlacementMarkers() })),
  };
}

/**
 * Fill missing or incomplete output fields on a timeline config while
 * preserving all existing values and non-output fields (clips, tracks,
 * theme, theme_overrides, generation_defaults, pinnedShotGroups, app, etc.).
 *
 * Only absent or null-ish output fields are filled. Existing output values —
 * even empty strings or zero — are left untouched because they represent
 * explicit user choices.
 *
 * Geometry precedence (mirrors Astrid's render contract — Remotion
 * `getCanvas` in Root.tsx and the ffmpeg `_timeline_canvas` both prefer
 * `theme_overrides.visual.canvas`, then the resolved theme canvas, then a
 * hardcoded default):
 *   1. explicit `output.resolution` / `output.fps` (persisted)
 *   2. `theme_overrides.visual.canvas` (per-timeline declared geometry)
 *   3. the installed theme's `visual.canvas` (via `resolveTimelineRenderTheme`)
 *   4. `DEFAULT_OUTPUT` (1280x720@30) — unchanged for timelines that declare
 *      no geometry, preserving current editor behavior byte-for-byte.
 * The resolved theme canvas is consulted ONLY when the config binds a theme
 * (slug or overrides); otherwise nothing changes.
 */
export function withDefaultTimelineOutput(
  input: Partial<TimelineConfig> & { output?: Partial<TimelineConfig['output']> },
  onMigration?: (findings: PlacementMigrationFinding[]) => void,
): TimelineConfig {
  let config = input;
  const existingOutput = config.output ?? ({} as Partial<TimelineConfig['output']>);

  const themeBound = config.theme !== undefined || config.theme_overrides !== undefined;
  const themeCanvas = themeBound ? resolveTimelineRenderTheme(config as TimelineConfig).visual?.canvas : undefined;
  const canvasResolution = (
    themeCanvas
    && typeof themeCanvas.width === 'number'
    && typeof themeCanvas.height === 'number'
  ) ? `${themeCanvas.width}x${themeCanvas.height}` : undefined;
  const canvasFps = (
    themeCanvas
    && typeof themeCanvas.fps === 'number'
  ) ? themeCanvas.fps : undefined;

  let output: TimelineConfig['output'] = {
    resolution: existingOutput.resolution ?? canvasResolution ?? DEFAULT_OUTPUT.resolution,
    fps: existingOutput.fps ?? canvasFps ?? DEFAULT_OUTPUT.fps,
    file: existingOutput.file ?? DEFAULT_OUTPUT.file,
    background: existingOutput.background !== undefined ? existingOutput.background : DEFAULT_OUTPUT.background,
    background_scale:
      existingOutput.background_scale !== undefined ? existingOutput.background_scale : DEFAULT_OUTPUT.background_scale,
  };

  // The package materializes an authored canvas, or the exact canvas this
  // editor historically resolved for a standalone media timeline.
  if (config.output?.resolution === undefined) {
    const tracks = new Map((config.tracks ?? []).map(track => [track.id, track]));
    const hasVisualMedia = (config.clips ?? []).some(clip => clip.asset
      && tracks.get(clip.track)?.kind !== 'audio'
      && (!clip.clipType || ['media', 'image', 'video', 'hold'].includes(clip.clipType)));
    if (hasVisualMedia || config.theme_overrides?.visual?.canvas !== undefined) {
      const [width, height] = output.resolution.split('x').map(Number);
      const result = normalizeClipPlacementWithFindings(
        {...config, clips: config.clips ?? [], tracks: config.tracks ?? []} as unknown as Parameters<typeof normalizeClipPlacementWithFindings>[0],
        hasVisualMedia ? {legacyCanvas: {width, height, fps: output.fps, source: 'app-resolved'}} : undefined,
      );
      config = result.config as unknown as typeof config;
      if (input.tracks === undefined) config = {...config, tracks: undefined};
      output = {...output, ...config.output};
      onMigration?.(result.findings);
    }
  }

  return {
    output,
    clips: config.clips ?? [],
    tracks: config.tracks ?? DEFAULT_VIDEO_TRACKS.map(({app: _newTrackMarkers, ...track}) => ({...track})),
    ...('theme' in config ? { theme: config.theme } : {}),
    ...('theme_overrides' in config ? { theme_overrides: config.theme_overrides } : {}),
    ...('generation_defaults' in config ? { generation_defaults: config.generation_defaults } : {}),
    ...('pinnedShotGroups' in config ? { pinnedShotGroups: config.pinnedShotGroups } : {}),
    ...('app' in config ? { app: config.app } : {}),
  };
}
