import { describe, expect, it } from 'vitest';
import { ApiError } from '@/integrations/runtime/generated.ts';
import type { CanonicalDocument } from '@/integrations/runtime/generated.ts';
import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import { toOutboxJson } from './commitOutbox.ts';
import { createLocalSaveSession, type LocalSaveSession } from './localSaveSession.ts';
import { environment, h0, scope } from './__tests__/localSaveSessionEnvironment.ts';

const h1 = { revisionId: 'r1', publicationId: 'p1' };
const staleHead = () => new ApiError(409, 'conflict', 'stale', '', { status: 'refused', reason: 'stale_head', actual_head: 'r1' });
// The Runtime's validation answer that live-checked into the stuck state.
const validationRefusal = () => new ApiError(400, 'protocol_error', 'validation refused');

function laterDocument(base: CanonicalDocument, label: string): CanonicalDocument {
  const next = structuredClone(base);
  const payload = next.parent_revision.payload as { config: { tracks: Array<{ label: string }> }; tracks: Array<{ label: string }> };
  payload.config.tracks[0].label = label;
  payload.tracks[0].label = label;
  return next;
}

/** A session whose Runtime head has moved on to r1 since it mounted. */
function movedHead() {
  const env = environment();
  const latest = env.accepted(env.pair.document, h1);
  const mount = (basis = env.initial) => createLocalSaveSession({ scope, initial: basis, document: toOutboxJson(basis.canonicalDocument),
    outboxes: env.outboxes, send: env.send, loadLatest: async () => ({ head: h1, canonicalDocument: latest.canonicalDocument }),
    prepareDisplay: env.prepareDisplay, changed: () => {} });
  return { env, latest, mount };
}

async function laterEdit(env: ReturnType<typeof environment>, session: LocalSaveSession, base: CanonicalDocument, label: string) {
  const later = laterDocument(base, label);
  await session.appendDocument({ before: base, after: later, label,
    roots: [{ ref: 'parent', revisionId: h1.revisionId, contentDigest: base.parent_revision.content_digest }],
    step: { id: `${label}-step`, label, intent: label, tags: [] } } as Parameters<typeof session.appendDocument>[0]);
  return later;
}

describe('a refused save can always be discharged', () => {
  describe('stale head', () => {
    it.each([
      ['typed refused', staleHead()],
      ['reason only', new ApiError(409, 'conflict', 'stale', '', { reason: 'stale_head' })],
    ])('rebases onto the new head and resends (%s)', async (_name, failure) => {
      const { env, latest, mount } = movedHead();
      const session = await mount();
      await env.append(session);
      const requests: Array<{ request: CommitRequest; key: string }> = [];
      env.send.mockImplementation(async (request, key) => {
        requests.push({ request, key });
        if (requests.length === 1) throw failure;
        return env.accepted(latest.canonicalDocument, { revisionId: 'r2', publicationId: 'p2' });
      });
      await expect(session.flush()).resolves.toMatchObject({ head: { revisionId: 'r2' } });
      expect(requests.map((entry) => entry.request.base_revision_id)).toEqual([h0.revisionId, h1.revisionId]);
      expect(requests[1].key).not.toBe(requests[0].key);
      expect(requests[1].request.commands).toEqual(requests[0].request.commands);
      expect(session.getState().status).toBe('saved');
    });

    it('stops rebasing a head that never settles and leaves the refusal dischargeable', async () => {
      const { env, mount } = movedHead();
      const session = await mount();
      await env.append(session);
      env.send.mockRejectedValue(staleHead());
      await expect(session.flush()).rejects.toThrow();
      expect(env.send).toHaveBeenCalledTimes(6);
      expect(session.getState().status).toBe('conflict');
      await session.discharge('latest');
      expect(session.getState().status).toBe('saved');
    });
  });

  describe('a rejected change', () => {
    async function rejected() {
      const ctx = movedHead();
      const session = await ctx.mount();
      await ctx.env.append(session);
      ctx.env.send.mockRejectedValueOnce(validationRefusal());
      await expect(session.flush()).rejects.toThrow();
      expect(session.getState().status).toBe('error');
      return { ...ctx, session };
    }

    it('blocks the next edit until it is discharged', async () => {
      const { env, session } = await rejected();
      const document = toOutboxJson(session.getDocument());
      expect(() => session.append({ before: document, after: document, label: 'x', commands: [] })).toThrow('Resolve retained local saves');
      expect(env.send).toHaveBeenCalledTimes(1);
    });

    it('"use latest" drops it, adopts the latest head and lets the next edit save', async () => {
      const { env, latest, session } = await rejected();
      await session.discharge('latest');
      expect(session.getState().status).toBe('saved');
      expect(session.getDocument()).toEqual(JSON.parse(JSON.stringify(latest.canonicalDocument)));
      env.send.mockImplementation(async () => env.accepted(latest.canonicalDocument, { revisionId: 'r2', publicationId: 'p2' }));
      await laterEdit(env, session, latest.canonicalDocument, 'Next');
      await expect(session.flush()).resolves.toMatchObject({ head: { revisionId: 'r2' } });
      expect(env.send).toHaveBeenCalledTimes(2);
      expect(env.send.mock.calls[1][0].base_revision_id).toBe(h1.revisionId);
    });

    it('"keep" resends it on the latest head and the next edit saves', async () => {
      const { env, latest, session } = await rejected();
      const saved = env.accepted(latest.canonicalDocument, { revisionId: 'r2', publicationId: 'p2' });
      env.send.mockImplementation(async () => saved);
      await session.discharge('keep');
      expect(session.getState().status).toBe('saved');
      expect(env.send.mock.calls[1][0].base_revision_id).toBe(h1.revisionId);
      const next = env.accepted(saved.canonicalDocument, { revisionId: 'r3', publicationId: 'p3' });
      env.send.mockImplementation(async () => next);
      await session.appendDocument({ before: session.getDocument() as unknown as CanonicalDocument, after: laterDocument(saved.canonicalDocument, 'Next'), label: 'Next',
        roots: [{ ref: 'parent', revisionId: 'r2', contentDigest: saved.canonicalDocument.parent_revision.content_digest }],
        step: { id: 'n', label: 'Next', intent: 'Next', tags: [] } } as Parameters<typeof session.appendDocument>[0]);
      await expect(session.flush()).resolves.toMatchObject({ head: { revisionId: 'r3' } });
    });

    it('a real refusal on "keep" refuses again and is still dischargeable', async () => {
      const { env, session } = await rejected();
      env.send.mockRejectedValue(validationRefusal());
      await session.discharge('keep');
      expect(session.getState().status).toBe('error');
      await session.discharge('latest');
      expect(session.getState().status).toBe('saved');
    });

    it.each(['latest', 'keep'] as const)('is dischargeable after a reload with "%s"', async (mode) => {
      const { env, latest, mount, session } = await rejected();
      await session.dispose();
      const reopened = await mount();
      const [owner] = reopened.getState().recoverableOwners;
      expect(reopened.getState().status).toBe('recovery');
      await reopened.recover(owner).catch(() => {});
      expect(reopened.getState().status).toBe('error');
      env.send.mockImplementation(async () => env.accepted(latest.canonicalDocument, { revisionId: 'r2', publicationId: 'p2' }));
      await reopened.discharge(mode);
      expect(reopened.getState().status).toBe('saved');
      expect((await env.outboxes.list(scope)).filter((entry) => entry.intents.length || entry.pending)).toEqual([]);
    });

    it('does nothing when nothing is rejected', async () => {
      const { mount } = movedHead();
      const session = await mount();
      await session.discharge('latest');
      expect(session.getState().status).toBe('saved');
    });

    it('discharges a chain of two rejected changes whose base is gone from the server', async () => {
      const { env, latest, mount } = movedHead();
      const session = await mount();
      await env.append(session);
      const second = laterDocument(env.pair.after, 'Second');
      await session.appendDocument({ before: env.pair.after, after: second, label: 'Second',
        roots: [{ ref: 'parent', revisionId: h0.revisionId, contentDigest: env.pair.after.parent_revision.content_digest }],
        step: { id: 'second-step', label: 'Second', intent: 'Second', tags: [] } } as Parameters<typeof session.appendDocument>[0]);
      env.send.mockRejectedValue(validationRefusal());
      await expect(session.flush()).rejects.toThrow();
      const [owner] = await env.outboxes.list(scope);
      expect(owner.intents).toHaveLength(2);
      expect(owner.intents.every((intent) => intent.conflict !== undefined)).toBe(true);
      await session.discharge('latest');
      expect(session.getState().status).toBe('saved');
      expect((await env.outboxes.list(scope))[0].intents).toEqual([]);
      expect(session.getDocument()).toEqual(JSON.parse(JSON.stringify(latest.canonicalDocument)));
    });
  });

  describe('two editor sessions left work on the same head', () => {
    it('recovers both in turn; the second is rebased onto what the first landed', async () => {
      const { env, mount } = movedHead();
      const first = await mount();
      const other = await mount();
      await env.append(first);
      await other.appendDocument({ before: env.pair.document, after: laterDocument(env.pair.document, 'Other'), label: 'Other',
        roots: [{ ref: 'parent', revisionId: h0.revisionId, contentDigest: env.pair.document.parent_revision.content_digest }],
        step: { id: 'other-step', label: 'Other', intent: 'Other', tags: [] } } as Parameters<typeof other.appendDocument>[0]);
      env.send.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(first.flush()).rejects.toThrow('remain unacknowledged');
      await expect(other.flush()).rejects.toThrow('remain unacknowledged');
      await first.dispose();
      await other.dispose();

      const bases: string[] = [];
      env.send.mockReset();
      env.send.mockImplementation(async (request) => {
        bases.push(request.base_revision_id);
        // The head is r1 once any save landed; a request still on r0 after that is stale.
        if (request.base_revision_id === h0.revisionId && bases.length > 1) throw staleHead();
        return env.accepted(env.pair.document, request.base_revision_id === h0.revisionId ? h1 : { revisionId: 'r2', publicationId: 'p2' });
      });
      const reopened = await mount();
      const owners = reopened.getState().recoverableOwners;
      expect(owners).toHaveLength(2);
      for (const owner of owners) await reopened.recover(owner);
      expect(reopened.getState().status).toBe('saved');
      expect(bases).toEqual([h0.revisionId, h0.revisionId, h1.revisionId]);
      expect((await env.outboxes.list(scope)).filter((entry) => entry.intents.length || entry.pending)).toEqual([]);
    });
  });
});
