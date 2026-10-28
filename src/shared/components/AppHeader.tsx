import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { Home, LayoutGrid, Settings } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { COARSE_TOUCH_TARGET } from '@/shared/components/ui/contracts/touchTarget.ts';
import { ProjectTimelinePicker } from '@/shared/components/ProjectTimelineSelectors.tsx';
import { ProjectHeaderActions } from '@/shared/components/ProjectHeaderActions.tsx';
import { useRuntimeEditorDiscovery } from '@/tools/video-editor/hooks/useRuntimeEditorDiscovery.ts';
import { useRuntimeConnectionSafe } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { usePageUpdateResolution } from '@/shared/lib/updates/usePageUpdateResolution.ts';
import { usePageStale } from '@/shared/components/RuntimeConnection/AppBuildProvider.tsx';
import { openUpdatesSettings } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';

export type AppHeaderNavigationMode = 'home' | 'tools';

interface AppHeaderProps {
  navigationMode?: AppHeaderNavigationMode;
  onNavigate?: () => void;
  navigationControls?: ReactNode;
  timelineName?: string | null;
  showProjectControls?: boolean;
  settingsDisabled?: boolean;
}

function AppHeaderProjectControls() {
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get('project');
  const [selectorsOpen, setSelectorsOpen] = useState(false);
  const discovery = useRuntimeEditorDiscovery({
    enabled: true,
    projectId,
    open: selectorsOpen,
  });
  const selectedProject = discovery.project;

  const refreshProjects = useCallback(() => {
    void discovery.projectsQuery.refetch();
  }, [discovery.projectsQuery]);

  const handleProjectChange = useCallback((nextProjectId: string) => {
    if (nextProjectId) {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set('project', nextProjectId);
        next.delete('timeline');
        return next;
      }, { replace: true });
    }
  }, [setSearchParams]);

  return (
    <>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <ProjectTimelinePicker
          projects={(discovery.projectsQuery.data ?? []).map((p) => ({ id: p.project_id, name: p.name, detail: p.slug }))}
          timelines={[]}
          projectId={selectedProject?.project_id ?? projectId}
          timelineId={null}
          projectName={selectedProject?.name ?? (projectId ? 'Project unavailable' : 'Select project')}
          projectsLoading={discovery.projectsQuery.isLoading}
          projectsError={discovery.projectsQuery.error?.message}
          onRetry={() => void discovery.reconnect()}
          onSelectProject={handleProjectChange}
          onSelectTimeline={() => undefined}
          disabled={false}
          showProjectSelector
          showTimelineSelector={false}
          onOpenChange={setSelectorsOpen}
        />
        <ProjectHeaderActions
          selectedProject={selectedProject}
          onProjectCreated={refreshProjects}
          onProjectUpdated={refreshProjects}
          disabled={discovery.projectsQuery.isLoading}
        />
      </div>
    </>
  );
}

/**
 * The single built-in app header. It is shared by the loaded editor,
 * project/timeline fallback states, and the other tools so navigation does not
 * change when the route changes.
 */
export function AppHeader({
  navigationMode = 'home',
  onNavigate,
  navigationControls,
  timelineName,
  showProjectControls = false,
  settingsDisabled = false,
}: AppHeaderProps) {
  const isToolsNavigation = navigationMode === 'tools';
  const navigationLabel = isToolsNavigation ? 'Tools' : 'Home';
  const NavigationIcon = isToolsNavigation ? LayoutGrid : Home;
  // The onboarding tour renders this header with no Runtime provider above it. With no connection there is no
  // update to show, so the header stays usable instead of throwing.
  const connection = useRuntimeConnectionSafe();
  const pageStale = usePageStale();
  const page = usePageUpdateResolution(connection);
  const updateAvailable = page?.resolution.card === 'notice' || page?.resolution.card === 'update';

  return (
    // `relative z-10` puts the header in the same layer as the app content, above the fixed sky backdrop
    // (`AppSkyBackground`, z-0 at half opacity). Unpositioned, it painted under the sky, which veiled the
    // logo, text and buttons.
    <header
      className={cn(
        'relative z-10 flex w-full min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground',
        'min-h-10 border-b border-border bg-background px-3 py-1.5',
      )}
      data-testid="video-editor-header"
    >
      {onNavigate && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          onClick={onNavigate}
          aria-label={isToolsNavigation ? 'Open tools' : 'Go home'}
          title={isToolsNavigation ? 'Open tools' : 'Go home'}
        >
          <NavigationIcon className="h-3.5 w-3.5" />
          <span>{navigationLabel}</span>
        </Button>
      )}

      {showProjectControls && (
        <AppHeaderProjectControls />
      )}

      {navigationControls && (
        <div
          className="flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-2"
          data-testid="video-editor-navigation-controls"
        >
          {navigationControls}
        </div>
      )}

      {timelineName && (
        <div className={cn('min-w-0 truncate text-foreground', !navigationControls && 'ml-1')}>
          <span className="">{timelineName}</span>
        </div>
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('relative ml-auto h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground', COARSE_TOUCH_TARGET)}
        onClick={openUpdatesSettings}
        disabled={settingsDisabled}
        title="Settings"
        aria-label="Settings"
      >
        <Settings className="h-3.5 w-3.5" />
        {updateAvailable && !pageStale && <span data-testid="settings-update-indicator" aria-label="Update available" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500" />}
      </Button>

    </header>
  );
}
