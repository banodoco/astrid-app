import { describe, expect, it } from 'vitest';
import { ApiError } from '@/integrations/runtime/generated.ts';
import type { CanonicalDocument } from '@/integrations/runtime/generated.ts';
import { toOutboxJson } from './commitOutbox.ts';
import { createLocalSaveSession, LocalSaveDeclined, type LocalSaveSession } from './localSaveSession.ts';
import { environment, h0, scope } from './__tests__/localSaveSessionEnvironment.ts';
import { saveBarInput } from '../hooks/saveBar.ts';

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
function world() {
  const env = environment();
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

        await session.discharge('latest');

        expect(session.getState().status).toBe('saved');
        expect(session.getState().recoverableOwners).toEqual([]);
        expect(await retained()).toEqual([]);
        // Every owner that existed is gone, not just emptied.
        expect((await env.outboxes.list(scope)).map((owner) => owner.ownerId).filter((id) => before.includes(id))).toEqual([]);
        expect(saveBarInput({ local: session.getState(), recoveryDraft: null, conflictExhausted: false,
          schemaIncompatible: false, watchdogTripped: false, saveError: null, bootstrapFailed: false })).toBeNull();

        env.send.mockReset();
        env.send.mockImplementation(async () => env.accepted(latest.canonicalDocument, h2));
        await laterEdit(session, 'Next');
        await expect(session.flush()).resolves.toMatchObject({ head: { revisionId: 'r2' } });

        // And after a reload nothing comes back.
        await session.dispose();
        const reopened = await mount();
        expect(reopened.getState().status).toBe('saved');
        expect(reopened.getState().recoverableOwners).toEqual([]);
        expect(await retained()).toEqual([]);
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

  it('fences a second tab that still holds a discarded owner: its next write fails and resurrects nothing', async () => {
    const { env, mount, retained, laterEdit, latest } = world();
    env.send.mockRejectedValue(new TypeError('Failed to fetch'));
    const tabA = await mount();
    await env.append(tabA);
    await expect(tabA.flush()).rejects.toThrow();
    const tabB = await mount();
    for (const owner of tabB.getState().recoverableOwners) await tabB.recover(owner).catch(() => {});

    await tabB.discharge('latest');
    expect(await retained()).toEqual([]);

    // Tab A still believes it owns the deleted row: the generation check refuses it.
    env.send.mockReset();
    env.send.mockImplementation(async () => env.accepted(latest.canonicalDocument, h2));
    await expect(laterEdit(tabA, 'Stale tab')).rejects.toThrow();
    expect(await retained()).toEqual([]);
    expect(env.send).not.toHaveBeenCalled();
  });

  it('retries an unavailable Runtime by itself, with a growing wait, and Try again retries at once', async () => {
    const { env, mount } = world();
    const { vi } = await import('vitest');
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
      // An edit retained under the old realm, plus two empty owners left by earlier editor sessions.
      await env.outboxes.create(oldScope, async (box) => { await box.append({ kind: 'stale' }, { head: h0 }); });
      await env.outboxes.create(oldScope, async () => undefined);
      await env.outboxes.create(scope, async () => undefined);
      await env.outboxes.create(scope, async () => undefined);
    }

    it('are deleted when the session starts, so a stale row never becomes a recoverable owner', async () => {
      const { env, mount } = world();
      await leaveRows(env);
      expect((await rows(env)).length).toBe(4);
      const session = await mount();
      expect(session.getState().status).toBe('saved');
      expect(session.getState().recoverableOwners).toEqual([]);
      // Only the session's own fresh owner is left.
      expect(await rows(env)).toHaveLength(1);
      await session.dispose();
    });

    it('are all deleted by Discard whatever realm wrote them', async () => {
      const { env, mount } = world();
      const session = await mount();
      await leaveRows(env);
      env.send.mockRejectedValue(failures.refused());
      await env.append(session);
      await expect(session.flush()).rejects.toThrow();
      await session.discharge('latest');
      const left = await rows(env);
      expect(left.filter((row) => row.realmId === 'old-realm' || row.intents.length || row.pending)).toEqual([]);
      expect(session.getState().status).toBe('saved');
    });
  });
});
