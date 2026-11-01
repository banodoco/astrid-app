// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SelectedMediaClip } from '@/tools/video-editor/hooks/useSelectedMediaClips';
import {
  __getSelectionStateForTests,
  __resetSelectionStoreForTests,
  activateTimelineClipData,
  clearTimelineClipData,
  composerRemoveAttachment,
  editorReplaceTimelineSelection,
  editorClearTimelineSelection,
  editorSetSelectedTrackId,
  getShotPlacementTarget,
  systemPruneTimelineSelection,
  systemResetTimelineSelection,
  useTimelineMultiSelect,
  useTimelineClipDataActive,
  useTimelineSelectionStore,
  userSelectTimelineClip,
  userSelectTimelineClips,
  setTimelineClipData,
  systemResetSelectionForProjectChange,
  userSelectGalleryItem,
} from './selectionStore';
import { createShotCompositionAdapter } from '@/tools/video-editor/data/shotCompositionAdapter';
import compositionFixture from '@/tools/video-editor/data/shotComposition.fixture.json';

const clip = (timeline: string): SelectedMediaClip => ({
  clipId: 'shared-clip-id',
  assetKey: timeline,
  url: `https://example.test/${timeline}.png`,
  mediaType: 'image',
  isTimelineBacked: true,
});
const currentClip = () => __getSelectionStateForTests().clipDataById.get('shared-clip-id');

beforeEach(__resetSelectionStoreForTests);

describe('canonical placement selection', () => {
  const composition = createShotCompositionAdapter({ load: async () => compositionFixture }).prepare(compositionFixture);
  const context = { projectId: composition.projectId, timelineId: composition.parentDocumentId, composition };

  it('requires one selected occurrence, retaining its identity across shared physical shot roots', () => {
    const owner = Symbol('editor');
    setTimelineClipData([], owner, context);
    userSelectTimelineClips(['occ-2:alpha-audio', 'occ-2:alpha-video'], {}, owner);
    const target = getShotPlacementTarget(composition.projectId, 'shot-alpha');
    expect(target).toEqual({ shot_id: expect.any(String), ownerRef: 'occurrence:occ-2', timelineRef: composition.parentDocumentId });
    expect(target.shot_id).not.toBe('shot-alpha');
  });

  it.each([
    ['missing', []],
    ['foreign clip', ['unknown']],
    ['ambiguous occurrences', ['occ-1:alpha-video', 'occ-2:alpha-video']],
    ['foreign shot', ['occ-4:beta-video']],
  ])('refuses %s selection without falling back to the parent', (_name, selected) => {
    const owner = Symbol('editor');
    setTimelineClipData([], owner, context);
    userSelectTimelineClips(selected, {}, owner);
    expect(() => getShotPlacementTarget(composition.projectId, 'shot-alpha')).toThrow();
  });

  it('refuses missing graphs and foreign project or timeline bindings', () => {
    const owner = Symbol('editor');
    setTimelineClipData([], owner, context);
    userSelectTimelineClips(['occ-2:alpha-video'], {}, owner);
    expect(() => getShotPlacementTarget('foreign-project', 'shot-alpha')).toThrow();
    setTimelineClipData([], owner, { ...context, timelineId: 'foreign-timeline' });
    expect(() => getShotPlacementTarget(composition.projectId, 'shot-alpha')).toThrow();
    setTimelineClipData([], owner, { ...context, composition: null });
    expect(() => getShotPlacementTarget(composition.projectId, 'shot-alpha')).toThrow();
  });

  it('uses only the active mounted editor and preserves parent-only behavior after release', () => {
    const active = Symbol('active');
    const background = Symbol('background');
    const release = setTimelineClipData([], active, context);
    userSelectTimelineClips(['occ-2:alpha-video'], {}, active);
    setTimelineClipData([], background, { ...context, projectId: 'foreign-project' });
    expect(getShotPlacementTarget(composition.projectId, 'shot-alpha').ownerRef).toBe('occurrence:occ-2');
    clearTimelineClipData(background);
    release();
    expect(getShotPlacementTarget(composition.projectId, 'shot-alpha')).toEqual({ shot_id: 'shot-alpha' });
  });
});

describe('timeline clip catalog ownership', () => {
  it('uses the explicitly activated owner for colliding clip IDs and composer removal', () => {
    const ownerA = Symbol('same-project');
    const ownerB = Symbol('same-project');
    setTimelineClipData([clip('a')], ownerA);
    setTimelineClipData([clip('b')], ownerB);
    expect(currentClip()?.url).toBe(clip('a').url);
    activateTimelineClipData(ownerB);
    expect(currentClip()?.url).toBe(clip('b').url);
    editorReplaceTimelineSelection(['shared-clip-id']);
    composerRemoveAttachment(clip('a'));
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual(['shared-clip-id']);
    composerRemoveAttachment(clip('b'));
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual([]);
  });

  it('background updates and cleanup preserve the active catalog and gallery selection', () => {
    const ownerA = Symbol('a');
    const ownerB = Symbol('b');
    setTimelineClipData([clip('a')], ownerA);
    setTimelineClipData([clip('b')], ownerB);
    const disposeB = setTimelineClipData([clip('b-updated')], ownerB);
    userSelectGalleryItem({ id: 'gallery', url: 'https://example.test/gallery.png', mediaType: 'image' }, { additive: false });
    disposeB();
    clearTimelineClipData();
    activateTimelineClipData(Symbol('missing'));
    expect(currentClip()?.url).toBe(clip('a').url);
    expect([...__getSelectionStateForTests().gallery.selectedGalleryIds]).toEqual(['gallery']);
  });

  it('stale disposal leaves its replacement intact and active disposal resumes another editor', () => {
    const ownerA = Symbol('a');
    const ownerB = Symbol('b');
    const disposeA = setTimelineClipData([clip('a')], ownerA);
    const staleDisposeB = setTimelineClipData([clip('b')], ownerB);
    const disposeB = setTimelineClipData([clip('b-new')], ownerB);
    activateTimelineClipData(ownerB);
    staleDisposeB();
    expect(currentClip()?.url).toBe(clip('b-new').url);
    disposeB();
    expect(currentClip()?.url).toBe(clip('a').url);
    disposeA();
    expect(__getSelectionStateForTests().clipDataById.size).toBe(0);
  });

  it('retains legacy single-caller behavior and resets registration lifetimes on project reset', () => {
    const staleDispose = setTimelineClipData([clip('legacy')]);
    expect(currentClip()?.url).toBe(clip('legacy').url);
    clearTimelineClipData();
    expect(__getSelectionStateForTests().clipDataById.size).toBe(0);
    const owner = Symbol('scope');
    const preResetDispose = setTimelineClipData([clip('old')], owner);
    systemResetSelectionForProjectChange();
    setTimelineClipData([clip('new')], owner);
    staleDispose();
    preResetDispose();
    expect(currentClip()?.url).toBe(clip('new').url);
  });
});


describe('timeline selection ownership', () => {
  it('background mount resets and pruning preserve the active selection and gallery', () => {
    const ownerA = Symbol('a');
    const ownerB = Symbol('b');
    setTimelineClipData([clip('a')], ownerA);
    editorReplaceTimelineSelection(['clip-a', 'clip-a2']);
    editorSetSelectedTrackId('track-a');
    userSelectGalleryItem({ id: 'gallery', url: 'https://example.test/gallery.png', mediaType: 'image' }, { additive: true });
    systemResetTimelineSelection(ownerB);
    const snapshots = __getSelectionStateForTests().timelineSelectionsByOwner;
    systemResetTimelineSelection(ownerB);
    expect(__getSelectionStateForTests().timelineSelectionsByOwner).toBe(snapshots);
    setTimelineClipData([clip('b')], ownerB);
    editorReplaceTimelineSelection(['clip-b', 'clip-b2'], ownerB);
    systemPruneTimelineSelection(new Set(['clip-b']), ownerB);
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual(['clip-a', 'clip-a2']);
    expect(__getSelectionStateForTests().timeline.selectedTrackId).toBe('track-a');
    activateTimelineClipData(ownerB);
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual(['clip-b']);
    expect([...__getSelectionStateForTests().gallery.selectedGalleryIds]).toEqual(['gallery']);
    activateTimelineClipData(ownerA);
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual(['clip-a', 'clip-a2']);
    expect(__getSelectionStateForTests().timeline.selectedTrackId).toBe('track-a');
  });

  it('explicit user selection mutates its owner and legacy commands address the active owner', () => {
    const ownerA = Symbol('a');
    const ownerB = Symbol('b');
    setTimelineClipData([clip('a')], ownerA);
    setTimelineClipData([clip('b')], ownerB);
    userSelectTimelineClip('clip-a', { additive: false });
    userSelectTimelineClip('clip-b', { additive: false }, ownerB);
    userSelectTimelineClips(['clip-b2'], { additive: true }, ownerB);
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual(['clip-a']);
    activateTimelineClipData(ownerB);
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual(['clip-b', 'clip-b2']);
    editorClearTimelineSelection(ownerA);
    clearTimelineClipData(ownerB);
    expect([...__getSelectionStateForTests().timeline.selectedClipIds]).toEqual([]);
  });

  it('scoped hooks react to background selection and prune only their owner', () => {
    const ownerA = Symbol('a');
    const ownerB = Symbol('b');
    setTimelineClipData([clip('a')], ownerA);
    setTimelineClipData([clip('b')], ownerB);
    const { result } = renderHook(() => ({
      a: useTimelineSelectionStore(ownerA),
      b: useTimelineMultiSelect(ownerB),
      active: useTimelineSelectionStore(),
      admitsA: useTimelineClipDataActive(ownerA),
      admitsB: useTimelineClipDataActive(ownerB),
      admitsLegacy: useTimelineClipDataActive(),
    }));
    act(() => {
      editorReplaceTimelineSelection(['a'], ownerA);
      editorReplaceTimelineSelection(['b', 'b2'], ownerB);
    });
    expect([...result.current.a.selectedClipIds]).toEqual(['a']);
    expect([...result.current.b.selectedClipIds]).toEqual(['b', 'b2']);
    expect(result.current.b.isClipSelected('b2')).toBe(true);
    act(() => { result.current.b.pruneSelection(new Set(['b2'])); });
    expect([...result.current.b.selectedClipIds]).toEqual(['b2']);
    expect([...result.current.active.selectedClipIds]).toEqual(['a']);
    expect(result.current.admitsA).toBe(true);
    expect(result.current.admitsB).toBe(false);
    expect(result.current.admitsLegacy).toBe(true);
    act(() => { activateTimelineClipData(ownerB); });
    expect([...result.current.active.selectedClipIds]).toEqual(['b2']);
    expect(result.current.admitsA).toBe(false);
    expect(result.current.admitsB).toBe(true);
    expect([...result.current.a.selectedClipIds]).toEqual(['a']);
  });
});
