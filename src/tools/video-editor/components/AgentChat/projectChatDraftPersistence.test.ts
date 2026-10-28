import { describe, expect, it, vi } from 'vitest';
import { flushDraftsBeforeReload } from '@/shared/lib/updates/draftSafeReload.ts';
import { ProjectChatDraftPersistence, mergeQueues } from './projectChatDraftPersistence';

const snapshot = (text: string, attachment = 'asset-a') => ({ text, queue: [{ id: 'q', text: 'queued', sessionId: 's', attachments: [{ assetId: attachment }] }] });

describe('project chat draft persistence', () => {
  it('does not write untouched hydrated drafts in two clients or on repeated cleanup', async () => {
    const saved = snapshot('saved');
    const write = vi.fn();
    const first = new ProjectChatDraftPersistence(4, saved);
    const second = new ProjectChatDraftPersistence(4, saved);
    await Promise.all([first.save(saved, write), second.save(saved, write), first.save(saved, write)]);
    expect(write).not.toHaveBeenCalled();
  });

  it('serializes overlapping saves and retains the chain when a composer reopens', async () => {
    const persistence = new ProjectChatDraftPersistence(4, snapshot('saved'));
    let acknowledge!: (revision: number) => void;
    const firstWrite = vi.fn(() => new Promise<number>(resolve => { acknowledge = resolve; }));
    const secondWrite = vi.fn(async (revision: number) => revision + 1);
    const first = persistence.save(snapshot('first edit'), firstWrite);
    await Promise.resolve(); await Promise.resolve();
    persistence.mounted = false;
    const retained = persistence;
    retained.mounted = true;
    const duplicate = retained.save(snapshot('first edit'), secondWrite);
    const second = retained.save(snapshot('second edit'), secondWrite);
    expect(secondWrite).not.toHaveBeenCalled();
    acknowledge(5);
    await Promise.all([first, duplicate, second]);
    expect(firstWrite).toHaveBeenCalledWith(4);
    expect(secondWrite).toHaveBeenCalledExactlyOnceWith(5);
    expect(retained.revision).toBe(6);
    expect(retained.saved).toEqual(snapshot('second edit'));
  });

  it('does not overwrite an acknowledged current draft with an older queued snapshot', async () => {
    const persistence = new ProjectChatDraftPersistence(4, snapshot('original'));
    const write = vi.fn();
    const pending = persistence.save(snapshot('older queued edit'), write);
    persistence.observe(6, snapshot('current edit'), snapshot('current edit'));
    await pending;
    expect(write).not.toHaveBeenCalled();
    expect(persistence.saved).toEqual(snapshot('current edit'));
    expect(persistence.revision).toBe(6);
  });

  it('does not regress an exact newer acknowledgement when an earlier save returns late', async () => {
    const persistence = new ProjectChatDraftPersistence(4, snapshot('original'));
    let acknowledge!: (revision: number) => void;
    const pending = persistence.save(snapshot('first edit'), () => new Promise<number>(resolve => { acknowledge = resolve; }));
    await Promise.resolve(); await Promise.resolve();
    persistence.observe(6, snapshot('second edit'), snapshot('second edit'));
    acknowledge(5);
    await pending;
    expect(persistence.revision).toBe(6);
    expect(persistence.saved).toEqual(snapshot('second edit'));
  });

  it('preserves original base on a real conflict, including queued attachment differences', async () => {
    const original = snapshot('original');
    const local = snapshot('my edit');
    const persistence = new ProjectChatDraftPersistence(4, original);
    persistence.observe(5, snapshot('other client', 'asset-b'), local);
    const write = vi.fn(async () => { throw new Error('draft conflict'); });
    await expect(persistence.save(local, write)).rejects.toThrow('draft conflict');
    expect(write).toHaveBeenCalledWith(4);
    expect(persistence.saved).toBe(original);
    expect(persistence.revision).toBe(4);
    expect(local).toEqual(snapshot('my edit'));
  });

  it('acknowledges an exact saved local payload or unchanged base without overwriting', async () => {
    const persistence = new ProjectChatDraftPersistence(4, snapshot('original'));
    const local = snapshot('my edit');
    persistence.observe(5, snapshot('original'), local);
    expect(persistence.revision).toBe(5);
    persistence.observe(6, snapshot('my edit', 'different-attachment'), local);
    expect(persistence.revision).toBe(5);
    persistence.observe(7, snapshot('my edit'), local);
    const write = vi.fn();
    await persistence.save(local, write);
    expect(write).not.toHaveBeenCalled();
    expect(persistence.revision).toBe(7);
  });
});

describe('mergeQueues', () => {
  const row = (id: string, text = id) => ({ id, text });
  it('keeps local order, adds rows only the server has, and drops rows the server removed', () => {
    expect(mergeQueues([row('a'), row('b')], [row('a'), row('c')], [row('b'), row('a'), row('d')]))
      .toEqual([row('a'), row('d'), row('c')]);
  });
  it('does not resurrect a row removed locally and keeps local text edits', () => {
    expect(mergeQueues([row('a'), row('b')], [row('a'), row('b')], [row('a', 'edited')])).toEqual([row('a', 'edited')]);
  });
  it('is the identity when nothing diverged', () => {
    expect(mergeQueues([row('a')], [row('a')], [row('a')])).toEqual([row('a')]);
  });
});

describe('draft persistence adoption', () => {
  it('is idle only with no save queued, and adopt supersedes older queued snapshots', async () => {
    const persistence = new ProjectChatDraftPersistence(4, snapshot('old'));
    expect(persistence.idle).toBe(true);
    let release!: (revision: number) => void;
    const pending = persistence.save(snapshot('first'), () => new Promise<number>(resolve => { release = resolve; }));
    const write = vi.fn(async (revision: number) => revision + 1);
    const queued = persistence.save(snapshot('second'), write);
    expect(persistence.idle).toBe(false);
    await Promise.resolve(); await Promise.resolve();
    release(5);
    await pending;
    persistence.adopt(9, snapshot('theirs'));
    await queued;
    expect(write).not.toHaveBeenCalled();
    expect(persistence.idle).toBe(true);
    expect(persistence.revision).toBe(9);
    expect(persistence.saved).toEqual(snapshot('theirs'));
  });
  it('records the snapshot a rebased write actually stored', async () => {
    const persistence = new ProjectChatDraftPersistence(4, snapshot('old'));
    await persistence.save(snapshot('mine'), async () => ({ revision: 7, snapshot: snapshot('mine', 'merged') }));
    expect(persistence.revision).toBe(7);
    expect(persistence.saved).toEqual(snapshot('mine', 'merged'));
  });
});

describe('project chat reload ownership', () => {
  it('keeps an unmounted project owner registered and writes a revert after an older held write', async () => {
    const original = snapshot('saved');
    const persistence = new ProjectChatDraftPersistence(4, original);
    let releaseOlder!: (revision: number) => void;
    let releaseLatest!: (revision: number) => void;
    const write = vi.fn()
      .mockImplementationOnce(() => new Promise<number>(resolve => { releaseOlder = resolve; }))
      .mockImplementationOnce((revision: number) => new Promise<number>(resolve => { releaseLatest = () => resolve(revision + 1); }));
    const ownerWriter = (value: ReturnType<typeof snapshot>) => persistence.save(value, write);
    persistence.track(snapshot('older B'), ownerWriter);
    const older = persistence.save(snapshot('older B'), write);
    await Promise.resolve(); await Promise.resolve();
    persistence.track(original, ownerWriter);
    persistence.mounted = false;

    let barrierFinished = false;
    const barrier = flushDraftsBeforeReload().then(() => { barrierFinished = true; });
    await Promise.resolve();
    expect(barrierFinished).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    releaseOlder(5);
    await older;
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(barrierFinished).toBe(false);
    releaseLatest(6);
    await barrier;
    expect(persistence.saved).toEqual(original);
  });

  it('retains a failed dirty owner for a later durable retry', async () => {
    const persistence = new ProjectChatDraftPersistence(4, snapshot('saved'));
    const current = snapshot('unsaved');
    const write = vi.fn()
      .mockRejectedValueOnce(new Error('temporary write failure'))
      .mockImplementation(async (revision: number) => revision + 1);
    persistence.track(current, value => persistence.save(value, write));
    persistence.mounted = false;

    await expect(flushDraftsBeforeReload()).rejects.toThrow('temporary write failure');
    expect(persistence.saved).toEqual(snapshot('saved'));
    await flushDraftsBeforeReload();
    expect(persistence.saved).toEqual(current);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('keeps reload blocked while the current draft keeps changing during saves', async () => {
    const persistence = new ProjectChatDraftPersistence(4, snapshot('saved'));
    let writes = 0;
    const ownerWriter = (value: ReturnType<typeof snapshot>) => persistence.save(value, async revision => {
      writes++;
      persistence.track(snapshot(`edit ${writes}`), ownerWriter);
      return revision + 1;
    });
    persistence.track(snapshot('first edit'), ownerWriter);
    await expect(flushDraftsBeforeReload()).rejects.toThrow('kept changing');
    expect(writes).toBe(5);
    persistence.track(persistence.saved, ownerWriter);
  });
});
