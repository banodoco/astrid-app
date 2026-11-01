import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createCommitOutbox, toOutboxJson, type OutboxJson } from './commitOutbox.ts';
import { createLocalSaveSession, type LocalSave, type LocalSaveSession, type LocalSaveState } from './localSaveSession.ts';

// These document-intent cases exercise the pre-v2 fallback explicitly. The
// joined generated client is full-v2, so the unavailable-contract condition
// must not depend on the production metadata.
vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  SCHEMA_DIGEST: 'sha256:unsupported-test-fixture',
}));

const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-commit' };
const h0 = { revisionId: 'r0', publicationId: 'p0' };
const h1 = { revisionId: 'r1', publicationId: 'p1' };
const h2 = { revisionId: 'r2', publicationId: 'p2' };
const original = { clips: [{ id: 'left', from: 0, to: 4, hold: 4, opaque: [null, false] }], meta: { opaque: null } };
const split = { ...original, clips: [
  { ...original.clips[0], to: 2, hold: 2 },
  { ...original.clips[0], id: 'right', from: 2, hold: 2 },
] };
const trimmed = { ...split, clips: [split.clips[0], { ...split.clips[1], to: 3, hold: 1 }] };
const splitCommands: CommitRequest['commands'] = [{ schema_version: 1, op: 'clip.split', version: '1', select: 'parent/clip:left',
  args: { on: 2, right_id: 'right' }, created: ['parent/clip:right'],
  reads: [{ ref: 'parent/clip:left', path: ['to'], state: { state: 'present', value: 4 } }] }];
const trimCommands: CommitRequest['commands'] = [{ schema_version: 1, op: 'clip.trim', version: '1', select: 'parent/clip:right',
  args: { out_s: 3 }, expect: { to: { state: 'present', value: 4 } },
  reads: [{ ref: 'parent/clip:right', path: ['from'], state: { state: 'present', value: 2 } }] }];
const splitSave = (): LocalSave => ({ before: original, after: split, label: 'Split clip', commands: structuredClone(splitCommands) });
const trimSave = (): LocalSave => ({ before: split, after: trimmed, label: 'Trim new clip', commands: structuredClone(trimCommands) });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
function result(document: OutboxJson, head = h1, base = h0, rebased = false): TimelineCommitResult {
  const response = acceptedCommit({ revision_id: head.revisionId, publication_id: head.publicationId },
    { revision_id: base.revisionId, publication_id: base.publicationId });
  response.data.canonical_document.parent_revision.payload = structuredClone(document) as Record<string, unknown>;
  response.data.canonical_document.parent_revision.content_digest = fixtureDigest(document);
  response.data.document_digest = fixtureDigest(response.data.canonical_document);
  if (rebased) {
    response.data.status = 'rebased';
    response.data.rebased_onto = { revision_id: 'agent-r', publication_id: 'agent-p' };
  }
  return { response, accepted: head, canonicalDocument: response.data.canonical_document, graph: {}, receipt: response.receipt };
}
function environment() {
  const held = new Set<string>();
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (key, work) => {
    if (held.has(key)) throw new Error('claimed');
    held.add(key);
    try { return await work(); } finally { held.delete(key); }
  } });
  const initialResult = result(original, h0, h0);
  const initial: TimelineCommandBasis = { head: h0, canonicalDocument: initialResult.canonicalDocument };
  const send = vi.fn<(request: CommitRequest, key: string) => Promise<TimelineCommitResult>>();
  const loadLatest = vi.fn(async () => initial);
  const states: LocalSaveState[] = [];
  let visible: OutboxJson = structuredClone(original);
  const adopted: OutboxJson[] = [];
  const prepareDisplay = vi.fn(async (basis: TimelineCommandBasis, draft?: OutboxJson) => {
    const document = structuredClone(draft ?? basis.canonicalDocument.parent_revision.payload) as OutboxJson;
    return { document, adopt() { visible = document; adopted.push(document); } };
  });
  const mount = () => createLocalSaveSession({ scope, initial, document: original, outboxes,
    send, loadLatest, prepareDisplay, changed: (state) => states.push(state) });
  const mountCanonical = () => createLocalSaveSession({ scope, initial, document: toOutboxJson(initial.canonicalDocument), outboxes,
    send, loadLatest, prepareDisplay, changed: (state) => states.push(state) });
  const append = async (session: LocalSaveSession, save: LocalSave) => {
    visible = structuredClone(save.after);
    await session.append(save);
  };
  return { outboxes, initial, send, loadLatest, states, prepareDisplay, mount, mountCanonical, append, adopted, visible: () => visible };
}

describe('local editor saves through the durable outbox', () => {
  it('retains encoded physical-root guards, step identity and dependent created IDs through recovery without inventing a request', async () => {
    const env = environment();
    const first = await env.mountCanonical();
    const before = structuredClone(env.initial.canonicalDocument);
    const after = structuredClone(before);
    after.parent_revision.payload = split;
    const final = structuredClone(after);
    final.parent_revision.payload = trimmed;
    const roots = [{ ref: 'parent' as const, revisionId: 'r0', contentDigest: before.parent_revision.content_digest }];
    const step = { id: 'split-step', label: 'Split', intent: 'Split local clip', tags: ['editing'] };
    const a = first.appendDocument({ before, after, roots, label: 'Split', step });
    const b = first.appendDocument({ before: after, after: final, roots, label: 'Trim', step: { ...step, id: 'trim-step' } });
    await Promise.all([a, b]);
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents[0].payload).toMatchObject({ documentIntent: { basis: { head: h0 },
      roots, created: ['parent/clip:right'], step, changes: expect.arrayContaining([
        expect.objectContaining({ op: 'list.insert', id: 'right', before: { state: 'absent' } }),
      ]) } });
    expect(stored.intents[1].payload).toMatchObject({ documentIntent: { basis: { after: stored.intents[0].id },
      before: after, after: final, changes: expect.arrayContaining([
        { op: 'set', ref: 'parent', path: ['clips', 'id:right', 'to'], before: { state: 'present', value: 4 }, value: 3 },
      ]) } });
    await expect(first.flush()).rejects.toThrow('draft retained');
    expect(env.send).not.toHaveBeenCalled();
    await first.dispose();
    const recovered = await env.mountCanonical();
    await recovered.recover(stored.ownerId);
    expect(recovered.getDocument()).toEqual(final);
    expect((await env.outboxes.list(scope))[0].intents).toEqual(stored.intents);
    expect((await env.outboxes.list(scope))[0].pending).toBeUndefined();
    await recovered.dispose();
  });

  it('validates document mappings before advancing the local chain and ignores exact no-ops', async () => {
    const env = environment();
    const session = await env.mountCanonical();
    const before = env.initial.canonicalDocument;
    const after = structuredClone(before);
    after.parent_revision.payload = split;
    const input = { before, after, roots: [], label: 'Split', step: { id: 's', label: 'Split', intent: '', tags: [] } };
    expect(() => session.appendDocument(input)).toThrow('explicit physical binding');
    expect(session.getDocument()).toEqual(before);
    await session.appendDocument({ ...input, after: before });
    expect((await env.outboxes.list(scope))[0].intents).toHaveLength(0);
    expect(session.getState().status).toBe('saved');
    await session.dispose();
  });

  it('persists split → trim before submit and preserves IDs, before-values and reads at the landed pair', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    await env.append(session, trimSave());
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(2);
    expect(stored.intents[1].basis).toEqual({ after: stored.intents[0].id });
    expect(stored.intents[1].readyBase).toBeUndefined();
    expect(stored.intents[0].payload).toMatchObject({ before: original, after: split, commands: splitCommands });
    expect(env.send).not.toHaveBeenCalled();
    const ack = deferred<TimelineCommitResult>();
    env.send.mockImplementationOnce(async () => ack.promise).mockImplementationOnce(async (request) => {
      expect(request.base_revision_id).toBe('r1');
      expect(request.base_publication_id).toBe('p1');
      expect(request.commands).toEqual(trimCommands);
      const [durable] = await env.outboxes.list(scope);
      expect(durable.accepted?.value).toMatchObject({ canonicalDocument: result(split).canonicalDocument });
      expect(durable.intents[0].payload).toEqual(stored.intents[1].payload);
      return result(trimmed, h2, h1);
    });
    const flushing = session.flush();
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
    expect(env.visible()).toEqual(trimmed);
    expect(env.send.mock.calls[0][0].commands).toEqual(splitCommands);
    ack.resolve(result(split));
    await expect(flushing).resolves.toMatchObject({ head: h2 });
    expect(env.send).toHaveBeenCalledTimes(2);
    expect(env.send.mock.calls[0][1]).not.toBe(env.send.mock.calls[1][1]);
    expect(env.adopted).toEqual([split, trimmed]);
    await session.dispose();
  });

  it('retains an unsupported free edit without emitting an invented v2 request or using a snapshot route', async () => {
    const env = environment();
    const session = await env.mount();
    const save = splitSave();
    delete save.commands;
    await env.append(session, save);
    await env.append(session, trimSave());
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(env.send).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ status: 'blocked', error: { code: 'commit_contract_unavailable' } });
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(2);
    expect(stored.pending).toBeUndefined();
    await session.dispose();
  });

  it('gates doc.patch even though the historical EditCommand op type is an open string', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, { ...splitSave(), commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, args: { changes: [] } }] });
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(env.send).not.toHaveBeenCalled();
    expect(session.getState().status).toBe('blocked');
    await session.dispose();
  });

  it('applies the Runtime canonical disjoint edit before replaying the original local suffix', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    await env.append(session, trimSave());
    const mergedSplit = { ...split, meta: { opaque: null, agent: 'preserved' } };
    const mergedTrim = { ...trimmed, meta: mergedSplit.meta };
    env.send.mockResolvedValueOnce(result(mergedSplit, h1, h0, true)).mockImplementationOnce(async (request) => {
      expect(env.visible()).toEqual(mergedSplit);
      expect(session.getDocument()).toEqual(mergedSplit);
      expect(request).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1', commands: trimCommands });
      return result(mergedTrim, h2, h1);
    });
    await session.flush();
    expect(env.visible()).toEqual(mergedTrim);
    const next = { ...mergedTrim, meta: { ...mergedTrim.meta, note: null } };
    await session.append({ before: mergedTrim, after: next, label: 'Note' });
    expect((await env.outboxes.list(scope))[0].intents[0].payload).toMatchObject({ before: mergedTrim, after: next });
    await session.dispose();
  });

  it('retries the entire exact request/key after a lost split acknowledgement and restart', async () => {
    const env = environment();
    const first = await env.mount();
    await env.append(first, splitSave());
    await env.append(first, trimSave());
    env.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    await expect(first.flush()).rejects.toThrow('unacknowledged');
    const exact = structuredClone(env.send.mock.calls[0]);
    const [stored] = await env.outboxes.list(scope);
    const originalSuffix = structuredClone(stored.intents[1]);
    await first.dispose();
    const recovered = await env.mount();
    expect(recovered.getState()).toMatchObject({ status: 'recovery', recoverableOwners: [stored.ownerId] });
    await expect(recovered.recover('unknown')).rejects.toThrow('explicitly listed');
    env.send.mockImplementationOnce(async (request, key) => {
      expect([request, key]).toEqual(exact);
      expect(env.visible()).toEqual(trimmed);
      return result(split);
    }).mockImplementationOnce(async (request) => {
      expect(request.commands).toEqual(trimCommands);
      expect(request.base_publication_id).toBe('p1');
      const [durable] = await env.outboxes.list(scope);
      expect(durable.intents[0].id).toBe(originalSuffix.id);
      expect(durable.intents[0].payload).toEqual(originalSuffix.payload);
      return result(trimmed, h2, h1);
    });
    await recovered.recover(stored.ownerId);
    expect(recovered.getState().status).toBe('saved');
    expect(env.visible()).toEqual(trimmed);
    await recovered.dispose();
  });

  it('recovers an acknowledged split before retrying the exact uncertain trim without repinning its guards', async () => {
    const env = environment();
    const first = await env.mount();
    await env.append(first, splitSave());
    await env.append(first, trimSave());
    const mergedSplit = { ...split, agent: ['unchanged', null] };
    env.send.mockResolvedValueOnce(result(mergedSplit, h1, h0, true)).mockRejectedValueOnce(new Error('Lost trim acknowledgement'));
    await expect(first.flush()).rejects.toThrow('unacknowledged');
    const [stored] = await env.outboxes.list(scope);
    expect(stored.accepted?.head).toEqual(h1);
    expect(stored.intents).toHaveLength(1);
    const exactTrim = structuredClone(env.send.mock.calls[1]);
    await first.dispose();
    const recovered = await env.mount();
    env.send.mockImplementationOnce(async (request, key) => {
      expect([request, key]).toEqual(exactTrim);
      expect(request.commands).toEqual(trimCommands);
      expect(env.prepareDisplay.mock.lastCall?.[0].head).toEqual(h1);
      expect(env.visible()).toEqual(mergedSplit);
      return result({ ...trimmed, agent: mergedSplit.agent }, h2, h1);
    });
    await recovered.recover(stored.ownerId);
    expect(env.visible()).toEqual({ ...trimmed, agent: mergedSplit.agent });
    expect(env.send).toHaveBeenCalledTimes(3);
    await recovered.dispose();
  });

  it('does not release the trim until the split reply includes a matching canonical landed document', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    await env.append(session, trimSave());
    const wrongDocument = result(split);
    wrongDocument.canonicalDocument.parent_revision.revision_id = 'unrelated-revision';
    env.send.mockResolvedValueOnce(wrongDocument);
    await expect(session.flush()).rejects.toThrow('unacknowledged');
    expect(env.send).toHaveBeenCalledTimes(1);
    const [stored] = await env.outboxes.list(scope);
    expect(stored.accepted).toBeUndefined();
    expect(stored.intents[1].readyBase).toBeUndefined();
    expect(stored.pending?.request.key).toBe(env.send.mock.calls[0][1]);
    env.send.mockResolvedValueOnce(result(split)).mockResolvedValueOnce(result(trimmed, h2, h1));
    await session.flush();
    expect(env.send.mock.calls[1]).toEqual(env.send.mock.calls[0]);
    expect(env.send.mock.calls[2][0].commands).toEqual(trimCommands);
    await session.dispose();
  });

  it('retains validation code/path/hint and preserves drafts when canonical rollback cannot load', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    await env.append(session, trimSave());
    const details = { code: 'invalid_timing', path: ['clips', 'id:left', 'hold'], hint: 'Use a positive duration' };
    env.send.mockRejectedValueOnce(new ApiError(422, 'invalid_timing', 'Invalid duration', '', details));
    env.loadLatest.mockRejectedValueOnce(new Error('Offline'));
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(session.getState()).toMatchObject({ status: 'error', error: {
      message: 'Draft retained; reload failed: Offline', failure: { code: 'invalid_timing', details },
    } });
    expect(env.visible()).toEqual(trimmed);
    expect((await env.outboxes.list(scope))[0].intents).toHaveLength(2);
    await session.dispose();
  });

  it('rolls back a failed predecessor visibly, retaining the complete split → trim chain and error details across restart', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    await env.append(session, trimSave());
    const details = { status: 'conflict', reason: 'dependency_changed', path: ['clips', 'id:left', 'to'], hint: 'Read current head' };
    env.send.mockRejectedValueOnce(new ApiError(409, 'dependency_changed', 'Split conflicts with another edit', '', details));
    const remote = result({ ...original, agent: true }, { revisionId: 'agent-r', publicationId: 'agent-p' });
    env.loadLatest.mockResolvedValue({ head: remote.accepted, canonicalDocument: remote.canonicalDocument });
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ status: 'conflict', error: { code: 'dependency_changed', details } });
    expect(env.visible()).toEqual({ ...original, agent: true });
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents.map((intent) => intent.payload)).toEqual([
      expect.objectContaining({ before: original, after: split, commands: splitCommands }),
      expect.objectContaining({ before: split, after: trimmed, commands: trimCommands }),
    ]);
    expect(stored.intents[1].conflict).toEqual(stored.intents[0].conflict);
    expect(() => session.append(trimSave())).toThrow('retained local saves');
    await session.dispose();
    const recovered = await env.mount();
    await recovered.recover(stored.ownerId);
    expect(recovered.getState().status).toBe('conflict');
    expect(env.send).toHaveBeenCalledTimes(1);
    expect((await env.outboxes.list(scope))[0].intents).toEqual(stored.intents);
    await recovered.dispose();
  });

  it('does not let an asynchronous canonical build overwrite a later local edit', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    env.send.mockResolvedValueOnce(result(split)).mockImplementationOnce(async (request) => {
      expect(env.visible()).toEqual(split);
      expect(request).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1', commands: trimCommands });
      return result(trimmed, h2, h1);
    });
    const building = deferred<void>();
    const ready = deferred<void>();
    const prepare = env.prepareDisplay.getMockImplementation()!;
    env.prepareDisplay.mockImplementationOnce(async (basis, draft) => {
      ready.resolve();
      await building.promise;
      return prepare(basis, draft);
    });
    const flush = session.flush();
    await ready.promise;
    await env.append(session, trimSave());
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents[0].payload).toMatchObject({ before: split, after: trimmed, commands: trimCommands });
    building.resolve();
    await expect(flush).rejects.toThrow('unacknowledged');
    expect(env.visible()).toEqual(trimmed);
    expect(env.adopted).toEqual([]);
    await session.flush();
    expect(env.visible()).toEqual(trimmed);
    await session.dispose();
  });

  it('surfaces a canonical projection failure and retries adoption without resubmitting an accepted edit', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    env.send.mockResolvedValueOnce(result(split));
    env.prepareDisplay.mockRejectedValueOnce(new Error('Canonical projection failed'));
    await expect(session.flush()).rejects.toThrow('Canonical projection failed');
    expect(session.getState()).toMatchObject({ status: 'error', error: { message: 'Canonical projection failed' } });
    expect((await env.outboxes.list(scope))[0].accepted?.head).toEqual(h1);
    await session.flush();
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(env.visible()).toEqual(split);
    expect(session.getState().status).toBe('saved');
    await session.dispose();
  });

  it('holds the original suffix through a failed canonical projection before dispatching it', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    await env.append(session, trimSave());
    const [originalRecord] = await env.outboxes.list(scope);
    const mergedSplit = { ...split, agent: true };
    env.send.mockResolvedValueOnce(result(mergedSplit)).mockImplementationOnce(async (request) => {
      expect(env.visible()).toEqual(mergedSplit);
      expect(request.commands).toEqual(trimCommands);
      return result({ ...trimmed, agent: true }, h2, h1);
    });
    env.prepareDisplay.mockRejectedValueOnce(new Error('Canonical projection failed'));
    await expect(session.flush()).rejects.toThrow('Canonical projection failed');
    expect(env.send).toHaveBeenCalledTimes(1);
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents[0].payload).toEqual(originalRecord.intents[1].payload);
    expect(stored.pending).toBeUndefined();
    await session.flush();
    expect(env.send).toHaveBeenCalledTimes(2);
    expect(env.visible()).toEqual({ ...trimmed, agent: true });
    await session.dispose();
  });

  it.each([409, 422])('retains a suffix refused at the canonical base (%s) across restart', async (status) => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    await env.append(session, trimSave());
    const [originalRecord] = await env.outboxes.list(scope);
    const canonical = result({ ...split, clips: [split.clips[0]], agent: true });
    env.loadLatest.mockResolvedValue({ head: h1, canonicalDocument: canonical.canonicalDocument });
    const details = { status: status === 409 ? 'conflict' : 'invalid',
      path: ['clips', 'id:right'], hint: 'Read the current canonical head' };
    env.send.mockResolvedValueOnce(canonical).mockImplementationOnce(async (request) => {
      expect(env.visible()).toEqual(canonical.canonicalDocument.parent_revision.payload);
      expect(request).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1', commands: trimCommands });
      throw new ApiError(status, 'binding_changed', 'Original dependent clip no longer exists', '', details);
    });
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(session.getState()).toMatchObject({ status: status === 409 ? 'conflict' : 'error', error: { code: 'binding_changed', details } });
    expect(env.visible()).toEqual(canonical.canonicalDocument.parent_revision.payload);
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(1);
    expect(stored.intents[0].payload).toEqual(originalRecord.intents[1].payload);
    const exact = stored.pending?.request;
    await session.dispose();
    const recovered = await env.mount();
    await recovered.recover(stored.ownerId);
    expect(recovered.getState().status).toBe(status === 409 ? 'conflict' : 'error');
    expect(env.send).toHaveBeenCalledTimes(2);
    expect((await env.outboxes.list(scope))[0].pending?.request).toEqual(exact);
    await recovered.dispose();
  });

  it('fences a canonical projection on unmount and adopts the durable prefix before recovered suffix dispatch', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session, splitSave());
    await env.append(session, trimSave());
    const mergedSplit = { ...split, agent: true };
    env.send.mockResolvedValueOnce(result(mergedSplit));
    const building = deferred<void>();
    const ready = deferred<void>();
    const prepare = env.prepareDisplay.getMockImplementation()!;
    env.prepareDisplay.mockImplementationOnce(async (basis, draft) => {
      ready.resolve();
      await building.promise;
      return prepare(basis, draft);
    });
    const flushing = session.flush();
    await ready.promise;
    await session.dispose();
    const [stored] = await env.outboxes.list(scope);
    const recovered = await env.mount();
    env.send.mockImplementationOnce(async (request) => {
      expect(env.visible()).toEqual(mergedSplit);
      expect(request.commands).toEqual(trimCommands);
      expect(() => recovered.append({ before: mergedSplit, after: { ...mergedSplit, note: true }, label: 'Note' }))
        .toThrow('dependent saves');
      return result({ ...trimmed, agent: true }, h2, h1);
    });
    await recovered.recover(stored.ownerId);
    const visible = env.visible();
    const adoptions = structuredClone(env.adopted);
    building.resolve();
    await expect(flushing).rejects.toThrow('unacknowledged');
    expect(env.visible()).toEqual(visible);
    expect(env.adopted).toEqual(adoptions);
    expect(env.send).toHaveBeenCalledTimes(2);
    await recovered.dispose();
  });

  it('drains a local append on disposal and fences a late acknowledgement after the owner is reclaimed', async () => {
    const env = environment();
    const session = await env.mount();
    const writing = session.append(splitSave());
    await session.dispose();
    await writing;
    expect(env.send).not.toHaveBeenCalled();
    const [stored] = await env.outboxes.list(scope);
    const recovered = await env.mount();
    const late = deferred<TimelineCommitResult>();
    env.send.mockImplementationOnce(async () => late.promise);
    const recovering = recovered.recover(stored.ownerId);
    await vi.waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
    await recovered.dispose();
    const next = await env.mount();
    env.send.mockResolvedValueOnce(result(split));
    await next.recover(stored.ownerId);
    const after = await env.outboxes.list(scope);
    const fenced = expect(recovering).rejects.toThrow('Stale');
    late.resolve(result(split));
    await fenced;
    expect(await env.outboxes.list(scope)).toEqual(after);
    await next.dispose();
  });

  it('compares exact local bytes without defaulting absent to null or reordering arrays', async () => {
    const env = environment();
    const session = await env.mount();
    expect(() => session.append({ ...splitSave(), before: { ...original, absent: null } })).toThrow('authored local document');
    expect(() => session.append({ ...splitSave(), before: { ...original, clips: [{ ...original.clips[0], opaque: [false, null] }] } })).toThrow('authored local document');
    await session.append({ ...splitSave(), before: { meta: original.meta, clips: original.clips } });
    expect((await env.outboxes.list(scope))[0].intents[0].payload).toMatchObject({ after: split });
    await session.dispose();
  });
});
