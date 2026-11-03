import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBuildProvider } from './AppBuildProvider.tsx';
import { flushDraftsBeforeReload, registerDraftSafeReloadGuard, resetDraftReloadGuardsForTest } from '@/shared/lib/updates/draftSafeReload.ts';

vi.mock('@/shared/lib/updates/appBuildWatch.ts', () => ({ useAppBuildWatch: () => true }));

afterEach(() => { cleanup(); resetDraftReloadGuardsForTest(); });

describe('AppBuildProvider stale-build notice', () => {
  it('stays above an interactive editor surface and reloads after mounted drafts flush', async () => {
    const reload = vi.fn();
    const flush = vi.fn(async () => undefined);
    const unregister = registerDraftSafeReloadGuard({ label: 'Timeline', flush, isDirty: () => false });
    render(
      <AppBuildProvider reload={reload}>
        <div data-testid="editor-surface" className="fixed inset-0 z-[100100]">Editor</div>
      </AppBuildProvider>,
    );

    const notice = screen.getByRole('status');
    const editor = screen.getByTestId('editor-surface');
    expect(notice).toHaveClass('z-[100110]');
    expect(editor).toHaveClass('z-[100100]');
    expect(notice).toHaveTextContent('Editor updated · Reload');
    const reloadButton = screen.getByRole('button', { name: 'Reload' });
    fireEvent.click(reloadButton);
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(flush).toHaveBeenCalledOnce();
    unregister();
  });

  it('keeps the page open and shows an error when a draft cannot be saved', async () => {
    const reload = vi.fn();
    const unregister = registerDraftSafeReloadGuard({ label: 'Agent chat', flush: async () => { throw new Error('bridge unavailable'); } });
    render(<AppBuildProvider reload={reload}>Editor</AppBuildProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent chat: bridge unavailable');
    expect(reload).not.toHaveBeenCalled();
    unregister();
  });

  it('does not fall back to recovery reload when Timeline persistence fails', async () => {
    const reload = vi.fn();
    const preserveForRecovery = vi.fn(async () => undefined);
    const unregister = registerDraftSafeReloadGuard({
      label: 'Timeline owner',
      flush: async () => { throw new Error('commit rejected'); },
      isDirty: () => true,
      flushForReload: preserveForRecovery,
      isDirtyForReload: () => false,
    });
    render(<AppBuildProvider reload={reload}><input aria-label="Track name" defaultValue="Keep this unsaved draft" /></AppBuildProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not safely reload: Timeline: commit rejected');
    expect(screen.getByRole('textbox', { name: 'Track name' })).toHaveValue('Keep this unsaved draft');
    expect(preserveForRecovery).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    unregister();
  });

  it('runs another flush wave when an earlier draft becomes dirty while another guard is saving', async () => {
    let timelineDirty = true;
    let timelineFlushes = 0;
    let releaseChat!: () => void;
    const chatPaused = new Promise<void>((resolve) => { releaseChat = resolve; });
    let chatFlushes = 0;
    const unregisterTimeline = registerDraftSafeReloadGuard({
      label: 'Timeline',
      flush: async () => { timelineFlushes++; timelineDirty = false; },
      isDirty: () => timelineDirty,
    });
    const unregisterChat = registerDraftSafeReloadGuard({
      label: 'Agent chat',
      flush: async () => {
        chatFlushes++;
        if (chatFlushes === 1) { await chatPaused; timelineDirty = true; }
      },
    });

    const flushing = flushDraftsBeforeReload();
    releaseChat();
    await flushing;

    expect(timelineFlushes).toBe(2);
    expect(chatFlushes).toBe(2);
    expect(timelineDirty).toBe(false);
    unregisterTimeline();
    unregisterChat();
  });
});

// Exercise the real mounted Timeline owner and local outbox when the commit transport aborts.
it('shows Timeline context and retains the edited draft when a local commit aborts', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createFakeIndexedDB } = await import('fake-indexeddb');
  const { acceptedCommit, fixtureDigest } = await import('@/integrations/runtime/__tests__/timelineCommitFixture.ts');
  const { VideoEditorRuntimeProvider } = await import('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx');
  const { createDefaultTimelineConfig } = await import('@/tools/video-editor/lib/defaults.ts');
  const { buildTimelineData } = await import('@/tools/video-editor/lib/timeline-data.ts');
  const { createInteractionState } = await import('@/tools/video-editor/lib/interaction-state.ts');
  const { createTimelineStore } = await import('@/tools/video-editor/hooks/timelineStore.ts');
  const { useTimelineSave } = await import('@/tools/video-editor/hooks/useTimelineSave.ts');
  const { RuntimeDataProvider } = await import('@/integrations/runtime/dataProvider.ts');
  const { runtimeFixture } = await import('@/test/fakeWorkspaceRuntime.ts');
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
  } });
  const scope = { projectId: 'project-commit', timelineId: 'reload-abort', realmId: 'realm', actorId: 'actor' };
  const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
  const config = createDefaultTimelineConfig();
  config.clips = [{ id: 'source', at: 0, track: 'V1', clipType: 'hold', hold: 2 }];
  const registry = { assets: {} };
  const original = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, scope);
  original.data.canonical_document.parent_revision.payload = { config, registry, clips: config.clips, occurrences: [] };
  original.data.canonical_document.parent_revision.content_digest = fixtureDigest(original.data.canonical_document.parent_revision.payload);
  const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
  const fixture = runtimeFixture();
  const transport = vi.fn<import('@/integrations/runtime/generated.ts').Transport>(async (method, path, headers, body) => {
    if (method === 'POST' && path.endsWith('/commit')) throw new TypeError('Failed to fetch');
    return fixture.transport(method, path, headers, body);
  });
  const runtime = new RuntimeDataProvider({ projectId: scope.projectId, transport });
  const provider: import('@/tools/video-editor/data/DataProvider.ts').DataProvider = {
    persistenceEnabled: true, loadTimeline: async () => ({ config, configVersion: 1, head }),
    loadAssetRegistry: async () => registry, resolveAssetUrl: async file => file, saveTimeline: vi.fn(async () => 2),
    getRecoverableIdentity: async () => ({ realmId: scope.realmId, actorId: scope.actorId }),
    loadTimelineCommandBasis: async () => ({ head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: original.data.canonical_document }),
    commitTimeline: (request, key) => runtime.commitTimeline(request, key),
  };
  const store = createTimelineStore();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const context = { provider, timelineId: scope.timelineId, project: { projectId: scope.projectId }, shots: {}, toast: { error: vi.fn() } } as unknown as import('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx').VideoEditorRuntimeContextValue;
  const interaction = { current: createInteractionState() };
  const reload = vi.fn();
  let save!: ReturnType<typeof useTimelineSave>;
  function Editor() {
    save = useTimelineSave({ timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } }, provider, interaction, store, data);
    return <input aria-label="Track name" value={save.dataRef.current?.config.tracks[0].label ?? ''} onChange={event => {
      const current = save.dataRef.current!;
      save.applyEdit({ type: 'config', resolvedConfig: { ...current.resolvedConfig,
        tracks: current.resolvedConfig.tracks.map((track, index) => index === 0 ? { ...track, label: event.target.value } : track) } });
    }} />;
  }
  try {
    render(<QueryClientProvider client={client}><VideoEditorRuntimeProvider value={context}><AppBuildProvider reload={reload}><Editor /></AppBuildProvider></VideoEditorRuntimeProvider></QueryClientProvider>);
    await waitFor(() => expect(save.isTimelineSavePending()).toBe(false));
    fireEvent.change(screen.getByRole('textbox', { name: 'Track name' }), { target: { value: 'Keep this unsaved draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not safely reload: Timeline:');
    expect(transport.mock.calls.some(([method, path]) => method === 'POST' && path.endsWith('/commit'))).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Track name' })).toHaveValue('Keep this unsaved draft');
    expect(save.dataRef.current?.config.tracks[0].label).toBe('Keep this unsaved draft');
  } finally {
    cleanup(); client.clear();
    if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks');
    vi.unstubAllGlobals();
  }
});
