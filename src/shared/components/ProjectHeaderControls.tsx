import type { ComponentProps } from 'react';
import { ProjectHeaderActions } from '@/shared/components/ProjectHeaderActions.tsx';
import { ProjectTimelinePicker } from '@/shared/components/ProjectTimelineSelectors.tsx';
import { ProvenanceButton } from '@/tools/video-editor/provenance/index.ts';
import type { EditorProjectChoice } from '@/shared/components/ProjectTimelineSelectors.tsx';

type SelectedProject = ComponentProps<typeof ProjectHeaderActions>['selectedProject'];

interface ProjectHeaderControlsProps {
  projects: readonly EditorProjectChoice[];
  projectId: string | null;
  projectName?: string | null;
  projectsLoading?: boolean;
  projectsError?: string;
  onRetry?(): void;
  onOpenChange?(open: boolean): void;
  onSelectProject(id: string): void;
  selectedProject: SelectedProject;
  pickerDisabled?: boolean;
  actionsDisabled?: boolean;
  onProjectCreated?: () => void;
  onProjectUpdated?: () => void;
  confirmNavigation?: () => boolean;
  showDialogs?: boolean;
  logoBootTarget?: boolean;
}

const noOp = () => undefined;

/** Project row shared by the connected editor and the in-memory onboarding tour. */
export function ProjectHeaderControls({
  projects,
  projectId,
  projectName,
  projectsLoading,
  projectsError,
  onRetry,
  onOpenChange,
  onSelectProject,
  selectedProject,
  pickerDisabled,
  actionsDisabled,
  onProjectCreated,
  onProjectUpdated,
  confirmNavigation,
  showDialogs,
  logoBootTarget = false,
}: ProjectHeaderControlsProps) {
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <img
        src="/astrid-favicon.svg"
        alt="Astrid"
        className="h-[30px] w-[30px] shrink-0"
        data-testid="astrid-project-row-logo"
        data-boot-mink-target={logoBootTarget ? '' : undefined}
      />
      <ProjectTimelinePicker
        projects={projects}
        timelines={[]}
        projectId={projectId}
        timelineId={null}
        projectName={projectName}
        projectsLoading={projectsLoading}
        projectsError={projectsError}
        onRetry={onRetry}
        onOpenChange={onOpenChange}
        onSelectProject={onSelectProject}
        onSelectTimeline={noOp}
        disabled={pickerDisabled}
        showProjectLabel={false}
        showTimelineSelector={false}
      />
      <ProjectHeaderActions
        selectedProject={selectedProject}
        onProjectCreated={onProjectCreated}
        onProjectUpdated={onProjectUpdated}
        disabled={actionsDisabled}
        confirmNavigation={confirmNavigation}
        showDialogs={showDialogs}
      />
      <ProvenanceButton
        projectId={selectedProject?.project_id ?? projectId}
        projectName={selectedProject?.name ?? projectName ?? null}
      />
    </div>
  );
}
