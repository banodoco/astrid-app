import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { ApiError } from '@/integrations/runtime/generated.ts';
import type { CanonicalDocument } from '@/integrations/runtime/generated.ts';
import { toOutboxJson } from './commitOutbox.ts';
import { createLocalSaveSession, LocalSaveDeclined, type LocalSaveSession } from './localSaveSession.ts';
import { environment, h0, scope } from './__tests__/localSaveSessionEnvironment.ts';
import { saveBarInput } from '../hooks/saveBar.ts';
import { clearTimelineDraft, hasOutboxRecoveryDraft, saveTimelineDraft } from '../data/timelineDraftIndexedDb.ts';

const h1 = { revisionId: 'r1', publicationId: 'p1' };
const h2 = { revisionId: 'r2', publicationId: 'p2' };

// The ways a save ends up unsaved. Each is one outcome of the one `send`.
const failures = {
  unavailable: () => new TypeError('Failed to fetch'),
  refused: () => new ApiError(400, 'protocol_error', 'validation refused'),
  'head moved': () => new ApiError(409, 'conflict', 'stale', '', { status: 'refused', reason: 'stale_head', actual_head: 'r1' }),
  // A 409 with no typed reason, like the media-selection digest refusal.
  'untyped 409': () => new ApiError(409, 'conflict', 'selected media catalog digest changed', '', {}),
} as const;

function laterDocument(base: CanonicalDocument, label: string): CanonicalDocument {
  const next = structuredClone(base);
  const payload = next.parent_revision.payload as { config: { tracks: Array<{ label: string }> }; tracks: Array<{ label: string }> };
  payload.config.tracks[0].label = label;
  payload.tracks[0].label = label;
  return next;
}

/** One timeline whose Runtime head has moved to r1, with sessions that can mount on it. */
function world(isRecoveryOwner?: Parameters<typeof environment>[0]) {
  const env = environment(isRecoveryOwner);
  const latest = env.accepted(env.pair.document, h1);
  const mount = () => createLocalSaveSession({ scope, initial: env.initial, document: toOutboxJson(env.initial.canonicalDocument),
    outboxes: env.outboxes, send: env.send, loadLatest: async () => ({ head: h1, canonicalDocument: latest.canonicalDocument }),
    prepareDisplay: env.prepareDisplay, changed: () => {} });
  const retained = async () => (await env.outboxes.list(scope)).filter((owner) => owner.intents.length || owner.pending);
  const laterEdit = async (session: LocalSaveSession, label: string) => session.appendDocument({
    before: latest.canonicalDocument, after: laterDocument(latest.canonicalDocument, label), label,
    roots: [{ ref: 'parent', revisionId: h1.revisionId, contentDigest: latest.canonicalDocument.parent_revision.content_digest }],
    step: { id: `${label}-step`, label, intent: label, tags: [] } } as Parameters<typeof session.appendDocument>[0]);
  return { env, latest, mount, retained, laterEdit };
}

// Lead ruling of 21 Nov (R14 App int merge: FIX-16 cross-tab rule wins)
describe('Discard is total: any unsaved state, one or two retained owners, before and after a reload', () => {
  describe.each(Object.keys(failures) as Array<keyof typeof failures>)('%s', (failure) => {
    describe.each([1, 2])('with %i retained owner(s)', (ownerCount) => {
      it.each([false, true])('shows the bar, leaves a saved state, saves the next edit and stays clean (reload first: %s)', async (reloadFirst) => {
        const { env, latest, mount, retained, laterEdit } = world();
        let session = await mount();
        // A second editor session's leftover, retained on a network error. Both mount before either fails.
        const other = ownerCount === 2 ? await mount() : undefined;
        if (other) {
          env.send.mockRejectedValueOnce(new TypeError('Failed to fetch'));
          await other.appendDocument({ before: env.pair.document, after: laterDocument(env.pair.document, 'Other'), label: 'Other',
            roots: [{ ref: 'parent', revisionId: h0.revisionId, contentDigest: env.pair.document.parent_revision.content_digest }],
            step: { id: 'other-step', label: 'Other', intent: 'Other', tags: [] } } as Parameters<typeof other.appendDocument>[0]);
          await other.flush().catch(() => {});
          await other.dispose();
        }
        env.send.mockReset();
        env.send.mockRejectedValue(failures[failure]());
        await env.append(session);
        await expect(session.flush()).rejects.toThrow();
        if (reloadFirst) {
          await session.dispose();
          session = await mount();
          for (const owner of session.getState().recoverableOwners) await session.recover(owner).catch(() => {});
        }
        expect((await retained()).length).toBeGreaterThanOrEqual(1);
        expect(saveBarInput({ local: session.getState(), recoveryDraft: null, conflictExhausted: false,
          schemaIncompatible: false, watchdogTripped: false, saveError: null, bootstrapFailed: false })).not.toBeNull();
        const before = (await env.outboxes.list(scope)).map((owner) => owner.ownerId);
        const offeredOwner = session.getState().ownerId;
        expect(offeredOwner).toBeTruthy();
        expect(before).toContain(offeredOwner);

        await session.discharge('latest');

        expect(session.getState().status).toBe('saved');
        const preserved = before.filter((id) => id !== offeredOwner);
        expect(session.getState().recoverableOwners).toEqual(preserved);
        expect((await retained()).map((owner) => owner.ownerId)).toEqual(preserved);
        // Discard deletes only the exact owner claimed for this action.
        expect((await env.outboxes.list(scope)).map((owner) => owner.ownerId)).not.toContain(offeredOwner);
        expect((await env.outboxes.list(scope)).map((owner) => owner.ownerId).filter((id) => before.includes(id))).toEqual(preserved);
        expect(saveBarInput({ local: session.getState(), recoveryDraft: null, conflictExhausted: false,
          schemaIncompatible: false, watchdogTripped: false, saveError: null, bootstrapFailed: false })).toBeNull();

        env.send.mockReset();
        env.send.mockImplementation(async () => env.accepted(latest.canonicalDocument, h2));
        await laterEdit(session, 'Next');
        await expect(session.flush()).resolves.toMatchObject({ head: { revisionId: 'r2' } });

        // A preserved sibling remains recoverable after a reload.
        await session.dispose();
        const reopened = await mount();
        expect(reopened.getState().status).toBe(preserved.length ? 'recovery' : 'saved');
        expect(reopened.getState().recoverableOwners).toEqual(preserved);
        expect((await retained()).map((owner) => owner.ownerId)).toEqual(preserved);
        await reopened.dispose();
      });
    });
  });

  it('declines an edit while earlier saves are unresolved with a typed refusal the editor can undo', async () => {
    const { env, mount, latest } = world();
    env.send.mockRejectedValue(failures.refused());
    const session = await mount();
    await env.append(session);
    await expect(session.flush()).rejects.toThrow();
    const document = toOutboxJson(session.getDocument());
    expect(() => session.append({ before: document, after: document, label: 'x', commands: [] })).toThrow(LocalSaveDeclined);
    expect(latest).toBeTruthy();
  });

  it('Discard stops a send loop that is already running and a retry timer that is already armed', async () => {
    const { env, mount, retained } = world();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const session = await mount();
    await env.append(session);
    await session.appendDocument({ before: env.pair.after, after: laterDocument(env.pair.after, 'Second'), label: 'Second',
      roots: [{ ref: 'parent', revisionId: h0.revisionId, contentDigest: env.pair.after.parent_revision.content_digest }],
      step: { id: 'second-step', label: 'Second', intent: 'Second', tags: [] } } as Parameters<typeof session.appendDocument>[0]);
    env.send.mockImplementation(async () => { await hold; return env.accepted(env.pair.after, h1); });
    const flushing = session.flush().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const discarding = session.discharge('latest');
    release();
    await Promise.all([flushing, discarding]);
    // Only the request already in flight was sent: the second intent was not dispatched after Discard.
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(await retained()).toEqual([]);
    expect(session.getState().status).toBe('saved');
  });

  it('discards only the offered owner while preserving a newer retained owner from another tab', async () => {
    const { env, mount, retained } = world();
    const offeredTab = await mount();
    const otherTab = await mount();
    env.send.mockRejectedValueOnce(failures.refused());
    await env.append(offeredTab);
    await expect(offeredTab.flush()).rejects.toThrow();
    const offeredOwner = offeredTab.getState().ownerId;
    env.send.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const newerDocument = laterDocument(env.pair.document, 'Other tab edit');
    await otherTab.appendDocument({ before: env.pair.document, after: newerDocument, label: 'Other tab edit',
      roots: [{ ref: 'parent', revisionId: h0.revisionId, contentDigest: env.pair.document.parent_revision.content_digest }],
      step: { id: 'other-tab-step', label: 'Other tab edit', intent: 'Keep the later edit', tags: [] } });
    await expect(otherTab.flush()).rejects.toThrow();

    const otherOwner = otherTab.getState().ownerId;
    expect(offeredOwner).toBeTruthy();
    expect(otherOwner).toBeTruthy();
    expect(otherOwner).not.toBe(offeredOwner);
    const tabBSnapshot = (await retained()).find((owner) => owner.ownerId === otherOwner);
    expect(tabBSnapshot?.intents[0].payload).toMatchObject({ label: 'Other tab edit' });

    await offeredTab.discharge('latest');

    expect(await retained()).toEqual([tabBSnapshot]);
    expect((await env.outboxes.list(scope)).map((owner) => owner.ownerId)).not.toContain(offeredOwner);

    env.send.mockReset();
    env.send.mockImplementation(async () => env.accepted(newerDocument, h2));
    await otherTab.discharge('keep');
    await expect(otherTab.flush()).resolves.toMatchObject({ head: { revisionId: 'r2' } });
    expect(await retained()).toEqual([]);

    await offeredTab.dispose();
    await otherTab.dispose();
  });

  it('preserves another tab owner and lets that tab continue flushing after the offered owner is discarded', async () => {
    const { env, mount, retained, latest } = world();
    const tabA = await mount();
    const tabB = await mount();
    env.send.mockRejectedValueOnce(failures.refused());
    await env.append(tabA);
    await expect(tabA.flush()).rejects.toThrow();
    const oldOwner = tabA.getState().ownerId;
    env.send.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await env.append(tabB);
    await expect(tabB.flush()).rejects.toThrow();

    await tabA.discharge('latest');
    expect((await env.outboxes.list(scope)).map((owner) => owner.ownerId)).not.toContain(oldOwner);
    expect((await retained()).map((owner) => owner.ownerId)).toEqual([tabB.getState().ownerId]);
    env.send.mockReset();
    env.send.mockImplementation(async () => env.accepted(latest.canonicalDocument, h2));
    await tabB.discharge('keep');
    await expect(tabB.flush()).resolves.toMatchObject({ head: { revisionId: 'r2' } });
  });

  it('retries an unavailable Runtime by itself, with a growing wait, and Try again retries at once', async () => {
    const { env, mount } = world();
    vi.useFakeTimers();
    try {
      env.send.mockRejectedValue(new TypeError('Failed to fetch'));
      const session = await mount();
      await env.append(session);
      await expect(session.flush()).rejects.toThrow();
      expect(env.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(env.send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1500);
      expect(env.send).toHaveBeenCalledTimes(2); // the second wait is 2 s
      await vi.advanceTimersByTimeAsync(600);
      expect(env.send).toHaveBeenCalledTimes(3);
      env.send.mockImplementation(async () => env.accepted(env.pair.after, h1));
      await session.discharge('keep');
      expect(session.getState().status).toBe('saved');
      await session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('rows a rebuilt stack leaves behind (another realm, or empty)', () => {
    const oldScope = { ...scope, realmId: 'old-realm' };
    const rows = async (env: ReturnType<typeof world>['env']) =>
      [...await env.outboxes.list(oldScope), ...await env.outboxes.list(scope)];

    async function leaveRows(env: ReturnType<typeof world>['env']) {
      // What older builds left behind: an edit retained under the old realm, empty owners of the old realm, and
      // thirty empty owners of this realm (some holding an accepted prefix).
      await env.putRow({ scope: oldScope, ownerId: 'old-with-edit', intents: [{ id: 'i', basis: { head: h0 }, payload: {} }] });
      await env.putRow({ scope: oldScope, ownerId: 'old-empty' });
      for (let index = 0; index < 30; index += 1) {
        await env.putRow({ scope, ownerId: `empty-${index}`, ...(index % 2 ? { accepted: { intentId: 'a', head: h0, value: {} } } : {}) });
      }
    }

    it('preserves nonempty rows and prunes only proven-empty rows when the session starts', async () => {
      const { env, mount } = world();
      await leaveRows(env);
      expect((await rows(env)).length).toBe(32);
      const session = await mount();
      expect(session.getState().status).toBe('saved');
      expect(session.getState().recoverableOwners).toEqual([]);
      expect((await rows(env)).map((row) => row.ownerId)).toEqual(['old-with-edit', session.getState().ownerId]);
      await session.dispose();
    });

    it('are not left by a session that ends with nothing to send: its own row goes when it releases the claim', async () => {
      const { env, mount } = world();
      for (let index = 0; index < 5; index += 1) await (await mount()).dispose();
      expect(await rows(env)).toEqual([]);
    });

    it('keeps an empty owner while a draft write links it to an occurrence recovery slot', async () => {
      const previousIndexedDb = globalThis.indexedDB;
      vi.stubGlobal('indexedDB', createFakeIndexedDB());
      const { env, mount } = world(hasOutboxRecoveryDraft);
      const recoveryKey = 'parent:shot:occurrence';
      try {
        const session = await mount();
        const ownerId = session.getState().ownerId;
        let finishWrite!: () => void;
        const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
        const writing = session.writeRecoveryDraft(async (outboxOwnerId) => {
          expect(outboxOwnerId).toBe(ownerId);
          await pendingWrite;
          await saveTimelineDraft(scope.timelineId, { config: env.pair.config }, 1, { recoveryKey, outboxOwnerId });
        });
        const disposing = session.dispose();
        finishWrite();
        await Promise.all([writing, disposing]);

        await (await mount()).dispose();
        expect((await rows(env)).map((row) => row.ownerId)).toEqual([ownerId]);
        await clearTimelineDraft(recoveryKey);
        await (await mount()).dispose();
        expect(await rows(env)).toEqual([]);
      } finally {
        vi.stubGlobal('indexedDB', previousIndexedDb);
      }
    });

    it('preserves unrelated owners and old-realm nonempty rows during Discard', async () => {
      const { env, mount } = world();
      const session = await mount();
      await leaveRows(env);
      env.send.mockRejectedValue(failures.refused());
      await env.append(session);
      await expect(session.flush()).rejects.toThrow();
      expect((await env.outboxes.list(oldScope)).find((row) => row.ownerId === 'old-with-edit')?.intents).toHaveLength(1);
      await session.discharge('latest');
      const left = await rows(env);
      expect(left.map((row) => row.ownerId)).toContain('old-with-edit');
      expect(left.map((row) => row.ownerId)).toContain('old-empty');
      expect(left.find((row) => row.ownerId === 'old-with-edit')?.intents).toHaveLength(1);
      expect(session.getState().status).toBe('saved');
    });
  });
});
