import { describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import { handleFileDrop } from './external-drop-utils.ts';
import type { TimelineData } from './timeline-data.ts';

const head = (revision: string) => ({ projectId: 'p', timelineId: 't', headRevisionId: revision, headPublicationId: `pub-${revision}` });
const timeline = (revision: string, rowIds = ['V1']) => ({
  head: head(revision),
  tracks: rowIds.map((id) => ({ id, kind: 'visual', label: id })),
  rows: rowIds.map((id) => ({ id, actions: [] as Array<{ id: string }> })),
  registry: { assets: {} },
  config: { clips: [] },
}) as unknown as TimelineData;

function setup() {
  const dataRef: MutableRefObject<TimelineData | null> = { current: timeline('r0') };
  const pendingOpsRef = { current: 0 };
  const applyEdit = vi.fn();
  const dropAsset = vi.fn(() => true);
  const onAssetDropError = vi.fn();
  let finishUpload!: () => void;
  const uploadImageGeneration = vi.fn(() => new Promise((resolve) => { finishUpload = () => resolve({ id: 'generation-2' }); }));
  const prepared = { assetKey: 'asset-2', mediaType: 'image', durationSeconds: null, entry: { file: 'x' }, source: 'registered' };
  const drop = () => handleFileDrop({
    files: [new File(['x'], 'two.png', { type: 'image/png' })], dataRef, pendingOpsRef,
    dropPosition: { time: 2, trackId: 'V1', isNewTrack: false } as never, insertAtTop: false, selectedTrackId: null,
    applyEdit, invalidateAssetRegistry: vi.fn(async () => undefined), resolveAssetUrl: vi.fn(async (file: string) => file),
    registerGenerationAsset: vi.fn(), prepareGenerationAsset: vi.fn(() => prepared) as never,
    uploadImageGeneration: uploadImageGeneration as never, uploadVideoGeneration: vi.fn() as never,
    dropAsset: dropAsset as never, onAssetDropError,
  });
  return { dataRef, pendingOpsRef, applyEdit, dropAsset, onAssetDropError, drop, finish: () => finishUpload() };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a dropped file whose upload finishes after a save landed', () => {
  it('is placed on the current document: the head moving is not a reason to drop it', async () => {
    const s = setup();
    await s.drop();
    // Drop 1's save lands during drop 2's upload: a new head, the same timeline and track.
    s.dataRef.current = timeline('r1');
    s.finish();
    await settle();
    expect(s.dropAsset).toHaveBeenCalledOnce();
    expect(s.onAssetDropError).not.toHaveBeenCalled();
    expect(s.pendingOpsRef.current).toBe(0);
  });

  it('is abandoned with a message, and its placeholder removed, only when its track is gone', async () => {
    const s = setup();
    await s.drop();
    s.dataRef.current = timeline('r1', ['V2']);
    s.finish();
    await settle();
    expect(s.dropAsset).not.toHaveBeenCalled();
    expect(s.onAssetDropError).toHaveBeenCalledOnce();
    expect((s.onAssetDropError.mock.calls[0][0] as Error).message).toBe('The timeline changed while this file uploaded; drop it again.');
    // The placeholder (an applyEdit that added `uploading-…` metadata) is deleted again.
    const deletes = s.applyEdit.mock.calls.flatMap(([edit]) => (edit as { metaDeletes?: string[] }).metaDeletes ?? []);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatch(/^uploading-/);
  });
});

describe('a dropped file that is not added', () => {
  function parkSetup(uploads: Array<() => Promise<unknown>>) {
    const dataRef: MutableRefObject<TimelineData | null> = { current: timeline('r0') };
    const pendingOpsRef = { current: 0 };
    // A minimal applyEdit that keeps the rows/meta honest so we can see what stays on the timeline.
    const meta: Record<string, { asset?: string }> = {};
    const applyEdit = vi.fn((edit: { rows?: unknown; metaUpdates?: Record<string, { asset?: string }>; metaDeletes?: string[] }) => {
      if (edit.rows) dataRef.current = { ...dataRef.current!, rows: edit.rows as never };
      for (const [id, value] of Object.entries(edit.metaUpdates ?? {})) meta[id] = value;
      for (const id of edit.metaDeletes ?? []) delete meta[id];
      dataRef.current = { ...dataRef.current!, meta: { ...meta } } as never;
    });
    const dropAsset = vi.fn(() => true);
    const onAssetDropError = vi.fn();
    const parked: Array<import('./external-drop-utils.ts').ParkedDrop> = [];
    const onDropParked = vi.fn((drop) => { parked.push(drop); });
    const onDropSettled = vi.fn();
    let next = 0;
    const uploadImageGeneration = vi.fn(() => uploads[next++]());
    const prepared = { assetKey: 'asset-2', mediaType: 'image', durationSeconds: null, entry: { file: 'x' }, source: 'registered' };
    const run = () => handleFileDrop({
      files: [new File(['x'], 'two.png', { type: 'image/png' })], dataRef, pendingOpsRef,
      dropPosition: { time: 2, trackId: 'V1', isNewTrack: false } as never, insertAtTop: false, selectedTrackId: null,
      applyEdit, invalidateAssetRegistry: vi.fn(async () => undefined), resolveAssetUrl: vi.fn(async (file: string) => file),
      registerGenerationAsset: vi.fn(), prepareGenerationAsset: vi.fn(() => prepared) as never,
      uploadImageGeneration: uploadImageGeneration as never, uploadVideoGeneration: vi.fn() as never,
      dropAsset: dropAsset as never, onAssetDropError, onDropParked, onDropSettled,
    });
    const placeholderIds = () => (dataRef.current!.rows.flatMap((row) => row.actions as Array<{ id: string }>)).map((a) => a.id);
    return { dataRef, meta, pendingOpsRef, dropAsset, onAssetDropError, parked, onDropParked, onDropSettled, run, placeholderIds, uploadImageGeneration };
  }

  it('keeps the placeholder visible and parked with the reason when the upload fails', async () => {
    const s = parkSetup([() => Promise.reject(new Error('The server refused the file.'))]);
    await s.run();
    await settle();
    expect(s.onAssetDropError).toHaveBeenCalledOnce();
    expect(s.placeholderIds()).toHaveLength(1);
    expect(s.onDropParked).toHaveBeenCalledOnce();
    expect(s.parked[0].reason).toBe('The server refused the file.');
    expect(s.parked[0].fileName).toBe('two.png');
    expect(Object.values(s.meta)[0].asset).toBe('uploading:two.png (not added: The server refused the file.)');
    expect(s.pendingOpsRef.current).toBe(0);
  });

  it('parks a drop the editor declined, with the decline reason', async () => {
    const s = parkSetup([() => Promise.resolve({ id: 'g' })]);
    s.dropAsset.mockImplementation(((_k: string, _t: unknown, _time: number, _a: boolean, _b: boolean, _p: unknown, _id: string, onDecline?: (m: string) => void) => {
      onDecline?.('That track is no longer available.');
      return false;
    }) as never);
    await s.run();
    await settle();
    expect(s.placeholderIds()).toHaveLength(1);
    expect(s.parked[0].reason).toBe('That track is no longer available.');
  });

  it('Try again uploads the retained file again and ends the parked state on success', async () => {
    const s = parkSetup([() => Promise.reject(new Error('Offline.')), () => Promise.resolve({ id: 'g' })]);
    await s.run();
    await settle();
    expect(s.parked).toHaveLength(1);
    await s.parked[0].tryAgain();
    expect(s.uploadImageGeneration).toHaveBeenCalledTimes(2);
    expect(s.dropAsset).toHaveBeenCalledOnce();
    expect(s.onDropSettled).toHaveBeenCalledWith(s.parked[0].id);
    expect(s.onDropParked).toHaveBeenCalledOnce();
    expect(s.pendingOpsRef.current).toBe(0);
  });

  it('Try again that fails again stays parked with the new reason', async () => {
    const s = parkSetup([() => Promise.reject(new Error('Offline.')), () => Promise.reject(new Error('Still offline.'))]);
    await s.run();
    await settle();
    await s.parked[0].tryAgain();
    expect(s.placeholderIds()).toHaveLength(1);
    expect(s.parked[1].reason).toBe('Still offline.');
    expect(s.onDropSettled).not.toHaveBeenCalled();
  });

  it('Discard removes the placeholder', async () => {
    const s = parkSetup([() => Promise.reject(new Error('Offline.'))]);
    await s.run();
    await settle();
    s.parked[0].discard();
    expect(s.placeholderIds()).toHaveLength(0);
    expect(Object.keys(s.meta)).toHaveLength(0);
    expect(s.onDropSettled).toHaveBeenCalledWith(s.parked[0].id);
  });

  it('a successful drop parks nothing', async () => {
    const s = parkSetup([() => Promise.resolve({ id: 'g' })]);
    await s.run();
    await settle();
    expect(s.dropAsset).toHaveBeenCalledOnce();
    expect(s.onDropParked).not.toHaveBeenCalled();
    expect(s.onAssetDropError).not.toHaveBeenCalled();
  });
});
