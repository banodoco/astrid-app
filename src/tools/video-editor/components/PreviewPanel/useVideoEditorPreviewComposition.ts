import { useMemo } from 'react';
import { useOptionalVideoEditorRuntime } from '../../contexts/VideoEditorRuntimeContext.tsx';
import { resolveCanonicalComposition } from '../../data/canonicalCompositionState.ts';
import type { ResolvedTimelineConfig } from '../../types/index.ts';

/** Both the stage and panel stills include in-progress edits inside placed shots. */
export function useVideoEditorPreviewComposition(resolvedConfig: ResolvedTimelineConfig | null | undefined) {
  const runtime = useOptionalVideoEditorRuntime();
  const hasShotClips = Boolean(resolvedConfig?.clips?.some((clip) => clip.clipType === 'shot'));
  const composition = runtime?.userId === null
    ? runtime.shots?.canonicalDraft?.composition ?? runtime.shots?.canonicalComposition
    : null;
  return useMemo(() => resolveCanonicalComposition({
    userId: runtime?.userId,
    hasShotClips,
    hasShotComposition: Boolean(runtime?.shots?.shotComposition),
    composition,
    compositionError: runtime?.userId === null ? runtime.shots?.canonicalCompositionError : null,
    baseConfig: resolvedConfig,
  }), [hasShotClips, composition, resolvedConfig, runtime?.shots?.canonicalCompositionError,
    runtime?.shots?.shotComposition, runtime?.userId]);
}
