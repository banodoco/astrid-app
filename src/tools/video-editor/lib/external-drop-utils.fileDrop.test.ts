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
