import { describe, expect, it } from 'vitest';
import { SCHEMA_DIGEST } from '@/integrations/runtime/generated-contract-metadata.ts';
import type { TimelineData } from '../lib/timeline-data.ts';
import { environment, h0, scope } from './__tests__/localSaveSessionEnvironment.ts';

// The current generated contract is the only path this migration is intended to exercise.
expect(SCHEMA_DIGEST).toBe('sha256:4118b1e26d30be43cb1a01649df0065fed6e55a528b8956364df8f4eedb413d2');

describe('local save session', () => {
  it('persists one doc.patch and retries the exact request after restart', async () => {
    const env = environment();
    const first = await env.mount();
    await env.append(first);
    env.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));

    await expect(first.flush()).rejects.toThrow('draft retained');
    const [stored] = await env.outboxes.list(scope);
    const exact = stored.pending!.request;
    const request = JSON.parse(exact.body);
    expect(request).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
      base_revision_id: h0.revisionId, base_publication_id: h0.publicationId, label: 'Native label',
      dry_run: false, merge: 'atomic', source: { via: 'app' }, steps: [{ id: 'track-label-step',
        label: 'Native label', intent: 'Update native label', tags: [], command_ordinals: [0] }] });
    expect(request.commands).toHaveLength(1);
    expect(request.commands[0]).toMatchObject({ schema_version: 1, op: 'doc.patch', version: '1', select: null,
      created: [], args: { changes: [{ op: 'set', ref: 'parent', path: ['tracks', 'id:V1', 'label'],
        before: { state: 'present', value: 'V1' }, value: 'Native label' }] } });
    expect(request.steps[0].patch).toEqual(request.commands[0].args.changes);
    await first.dispose();

    const second = await env.mount();
    env.send.mockResolvedValueOnce(env.accepted(env.pair.after, { revisionId: 'r1', publicationId: 'p1' }));
    await second.recover(stored.ownerId);

    expect(env.send).toHaveBeenCalledTimes(2);
    expect(env.send.mock.calls[1][0]).toEqual(request);
    expect(env.send.mock.calls[1][1]).toBe(exact.key);
    expect(JSON.stringify(env.send.mock.calls[1][0])).toBe(exact.body);
    expect(env.send.mock.calls[0][0].commands).toEqual(env.send.mock.calls[1][0].commands);
    expect(env.send.mock.calls[0][1]).toBe(env.send.mock.calls[1][1]);
    expect((env.visible() as { parent_revision: { payload: unknown } }).parent_revision.payload)
      .toEqual(env.pair.after.parent_revision.payload);
    await second.flush();
    await second.dispose();
  });

  it.each([
    ['matching accepted projection', { kind: 'accepted', head: { revisionId: 'r0', publicationId: 'p0' } }, true],
    ['matching local projection base', { kind: 'local', base: { revisionId: 'r0', publicationId: 'p0' }, generation: 1 }, true],
    ['stale accepted projection', { kind: 'accepted', head: { revisionId: 'r0', publicationId: 'stale' } }, false],
    ['no projection fact', undefined, false],
  ] as const)('requires a matching source fact when publication is null (%s)', async (_name, projection, allowed) => {
    const env = environment();
    const session = await env.mount();
    const displayed: Pick<TimelineData, 'head' | 'editProjection'> = {
      head: { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: null },
      editProjection: projection as TimelineData['editProjection'],
    };
    expect(displayed.head.headPublicationId).toBeNull();

    if (allowed) {
      await expect(env.sourceGuard(session, displayed)).resolves.toBeUndefined();
    } else {
      await expect(env.sourceGuard(session, displayed))
        .rejects.toThrow('original verified authoring head is unavailable');
    }
    expect((await env.outboxes.list(scope))[0].intents).toHaveLength(0);
    await session.dispose();
  });
});
