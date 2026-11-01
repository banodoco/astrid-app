import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceClient, type Transport } from '@/integrations/runtime/generated.ts';
import { supportsFullV2Commit } from '@/integrations/runtime/contract-metadata.ts';
import { environment, h0, scope } from './__tests__/localSaveSessionEnvironment.ts';

const fixture = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));
vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>();
  return { ...actual,
    get SCHEMA_DIGEST() { return fixture.overrides.SCHEMA_DIGEST ?? actual.SCHEMA_DIGEST; },
    get PROTOCOL() { return fixture.overrides.PROTOCOL ?? actual.PROTOCOL; },
    get CONTRACT_VERSION() { return fixture.overrides.CONTRACT_VERSION ?? actual.CONTRACT_VERSION; },
    get COMPONENT_MANIFEST_SHA256() { return fixture.overrides.COMPONENT_MANIFEST_SHA256 ?? actual.COMPONENT_MANIFEST_SHA256; },
    get OPERATIONS() { return fixture.overrides.OPERATIONS ?? actual.OPERATIONS; },
  };
});
afterEach(() => { fixture.overrides = {}; });

describe('qualified full-v2 generated contracts at the local save boundary', () => {
  it.each([
    ['actual D39', {}],
    ['original full-v2', { SCHEMA_DIGEST: 'sha256:35c2d9c5e0b51ab8d8b7a4f4dbafbdfcb13d232d7bd22fff21cf73e250398d4c' }],
  ])('sends document and semantic saves with complete v2 metadata using %s', async (_name, overrides) => {
    fixture.overrides = overrides;
    expect(supportsFullV2Commit()).toBe(true);
    for (const semantic of [false, true]) {
      const env = environment();
      const session = await env.mount();
      const sent: Parameters<Transport>[] = [];
      const accepted = env.accepted(env.pair.after, { revisionId: 'r1', publicationId: 'p1' });
      const client = new WorkspaceClient('http://runtime.test', 'token', async (...args) => {
        sent.push(args);
        return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(accepted.response)) };
      });
      env.send.mockImplementation(async (request, key) => {
        await client.commitTimeline(scope.projectId, scope.timelineId, request, key);
        return accepted;
      });
      const reads = [{ kind: 'field' as const, ref: 'parent', path: ['tracks', 'id:V1', 'label'],
        state: { state: 'present' as const, value: 'V1' } }];
      const steps = [{ id: 'semantic-step', label: 'Native label', intent: 'Rename track', tags: ['editing'],
        command_ordinals: [0] as [number], patch: [], reads }];
      if (semantic) {
        await session.append({ before: env.pair.document, after: env.pair.after, label: 'Native label', steps, reads,
          rationale: 'Clarify track', group_id: 'track-group', commands: [{ schema_version: 1,
            op: 'track.set', version: '1', select: 'parent/track:V1', created: [], args: { values: { label: 'Native label' }, clear: [] } }] });
      } else await env.append(session);
      await session.flush();
      expect(sent).toHaveLength(1);
      const [method, path, headers, bytes] = sent[0];
      const request = env.send.mock.calls[0][0];
      expect([method, path]).toEqual(['POST', `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`]);
      expect(headers['Idempotency-Key']).toBe(env.send.mock.calls[0][1]);
      expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(JSON.stringify(request));
      expect(request).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
        base_revision_id: h0.revisionId, base_publication_id: h0.publicationId, label: 'Native label',
        source: { via: 'app' }, dry_run: false, merge: semantic ? 'fields' : 'atomic',
        steps: [{ id: semantic ? 'semantic-step' : 'track-label-step', command_ordinals: [0] }] });
      if (semantic) expect(request).toMatchObject({ steps, reads, rationale: 'Clarify track', group_id: 'track-group' });
      else {
        expect(request.commands[0]).toMatchObject({ op: 'doc.patch', version: '1', select: null, created: [] });
        expect(request.steps![0].patch).toEqual(request.commands[0].args.changes);
        expect(request).not.toHaveProperty('reads');
      }
      expect(session.getState().status).toBe('saved');
      await session.dispose();
    }
  });

  it.each([
    ['unknown schema', { SCHEMA_DIGEST: 'sha256:unsupported-test-fixture' }],
    ['legacy schema', { SCHEMA_DIGEST: 'sha256:53bc985a9ab3dba290c3d2a99c7837460f43c9bb0f0ef486d273eec3e2e44ed0' }],
    ['wrong protocol', { PROTOCOL: 'workspace.v0' }],
    ['wrong version', { CONTRACT_VERSION: '0.2.13' }],
    ['wrong components', { COMPONENT_MANIFEST_SHA256: 'sha256:unsupported-test-fixture' }],
    ['missing commit', { OPERATIONS: ['listTimelineCommits'] }],
    ['missing history', { OPERATIONS: ['commitTimeline'] }],
  ])('retains a document save before POST with %s metadata', async (_name, overrides) => {
    fixture.overrides = overrides;
    expect(supportsFullV2Commit()).toBe(false);
    const env = environment();
    const session = await env.mount();
    await env.append(session);
    await expect(session.flush()).rejects.toThrow('draft retained');
    expect(env.send).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ status: 'blocked', error: { code: 'commit_contract_unavailable' } });
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(1);
    expect(stored.pending).toBeUndefined();
    await session.dispose();
  });
});
