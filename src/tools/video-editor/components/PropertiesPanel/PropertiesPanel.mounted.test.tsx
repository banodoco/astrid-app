// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { AgentChatProvider, useAgentChatBridge, useAgentChatRegistry } from '@/shared/contexts/AgentChatContext';
import { systemResetSelectionForProjectChange } from '@/shared/state/selectionStore';
import { toast } from '@/shared/components/ui/runtime/sonner';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture';
import { ApiError } from '@/integrations/runtime/generated';
import { VideoEditorProvider } from '../../contexts/VideoEditorProvider';
import { useVideoEditorRuntime } from '../../contexts/VideoEditorRuntimeContext';
import { useTimelineEditorData, useTimelineEditorOps } from '../../hooks/timelineStore';
import { createDefaultTimelineConfig, withDefaultTimelineOutput } from '../../lib/defaults';
import { buildTimelineData } from '../../lib/timeline-data';
import { createCommitOutbox } from '../../commands/commitOutbox';
import { INSTALLED_ASTRID_ELEMENT_HOST } from '../../runtime/astrid-element-components';
import type { DataProvider } from '../../data/DataProvider';
import { PropertiesPanel } from './PropertiesPanel';

vi.mock('../../hooks/useEffects.ts', () => ({ useEffects: () => ({ data: [] }) }));
vi.mock('../../hooks/useFinalVideoAvailable.ts', () => ({ useFinalVideoAvailable: () => ({ finalVideoMap: new Map() }) }));
vi.mock('../../compositions/TimelineRenderer.tsx', () => ({ invalidateReferencedTimelineCache: vi.fn() }));
vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async original => ({
  ...await original<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  SCHEMA_DIGEST: 'sha256:35c2d9c5e0b51ab8d8b7a4f4dbafbdfcb13d232d7bd22fff21cf73e250398d4c',
}));

const scope = { projectId: 'project-commit', timelineId: 'timeline-commit', actorId: 'actor', realmId: 'realm' };
const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
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
  vi.unstubAllGlobals();
  if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
  else Reflect.deleteProperty(navigator, 'locks');
});

it.each(['valid', 'dependent', 'conflict', 'missing', 'copied', 'forged', 'wrong editor', 'stale', 'closed'] as const)(
  'actual property form preserves mounted save ownership: %s', async control => {
    const descriptor = INSTALLED_ASTRID_ELEMENT_HOST.descriptors.find(entry => entry.id === 'text-card' && entry.packId === 'rendering')!;
    const elementRef = { id: descriptor.id, kind: descriptor.kind, packId: descriptor.packId, revision: descriptor.revision };
    const config = { ...createDefaultTimelineConfig(), clips: [
      { id: 'authored', track: 'V1', at: 0, hold: 2, clipType: 'hold', elementRef,
        params: { content: 'Before', future: { keep: [null, false] } } },
      { id: 'sibling', track: 'V1', at: 2, hold: 2, opaque: { keep: null } },
    ] };
    const registry = { assets: {} };
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
      { children: true }).data.canonical_document;
    document.parent_revision.payload = { ...document.parent_revision.payload, config, clips: structuredClone(config.clips), registry, opaque: { keep: null } };
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
    const data = await buildTimelineData(config, registry, async file => file, 1, undefined, head);
    const basis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
    // Hold the ACK so the persisted pending request can be inspected directly.
    let acknowledge!: () => void;
    let acknowledgeFinal!: () => void;
    const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' });
    const canonical = structuredClone(document);
    canonical.parent_revision.revision_id = 'r1';
    const nextConfig = { ...config, clips: config.clips.map(clip => clip.id === 'authored'
      ? { ...clip, params: { ...clip.params, content: 'After' } } : clip) };
    canonical.parent_revision.payload = { ...canonical.parent_revision.payload, config: nextConfig, clips: structuredClone(nextConfig.clips) };
    canonical.parent_revision.content_digest = fixtureDigest(canonical.parent_revision.payload);
    response.data.canonical_document = canonical;
    const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>(() => new Promise(resolve => {
      acknowledge = () => resolve({ response, accepted: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: canonical, graph: {}, receipt: response.receipt });
    }));
    if (control === 'conflict') send.mockRejectedValueOnce(new ApiError(409, 'conflict', 'Property changed', '', {
      status: 'conflict', reason: 'field_changed', head: basis.head,
    }));
    const finalDocument = structuredClone(canonical);
    finalDocument.parent_revision.revision_id = 'r2';
    const finalConfig = { ...nextConfig, clips: nextConfig.clips.map(clip => clip.id === 'authored'
      ? { ...clip, params: { ...clip.params, content: 'Final' } } : clip) };
    finalDocument.parent_revision.payload = { ...finalDocument.parent_revision.payload, config: finalConfig, clips: structuredClone(finalConfig.clips) };
    finalDocument.parent_revision.content_digest = fixtureDigest(finalDocument.parent_revision.payload);
    const legacy = vi.fn(async () => { throw new Error('Legacy writer'); });
    const provider: DataProvider = {
      persistenceEnabled: true, loadTimeline: vi.fn(async () => ({ config, configVersion: 1, head })),
      loadAssetRegistry: vi.fn(async () => registry), resolveAssetUrl: vi.fn(async file => file), saveTimeline: legacy,
      loadTimelineCommandBasis: vi.fn(async () => basis), commitTimeline: send,
      getRecoverableIdentity: vi.fn(async () => ({ actorId: scope.actorId, realmId: scope.realmId })),
    };
    let editor!: ReturnType<typeof useTimelineEditorData>;
    let ops!: ReturnType<typeof useTimelineEditorOps>;
    let chat!: ReturnType<typeof useAgentChatBridge>;
    let registrations!: ReturnType<typeof useAgentChatRegistry>;
    let otherOps!: ReturnType<typeof useTimelineEditorOps>;
    let otherRuntime!: ReturnType<typeof useVideoEditorRuntime>;
    function Capture() {
      editor = useTimelineEditorData(); ops = useTimelineEditorOps();
      chat = useAgentChatBridge(); registrations = useAgentChatRegistry();
      return <PropertiesPanel />;
    }
    function OtherEditor() {
      otherOps = useTimelineEditorOps(); otherRuntime = useVideoEditorRuntime();
      return null;
    }
    const otherProvider = { ...provider, persistenceEnabled: false, loadTimelineCommandBasis: undefined,
      commitTimeline: undefined, getRecoverableIdentity: undefined };
    const errors = vi.spyOn(toast, 'error');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = render(<MemoryRouter><QueryClientProvider client={client}><AgentChatProvider>
      <VideoEditorProvider dataProvider={provider} projectId={scope.projectId} projectSlug={scope.projectId}
        timelineId={scope.timelineId} userId={null} initialTimelineData={data}><Capture /></VideoEditorProvider>
      {control === 'wrong editor' && <VideoEditorProvider dataProvider={otherProvider} projectId={scope.projectId}
        projectSlug={scope.projectId} timelineId={scope.timelineId} userId={null} initialTimelineData={data}><OtherEditor /></VideoEditorProvider>}
    </AgentChatProvider></QueryClientProvider></MemoryRouter>);
    try {
      await waitFor(() => expect(chat.editorContext?.elementOperationAdapter).toBeDefined());
      await act(async () => { ops.selectClip('authored'); });
      await waitFor(() => expect(chat.editorContext?.elementContext?.selectedClips[0]?.id).toBe('authored'));
      await waitFor(async () => expect(await createCommitOutbox().list(scope)).toHaveLength(1));
      const owner = chat.editorContext!;
      expect(editor.data?.head).toEqual(head);
      expect(owner.timelineSummary?.configVersion).toBe(editor.data?.configVersion);
      expect(owner.elementContext?.selectedClips[0]).toMatchObject({ id: 'authored', trackId: 'V1', scope: 'parent-timeline',
        elementRef, params: config.clips[0].params });
      if (control !== 'valid' && control !== 'dependent' && control !== 'conflict' && control !== 'closed') {
        let source = owner;
        if (control === 'missing') source = { ...owner, elementOperationAdapter: undefined, elementContext: undefined };
        if (control === 'copied') source = { ...owner, elementContext: structuredClone(owner.elementContext) };
        if (control === 'forged') source = { ...owner, elementContext: structuredClone(owner.elementContext), elementOperationAdapter: undefined };
        if (control === 'wrong editor') {
          await act(async () => { otherOps.selectClip('authored'); registrations.activate(otherRuntime.agentSelectionOwner); });
          await waitFor(() => expect(chat.editorContext?.elementContext?.selectedClips[0]?.id).toBe('authored'));
          expect(chat.editorContext?.elementOperationAdapter).not.toBe(owner.elementOperationAdapter);
          expect(chat.editorContext?.elementContext).toEqual(owner.elementContext);
        }
        if (control === 'stale') {
          await act(async () => { ops.selectClip('sibling'); });
          await act(async () => { ops.selectClip('authored'); });
          await waitFor(() => expect(chat.editorContext?.elementContext).not.toBe(owner.elementContext));
        }
        if (control !== 'wrong editor') act(() => { registrations.register({ timelineId: scope.timelineId, editorContext: source }, 'attack'); registrations.activate('attack'); });
      }
      fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'After' } });
      if (control === 'closed') view.unmount();
      if (control === 'conflict') {
        await waitFor(() => expect(send).toHaveBeenCalledOnce());
        await waitFor(() => expect(errors).toHaveBeenCalled());
        expect(editor.data?.config.clips[0].params?.content).toBe('Before');
        const [retained] = await createCommitOutbox().list(scope);
        expect(retained.intents).toHaveLength(1);
        expect(legacy).not.toHaveBeenCalled();
        return;
      }
      if (control === 'valid' || control === 'dependent') {
        await waitFor(() => { expect(errors.mock.calls).toEqual([]); expect(send).toHaveBeenCalledOnce(); });
        const [stored] = await createCommitOutbox().list(scope);
        expect(stored.intents).toHaveLength(1);
        expect(stored.pending?.request.key).toBe(send.mock.calls[0][1]);
        expect(send.mock.calls[0][0]).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
          base_revision_id: 'r0', base_publication_id: 'p0', merge: 'atomic', dry_run: false,
          commands: [{ op: 'doc.patch' }], steps: [{ command_ordinals: [0] }] });
        const request = send.mock.calls[0][0];
        expect(request.commands[0].args.changes).toEqual([
          { op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'params', 'content'],
            before: { state: 'present', value: 'Before' }, value: 'After' },
        ]);
        expect(request.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:authored', 'params'],
          state: { state: 'present', value: config.clips[0].params } });
        expect(request.steps?.[0]).toMatchObject({ intent: 'timeline.update_element', tags: [], patch: request.commands[0].args.changes, reads: request.reads });
        expect(request.source).toEqual({ via: 'app' });
        if (control === 'dependent') {
          await waitFor(() => expect(chat.editorContext?.elementContext?.selectedClips[0]?.params?.content).toBe('Before'));
          await act(async () => { acknowledge(); });
          await waitFor(() => expect(editor.data?.head?.headRevisionId).toBe('r1'));
          await waitFor(() => expect(chat.editorContext?.elementContext?.selectedClips[0]?.params?.content).toBe('After'));
          const finalResponse = acceptedCommit({ revision_id: 'r2', publication_id: 'p2' }, { revision_id: 'r1', publication_id: 'p1' });
          finalResponse.data.canonical_document = finalDocument;
          send.mockImplementationOnce(() => new Promise(resolve => {
            acknowledgeFinal = () => resolve({ response: finalResponse, accepted: { revisionId: 'r2', publicationId: 'p2' },
              canonicalDocument: finalDocument, graph: {}, receipt: finalResponse.receipt });
          }));
          fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Final' } });
          await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
          const [chained] = await createCommitOutbox().list(scope);
          expect(chained.intents[0].basis).toEqual({ after: stored.intents[0].id });
          await act(async () => { acknowledgeFinal(); });
        }
        await act(async () => { acknowledge(); });
        await waitFor(() => expect(editor.data?.head?.headRevisionId).toBe(control === 'dependent' ? 'r2' : 'r1'));
        expect(editor.data?.config.clips[0].params).toEqual({ content: control === 'dependent' ? 'Final' : 'After', future: { keep: [null, false] } });
        expect(editor.data?.config.clips[1]).toEqual(data.config.clips[1]);
        const [accepted] = await createCommitOutbox().list(scope);
        expect(accepted.accepted?.value).toMatchObject({ canonicalDocument: control === 'dependent' ? finalDocument : canonical });
        if (control === 'dependent') {
          expect(send.mock.calls[1][0]).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1',
            commands: [{ args: { changes: [{ op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'params', 'content'],
              before: { state: 'present', value: 'After' }, value: 'Final' }] } }] });
        }
        expect(canonical.shot_revisions).toEqual(document.shot_revisions);
      } else {
        await waitFor(() => expect(errors).toHaveBeenCalledWith(control === 'missing'
          ? 'Element parameter ownership changed or is unavailable; reload the timeline before editing.'
          : control === 'closed'
            ? 'The captured editor was closed or replaced. Reopen the current timeline and recover the draft before applying it.'
            : 'Element parameter editor owner changed or is unavailable; draft retained'));
        expect(send).not.toHaveBeenCalled();
        const [stored] = await createCommitOutbox().list(scope);
        expect(stored.intents).toEqual([]);
        expect(stored.pending).toBeUndefined();
        expect(editor.data?.config.clips[0].params?.content).toBe('Before');
      }
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      if (acknowledge) await act(async () => { acknowledge(); });
      view.unmount(); client.clear();
    }
  });

it('mounts the retained native-none two-clip transition clear through selection, outbox, and commit dispatch', async () => {
  const nativeScope = { ...scope, timelineId: 'timeline-native-none' };
  // This is the authored native-none source from the three-products harness.
  // Keep the unknown transition siblings and registry metadata here; the
  // editor projection is produced by buildTimelineData below, while the
  // command basis retains this complete canonical source.
  const nativeNoneTransition = JSON.parse('{"type":"crossfade","duration":0.5,"revision":"native-none-unknown-revision","params":{"nullable":null,"__proto__":{"literal":true},"constructor":{"prototype":[null,false]}},"future":{"ordered":[null,0,false]},"__proto__":{"outer":true},"prototype":false}') as {
    type: string;
    duration: number;
    [key: string]: unknown;
  };
  const canonicalConfig = {
    output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
    tracks: [
      { id: 'V1', kind: 'visual', label: 'V1' },
      { id: 'S1', kind: 'visual', label: 'S1' },
    ],
    clips: [
      {
        id: 'f2-app-clip', track: 'V1', at: 0, clipType: 'media', from: 0, to: 3, speed: 1,
        asset: 'f2-app',
        opaqueClip: { nullable: null, ordered: [false, 0, '', [], { z: 2, a: 1 }] },
        transition: nativeNoneTransition,
      },
      { id: 'f2-transition-clip', track: 'V1', at: 15, clipType: 'media', from: 0, to: 3, speed: 1,
        asset: 'f2-video', transition: { type: 'crossfade', duration: 0.5 } },
    ],
    x_f2_opaque: { owner: 'f2', nested: [1, { k: 'v' }], flag: true },
    app: { 'haus.astrid.scene-phase-markers': { sceneMarkers: [{ id: 'ordinary-marker-a', time: 1 }, { id: 'ordinary-marker-b', time: 6 }] } },
  };
  const config = {
    ...withDefaultTimelineOutput(canonicalConfig),
    x_f2_opaque: canonicalConfig.x_f2_opaque,
    app: canonicalConfig.app,
  };
  const registry = { assets: {
    'f2-app': {
      file: 'f2-app.png', type: 'image/png',
      media_id: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      content_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      generationId: 'generation-f2-app', variantId: 'variant-f2-app',
    },
    'f2-video': {
      file: 'f2-video.mp4', type: 'video/mp4', duration: 12,
      media_id: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      content_sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      generationId: 'generation-f2-video', variantId: 'variant-f2-video',
    },
  } };
  const sourceClips = structuredClone(config.clips);
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
    { children: true, projectId: nativeScope.projectId, timelineId: nativeScope.timelineId }).data.canonical_document;
  for (const shot of document.shot_revisions) shot.shot_id = 'f2-shot';
  for (const pin of document.dependency_manifest.shots) pin.shot_id = 'f2-shot';
  document.parent_revision.payload = {
    slug: 'main',
    name: 'Main',
    config: canonicalConfig,
    clips: sourceClips,
    registry,
    occurrences: [{ occurrence_id: 'f2-occurrence', shot_id: 'f2-shot', shot_revision_id: 'shot-r1',
      placement: { start_ms: 0 }, source_offset: 0, duration_ms: 12000, speed: 1, track: 'S1',
      transform: {}, gain: 1, mute: false, provenance: {} }],
  };
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  const head = { projectId: nativeScope.projectId, timelineId: nativeScope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
  const data = await buildTimelineData(config, registry, async file => file, 1, undefined, head);
  expect(data.config.clips).toEqual(sourceClips);
  expect(data.config.tracks.map(track => track.id)).toEqual(['V1', 'S1']);
  expect(data.registry).toEqual(registry);
  const basis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };

  let acknowledge!: () => void;
  const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' });
  const canonical = structuredClone(document);
  canonical.parent_revision.revision_id = 'r1';
  for (const list of [canonical.parent_revision.payload.config.clips, canonical.parent_revision.payload.clips]) {
    for (const clip of list) {
      if (clip.id === 'f2-app-clip' || clip.id === 'f2-transition-clip') delete clip.transition;
    }
  }
  canonical.parent_revision.content_digest = fixtureDigest(canonical.parent_revision.payload);
  response.data.canonical_document = canonical;
  response.data.document_digest = fixtureDigest(canonical);
  const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>(() => new Promise(resolve => {
    acknowledge = () => resolve({ response, accepted: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: canonical, graph: {}, receipt: response.receipt });
  }));
  const legacy = vi.fn(async () => { throw new Error('Legacy writer'); });
  const provider: DataProvider = {
    persistenceEnabled: true,
    loadTimeline: vi.fn(async () => ({ config, configVersion: 1, head })),
    loadAssetRegistry: vi.fn(async () => registry),
    resolveAssetUrl: vi.fn(async file => file),
    saveTimeline: legacy,
    loadTimelineCommandBasis: vi.fn(async () => basis),
    commitTimeline: send,
    getRecoverableIdentity: vi.fn(async () => ({ actorId: nativeScope.actorId, realmId: nativeScope.realmId })),
  };
  let editor!: ReturnType<typeof useTimelineEditorData>;
  let ops!: ReturnType<typeof useTimelineEditorOps>;
  let chat!: ReturnType<typeof useAgentChatBridge>;
  function Capture() {
    editor = useTimelineEditorData();
    ops = useTimelineEditorOps();
    chat = useAgentChatBridge();
    return <>
      <button type="button" onClick={() => ops.selectClip('f2-app-clip')}>f2-app-clip</button>
      <button type="button" onClick={(event) => ops.selectClip('f2-transition-clip', { toggle: event.shiftKey })}>f2-transition-clip</button>
      <PropertiesPanel />
    </>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const user = userEvent.setup();
  const errors = vi.spyOn(toast, 'error');
  const view = render(<MemoryRouter><QueryClientProvider client={client}><AgentChatProvider>
    <VideoEditorProvider dataProvider={provider} projectId={nativeScope.projectId} projectSlug={nativeScope.projectId}
      timelineId={nativeScope.timelineId} userId={null} initialTimelineData={data}><Capture /></VideoEditorProvider>
  </AgentChatProvider></QueryClientProvider></MemoryRouter>);
  try {
    await waitFor(() => expect(chat.editorContext?.elementOperationAdapter).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'f2-app-clip' }));
    fireEvent.click(screen.getByRole('button', { name: 'f2-transition-clip' }), { shiftKey: true });
    await waitFor(() => expect(screen.getByText('2 clips selected')).toBeInTheDocument());

    expect(editor.data?.config.clips).toEqual(sourceClips);

    const transitionLabel = screen.getByText('Transition');
    const transitionSection = transitionLabel.closest('[class*="md:col-span-2"]') as HTMLElement;
    const transitionSelect = within(transitionSection).getByRole('combobox');
    await user.click(transitionSelect);
    const transitionListId = transitionSelect.getAttribute('aria-controls');
    const noneOption = screen.getAllByRole('option', { name: 'None', exact: true })
      .find(option => option.closest('[role="listbox"]')?.id === transitionListId);
    expect(noneOption).toBeDefined();
    await user.click(noneOption!);
    await waitFor(() => expect(transitionSelect).toHaveTextContent('None'));
    await waitFor(() => expect(editor.data?.config.clips.find(clip => clip.id === 'f2-app-clip')?.transition).toBeUndefined());

    expect(errors).not.toHaveBeenCalled();
    await waitFor(async () => expect((await createCommitOutbox().list(nativeScope))[0]?.intents).toHaveLength(1));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    const [request, idempotencyKey] = send.mock.calls[0];
    const selectedIds = ['f2-app-clip', 'f2-transition-clip'];
    const sourceClip = (id: string) => sourceClips.find(clip => clip.id === id)!;
    const changes = selectedIds.map(id => ({
      op: 'remove' as const, ref: 'parent' as const, path: ['clips', `id:${id}`, 'transition'],
      before: { state: 'present' as const, value: structuredClone(sourceClip(id).transition) },
    }));
    const reads = selectedIds.flatMap(id => [
      { kind: 'field' as const, ref: 'parent' as const, path: ['config', 'clips', `id:${id}`, 'id'], state: { state: 'present' as const, value: sourceClip(id).id } },
      { kind: 'field' as const, ref: 'parent' as const, path: ['config', 'clips', `id:${id}`, 'transition'], state: { state: 'present' as const, value: structuredClone(sourceClip(id).transition) } },
    ]);
    reads.push({ kind: 'field', ref: 'parent', path: ['config', 'pinnedShotGroups'], state: { state: 'absent' } });
    const step = request.steps?.[0];
    expect(step?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotencyKey).toEqual(expect.any(String));
    expect(request).toEqual({
      api_version: 1,
      project_id: nativeScope.projectId,
      timeline_id: nativeScope.timelineId,
      base_revision_id: 'r0',
      base_publication_id: 'p0',
      commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [], args: { changes } }],
      label: 'Edit timeline',
      steps: [{ id: step?.id, label: 'Edit timeline', intent: 'Clear transitions: f2-app-clip, f2-transition-clip', tags: [], command_ordinals: [0], patch: changes, reads }],
      merge: 'fields',
      reads,
      dry_run: false,
      source: { via: 'app' },
    });
    const [stored] = await createCommitOutbox().list(nativeScope);
    expect(stored.pending?.request.key).toBe(idempotencyKey);
    expect(JSON.parse(stored.pending!.request.body)).toEqual(request);
    expect(stored.intents).toHaveLength(1);
    expect(document.parent_revision.payload.config).toEqual(canonicalConfig);
    expect(document.parent_revision.payload.registry).toEqual(registry);
    expect(document.parent_revision.payload.clips).toEqual(sourceClips);
    expect(document.parent_revision.payload.occurrences).toEqual([{ occurrence_id: 'f2-occurrence', shot_id: 'f2-shot', shot_revision_id: 'shot-r1',
      placement: { start_ms: 0 }, source_offset: 0, duration_ms: 12000, speed: 1, track: 'S1',
      transform: {}, gain: 1, mute: false, provenance: {} }]);
    expect(legacy).not.toHaveBeenCalled();
    expect(editor.data?.config.clips.find(clip => clip.id === 'f2-app-clip')?.transition).toBeUndefined();
    await act(async () => { acknowledge(); });
    await waitFor(() => expect(editor.data?.head?.headRevisionId).toBe('r1'));
    expect(editor.data?.config.clips.find(clip => clip.id === 'f2-app-clip')?.transition).toBeUndefined();
    expect(editor.data?.config.clips.find(clip => clip.id === 'f2-transition-clip')?.transition).toBeUndefined();
    expect(canonical.parent_revision.payload.config.x_f2_opaque).toEqual(config.x_f2_opaque);
    expect(canonical.parent_revision.payload.config.app).toEqual(config.app);
    expect(canonical.parent_revision.payload.config.tracks).toEqual(config.tracks);
    expect(canonical.parent_revision.payload.config.clips.find(clip => clip.id === 'f2-app-clip')?.opaqueClip)
      .toEqual(config.clips[0].opaqueClip);
    expect(canonical.parent_revision.payload.registry).toEqual(registry);
    expect(canonical.parent_revision.payload.occurrences).toEqual(document.parent_revision.payload.occurrences);
    expect((await createCommitOutbox().list(nativeScope))[0].accepted?.value).toMatchObject({ canonicalDocument: canonical });
  } finally {
    if (acknowledge) await act(async () => { acknowledge(); });
    view.unmount();
    client.clear();
  }
});
