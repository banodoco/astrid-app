// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __getSelectionStateForTests,
  __resetSelectionStoreForTests,
} from '@/shared/state/selectionStore';
import { applyTimelineMutation, previewTimelineMutation } from '@/tools/video-editor/lib/timeline-mutation-engine';
import { useTimelineCommit } from './useTimelineCommit';
import { useClipEditing } from './useClipEditing';
import { createTimelineLocalSaveHandoff } from './timelineLocalSaveHandoff';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox';
import { createLocalSaveSession } from '../commands/localSaveSession';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture';
import { withDefaultTimelineOutput } from '../lib/defaults';
import { TimelineEventBus } from './useTimelineEventBus';
import { buildTimelineData, configToRows, type TimelineData } from '../lib/timeline-data';
import { getConfigSignature, getStableConfigSignature } from '../lib/config-utils';
import type { PinnedShotImageClipSnapshot, TimelineConfig } from '../types';

function makeVideoModeGroupData(): TimelineData {
  // Video-mode pinned group: a single video clip on V1, plus an imageClipSnapshot
  // recording the previous image clips the group used to have (pre-switch).
  const imageClipSnapshot: PinnedShotImageClipSnapshot[] = [
    {
      clipId: 'clip-img-a',
      assetKey: 'img-a',
      meta: { clipType: 'hold', hold: 1 },
    },
    {
      clipId: 'clip-img-b',
      assetKey: 'img-b',
      meta: { clipType: 'hold', hold: 2 },
    },
  ];

  const config: TimelineConfig = {
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    theme: '2rp',
    theme_overrides: { visual: { canvas: { fps: 24 } } },
    generation_defaults: { model: 'sequence-v1' },
    clips: [
      {
        id: 'clip-video',
        at: 0,
        track: 'V1',
        clipType: 'media',
        asset: 'video-asset',
        from: 0,
        to: 3,
        speed: 1,
      },
    ],
    pinnedShotGroups: [
      {
        shotId: 'shot-1',
        trackId: 'V1',
        clipIds: ['clip-video'],
        mode: 'video',
        videoAssetKey: 'video-asset',
        imageClipSnapshot,
      },
    ],
  };

  const rowData = configToRows(config);
  const resolvedConfig = {
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((t) => ({ ...t })),
    clips: config.clips.map((clip) => ({ ...clip, assetEntry: undefined })),
    registry: {},
    theme: config.theme,
    theme_overrides: config.theme_overrides,
    generation_defaults: config.generation_defaults,
  };

  return {
    config,
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: {},
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((t) => ({ ...t })),
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(resolvedConfig),
    stableSignature: getStableConfigSignature(config, { assets: {} }),
  };
}

function makeSelectionForwardingData(): TimelineData {
  const config: TimelineConfig = {
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [
      { id: 'V1', kind: 'visual', label: 'V1' },
      { id: 'V2', kind: 'visual', label: 'V2' },
    ],
    clips: [
      {
        id: 'clip-old',
        at: 0,
        track: 'V1',
        clipType: 'media',
        hold: 3,
      },
    ],
  };
  const rowData = configToRows(config);
  const resolvedConfig = {
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((t) => ({ ...t })),
    clips: config.clips.map((clip) => ({ ...clip, assetEntry: undefined })),
    registry: {},
  };

  return {
    config,
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: {},
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((t) => ({ ...t })),
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(resolvedConfig),
    stableSignature: getStableConfigSignature(config, { assets: {} }),
  };
}

describe('useTimelineCommit — delete-shot / auto-restore regression', () => {
  beforeEach(() => {
    __resetSelectionStoreForTests();
  });

  it.each([undefined, 'Authored title', 'p1-video.mp4'])('splits the original raw seed without authoring display defaults (label %s)', async (label) => {
    const clip = {
      id: 'p1-chain-source', at: 0, track: 'V1', clipType: 'media', asset: 'p1-video', from: 0, to: 8, speed: 1, hold: 8,
      app: { opaque: { keep: null, ordered: [false, 0, ''] }, astrid: { for: 8 }, 'org.example': { literal: 'p1-chain-source', clear: null } },
      ...(label === undefined ? {} : { label }),
    };
    const config: TimelineConfig = {
      output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
      tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }], clips: [clip],
    };
    Object.assign(config, { opaque: { root: null, order: [0, false] } });
    const registry = { assets: { 'p1-video': { file: 'p1-video.mp4', type: 'video/mp4', duration: 8 } } };
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }).data.canonical_document;
    document.parent_revision.payload = { config, clips: structuredClone(config.clips), registry, opaque: { root: null, order: [0, false] } };
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const head = { projectId: document.project_id, timelineId: document.timeline_id, headRevisionId: 'r0', headPublicationId: 'p0' };
    const initial = { ...await buildTimelineData({ ...config, ...withDefaultTimelineOutput(config) }, registry), head };
    expect(initial.resolvedConfig.clips[0].label).toBe(label ?? 'p1-video.mp4');
    const basis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
    const scope = { realmId: 'realm', actorId: 'actor', projectId: head.projectId, timelineId: head.timelineId };
    const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_key, work) => work() });
    const session = await createLocalSaveSession({ scope, initial: basis, document: toOutboxJson(document), outboxes,
      send: vi.fn(), loadLatest: vi.fn(), prepareDisplay: vi.fn(), changed: vi.fn() });
    const source = { config: initial.config, registry, head };
    const handoff = createTimelineLocalSaveHandoff({ initial: basis, source, session, adopted: vi.fn() });
    const eventBus = new TimelineEventBus();
    const saves: Promise<void>[] = [];
    eventBus.on('scheduleSave', (next, options) => { saves.push(handoff.capture({ config: next.config, registry: next.registry, head }, options?.gestureBasis)); });
    const { result, unmount } = renderHook(() => {
      const commit = useTimelineCommit({ eventBus, lastSavedSignatureRef: { current: '' }, initialData: initial });
      const editing = useClipEditing({ dataRef: commit.dataRef, resolvedConfig: commit.data?.resolvedConfig ?? null,
        selectedClipId: clip.id, selectedTrack: null, currentTime: 2, selectClip: vi.fn(),
        setSelectedTrackId: commit.setSelectedTrackId, applyEdit: commit.applyEdit });
      return { commit, editing };
    });
    try {
      act(() => result.current.editing.handleSplitSelectedClip());
      await Promise.all(saves);
      const next = result.current.commit.dataRef.current!;
      const rightId = next.config.clips[1].id;
      expect(rightId).not.toBe(clip.id);
      expect(next.config.output).toEqual(initial.config.output);
      expect(next.config.clips).toEqual([{ ...clip, hold: 2 }, { ...clip, id: rightId, at: 2, hold: 6 }]);
      if (label === undefined) for (const row of next.config.clips) expect(row).not.toHaveProperty('label');
      const [stored] = await outboxes.list(scope);
      const intent = stored.intents[0].payload.documentIntent as Record<string, unknown>;
      expect(intent.changes).toEqual([
        { op: 'list.insert', ref: 'parent', path: ['clips'], id: rightId, after_id: clip.id,
          before: { state: 'absent' }, order_before: [clip.id], value: { ...clip, id: rightId, at: 2, hold: 6 } },
        { op: 'set', ref: 'parent', path: ['clips', `id:${clip.id}`, 'hold'], before: { state: 'present', value: 8 }, value: 2 },
      ]);
      expect(intent.reads).toEqual([
        ...['id', 'track', 'at', 'clipType', 'hold', 'from', 'to', 'speed', 'asset'].map((key) => ({
          kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${clip.id}`, key],
          state: { state: 'present', value: Reflect.get(clip, key) },
        })),
        { kind: 'field', ref: 'parent', path: ['config', 'output', 'fps'], state: { state: 'present', value: 30 } },
        { kind: 'field', ref: 'parent', path: ['config', 'registry', 'assets', 'p1-video'], state: { state: 'present', value: registry.assets['p1-video'] } },
        { kind: 'collection', ref: 'parent', path: ['config', 'clips'], members: [clip.id], order: [clip.id] },
        { kind: 'field', ref: 'parent', path: ['config', 'pinnedShotGroups'], state: { state: 'absent' } },
      ]);
      expect(session.getDocument()).toMatchObject({ parent_revision: { payload: { config: { output: config.output, clips: next.config.clips }, clips: next.config.clips } } });
      act(() => result.current.commit.applyEdit({ type: 'config', resolvedConfig: {
        ...next.resolvedConfig, output: { ...next.resolvedConfig.output, file: 'intentional.mp4' },
        clips: next.resolvedConfig.clips.map((row) => row.id === clip.id ? { ...row, label: 'Edited title' } : row),
      } }));
      await Promise.all(saves);
      expect(session.getDocument()).toMatchObject({ parent_revision: { payload: { config: { output: { file: 'intentional.mp4' }, clips: [{ id: clip.id, label: 'Edited title' }, { id: rightId }] } } } });
    } finally { unmount(); await session.dispose(); }
  });

  it('retains managed image URLs through track reorder followed by a row edit without persisting URLs', async () => {
    const fixture = makeSelectionForwardingData();
    const registry = { assets: { overlay: { type: 'image', media_id: 'sha256:overlay' } } };
    const config = { ...fixture.config, clips: fixture.config.clips.map((clip) => ({ ...clip, asset: 'overlay' })) };
    const url = '/api/runtime/v1/objects/sha256%3Aoverlay';
    const initial = await buildTimelineData(config, registry, async () => url);
    const eventBus = new TimelineEventBus();
    const saved = vi.fn();
    eventBus.on('scheduleSave', saved);
    const { result } = renderHook(() => useTimelineCommit({
      eventBus, lastSavedSignatureRef: { current: '' }, initialData: initial,
    }));
    act(() => result.current.applyEdit({ type: 'config', resolvedConfig: {
      ...initial.resolvedConfig, tracks: [...initial.resolvedConfig.tracks].reverse(),
    } }));
    act(() => result.current.applyEdit({ type: 'rows', rows: result.current.dataRef.current!.rows }));
    const actual = result.current.dataRef.current!;
    expect(actual.resolvedConfig.registry.overlay.src).toBe(url);
    expect(actual.resolvedConfig.clips[0].assetEntry?.src).toBe(url);
    expect(actual.registry).toEqual(registry);
    expect(saved.mock.calls.at(-1)?.[0].registry).toEqual(registry);
  });

  it('resolves replaced managed identities without reusing old URLs or overwriting a newer edit', async () => {
    const fixture = makeSelectionForwardingData();
    const registry = { assets: { overlay: { type: 'image', media_id: 'sha256:old' } } };
    const config = { ...fixture.config, clips: fixture.config.clips.map((clip) => ({ ...clip, asset: 'overlay' })) };
    const initial = await buildTimelineData(config, registry, async () => '/objects/old');
    const pending = new Map<string, (src: string) => void>();
    const resolveAssetUrl = vi.fn((token: string) => new Promise<string>((resolve) => pending.set(token, resolve)));
    const eventBus = new TimelineEventBus();
    const saved = vi.fn();
    eventBus.on('scheduleSave', saved);
    const { result } = renderHook(() => useTimelineCommit({
      eventBus, lastSavedSignatureRef: { current: '' }, initialData: initial, resolveAssetUrl,
    }));
    act(() => result.current.applyEdit({ type: 'rows', rows: initial.rows,
      registryOverride: { assets: { overlay: { type: 'image', media_id: 'sha256:new' } } },
    }));
    expect(result.current.dataRef.current!.resolvedConfig.registry.overlay).toBeUndefined();
    act(() => result.current.patchRegistry('overlay', { type: 'image', media_id: 'sha256:newest' }));
    await act(async () => { pending.get('sha256:newest')!('/objects/newest'); });
    await waitFor(() => expect(result.current.dataRef.current!.resolvedConfig.registry.overlay.src).toBe('/objects/newest'));
    await act(async () => { pending.get('sha256:new')!('/objects/new'); });
    expect(result.current.dataRef.current!.resolvedConfig.registry.overlay.src).toBe('/objects/newest');
    expect(result.current.dataRef.current!.resolvedConfig.clips[0].assetEntry?.src).toBe('/objects/newest');
    expect(result.current.dataRef.current!.registry.assets.overlay).toEqual({ type: 'image', media_id: 'sha256:newest' });
    expect(saved).toHaveBeenCalledTimes(2); // Only the edits, never URL hydration.
  });

  it('refuses an edit before changing data or scheduling persistence when the timeline guard denies it', () => {
    const eventBus = new TimelineEventBus();
    const scheduleSave = vi.fn();
    const editability = { checkTimeline: vi.fn(() => ({ allowed: false as const, reason: 'timeline_read_only' as const })) };
    eventBus.on('scheduleSave', scheduleSave);
    const { result } = renderHook(() => useTimelineCommit({
      eventBus,
      lastSavedSignatureRef: { current: '' },
      editability,
    }));
    act(() => result.current.commitData(makeVideoModeGroupData(), { save: false }));
    const initial = result.current.dataRef.current;
    const beforeEditSeq = result.current.editSeqRef.current;

    act(() => result.current.applyEdit({
      type: 'rows',
      rows: initial!.rows.map((row) => ({ ...row, actions: [] })),
      metaDeletes: ['clip-video'],
    }));
    act(() => {
      result.current.patchRegistry('new-asset', { file: 'https://example.com/new.png', type: 'image/png' });
      result.current.unpatchRegistry('video-asset');
    });

    expect(editability.checkTimeline).toHaveBeenCalledTimes(3);
    expect(result.current.dataRef.current).toBe(initial);
    expect(result.current.editSeqRef.current).toBe(beforeEditSeq);
    expect(scheduleSave).not.toHaveBeenCalled();
  });

  it('deleting a video-mode group\'s video clip does NOT auto-insert image snapshots', () => {
    const eventBus = new TimelineEventBus();
    const lastSavedSignatureRef = { current: '' };

    const { result } = renderHook(() => useTimelineCommit({
      eventBus,
      lastSavedSignatureRef,
    }));

    // Seed the hook with the initial timeline data.
    act(() => {
      result.current.commitData(makeVideoModeGroupData(), { save: false });
    });

    const initial = result.current.dataRef.current!;
    expect(initial.rows[0].actions.map((a) => a.id)).toEqual(['clip-video']);
    expect(initial.config.pinnedShotGroups?.[0].clipIds).toEqual(['clip-video']);
    expect(initial.config.pinnedShotGroups?.[0].mode).toBe('video');
    expect(initial.config.pinnedShotGroups?.[0].imageClipSnapshot).toHaveLength(2);

    // Delete the video clip via a rows mutation: rows now have no actions on V1,
    // and the video clip's meta is deleted. No pinnedShotGroupsOverride is passed,
    // so the reconciler (deleted) is the only code that *would* have re-inserted
    // the image snapshots. This test proves that behavior is gone.
    const rowsWithoutVideo = initial.rows.map((row) => ({ ...row, actions: [] }));

    act(() => {
      result.current.applyEdit({
        type: 'rows',
        rows: rowsWithoutVideo,
        metaDeletes: ['clip-video'],
      }, { save: false });
    });

    const after = result.current.dataRef.current!;

    // (a) The video clip is gone from rows, meta, and config clips.
    const allActionIds = after.rows.flatMap((row) => row.actions.map((a) => a.id));
    expect(allActionIds).not.toContain('clip-video');
    expect(after.meta['clip-video']).toBeUndefined();
    expect(after.config.clips.find((c) => c.id === 'clip-video')).toBeUndefined();

    // (b) NO image clips from imageClipSnapshot were auto-inserted.
    expect(allActionIds).not.toContain('clip-img-a');
    expect(allActionIds).not.toContain('clip-img-b');
    expect(after.config.clips.find((c) => c.id === 'clip-img-a')).toBeUndefined();
    expect(after.config.clips.find((c) => c.id === 'clip-img-b')).toBeUndefined();

    // (c) The group entry is preserved (no auto-delete either). clipIds still
    // reference the deleted video clip id because the mutation did not pass a
    // pinnedShotGroupsOverride — rendering will show a degraded placeholder.
    const groupAfter = after.config.pinnedShotGroups?.[0];
    expect(groupAfter).toBeDefined();
    expect(groupAfter?.shotId).toBe('shot-1');
    expect(groupAfter?.mode).toBe('video');
    expect(groupAfter?.videoAssetKey).toBe('video-asset');
    // Snapshot metadata is preserved so a later explicit switchToImages() can still use it.
    expect(groupAfter?.imageClipSnapshot).toHaveLength(2);
    expect(after.config).toMatchObject({
      theme: '2rp',
      theme_overrides: { visual: { canvas: { fps: 24 } } },
      generation_defaults: { model: 'sequence-v1' },
    });
    expect(after.resolvedConfig).toMatchObject({
      theme: '2rp',
      theme_overrides: { visual: { canvas: { fps: 24 } } },
      generation_defaults: { model: 'sequence-v1' },
    });
  });

  it('delete-shot with pinnedShotGroupsOverride removes the group in the same commit', () => {
    const eventBus = new TimelineEventBus();
    const lastSavedSignatureRef = { current: '' };

    const { result } = renderHook(() => useTimelineCommit({
      eventBus,
      lastSavedSignatureRef,
    }));

    act(() => {
      result.current.commitData(makeVideoModeGroupData(), { save: false });
    });

    const initial = result.current.dataRef.current!;
    const rowsWithoutVideo = initial.rows.map((row) => ({ ...row, actions: [] }));

    act(() => {
      result.current.applyEdit({
        type: 'rows',
        rows: rowsWithoutVideo,
        metaDeletes: ['clip-video'],
        // Explicit delete-shot: remove the group entry in the same commit.
        pinnedShotGroupsOverride: [],
      }, { save: false });
    });

    const after = result.current.dataRef.current!;
    expect(after.config.pinnedShotGroups ?? []).toEqual([]);
    expect(after.config.clips).toEqual([]);
  });

  it('config mutations preserve theme extras through serializeForDisk and registry-backed rebuild', () => {
    const eventBus = new TimelineEventBus();
    const lastSavedSignatureRef = { current: '' };

    const { result } = renderHook(() => useTimelineCommit({
      eventBus,
      lastSavedSignatureRef,
    }));

    act(() => {
      result.current.commitData(makeVideoModeGroupData(), { save: false });
    });

    const initial = result.current.dataRef.current!;

    act(() => {
      result.current.applyEdit({
        type: 'config',
        resolvedConfig: {
          ...initial.resolvedConfig,
          tracks: initial.resolvedConfig.tracks.map((track) => (
            track.id === 'V1' ? { ...track, label: 'Renamed Visual' } : track
          )),
        },
      }, { save: false });
    });

    const after = result.current.dataRef.current!;
    expect(after.config.tracks?.[0]?.label).toBe('Renamed Visual');
    expect(after.config).toMatchObject({
      theme: '2rp',
      theme_overrides: { visual: { canvas: { fps: 24 } } },
      generation_defaults: { model: 'sequence-v1' },
    });
    expect(after.resolvedConfig).toMatchObject({
      theme: '2rp',
      theme_overrides: { visual: { canvas: { fps: 24 } } },
      generation_defaults: { model: 'sequence-v1' },
    });
  });

  it('rows mutations can replace a deleted selected clip with an explicit new clip and track selection', () => {
    const eventBus = new TimelineEventBus();
    const lastSavedSignatureRef = { current: '' };

    const { result } = renderHook(() => useTimelineCommit({
      eventBus,
      lastSavedSignatureRef,
    }));

    act(() => {
      result.current.commitData(makeSelectionForwardingData(), {
        save: false,
        selectedClipId: 'clip-old',
        selectedTrackId: 'V1',
      });
    });

    const initial = result.current.dataRef.current!;
    const rowsWithReplacement = initial.rows.map((row) => {
      if (row.id === 'V1') {
        return { ...row, actions: [] };
      }
      if (row.id === 'V2') {
        return {
          ...row,
          actions: [{
            id: 'clip-new',
            start: 0,
            end: 3,
            effectId: 'effect-clip-new',
          }],
        };
      }
      return row;
    });

    act(() => {
      result.current.applyEdit({
        type: 'rows',
        rows: rowsWithReplacement,
        metaDeletes: ['clip-old'],
        metaUpdates: {
          'clip-new': {
            track: 'V2',
            clipType: 'section-hook',
            hold: 3,
            params: { title: 'Replacement' },
          },
        },
        clipOrderOverride: {
          V1: [],
          V2: ['clip-new'],
        },
      }, {
        save: false,
        selectedClipId: 'clip-new',
        selectedTrackId: 'V2',
      });
    });

    const after = result.current.dataRef.current!;
    expect(after.meta['clip-old']).toBeUndefined();
    expect(after.meta['clip-new']).toMatchObject({ track: 'V2' });
    expect(result.current.selectedClipId).toBe('clip-new');
    expect(result.current.selectedTrackId).toBe('V2');
    expect(result.current.selectedClipIdRef.current).toBe('clip-new');
    expect(result.current.selectedTrackIdRef.current).toBe('V2');
    expect(__getSelectionStateForTests().timeline.selectedClipId).toBe('clip-new');
    expect(__getSelectionStateForTests().timeline.selectedTrackId).toBe('V2');
  });

  it('the extracted mutation engine returns pure preview/apply results without mutating the input snapshot', () => {
    const initial = makeSelectionForwardingData();
    const rowsWithReplacement = initial.rows.map((row) => {
      if (row.id === 'V1') {
        return { ...row, actions: [] };
      }
      if (row.id === 'V2') {
        return {
          ...row,
          actions: [{
            id: 'clip-new',
            start: 0,
            end: 3,
            effectId: 'effect-clip-new',
          }],
        };
      }
      return row;
    });

    const mutation = {
      type: 'rows' as const,
      rows: rowsWithReplacement,
      metaDeletes: ['clip-old'],
      metaUpdates: {
        'clip-new': {
          track: 'V2',
          clipType: 'section-hook',
          hold: 3,
          params: { title: 'Replacement' },
        },
      },
      clipOrderOverride: {
        V1: [],
        V2: ['clip-new'],
      },
    };

    const preview = previewTimelineMutation(initial, mutation);
    const applied = applyTimelineMutation(initial, mutation);

    expect(preview.ok).toBe(true);
    expect(applied.ok).toBe(true);
    if (!preview.ok || !applied.ok) {
      throw new Error('Expected pure mutation results to succeed');
    }

    expect(initial.meta['clip-old']).toBeDefined();
    expect(initial.meta['clip-new']).toBeUndefined();
    expect(initial.config.clips.map((clip) => clip.id)).toEqual(['clip-old']);

    expect(preview.nextData.config.clips.map((clip) => clip.id)).toEqual(['clip-new']);
    expect(preview.nextMeta['clip-new']).toMatchObject({ track: 'V2' });
    expect(preview.nextClipOrder).toEqual({ V1: [], V2: ['clip-new'] });
    expect(applied.nextData).toEqual(preview.nextData);
  });

  it('useTimelineCommit still owns commit-side effects while the pure engine stays side-effect free', () => {
    const eventBus = new TimelineEventBus();
    const lastSavedSignatureRef = { current: '' };
    const beforeCommit = vi.fn();
    const pruneSelection = vi.fn();
    const scheduleSave = vi.fn();

    eventBus.on('beforeCommit', beforeCommit);
    eventBus.on('pruneSelection', pruneSelection);
    eventBus.on('scheduleSave', scheduleSave);

    const initial = makeSelectionForwardingData();
    const rowsWithReplacement = initial.rows.map((row) => {
      if (row.id === 'V1') {
        return { ...row, actions: [] };
      }
      if (row.id === 'V2') {
        return {
          ...row,
          actions: [{
            id: 'clip-new',
            start: 0,
            end: 3,
            effectId: 'effect-clip-new',
          }],
        };
      }
      return row;
    });

    const mutation = {
      type: 'rows' as const,
      rows: rowsWithReplacement,
      metaDeletes: ['clip-old'],
      metaUpdates: {
        'clip-new': {
          track: 'V2',
          clipType: 'section-hook',
          hold: 3,
        },
      },
      clipOrderOverride: {
        V1: [],
        V2: ['clip-new'],
      },
    };

    const preview = previewTimelineMutation(initial, mutation);
    expect(preview.ok).toBe(true);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(pruneSelection).not.toHaveBeenCalled();
    expect(scheduleSave).not.toHaveBeenCalled();

    const { result } = renderHook(() => useTimelineCommit({
      eventBus,
      lastSavedSignatureRef,
    }));

    act(() => {
      result.current.commitData(initial, {
        save: false,
        selectedClipId: 'clip-old',
        selectedTrackId: 'V1',
      });
    });
    beforeCommit.mockClear();
    pruneSelection.mockClear();
    scheduleSave.mockClear();

    act(() => {
      result.current.applyEdit(mutation, {
        selectedClipId: 'clip-new',
        selectedTrackId: 'V2',
      });
    });

    expect(beforeCommit).toHaveBeenCalledTimes(1);
    expect(pruneSelection).toHaveBeenCalledTimes(1);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
    expect(result.current.selectedClipId).toBe('clip-new');
    expect(result.current.selectedTrackId).toBe('V2');
  });
});

describe('useTimelineCommit — registry patches preserve in-flight placements', () => {
  beforeEach(() => {
    __resetSelectionStoreForTests();
  });

  it('does not discard an uploading placeholder when the registry is patched', () => {
    const eventBus = new TimelineEventBus();
    const lastSavedSignatureRef = { current: '' };
    const { result } = renderHook(() => useTimelineCommit({ eventBus, lastSavedSignatureRef }));

    act(() => {
      result.current.commitData(makeSelectionForwardingData(), { save: false });
      const current = result.current.dataRef.current!;
      result.current.applyEdit({
        type: 'rows',
        rows: current.rows.map((row) => row.id === 'V1'
          ? {
              ...row,
              actions: [...row.actions, {
                id: 'uploading-test',
                start: 0,
                end: 5,
                effectId: 'effect-uploading-test',
              }],
            }
          : row),
        metaUpdates: {
          'uploading-test': {
            asset: 'uploading:clip.mp4',
            track: 'V1',
            clipType: 'hold',
            hold: 5,
          },
        },
      }, { save: false });
    });

    act(() => {
      result.current.patchRegistry('asset-new', { file: 'clip.mp4', type: 'video/mp4' });
    });

    const current = result.current.dataRef.current!;
    expect(current.rows[0]?.actions.map((action) => action.id)).toContain('uploading-test');
    expect(current.meta['uploading-test']).toMatchObject({ asset: 'uploading:clip.mp4' });
  });
});


describe('useTimelineCommit owned registry receipts', () => {
  it('restores the prior entry/source while preserving unrelated edits', () => {
    const eventBus = new TimelineEventBus();
    const { result } = renderHook(() => useTimelineCommit({ eventBus, lastSavedSignatureRef: { current: '' }, initialData: { ...makeVideoModeGroupData(), head: { projectId: 'project-owned', timelineId: 'timeline-owned', headRevisionId: 'head-owned' } } }));
    act(() => result.current.patchRegistry('asset-own', { file: 'prior.png' }, 'resolved-prior.png'));
    let receipt!: ReturnType<typeof result.current.patchRegistryOwned>;
    act(() => { receipt = result.current.patchRegistryOwned('asset-own', { file: 'new.png' }, 'resolved-new.png'); });
    act(() => result.current.patchRegistry('unrelated', { file: 'other.png' }));
    act(() => { expect(result.current.rollbackRegistryMutation(receipt)).toBe(true); });
    expect(result.current.dataRef.current?.registry.assets['asset-own']).toEqual({ file: 'prior.png' });
    expect(result.current.dataRef.current?.resolvedConfig.registry['asset-own'].src).toBe('resolved-prior.png');
    expect(result.current.dataRef.current?.registry.assets.unrelated.file).toBe('other.png');
    expect(result.current.dataRef.current?.head).toEqual({ projectId: 'project-owned', timelineId: 'timeline-owned', headRevisionId: 'head-owned' });
    expect(result.current.rollbackRegistryMutation(receipt)).toBe(false);
  });

  it('protects newer same-key mutations and newly referenced entries', () => {
    const { result } = renderHook(() => useTimelineCommit({ eventBus: new TimelineEventBus(), lastSavedSignatureRef: { current: '' }, initialData: makeVideoModeGroupData() }));
    let older!: ReturnType<typeof result.current.patchRegistryOwned>;
    let newer!: ReturnType<typeof result.current.patchRegistryOwned>;
    act(() => { older = result.current.patchRegistryOwned('asset-own', { file: 'old.png' }); });
    act(() => { newer = result.current.patchRegistryOwned('asset-own', { file: 'new.png' }); });
    expect(result.current.rollbackRegistryMutation(older)).toBe(false);
    const current = result.current.dataRef.current!;
    act(() => result.current.commitData({ ...current, config: { ...current.config, clips: [...current.config.clips, { id: 'ref', at: 0, track: 'V1', clipType: 'media', asset: 'asset-own', from: 0, to: 1 }] } }));
    expect(result.current.rollbackRegistryMutation(newer)).toBe(false);
    expect(result.current.dataRef.current?.registry.assets['asset-own'].file).toBe('new.png');
  });
});

describe('useTimelineCommit local save boundary', () => {
  it('exposes each upstream local predecessor before debounce while leaving save scheduling intact', () => {
    const eventBus = new TimelineEventBus();
    const local = vi.fn();
    const scheduled = vi.fn();
    eventBus.on('localCommit', local);
    eventBus.on('scheduleSave', scheduled);
    const initial = makeVideoModeGroupData();
    const { result } = renderHook(() => useTimelineCommit({ eventBus, lastSavedSignatureRef: { current: '' }, initialData: initial }));
    const first = { ...initial, config: { ...initial.config, theme: 'first' } };
    const second = { ...first, config: { ...first.config, theme: 'second' } };
    act(() => {
      result.current.commitData(first);
      result.current.commitData(second);
    });
    expect(local.mock.calls).toEqual([[initial, first], [first, second]]);
    expect(scheduled.mock.calls).toEqual([[first], [second]]);
    expect(result.current.dataRef.current).toBe(second);
    expect(result.current.editSeqRef.current).toBe(2);
    act(() => result.current.commitData(initial, { save: false, skipHistory: true, updateLastSavedSignature: true }));
    expect(local).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveBeenCalledTimes(2);
  });
});
