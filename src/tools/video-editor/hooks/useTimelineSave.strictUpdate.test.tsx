// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import { pageUpdateOperation } from '@/shared/lib/updates/updateOperation.ts';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { flushDraftsBeforeReload, resetDraftReloadGuardsForTest } from '@/shared/lib/updates/draftSafeReload.ts';
import { UpdateResolutionActions } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { TimelineSaveError, type DataProvider } from '../data/DataProvider.ts';
import { loadTimelineDraft, saveTimelineDraft } from '../data/timelineDraftIndexedDb.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import { createInteractionState } from '../lib/interaction-state.ts';
import { useTimelineSave } from './useTimelineSave.ts';
import { createTimelineStore } from './timelineStore.ts';
import { bindTimelinePersistenceHandoff, TimelinePersistenceHandoffContext, type TimelinePersistenceHandoff } from './timelineLocalSaveHandoff.ts';
import { useEditorBrowserDefaults } from './useEditorBrowserDefaults.ts';
import { AstridElementOperationAdapter } from '../runtime/element-adapter.ts';
import { buildAstridAgentElementContext } from '../runtime/element-contract.ts';
import { ASTRID_EFFECT_CATALOG } from '../runtime/astrid-element-catalog.ts';
import { ProjectChatDraftPersistence } from '../components/AgentChat/projectChatDraftPersistence.ts';

vi.mock('@/shared/contexts/AuthContext.tsx', () => ({ useAuthSafe: () => ({ isAuthenticated: true }) }));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => 'https://astrid.test', runtimeApiBase: () => 'https://astrid.test/api/runtime' }));
vi.mock('../compositions/TimelineRenderer.tsx', () => ({ invalidateReferencedTimelineCache: vi.fn() }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const drain = () => act(async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); });
const timelineId = 'strict-timeline';
const projectId = 'project-commit';
let permission: () => Promise<boolean>;
let updatePosts: RequestInit[];
let runtimeState: string;

beforeEach(() => {
  resetFakeIndexedDB();
  resetDraftReloadGuardsForTest();
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
  } });
  updatePosts = [];
  runtimeState = 'none';
  permission = async () => true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (url.endsWith('/v1/health')) body = { status: 'ok', protocol: 'workspace.v1', schema_digest: 'schema-test',
      runtime_instance_id: 'strict-runtime', runtime_session_id: 'session', runtime_epoch: 1, release: 3, identity: { managed_by: null, release: 3 } };
    else if (url.endsWith('/v1/update/status')) body = { available: true, state: runtimeState,
      ...(runtimeState === 'active' ? { operation_id: '0123456789abcdef0123456789abcdef' } : {}) };
    else if (url.endsWith('/v1/update') && init?.method === 'POST') {
      updatePosts.push(init); runtimeState = 'active';
      body = { accepted: true, state: 'accepted', operation_id: '0123456789abcdef0123456789abcdef', message: 'Update accepted.' };
    } else if (url === '/build.json' || url === '/install-manifest.json') body = { app: 'served-build', release: 4 };
    else throw new Error(`Unexpected request ${url}`);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup();
  resetDraftReloadGuardsForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'locks');
});

async function mountEditor(options: { handoff?: TimelinePersistenceHandoff; local?: boolean; identity?: () => Promise<{ realmId: string; actorId: string }>;
  save?: DataProvider['saveTimeline']; wait?: boolean; recovery?: boolean } = {}) {
  const config = createDefaultTimelineConfig();
  config.clips = [{ id: 'source', at: 0, track: 'V1', clipType: 'hold', hold: 2 }];
  const registry = { assets: {} };
  const head = { projectId, timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
  const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
  const original = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { projectId, timelineId });
  original.data.canonical_document.parent_revision.payload = { config, registry, clips: config.clips, occurrences: [] };
  original.data.canonical_document.parent_revision.content_digest = fixtureDigest(original.data.canonical_document.parent_revision.payload);
  const provider: DataProvider = {
    persistenceEnabled: true, loadTimeline: async () => ({ config, configVersion: 1, head }), loadAssetRegistry: async () => registry,
    resolveAssetUrl: async file => file, saveTimeline: vi.fn(options.save ?? (async () => 2)),
    ...(options.local ? {
      getRecoverableIdentity: options.identity ?? (async () => ({ realmId: 'realm', actorId: 'actor' })),
      loadTimelineCommandBasis: async () => ({ head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: original.data.canonical_document }),
      commitTimeline: vi.fn(async () => { throw new Error('Held local commit'); }),
    } : {}),
  };
  if (options.recovery) await saveTimelineDraft(timelineId, { config: { ...config, output: { ...config.output, file: 'recover-me.mp4' } }, registry }, 1);
  const store = createTimelineStore();
  const interaction = { current: createInteractionState() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const context = { provider, timelineId, project: { projectId }, shots: {}, toast: { error: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
  const binding = options.handoff ? bindTimelinePersistenceHandoff(provider, timelineId, options.handoff) : undefined;
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>
    <VideoEditorRuntimeProvider value={context}><TimelinePersistenceHandoffContext.Provider value={binding}>{children}</TimelinePersistenceHandoffContext.Provider></VideoEditorRuntimeProvider>
  </QueryClientProvider>;
  const root = document.createElement('div'); document.body.appendChild(root);
  const hook = renderHook(({ currentProvider }) => {
    const save = useTimelineSave({ timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } }, currentProvider, interaction, store, data);
    useEditorBrowserDefaults({ shellRoot: root, saveStatus: save.saveStatus, flushPendingSave: save.flushPendingSave,
      preserveTimelineDraftForReload: save.preserveTimelineDraftForReload, isTimelineDraftDurableForReload: save.isTimelineDraftDurableForReload,
      isTimelineSavePending: save.isTimelineSavePending });
    return save;
  }, { wrapper, initialProps: { currentProvider: provider } });
  if (options.wait !== false && !options.recovery) await waitFor(() => expect(hook.result.current.isTimelineSavePending()).toBe(false));
  else await drain();
  const edit = async (file: string) => {
    const current = hook.result.current.dataRef.current!;
    const next = await buildTimelineData({ ...current.config, output: { ...current.config.output, file } }, current.registry, undefined, current.configVersion, undefined, current.head);
    act(() => hook.result.current.commitData(next, { save: true }));
  };
  return { hook, provider, edit, root, head, client };
}
async function mountUpdate(recovery = false) {
  if (recovery) runtimeState = 'recovery-needed';
  const connection = { isConnected: true, state: { status: 'connected' }, confirmPermission: () => permission() } as unknown as RuntimeConnectionValue;
  function Actions() {
    const operation = useInstallerUpdate(connection);
    return <UpdateResolutionActions resolution={resolveUpdate({ installType: 'installer', updateNowAvailable: true,
      ...(recovery ? { updateReason: 'recovery-needed' } : { compatibility: { kind: 'schema', detail: 'Update required' } }) })} operation={operation} />;
  }
  render(<Actions />);
  const button = await screen.findByRole('button', { name: recovery ? 'Update' : 'Update now' });
  await waitFor(() => expect(button).toBeEnabled());
  return () => fireEvent.click(button);
}
function expectNoUpdate() { expect(updatePosts).toHaveLength(0); }

describe('strict D5 mounted editor Update', () => {
  it.each([false, true])('saves before exactly one explicit POST, recovery-needed=%s', async recovery => {
    const editor = await mountEditor();
    await editor.edit('saved.mp4');
    const click = await mountUpdate(recovery);
    expectNoUpdate(); click(); click();
    await waitFor(() => expect(updatePosts).toHaveLength(1));
    expect(editor.provider.saveTimeline).toHaveBeenCalledOnce();
    expect(updatePosts[0].body).toBeUndefined();
    await drain(); expect(updatePosts).toHaveLength(1);
  });

  it.each(['delayed capture', 'failed capture', 'failed flush'] as const)('%s blocks POST and preserves edits', async mode => {
    const captureGate = deferred();
    const handoff = { capture: vi.fn(() => mode === 'failed capture' ? Promise.reject(new TimelineSaveError('capture failed')) : captureGate.promise),
      flush: vi.fn(async () => { throw new TimelineSaveError('flush failed'); }) };
    const editor = await mountEditor({ handoff });
    await editor.edit('unsaved.mp4');
    const click = await mountUpdate(); click(); await drain(); expectNoUpdate();
    if (mode === 'delayed capture') { expect(handoff.flush).not.toHaveBeenCalled(); captureGate.reject(new TimelineSaveError('capture failed')); }
    if (mode === 'failed flush') captureGate.resolve();
    await screen.findByRole('alert'); expectNoUpdate();
    expect(editor.hook.result.current.dataRef.current?.config.output.file).toBe('unsaved.mp4');
    expect((await loadTimelineDraft(timelineId))?.draft.config).toMatchObject({ output: { file: 'unsaved.mp4' } });
  });

  it('delayed capture and delayed flush send only after both acknowledge', async () => {
    const capture = deferred(); const flush = deferred<{ configVersion: number; head: Awaited<ReturnType<typeof mountEditor>>['head'] }>();
    const handoff = { capture: vi.fn(() => capture.promise), flush: vi.fn(() => flush.promise) };
    const editor = await mountEditor({ handoff }); await editor.edit('after-capture.mp4');
    const click = await mountUpdate(); click(); await drain(); expectNoUpdate();
    await act(async () => capture.resolve()); await waitFor(() => expect(handoff.flush).toHaveBeenCalledOnce()); expectNoUpdate();
    await act(async () => flush.resolve({ configVersion: 2, head: editor.head }));
    await waitFor(() => expect(updatePosts).toHaveLength(1)); expect(handoff.capture).toHaveBeenCalledOnce();
  });

  it('an edit during flush denies that click even after the background save succeeds', async () => {
    const gate = deferred<number>();
    let attempt = 0;
    const editor = await mountEditor({ save: async () => ++attempt === 1 ? gate.promise : 3 });
    await editor.edit('A.mp4'); const click = await mountUpdate(); click();
    await waitFor(() => expect(editor.provider.saveTimeline).toHaveBeenCalledOnce());
    await editor.edit('B.mp4'); await act(async () => gate.resolve(2));
    await screen.findByRole('alert'); expectNoUpdate();
    expect(editor.hook.result.current.dataRef.current?.config.output.file).toBe('B.mp4');
    await waitFor(() => expect(editor.hook.result.current.isTimelineSavePending()).toBe(false));
    click(); await waitFor(() => expect(updatePosts).toHaveLength(1));
  });

  it.each(['pending identity', 'failed identity'] as const)('%s blocks even a saved badge', async mode => {
    const gate = deferred<{ realmId: string; actorId: string }>();
    const editor = await mountEditor({ local: true, identity: () => gate.promise, wait: false });
    const click = await mountUpdate(); click(); await drain(); expectNoUpdate();
    expect(editor.hook.result.current.isTimelineSavePending()).toBe(true);
    await act(async () => gate.reject(new Error('identity unavailable')));
    await screen.findByRole('alert'); expectNoUpdate();
  });

  it('an unresolved recovery choice blocks Update without overwriting the recovered draft', async () => {
    await mountEditor({ recovery: true }); const click = await mountUpdate(true); click();
    await screen.findByRole('alert'); expectNoUpdate();
    expect((await loadTimelineDraft(timelineId))?.draft.config).toMatchObject({ output: { file: 'recover-me.mp4' } });
  });

  it.each(['discovery', 'write', 'missing'] as const)('IndexedDB %s failure blocks POST', async failure => {
    if (failure === 'discovery') vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('IndexedDB unavailable'); });
    if (failure === 'missing') vi.stubGlobal('indexedDB', undefined);
    const editor = await mountEditor({ wait: failure === 'write' });
    if (failure === 'write') { vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('IndexedDB full'); }); await editor.edit('storage-failed.mp4'); }
    const click = await mountUpdate(); click(); await screen.findByRole('alert'); expectNoUpdate();
    if (failure === 'write') expect(editor.hook.result.current.dataRef.current?.config.output.file).toBe('storage-failed.mp4');
  });

  it.each(['unmount', 'replacement'] as const)('retains unresolved owner after %s', async change => {
    const gate = deferred<number>(); const editor = await mountEditor({ save: () => gate.promise });
    await editor.edit('retained.mp4'); const click = await mountUpdate(); click();
    await waitFor(() => expect(editor.provider.saveTimeline).toHaveBeenCalledOnce());
    act(() => { if (change === 'unmount') editor.hook.unmount(); else editor.hook.rerender({ currentProvider: {
      ...editor.provider, saveTimeline: vi.fn(async () => { throw new TimelineSaveError('Replacement unresolved'); }),
    } }); });
    await act(async () => gate.resolve(2)); await screen.findByRole('alert'); expectNoUpdate();
    click(); await drain(); expectNoUpdate();
    const leaving = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    expect((await loadTimelineDraft(timelineId))?.draft.config).toMatchObject({ output: { file: 'retained.mp4' } });
  });

  it('edits saved during the permission await still invalidate the original click', async () => {
    const editor = await mountEditor(); const click = await mountUpdate();
    const gate = deferred<boolean>(); const waiting = vi.fn(() => gate.promise); permission = waiting;
    click(); await waitFor(() => expect(waiting).toHaveBeenCalledOnce());
    await editor.edit('permission-edit.mp4');
    await act(async () => { await editor.hook.result.current.flushPendingSave(); });
    await act(async () => gate.resolve(true)); await screen.findByRole('alert'); expectNoUpdate();
    permission = async () => true; click(); await waitFor(() => expect(updatePosts).toHaveLength(1));
  });

  it('recovery preservation never captures or authorizes Update, and every new edit invalidates its marker', async () => {
    const handoff = { capture: vi.fn(async () => {}), flush: vi.fn(async () => { throw new TimelineSaveError('offline'); }) };
    const editor = await mountEditor({ handoff }); await editor.edit('preserved.mp4');
    await act(async () => { await editor.hook.result.current.preserveTimelineDraftForReload(); });
    expect(editor.hook.result.current.isTimelineDraftDurableForReload()).toBe(true);
    expect(handoff.capture).toHaveBeenCalledOnce(); expect(handoff.flush).not.toHaveBeenCalled();
    const click = await mountUpdate(); click(); await screen.findByRole('alert'); expectNoUpdate();
    await editor.edit('newer.mp4'); expect(editor.hook.result.current.isTimelineDraftDurableForReload()).toBe(false);
    expect(handoff.capture).toHaveBeenCalledTimes(2);
  });

  it('tracks a mounted element operation before its save acknowledgement and invalidates recovery', async () => {
    const gate = deferred<number>();
    const editor = await mountEditor({ save: () => gate.promise });
    await act(async () => { await editor.hook.result.current.preserveTimelineDraftForReload(); });
    const context = buildAstridAgentElementContext({ astridEffects: ASTRID_EFFECT_CATALOG });
    const entry = context.catalog.find(item => item.id === 'text-card' && item.packId === 'rendering')!;
    const adapter = new AstridElementOperationAdapter(context, editor.hook.result.current.elementTimelineRoutes, projectId, {
      timelineId, assertAuthority: () => {}, getHead: () => editor.hook.result.current.dataRef.current?.head,
    });
    let execution!: ReturnType<ReturnType<typeof adapter.captureForTurn>['execute']>;
    await act(async () => { execution = adapter.captureForTurn().execute({ name: 'timeline.apply_element', project: projectId,
      timeline: timelineId, expected_version: 1, clip_id: 'source', placement: 'clip',
      element: { id: entry.id, kind: entry.kind, packId: entry.packId, revision: entry.revision } }); });
    await waitFor(() => expect(editor.provider.saveTimeline).toHaveBeenCalledOnce());
    expect(editor.hook.result.current.isTimelineDraftDurableForReload()).toBe(false);
    const click = await mountUpdate(); click(); await screen.findByRole('alert'); expectNoUpdate();
    await act(async () => { gate.resolve(2); await execution; });
    click(); await waitFor(() => expect(updatePosts).toHaveLength(1));
  });

  it.each(['registry patch', 'registry removal', 'config edit'] as const)('invalidates a recovery marker on the actual %s path', async path => {
    const editor = await mountEditor();
    if (path === 'registry removal') {
      act(() => editor.hook.result.current.patchRegistry('asset', { file: 'before.webm', type: 'video/webm' }));
      await act(async () => { await editor.hook.result.current.flushPendingSave(); });
    }
    await act(async () => { await editor.hook.result.current.preserveTimelineDraftForReload(); });
    expect(editor.hook.result.current.isTimelineDraftDurableForReload()).toBe(true);
    act(() => {
      if (path === 'registry patch') editor.hook.result.current.patchRegistry('asset', { file: 'new.webm', type: 'video/webm' });
      else if (path === 'registry removal') editor.hook.result.current.unpatchRegistry('asset');
      else {
        const current = editor.hook.result.current.dataRef.current!;
        editor.hook.result.current.applyEdit({ type: 'config', resolvedConfig: { ...current.resolvedConfig,
          output: { ...current.resolvedConfig.output, file: 'edit.mp4' } } });
      }
      expect(editor.hook.result.current.isTimelineDraftDurableForReload()).toBe(false);
      expect(editor.hook.result.current.isTimelineSavePending()).toBe(true);
    });
  });

  it('a failed chat save followed by success during permission still denies the original click', async () => {
    await mountEditor(); const click = await mountUpdate();
    const gate = deferred<boolean>(); const waiting = vi.fn(() => gate.promise); permission = waiting;
    click(); await waitFor(() => expect(waiting).toHaveBeenCalledOnce());
    const chat = new ProjectChatDraftPersistence(1, { text: '', queue: [] });
    const snapshot = { text: 'later text', queue: [] };
    await expect(chat.save(snapshot, async () => { throw new Error('transient storage failure'); })).rejects.toThrow('transient');
    await chat.save(snapshot, async () => 2);
    await act(async () => gate.resolve(true)); await screen.findByRole('alert'); expectNoUpdate();
    permission = async () => true; click(); await waitFor(() => expect(updatePosts).toHaveLength(1));
  });

  it('invalidates before re-entrant history listeners can dispatch using an earlier save witness', async () => {
    const editor = await mountEditor(); await mountUpdate();
    const validate = await flushDraftsBeforeReload();
    expect(validate()).toBe(true);
    const operation = pageUpdateOperation('https://astrid.test/api/runtime');
    const off = editor.hook.result.current.eventBus.on('beforeCommit', () => {
      expect(validate()).toBe(false);
      void operation.start(validate);
    });
    await editor.edit('reentrant.mp4'); await drain(); expectNoUpdate(); off();
    expect(operation.getSnapshot().error).toContain('Drafts changed');
  });

  it('a synchronous edit failure blocks Update even before the saved badge rerenders', async () => {
    const editor = await mountEditor();
    act(() => editor.hook.result.current.eventBus.emit('lostEdit'));
    expect(editor.hook.result.current.isTimelineSavePending()).toBe(true);
    const click = await mountUpdate(); click(); await screen.findByRole('alert'); expectNoUpdate();
  });

  it('a retained chat draft failure blocks Update until a new explicit click saves it', async () => {
    await mountEditor();
    const chat = new ProjectChatDraftPersistence(1, { text: '', queue: [] });
    let fail = true;
    chat.track({ text: 'unsent chat', queue: [] }, snapshot => chat.save(snapshot, async () => {
      if (fail) throw new Error('chat storage failed'); return 2;
    }));
    chat.mounted = false;
    const click = await mountUpdate(); click(); await screen.findByRole('alert'); expectNoUpdate();
    fail = false; click(); await waitFor(() => expect(updatePosts).toHaveLength(1));
    expect(chat.saved.text).toBe('unsent chat');
  });
});
