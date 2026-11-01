import { toast } from '@/shared/components/ui/runtime/sonner.tsx';
import { createElement } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { AstridElementParams } from '../components/PropertiesPanel/AstridElementParams.tsx';
import { useClipEditing } from './useClipEditing.ts';
import type { AgentChatEditorContext } from '@/shared/contexts/AgentChatContext.tsx';
import { AstridElementOperationAdapter, type ElementTimelineRoutes } from '../runtime/element-adapter.ts';
import { saveElementParameterEdit } from './useTimelineSave.ts';
import { useTimelineCommit } from './useTimelineCommit.ts';
import { TimelineEventBus } from './useTimelineEventBus.ts';
import { applyTimelineOperation } from '../runtime/element-adapter.ts';
import { buildAstridAgentElementContext } from '../runtime/element-contract.ts';
import { ASTRID_EFFECT_CATALOG } from '../runtime/astrid-element-catalog.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { WorkspaceClient, type Transport } from '@/integrations/runtime/generated.ts';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox.ts';
import { createLocalSaveSession } from '../commands/localSaveSession.ts';
import { applyPreparedMediaCommand } from '../commands/media.ts';
import { createDefaultTimelineConfig, withDefaultTimelineOutput } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import { emitTimelineSaveDiagnostic } from '../lib/timeline-diagnostics.ts';
import { TimelineSaveError, TimelineVersionConflictError } from '../data/DataProvider.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { createTimelineLocalSaveHandoff, type TimelineSaveSource } from './timelineLocalSaveHandoff.ts';

vi.mock('@/shared/components/ui/runtime/sonner.tsx', () => ({ toast: { error: vi.fn() } }));

const propertyOwner = vi.hoisted(() => ({ context: null as AgentChatEditorContext | null, descriptors: [] as unknown[] }));
vi.mock('@/shared/contexts/AgentChatContext.tsx', () => ({ useOptionalAgentChatBridge: () => ({ editorContext: propertyOwner.context }) }));
vi.mock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx', async importOriginal => ({
  ...await importOriginal<typeof import('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx')>(),
  useVideoEditorRuntime: () => ({ astridElementHost: { descriptors: propertyOwner.descriptors } }),
}));

const contractFixture = vi.hoisted(() => ({ digest: 'sha256:unsupported-test-fixture' }));
const CURRENT_V2_DIGEST = 'sha256:35c2d9c5e0b51ab8d8b7a4f4dbafbdfcb13d232d7bd22fff21cf73e250398d4c';

vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  get SCHEMA_DIGEST() { return contractFixture.digest; },
}));

afterEach(() => { propertyOwner.context = null; vi.mocked(toast.error).mockClear(); contractFixture.digest = 'sha256:unsupported-test-fixture'; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function environment(children = false, raw: boolean | 'property' = false, rawIds = ['authored'], rawApp?: Record<string, unknown>, asset?: { key: string; registry: AssetRegistry; mirror?: boolean | Record<string, unknown>; rawRegistry?: Record<string, unknown> }, topLevel = false, transitions: boolean | 'null' = false, pinned = false, trackMarker = false) {
  const head = { projectId: 'project-commit', timelineId: 'timeline-commit', headRevisionId: 'r0', headPublicationId: 'p0' };
  let source: TimelineSaveSource = { config: createDefaultTimelineConfig(), registry: asset?.registry ?? { assets: {} }, head };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { children }).data.canonical_document;
  const { output: _derived, ...config } = source.config;
  document.parent_revision.payload = { ...document.parent_revision.payload, config, clips: [], registry: source.registry };
  if (raw) {
    const authored = { ...config, output: raw === 'property' ? _derived : { resolution: null, file: null, opaque: { keep: null } },
      ...(raw === 'property' ? {} : { pinnedShotGroups: pinned ? [{ shotId: 'shot-1', trackId: 'V1', clipIds: ['authored'] }] : null }),
      ...(raw === 'property' ? {} : Object.fromEntries([['__proto__', { keep: null }], ['constructor', null]])),
      opaque: { keep: [null, false] }, clips: rawIds.map((id, index) => ({ id, track: 'V1', at: index * 2, hold: 2, clipType: raw === 'property' ? 'hold' : null,
        opaque: { keep: null }, ...(transitions && index < 2 ? { transition: transitions === 'null' ? null : { type: 'crossfade', duration: 0.5, opaque: null } } : {}), ...(rawApp ? { app: rawApp } : {}), ...(asset ? { asset: asset.key } : {}) })) };
    document.parent_revision.payload.config = authored;
    if (asset?.mirror) document.parent_revision.payload.config.registry = structuredClone(asset.mirror === true ? source.registry : asset.mirror);
    document.parent_revision.payload.clips = structuredClone(authored.clips);
    const data = await buildTimelineData({ ...authored,
      ...withDefaultTimelineOutput(authored as unknown as TimelineConfig) } as unknown as TimelineConfig, source.registry);
    source = { config: data.config, registry: data.registry, head };
    if (asset?.rawRegistry) {
      document.parent_revision.payload.registry = asset.rawRegistry;
      if (asset.mirror) document.parent_revision.payload.config.registry = structuredClone(asset.rawRegistry);
    }
  }
  if (trackMarker) {
    source.config.tracks = source.config.tracks.map(track => ({ ...track, app: { scaleAppliesToPositionedClips: true } }));
    (document.parent_revision.payload.config as Record<string, unknown>).tracks = structuredClone(source.config.tracks);
  }
  if (topLevel) delete document.parent_revision.payload.config.clips;
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
  const scope = { realmId: 'realm', actorId: 'actor', projectId: head.projectId, timelineId: head.timelineId };
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_key, work) => work() });
  const send = vi.fn();
  const prepareDisplay = vi.fn<Parameters<typeof createLocalSaveSession>[0]['prepareDisplay']>(async () => { throw new Error('No canonical acceptance expected'); });
  const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(document), outboxes, send,
    loadLatest: vi.fn(async () => initial), changed: vi.fn(),
    prepareDisplay });
  const receipt = vi.fn();
  const handoff = createTimelineLocalSaveHandoff({ initial, source, session, adopted: receipt });
  return { source, initial, scope, outboxes, send, session, receipt, handoff, prepareDisplay };
}

function preparedImageCommand(removeClipId?: string) {
  return { type: 'place-prepared-media' as const, payload: { at: 0, trackId: 'V1',
    ...(removeClipId !== undefined ? { removeClipId } : {}), asset: {
      assetKey: 'import-image', mediaType: 'image' as const, durationSeconds: null, source: 'registered' as const,
      entry: { file: 'import.png', type: 'image/png' }, mediaSelection: { asset: 'import-image',
        generation_id: 'generation', variant_id: 'variant', object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'b'.repeat(64)}` },
    } } };
}

describe('upstream local document handoff', () => {
  it('retains the upstream video preview whose row lacks the hold required by Python media add', async () => {
    const env = await environment();
    const current = await buildTimelineData(env.source.config, env.source.registry);
    const command = { type: 'place-prepared-media' as const, payload: { at: 0, trackId: 'V1', asset: {
      assetKey: 'import-video', mediaType: 'video' as const, durationSeconds: 3, source: 'registered' as const,
      entry: { file: 'import.mp4', type: 'video/mp4', duration: 3 }, mediaSelection: { asset: 'import-video',
        generation_id: 'generation', variant_id: 'variant', object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'b'.repeat(64)}` },
    } } };
    const preview = applyPreparedMediaCommand(current, command)!;
    const row = preview.nextData.config.clips[0];
    expect(row).toMatchObject({ from: 0, to: 3, asset: 'import-video' });
    expect(row.hold).toBeUndefined();
    await expect(env.handoff.capture({ ...env.source, config: preview.nextData.config, registry: preview.nextData.registry },
      { kind: 'prepared-media', config: env.source.config, registry: env.source.registry, clipId: row.id, command }))
      .rejects.toThrow('ordinary image add');
    await expect(env.handoff.capture({ ...env.source, config: preview.nextData.config, registry: preview.nextData.registry }))
      .rejects.toThrow('original Runtime project media selection');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(env.scope))[0].intents).toEqual([]);
    expect(env.send).not.toHaveBeenCalled();
    await env.session.dispose();
  });

  it('allows a valid edit after a refused media gesture has been discarded', async () => {
    const env = await environment();
    const prepared = preparedImageCommand();
    const { mediaSelection: _selection, ...asset } = prepared.payload.asset;
    const command = { ...prepared, payload: { ...prepared.payload, asset } };
    const refused = structuredClone(env.source);
    refused.config.clips.push({ id: 'refused', track: 'V1', at: 0, hold: 2, clipType: 'hold', asset: 'import-image' });
    refused.registry.assets['import-image'] = command.payload.asset.entry;
    await expect(env.handoff.capture(refused, { kind: 'prepared-media', config: env.source.config,
      registry: env.source.registry, clipId: 'refused', command })).rejects.toThrow('Runtime project media selection');
    // Discard the refused preview and author a fresh ordinary edit from the
    // unchanged canonical source, using the same mounted handoff.
    const valid = structuredClone(env.source);
    valid.config.tracks[0].label = 'After discard';
    await expect(env.handoff.capture(valid)).resolves.toBeUndefined();
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(1);
    await env.session.dispose();
  });

  it('persists an image file drop after removing its transient uploading skeleton', async () => {
    const env = await environment(false, false, ['authored'], undefined, undefined, false, false, false, true);
    const current = await buildTimelineData(env.source.config, env.source.registry);
    const skeletonId = 'uploading-test-drop';
    current.rows[0].actions.push({ id: skeletonId, start: 0, end: 2, effectId: `effect-${skeletonId}` });
    current.meta[skeletonId] = { asset: 'uploading:drop.png', track: 'V1', clipType: 'hold', hold: 2 };
    const command = { type: 'place-prepared-media' as const, payload: { at: 0, trackId: 'V1', removeClipId: skeletonId, asset: {
      assetKey: 'import-image', mediaType: 'image' as const, durationSeconds: null, source: 'registered' as const,
      entry: { file: 'import.png', type: 'image/png' }, mediaSelection: { asset: 'import-image',
        generation_id: 'generation', variant_id: 'variant', object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'b'.repeat(64)}` },
    } } };
    const preview = applyPreparedMediaCommand(current, command)!;
    const row = preview.nextData.config.clips[0];
    await env.handoff.capture({ ...env.source, config: preview.nextData.config, registry: preview.nextData.registry },
      { kind: 'prepared-media', config: env.source.config, registry: env.source.registry, clipId: row.id, command });
    const [stored] = await env.outboxes.list(env.scope);
    expect(stored.intents[0].payload).toMatchObject({ commands: [
      { op: 'clip.add-media', args: { row: { id: row.id, asset: 'import-image' } } },
    ] });
    expect(env.session.getDocument()).toMatchObject({ parent_revision: { payload: { config: { clips: [
      { id: row.id, asset: 'import-image' },
    ] } } } });
    await env.session.dispose();
  });

  it('proves the mounted command caller rejects an unknown uploading id before handoff', async () => {
    const env = await environment(false, false, ['authored'], undefined, undefined, false, false, false, true);
    const current = await buildTimelineData(env.source.config, env.source.registry, undefined, 1, undefined, env.source.head);
    const skeletonId = 'uploading-1729800000000-test';
    current.rows[0].actions.push({ id: skeletonId, start: 0, end: 2, effectId: `effect-${skeletonId}` });
    current.meta[skeletonId] = { asset: 'uploading:drop.png', track: 'V1', clipType: 'hold', hold: 2 };
    const eventBus = new TimelineEventBus();
    let capture: Promise<void> | undefined;
    const offSave = eventBus.on('scheduleSave', (next, options) => {
      capture = env.handoff.capture({ config: next.config, registry: next.registry, head: next.head }, options?.gestureBasis);
    });
    const lostEdit = vi.fn();
    const offLost = eventBus.on('lostEdit', lostEdit);
    const mounted = renderHook(() => useTimelineCommit({ eventBus, initialData: current,
      lastSavedSignatureRef: { current: current.stableSignature } }));
    try {
      act(() => mounted.result.current.applyEdit({ type: 'prepared-media', command: preparedImageCommand(skeletonId) }, { semantic: true }));
      await expect(capture).resolves.toBeUndefined();

      const beforeUnknown = mounted.result.current.dataRef.current;
      act(() => mounted.result.current.applyEdit({ type: 'prepared-media', command: preparedImageCommand('uploading-not-present') }, { semantic: true }));
      expect(mounted.result.current.dataRef.current).toBe(beforeUnknown);
      expect(lostEdit).toHaveBeenCalledOnce();
    } finally {
      offLost(); offSave(); mounted.unmount(); await env.session.dispose();
    }
  });

  it.each([
    ['an authored parent id with the transient prefix', false, ['uploading-authored'], 'uploading-authored'],
    ['a child-owned visual track id with the transient prefix', true, ['authored'], 'uploading-child-title'],
  ])('refuses prepared media cleanup of %s', async (_label, children, rawIds, removeClipId) => {
    const env = await environment(children, true, rawIds, undefined, undefined, false, false, false, true);
    const command = preparedImageCommand(removeClipId);
    command.payload.at = 3;
    const next = structuredClone(env.source);
    next.config.clips = next.config.clips.filter(clip => clip.id !== removeClipId);
    next.config.clips.push({ id: 'imported-image', track: 'V1', at: 3, hold: 5, clipType: 'hold', asset: 'import-image' });
    next.registry.assets['import-image'] = { file: 'import.png', type: 'image/png' };
    await expect(env.handoff.capture(next,
      { kind: 'prepared-media', config: env.source.config, registry: env.source.registry, clipId: 'imported-image', command }))
      .rejects.toThrow();
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(env.scope))[0].intents).toEqual([]);
    await env.session.dispose();
  });

  it('refuses a restored media draft without its semantic selection instead of encoding doc.patch', async () => {
    contractFixture.digest = CURRENT_V2_DIGEST;
    const env = await environment();
    const next = structuredClone(env.source);
    next.config.clips = [{ id: 'restored', track: 'V1', at: 0, hold: 2, clipType: 'media', asset: 'new-media' }];
    next.registry.assets['new-media'] = { file: 'import.png', type: 'image/png' };
    await expect(env.handoff.capture(next)).rejects.toThrow('original Runtime project media selection');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(env.scope))[0].intents).toEqual([]);
    expect(env.send).not.toHaveBeenCalled();
    await env.session.dispose();
  });

  it.each([
    ['head', 'capture-input-head-unavailable', 'original verified authoring head is unavailable'],
    ['source', 'source-parent-mismatch', 'upstream source differs from the verified authored parent'],
    ['children', 'child-ownership-unavailable', 'child ownership/fork mapping is unavailable'],
    ['gesture', 'gesture-basis-mismatch', 'gesture read basis differs from the original local authoring input'],
    ['selected clip', 'gesture-clip-ambiguous', 'gesture selected clip has no unique authored binding'],
    ['trim', 'trim-operands-unavailable', 'trim operands are unavailable'],
    ['mirror', 'parent-mirror-mismatch', 'contradictory parent clips mirror'],
    ['nonfinite', 'operation-rejected', 'Outbox values must be finite JSON'],
  ])('observes the existing %s capture guard with identical enabled/disabled rejection behavior', async (kind, code, message) => {
    const outcomes: Array<{ message: string; document: unknown; intents: unknown }> = [];
    for (const enabled of [false, true]) {
      vi.stubGlobal('__timelineSaveDiagnosticsEnabled', enabled);
      const env = await environment(kind === 'children', true);
      let handoff = env.handoff;
      const next = structuredClone(env.source);
      const gesture = structuredClone({ kind: 'trim' as const, clipId: 'authored', patch: { hold: 3 },
        config: env.source.config, registry: env.source.registry });
      if (kind === 'head') next.head!.headRevisionId = 'other';
      if (kind === 'source') {
        const source = structuredClone(env.source);
        source.config.clips[0].at = 9;
        handoff = createTimelineLocalSaveHandoff({ initial: env.initial, source, session: env.session, adopted: env.receipt });
      }
      if (kind === 'gesture') gesture.config.clips[0].at = 9;
      if (kind === 'selected clip') gesture.clipId = 'missing';
      if (kind === 'trim') gesture.patch = {} as typeof gesture.patch;
      if (kind === 'nonfinite') next.config.clips[0].hold = NaN;
      if (kind === 'mirror') {
        env.initial.canonicalDocument.parent_revision.payload.clips = [];
        const document = toOutboxJson(env.initial.canonicalDocument);
        vi.spyOn(env.session, 'getDocument').mockReturnValue(document);
        handoff = createTimelineLocalSaveHandoff({ initial: env.initial, source: env.source, session: env.session, adopted: env.receipt });
      }
      const reject = vi.spyOn(Promise, 'reject');
      const error = await handoff.capture(next, gesture).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(kind === 'head' ? TimelineVersionConflictError : TimelineSaveError);
      expect(error).toHaveProperty('message', `Local document save retained: ${message}`);
      // This is the exact error passed to the existing Promise.reject boundary.
      expect(reject.mock.calls.some(([original]) => original === error)).toBe(true);
      reject.mockRestore();
      const descriptors = Object.getOwnPropertyDescriptors(error);
      const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
      emitTimelineSaveDiagnostic('capture-rejected', () => ({ error }));
      if (enabled) expect((dispatch.mock.lastCall![0] as CustomEvent).detail).toMatchObject({
        errorCode: code, errorClass: kind === 'nonfinite' ? 'UNKNOWN' : kind === 'head' ? 'TimelineVersionConflictError' : 'TimelineSaveError' });
      else expect(dispatch).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
      dispatch.mockRestore();
      expect(env.send).not.toHaveBeenCalled();
      const [stored] = await env.outboxes.list(env.scope);
      expect(stored.intents).toHaveLength(0);
      expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
      outcomes.push({ message: (error as Error).message, document: env.session.getDocument(), intents: stored.intents });
      await env.session.dispose();
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it.each([false, true])('clears only selected parent transitions with full child closure (topLevel=%s)', async (topLevel) => {
    contractFixture.digest = CURRENT_V2_DIGEST;
    const env = await environment(true, true, ['authored', 'sibling', 'untouched'], undefined, undefined, topLevel, true);
    const before = structuredClone(env.initial.canonicalDocument);
    const next = structuredClone(env.source);
    next.config.clips = next.config.clips.map(clip => clip.id === 'untouched' ? clip : { ...clip, transition: undefined });
    await env.handoff.capture(next, { kind: 'transition-clear', clipId: 'authored', clipIds: ['authored', 'sibling'],
      config: env.source.config, registry: env.source.registry });
    const [stored] = await env.outboxes.list(env.scope);
    expect(stored.intents).toHaveLength(1);
    const intent = stored.intents[0].payload.documentIntent as { reads: unknown[]; step: { reads: unknown[] } };
    expect(intent).toMatchObject({ merge: 'fields', roots: [{ ref: 'parent' }] });
    const after = structuredClone(before);
    for (const key of ['authored', 'sibling']) {
      for (const list of [after.parent_revision.payload.clips, after.parent_revision.payload.config.clips]) {
        if (Array.isArray(list)) delete (list.find(row => row.id === key) as Record<string, unknown>).transition;
      }
    }
    expect(env.session.getDocument()).toEqual(after);
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent',
      path: [...(topLevel ? [] : ['config']), 'clips', 'id:authored', 'transition'],
      state: { state: 'present', value: { type: 'crossfade', duration: 0.5, opaque: null } } });
    expect(intent.step.reads).toEqual(intent.reads);
    await env.session.dispose();
  });

  it('removes selected raw null transitions and keeps absent transitions absent across dependent clears', async () => {
    const env = await environment(true, true, ['authored', 'sibling', 'untouched'], undefined, undefined, true, 'null');
    const next = structuredClone(env.source);
    delete next.config.clips[0].transition;
    await env.handoff.capture(next, { kind: 'transition-clear', clipId: 'authored', clipIds: ['authored'],
      config: env.source.config, registry: env.source.registry });
    const expected = structuredClone(env.initial.canonicalDocument);
    delete (expected.parent_revision.payload.clips as Array<Record<string, unknown>>)[0].transition;
    expect(env.session.getDocument()).toEqual(expected);
    const absent = structuredClone(next);
    await env.handoff.capture(absent, { kind: 'transition-clear', clipId: 'untouched', clipIds: ['untouched'],
      config: next.config, registry: next.registry });
    expect(env.session.getDocument()).toEqual(expected);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(1);
    await env.session.dispose();
  });

  for (const kind of ['move', 'transition-clear'] as const) {
    it.each(['sibling', 'track', 'registry', 'bundle', 'output', 'opaque', 'child', 'stale', 'pinned'] as const)(
      `refuses ${kind} carrying an unrelated %s change or selection`, async changed => {
        const env = await environment(true, true, ['authored', 'sibling'], undefined, undefined, false, true, changed === 'pinned');
        const next = structuredClone(env.source);
        const basis = structuredClone({ kind, clipId: 'authored', clipIds: ['authored'], trackId: 'V1',
          config: env.source.config, registry: env.source.registry });
        if (kind === 'move') next.config.clips[0].at = 5;
        else next.config.clips[0].transition = undefined;
        if (changed === 'sibling') next.config.clips[1].at = 7;
        if (changed === 'track') next.config.tracks![0].label = 'unexpected';
        if (changed === 'registry') next.registry.assets.unrelated = { file: 'unexpected.png' };
        if (changed === 'bundle') next.bundle = { schema_version: 1, itemsBySchemaRef: {} };
        if (changed === 'output') next.config.output.fps = 60;
        if (changed === 'opaque') Object.assign(next.config.clips[0], { opaque: { keep: false } });
        if (changed === 'child') { basis.clipId = 'child-title'; basis.clipIds = ['child-title']; }
        if (changed === 'stale') basis.config.clips[0].at = 12;
        await expect(env.handoff.capture(next, basis)).rejects.toBeInstanceOf(TimelineSaveError);
        expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
        expect((await env.outboxes.list(env.scope))[0].intents).toEqual([]);
        expect(env.send).not.toHaveBeenCalled();
        await env.session.dispose();
      });
  }

  it.each([[], ['authored', 'authored'], ['sibling'], ['authored', 'child-title']].map(clipIds => ({ clipIds })))('refuses an ambiguous transition clear selection $clipIds', async ({ clipIds }) => {
    const env = await environment(true, true, ['authored', 'sibling'], undefined, undefined, false, true);
    const next = structuredClone(env.source);
    next.config.clips[0].transition = undefined;
    await expect(env.handoff.capture(next, { kind: 'transition-clear', clipId: 'authored', clipIds,
      config: env.source.config, registry: env.source.registry })).rejects.toThrow('authored parent binding');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(env.scope))[0].intents).toEqual([]);
    await env.session.dispose();
  });

  it('persists original parent move reads and sends the exact dependent request after lost ACK and restart', async () => {
    contractFixture.digest = CURRENT_V2_DIGEST;
    const env = await environment(false, true, ['authored', 'sibling']);
    const move = (source: TimelineSaveSource) => structuredClone({ kind: 'move' as const, clipId: 'authored', trackId: 'V1',
      config: source.config, registry: source.registry });
    const a = structuredClone(env.source);
    a.config.clips[0].at = 5;
    await env.handoff.capture(a, move(env.source));
    const b = structuredClone(a);
    b.config.clips[0].at = 7;
    await env.handoff.capture(b, move(a));
    const [authored] = await env.outboxes.list(env.scope);
    const originalB = structuredClone(authored.intents[1].payload);
    const intent = originalB.documentIntent as { reads: { kind: string; path: string[] }[] };
    expect(intent.merge).toBe('fields');
    expect(authored.intents[1].basis).toEqual({ after: authored.intents[0].id });
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:authored', 'at'],
      state: { state: 'present', value: 5 } });
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:sibling', 'hold'],
      state: { state: 'present', value: 2 } });
    expect(intent.reads).toContainEqual({ kind: 'collection', ref: 'parent', path: ['config', 'clips'],
      members: ['authored', 'sibling'], order: ['authored', 'sibling'] });
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'tracks', 'id:V1', 'kind'],
      state: { state: 'present', value: 'visual' } });
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'pinnedShotGroups'],
      state: { state: 'present', value: null } });
    expect(intent.reads.some((read) => read.kind === 'scope' || read.path.at(-1) === 'label'
      || read.path.join('/') === 'config/tracks')).toBe(false);
    env.prepareDisplay.mockImplementation(async (basis) => ({ document: toOutboxJson(basis.canonicalDocument), adopt() {} }));
    const sent: Parameters<Transport>[] = [];
    const client = new WorkspaceClient('http://runtime.test', 'token', async (...args) => {
      sent.push(args);
      throw new Error('Lost acknowledgement');
    });
    env.send.mockImplementationOnce(async () => {
      const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' });
      response.data.canonical_document = structuredClone(authored.intents[0].payload.after) as unknown as typeof env.initial.canonicalDocument;
      response.data.canonical_document.parent_revision.revision_id = 'r1';
      return { response, accepted: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: response.data.canonical_document,
        receipt: response.receipt, graph: {} };
    }).mockImplementationOnce((request, key) => client.commitTimeline(env.scope.projectId, env.scope.timelineId, request, key));
    await expect(env.session.flush()).rejects.toThrow('unacknowledged');
    const [uncertain] = await env.outboxes.list(env.scope);
    const exact = uncertain.pending!.request;
    const request = JSON.parse(exact.body);
    expect(sent[0].slice(0, 2)).toEqual(['POST', exact.path]);
    expect(sent[0][2]['Idempotency-Key']).toBe(exact.key);
    expect(new TextDecoder().decode(sent[0][3])).toBe(exact.body);
    expect(request).toMatchObject({ api_version: 1, project_id: env.scope.projectId, timeline_id: env.scope.timelineId,
      base_revision_id: 'r1', base_publication_id: 'p1', label: 'Edit timeline', merge: 'fields', reads: intent.reads, dry_run: false,
      commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [], args: { changes: [
        { op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'at'], before: { state: 'present', value: 5 }, value: 7 },
      ] } }], steps: [{ intent: 'Move authored on V1', command_ordinals: [0] }] });
    expect(request.steps[0].patch).toEqual(request.commands[0].args.changes);
    expect(uncertain.intents[0].payload).toEqual(originalB);
    await env.session.dispose();
    const latest = structuredClone(env.initial);
    latest.head = { revisionId: 'agent-r', publicationId: 'agent-p' };
    latest.canonicalDocument.parent_revision.revision_id = 'agent-r';
    const config = latest.canonicalDocument.parent_revision.payload.config as unknown as TimelineConfig;
    config.tracks!.push({ id: 'independent-C', kind: 'visual' });
    config.tracks![0].label = 'Agent label';
    env.send.mockImplementationOnce(async (retry, key) => {
      expect(JSON.stringify(retry)).toBe(exact.body);
      expect(key).toBe(exact.key);
      return client.commitTimeline(env.scope.projectId, env.scope.timelineId, retry, key);
    });
    const recovered = await createLocalSaveSession({ scope: env.scope, initial: latest, document: toOutboxJson(latest.canonicalDocument),
      outboxes: env.outboxes, send: env.send, loadLatest: async () => latest, changed() {}, prepareDisplay: env.prepareDisplay });
    await recovered.recover(uncertain.ownerId);
    expect(recovered.getState().status).toBe('retry');
    expect(sent[1]).toEqual(sent[0]);
    expect((await env.outboxes.list(env.scope))[0].intents[0].payload).toEqual(originalB);
    expect(env.send).toHaveBeenCalledTimes(3);
    await recovered.dispose();
  });

  it('binds declared timing reads to the original input, preserves raw nulls, and refuses a stale gesture basis', async () => {
    const env = await environment(false, true);
    const original = structuredClone({ kind: 'trim' as const, clipId: 'authored', patch: { hold: 3 }, config: env.source.config, registry: env.source.registry });
    const next = structuredClone(env.source);
    next.config.clips[0].hold = 3;
    await env.handoff.capture(next, original);
    const [stored] = await env.outboxes.list(env.scope);
    const intent = stored.intents[0].payload.documentIntent as Record<string, unknown>;
    expect(intent.merge).toBe('fields');
    expect(intent.step).toMatchObject({ intent: 'Trim authored: {"hold":3}' });
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'output', 'fps'],
      state: { state: 'absent' } });
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:authored', 'clipType'],
      state: { state: 'present', value: null } });
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:authored', 'asset'],
      state: { state: 'absent' } });
    expect(intent.reads).not.toContainEqual(expect.objectContaining({ kind: 'scope' }));
    expect(intent.reads).not.toContainEqual(expect.objectContaining({ path: ['config', 'pinnedShotGroups'] }));
    const stale = structuredClone(next);
    stale.config.clips[0].hold = 4;
    const document = env.session.getDocument();
    await expect(env.handoff.capture(stale, original)).rejects.toThrow('gesture read basis differs');
    expect(env.session.getDocument()).toEqual(document);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(1);
    await env.session.dispose();
  });

  it.each(['absent', 'null'] as const)('guards the raw %s assets ancestor instead of inventing a selected entry', async (layout) => {
    const rawRegistry = layout === 'null' ? { assets: null } : {};
    const env = await environment(false, true, ['authored'], undefined,
      { key: 'missing', registry: { assets: {} }, rawRegistry });
    const original = structuredClone({ kind: 'trim' as const, clipId: 'authored', patch: { hold: 1 },
      config: env.source.config, registry: env.source.registry });
    const next = structuredClone(env.source);
    next.config.clips[0].hold = 1;
    await env.handoff.capture(next, original);
    const [stored] = await env.outboxes.list(env.scope);
    expect(stored.intents[0].payload).toMatchObject({ documentIntent: { reads: expect.arrayContaining([
      { kind: 'field', ref: 'parent', path: ['config', 'registry', 'assets'],
        state: layout === 'null' ? { state: 'present', value: null } : { state: 'absent' } },
    ]) } });
    expect(env.session.getDocument()).toMatchObject({ parent_revision: { payload: { registry: rawRegistry } } });
    await env.session.dispose();
  });

  it('refuses a contradictory registry mirror before claiming normalized asset reads', async () => {
    const env = await environment(false, true, ['authored'], undefined,
      { key: 'media', registry: { assets: { media: { file: 'media.mp4' } } }, mirror: { assets: {} } });
    const next = structuredClone(env.source);
    next.config.clips[0].hold = 1;
    await expect(env.handoff.capture(next, { kind: 'trim', clipId: 'authored', patch: { hold: 1 },
      config: env.source.config, registry: env.source.registry })).rejects.toThrow('contradictory parent registry mirror');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect(env.send).not.toHaveBeenCalled();
    await env.session.dispose();
  });

  it.each(['top-level', 'mirror', 'absent'] as const)('guards the exact selected registry entry at the normalized path: %s', async (layout) => {
    const media = { file: 'media.mp4', type: 'video/mp4', duration: 8, opaque: { keep: [null, false] }, optional: null };
    const registry = { assets: { ...(layout === 'absent' ? {} : { media }),
      unused: { file: 'other.mp4', type: 'video/mp4' } } };
    const env = await environment(false, true, ['authored', 'OTHERCLIP'], undefined,
      { key: 'media', registry, mirror: layout === 'mirror' });
    const original = structuredClone({ kind: 'trim' as const, clipId: 'authored', patch: { hold: 1 },
      config: env.source.config, registry: env.source.registry });
    const next = structuredClone(env.source);
    next.config.clips[0].hold = 1;
    await env.handoff.capture(next, original);
    const [stored] = await env.outboxes.list(env.scope);
    const intent = stored.intents[0].payload.documentIntent as { reads: { kind: string; path: string[] }[] };
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'registry', 'assets', 'media'],
      state: layout === 'absent' ? { state: 'absent' } : { state: 'present', value: media } });
    expect(intent.reads.every((read) => read.kind === 'field')).toBe(true);
    expect(intent.reads.some((read) => read.path.includes('id:OTHERCLIP') || read.path.includes('unused') || read.path.includes('tracks'))).toBe(false);
    expect(intent.reads.some((read) => read.path.length <= 2 && read.path.at(-1) === 'clips')).toBe(false);
    expect(env.session.getDocument()).toMatchObject({ parent_revision: { payload: {
      config: { output: { resolution: null, file: null, opaque: { keep: null } }, pinnedShotGroups: null }, registry,
    } } });
    expect(intent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:authored', 'speed'],
      state: { state: 'absent' } });
    await env.session.dispose();
  });

  it('chains exact trim intent removals without clearing omitted opaque fields or restoring them on a partial edit', async () => {
    const env = await environment(false, true, ['authored'], {
      astrid: { for: 19, until: null, opaque: [null, false] }, 'org.example': { clear: null },
    });
    const moved = structuredClone(env.source);
    moved.config.clips[0].at = 1;
    await env.handoff.capture(moved);
    const trimmed = structuredClone(moved);
    trimmed.config.clips[0].hold = 1;
    trimmed.config.clips[0].app = { astrid: {} };
    await env.handoff.capture(trimmed);
    const expected = structuredClone(env.initial.canonicalDocument);
    for (const clips of [expected.parent_revision.payload.clips,
      (expected.parent_revision.payload.config as Record<string, unknown>).clips] as Record<string, unknown>[][]) {
      clips[0].at = 1;
      clips[0].hold = 1;
      clips[0].app = { astrid: { opaque: [null, false] }, 'org.example': { clear: null } };
    }
    expect(env.session.getDocument()).toEqual(expected);
    await env.handoff.capture(structuredClone(trimmed));
    const partial = structuredClone(trimmed);
    delete partial.config.clips[0].app;
    partial.config.clips[0].at = 2;
    await env.handoff.capture(partial);
    const [owner] = await env.outboxes.list(env.scope);
    expect(owner.intents).toHaveLength(3);
    expect(owner.intents[1].basis).toEqual({ after: owner.intents[0].id });
    expect(owner.intents[1].payload).toMatchObject({ documentIntent: { changes: [
      { op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'hold'], before: { state: 'present', value: 2 }, value: 1 },
      { op: 'remove', ref: 'parent', path: ['clips', 'id:authored', 'app', 'astrid', 'for'], before: { state: 'present', value: 19 } },
      { op: 'remove', ref: 'parent', path: ['clips', 'id:authored', 'app', 'astrid', 'until'], before: { state: 'present', value: null } },
    ] } });
    expect(owner.intents[2].basis).toEqual({ after: owner.intents[1].id });
    expect(owner.intents[2].payload).toMatchObject({ documentIntent: { changes: [
      { op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'at'], before: { state: 'present', value: 1 }, value: 2 },
    ] } });
    expect(env.session.getDocument()).toMatchObject({ parent_revision: { payload: {
      clips: [{ app: { astrid: { opaque: [null, false] }, 'org.example': { clear: null } } }],
    } } });
    await env.session.dispose();
  });

  it.each(['app', 'namespace'] as const)('preserves trim intent when a partial view omits the %s container', async (kind) => {
    const app = { astrid: { for: 19, until: null, opaque: [null, false] }, 'org.example': { clear: null } };
    const env = await environment(false, true, ['authored'], app);
    const next = structuredClone(env.source);
    if (kind === 'app') delete next.config.clips[0].app;
    else next.config.clips[0].app = { 'org.example': { clear: null } };
    next.config.clips[0].hold = 1;
    await env.handoff.capture(next);
    const [owner] = await env.outboxes.list(env.scope);
    expect(owner.intents[0].payload).toMatchObject({ documentIntent: { changes: [
      { op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'hold'], before: { state: 'present', value: 2 }, value: 1 },
    ] } });
    expect(env.session.getDocument()).toMatchObject({ parent_revision: { payload: { clips: [{ app }] } } });
    await env.session.dispose();
  });

  it('keeps raw nulls, absence and opaque own keys through a real upstream projection and dependent edits', async () => {
    const env = await environment(false, true);
    const raw = structuredClone(env.initial.canonicalDocument);
    expect(env.source.config.output.resolution).toBe('1280x720');
    expect(env.source.config.pinnedShotGroups).toBeUndefined();
    expect(env.source.config.clips[0].clipType).toBe('hold');
    await env.handoff.capture(structuredClone(env.source));
    expect(env.session.getDocument()).toEqual(raw);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(0);
    const moved = structuredClone(env.source);
    moved.config.clips[0].at = 1;
    await env.handoff.capture(moved);
    const trimmed = structuredClone(moved);
    trimmed.config.clips = [{ id: 'authored', track: 'V1', at: 1, hold: 1 }];
    await env.handoff.capture(trimmed);
    const expected = structuredClone(raw);
    for (const clips of [expected.parent_revision.payload.clips,
      (expected.parent_revision.payload.config as Record<string, unknown>).clips] as Record<string, unknown>[][]) {
      clips[0].at = 1;
      clips[0].hold = 1;
    }
    expect(env.session.getDocument()).toEqual(expected);
    const [owner] = await env.outboxes.list(env.scope);
    expect(owner.intents).toHaveLength(2);
    expect(owner.intents[1].basis).toEqual({ after: owner.intents[0].id });
    expect(owner.intents[1].payload).toMatchObject({ documentIntent: { changes: [
      { op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'hold'], before: { state: 'present', value: 2 }, value: 1 },
    ] } });
    expect(owner.intents[1].payload).not.toHaveProperty('documentIntent.reads');
    const rebuilt = structuredClone(env.source);
    rebuilt.config.clips[0].at = 1;
    rebuilt.config.clips[0].hold = 1;
    await env.handoff.capture(rebuilt);
    expect(env.session.getDocument()).toEqual(expected);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(2);
    await env.session.dispose();
  });

  it('refuses an ambiguous display container clear without changing the raw document or its dependent chain', async () => {
    const env = await environment(false, true);
    const next = structuredClone(env.source);
    next.config.output.resolution = undefined as unknown as string;
    await expect(env.handoff.capture(next)).rejects.toThrow('explicit clear is unavailable');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(0);
    const valid = structuredClone(env.source);
    valid.config.clips[0].hold = 3;
    await env.handoff.capture(valid);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(1);
    await env.session.dispose();
  });

  it('refuses repaired display identities rather than using them to identify authored clips', async () => {
    const env = await environment(false, true, ['authored-dup-1', 'authored-dup-2']);
    expect(env.source.config.clips[0].id).toBe('authored');
    await expect(env.handoff.capture(env.source)).rejects.toThrow('authored clips identity changed in projection');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(0);
    await env.session.dispose();
  });

  it('maps authored source items and registry while preserving opaque parent data and omitting derived output', async () => {
    const env = await environment();
    const next: TimelineSaveSource = structuredClone(env.source);
    next.bundle = { schema_version: 1, itemsBySchemaRef: {} };
    next.registry = { assets: { media: { file: 'media.mp4', type: 'video/mp4' } } };
    await env.handoff.capture(next);
    const candidate = env.session.getDocument();
    expect(candidate).toMatchObject({ parent_revision: { payload: {
      unknown: { nested: ['value', null] }, config: { bundle: next.bundle }, registry: next.registry,
    } } });
    expect(candidate).not.toHaveProperty('parent_revision.payload.config.output');
    next.bundle.itemsBySchemaRef.changed = [];
    expect(env.session.getDocument()).toEqual(candidate);
    await expect(env.handoff.flush()).rejects.toThrow('generated v2 doc.patch contract');
    expect(env.receipt).not.toHaveBeenCalled();
    expect(env.send).not.toHaveBeenCalled();
    await env.session.dispose();
  });

  it('dispatches the original guarded doc.patch through the session when current v2 is supported', async () => {
    contractFixture.digest = CURRENT_V2_DIGEST;
    const env = await environment(false, true);
    const next = structuredClone(env.source);
    next.config.clips[0].at = 1;
    await env.handoff.capture(next);
    env.send.mockRejectedValueOnce(new Error('stop after request inspection'));

    await expect(env.handoff.flush()).rejects.toThrow('draft retained');
    expect(env.send).toHaveBeenCalledTimes(1);
    const [request] = env.send.mock.calls[0];
    expect(request).toMatchObject({
      base_revision_id: 'r0',
      base_publication_id: 'p0',
      label: 'Edit timeline',
      merge: 'atomic',
      dry_run: false,
      commands: [{ op: 'doc.patch', args: { changes: [{
        op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'at'],
        before: { state: 'present', value: 0 }, value: 1,
      }] } }],
      steps: [{ intent: 'Save local editor changes', command_ordinals: [0] }],
    });
    expect(request.steps?.[0].patch).toEqual(request.commands[0].args.changes);
    expect(request).not.toHaveProperty('reads');
    expect(env.receipt).not.toHaveBeenCalled();
    await env.session.dispose();
  });

  it.each(['missing publication', 'refreshed head', 'foreign timeline'] as const)('refuses %s instead of refreshing the authoring basis', async (kind) => {
    const env = await environment();
    const next = structuredClone(env.source);
    if (kind === 'missing publication') delete next.head!.headPublicationId;
    if (kind === 'refreshed head') next.head!.headRevisionId = 'newer-polled-r';
    if (kind === 'foreign timeline') next.head!.timelineId = 'other';
    await expect(env.handoff.capture(next)).rejects.toThrow('original verified authoring head');
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(0);
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    await env.session.dispose();
  });

  it('refuses flattened child/occurrence saves without reconstructing or changing the verified closure', async () => {
    const env = await environment(true);
    const next = structuredClone(env.source);
    next.config.clips = [{ id: 'display-child-title', track: 'V1', at: 0, hold: 2 }];
    await expect(env.handoff.capture(next)).rejects.toThrow('child ownership/fork mapping');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(0);
    await env.session.dispose();
  });

  it('retains source mismatches and invalid values without silently defaulting or laundering them', async () => {
    const env = await environment();
    const mismatch = createTimelineLocalSaveHandoff({ initial: env.initial, source: {
      ...env.source, config: { ...env.source.config, clips: [{ id: 'not-authored', track: 'V1', at: 0, hold: 1 }] },
    }, session: env.session, adopted: env.receipt });
    await expect(mismatch.capture(env.source)).rejects.toThrow('differs from the verified authored parent');
    const bad = structuredClone(env.source);
    bad.config.clips = [{ id: 'bad', track: 'V1', at: 0, hold: NaN }];
    await expect(env.handoff.capture(bad)).rejects.toThrow('finite JSON');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    await env.session.dispose();
  });

  it('encodes explicit transition clearing as guarded removal and retains no-op captures without another intent', async () => {
    const env = await environment();
    const next = structuredClone(env.source);
    next.config.clips = [{ id: 'new', track: 'V1', at: 0, hold: 1, transition: { type: 'fade', duration: 0.1 },
      ...{ opaque: { keep: [null, false] } } }];
    await env.handoff.capture(next);
    await env.handoff.capture(structuredClone(next));
    const cleared = structuredClone(next);
    cleared.config.clips = [{ id: 'new', track: 'V1', at: 0, hold: 1, transition: undefined }];
    await env.handoff.capture(cleared);
    const [stored] = await env.outboxes.list(env.scope);
    expect(stored.intents).toHaveLength(2);
    expect(stored.intents[1].payload).toMatchObject({ documentIntent: {
      changes: [{ op: 'remove', ref: 'parent', path: ['clips', 'id:new', 'transition'],
        before: { state: 'present', value: next.config.clips[0].transition } }],
    } });
    expect(env.session.getDocument()).toMatchObject({ parent_revision: { payload: {
      clips: [{ id: 'new', opaque: { keep: [null, false] } }],
    } } });
    await env.session.dispose();
  });
});


it('captures verified parent element apply/remove while retaining raw children and sibling bytes', async () => {
  contractFixture.digest = CURRENT_V2_DIGEST;
  const env = await environment(true, true, ['authored', 'sibling']);
  const context = buildAstridAgentElementContext({ astridEffects: ASTRID_EFFECT_CATALOG });
  const entry = context.catalog.find(item => item.id === 'text-card' && item.packId === 'rendering')!;
  const operation = { name: 'timeline.apply_element' as const, project: 'project-commit', timeline: 'timeline-commit', expected_version: 1,
    clip_id: 'authored', placement: 'clip' as const, element: { id: entry.id, kind: entry.kind, revision: entry.revision, packId: entry.packId }, params: { color: 'red' } };
  const next = { ...env.source, config: applyTimelineOperation(context, env.source.config, operation) };
  await env.handoff.capture(next, { kind: 'element', config: env.source.config, registry: env.source.registry, clipId: 'authored', operation, context });
  const document = env.session.getDocument() as unknown as typeof env.initial.canonicalDocument;
  expect(document.shot_revisions).toEqual(env.initial.canonicalDocument.shot_revisions);
  expect(document.internal_timeline_revisions).toEqual(env.initial.canonicalDocument.internal_timeline_revisions);
  expect(document.parent_revision.payload.occurrences).toEqual(env.initial.canonicalDocument.parent_revision.payload.occurrences);
  expect(document.parent_revision.payload.config.clips[1]).toEqual(env.initial.canonicalDocument.parent_revision.payload.config.clips[1]);
  expect(document.parent_revision.payload.config.clips[0]).toMatchObject({ elementRef: operation.element, opaque: { keep: null }, clipType: null });
  const remove = { name: 'timeline.remove_element' as const, project: operation.project, timeline: operation.timeline, expected_version: 1, clip_id: 'authored' };
  const removed = { ...next, config: applyTimelineOperation(context, next.config, remove) };
  await env.handoff.capture(removed, { kind: 'element', config: next.config, registry: next.registry, clipId: 'authored', operation: remove, context });
  const final = env.session.getDocument() as unknown as typeof env.initial.canonicalDocument;
  expect(final.parent_revision.payload.config.clips[0]).not.toHaveProperty('elementRef');
  expect(final.shot_revisions).toEqual(document.shot_revisions);
  const [stored] = await env.outboxes.list(env.scope);
  expect(stored.intents).toHaveLength(2);
  expect(stored.intents[1].basis).toEqual({ after: stored.intents[0].id });
  expect(stored.intents[0].payload.documentIntent).toMatchObject({ merge: 'atomic', reads: expect.any(Array), step: { reads: expect.any(Array) } });
  await env.session.dispose();
});

it.each(['registry', 'bundle', 'flattened child'] as const)('refuses an element capture with changed %s provenance', async changed => {
  const env = await environment(true, true);
  const context = buildAstridAgentElementContext({});
  const operation = { name: 'timeline.set_clip_fade' as const, project: 'project-commit', timeline: 'timeline-commit', expected_version: 1, clip_id: 'authored', fade_in: 0.25 };
  const source = structuredClone(env.source);
  if (changed === 'flattened child') source.config.clips.push({ id: 'child-title', track: 'V1', at: 0, hold: 1 });
  const next = { ...source, config: applyTimelineOperation(context, source.config, operation) };
  if (changed === 'registry') next.registry = { assets: { injected: { file: 'new.png' } } };
  if (changed === 'bundle') next.bundle = { schema_version: 1, itemsBySchemaRef: {} };
  await expect(env.handoff.capture(next, { kind: 'element', config: source.config, registry: source.registry, clipId: 'authored', operation, context })).rejects.toThrow();
  expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
  expect((await env.outboxes.list(env.scope))[0].intents).toEqual([]);
  expect(env.send).not.toHaveBeenCalled();
  await env.session.dispose();
});


it.each([false, true])('binds top-level parent element clips and refuses an incomplete mounted view: %s', async missing => {
  const env = await environment(true, true, ['authored', 'sibling'], undefined, undefined, true);
  const source = structuredClone(env.source);
  if (missing) source.config.clips = [];
  const handoff = createTimelineLocalSaveHandoff({ initial: env.initial, source, session: env.session, adopted: env.receipt });
  const context = buildAstridAgentElementContext({});
  const operation = { name: 'timeline.set_clip_fade' as const, project: 'project-commit', timeline: 'timeline-commit', expected_version: 1, clip_id: 'authored', fade_in: 0.25 };
  const next = { ...source, config: missing ? env.source.config : applyTimelineOperation(context, source.config, operation) };
  const capture = handoff.capture(next, { kind: 'element', config: source.config, registry: source.registry, clipId: 'authored', operation, context });
  if (missing) {
    await expect(capture).rejects.toThrow('not present in the mounted source');
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
  } else {
    await capture;
    const document = env.session.getDocument() as unknown as typeof env.initial.canonicalDocument;
    expect(document.parent_revision.payload.config).not.toHaveProperty('clips');
    expect(document.parent_revision.payload.clips[0]).toMatchObject({ id: 'authored', entrance: { type: 'fade', duration: 0.25 } });
    expect(document.parent_revision.payload.clips[1]).toEqual(env.initial.canonicalDocument.parent_revision.payload.clips[1]);
    expect(document.shot_revisions).toEqual(env.initial.canonicalDocument.shot_revisions);
  }
  await env.session.dispose();
});


it.each(['valid', 'missing owner', 'wrong owner', 'stale selection', 'child selection', 'missing head', 'stale head'] as const)(
  'saves or refuses the real element parameter callback on an occurrence-bearing local chain: %s', async control => {
  contractFixture.digest = CURRENT_V2_DIGEST;
  const env = await environment(true, 'property', ['authored', 'sibling']);
  const context = buildAstridAgentElementContext({ astridEffects: ASTRID_EFFECT_CATALOG });
  const entry = context.catalog.find(item => item.id === 'text-card' && item.packId === 'rendering')!;
  const element = { id: entry.id, kind: entry.kind, revision: entry.revision, packId: entry.packId };
  const apply = { name: 'timeline.apply_element' as const, project: 'project-commit', timeline: 'timeline-commit', expected_version: 1,
    clip_id: 'authored', placement: 'clip' as const, element, params: { selectedSegmentIndex: 2, future: 'keep' } };
  let original = { ...env.source, config: applyTimelineOperation(context, env.source.config, apply), config_version: 1 };
  await env.handoff.capture(original, { kind: 'element', config: env.source.config, registry: env.source.registry, clipId: 'authored', operation: apply, context });
  const routes: ElementTimelineRoutes = { get: async () => original, save: vi.fn(async (_id, input) => {
    await env.handoff.capture({ ...original, config: input.config as TimelineConfig, registry: input.registry as AssetRegistry }, {
      kind: 'element', config: original.config, registry: original.registry, clipId: 'authored', operation: input.operation!, context: input.context!,
    });
    original = { ...original, config: input.config as TimelineConfig };
    return original;
  }) };
  const adapter = new AstridElementOperationAdapter(context, routes, 'project-commit', {
    timelineId: 'timeline-commit', assertAuthority: () => {}, getHead: () => original.head,
  });
  propertyOwner.context = { tool: 'video-editor', projectId: 'project-commit', projectSlug: 'project-commit', timelineId: 'timeline-commit', timelineName: null,
    timelineSummary: { configVersion: 1, trackCount: 1, clipCount: 2, assetCount: 0, duration: 4 },
    elementContext: { ...context, selectedClips: [{ id: 'authored', trackId: 'V1', at: 0, duration: 2, elementRef: element,
      params: original.config.clips[0].params, scope: 'parent-timeline' }] }, elementOperationAdapter: adapter };
  propertyOwner.descriptors = [{ ...element, componentPath: 'packs/text-card', schema: { properties: { selectedSegmentIndex: { type: 'number', title: 'Selected Segment Index' } } } }];
  const data = await buildTimelineData(original.config, original.registry);
  data.head = original.head;
  data.configVersion = 1;
  if (control === 'missing owner') propertyOwner.context = null;
  if (control === 'wrong owner') propertyOwner.context!.projectId = 'another-project';
  if (control === 'stale selection') propertyOwner.context!.elementContext!.selectedClips = [{ ...propertyOwner.context!.elementContext!.selectedClips[0], elementRef: { ...element, revision: 'stale' } }];
  if (control === 'child selection') propertyOwner.context!.elementContext!.selectedClips = [{ ...propertyOwner.context!.elementContext!.selectedClips[0], scope: 'child-shot' }];
  if (control === 'missing head') data.head = undefined;
  if (control === 'stale head') data.head = { ...original.head!, headPublicationId: 'another-publication' };
  const beforeGesture = structuredClone(env.session.getDocument());
  const eventBus = new TimelineEventBus();
  let captured: Promise<void> | undefined;
  eventBus.on('scheduleSave', (next, options) => {
    captured = env.handoff.capture({ config: next.config, registry: next.registry, head: next.head }, options?.gestureBasis);
    void captured.catch(() => {});
  });
  const hook = renderHook(() => {
    const commit = useTimelineCommit({ initialData: data, eventBus, lastSavedSignatureRef: { current: data.signature } });
    return useClipEditing({ dataRef: commit.dataRef, resolvedConfig: commit.data?.resolvedConfig ?? null, selectedClipId: 'authored',
      selectedTrack: null, currentTime: 0, selectClip: vi.fn(), setSelectedTrackId: commit.setSelectedTrackId, applyEdit: (mutation, options) => {
        if (options?.gestureBasis?.kind === 'element') {
          adapter.updateContext(options.gestureBasis.context);
          captured = saveElementParameterEdit(commit.dataRef.current!, mutation, options.gestureBasis, routes, 'timeline-commit', adapter.captureForTurn()).then(() => {});
          void captured.catch(() => {});
        } else commit.applyEdit(mutation, options);
      } });
  });
  const form = render(createElement(AstridElementParams, { clip: data.resolvedConfig.clips[0], registry: data.resolvedConfig.registry,
    onChange: patch => hook.result.current.handleSelectedClipChange(patch, propertyOwner.context) }));
  act(() => fireEvent.change(screen.getByLabelText('Selected Segment Index'), { target: { value: '1' } }));
  if (control === 'stale head') {
    expect(captured).toBeDefined();
    await expect(captured).rejects.toThrow('Element parameter owner changed');
    expect(env.session.getDocument()).toEqual(beforeGesture);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(1);
    form.unmount(); hook.unmount();
    await env.session.dispose();
    return;
  }
  if (control !== 'valid') {
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(routes.save).not.toHaveBeenCalled();
    expect(captured).toBeUndefined();
    expect(env.session.getDocument()).toEqual(beforeGesture);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(1);
    expect(env.send).not.toHaveBeenCalled();
    form.unmount(); hook.unmount();
    await env.session.dispose();
    return;
  }
  expect(captured).toBeDefined();
  await captured;
  expect(routes.save).toHaveBeenCalledTimes(1);
  const final = env.session.getDocument() as unknown as typeof env.initial.canonicalDocument;
  expect(final.parent_revision.payload.config.clips[0].params).toEqual({ selectedSegmentIndex: 1, future: 'keep' });
  expect(final.parent_revision.payload.config.clips[1]).toEqual(env.initial.canonicalDocument.parent_revision.payload.config.clips[1]);
  expect(final.shot_revisions).toEqual(env.initial.canonicalDocument.shot_revisions);
  expect(final.internal_timeline_revisions).toEqual(env.initial.canonicalDocument.internal_timeline_revisions);
  expect(final.parent_revision.payload.occurrences).toEqual(env.initial.canonicalDocument.parent_revision.payload.occurrences);
  const [stored] = await env.outboxes.list(env.scope);
  expect(stored.intents[1].basis).toEqual({ after: stored.intents[0].id });
  expect(stored.intents[1].payload.documentIntent).toMatchObject({ merge: 'atomic', reads: expect.arrayContaining([
    expect.objectContaining({ kind: 'field', path: ['config', 'clips', 'id:authored', 'params'], state: { state: 'present', value: { selectedSegmentIndex: 2, future: 'keep' } } }),
  ]) });
  const intent = stored.intents[1].payload.documentIntent as { reads: unknown[]; step: { id: string; reads: unknown[] }; changes: unknown[] };
  expect(intent.changes).toEqual([{ op: 'set', ref: 'parent', path: ['clips', 'id:authored', 'params', 'selectedSegmentIndex'],
    before: { state: 'present', value: 2 }, value: 1 }]);
  expect(intent.step.reads).toEqual(intent.reads);
  env.prepareDisplay.mockImplementation(async basis => ({ document: toOutboxJson(basis.canonicalDocument), adopt() {} }));
  const sent: Parameters<Transport>[] = [];
  const client = new WorkspaceClient('http://runtime.test', 'token', async (...args) => {
    sent.push(args);
    throw new Error('Lost acknowledgement');
  });
  env.send.mockImplementationOnce(async () => {
    const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' });
    response.data.canonical_document = structuredClone(stored.intents[0].payload.after) as unknown as typeof env.initial.canonicalDocument;
    response.data.canonical_document.parent_revision.revision_id = 'r1';
    return { response, accepted: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: response.data.canonical_document,
      receipt: response.receipt, graph: {} };
  }).mockImplementation((request, key) => client.commitTimeline(env.scope.projectId, env.scope.timelineId, request, key));
  await expect(env.session.flush()).rejects.toThrow('unacknowledged');
  const [uncertain] = await env.outboxes.list(env.scope);
  const exact = uncertain.pending!.request;
  const request = JSON.parse(exact.body);
  expect(sent[0].slice(0, 2)).toEqual(['POST', exact.path]);
  expect(sent[0][2]['Idempotency-Key']).toBe(exact.key);
  expect(new TextDecoder().decode(sent[0][3])).toBe(exact.body);
  expect(request).toMatchObject({ api_version: 1, project_id: env.scope.projectId, timeline_id: env.scope.timelineId,
    base_revision_id: 'r1', base_publication_id: 'p1', label: 'Edit timeline', merge: 'atomic', reads: intent.reads,
    source: { via: 'app' }, dry_run: false,
    commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [], args: { changes: intent.changes } }],
    steps: [{ id: intent.step.id, label: 'Edit timeline', intent: 'timeline.update_element', tags: [], command_ordinals: [0], patch: intent.changes, reads: intent.reads }] });
  const latest = { head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: structuredClone(stored.intents[0].payload.after) as unknown as typeof env.initial.canonicalDocument };
  latest.canonicalDocument.parent_revision.revision_id = 'r1';
  const recovered = await createLocalSaveSession({ scope: env.scope, initial: latest, document: toOutboxJson(latest.canonicalDocument),
    outboxes: env.outboxes, send: env.send, loadLatest: async () => latest, changed() {}, prepareDisplay: env.prepareDisplay });
  await recovered.recover(uncertain.ownerId);
  expect(recovered.getState().status).toBe('retry');
  expect(sent[1]).toEqual(sent[0]);
  expect((await env.outboxes.list(env.scope))[0].intents[0].payload).toEqual(stored.intents[1].payload);
  expect(env.handoff.canUndo()).toBe(false);
  await recovered.dispose();
  form.unmount(); hook.unmount(); propertyOwner.context = null;
  await env.session.dispose();
});

describe('prepared image media on a newly created track', () => {
  it.each([['at the bottom', false], ['at the top', true]])('captures one atomic intent for an image drop %s', async (_label, insertAtTop) => {
    contractFixture.digest = CURRENT_V2_DIGEST;
    const env = await environment(false, false, ['authored'], undefined, undefined, false, false, false, true);
    const current = await buildTimelineData(env.source.config, env.source.registry);
    const command = preparedImageCommand();
    command.payload.forceNewTrack = true;
    command.payload.insertAtTop = insertAtTop;
    const preview = applyPreparedMediaCommand(current, command)!;
    const row = preview.nextData.config.clips.find(clip => clip.id === preview.commandResult.detail?.clipId)!;
    await env.handoff.capture({ ...env.source, config: preview.nextData.config, registry: preview.nextData.registry },
      { kind: 'prepared-media', config: env.source.config, registry: env.source.registry, clipId: row.id, command });

    const [stored] = await env.outboxes.list(env.scope);
    expect(stored.intents).toHaveLength(1);
    expect(stored.intents[0].payload.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'track.create', args: { row: expect.objectContaining({ id: row.track, kind: 'visual' }) } }),
      expect.objectContaining({ op: 'clip.add-media', args: { row: expect.objectContaining({ id: row.id, track: row.track, asset: 'import-image' }),
        media: command.payload.asset.mediaSelection } }),
    ]));
    const after = stored.intents[0].payload.after as typeof env.initial.canonicalDocument;
    const tracks = (after.parent_revision.payload.config as Record<string, Array<{ id: string }>>).tracks;
    expect(tracks.map(track => track.id)).toEqual(insertAtTop ? [row.track, ...env.source.config.tracks.map(track => track.id)]
      : [...env.source.config.tracks.map(track => track.id), row.track]);
    expect((after.parent_revision.payload.config as Record<string, Array<Record<string, unknown>>>).clips)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: row.id, track: row.track, asset: 'import-image' })]));
    if (insertAtTop) expect(stored.intents[0].payload.commands.map(command => command.op)).toEqual(['track.create', 'doc.patch', 'clip.add-media']);
    await env.session.dispose();
  });

  it('refuses a prepared-media gesture basis with an unrelated original track edit', async () => {
    contractFixture.digest = CURRENT_V2_DIGEST;
    const env = await environment(false, false, ['authored'], undefined, undefined, false, false, false, true);
    const current = await buildTimelineData(env.source.config, env.source.registry);
    const command = preparedImageCommand();
    command.payload.forceNewTrack = true;
    const preview = applyPreparedMediaCommand(current, command)!;
    const row = preview.nextData.config.clips.find(clip => clip.id === preview.commandResult.detail?.clipId)!;
    const changedTracks = structuredClone(env.source.config.tracks);
    changedTracks[0] = { ...changedTracks[0], label: 'Unrelated edit' };
    await expect(env.handoff.capture({ ...env.source, config: preview.nextData.config, registry: preview.nextData.registry },
      { kind: 'prepared-media', config: { ...env.source.config, tracks: changedTracks }, registry: env.source.registry,
        clipId: row.id, command })).rejects.toBeInstanceOf(TimelineSaveError);
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(env.scope))[0].intents).toHaveLength(0);
    expect(env.send).not.toHaveBeenCalled();
    await env.session.dispose();
  });
});
