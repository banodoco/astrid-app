import { useEffect, useState } from 'react';
import { FileInput, FileOutput, Plus } from 'lucide-react';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import {
  PickerFooterAction,
  PickerMenu,
  PickerRow,
  PickerTrigger,
  RenameDialog,
} from '@/shared/components/ui/picker-menu.tsx';

/** Shared project and timeline picker used by the editor and app header. */
export interface EditorProjectChoice {
  id: string;
  name: string;
  detail?: string;
}
export interface EditorTimelineChoice {
  id: string;
  name: string;
  /** Secondary metadata under the name, e.g. "edited 5 minutes ago". */
  detail?: string;
  isPrimary?: boolean;
}
export function ProjectTimelinePicker({
  projects,
  timelines,
  projectId,
  timelineId,
  projectName,
  timelineName,
  projectsLoading = false,
  timelinesLoading = false,
  projectsError,
  timelinesError,
  onSelectProject,
  onSelectTimeline,
  onRetry,
  onSetPrimaryTimeline,
  settingPrimaryTimelineId,
  onCreateTimeline,
  creatingTimeline,
  disabled = false,
  showProjectSelector = true,
  showTimelineSelector = true,
  showProjectLabel = true,
  onOpenChange,
  onRenameTimeline,
  onExportTimeline,
  onImportTimeline,
}: {
  projects: readonly EditorProjectChoice[];
  timelines: readonly EditorTimelineChoice[];
  projectId: string | null;
  timelineId: string | null;
  projectName?: string | null;
  timelineName?: string | null;
  projectsLoading?: boolean;
  timelinesLoading?: boolean;
  projectsError?: string;
  timelinesError?: string;
  onSelectProject(id: string): void;
  onSelectTimeline(id: string): void;
  onRetry?(): void;
  onSetPrimaryTimeline?(id: string): void;
  settingPrimaryTimelineId?: string | null;
  onCreateTimeline?(): void;
  creatingTimeline?: boolean;
  disabled?: boolean;
  showProjectLabel?: boolean;
  showProjectSelector?: boolean;
  showTimelineSelector?: boolean;
  onOpenChange?(open: boolean): void;
  onRenameTimeline?: (timelineId: string, name: string) => Promise<void>;
  onExportTimeline?: (timelineId: string, timelineName: string, saveAs?: boolean) => void;
  onImportTimeline?: (file: File) => void;
}) {
  const [projectOpen, setProjectOpen] = useState(false),
    [timelineOpen, setTimelineOpen] = useState(false);
  const [renamingTimeline, setRenamingTimeline] = useState<{ id: string; label: string } | null>(null);
  const [importInput, setImportInput] = useState<HTMLInputElement | null>(null);
  useEffect(() => {
    onOpenChange?.(projectOpen || timelineOpen);
  }, [onOpenChange, projectOpen, timelineOpen]);
  const picker = (
    kind: 'project' | 'timeline',
    open: boolean,
    setOpen: (open: boolean) => void,
    rows: readonly (EditorProjectChoice & Partial<EditorTimelineChoice>)[],
    selected: string | null,
    /** null while the name is still arriving: a quiet bar instead of loading words. */
    label: string | null,
    loading: boolean,
    error?: string,
  ) => (
    <PickerMenu
      open={open}
      onOpenChange={setOpen}
      plural={`${kind}s`}
      currentValue={selected ?? undefined}
      count={rows.length}
      loading={loading}
      error={error}
      onRetry={onRetry}
      trigger={
        <PickerTrigger
          role="combobox"
          aria-label={`Select ${kind}`}
          disabled={disabled}
          label={label}
          loadingLabel={`Loading ${kind}`}
          starLabel={kind === 'timeline' && rows.some((row) => row.id === selected && row.isPrimary) ? 'Primary timeline' : undefined}
        />
      }
      footer={
        // New timeline is the picker's own last row, pinned under the list so a long
        // list never scrolls it away: the one way to start a timeline, first or not.
        kind === 'timeline' && (onCreateTimeline || onImportTimeline || onExportTimeline) && !loading && !error ? (
          <>
            {onExportTimeline && selected && typeof window !== 'undefined' && 'showSaveFilePicker' in window && <PickerFooterAction
              icon={FileOutput}
              disabled={disabled}
              onClick={() => {
                const row = rows.find((item) => item.id === selected);
                if (row) { setOpen(false); onExportTimeline(row.id, row.name, true); }
              }}
            >Save timeline as… (direct to file)</PickerFooterAction>}
            {onCreateTimeline && <PickerFooterAction
              icon={Plus}
              disabled={disabled || creatingTimeline}
              onClick={() => { setOpen(false); onCreateTimeline(); }}
            >{creatingTimeline ? 'Creating timeline…' : 'New timeline'}</PickerFooterAction>}
            {onImportTimeline && <PickerFooterAction
              icon={FileInput}
              disabled={disabled}
              onClick={() => { setOpen(false); importInput?.click(); }}
            >Import timeline…</PickerFooterAction>}
          </>
        ) : undefined
      }
    >
      {rows.map((row) => {
        const timeline = kind === 'timeline';
        const name = row.name?.trim() || row.detail?.trim() || (timeline ? 'Untitled timeline' : 'Untitled project');
        return (
          <PickerRow
            key={row.id}
            value={row.id}
            keywords={[row.name, row.detail ?? '']}
            current={selected === row.id}
            title={name}
            detail={row.detail}
            starred={timeline && !!row.isPrimary}
            starLabel="Primary timeline"
            onStar={timeline && onSetPrimaryTimeline ? () => onSetPrimaryTimeline(row.id) : undefined}
            starActionLabel={`Make ${row.name} primary`}
            starPending={settingPrimaryTimelineId === row.id}
            starDisabled={!!settingPrimaryTimelineId}
            onRename={timeline && onRenameTimeline ? () => {
              setOpen(false);
              setRenamingTimeline({ id: row.id, label: row.name });
            } : undefined}
            renameLabel="Rename timeline"
            onExport={timeline && selected === row.id && onExportTimeline ? () => onExportTimeline(row.id, name) : undefined}
            exportLabel="Export timeline"
            onSelect={() => {
              (kind === 'project' ? onSelectProject : onSelectTimeline)(row.id);
              setOpen(false);
            }}
          />
        );
      })}
    </PickerMenu>
  );
  return (
    <>
    {onImportTimeline && <input
      ref={setImportInput}
      type="file"
      accept=".astrid,application/zip"
      aria-label="Import timeline archive"
      className="sr-only"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) onImportTimeline(file);
      }}
    />}
    <div
      className="flex min-w-0 items-center gap-2"
      data-testid="editor-project-timeline-selectors"
    >
      {showProjectSelector && (
        <span
          className={cn(
            'text-xs font-medium text-muted-foreground',
            showProjectLabel === false && 'sr-only',
          )}
        >
          Project
        </span>
      )}
      {showProjectSelector &&
        picker(
          'project',
          projectOpen,
          setProjectOpen,
          projects,
          projectId,
          projectName ||
            projects.find((p) => p.id === projectId)?.name ||
            (projectsLoading
              ? null
              : projectId
                ? 'Project unavailable'
                : 'Select project'),
          projectsLoading,
          projectsError,
        )}
      {showTimelineSelector &&
        picker(
          'timeline',
          timelineOpen,
          setTimelineOpen,
          timelines,
          timelineId,
          timelineName ||
            timelines.find((t) => t.id === timelineId)?.name ||
            (timelinesLoading
              ? null
              : timelineId
                ? 'Timeline unavailable'
                : 'Select timeline'),
          timelinesLoading,
          timelinesError,
        )}
    </div>
    {onRenameTimeline && (
      <RenameDialog
        noun="timeline"
        target={renamingTimeline}
        onClose={() => setRenamingTimeline(null)}
        onRename={onRenameTimeline}
      />
    )}
    </>
  );
}
