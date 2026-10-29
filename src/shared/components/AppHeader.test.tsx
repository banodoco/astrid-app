// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from '@/shared/components/AppHeader.tsx';

const runtimeMock = vi.hoisted(() => ({
  discovery: null as any,
  connection: { isConnected: false, managedByPinokio: false },
  pageStale: false,
  pageStatus: vi.fn(),
}));
vi.mock('@/tools/video-editor/hooks/useRuntimeEditorDiscovery.ts', () => ({
  useRuntimeEditorDiscovery: () => runtimeMock.discovery,
}));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({
  useRuntimeConnection: () => runtimeMock.connection,
  useRuntimeConnectionSafe: () => runtimeMock.connection,
}));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => 'https://astrid.test' }));
vi.mock('@/shared/components/RuntimeConnection/AppBuildProvider.tsx', () => ({ usePageStale: () => runtimeMock.pageStale }));
vi.mock('@/shared/lib/updates/pageUpdateStatus.ts', () => ({
  loadPageUpdateStatus: (...args: unknown[]) => runtimeMock.pageStatus(...args),
  resolvePageUpdateStatus: (status: any) => ({ card: status?.behind ? 'notice' : 'none' }),
}));
vi.mock('@/shared/components/ProjectHeaderActions.tsx', () => ({
  ProjectHeaderActions: () => null,
}));
function RouteSearch() {
  const location = useLocation();
  return <output data-testid="route-search">{location.search}</output>;
}
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
});

describe('AppHeader', () => {
  beforeEach(() => {
    runtimeMock.connection = { isConnected: false, managedByPinokio: false };
    runtimeMock.pageStale = false;
    runtimeMock.pageStatus.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses Home navigation when the editor is not the home tool', () => {
    const onNavigate = vi.fn();

    render(
      <AppHeader
        onNavigate={onNavigate}
        navigationControls={<div data-testid="selectors">Project One</div>}
        timelineName="Main timeline"
      />,
    );

    expect(screen.getByRole('button', { name: 'Go home' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open tools' })).toBeNull();
    expect(screen.getByTestId('selectors')).toBeInTheDocument();
    expect(screen.getByText('Main timeline')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go home' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('uses Tools navigation when the editor is the home tool', () => {
    render(
      <AppHeader
        navigationMode="tools"
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Open tools' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go home' })).toBeNull();
  });

  it('sits in the content layer, above the fixed sky backdrop, ', () => {
    const { unmount } = render(<AppHeader />);
    expect(screen.getByTestId('video-editor-header')).toHaveClass('relative', 'z-10');
    unmount();

    render(<AppHeader />);
    expect(screen.getByTestId('video-editor-header')).toHaveClass('relative', 'z-10');
  });

  it('keeps editor selectors, navigation, and settings together', () => {
    const settingsEvent = vi.fn();
    window.addEventListener('openSettings', settingsEvent, { once: true });

    render(
      <AppHeader
        onNavigate={vi.fn()}
        navigationControls={<div data-testid="selectors">Project One</div>}
        timelineName="Main timeline"
      />,
    );

    expect(screen.getByTestId('selectors')).toBeInTheDocument();
    expect(screen.getByText('Main timeline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go home' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open tools' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByTestId('video-editor-header')).toHaveClass('border-b');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(settingsEvent).toHaveBeenCalledTimes(1);
  });

  it('renders the page-owned project selector without app-wide Tools or built-in project controls', () => {
    render(
      <AppHeader
        navigationMode="tools"
        navigationControls={<button type="button">Editor project selector</button>}
        showProjectControls={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Editor project selector' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open tools' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go home' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('shows the Settings dot for an available update and opens the Updates section from that trigger', async () => {
    runtimeMock.connection = { isConnected: true, managedByPinokio: false };
    runtimeMock.pageStatus.mockResolvedValue({ behind: true });
    window.history.replaceState({}, '', '/tools/video-editor?project=film#edit');
    const onOpen = vi.fn();
    window.addEventListener('openSettings', (event) => onOpen((event as CustomEvent).detail), { once: true });
    render(<BrowserRouter><RouteSearch /><AppHeader /></BrowserRouter>);
    expect(await screen.findByTestId('settings-update-indicator')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpen).toHaveBeenCalledWith({ tab: 'updates' });
    expect(window.location.search).toContain('settings=updates');
    expect(window.location.hash).toBe('#edit');
    window.history.replaceState({}, '', '/tools/video-editor');
  });

  it.each([
    ['up to date', { behind: false }, false],
    ['failed', null, false],
    ['stale App page', { behind: true }, true],
  ])('keeps the Settings dot absent when status is %s', async (_label, status, pageStale) => {
    runtimeMock.connection = { isConnected: true, managedByPinokio: false };
    runtimeMock.pageStale = pageStale;
    runtimeMock.pageStatus.mockResolvedValue(status);
    render(<AppHeader />);
    await waitFor(() => expect(runtimeMock.pageStatus).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('settings-update-indicator')).toBeNull();
  });

  it('selects Runtime project IDs and writes canonical project navigation', async () => {
    const project = { project_id: 'canonical-project', slug: 'project-slug', name: 'Canonical Project', metadata: {} };
    runtimeMock.discovery = {
      project,
      projectsQuery: { data: [project], isLoading: false, error: null, refetch: vi.fn() },
      reconnect: vi.fn(),
    };
    render(
      <MemoryRouter initialEntries={['/tools/video-editor?project=old-project&timeline=old-timeline&intent=keep']}>
        <RouteSearch />
        <AppHeader showProjectControls />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select project' }));
    await user.click(await screen.findByRole('option', { name: /Canonical Project/ }));
    expect(screen.getByTestId('route-search')).toHaveTextContent('project=canonical-project');
    expect(screen.getByTestId('route-search')).not.toHaveTextContent('timeline=');
    expect(screen.getByTestId('route-search')).toHaveTextContent('intent=keep');
  });
});
