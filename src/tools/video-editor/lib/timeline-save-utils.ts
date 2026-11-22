import { assembleTimelineData, materializeAuthoredOutput, type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { canonicalizeTimelinePair } from '@/tools/video-editor/lib/timeline-domain.ts';
import type {
  AssetRegistry,
  ResolvedAssetRegistryEntry,
  TimelineConfig,
} from '@/tools/video-editor/types/index.ts';
import {
  buildAssetReferenceMap,
  getAssetImmediateSource,
} from '@/tools/video-editor/lib/asset-registry.ts';

export function shouldAcceptPolledData(
  editSeq: number,
  savedSeq: number,
  pendingOps: number,
  polledStableSig: string,
  lastSavedStableSig: string,
): boolean {
  if (savedSeq < editSeq) {
    return false;
  }

  if (pendingOps > 0) {
    return false;
  }

  return polledStableSig !== lastSavedStableSig;
}

export function buildDataFromCurrentRegistry(
  config: TimelineConfig,
  current: TimelineData,
  overrides?: {
    registry?: AssetRegistry;
    resolvedRegistry?: Record<string, ResolvedAssetRegistryEntry>;
    sourceItemsBySchemaRef?: TimelineData['sourceItemsBySchemaRef'];
    transcriptReferences?: TimelineData['transcriptReferences'];
  },
): TimelineData {
  const registry = overrides?.registry ?? current.registry;
  const resolvedRegistry = overrides?.resolvedRegistry ?? current.resolvedConfig.registry;
  const canonical = canonicalizeTimelinePair(materializeAuthoredOutput(config), registry);
  const canonicalConfig = canonical.config;

  const resolvedConfig = {
    ...canonicalConfig,
    output: { ...canonicalConfig.output },
    tracks: canonicalConfig.tracks ?? [],
    clips: canonicalConfig.clips.map((clip) => ({
      ...clip,
      assetEntry: clip.asset ? resolvedRegistry[clip.asset] : undefined,
    })),
    registry: resolvedRegistry,
    ...(canonicalConfig.theme !== undefined ? { theme: canonicalConfig.theme } : {}),
    ...(canonicalConfig.theme_overrides !== undefined ? { theme_overrides: canonicalConfig.theme_overrides } : {}),
    ...(canonicalConfig.generation_defaults !== undefined ? { generation_defaults: canonicalConfig.generation_defaults } : {}),
  };

  return assembleTimelineData({
    config: canonicalConfig,
    configVersion: current.configVersion,
    head: current.head,
    registry,
    resolvedConfig,
    assetMap: buildAssetReferenceMap(registry),
    output: { ...canonicalConfig.output },
    sourceItemsBySchemaRef: overrides?.sourceItemsBySchemaRef ?? current.sourceItemsBySchemaRef,
    transcriptReferences: overrides?.transcriptReferences ?? current.transcriptReferences,
  });
}

export function buildDataFromSnapshot(
  config: TimelineConfig,
  registry: AssetRegistry,
  current: TimelineData,
  sourceItemsBySchemaRef = current.sourceItemsBySchemaRef,
): TimelineData {
  const canonical = canonicalizeTimelinePair(materializeAuthoredOutput(config), registry);
  const canonicalConfig = canonical.config;

  const snapshotResolvedRegistry: Record<string, ResolvedAssetRegistryEntry> = Object.fromEntries(
    Object.entries(registry.assets ?? {}).flatMap(([assetId, entry]) => {
      const src = getAssetImmediateSource(entry);
      return src ? [[assetId, { ...entry, src }] as const] : [];
    }),
  );
  const mergedResolvedRegistry = {
    ...snapshotResolvedRegistry,
    ...current.resolvedConfig.registry,
  };
  const resolvedConfig = {
    ...canonicalConfig,
    output: { ...canonicalConfig.output },
    tracks: canonicalConfig.tracks ?? [],
    clips: canonicalConfig.clips.map((clip) => ({
      ...clip,
      assetEntry: clip.asset ? mergedResolvedRegistry[clip.asset] : undefined,
    })),
    registry: mergedResolvedRegistry,
    ...(canonicalConfig.theme !== undefined ? { theme: canonicalConfig.theme } : {}),
    ...(canonicalConfig.theme_overrides !== undefined ? { theme_overrides: canonicalConfig.theme_overrides } : {}),
    ...(canonicalConfig.generation_defaults !== undefined ? { generation_defaults: canonicalConfig.generation_defaults } : {}),
  };

  return assembleTimelineData({
    config: canonicalConfig,
    configVersion: current.configVersion,
    head: current.head,
    registry,
    resolvedConfig,
    assetMap: buildAssetReferenceMap(registry),
    output: { ...canonicalConfig.output },
    sourceItemsBySchemaRef: current.transcriptReferences ? {
      ...sourceItemsBySchemaRef,
      'astrid.transcript_segment/v1': [
        ...(sourceItemsBySchemaRef?.['astrid.transcript_segment/v1'] ?? []).filter(i => !current.transcriptReferences!.associations.some(r => r.assetId === i.sourceArtifactRef.assetId)),
        ...(current.sourceItemsBySchemaRef?.['astrid.transcript_segment/v1'] ?? []).filter(i => current.transcriptReferences!.associations.some(r => r.assetId === i.sourceArtifactRef.assetId)),
      ],
    } : sourceItemsBySchemaRef,
    transcriptReferences: current.transcriptReferences,
  });
}
