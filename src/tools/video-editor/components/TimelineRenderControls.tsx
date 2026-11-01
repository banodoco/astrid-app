import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Download, Loader2, Play, Square, X } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { COARSE_TOUCH_TARGET } from '@/shared/components/ui/contracts/touchTarget.ts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog.tsx';
import { toast } from '@/shared/components/ui/toast.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/components/ui/tooltip.tsx';
import { useTimelineChromeContext } from '@/tools/video-editor/hooks/timelineStore.ts';
import { mediaCrossOrigin } from '@/shared/lib/media/mediaCrossOrigin';
import { downloadRenderedFile } from '@/tools/video-editor/lib/render-download.ts';
import type { VisualSeamReport } from '@/tools/video-editor/data/visualSeamContract.ts';
import { EditorErrorMessage } from './EditorErrorMessage.tsx';

function diagnosticRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function diagnosticText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasVisualSeamFindings(report: VisualSeamReport | null | undefined): report is VisualSeamReport {
  return Boolean(report && (
    report.warningCount > 0
    || report.boundaries.some((boundary) => boundary.unacknowledgedRisk || boundary.structuralIssues.length > 0)
    || report.structuralIssues.length > 0
    || report.opaqueElements.length > 0
  ));
}

type RenderSaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{ createWritable: () => Promise<WritableStream> }>;
};

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function formatTimecode(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  return `${minutes}:${((tenths - minutes * 600) / 10).toFixed(1).padStart(4, '0')}`;
}

function VisualBoundaryReport({ report, canDeclareSeamsAsHardCuts, declareSeamsAsHardCuts, canAcknowledgeVisualCues, acknowledgeVisualCuesAsSynchronized }: {
  report: VisualSeamReport;
  canDeclareSeamsAsHardCuts?: boolean;
  declareSeamsAsHardCuts?: () => Promise<void>;
  canAcknowledgeVisualCues?: boolean;
  acknowledgeVisualCuesAsSynchronized?: () => Promise<void>;
}) {
  return (
    <section className="mt-2 space-y-2 border-t border-current/15 pt-2" aria-label="Visual seam admission report">
      <p className="font-medium text-zinc-100">Visual boundary report</p>
      {report.structuralIssues.map((issue) => (
        <p key={issue} className="text-red-300">{issue}</p>
      ))}
      {report.boundaries.filter((boundary) => boundary.unacknowledgedRisk).map((boundary) => (
        <p key={boundary.frame} className="text-zinc-200">
          {formatTimecode(boundary.timeSeconds)} · Possible visual change at this cut
        </p>
      ))}
      <details className="text-zinc-400">
        <summary className="cursor-pointer">Technical details</summary>
        {report.boundaries.filter((boundary) => boundary.unacknowledgedRisk).map((boundary) => (
          <div key={boundary.frame} className="mt-1">
            <p>Frame {boundary.frame} · {boundary.participants.map((participant) => participant.cue?.kind ?? participant.behavior).join(', ') || 'Boundary'}</p>
            {boundary.participants.map((participant) => (
              <p key={`${participant.ownerId}:${participant.path.join('/')}:${participant.behavior}:${participant.cue?.kind ?? ''}:${participant.cue?.id ?? ''}:${participant.cue?.frame ?? ''}`} className="break-all text-zinc-500">
                {participant.path.join(' / ')}
              </p>
            ))}
          </div>
        ))}
        {report.opaqueElements.length > 0 && (
          <p className="mt-1 text-amber-200">
            Full-screen clips with undisclosed timing ({report.opaqueElements.length}): {[...new Set(report.opaqueElements.map((element) => element.clipType))].join(', ')}
          </p>
        )}
      </details>
      {(() => {
        const raw = report.rawDiagnostics;
        const rawBoundaries = Array.isArray(raw?.boundaries) ? raw.boundaries : [];
        const boundaryOpaquePaths = rawBoundaries.flatMap((item) => {
          const paths = diagnosticRecord(item)?.opaquePaths;
          return Array.isArray(paths) ? paths : [];
        });
        const opaquePaths = [...(Array.isArray(raw?.opaquePaths) ? raw.opaquePaths : []), ...boundaryOpaquePaths];
        const rawIssues = Array.isArray(raw?.structuralIssues) ? raw.structuralIssues : [];
        return (
          <>
            {opaquePaths.length > 0 && (
              <div className="text-amber-200">
                Opaque owner paths ({opaquePaths.length}):
                {opaquePaths.slice(0, 12).map((path, index) => (
                  <p key={`${diagnosticText(path)}:${index}`} className="break-all text-zinc-400">{Array.isArray(path) ? path.join(' / ') : diagnosticText(path)}</p>
                ))}
                {opaquePaths.length > 12 && <p className="text-zinc-500">And {opaquePaths.length - 12} more. Expand Runtime details for the full report.</p>}
              </div>
            )}
            {(rawIssues.length > 0 || opaquePaths.length > 0) && (
              <details className="text-zinc-400">
                <summary className="cursor-pointer">Runtime diagnostic details</summary>
                <pre className="mt-1 whitespace-pre-wrap break-all">{diagnosticText({structuralIssues: rawIssues, opaquePaths})}</pre>
              </details>
            )}
          </>
        );
      })()}
      {canDeclareSeamsAsHardCuts && declareSeamsAsHardCuts && (
        <Button type="button" size="sm" variant="outline" onClick={() => void declareSeamsAsHardCuts()}>
          Declare flagged boundaries as hard cuts
        </Button>
      )}
      {canAcknowledgeVisualCues && acknowledgeVisualCuesAsSynchronized && (
        <Button type="button" size="sm" variant="outline" onClick={() => void acknowledgeVisualCuesAsSynchronized()}>
          Acknowledge listed cues as synchronized
        </Button>
      )}
    </section>
  );
}

/** Render button, render blocker message, and cancellation control. */
export function TimelineRenderControls({
  previewActionButtonClass,
  afterRenderControl,
  compact = false,
  iconOnly = false,
}: {
  previewActionButtonClass: string;
  afterRenderControl?: ReactNode;
  /** The phone's row: progress reads as a bare percentage and the secondary buttons keep only their icons. */
  compact?: boolean;
  /** A narrow preview row: Render keeps only its download icon, named and tooltipped as "Render". */
  iconOnly?: boolean;
}) {
  const chrome = useTimelineChromeContext();
  const [playerOpen, setPlayerOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [dismissedRenderError, setDismissedRenderError] = useState<string | null>(null);
  const [dismissedSeamWarning, setDismissedSeamWarning] = useState<VisualSeamReport | null>(null);
  const renderButtonRef = useRef<HTMLButtonElement>(null);
  const renderErrorPanelRef = useRef<HTMLDivElement>(null);
  const renderWarningPanelRef = useRef<HTMLDivElement>(null);
  const { renderResultUrl, renderResultInfo } = chrome;
  const renderError = chrome.renderStatus === 'error' && chrome.renderLog ? chrome.renderLog : null;
  const renderErrorOpen = renderError !== null && dismissedRenderError !== renderError;
  const seamReport = chrome.visualSeamReport;
  const renderWarningOpen = !renderErrorOpen && chrome.renderStatus !== 'error'
    && hasVisualSeamFindings(seamReport) && dismissedSeamWarning !== seamReport;
  const completedAt = renderResultInfo?.completedAt ?? null;
  const seenCompletion = useRef(completedAt);
  // A render that finishes while the editor is open shows the film once;
  // "Play last render" brings it back after closing.
  useEffect(() => {
    if (completedAt !== null && completedAt !== seenCompletion.current && renderResultUrl) {
      setPlayerOpen(true);
    }
    seenCompletion.current = completedAt;
  }, [completedAt, renderResultUrl]);

  useEffect(() => {
    if (renderError === null) setDismissedRenderError(null);
  }, [renderError]);

  useEffect(() => {
    if (!hasVisualSeamFindings(seamReport)) setDismissedSeamWarning(null);
  }, [seamReport]);

  useEffect(() => {
    if ((!renderErrorOpen || renderError === null) && !renderWarningOpen) return;
    const dismiss = () => {
      if (renderErrorOpen && renderError !== null) setDismissedRenderError(renderError);
      if (renderWarningOpen && hasVisualSeamFindings(seamReport)) setDismissedSeamWarning(seamReport);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (renderErrorPanelRef.current?.contains(target)
        || renderWarningPanelRef.current?.contains(target)
        || renderButtonRef.current?.contains(target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [renderError, renderErrorOpen, renderWarningOpen, seamReport]);

  const hasResult = Boolean(renderResultUrl) && chrome.renderStatus !== 'rendering';
  const filename = chrome.renderResultFilename ?? 'timeline-render.mp4';
  const downloadRender = async (saveAs = false) => {
    if (!renderResultUrl || isDownloading) return;
    setIsDownloading(true);
    try {
      const pickerWindow = window as RenderSaveFilePickerWindow;
      const saveFilePicker = pickerWindow.showSaveFilePicker;
      if (saveAs && typeof saveFilePicker === 'function') {
        let fileHandle: Awaited<ReturnType<NonNullable<RenderSaveFilePickerWindow['showSaveFilePicker']>>>;
        try {
          fileHandle = await saveFilePicker.call(pickerWindow, {
            suggestedName: filename,
            types: [{
              description: 'MP4 video',
              accept: { 'video/mp4': ['.mp4'] },
            }],
          });
        } catch (error) {
          if (isAbortError(error)) return;
          throw error;
        }

        const response = await fetch(renderResultUrl, { mode: 'cors' });
        if (!response.ok) {
          toast.error(`Couldn't download the render (HTTP ${response.status})`);
          return;
        }
        if (!response.body) throw new Error('The render response had no body');
        await response.body.pipeTo(await fileHandle.createWritable());
        return;
      }

      if (saveAs) throw new Error('Save as is unavailable in this browser. Use Chrome for large files.');
      await downloadRenderedFile(renderResultUrl, filename);
    } catch (error) {
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Couldn't download the render");
    } finally {
      setIsDownloading(false);
    }
  };
  const summary = renderResultInfo
    ? [
        renderResultInfo.revision !== null ? `Timeline version ${renderResultInfo.revision}` : null,
        new Date(renderResultInfo.completedAt).toLocaleString(),
      ].filter(Boolean).join(' · ')
    : filename;

  const renderButton = (
    <Button
      ref={renderButtonRef}
      type="button"
      size="sm"
      className={`gap-1.5 ${previewActionButtonClass}${iconOnly ? ' aspect-square px-0' : ''}`}
      aria-label={iconOnly ? 'Render' : undefined}
      onClick={() => void chrome.startRender()}
      disabled={chrome.renderStatus === 'rendering'}
    >
      <Download className="h-3.5 w-3.5" />
      {chrome.renderStatus === 'rendering' && chrome.renderProgress
        ? compact || iconOnly ? `${chrome.renderProgress.percent}%` : `Render ${chrome.renderProgress.percent}%`
        : iconOnly ? null : 'Render'}
    </Button>
  );

  return (
    <>
      {iconOnly ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>{renderButton}</TooltipTrigger>
            <TooltipContent>Render</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : renderButton}
      {afterRenderControl}
      {hasResult && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={`gap-1.5 ${previewActionButtonClass}`}
          onClick={() => setPlayerOpen(true)}
          aria-label="Play last render"
          title="Play last render"
        >
          <Play className="h-3 w-3" />
          {!compact && 'Play last render'}
        </Button>
      )}
      {renderResultUrl && (
        <Dialog open={playerOpen} onOpenChange={setPlayerOpen}>
          <DialogContent className="max-w-3xl" data-video-editor-render-player="true">
            <DialogHeader>
              <DialogTitle>Rendered film</DialogTitle>
              <DialogDescription>{summary}</DialogDescription>
            </DialogHeader>
            <video
              key={renderResultUrl}
              src={renderResultUrl}
              crossOrigin={mediaCrossOrigin(renderResultUrl)}
              controls
              // The browser's own download (⋮ menu, right-click Save) fetches without the Origin the
              // Runtime door requires, so it saves an error. Download below is the one way to save.
              controlsList="nodownload"
              onContextMenu={(event) => event.preventDefault()}
              preload="metadata"
              className="max-h-[60dvh] w-full rounded bg-black"
              data-testid="timeline-render-player"
            />
            <p className="text-xs text-muted-foreground">Download appears in your browser’s Downloads. Save as… writes directly to a file for large renders.</p>
            <div className="flex justify-end gap-2">
              {typeof (window as RenderSaveFilePickerWindow).showSaveFilePicker === 'function' && <Button
                type="button" size="sm" variant="outline" disabled={isDownloading}
                onClick={() => void downloadRender(true)}
              >Save as…</Button>}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={`gap-1.5 ${COARSE_TOUCH_TARGET}`}
                onClick={() => void downloadRender()}
                disabled={isDownloading}
              >
                {isDownloading
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Downloading…</>
                  : <><Download className="h-3.5 w-3.5" />Download</>}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {chrome.renderStatus === 'rendering' && chrome.activeRenderTaskId && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={`gap-1.5 ${previewActionButtonClass}`}
          onClick={() => void chrome.cancelRender()}
          aria-label="Cancel render"
          title="Cancel render"
        >
          <Square className="h-3 w-3" />
          {!compact && 'Cancel'}
        </Button>
      )}
      {renderErrorOpen && renderError && (
        <div
          ref={renderErrorPanelRef}
          className="absolute right-0 top-full z-40 mt-1 max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-red-500/30 bg-zinc-950/95 px-3 py-2 text-[11px] text-red-200 shadow-lg backdrop-blur-sm"
          data-video-editor-render-blocker="true"
        >
          <button
            type="button"
            aria-label="Dismiss"
            className="absolute right-2 top-2 rounded p-0.5 text-red-300 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-300"
            onClick={() => setDismissedRenderError(renderError)}
          >
            <X className="h-3 w-3" />
          </button>
          <div className="flex items-start gap-1 pr-5">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <EditorErrorMessage message={renderError} />
          </div>
          {renderError.includes('\n') && (
            <details className="mt-2">
              <summary className="cursor-pointer">Details</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-sans">{renderError}</pre>
            </details>
          )}
          {hasVisualSeamFindings(chrome.visualSeamReport) && (
            <VisualBoundaryReport
              report={chrome.visualSeamReport}
              canDeclareSeamsAsHardCuts={chrome.canDeclareSeamsAsHardCuts}
              declareSeamsAsHardCuts={chrome.declareSeamsAsHardCuts}
              canAcknowledgeVisualCues={chrome.canAcknowledgeVisualCues}
              acknowledgeVisualCuesAsSynchronized={chrome.acknowledgeVisualCuesAsSynchronized}
            />
          )}
        </div>
      )}
      {renderWarningOpen && hasVisualSeamFindings(seamReport) && (
        <div
          ref={renderWarningPanelRef}
          className="absolute right-0 top-full z-40 mt-1 max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-amber-500/30 bg-zinc-950/95 px-3 py-2 text-[11px] text-amber-100 shadow-lg backdrop-blur-sm"
          data-video-editor-render-warning="true"
        >
          <button
            type="button"
            aria-label="Dismiss"
            className="absolute right-2 top-2 rounded p-0.5 text-amber-300 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300"
            onClick={() => setDismissedSeamWarning(seamReport)}
          >
            <X className="h-3 w-3" />
          </button>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-start gap-1 pr-5 [&::-webkit-details-marker]:hidden">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>Seam warnings</span>
              <ChevronDown className="ml-auto mt-0.5 h-3 w-3 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <VisualBoundaryReport
              report={seamReport}
              canDeclareSeamsAsHardCuts={chrome.canDeclareSeamsAsHardCuts}
              declareSeamsAsHardCuts={chrome.declareSeamsAsHardCuts}
              canAcknowledgeVisualCues={chrome.canAcknowledgeVisualCues}
              acknowledgeVisualCuesAsSynchronized={chrome.acknowledgeVisualCuesAsSynchronized}
            />
          </details>
        </div>
      )}
    </>
  );
}
