import { TimelineAddMediaButton } from './TimelineAddMediaButton.tsx';
import type { Dispatch, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { GripHorizontal, History, Maximize2, Minimize2, Redo2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { Badge } from '@/shared/components/ui/badge.tsx';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { COARSE_TOUCH_TARGET } from '@/shared/components/ui/contracts/touchTarget.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/shared/components/ui/dropdown-menu.tsx';
import { useRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { useEditorTourRunning } from '@/shared/state/editorTourStore.ts';
import { useTimelineChromeContext } from '@/tools/video-editor/hooks/timelineStore.ts';
import { clampTimelineScaleWidth, TIMELINE_ZOOM_STEP } from '@/tools/video-editor/lib/timeline-scale.ts';

const STATUS_VARIANT = {
  saved: 'default',
  saving: 'secondary',
  dirty: 'outline',
  // Recoverable transport backoff — NOT a destructive error.
  retrying: 'secondary',
  error: 'destructive',
} as const;
const CHECKPOINT_TRIGGER_LABELS = {
  session_boundary: 'Session boundary',
  edit_distance: 'Edit cap',
  semantic: 'Destructive edit',
  manual: 'Manual',
} as const;
const CHECKPOINT_TRIGGER_BADGE_VARIANT = {
  session_boundary: 'secondary',
  edit_distance: 'outline',
  semantic: 'destructive',
  manual: 'default',
} as const;

const ARMED_GESTURE_HINT = {
  move: 'Drag a clip to move it',
  trim: 'Drag a clip’s edge to trim it',
} as const;

/**
 * Undo and redo. The desktop layouts keep them in the toolbar; the touch shell
 * keeps them with the playback row under the picture, next to what they change.
 */
export function TimelineUndoRedo({
  buttonClassName,
  iconClassName = 'h-3.5 w-3.5',
}: {
  buttonClassName: string;
  iconClassName?: string;
}) {
  const chrome = useTimelineChromeContext();
  // While uploads are in flight the history layer pauses undo/redo (a
  // snapshot restore would strand the upload's registry patch); say so
  // instead of presenting a mysteriously dead button.
  const undoLabel = chrome.historyPausedForUploads ? 'Undo is paused while media uploads finish' : 'Undo';
  const redoLabel = chrome.historyPausedForUploads ? 'Redo is paused while media uploads finish' : 'Redo';
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={buttonClassName}
        onClick={chrome.undo}
        disabled={!chrome.canUndo}
        title={undoLabel}
        aria-label={undoLabel}
      >
        <Undo2 className={iconClassName} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={buttonClassName}
        onClick={chrome.redo}
        disabled={!chrome.canRedo}
        title={redoLabel}
        aria-label={redoLabel}
      >
        <Redo2 className={iconClassName} />
      </Button>
    </>
  );
}

/**
 * The shell's chrome row: save status, undo/redo/history, the drag
 * handle for the preview/timeline split, and the zoom controls. Shared by all
 * three layout variants.
 *
 * On touch (phones and tablets) it is the document row above the picture: `leading` (the
 * timeline picker), a quiet save status and `trailing` (Render). Undo and redo
 * live with the playback row there, pinch zooms the timeline, and history,
 * Elements and the split handle stay with the larger layouts.
 *
 * While a clip action has armed a touch gesture (`armedGesture`), the row says
 * what to do and offers Done, the only way back to the resting mode.
 */
export function TimelineEditorShellToolbar({
  touchChrome,
  condensed,
  documentRow = false,
  armedGesture = null,
  onReleaseArmedGesture,
  leading,
  trailing,
  onDividerPointerDown,
  onDividerPointerMove,
  onDividerPointerUp,
  onDividerPointerCancel,
  onDividerLostPointerCapture,
  isTimelineMaximized,
  setIsTimelineMaximized,
  timelineLoaded = true,
}: {
  touchChrome: boolean;
  condensed: boolean;
  /** The touch shell's document row. */
  documentRow?: boolean;
  armedGesture?: 'move' | 'trim' | null;
  onReleaseArmedGesture?: () => void;
  /** Document row only: the controls at the row's start (the timeline picker). */
  leading?: ReactNode;
  /** Document row only: the controls at the row's end (Render). */
  trailing?: ReactNode;
  onDividerPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDividerPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onDividerPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onDividerPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onDividerLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  isTimelineMaximized: boolean;
  setIsTimelineMaximized: Dispatch<SetStateAction<boolean>>;
  /** False until the timeline has arrived: nothing is saved yet, so the save badge holds its place unseen. */
  timelineLoaded?: boolean;
}) {
  const chrome = useTimelineChromeContext();
  // The tour's demo timeline saves nothing, so a "Dirty" badge there would only read as an error.
  const tourRunning = useEditorTourRunning();
  const statusVisible = timelineLoaded && !tourRunning;
  const toolbarButtonSizeClass = touchChrome ? 'h-11 w-11' : 'h-6 w-6';

  // While the hosted build's "Astrid stopped" / "restarted" card is up, a failed save is not an editor fault: the changes
  // are kept and the card says what to do, so the badge reads neutral instead of a red "Error". An open save conflict is
  // a choice between two versions, not an error, so it reads the same way.
  const recoveryCardShowing = useRecoveryCardShowing();
  // On the hosted build a failed save is Astrid not answering (the card says so, and the save is retried when it is back),
  // so the red "Error" never shows there, not even in the moment after the card clears: schema rejections have their own banner.
  const hostedSaveWaiting = runtimeOrigin() !== '' && chrome.saveStatus === 'error' && !chrome.schemaIncompatible;
  const notSaved = (recoveryCardShowing || chrome.isConflictExhausted || hostedSaveWaiting) && chrome.saveStatus !== 'saved';
  const saveBadge = (
    <Badge
      variant={notSaved ? 'outline' : STATUS_VARIANT[chrome.saveStatus]}
      className={cn('h-5 px-1.5 text-[10px]', notSaved ? 'text-muted-foreground' : 'capitalize', !statusVisible && 'invisible')}
      aria-hidden={!statusVisible || undefined}
    >
      {notSaved ? 'Not saved' : chrome.saveStatus}
    </Badge>
  );
  const historyMenu = (
    <DropdownMenu onOpenChange={(open) => {
      if (open && chrome.canonicalHistorySupported) {
        void chrome.refreshCanonicalHistory();
      }
    }}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className={toolbarButtonSizeClass} title="History">
          <History className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="pb-1 text-xs font-semibold text-muted-foreground">
          History
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {chrome.canonicalHistoryError ? (
          <div role="alert" className="px-2 py-2 text-xs text-destructive">
            {chrome.canonicalHistoryError}
          </div>
        ) : null}
        {chrome.canonicalHistorySupported ? (
          chrome.canonicalHistoryError ? null : chrome.canonicalHistory.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No published revisions yet.
            </div>
          ) : (
            chrome.canonicalHistory.map((entry) => (
              <DropdownMenuItem
                key={entry.revisionId}
                className="flex flex-col items-start gap-1 py-2"
                disabled={entry.isCurrentHead || chrome.restoringCanonicalRevisionId !== null}
                onClick={() => void chrome.restoreCanonicalRevision(entry.revisionId)}
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <span className="truncate font-mono text-xs text-foreground">
                    {entry.revisionId.slice(0, 16)}
                  </span>
                  {entry.isCurrentHead ? (
                    <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[9px] uppercase tracking-[0.12em]">
                      Current
                    </Badge>
                  ) : chrome.restoringCanonicalRevisionId === entry.revisionId ? (
                    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[9px] uppercase tracking-[0.12em]">
                      Restoring
                    </Badge>
                  ) : null}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                </span>
              </DropdownMenuItem>
            ))
          )
        ) : chrome.checkpoints.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No checkpoints yet. Save one manually or keep editing to build history.
          </div>
        ) : (
          chrome.checkpoints.map((checkpoint) => (
            <DropdownMenuItem
              key={checkpoint.id}
              className="flex flex-col items-start gap-1 py-2"
              onClick={() => chrome.jumpToCheckpoint(checkpoint.id)}
            >
              <div className="flex w-full items-start justify-between gap-2">
                <span className="truncate text-sm text-foreground">{checkpoint.label}</span>
                <Badge
                  variant={CHECKPOINT_TRIGGER_BADGE_VARIANT[checkpoint.triggerType]}
                  className="shrink-0 px-1.5 py-0 text-[9px] uppercase tracking-[0.12em]"
                >
                  {CHECKPOINT_TRIGGER_LABELS[checkpoint.triggerType]}
                </Badge>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {formatDistanceToNow(new Date(checkpoint.createdAt), { addSuffix: true })}
              </span>
            </DropdownMenuItem>
          ))
        )}
        {!chrome.canonicalHistorySupported ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void chrome.createManualCheckpoint()}>
              Save checkpoint
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const armedGestureControl = armedGesture ? (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center justify-between gap-2',
        // The larger layouts give it a line of its own under the toolbar's controls.
        !documentRow && 'order-last basis-full border-t border-border/60 pl-1 pt-1',
      )}
      data-armed-gesture={armedGesture}
    >
      <span className={cn('min-w-0 truncate text-foreground', documentRow ? 'text-sm' : 'text-xs')}>{ARMED_GESTURE_HINT[armedGesture]}</span>
      <Button
        type="button"
        size="sm"
        className={cn('h-9 shrink-0 px-4', COARSE_TOUCH_TARGET)}
        onClick={onReleaseArmedGesture}
      >
        Done
      </Button>
    </div>
  ) : null;

  if (documentRow) {
    // Quiet when all is well: a word appears only while a save is pending or has not landed.
    const quietStatus = notSaved || chrome.saveStatus === 'error'
      ? 'Not saved'
      : chrome.saveStatus === 'saved' ? null : 'Saving…';
    return (
      <div
        className={cn(
          'relative flex min-h-9 min-w-0 max-w-full items-center gap-2 text-muted-foreground',
          // The row is just its controls, like the header above it. An armed
          // gesture swaps them for its hint and Done, at the same height.
          armedGestureControl && 'pl-1',
        )}
        data-toolbar-layout="touch"
      >
        {armedGestureControl ? (
          armedGestureControl
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {leading}
              {quietStatus && statusVisible && (
                <span
                  className={cn(
                    'shrink-0 text-[11px]',
                    chrome.saveStatus === 'error' && !notSaved ? 'text-destructive' : 'text-muted-foreground',
                  )}
                  role="status"
                >
                  {quietStatus}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">{trailing}</div>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex min-w-0 max-w-full items-center justify-between gap-2 rounded-lg border border-border/70 bg-card/95 px-2 text-muted-foreground',
        touchChrome ? 'min-h-11 py-1' : 'h-7',
        (condensed || armedGestureControl) && 'h-auto flex-wrap',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {saveBadge}
        <TimelineUndoRedo buttonClassName={toolbarButtonSizeClass} />
        {historyMenu}
        <TimelineAddMediaButton disabled={!timelineLoaded} />
      </div>
      {armedGestureControl}
      {!condensed && !armedGestureControl && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className="pointer-events-auto flex h-full w-12 cursor-row-resize touch-none select-none items-center justify-center"
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
            onPointerCancel={onDividerPointerCancel}
            onLostPointerCapture={onDividerLostPointerCapture}
          >
            <GripHorizontal className="h-4 w-4 text-border" />
          </div>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1">
        {!condensed && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={toolbarButtonSizeClass}
            onClick={() => setIsTimelineMaximized((value) => !value)}
            title={isTimelineMaximized ? 'Restore preview and timeline split' : 'Maximize timeline'}
          >
            {isTimelineMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={toolbarButtonSizeClass}
          title="Zoom out timeline"
          aria-label="Zoom out timeline"
          onClick={() => chrome.setScaleWidth((value) => clampTimelineScaleWidth(value / TIMELINE_ZOOM_STEP))}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={toolbarButtonSizeClass}
          title="Zoom in timeline"
          aria-label="Zoom in timeline"
          onClick={() => chrome.setScaleWidth((value) => clampTimelineScaleWidth(value * TIMELINE_ZOOM_STEP))}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
