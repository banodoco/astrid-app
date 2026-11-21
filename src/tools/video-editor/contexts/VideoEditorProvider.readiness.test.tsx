// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { AgentChatProvider } from '@/shared/contexts/AgentChatContext';
import { systemResetSelectionForProjectChange } from '@/shared/state/selectionStore';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture';
import type { DataProvider, TimelineCommandBasis } from '../data/DataProvider';
import type { TimelineConfig } from '../types';
import type { TimelineEditability } from '../lib/timeline-editability';
import { createDefaultTimelineConfig } from '../lib/defaults';
import { buildTimelineData } from '../lib/timeline-data';
import { useTimelineChromeContext, useTimelineEditorData, useTimelineEditorOps } from '../hooks/timelineStore';
import { TrackLabelContent } from '../components/TimelineEditor/TrackLabel';
import { TimelineEditorShellToolbar } from '../components/TimelineEditorShellToolbar';
import { useVideoEditorRuntime } from './VideoEditorRuntimeContext';
import { VideoEditorProvider } from './VideoEditorProvider';

// Match the existing mounted-provider fixture's non-persistence boundaries.
// The provider, save/track hooks, outbox, editability and visible controls are real.
vi.mock('../hooks/useEffects.ts', () => ({ useEffects: () => ({ data: [] }) }));
vi.mock('../hooks/useFinalVideoAvailable.ts', () => ({ useFinalVideoAvailable: () => ({ finalVideoMap: new Map() }) }));
vi.mock('../compositions/TimelineRenderer.tsx', () => ({ invalidateReferencedTimelineCache: vi.fn() }));

const projectId = 'project-c4-readiness';
const timelineId = 'timeline-c4-readiness';
const renamed = 'P61 copied-realm edit';
const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  localStorage.clear();
  systemResetSelectionForProjectChange();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
  } });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
  else Reflect.deleteProperty(navigator, 'locks');
});

async function mountReadiness(options: {
  hold?: 'original' | 'identity';
  touchChrome?: boolean;
  editability?: TimelineEditability;
} = {}) {
  const gate = deferred();
  const config = { ...createDefaultTimelineConfig(),
    tracks: [{ id: 'V1', kind: 'visual' as const, label: 'Picture' }],
    clips: [{ id: 'existing', track: 'V1', at: 0, hold: 2, text: { content: 'Keep me' } }],
  };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
    { revision_id: 'r0', publication_id: 'p0' }, { projectId, timelineId }).data.canonical_document;
  document.parent_revision.payload = { config, clips: config.clips, registry: { assets: {} }, occurrences: [] };
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  let basis: TimelineCommandBasis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
  const initialData = await buildTimelineData(config, { assets: {} }, async file => file, 1, undefined,
    { projectId, timelineId, headRevisionId: 'r0', headPublicationId: 'p0' });
  let editor!: ReturnType<typeof useTimelineEditorData>;
  let chrome!: ReturnType<typeof useTimelineChromeContext>;
  let ops!: ReturnType<typeof useTimelineEditorOps>;
  let runtime!: ReturnType<typeof useVideoEditorRuntime>;

  function Controls() {
    editor = useTimelineEditorData();
    chrome = useTimelineChromeContext();
    ops = useTimelineEditorOps();
    runtime = useVideoEditorRuntime();
    const track = editor.resolvedConfig?.tracks[0];
    // The actual timeline and Inspector consume this same runtime policy.
    const readOnly = runtime.timelineEditability?.checkTimeline?.().allowed === false;
    return <>
      <TimelineEditorShellToolbar touchChrome={options.touchChrome ?? false} condensed={false}
        documentRow={options.touchChrome ?? false} timelineLoaded={Boolean(track)}
        onDividerPointerDown={() => {}} onDividerPointerMove={() => {}} onDividerPointerUp={() => {}}
        onDividerPointerCancel={() => {}} onDividerLostPointerCapture={() => {}}
        isTimelineMaximized={false} setIsTimelineMaximized={() => {}} />
      {track && <TrackLabelContent track={track} isSelected={false} hasClips deviceClass="desktop"
        readOnly={readOnly} onSelect={() => {}} onRemove={ops.handleRemoveTrack}
        onChange={ops.handleTrackPopoverChange} />}
    </>;
  }

  const commit = vi.fn<NonNullable<DataProvider['commitTimeline']>>(async (request, key) => {
    const next = structuredClone(basis.canonicalDocument);
    for (const command of request.commands) {
      expect(command.op).toBe('doc.patch');
      for (const change of command.args.changes as Array<{ op: string; path: string[]; value?: unknown }>) {
        let target: unknown = next.parent_revision.payload;
        for (const part of change.path.slice(0, -1)) target = part.startsWith('id:')
          ? (target as Array<{ id: string }>).find(row => row.id === part.slice(3))
          : (target as Record<string, unknown>)[part];
        const field = change.path.at(-1)!;
        if (change.op === 'remove') delete (target as Record<string, unknown>)[field];
        else (target as Record<string, unknown>)[field] = structuredClone(change.value);
      }
    }
    next.parent_revision.revision_id = 'r1';
    next.parent_revision.content_digest = fixtureDigest(next.parent_revision.payload);
    const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' },
      { revision_id: request.base_revision_id, publication_id: request.base_publication_id },
      { projectId, timelineId, commands: request.commands });
    Object.assign(response.data, { canonical_document: next, document_digest: fixtureDigest(next),
      merge_mode: request.merge, steps: request.steps, label: request.label, source: request.source });
    response.receipt.idempotency_key = key;
    response.receipt.result = response.data;
    basis = { head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: next };
    return { response, accepted: basis.head, canonicalDocument: next, graph: {}, receipt: response.receipt };
  });
  const loadBasis = vi.fn(async () => {
    if (options.hold === 'original') await gate.promise;
    return structuredClone(basis);
  });
  const identity = vi.fn(async () => {
    if (options.hold === 'identity') await gate.promise;
    return { realmId: 'realm-c4', actorId: 'actor-c4' };
  });
  const provider: DataProvider = {
    loadTimeline: vi.fn(async () => ({ config: initialData.config, configVersion: 1, head: initialData.head })),
    loadAssetRegistry: vi.fn(async () => initialData.registry), resolveAssetUrl: async file => file,
    saveTimeline: vi.fn(), loadTimelineCommandBasis: loadBasis, getRecoverableIdentity: identity,
    commitTimeline: commit,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<MemoryRouter><QueryClientProvider client={client}><AgentChatProvider>
    <VideoEditorProvider dataProvider={provider} projectId={projectId} timelineId={timelineId} userId={null}
      initialTimelineData={initialData} timelineEditability={options.editability}>
      <Controls />
    </VideoEditorProvider>
  </AgentChatProvider></QueryClientProvider></MemoryRouter>);
  return { gate, view, provider, loadBasis, identity, commit, client,
    getEditor: () => editor, getChrome: () => chrome, getOps: () => ops, getRuntime: () => runtime,
    getBasis: () => structuredClone(basis),
  };
}

async function renameOnce(mounted: Awaited<ReturnType<typeof mountReadiness>>) {
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Track name' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox', { name: 'Track name' }), { target: { value: renamed } });
  await waitFor(() => expect(mounted.getEditor().dataRef.current?.config.tracks?.[0].label).toBe(renamed));
  await act(async () => { await mounted.getChrome().flushPendingSave(); });
  expect(mounted.commit).toHaveBeenCalledTimes(1);
  expect(mounted.commit.mock.calls[0][0]).toMatchObject({
    project_id: projectId, timeline_id: timelineId, base_revision_id: 'r0', base_publication_id: 'p0',
    commands: [expect.objectContaining({ op: 'doc.patch', args: expect.objectContaining({
      changes: [expect.objectContaining({ path: ['config', 'tracks', 'id:V1', 'label'], value: renamed })],
    }) })],
  });
  expect((mounted.getBasis().canonicalDocument.parent_revision.payload.config as unknown as TimelineConfig).tracks?.[0].label).toBe(renamed);
  expect(mounted.getBasis().head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
  await waitFor(() => expect(mounted.getChrome().saveStatus).toBe('saved'));
  expect(mounted.provider.saveTimeline).not.toHaveBeenCalled();
}

describe('C4 mounted editor save readiness (#966)', () => {
  it.each([false, true])('holds the original read: loading and no early rename, then exactly one commit (touch=%s)', async touchChrome => {
    const mounted = await mountReadiness({ hold: 'original', touchChrome });
    try {
      await waitFor(() => expect(mounted.loadBasis).toHaveBeenCalled());
      const beforeStatus = mounted.getChrome().saveStatus;
      const beforeBadge = screen.queryByText(/^saved$/i)?.textContent ?? null;
      const earlyInput = screen.queryByRole('textbox', { name: 'Track name' });
      // Preserve the real old failure before the regression assertion rejects it:
      // the offered input edits locally, invalidates the held original, and sends nothing.
      if (earlyInput) {
        fireEvent.change(earlyInput, { target: { value: renamed } });
        await waitFor(() => expect(mounted.getEditor().dataRef.current?.config.tracks?.[0].label).toBe(renamed));
        await act(async () => { mounted.gate.resolve(); });
        let rejection: unknown;
        await act(async () => {
          try { await mounted.getChrome().flushPendingSave(); } catch (error) { rejection = error; }
        });
        expect(String(rejection)).toContain('Local edits preceded the original verified read');
        expect(mounted.commit).toHaveBeenCalledTimes(0);
        console.info('C4 held-read before evidence', { beforeStatus, beforeBadge, earlyInputOffered: true,
          localLabel: mounted.getEditor().dataRef.current?.config.tracks?.[0].label,
          commits: mounted.commit.mock.calls.length, rejection: String(rejection) });
      }
      expect(beforeStatus).toBe('loading');
      expect(beforeBadge).toBeNull();
      expect(earlyInput).toBeNull();
      expect(screen.getByText(/^loading(?:…)?$/i)).toBeVisible();
      expect(mounted.getEditor().dataRef.current?.config.tracks?.[0].label).toBe('Picture');
      expect(mounted.commit).toHaveBeenCalledTimes(0);
      await act(async () => { mounted.gate.resolve(); });
      await renameOnce(mounted);
      console.info('C4 held-read after evidence', { beforeStatus, earlyInputOffered: false,
        commits: mounted.commit.mock.calls.length, acceptedHead: mounted.getBasis().head });
    } finally { mounted.gate.resolve(); mounted.view.unmount(); mounted.client.clear(); }
  });

  it('keeps controls read-only after the original read while the identity/handoff is still pending', async () => {
    const mounted = await mountReadiness({ hold: 'identity' });
    try {
      await waitFor(() => expect(mounted.identity).toHaveBeenCalled());
      expect(mounted.getChrome().saveStatus).toBe('loading');
      expect(screen.queryByRole('textbox', { name: 'Track name' })).toBeNull();
      const policy = mounted.getRuntime().timelineEditability;
      expect(policy?.checkTimeline?.().allowed).toBe(false);
      expect(policy?.check({ clipId: 'existing', sourceTrackId: 'V1', targetTrackId: 'V1' }).allowed).toBe(false);
      expect(policy?.checkMove?.({ clipId: 'existing', sourceTrackId: 'V1', targetTrackId: 'V1', start: 1, duration: 2 }).allowed).toBe(false);
      await act(async () => { mounted.gate.resolve(); });
      await renameOnce(mounted);
    } finally { mounted.gate.resolve(); mounted.view.unmount(); mounted.client.clear(); }
  });

  it('keeps a failed handoff read-only and reports the error instead of Saved', async () => {
    const mounted = await mountReadiness({ hold: 'original' });
    try {
      await waitFor(() => expect(mounted.loadBasis).toHaveBeenCalled());
      await act(async () => { mounted.gate.reject(new Error('Original read refused')); });
      await waitFor(() => expect(mounted.getChrome().saveStatus).toBe('error'));
      expect(screen.queryByRole('textbox', { name: 'Track name' })).toBeNull();
      expect(mounted.getRuntime().timelineEditability?.checkTimeline?.().allowed).toBe(false);
      expect(mounted.commit).toHaveBeenCalledTimes(0);
    } finally { mounted.view.unmount(); mounted.client.clear(); }
  });

  it('preserves the host read-only policy after the handoff becomes ready', async () => {
    const denied = () => ({ allowed: false, reason: 'timeline_read_only' as const });
    const editability = { hardDurationSeconds: 12, checkTimeline: denied, check: denied, checkMove: denied };
    const mounted = await mountReadiness({ hold: 'original', editability });
    try {
      await waitFor(() => expect(mounted.loadBasis).toHaveBeenCalled());
      await act(async () => { mounted.gate.resolve(); });
      await waitFor(() => expect(mounted.getChrome().saveStatus).toBe('saved'));
      expect(screen.queryByRole('textbox', { name: 'Track name' })).toBeNull();
      const policy = mounted.getRuntime().timelineEditability;
      expect(policy?.hardDurationSeconds).toBe(12);
      expect(policy?.checkTimeline?.()).toEqual(denied());
      expect(policy?.check({ clipId: 'existing', sourceTrackId: 'V1', targetTrackId: 'V1' })).toEqual(denied());
      expect(mounted.commit).toHaveBeenCalledTimes(0);
    } finally { mounted.gate.resolve(); mounted.view.unmount(); mounted.client.clear(); }
  });

  it('refuses a retained track callback while the first handoff is pending', async () => {
    const mounted = await mountReadiness({ hold: 'original' });
    try {
      await waitFor(() => expect(mounted.loadBasis).toHaveBeenCalled());
      await act(async () => { mounted.getOps().handleTrackPopoverChange('V1', { label: 'Too early' }); });
      expect(mounted.getEditor().dataRef.current?.config.tracks?.[0].label).toBe('Picture');
      expect(mounted.commit).toHaveBeenCalledTimes(0);
      await act(async () => { mounted.gate.resolve(); });
      await renameOnce(mounted);
    } finally { mounted.gate.resolve(); mounted.view.unmount(); mounted.client.clear(); }
  });
});
