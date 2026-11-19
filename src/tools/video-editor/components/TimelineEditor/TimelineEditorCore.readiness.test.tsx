// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { AgentChatProvider } from '@/shared/contexts/AgentChatContext';
import { systemResetSelectionForProjectChange } from '@/shared/state/selectionStore';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture';
import { VideoEditorProvider } from '../../contexts/VideoEditorProvider';
import { useVideoEditorRuntime } from '../../contexts/VideoEditorRuntimeContext';
import type { DataProvider, TimelineCommandBasis } from '../../data/DataProvider';
import { useTimelineChromeContext, useTimelineEditorData, useTimelineEditorOps } from '../../hooks/timelineStore';
import { createDefaultTimelineConfig } from '../../lib/defaults';
import { buildTimelineData } from '../../lib/timeline-data';
import type { TimelineEditability } from '../../lib/timeline-editability';
import type { TimelineConfig } from '../../types';
import { TimelineEditorCore } from './TimelineEditorCore';

// Only the existing mounted-provider fixture's unrelated catalog/preview
// boundaries are replaced. Core, Canvas, TrackListRenderer, the sortable row,
// TrackLabelContent, provider, editability, save hooks and outbox remain real.
vi.mock('../../hooks/useEffects.ts', () => ({ useEffects: () => ({ data: [] }) }));
vi.mock('../../hooks/useFinalVideoAvailable.ts', () => ({ useFinalVideoAvailable: () => ({ finalVideoMap: new Map() }) }));
vi.mock('../../compositions/TimelineRenderer.tsx', () => ({ invalidateReferencedTimelineCache: vi.fn() }));

const projectId = 'project-c4-production-readiness';
const timelineId = 'timeline-c4-production-readiness';
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

async function makeSource(hold: 'original' | 'identity' | 'none' = 'original') {
  const gate = deferred();
  const config = { ...createDefaultTimelineConfig(),
    tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
    clips: [{ id: 'existing', track: 'V1', at: 0, hold: 2, text: { content: 'Keep me' } }],
  };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
    { revision_id: 'r0', publication_id: 'p0' }, { projectId, timelineId }).data.canonical_document;
  document.parent_revision.payload = { config, clips: config.clips, registry: { assets: {} }, occurrences: [] };
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  let basis: TimelineCommandBasis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
  const initialData = await buildTimelineData(config, { assets: {} }, async file => file, 1, undefined,
    { projectId, timelineId, headRevisionId: 'r0', headPublicationId: 'p0' });
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
    if (hold === 'original') await gate.promise;
    return structuredClone(basis);
  });
  const identity = vi.fn(async () => {
    if (hold === 'identity') await gate.promise;
    return { realmId: 'realm-c4-production', actorId: 'actor-c4-production' };
  });
  const provider: DataProvider = {
    loadTimeline: vi.fn(async () => ({ config: initialData.config, configVersion: 1, head: initialData.head })),
    loadAssetRegistry: vi.fn(async () => initialData.registry), resolveAssetUrl: async file => file,
    saveTimeline: vi.fn(), loadTimelineCommandBasis: loadBasis, getRecoverableIdentity: identity,
    commitTimeline: commit,
  };
  return { gate, config, initialData, provider, loadBasis, identity, commit,
    getBasis: () => structuredClone(basis) };
}

type Source = Awaited<ReturnType<typeof makeSource>>;

function mountCore(source: Source, editability?: TimelineEditability) {
  let editor!: ReturnType<typeof useTimelineEditorData>;
  let chrome!: ReturnType<typeof useTimelineChromeContext>;
  let ops!: ReturnType<typeof useTimelineEditorOps>;
  let runtime!: ReturnType<typeof useVideoEditorRuntime>;
  const sources = [source];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function ProductionCore() {
    editor = useTimelineEditorData();
    chrome = useTimelineChromeContext();
    ops = useTimelineEditorOps();
    runtime = useVideoEditorRuntime();
    // Do not calculate or supply readOnly here: this is the production route
    // whose missing policy propagation the old direct-label fixture bypassed.
    return <TimelineEditorCore />;
  }
  function tree(current: Source) {
    return <MemoryRouter><QueryClientProvider client={client}><AgentChatProvider>
      <VideoEditorProvider dataProvider={current.provider} projectId={projectId} timelineId={timelineId} userId={null}
        initialTimelineData={current.initialData} timelineEditability={editability}>
        <ProductionCore />
      </VideoEditorProvider>
    </AgentChatProvider></QueryClientProvider></MemoryRouter>;
  }
  const view = render(tree(source));
  return { view, getEditor: () => editor, getChrome: () => chrome, getOps: () => ops, getRuntime: () => runtime,
    replaceSource(next: Source) { sources.push(next); view.rerender(tree(next)); },
    dispose() { sources.forEach(current => current.gate.resolve()); view.unmount(); client.clear(); },
  };
}

type Mounted = ReturnType<typeof mountCore>;

function inputEnterBlur(input: HTMLElement, value: string) {
  fireEvent.focus(input);
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  fireEvent.keyUp(input, { key: 'Enter', code: 'Enter' });
  fireEvent.blur(input);
}

function observePendingInput(mounted: Mounted, source: Source, boundary: string) {
  expect(mounted.getRuntime().timelineEditability?.checkTimeline?.().allowed).toBe(false);
  const earlyInput = screen.queryByRole<HTMLInputElement>('textbox', { name: 'Track name' });
  const writable = Boolean(earlyInput && !earlyInput.readOnly && !earlyInput.disabled);
  // Soft only to retain the complete failing-before sequence: on the unfixed
  // Core the input is offered, its edit is refused, then the released owner
  // still proves one persisted rename. This assertion fails that same test.
  expect.soft(writable, `${boundary}: production V1 must not offer an edit while its current policy refuses it`).toBe(false);
  if (writable) inputEnterBlur(earlyInput!, 'Before current handoff');
  expect(mounted.getEditor().dataRef.current?.config.tracks?.[0].label).toBe('V1');
  expect(source.commit).toHaveBeenCalledTimes(0);
  expect(source.getBasis().head).toEqual({ revisionId: 'r0', publicationId: 'p0' });
  console.info('C4 production held-read observation', { boundary, writable,
    domValueAfterInputEnterBlur: earlyInput?.value ?? null,
    controlledLabel: mounted.getEditor().dataRef.current?.config.tracks?.[0].label,
    saveStatus: mounted.getChrome().saveStatus, commits: source.commit.mock.calls.length });
}

async function renameOnce(mounted: Mounted, source: Source) {
  await waitFor(() => expect(mounted.getRuntime().timelineEditability?.checkTimeline?.().allowed).toBe(true));
  const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Track name' });
  expect(input).toBeEnabled();
  expect(input.readOnly).toBe(false);
  inputEnterBlur(input, renamed);
  await waitFor(() => expect(mounted.getEditor().dataRef.current?.config.tracks?.[0].label).toBe(renamed));
  await act(async () => { await mounted.getChrome().flushPendingSave(); });
  expect(source.commit).toHaveBeenCalledTimes(1);
  expect(source.commit.mock.calls[0][0]).toMatchObject({
    project_id: projectId, timeline_id: timelineId, base_revision_id: 'r0', base_publication_id: 'p0',
    commands: [expect.objectContaining({ op: 'doc.patch', args: expect.objectContaining({
      changes: [expect.objectContaining({ path: ['config', 'tracks', 'id:V1', 'label'], value: renamed })],
    }) })],
  });
  const saved = source.getBasis();
  const savedConfig = saved.canonicalDocument.parent_revision.payload.config as unknown as TimelineConfig;
  expect(savedConfig).toEqual({ ...source.config, tracks: [{ ...source.config.tracks[0], label: renamed }] });
  expect(saved.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
  await waitFor(() => expect(mounted.getChrome().saveStatus).toBe('saved'));
  expect(source.provider.saveTimeline).not.toHaveBeenCalled();
  console.info('C4 production persisted rename', { commits: source.commit.mock.calls.length,
    acceptedHead: saved.head, label: savedConfig.tracks?.[0].label });
}

describe('C4 production Core-to-V1 save readiness (#966)', () => {
  it.each(['original', 'identity'] as const)(
    'withholds the production rename while %s is held, then persists exactly one rename', async hold => {
      const source = await makeSource(hold);
      const mounted = mountCore(source);
      try {
        await waitFor(() => expect(hold === 'original' ? source.loadBasis : source.identity).toHaveBeenCalled());
        expect(mounted.getChrome().saveStatus).toBe('loading');
        observePendingInput(mounted, source, hold);
        await act(async () => { source.gate.resolve(); });
        await renameOnce(mounted, source);
      } finally { mounted.dispose(); }
    },
  );

  it.each(['ready', 'pending'] as const)(
    'uses the replacement owner while the earlier owner was %s', async earlier => {
      const previous = await makeSource(earlier === 'ready' ? 'none' : 'original');
      const current = await makeSource('original');
      const mounted = mountCore(previous);
      try {
        await waitFor(() => expect(previous.loadBasis).toHaveBeenCalled());
        if (earlier === 'ready') {
          await waitFor(() => expect(mounted.getRuntime().timelineEditability?.checkTimeline?.().allowed).toBe(true));
          expect(screen.getByRole('textbox', { name: 'Track name' })).toBeEnabled();
        }
        const previousPolicy = mounted.getRuntime().timelineEditability;
        const previousTrackChange = mounted.getOps().handleTrackPopoverChange;
        // Same mounted Core and timeline, new provider/save owner. A ready flag
        // retained from the previous session must not enable the pending one.
        mounted.replaceSource(current);
        await waitFor(() => expect(current.loadBasis).toHaveBeenCalled());
        await act(async () => { previous.gate.resolve(); });
        expect(mounted.getRuntime().provider).toBe(current.provider);
        expect(mounted.getRuntime().timelineEditability).not.toBe(previousPolicy);
        expect(previousPolicy?.checkTimeline?.().allowed).toBe(false);
        await act(async () => { previousTrackChange('V1', { label: 'Stale owner edit' }); });
        expect(previous.commit).toHaveBeenCalledTimes(0);
        observePendingInput(mounted, current, `replacement after ${earlier}`);
        await act(async () => { current.gate.resolve(); });
        await renameOnce(mounted, current);
        expect(previous.commit).toHaveBeenCalledTimes(0);
        expect(previous.getBasis().head).toEqual({ revisionId: 'r0', publicationId: 'p0' });
      } finally { current.gate.resolve(); mounted.dispose(); }
    },
  );

  it('retains the host read-only policy in the production route after handoff', async () => {
    const denied = () => ({ allowed: false, reason: 'timeline_read_only' as const });
    const policy = { hardDurationSeconds: 12, checkTimeline: denied, check: denied, checkMove: denied };
    const source = await makeSource();
    const mounted = mountCore(source, policy);
    try {
      await waitFor(() => expect(source.loadBasis).toHaveBeenCalled());
      await act(async () => { source.gate.resolve(); });
      await waitFor(() => expect(mounted.getChrome().saveStatus).toBe('saved'));
      expect(mounted.getRuntime().timelineEditability?.checkTimeline?.()).toEqual(denied());
      expect(mounted.getRuntime().timelineEditability?.hardDurationSeconds).toBe(12);
      observePendingInput(mounted, source, 'host read-only after handoff');
      expect(source.provider.saveTimeline).not.toHaveBeenCalled();
    } finally { mounted.dispose(); }
  });

  it('keeps the production rename unavailable when the original read fails', async () => {
    const source = await makeSource();
    const mounted = mountCore(source);
    try {
      await waitFor(() => expect(source.loadBasis).toHaveBeenCalled());
      await act(async () => { source.gate.reject(new Error('Original read refused')); });
      await waitFor(() => expect(mounted.getChrome().saveStatus).toBe('error'));
      observePendingInput(mounted, source, 'failed original read');
      expect(source.provider.saveTimeline).not.toHaveBeenCalled();
    } finally { mounted.dispose(); }
  });
});

describe('C4 production track-name presentation during save readiness (#966)', () => {
  it.each(['original', 'identity'] as const)(
    'keeps the named field visible and nonwritable while %s is held, then enables the same field', async hold => {
      const source = await makeSource(hold);
      const mounted = mountCore(source);
      try {
        await waitFor(() => expect(hold === 'original' ? source.loadBasis : source.identity).toHaveBeenCalled());
        const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Track name' });
        expect(field).toBeVisible();
        expect(field).toHaveValue('V1');
        expect(field).toHaveAttribute('readonly');
        expect(screen.queryByRole('button', { name: 'Reorder track' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Track settings' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Remove track' })).toBeNull();
        // Even a synthetic change cannot call the track operation during the hold.
        fireEvent.change(field, { target: { value: 'Denied during handoff' } });
        expect(mounted.getEditor().dataRef.current?.config.tracks?.[0].label).toBe('V1');
        expect(source.commit).toHaveBeenCalledTimes(0);
        expect(mounted.getRuntime().timelineEditability?.checkTimeline?.().allowed).toBe(false);
        await act(async () => { source.gate.resolve(); });
        await renameOnce(mounted, source);
        expect(screen.getByRole('textbox', { name: 'Track name' })).toBe(field);
        expect(field).not.toHaveAttribute('readonly');
      } finally { mounted.dispose(); }
    },
  );

  it('returns the named field to nonwritable presentation for a replacement save owner', async () => {
    const previous = await makeSource('none');
    const current = await makeSource('original');
    const mounted = mountCore(previous);
    try {
      await waitFor(() => expect(mounted.getRuntime().timelineEditability?.checkTimeline?.().allowed).toBe(true));
      expect(screen.getByRole('textbox', { name: 'Track name' })).not.toHaveAttribute('readonly');
      mounted.replaceSource(current);
      await waitFor(() => expect(current.loadBasis).toHaveBeenCalled());
      const field = screen.getByRole('textbox', { name: 'Track name' });
      expect(field).toBeVisible();
      expect(field).toHaveAttribute('readonly');
      fireEvent.change(field, { target: { value: 'Denied on replacement' } });
      expect(mounted.getEditor().dataRef.current?.config.tracks?.[0].label).toBe('V1');
      expect(previous.commit).toHaveBeenCalledTimes(0);
      expect(current.commit).toHaveBeenCalledTimes(0);
      await act(async () => { current.gate.resolve(); });
      await renameOnce(mounted, current);
      expect(previous.commit).toHaveBeenCalledTimes(0);
    } finally { current.gate.resolve(); mounted.dispose(); }
  });

  it('keeps permanent host read-only presentation during and after the save hold', async () => {
    const denied = () => ({ allowed: false, reason: 'timeline_read_only' as const });
    const source = await makeSource('original');
    const mounted = mountCore(source, { checkTimeline: denied, check: denied, checkMove: denied });
    try {
      await waitFor(() => expect(source.loadBasis).toHaveBeenCalled());
      expect(screen.queryByRole('textbox', { name: 'Track name' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reorder track' })).toBeNull();
      await act(async () => { source.gate.resolve(); });
      await waitFor(() => expect(mounted.getChrome().saveStatus).toBe('saved'));
      expect(screen.queryByRole('textbox', { name: 'Track name' })).toBeNull();
      expect(mounted.getRuntime().timelineEditability?.checkTimeline?.()).toEqual(denied());
      expect(source.commit).toHaveBeenCalledTimes(0);
      expect(source.provider.saveTimeline).not.toHaveBeenCalled();
    } finally { mounted.dispose(); }
  });
});
