import type { PreparedShotComposition } from './shotCompositionAdapter.ts';
import { projectCanonicalComposition, type ShotPlacementFinding } from './shotCompositionProjection.ts';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types/index.ts';

export type CanonicalCompositionResolution = Readonly<{
  source: 'legacy' | 'canonical';
  status: 'ready' | 'loading' | 'error';
  config: ResolvedTimelineConfig | null;
  error: Error | null;
  placementFindings?: readonly ShotPlacementFinding[];
}>;

/**
 * Decide once whether a document is a normal timeline or a Runtime shot
 * composition, and project the canonical graph only after it is ready. Preview
 * and export must share this decision so they cannot silently render different
 * inputs for the same document.
 */
export function resolveCanonicalComposition({
  userId,
  hasShotClips,
  hasShotComposition,
  composition,
  compositionError,
  baseConfig,
}: {
  userId: string | null | undefined;
  hasShotClips: boolean;
  hasShotComposition: boolean;
  composition: PreparedShotComposition | null | undefined;
  compositionError: Error | null | undefined;
  baseConfig: ResolvedTimelineConfig | null | undefined;
}): CanonicalCompositionResolution {
  // A prepared graph is authoritative even when the legacy parent has no
  // shot shells at all. Shells are only useful while deciding whether a graph
  // is expected but has not arrived yet.
  const canonicalLane = userId === null
    && hasShotComposition
    && (hasShotClips || Boolean(composition));
  if (!canonicalLane) {
    return {
      source: 'legacy',
      status: 'ready',
      config: baseConfig ?? null,
      error: null,
    };
  }

  if (!composition) {
    return {
      source: 'canonical',
      status: compositionError ? 'error' : 'loading',
      config: null,
      error: compositionError ?? null,
    };
  }

  try {
    const projection = projectCanonicalComposition(composition, baseConfig);
    return {
      source: 'canonical',
      status: 'ready',
      config: projection.config,
      error: null,
      placementFindings: projection.placementFindings,
    };
  } catch (error) {
    return {
      source: 'canonical',
      status: 'error',
      config: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
