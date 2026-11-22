import { beforeEach, describe, expect, it } from 'vitest';
// Install fake-indexeddb before importing the module under test so its
// `typeof indexedDB` guards see a real implementation.
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
const fakeIndexedDb = createFakeIndexedDB();
vi.stubGlobal('indexedDB', fakeIndexedDb);
vi.stubGlobal('IDBKeyRange', (await import('fake-indexeddb')).IDBKeyRange);

import {
  advanceTimelineDraftBaseAfterHeadAcknowledgement,
  clearTimelineDraft,
  clearTimelineDraftIfMatches,
  loadTimelineDraft,
  reconcileTimelineDraftHeadMarker,
  saveTimelineDraft,
  saveTimelineDraftIfOwner,
} from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';
import { createCommitOutbox } from '@/tools/video-editor/commands/commitOutbox.ts';

describe('timelineDraftIndexedDb — one-slot recovery draft (plan-v5 B9)', () => {
  beforeEach(() => {
    resetFakeIndexedDB();
  });

  it('round-trips a draft with its base version', async () => {
    await saveTimelineDraft('tl-1', { config: { name: 'x' }, registry: { assets: {} } }, 42);

    const record = await loadTimelineDraft('tl-1');
    expect(record?.timelineId).toBe('tl-1');
    expect(record?.baseVersion).toBe(42);
    expect(record?.draft).toEqual({ config: { name: 'x' }, registry: { assets: {} } });
    expect(record?.updatedAt).toBeTruthy();
  });

  it('keeps exactly one slot per timeline: a new draft overwrites the old', async () => {
    await saveTimelineDraft('tl-1', { config: { name: 'first' } }, 1);
    await saveTimelineDraft('tl-1', { config: { name: 'second' } }, 2);

    const record = await loadTimelineDraft('tl-1');
    expect(record?.baseVersion).toBe(2);
    expect(record?.draft).toEqual({ config: { name: 'second' } });
  });

  it('returns null for a timeline with no draft', async () => {
    expect(await loadTimelineDraft('tl-ghost')).toBeNull();
  });

  it('suppresses only the exact acknowledged draft and recovers a newer refused draft for its outbox owner', async () => {
    const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project', timelineId: 'timeline' };
    const outbox = createCommitOutbox({ indexedDB: fakeIndexedDb, exclusiveLock: async (_name, work) => work() });
    let outboxOwnerId = '';
    const acknowledgedDraftOwnerId = 'draft-acknowledged';
    const refusedDraftOwnerId = 'draft-refused';

    await outbox.create(scope, async (claimed, ownerId) => {
      outboxOwnerId = ownerId;
      await claimed.append({ edit: 'acknowledged' }, { head: { revisionId: 'r0', publicationId: 'p0' } }, acknowledgedDraftOwnerId);
      await claimed.dispatch((intent) => ({
        method: 'POST', path: '/v1/projects/project/timelines/timeline/commit', body: intent.payload,
      }), async () => ({ kind: 'accepted', head: { revisionId: 'r1', publicationId: 'p1' }, value: {} }));
      await claimed.append({ edit: 'refused' }, { head: { revisionId: 'r1', publicationId: 'p1' } }, refusedDraftOwnerId);
      await claimed.dispatch((intent) => ({
        method: 'POST', path: '/v1/projects/project/timelines/timeline/commit', body: intent.payload,
      }), async () => ({ kind: 'rejected', error: { status: 'refused' } }));
    });

    await saveTimelineDraft('timeline', { edit: 'acknowledged' }, 1, {
      recoveryKey: 'timeline:occurrence', ownerId: acknowledgedDraftOwnerId,
      outboxOwnerId, outboxScope: scope,
    });
    expect(await loadTimelineDraft('timeline:occurrence')).toBeNull();

    await saveTimelineDraft('timeline', { edit: 'refused' }, 2, {
      recoveryKey: 'timeline:occurrence', ownerId: refusedDraftOwnerId,
      draftIdentity: refusedDraftOwnerId, outboxOwnerId, outboxScope: scope,
    });
    expect(await loadTimelineDraft('timeline:occurrence')).toMatchObject({
      ownerId: refusedDraftOwnerId,
      draftIdentity: refusedDraftOwnerId,
      outboxOwnerId,
      draft: { edit: 'refused' },
    });
  });

  it('clear removes the slot; the draft is retained until then', async () => {
    await saveTimelineDraft('tl-1', { config: { name: 'x' } }, 7);
    expect(await loadTimelineDraft('tl-1')).not.toBeNull();

    await clearTimelineDraft('tl-1');
    expect(await loadTimelineDraft('tl-1')).toBeNull();
  });

  it('compare-and-delete never lets an old acknowledgement clear a newer owner', async () => {
    const recoveryKey = 'tl-1:occurrence-1';
    await saveTimelineDraft('tl-1', { config: { name: 'first' } }, 1, {
      recoveryKey,
      draftIdentity: 'edit-1',
      ownerId: 'owner-1',
    });
    await saveTimelineDraft('tl-1', { config: { name: 'newer' } }, 1, {
      recoveryKey,
      draftIdentity: 'edit-2',
      ownerId: 'owner-2',
    });

    await clearTimelineDraft(recoveryKey, 'owner-1');
    expect(await loadTimelineDraft(recoveryKey)).toMatchObject({
      ownerId: 'owner-2',
      draftIdentity: 'edit-2',
      draft: { config: { name: 'newer' } },
    });

    await clearTimelineDraft(recoveryKey, 'owner-2');
    expect(await loadTimelineDraft(recoveryKey)).toBeNull();
  });

  it('conditionally acknowledges only the matching publication identity', async () => {
    await saveTimelineDraft('session-a', { config: { name: 'A' } }, 1, {
      recoveryKey: 'occurrence-1',
      draftIdentity: 'edit-A',
      acknowledgementIdentity: 'publish-A',
    });
    await saveTimelineDraft('session-b', { config: { name: 'B' } }, 1, {
      recoveryKey: 'occurrence-1',
      draftIdentity: 'edit-B',
    });

    expect(await clearTimelineDraftIfMatches('occurrence-1', 'publish-A')).toBe(false);
    expect((await loadTimelineDraft('occurrence-1'))?.draft).toEqual({ config: { name: 'B' } });
  });

  it('reconciles only the matching recovery owner head marker and preserves draft content/base', async () => {
    const key = 'shot-recovery';
    const clips = [{ id: 'clip-B', at: 0.7 }];
    await saveTimelineDraft('popup-session', {
      config: {
        clips,
        app: { canonicalComposition: { headRevisionId: 'head-H0', preserved: true } },
      },
      registry: { assets: {} },
    }, 4, {
      recoveryKey: key,
      draftIdentity: 'edit-B',
      ownerId: 'owner-B',
      baseHeadRevisionId: 'head-H1',
      baseCanonicalGraph: { revision: 'H1' },
      acknowledgementIdentity: 'publish-A',
    });
    const before = await loadTimelineDraft(key);

    expect(await reconcileTimelineDraftHeadMarker(key, 'stale-owner', 'head-H1')).toBe(false);
    expect(await reconcileTimelineDraftHeadMarker(key, 'edit-B', 'head-H0')).toBe(false);
    expect(await reconcileTimelineDraftHeadMarker(key, 'edit-B', 'head-H1')).toBe(true);

    const after = await loadTimelineDraft(key);
    expect(after).toMatchObject({
      draftIdentity: 'edit-B',
      ownerId: 'owner-B',
      baseVersion: 4,
      baseHeadRevisionId: 'head-H1',
      baseCanonicalGraph: { revision: 'H1' },
      acknowledgementIdentity: 'publish-A',
      updatedAt: before?.updatedAt,
      draft: {
        config: {
          clips,
          app: { canonicalComposition: { headRevisionId: 'head-H1', preserved: true } },
        },
        registry: { assets: {} },
      },
    });
  });

  it('preserves a newer B queued ahead of A publication and protects it from A acknowledgement', async () => {
      const key = 'occurrence-concurrent';
      await saveTimelineDraft('session-a', { config: { name: 'A' } }, 1, {
        recoveryKey: key,
        draftIdentity: 'edit-A',
      });
      const writeA = () => saveTimelineDraftIfOwner(
        'session-a',
        { config: { name: 'A-published' }, canonicalPublication: { idempotencyKey: 'publish-A' } },
        1,
        {
          recoveryKey: key,
          draftIdentity: 'publish-A',
          acknowledgementIdentity: 'publish-A',
        },
        'edit-A',
        (current, candidate) => ({
          ...current,
          // Preserve B's durable config, CAS base, and owner while retaining
          // A's exact retry candidate for explicit recovery if needed.
          draft: { ...current.draft, canonicalPublication: candidate.draft.canonicalPublication },
        }),
      );
      const writeB = () => saveTimelineDraft('session-b', { config: { name: 'B' } }, 2, {
        recoveryKey: key,
        baseHeadRevisionId: 'head-B',
        baseCanonicalGraph: { head: 'head-B' },
        draftIdentity: 'edit-B',
      });

      // Start both independent read-write transactions without awaiting
      // either. B is queued first, so A's conditional transaction must observe
      // the newer owner and merge only the publication retry metadata.
      await Promise.all([writeB(), writeA()]);

      expect(await clearTimelineDraftIfMatches(key, 'publish-A')).toBe(false);
      const reopened = await loadTimelineDraft(key);
      expect(reopened).toMatchObject({
        baseVersion: 2,
        baseHeadRevisionId: 'head-B',
        baseCanonicalGraph: { head: 'head-B' },
        draftIdentity: 'edit-B',
        draft: { config: { name: 'B' } },
      });
      expect(reopened?.draft.canonicalPublication).toEqual({ idempotencyKey: 'publish-A' });
  });

  it('advances only the queued draft that is still based on the acknowledged head', async () => {
    const key = 'occurrence-head-advance';
    const expectedHead = { projectId: 'project', timelineId: 'timeline', headRevisionId: 'head-0' };
    const acknowledgedHead = { ...expectedHead, headRevisionId: 'head-1' };
    await saveTimelineDraft('timeline', { config: { name: 'B' } }, 2, {
      recoveryKey: key,
      ownerId: 'owner-B',
      baseHeadProjectId: expectedHead.projectId,
      baseHeadTimelineId: expectedHead.timelineId,
      baseHeadRevisionId: expectedHead.headRevisionId,
    });

    expect(await advanceTimelineDraftBaseAfterHeadAcknowledgement(
      key,
      'wrong-owner',
      expectedHead,
      acknowledgedHead,
    )).toBe(false);
    expect(await advanceTimelineDraftBaseAfterHeadAcknowledgement(
      key,
      'owner-B',
      expectedHead,
      acknowledgedHead,
    )).toBe(true);
    expect(await loadTimelineDraft(key)).toMatchObject({
      ownerId: 'owner-B',
      baseHeadProjectId: 'project',
      baseHeadTimelineId: 'timeline',
      baseHeadRevisionId: 'head-1',
      draft: { config: { name: 'B' } },
    });
  });

  it('drafts for different timelines do not collide', async () => {
    await saveTimelineDraft('tl-a', { config: { name: 'a' } }, 1);
    await saveTimelineDraft('tl-b', { config: { name: 'b' } }, 2);

    expect((await loadTimelineDraft('tl-a'))?.draft).toEqual({ config: { name: 'a' } });
    expect((await loadTimelineDraft('tl-b'))?.draft).toEqual({ config: { name: 'b' } });
  });
});
