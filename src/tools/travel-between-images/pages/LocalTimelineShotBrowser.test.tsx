// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTimelineShotBrowser } from './LocalTimelineShotBrowser';
import fixture from '@/tools/video-editor/data/shotComposition.fixture.json';
import { createShotCompositionAdapter } from '@/tools/video-editor/data/shotCompositionAdapter.ts';

// The production list/editor are integration-tested separately. These focused
// tests keep the document-to-shot adapter and URL contract deterministic without
// requiring the full application provider tree (auth, panes, and settings).
vi.mock('../components/VideoGallery/ShotListDisplay.tsx', () => ({
  ShotListDisplay: ({ shots, onSelectShot }: { shots: Array<{ id: string; name: string }>; onSelectShot: (shot: unknown) => void }) => (
    <div data-testid="production-shot-list">
      {shots.map((shot) => (
        <button key={shot.id} type="button" onClick={() => onSelectShot(shot)}>
          Select shot {shot.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./ShotEditorView.tsx', () => ({
  ShotEditorView: ({ shotToEdit, canonicalOccurrence, canonicalShotComposition, onClose, ...props }: { shotToEdit: { name: string; images?: Array<{ id: string }> }; canonicalOccurrence?: { occurrenceId: string; stableDeepLink: string }; canonicalShotComposition?: unknown; onClose?: () => void }) => {
    mocks.shotEditorProps({ canonicalShotComposition, ...props });
    const navigate = useNavigate();
    const location = useLocation();
    return (
      <div data-testid="production-shot-editor">
        <button
          type="button"
          onClick={() => onClose?.() ?? navigate({ pathname: location.pathname, search: location.search, hash: '' })}
        >Back to all shots</button>
        <h1>{shotToEdit.name}</h1>
        <div data-testid="canonical-occurrence">{canonicalOccurrence?.occurrenceId}:{canonicalOccurrence?.stableDeepLink}</div>
        <div data-testid="canonical-adapter">{canonicalShotComposition ? 'shared' : 'missing'}</div>
        <div data-testid="selected-shot-image-ids">{shotToEdit.images?.map((image) => image.id).join(',')}</div>
      </div>
    );
  },
}));

const mocks = vi.hoisted(() => ({
  providerOptions: vi.fn(),
  shotEditorProps: vi.fn(),
  loadTimeline: vi.fn(),
  loadAssetRegistry: vi.fn(),
  onResolve: vi.fn(({ file }: { file: string }) => `https://runtime.test/${file}`),
  loadShotComposition: vi.fn(),
}));

vi.mock('@/integrations/runtime/dataProvider.ts', () => ({
  RuntimeDataProvider: class MockRuntimeDataProvider {
    refreshIntervalMs = 6_000;
    loadTimeline = mocks.loadTimeline;
    loadAssetRegistry = mocks.loadAssetRegistry;
    onResolve = mocks.onResolve;
    shotComposition = { load: mocks.loadShotComposition };
    constructor(options: unknown) {
      mocks.providerOptions(options);
    }
  },
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>;
}

function renderBrowser(initialEntry = '/tools/travel-between-images?project=project-001&timeline=document-primary') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocalTimelineShotBrowser projectSlug="project-001" projectId="project-001" timelineRef="document-primary" />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LocalTimelineShotBrowser', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.providerOptions.mockReset();
    mocks.shotEditorProps.mockReset();
    mocks.loadTimeline.mockReset();
    mocks.loadAssetRegistry.mockReset();
    mocks.onResolve.mockClear();
    mocks.loadShotComposition.mockReset();
    mocks.loadTimeline.mockResolvedValue({
      config: {
        output: { resolution: '1280x720', fps: 24, file: 'out.mp4' },
        tracks: [{ id: 'V1', kind: 'visual', label: 'Visual' }],
        clips: [{ id: 'clip-a', at: 0, track: 'V1', asset: 'asset-a', from: 0, to: 2 }],
      },
      configVersion: 1,
    });
    mocks.loadAssetRegistry.mockResolvedValue({
      assets: {
        'alpha-image': { media_id: 'object-alpha-image', type: 'image/png', duration: 2 },
        'beta-image': { media_id: 'object-beta-image', type: 'image/png', duration: 1.2 },
      },
    });
    mocks.loadShotComposition.mockResolvedValue(fixture);
  });

  it('renders the established shot list from document-derived shot models', async () => {
    renderBrowser();

    expect(await screen.findAllByRole('button', { name: 'Select shot shot-alpha' })).not.toHaveLength(0);
    expect(screen.getByTestId('production-shot-list')).toBeInTheDocument();
  });

  it('reads the timeline, registry and assets through the Runtime provider for the project id', async () => {
    renderBrowser();

    expect(await screen.findAllByRole('button', { name: 'Select shot shot-alpha' })).not.toHaveLength(0);
    expect(mocks.providerOptions).toHaveBeenCalledWith({ projectId: 'project-001' });
    expect(mocks.loadTimeline).toHaveBeenCalledWith('document-primary');
    expect(mocks.loadAssetRegistry).toHaveBeenCalledWith('document-primary');
    expect(mocks.loadShotComposition).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-001', parentDocumentId: 'document-primary' }),
    );
  });

  it('reports a load error instead of falling back to another backend when no Runtime project id is given', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tools/travel-between-images?project=project-001&timeline=document-primary']}>
          <LocalTimelineShotBrowser projectSlug="project-001" timelineRef="document-primary" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace Runtime project is unavailable');
    expect(mocks.providerOptions).not.toHaveBeenCalled();
    expect(mocks.loadTimeline).not.toHaveBeenCalled();
  });

  it('opens the established shot editor with only the selected group clips', async () => {
    renderBrowser();
    const shot = (await screen.findAllByRole('button', { name: 'Select shot shot-alpha' }))[0];
    fireEvent.click(shot);

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/tools/travel-between-images?project=project-001&timeline=document-primary#project%2Fproject-001%2Fdocument%2Fdocument-primary%2Fshot%2Fshot-alpha%2Frevision%2Frev-a%2Foccurrence%2Focc-1',
      );
      expect(screen.getByRole('heading', { name: 'shot-alpha' })).toBeInTheDocument();
      expect(screen.getByTestId('production-shot-editor')).toBeInTheDocument();
      expect(screen.getByTestId('canonical-occurrence')).toHaveTextContent('occ-1');
      expect(screen.getByTestId('canonical-adapter')).toHaveTextContent('shared');
      expect(screen.getByTestId('selected-shot-image-ids')).toHaveTextContent('occ-1:representative');
    });
  });

  it('opens a valid deep link directly in shot detail after refresh', async () => {
    renderBrowser('/tools/travel-between-images?project=project-001&timeline=document-primary#project%2Fproject-001%2Fdocument%2Fdocument-primary%2Fshot%2Fshot-alpha%2Frevision%2Frev-a%2Foccurrence%2Focc-1');

    expect(await screen.findByRole('heading', { name: 'shot-alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to all shots/i })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/tools/travel-between-images?project=project-001&timeline=document-primary#project%2Fproject-001%2Fdocument%2Fdocument-primary%2Fshot%2Fshot-alpha%2Frevision%2Frev-a%2Foccurrence%2Focc-1',
    );
  });

  it('opens an embedded shot ref without changing the parent URL', async () => {
    const onClose = vi.fn();
    const shotCompositionAdapter = createShotCompositionAdapter({
      load: async () => fixture,
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tools/video-editor?project=project-001&timeline=document-primary']}>
          <LocalTimelineShotBrowser
            projectSlug="project-001"
            projectId="project-001"
            timelineRef="document-primary"
            shotCompositionAdapter={shotCompositionAdapter}
            shotRef="project/project-001/document/document-primary/shot/shot-alpha/revision/rev-a/occurrence/occ-1"
            onClose={onClose}
          />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'shot-alpha' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/tools/video-editor?project=project-001&timeline=document-primary');

    fireEvent.click(screen.getByRole('button', { name: /Back to all shots/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/tools/video-editor?project=project-001&timeline=document-primary');
  });

  it('mounts the canonical occurrence owner and Runtime saver for the shot editor', async () => {
    const shotCompositionAdapter = createShotCompositionAdapter({
      load: async () => fixture,
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tools/video-editor?project=project-001&timeline=document-primary']}>
          <LocalTimelineShotBrowser
            projectSlug="project-001"
            projectId="project-001"
            timelineRef="document-primary"
            shotCompositionAdapter={shotCompositionAdapter}
            shotRef="project/project-001/document/document-primary/shot/shot-alpha/revision/rev-a/occurrence/occ-1"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'shot-alpha' })).toBeInTheDocument();
    expect(mocks.shotEditorProps).toHaveBeenCalledWith(expect.objectContaining({
      canonicalShotComposition: shotCompositionAdapter,
      timelineDataProvider: expect.anything(),
      onCanonicalCompositionPublished: expect.any(Function),
    }));
  });

  it('opens immediately from the parent composition while the document refresh is still pending', () => {
    const unresolved = new Promise<never>(() => {});
    mocks.loadTimeline.mockReturnValue(unresolved);
    mocks.loadAssetRegistry.mockReturnValue(unresolved);
    const shotCompositionAdapter = createShotCompositionAdapter({
      load: vi.fn(() => unresolved),
      publish: vi.fn(),
    });
    const initialComposition = shotCompositionAdapter.prepare(fixture);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tools/video-editor?project=project-001&timeline=document-primary']}>
          <LocalTimelineShotBrowser
            projectSlug="project-001"
            projectId="project-001"
            timelineRef="document-primary"
            shotCompositionAdapter={shotCompositionAdapter}
            shotRef="project/project-001/document/document-primary/shot/shot-alpha/revision/rev-a/occurrence/occ-1"
            initialComposition={initialComposition}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { name: 'shot-alpha' })).toBeInTheDocument();
    expect(screen.getByTestId('canonical-adapter')).toHaveTextContent('shared');
    expect(screen.queryByText('Loading timeline shots…')).toBeNull();
  });

  it.each([
    ['malformed', '/tools/travel-between-images?project=project-001&timeline=document-primary#%E0%A4%A'],
    ['unknown', '/tools/travel-between-images?project=project-001&timeline=document-primary#not-a-shot'],
  ])('falls back to the overview for a %s hash', async (_kind, initialEntry) => {
    renderBrowser(initialEntry);

    expect(await screen.findAllByRole('button', { name: 'Select shot shot-alpha' })).not.toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/tools/travel-between-images?project=project-001&timeline=document-primary',
      );
    });
    expect(screen.queryByTestId('production-shot-editor')).not.toBeInTheDocument();
  });

  it('returns from shot detail to the complete overview while preserving local scope', async () => {
    renderBrowser();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Select shot shot-alpha' }))[0]);

    const back = await screen.findByRole('button', { name: /Back to all shots/i });
    fireEvent.click(back);

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/tools/travel-between-images?project=project-001&timeline=document-primary',
      );
      expect(screen.getAllByRole('button', { name: 'Select shot shot-alpha' })).not.toHaveLength(0);
    });
  });

  it('reports a typed canonical graph failure', async () => {
    mocks.loadShotComposition.mockRejectedValueOnce(new Error('missing canonical dependency'));
    renderBrowser();
    expect(await screen.findByRole('alert')).toHaveTextContent('missing canonical dependency');
  });
});
