import { describe, expect, it, vi } from 'vitest';
import { createLocalSaveSession } from './localSaveSession.ts';
import { toOutboxJson } from './commitOutbox.ts';
import { ApiError, type CanonicalDocument } from '@/integrations/runtime/generated.ts';
import { environment, h0, scope } from './__tests__/localSaveSessionEnvironment.ts';

function editOnTop(base: CanonicalDocument): CanonicalDocument {
  const after = structuredClone(base);
  const payload = after.parent_revision.payload as {
    config: { tracks: Array<{ label: string }> };
    tracks: Array<{ label: string }>;
  };
  payload.config.tracks[0].label = 'Second unsaved change';
  payload.tracks[0].label = 'Second unsaved change';
  return after;
}

describe('FIX-16 rejected save safety: original IDs and durable suffix', () => {
  it.each([
    [413, 'too_large'],
    [422, 'validation'],
    [400, 'validation'],
    [404, 'unsupported_route'],
    [405, 'unsupported_route'],
  ] as const)('FIX16-PERM-%s retains the exact original and dependent change on rejection and restart', async (status, kind) => {
    const env = environment();
    const session = await env.mount();
    await env.append(session);
    const after = editOnTop(env.pair.after);
    await session.appendDocument({
      before: env.pair.after, after, label: 'Edit after rejected change',
      roots: [{ ref: 'parent', revisionId: h0.revisionId,
        contentDigest: env.pair.document.parent_revision.content_digest }],
      step: { id: 'followup-step', label: 'Edit on top', intent: 'Preserve all edits', tags: [] },
    });

    env.send.mockRejectedValueOnce(new ApiError(status, 'http_error', `HTTP ${status}`));
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ status: 'error', error: { kind } });
    expect(session.getDocument()).toEqual(JSON.parse(JSON.stringify(after)));
    expect(env.visible()).toEqual(JSON.parse(JSON.stringify(after)));
    const [durable] = await env.outboxes.list(scope);
    expect(durable.intents).toHaveLength(2);
    expect(durable.intents[0].payload).toMatchObject({ after: env.pair.after });
    expect(durable.intents[1].payload).toMatchObject({ after });
    const rejectedRequest = durable.pending?.request;
    expect(rejectedRequest).toBeDefined();

    await session.dispose();
    const reopened = await env.mount();
    expect(reopened.getState().recoverableOwners).toContain(durable.ownerId);
    await reopened.recover(durable.ownerId);
    expect(reopened.getState()).toMatchObject({ status: 'error', error: { kind } });
    expect(reopened.getDocument()).toEqual(JSON.parse(JSON.stringify(after)));
    expect(env.visible()).toEqual(JSON.parse(JSON.stringify(after)));
    expect(env.send).toHaveBeenCalledTimes(1);
    expect((await env.outboxes.list(scope))[0].pending?.request).toEqual(rejectedRequest);
    await reopened.dispose();
  });

  it.each([413, 422, 404, 405])('FIX16-COPY-%s exports exact rejected request and dependent edits without consuming them', async (status) => {
    const env = environment();
    const session = await env.mount();
    await env.append(session);
    const after = editOnTop(env.pair.after);
    await session.appendDocument({
      before: env.pair.after, after, label: 'Edit after rejected change',
      roots: [{ ref: 'parent', revisionId: h0.revisionId,
        contentDigest: env.pair.document.parent_revision.content_digest }],
      step: { id: 'followup-step', label: 'Edit on top', intent: 'Preserve all edits', tags: [] },
    });
    env.send.mockRejectedValueOnce(new ApiError(status, 'http_error', `HTTP ${status}`));
    await expect(session.flush()).rejects.toThrow('draft retained');
    const [before] = await env.outboxes.list(scope);
    const copied = await session.exportRejectedChange() as unknown as {
      format: string;
      rejected_request: { method: string; path: string; key: string; body: string };
      edits: Array<{ id: string; payload: unknown }>;
      final_document: unknown;
    };
    expect(copied.format).toBe('astrid.rejected-local-save/v1');
    expect(copied.rejected_request).toEqual(before.pending?.request);
    expect(copied.edits.map((intent) => intent.id)).toEqual(before.intents.map((intent) => intent.id));
    expect(copied.edits.map((intent) => intent.payload)).toEqual(before.intents.map((intent) => intent.payload));
    expect(copied.final_document).toEqual(JSON.parse(JSON.stringify(after)));
    expect((await env.outboxes.list(scope))[0]).toEqual(before);
    expect(env.send).toHaveBeenCalledTimes(1);
    await session.discharge('latest'); // Only the explicit creator choice discards.
    expect((await env.outboxes.list(scope))[0].intents).toEqual([]);
    expect(session.getDocument()).toEqual(JSON.parse(JSON.stringify(env.pair.document)));
    expect(env.send).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('FIX16-OFFLINE keeps every rejected edit when explicit discard cannot load canonical', async () => {
    const env = environment();
    const loadLatest = vi.fn().mockRejectedValueOnce(new Error('Runtime offline')).mockResolvedValue(env.initial);
    const session = await createLocalSaveSession({
      scope, initial: env.initial, document: toOutboxJson(env.pair.document),
      outboxes: env.outboxes, send: env.send, loadLatest, prepareDisplay: env.prepareDisplay,
      changed: () => {},
    });
    await env.append(session);
    env.send.mockRejectedValueOnce(new ApiError(413, 'http_error', 'HTTP 413'));
    await expect(session.flush()).rejects.toThrow('draft retained');
    const [before] = await env.outboxes.list(scope);
    await expect(session.discharge('latest')).rejects.toThrow('Runtime offline');
    expect((await env.outboxes.list(scope))[0]).toEqual(before);
    expect(session.getDocument()).toEqual(JSON.parse(JSON.stringify(env.pair.after)));
    expect(session.getState().status).toBe('error');
    await session.discharge('latest');
    expect((await env.outboxes.list(scope))[0].intents).toEqual([]);
    await session.dispose();
  });

  it('FIX16-CHOICE never discards a rejected save merely by flushing again', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session);
    env.send.mockRejectedValue(new ApiError(413, 'http_error', 'HTTP 413'));
    await expect(session.flush()).rejects.toThrow('draft retained');
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(env.send).toHaveBeenCalledTimes(1);
    const [retained] = await env.outboxes.list(scope);
    expect(retained.intents).toHaveLength(1);
    expect(session.getState().status).toBe('error');
    await session.dispose();
  });
});
