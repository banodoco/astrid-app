import { getEffectiveClipVolume } from '@/tools/video-editor/lib/clip-volume.ts';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FC, type ReactNode } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useDelayRender, useRemotionEnvironment, useVideoConfig } from 'remotion';
import { ReadinessImage } from '@astrid/packs/rendering/shared/readiness-image';
import { ReadinessVideo } from './ReadinessVideo.tsx';
import {
  getClipDurationInFrames,
  getSanitizedMediaSrc,
  getSanitizedMediaTrimProps,
  getSanitizedPlaybackRate,
  getSanitizedVolume,
} from '@/tools/video-editor/lib/config-utils.ts';
import { wrapWithClipEffects } from '@/tools/video-editor/effects/index.tsx';
import { ClipTransition, clipSequenceTiming } from './ClipTransition.tsx';
import {
  useOptionalEffectRegistryContext,
  type EffectRegistrySnapshot,
} from '@/tools/video-editor/effects/registry/index.ts';
import { useOptionalPreviewMediaFailure } from '@/tools/video-editor/compositions/PreviewMediaFailureContext.tsx';
import { intrinsicMediaSize, resolveClipPlacement } from '@banodoco/timeline-composition';
import type { ResolvedTimelineClip, TrackDefinition } from '@/tools/video-editor/types/index.ts';
import { getTimelineClipShader } from '@/tools/video-editor/lib/timeline-domain.ts';
import { PendingMaterialPlaceholder } from '@/tools/video-editor/components/PendingMaterialPlaceholder.tsx';
import type { CapabilityFinding, RenderMaterialRef } from '@astrid/editor-sdk';
import type { RenderPlannerMaterialStatus } from '@/tools/video-editor/runtime/renderPlanner.ts';
import { ClipShaderPreviewCanvas } from '@/tools/video-editor/shaders/preview/ClipShaderPreviewCanvas.tsx';
import {
  useOptionalShaderEffectRegistryContext,
  type ShaderEffectRegistrySnapshot,
} from '@/tools/video-editor/shaders/registry/index.ts';
import { mediaCrossOrigin } from '@/shared/lib/media/mediaCrossOrigin';

// inline missing-asset placeholder body. Mirrors the
// styling of UnknownClipPlaceholder so the two loud cases look like a pair.
// Lives inline (not a shared component) because VisualClip already wraps
// content in a Sequence/AbsoluteFill upstream — we only need the visible
// label here.
const MissingAssetBody: FC<{ clipId: string; clipType: string }> = ({ clipId, clipType }) => (
  <AbsoluteFill
    data-testid="missing-asset-placeholder"
    data-clip-id={clipId}
    data-clip-type={clipType}
    style={{
      backgroundColor: '#5B0000',
      borderTop: '2px solid #FF5252',
      borderBottom: '2px solid #FF5252',
      color: '#FFCDD2',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '12px 24px',
      textAlign: 'center',
      fontFamily:
        'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.4,
      letterSpacing: '0.04em',
    }}
  >
    <div
      style={{
        maxWidth: '80%',
        padding: '8px 16px',
        borderRadius: 4,
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      {`clipType '${clipType}' missing asset — clip will not appear in render`}
    </div>
  </AbsoluteFill>
);



const UnsupportedAssetBody: FC<{ clipId: string; clipType: string; assetType?: string }> = ({ clipId, clipType, assetType }) => (
  <AbsoluteFill
    data-testid="unsupported-asset-placeholder"
    data-clip-id={clipId}
    data-clip-type={clipType}
    data-asset-type={assetType}
    style={{
      backgroundColor: '#332600',
      borderTop: '2px solid #FBBF24',
      borderBottom: '2px solid #FBBF24',
      color: '#FEF3C7',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '12px 24px',
      textAlign: 'center',
      fontFamily:
        'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.4,
      letterSpacing: '0.04em',
    }}
  >
    <div
      style={{
        maxWidth: '80%',
        padding: '8px 16px',
        borderRadius: 4,
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      {`clipType '${clipType}' references unsupported asset type '${assetType ?? 'unknown'}' — clip will not appear in render`}
    </div>
  </AbsoluteFill>
);

const UnsupportedClipShaderExportBody: FC<{ clipId: string; shaderId: string }> = ({ clipId, shaderId }) => (
  <AbsoluteFill
    data-testid="unsupported-clip-shader-export"
    data-clip-id={clipId}
    data-shader-id={shaderId}
    style={{
      backgroundColor: 'rgba(20, 20, 20, 0.72)',
      borderTop: '2px solid #38BDF8',
      borderBottom: '2px solid #38BDF8',
      color: '#E0F2FE',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '12px 24px',
      textAlign: 'center',
      fontFamily:
        'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.4,
    }}
  >
    <div
      style={{
        maxWidth: '80%',
        padding: '8px 16px',
        borderRadius: 4,
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      {`shader '${shaderId}' is browser-preview only — export requires a shader materializer that produces RenderMaterial`}
    </div>
  </AbsoluteFill>
);

type VisualClipProps = {
  clip: ResolvedTimelineClip;
  track: TrackDefinition;
  fps: number;
  predecessor?: ResolvedTimelineClip | null;
  effectRegistrySnapshot?: EffectRegistrySnapshot;
  shaderRegistrySnapshot?: ShaderEffectRegistrySnapshot;
  materialRefs?: readonly RenderMaterialRef[];
  materialStatuses?: readonly RenderPlannerMaterialStatus[];
  materialDiagnostics?: readonly CapabilityFinding[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const IntrinsicSizeDelay: FC<{
  source: string;
  mediaType: string;
  result: { source: string; type: string; size: { width: number; height: number } | null; failed: boolean } | null;
}> = ({ source, mediaType, result }) => {
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const pendingHandle = useRef<number | null>(null);
  useLayoutEffect(() => {
    pendingHandle.current = delayRender(`Intrinsic dimensions for ${source}`);
    return () => {
      const handle = pendingHandle.current;
      pendingHandle.current = null;
      if (handle !== null) continueRender(handle);
    };
  }, [source, mediaType, delayRender, continueRender]);
  useLayoutEffect(() => {
    if (result?.source !== source || result.type !== mediaType || pendingHandle.current === null) return;
    const handle = pendingHandle.current;
    pendingHandle.current = null;
    if (result.failed) {
      try {
        cancelRender(new Error(`Could not load intrinsic dimensions for ${source}`));
      } catch {
        // Remotion may throw the cancellation through React after recording it.
      }
    }
    else if (result.size) continueRender(handle);
  }, [source, mediaType, result, continueRender, cancelRender]);
  return null;
};

function materialRefsForClip(
  clip: ResolvedTimelineClip,
  materialRefs: readonly RenderMaterialRef[] | undefined,
): readonly RenderMaterialRef[] {
  if (materialRefs && materialRefs.length > 0) return materialRefs;
  const app = isRecord(clip.app) ? clip.app : undefined;
  const refs = app?.materialRefs ?? clip.params?.materialRefs;
  return Array.isArray(refs) ? refs.filter(isRecord) as unknown as readonly RenderMaterialRef[] : [];
}

function statusForMaterial(material: RenderMaterialRef, statuses: readonly RenderPlannerMaterialStatus[] | undefined): RenderPlannerMaterialStatus {
  return statuses?.find((status) => status.materialRefId === material.id)
    ?? {
      materialRefId: material.id,
      state: material.determinism === 'deterministic' ? 'resolved' : 'pending',
      detail: material.determinism === 'deterministic' ? undefined : { phase: 'queued' },
    };
}

function shouldRenderMaterialPlaceholder(status: RenderPlannerMaterialStatus): boolean {
  return status.state === 'missing' || status.state === 'pending' || status.state === 'stale' || status.state === 'failed';
}

const VisualAsset: FC<VisualClipProps & { isRendering: boolean }> = ({ clip, track, fps, isRendering }) => {
  const { width: compositionWidth, height: compositionHeight } = useVideoConfig();
  const previewMediaFailure = useOptionalPreviewMediaFailure();
  const [probeResult, setProbeResult] = useState<{source: string; type: string; size: {width: number; height: number} | null; failed: boolean} | null>(null);
  const declaredSize = intrinsicMediaSize(clip.assetEntry);
  const resolution = clip.assetEntry?.resolution;
  const source = clip.assetEntry?.src;
  const type = clip.assetEntry?.type;
  const supportedType = type?.startsWith('image') ? 'image' : type?.startsWith('video') ? 'video' : null;
  const needsProbe = Boolean(source && supportedType && typeof document !== 'undefined' && !(Number.isFinite(declaredSize.width) && Number.isFinite(declaredSize.height)));

  useEffect(() => {
    if (!needsProbe || !source || typeof document === 'undefined') return;
    let active = true;
    const finish = (result: {size: {width: number; height: number} | null; failed: boolean}) => {
      if (!active) return;
      setProbeResult({source, type: type ?? '', ...result});
    };
    const media = document.createElement(type?.startsWith('image') ? 'img' : 'video');
    const loaded = () => {
      const width = media instanceof HTMLImageElement ? media.naturalWidth : media.videoWidth;
      const height = media instanceof HTMLImageElement ? media.naturalHeight : media.videoHeight;
      if (width > 0 && height > 0) finish({size: {width, height}, failed: false});
      else {
        finish({size: null, failed: true});
      }
    };
    const failed = () => {
      finish({size: null, failed: true});
    };
    media.addEventListener('error', failed);
    media.addEventListener(type?.startsWith('image') ? 'load' : 'loadedmetadata', loaded);
    media.src = source;
    return () => {
      active = false;
      media.removeEventListener('error', failed);
      media.removeEventListener(type?.startsWith('image') ? 'load' : 'loadedmetadata', loaded);
      media.removeAttribute('src');
    };
  }, [source, type, resolution, declaredSize.width, declaredSize.height, needsProbe]);
  // Never silent-null when a built-in clip is missing its asset.
  // Render a labeled red band so the gap is obvious in preview/export.
  if (!clip.assetEntry) {
    return <MissingAssetBody clipId={clip.id} clipType={clip.clipType ?? 'media'} />;
  }

  const mediaSrc = getSanitizedMediaSrc(clip.assetEntry.src);
  if (!mediaSrc) {
    return <MissingAssetBody clipId={clip.id} clipType={clip.clipType ?? 'media'} />;
  }

  const clipVolume = getEffectiveClipVolume(clip);
  const effectiveVolume = track.muted ? 0 : getSanitizedVolume(track.volume) * clipVolume;
  const playbackRate = getSanitizedPlaybackRate(clip.speed);
  const trimProps = getSanitizedMediaTrimProps(clip, fps);
  const retryToken = previewMediaFailure?.enabled
    ? previewMediaFailure.retryTokenFor(clip.id, mediaSrc)
    : 0;
  const posterUrl = clip.assetEntry.thumbnailUrl ?? null;
  const mediaFailure = previewMediaFailure?.enabled
      ? {
        onError: () => {
          previewMediaFailure.reportFailure({clipId: clip.id, source: mediaSrc, posterUrl}, retryToken);
          return 'fallback' as const;
        },
        onVideoFrame: retryToken > 0
          ? () => previewMediaFailure.markFrameReady(clip.id, mediaSrc, retryToken)
          : undefined,
        onLoadedData: retryToken > 0
          ? () => previewMediaFailure.markFrameReady(clip.id, mediaSrc, retryToken)
          : undefined,
        fallback: (style: CSSProperties) => (
          <ClipFailurePoster posterUrl={posterUrl} style={style} />
        ),
      }
    : null;
  const isImage = clip.assetEntry.type?.startsWith('image');
  const isVideo = clip.assetEntry.type?.startsWith('video');
  if (!isImage && !isVideo) {
    return (
      <UnsupportedAssetBody
        clipId={clip.id}
        clipType={clip.clipType ?? 'media'}
        assetType={clip.assetEntry.type}
      />
    );
  }
  const currentProbe = probeResult?.source === source && probeResult.type === (type ?? '') ? probeResult : null;
  const size = Number.isFinite(declaredSize.width) && Number.isFinite(declaredSize.height) ? declaredSize : currentProbe?.size;
  const delayProbe = isRendering && needsProbe && source && supportedType && type
    ? <IntrinsicSizeDelay source={source} mediaType={type} result={probeResult} />
    : null;
  if (!size && currentProbe?.failed) return <>{delayProbe}<div role="alert" data-testid="preview-media-error">{`Clip '${clip.id}' asset '${clip.asset ?? clip.assetEntry.file ?? mediaSrc}' could not load intrinsic dimensions`}</div></>;
  if (!size) return delayProbe;
  const placement = resolveClipPlacement({clip, track, canvas: {width: compositionWidth, height: compositionHeight}, intrinsic: size});
  const renderBounds = placement.local.clip;
  const mediaBounds = placement.local.media;
  if (renderBounds.width <= 0 || renderBounds.height <= 0) return null;

  const viewportStyle: CSSProperties = {
    position: 'absolute',
    left: renderBounds.x,
    top: renderBounds.y,
    width: renderBounds.width,
    height: renderBounds.height,
    overflow: 'hidden',
    opacity: clip.opacity ?? 1,
  };
  const mediaStyle: CSSProperties = {
    position: 'absolute',
    left: (mediaBounds.x - renderBounds.x),
    top: (mediaBounds.y - renderBounds.y),
    width: mediaBounds.width,
    height: mediaBounds.height,
    // Override Tailwind preflight's `img { max-width: 100%; height: auto; }`
    // which would squash the media to fit the viewport container. The media
    // must overflow the container (clipped by overflow:hidden) for the
    // manual cover layout to work correctly.
    maxWidth: 'none',
    maxHeight: 'none',
    mixBlendMode: track.blendMode && track.blendMode !== 'normal' ? track.blendMode : undefined,
  };

  if (isImage) {
    return (
      <>
      {delayProbe}
      <div style={viewportStyle}>
        <ReadinessImage src={mediaSrc} mediaId={clip.id} style={mediaStyle} crossOrigin="anonymous" />
      </div>
      </>
    );
  }

  return (
    <>
    {delayProbe}
    <div style={viewportStyle}>
      <ReadinessVideo
        clipId={clip.id}
        resetKey={`${clip.id}:${mediaSrc}:${trimProps.trimBefore}:${trimProps.trimAfter ?? 'none'}:${playbackRate}:${effectiveVolume}:viewport:${retryToken}`}
        fallback={mediaFailure?.fallback({position: 'absolute', inset: 0}) ?? null}
        onError={mediaFailure?.onError}
        src={mediaSrc}
        trimBefore={trimProps.trimBefore}
        trimAfter={trimProps.trimAfter}
        playbackRate={playbackRate}
        volume={effectiveVolume}
        muted={effectiveVolume <= 0}
        style={mediaStyle}
        data-astrid-retry-token={String(retryToken)}
        onVideoFrame={mediaFailure?.onVideoFrame}
        onLoadedData={mediaFailure?.onLoadedData}
      />
    </div>
    </>
  );
};

const ClipFailurePoster: FC<{posterUrl: string | null; style: CSSProperties}> = ({posterUrl, style}) => {
  const [posterFailed, setPosterFailed] = useState(false);
  return (
    <div
      data-astrid-preview-failed-poster="true"
      style={{
        ...style,
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        background: '#fffefa',
      }}
    >
      {posterUrl && !posterFailed && (
        <img
          src={posterUrl}
          crossOrigin={mediaCrossOrigin(posterUrl)}
          alt=""
          onError={() => setPosterFailed(true)}
          style={{width: '100%', height: '100%', objectFit: 'contain'}}
        />
      )}
    </div>
  );
};

export const VisualClip: FC<VisualClipProps> = ({
  clip,
  track,
  fps,
  effectRegistrySnapshot,
  shaderRegistrySnapshot,
  materialRefs,
  materialStatuses,
  materialDiagnostics,
}) => {
  const environment = useRemotionEnvironment();
  const providerRegistryContext = useOptionalEffectRegistryContext();
  const registrySnapshot = effectRegistrySnapshot ?? providerRegistryContext?.snapshot;
  const providerShaderRegistryContext = useOptionalShaderEffectRegistryContext();
  const shaderSnapshot = shaderRegistrySnapshot ?? providerShaderRegistryContext?.snapshot;
  const { width: compositionWidth, height: compositionHeight } = useVideoConfig();


  if (clip.clipType === 'effect-layer') {
    return null;
  }

  const pendingMaterial = materialRefsForClip(clip, materialRefs)
    .map((material) => ({ material, status: statusForMaterial(material, materialStatuses) }))
    .find(({ status }) => shouldRenderMaterialPlaceholder(status));

  if (pendingMaterial) {
    return (
      <PendingMaterialPlaceholder
        clipId={clip.id}
        material={pendingMaterial.material}
        status={pendingMaterial.status}
        diagnostics={materialDiagnostics?.filter((diagnostic) =>
          diagnostic.materialRefId === pendingMaterial.material.id || diagnostic.clipId === clip.id)}
      />
    );
  }

  const durationInFrames = getClipDurationInFrames(clip, fps);
  const frame = useCurrentFrame();
  const shader = getTimelineClipShader(clip);
  const shaderRecord = shader
    ? shaderSnapshot?.get(shader.shaderId, shader.extensionId)
    : undefined;
  const renderBrowserShaderPreview = Boolean(
    shader
    && shader.enabled !== false
    && shaderRecord
    && !environment.isRendering
    && !environment.isClientSideRendering,
  );
  const renderUnsupportedShaderExport = Boolean(
    shader
    && shader.enabled !== false
    && (environment.isRendering || environment.isClientSideRendering),
  );

  const content: ReactNode = (
    <ClipTransition clip={clip} fps={fps}>
      <VisualAsset clip={clip} track={track} fps={fps} isRendering={environment.isRendering || environment.isClientSideRendering} />
      {renderUnsupportedShaderExport && shader ? (
        <UnsupportedClipShaderExportBody clipId={clip.id} shaderId={shader.shaderId} />
      ) : null}
      {renderBrowserShaderPreview && shader && shaderRecord ? (
        <ClipShaderPreviewCanvas
          shader={shader}
          record={shaderRecord}
          timeSeconds={frame / fps}
          frame={frame}
          width={compositionWidth}
          height={compositionHeight}
          testId="visual-clip-shader-preview"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </ClipTransition>
  );

  return <>{wrapWithClipEffects(content, clip, durationInFrames, fps, registrySnapshot)}</>;
};

const LazyGuard: FC<{ durationInFrames: number; children: ReactNode }> = ({ durationInFrames, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bufferFrames = Math.max(1, Math.round(fps));

  if (frame < -bufferFrames || frame > durationInFrames + bufferFrames) {
    return null;
  }

  return <>{children}</>;
};

export const VisualClipSequence: FC<VisualClipProps> = ({
  clip,
  track,
  fps,
  predecessor,
  effectRegistrySnapshot,
  shaderRegistrySnapshot,
  materialRefs,
  materialStatuses,
  materialDiagnostics,
}) => {
  const { from, effectiveDuration } = clipSequenceTiming(clip, fps, predecessor);

  return (
    <Sequence
      key={clip.id}
      from={from}
      durationInFrames={effectiveDuration}
      premountFor={fps}
    >
      <LazyGuard durationInFrames={effectiveDuration}>
        <VisualClip
          clip={clip}
          track={track}
          fps={fps}
          predecessor={predecessor}
          effectRegistrySnapshot={effectRegistrySnapshot}
          shaderRegistrySnapshot={shaderRegistrySnapshot}
          materialRefs={materialRefs}
          materialStatuses={materialStatuses}
          materialDiagnostics={materialDiagnostics}
        />
      </LazyGuard>
    </Sequence>
  );
};
