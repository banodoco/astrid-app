import { describe, expect, it } from 'vitest';
import { ApiError } from '@/integrations/runtime/generated.ts';
import type { CanonicalDocument } from '@/integrations/runtime/generated.ts';
import { environment, h0 } from './__tests__/localSaveSessionEnvironment.ts';

// A second, independent edit on top of the canonical head (label only).
function laterDocument(base: CanonicalDocument, label: string): CanonicalDocument {
  const next = structuredClone(base);
  const payload = next.parent_revision.payload as { config: { tracks: Array<{ label: string }> }; tracks: Array<{ label: string }> };
  payload.config.tracks[0].label = label;
  payload.tracks[0].label = label;
  return next;
}

describe('local save permanent rejections', () => {
  it('retains a 413 change, explains the refusal, and permits a next save only after explicit discard', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session);
    env.send.mockRejectedValueOnce(new ApiError(413, 'http_error', 'HTTP 413'));
    const later = laterDocument(env.pair.document, 'Later');
    env.send.mockImplementation(async () => env.accepted(later, { revisionId: 'r1', publicationId: 'p1' }));

    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ status: 'error',
      error: { kind: 'too_large', message: expect.stringContaining('This change is too large to save.') } });
    expect(session.getDocument()).toEqual(JSON.parse(JSON.stringify(env.pair.after)));
    expect((await env.outboxes.list({ realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-commit' }))[0].intents).toHaveLength(1);
    // The creator must choose to discard before a different change can save.
    await session.discharge('latest');
    expect(session.getDocument()).toEqual(JSON.parse(JSON.stringify(env.pair.document)));

    await session.appendDocument({ before: env.pair.document, after: later, label: 'Later',
      roots: [{ ref: 'parent', revisionId: h0.revisionId, contentDigest: env.pair.document.parent_revision.content_digest }],
      step: { id: 'later-step', label: 'Later', intent: 'Update later label', tags: [] } } as Parameters<typeof session.appendDocument>[0]);
    await expect(session.flush()).resolves.toMatchObject({ head: { revisionId: 'r1' } });
    expect(env.send).toHaveBeenCalledTimes(2);
    expect(session.getState().notice).toBeUndefined();
    expect(session.getState().status).toBe('saved');
  });

  it('reports the limit when the 413 body carries one', async () => {
    const env = environment();
    const session = await env.mount();
    await env.append(session);
    env.send.mockRejectedValueOnce(new ApiError(413, 'http_error', 'HTTP 413', '', { max_bytes: 1024 }));
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(session.getState().error).toMatchObject({ kind: 'too_large',
      message: expect.stringContaining('The limit is 1024 bytes.') });
  });

  it.each([404, 405])('keeps a %s retained and blocked with the unsupported-version reason', async (status) => {
    const env = environment();
    const session = await env.mount();
    await env.append(session);
    env.send.mockRejectedValueOnce(new ApiError(status, 'http_error', `HTTP ${status}`));
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ status: 'error',
      error: { kind: 'unsupported_route', message: expect.stringContaining('does not support this save') } });
  });

  it.each([
    ['429', new ApiError(429, 'http_error', 'HTTP 429')],
    ['408', new ApiError(408, 'http_error', 'HTTP 408')],
    ['503', new ApiError(503, 'http_error', 'HTTP 503')],
    ['network', new TypeError('Failed to fetch')],
  ])('keeps %s retryable', async (_label, failure) => {
    const env = environment();
    const session = await env.mount();
    await env.append(session);
    env.send.mockRejectedValueOnce(failure);
    await expect(session.flush()).rejects.toThrow('remain unacknowledged');
    expect(session.getState().status).toBe('retry');
    expect(env.send).toHaveBeenCalledTimes(1);
  });
});
