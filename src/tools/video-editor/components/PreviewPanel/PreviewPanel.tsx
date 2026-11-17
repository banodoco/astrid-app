import { memo, type ReactNode } from 'react';
import { EDITOR_TOUR_ANCHORS, EDITOR_TOUR_ANCHOR_ATTRIBUTE } from '@/tools/video-editor/tour/anchors.ts';
import { shallow } from 'zustand/shallow';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import OverlayEditor from '@/tools/video-editor/components/PreviewPanel/OverlayEditor.tsx';
import type { VideoEditorPreviewSurface } from '@/tools/video-editor/components/PreviewPanel/useVideoEditorPreviewSurface.tsx';
import {
  useTimelineDataSelector,
  useTimelineOpsSelector,
  useTimelinePlaybackSelector,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { useRenderDiagnostic } from '@/tools/video-editor/hooks/usePerfDiagnostics.ts';
import { isTouchTimelineInput } from '@/tools/video-editor/lib/mobile-interaction-model.ts';
import { useRenderBudget } from '@/shared/dev/useRenderBudget.ts';
import { userClearAllSelection, userSelectTimelineClip } from '@/shared/state/selectionStore.ts';

export interface PreviewPanelProps {
  surface: VideoEditorPreviewSurface;
  overlay?: ReactNode;
  footer?: ReactNode;
  showOverlayEditor?: boolean;
  panelClassName?: string;
  surfaceClassName?: string;
}

function PreviewPanelComponent({
  surface,
  overlay,
  footer,
  showOverlayEditor = true,
  panelClassName,
  surfaceClassName,
}: PreviewPanelProps) {
  useRenderBudget('PreviewPanel', 5);
  useRenderDiagnostic('PreviewPanel');
  const {
    data,
    resolvedConfig,
    trackScaleMap,
    compositionSize,
    selectedClipId,
    deviceClass,
    inputModality,
    interactionMode,
    gestureOwner,
  } = useTimelineDataSelector((timeline) => ({
    data: timeline.data,
    resolvedConfig: timeline.resolvedConfig,
    trackScaleMap: timeline.trackScaleMap,
    compositionSize: timeline.compositionSize,
    selectedClipId: timeline.selectedClipId,
    deviceClass: timeline.deviceClass,
    inputModality: timeline.inputModality,
    interactionMode: timeline.interactionMode,
    gestureOwner: timeline.gestureOwner,
  }), shallow);
  const {
    onOverlayChange,
    onDoubleClickAsset,
    setInputModalityFromPointerType,
    setGestureOwner,
    setContextTarget,
    setInspectorTarget,
  } = useTimelineOpsSelector((ops) => ({
    onOverlayChange: ops.onOverlayChange,
    onDoubleClickAsset: ops.onDoubleClickAsset,
    setInputModalityFromPointerType: ops.setInputModalityFromPointerType,
    setGestureOwner: ops.setGestureOwner,
    setContextTarget: ops.setContextTarget,
    setInspectorTarget: ops.setInspectorTarget,
  }), shallow);
  const {
    playerContainerRef,
    currentTime,
  } = useTimelinePlaybackSelector((playback) => ({
    playerContainerRef: playback.playerContainerRef,
    currentTime: playback.currentTime,
  }), shallow);

  if (!data || !resolvedConfig || !surface.hasConfig) {
    // The card's paper is there from the shell's first frame, so nothing pops in when the timeline
    // arrives. The surface slot stays behind the gate so the preview portal mounts exactly as before.
    return (
      <div
        className={cn(
          'flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card/95',
          panelClassName,
        )}
        role="region"
        aria-label="Preview panel"
        {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.preview }}
        aria-busy="true"
      />
    );
  }

  const interactionStateLabel = gestureOwner === 'preview'
    ? 'Preview overlay transform active.'
    : (isTouchTimelineInput(deviceClass, inputModality)
        ? 'Touch preview uses inspector-first overlay editing.'
        : 'Preview overlay transforms are available in the preview.');

  return (
    <>
      <div
        className={cn(
          'flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card/95',
          panelClassName,
        )}
        role="region"
        aria-label="Preview panel"
        {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.preview }}
      >
        <div className="relative flex min-h-0 flex-1">
          <div
            className={cn(
              // group/preview: the pointer anywhere over the picture, its overlays or its header brings up the player's controls.
              'group/preview relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-transparent',
              surfaceClassName,
            )}
            style={{ touchAction: gestureOwner === 'preview' ? 'none' : 'manipulation' }}
            onPointerDownCapture={(event) => {
              const target = event.target;
              if (!(target instanceof Element)) {
                return;
              }

              if (target.closest("[data-overlay-hit='true'], [data-inline-text-editor='true']")) {
                return;
              }

              setInputModalityFromPointerType(event.pointerType);
              if (gestureOwner !== 'none' && gestureOwner !== 'preview') {
                return;
              }

              setContextTarget({ kind: 'preview' });
              setInspectorTarget({ kind: 'preview' });
              if (gestureOwner === 'preview') {
                setGestureOwner('none');
              }
              userClearAllSelection();
            }}
          >
            <div className="sr-only" aria-live="polite" aria-atomic="true">
              {interactionStateLabel}
              {' '}
              Mode {interactionMode}.
            </div>
            <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex flex-col gap-1" data-testid="preview-status-strip">
            {data.migrationIssues?.some(issue => issue.details?.kind === 'canvas' || issue.details?.kind === 'explicit-fit' || issue.details?.kind === 'scale-bake') && (() => {
              const findings = data.migrationIssues!.filter(issue => issue.details?.kind === 'canvas' || issue.details?.kind === 'explicit-fit' || issue.details?.kind === 'scale-bake');
              const clips = new Set(findings.map(issue => issue.clipId).filter(Boolean)).size;
              const canvas = findings.find(issue => issue.details?.kind === 'canvas');
              return <div className="rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground" role="status" title={JSON.stringify(findings)}>
                {clips > 0 ? `Preview uses legacy framing for ${clips} ${clips === 1 ? 'clip' : 'clips'}. ` : ''}
                {canvas ? (canvas.details?.source === 'app-resolved'
                  ? `Canvas is not stated on this timeline; using ${data.output.resolution.replace('x', ' × ')} from the ${data.config?.theme !== undefined || data.config?.theme_overrides !== undefined ? 'editor theme' : 'editor default'}. It has not been written.`
                  : `Canvas is not stated in timeline output; using ${data.output.resolution.replace('x', ' × ')} from timeline settings. It has not been written to output.`) : ''}
              </div>;
            })()}
            {surface.placementFindings?.some(finding => finding.scope === 'child' && (finding.kind === 'canvas' || finding.kind === 'explicit-fit' || finding.kind === 'scale-bake')) && (() => {
              const findings = surface.placementFindings!.filter(finding => finding.scope === 'child' && (finding.kind === 'canvas' || finding.kind === 'explicit-fit' || finding.kind === 'scale-bake'));
              const occurrences = new Set(findings.map(finding => finding.occurrenceId)).size;
              return <div className="rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground" role="status" title={JSON.stringify(findings)}>{`Preview uses legacy framing in ${occurrences} ${occurrences === 1 ? 'shot' : 'shots'}.`}</div>;
            })()}
            </div>
            {overlay}
            <div
              ref={surface.slotRef}
              className="flex h-full w-full min-h-0 items-center justify-center"
              data-testid="video-editor-preview-surface"
              data-current-time={currentTime}
            />
            {showOverlayEditor ? (
              <OverlayEditor
                rows={data.rows}
                meta={data.meta}
                registry={resolvedConfig.registry}
                currentTime={currentTime}
                playerContainerRef={playerContainerRef}
                trackScaleMap={trackScaleMap}
                tracks={resolvedConfig.tracks}
                compositionWidth={compositionSize.width}
                compositionHeight={compositionSize.height}
                selectedClipId={selectedClipId}
                deviceClass={deviceClass}
                inputModality={inputModality}
                interactionMode={interactionMode}
                gestureOwner={gestureOwner}
                onSelectClip={(clipId) => {
                  if (clipId === null) {
                    userClearAllSelection();
                    return;
                  }
                  userSelectTimelineClip(clipId, { additive: false });
                }}
                onOverlayChange={onOverlayChange}
                setInputModalityFromPointerType={setInputModalityFromPointerType}
                setGestureOwner={setGestureOwner}
                setContextTarget={setContextTarget}
                setInspectorTarget={setInspectorTarget}
                onDoubleClickAsset={onDoubleClickAsset}
              />
            ) : null}
          </div>
        </div>
        {footer ? <div className="border-t border-border px-3 py-2">{footer}</div> : null}
      </div>
      {surface.portal}
    </>
  );
}

export const PreviewPanel = memo(PreviewPanelComponent);
