// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentChatBridge } from '@/shared/contexts/AgentChatContext';
import { useGallerySelectionOptional } from '@/shared/state/selectionStore';
import { RuntimeConnectionProvider } from '@/integrations/runtime/RuntimeConnectionProvider';
import { useRuntimeAuthority } from '@/app/runtime/runtimeAuthority';
import { AppProviders } from './AppProviders';

const mocks = vi.hoisted(() => ({ listProjects: vi.fn(), listTimelines: vi.fn() }));
let authorityProbeMounts = 0;

vi.mock('@/integrations/runtime/client', () => ({
  AstridRuntimeClient: class {
    listProjects = mocks.listProjects;
    listTimelines = mocks.listTimelines;
  },
}));

vi.mock('@/shared/components/AstridLoading', () => ({ AstridLoading: () => <div data-testid="runtime-document-loading" /> }));

function passthroughProvider(testId: string) {
  return function Provider({ children }: { children: ReactNode }) {
    return <div data-testid={testId}>{children}</div>;
  };
}

vi.mock('@/shared/contexts/AuthContext', () => ({
  AuthProvider: passthroughProvider('AuthProvider'),
}));

vi.mock('@/shared/auth/components/AuthGate', () => ({
  AuthGate: passthroughProvider('AuthGate'),
}));

vi.mock('@/shared/contexts/UserSettingsContext', () => ({
  UserSettingsProvider: passthroughProvider('UserSettingsProvider'),
  useUserSettings: () => ({
    userSettings: { lastTimelineId: 'timeline-from-settings' },
    isLoadingSettings: false,
    fetchUserSettings: vi.fn(),
    updateUserSettings: vi.fn(),
  }),
}));

vi.mock('@/shared/hooks/settings/useToolSettings', () => ({
  useToolSettings: () => ({
    settings: { lastAffectedShotId: 'shot-from-settings', lastTimelineId: 'timeline-from-settings' },
    update: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock('@/shared/contexts/ProjectContext', () => ({
  ProjectProvider: passthroughProvider('ProjectProvider'),
  useProject: () => ({ selectedProjectId: 'project-1' }),
  useProjectSelectionContext: () => ({ selectedProjectId: 'project-1' }),
}));

vi.mock('@/shared/providers/RealtimeProvider', () => ({
  RealtimeProvider: passthroughProvider('RealtimeProvider'),
}));

vi.mock('@/shared/contexts/ShotsContext', () => ({
  AstridShotsProvider: passthroughProvider('AstridShotsProvider'),
}));

vi.mock('@/shared/contexts/GenerationTaskContext', () => ({
  GenerationTaskProvider: passthroughProvider('GenerationTaskProvider'),
}));

vi.mock('@/shared/contexts/IncomingTasksContext', () => ({
  IncomingTasksProvider: passthroughProvider('IncomingTasksProvider'),
}));

vi.mock('@/shared/state/panesStore', () => ({
  PanesStoreBootstrapBoundary: passthroughProvider('PanesStoreBootstrapBoundary'),
}));

vi.mock('@/shared/contexts/ToolPageHeaderContext', () => ({
  ToolPageHeaderProvider: passthroughProvider('ToolPageHeaderProvider'),
}));

vi.mock('@/shared/components/TaskTypeConfigInitializer', () => ({
  TaskTypeConfigInitializer: passthroughProvider('TaskTypeConfigInitializer'),
}));

vi.mock('@/shared/state/selectionStore', async () => {
  const actual = await vi.importActual<typeof import('@/shared/state/selectionStore')>('@/shared/state/selectionStore');
  return {
    ...actual,
    useLastAffectedShot: () => ({
      lastAffectedShotId: 'shot-from-settings',
      setLastAffectedShotId: vi.fn(),
    }),
  };
});

function GallerySelectionConsumer() {
  const context = useGallerySelectionOptional();
  return <span data-testid="gallery-selection-context">{context ? 'available' : 'missing'}</span>;
}

function AgentChatBridgeConsumer() {
  const bridge = useAgentChatBridge();
  return (
    <>
      <span data-testid="agent-chat-timeline-id">{bridge.timelineId ?? 'none'}</span>
    </>
  );
}

function AuthorityNavigationProbe() {
  const { runtimeAuthority, runtimeProjectId } = useRuntimeAuthority();
  const navigate = useNavigate();
  const [mounts, setMounts] = useState(0);
  useEffect(() => {
    authorityProbeMounts += 1;
    setMounts(authorityProbeMounts);
  }, []);
  return (
    <>
      <span data-testid="authority-project">{runtimeAuthority ? runtimeProjectId : 'no-runtime-authority'}</span>
      <span data-testid="authority-mounts">{mounts}</span>
      <button onClick={() => navigate('/tools/video-editor?project=project-2&timeline=timeline-2')}>navigate project</button>
    </>
  );
}

describe('AppProviders', () => {
  beforeEach(() => {
    authorityProbeMounts = 0;
    mocks.listProjects.mockReset().mockResolvedValue([
      { project_id: 'project-id', slug: 'project-slug', name: 'Project' },
      { project_id: 'project-2', slug: 'project-two', name: 'Project Two' },
    ]);
    mocks.listTimelines.mockReset().mockResolvedValue([{ project_id: 'project-id', timeline_id: 'timeline-id', timeline_ulid: 'timeline-alias' }]);
  });

  it('mounts the selection-store boundary and the default AgentChat bridge inside the provider tree', () => {
    render(
      <MemoryRouter>
        <RuntimeConnectionProvider gated={false}>
          <AppProviders>
            <GallerySelectionConsumer />
            <AgentChatBridgeConsumer />
          </AppProviders>
        </RuntimeConnectionProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('gallery-selection-context')).toHaveTextContent('available');
    expect(screen.getByTestId('agent-chat-timeline-id')).toHaveTextContent('timeline-from-settings');
    expect(screen.getByTestId('PanesStoreBootstrapBoundary')).toBeInTheDocument();
    expect(screen.getByTestId('AstridShotsProvider')).toBeInTheDocument();
  });

  it('holds settings and project providers until a legacy tool URL resolves to canonical identity', async () => {
    let resolveProjects!: (projects: Array<{ project_id: string; slug: string; name: string }>) => void;
    mocks.listProjects.mockImplementationOnce(() => new Promise((resolve) => { resolveProjects = resolve; }));
    function RouteProbe() {
      const { pathname, search } = useLocation();
      return <span data-testid="resolved-route">{pathname}{search}</span>;
    }

    render(
      <MemoryRouter initialEntries={['/tools/image-generation?localProject=project-slug&localTimeline=timeline-alias&filter=video']}>
        <RuntimeConnectionProvider gated={false}>
          <AppProviders><RouteProbe /></AppProviders>
        </RuntimeConnectionProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('runtime-document-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('UserSettingsProvider')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ProjectProvider')).not.toBeInTheDocument();

    await act(async () => {
      resolveProjects([{ project_id: 'project-id', slug: 'project-slug', name: 'Project' }]);
    });
    await waitFor(() => expect(screen.getByTestId('resolved-route')).toHaveTextContent(
      '/tools/image-generation?filter=video&project=project-id&timeline=timeline-id',
    ));
    expect(screen.getByTestId('UserSettingsProvider')).toBeInTheDocument();
    expect(screen.getByTestId('ProjectProvider')).toBeInTheDocument();
    expect(mocks.listTimelines).toHaveBeenCalledWith('project-id');
  });

  it('keeps hosted providers behind the Runtime connection gate before attempting normalization', async () => {
    const permissions = { query: vi.fn(async () => ({ state: 'granted', onchange: null })) };
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    render(
      <MemoryRouter initialEntries={['/tools/image-generation?localProject=project-slug']}>
        <RuntimeConnectionProvider gated permissions={permissions} fetchImpl={fetchImpl as unknown as typeof fetch} pollIntervalMs={10}>
          <AppProviders><span>providers mounted</span></AppProviders>
        </RuntimeConnectionProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toBeInTheDocument());
    expect(screen.queryByTestId('UserSettingsProvider')).not.toBeInTheDocument();
    expect(screen.queryByText('providers mounted')).not.toBeInTheDocument();
    expect(mocks.listProjects).not.toHaveBeenCalled();
  });

  it('leaves public routes available while a hosted Runtime is disconnected', () => {
    const permissions = { query: vi.fn(async () => ({ state: 'granted', onchange: null })) };
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    render(
      <MemoryRouter initialEntries={['/blog?localProject=ignored']}>
        <RuntimeConnectionProvider gated permissions={permissions} fetchImpl={fetchImpl as unknown as typeof fetch} pollIntervalMs={10}>
          <AppProviders><span>public page</span></AppProviders>
        </RuntimeConnectionProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('public page')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-not-connected')).not.toBeInTheDocument();
    expect(mocks.listProjects).not.toHaveBeenCalled();
  });

  it('updates Runtime authority on picker navigation without remounting provider children', async () => {
    render(
      <MemoryRouter initialEntries={['/tools/video-editor?project=project-id&timeline=timeline-id']}>
        <RuntimeConnectionProvider gated={false}>
          <AppProviders><AuthorityNavigationProbe /></AppProviders>
        </RuntimeConnectionProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('authority-project')).toHaveTextContent('project-id');
      expect(screen.getByTestId('authority-mounts')).toHaveTextContent('1');
    });
    expect(screen.getByTestId('authority-mounts')).toHaveTextContent('1');
    act(() => screen.getByText('navigate project').click());
    await waitFor(() => {
      expect(screen.getByTestId('authority-project')).toHaveTextContent('project-2');
      expect(screen.getByTestId('authority-mounts')).toHaveTextContent('1');
    });
    expect(screen.getByTestId('authority-mounts')).toHaveTextContent('1');
  });
});
