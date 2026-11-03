import { describe, expect, it } from 'vitest';
import { AstridRuntimeClient, RUNTIME_CLIENT_SCOPES } from './client.ts';
import { RuntimeDataProvider } from './dataProvider.ts';
import type { CommitRequest, Transport } from './generated.ts';
import { RUNTIME_SCHEMA_DIGEST, RUNTIME_TARGETED_EXECUTION_CAPABILITY } from './contract-metadata.ts';
import { PROJECT_ID, TIMELINE_ID, json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { acceptedCommit } from './__tests__/timelineCommitFixture.ts';

async function waitForRenewalReplies(
  replies: Map<number, (value: Awaited<ReturnType<Transport>>) => void>,
  sequences: number[],
) {
  for (let attempt = 0; attempt < 100 && sequences.some(sequence => !replies.has(sequence)); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  expect(sequences.every(sequence => replies.has(sequence))).toBe(true);
}

describe('Runtime timeline editing lease client', () => {
  it('accepts a same-sequence retry after a lost initial PUT acknowledgement', async () => {
    const fixture = runtimeFixture();
    const requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }> = [];
    let firstPut = true;
    const wireBody: CommitRequest = {
      api_version: 1, project_id: PROJECT_ID, timeline_id: TIMELINE_ID,
      base_revision_id: 'r0', base_publication_id: 'p0', source: { via: 'app' },
      commands: [{ schema_version: 1, op: 'track.set', version: '1', select: 'parent/track:V1', args: { values: { label: 'App' } } }],
    };
    const transport: Transport = async (method, path, headers, body) => {
      const request = { method, path, headers, body: body ? new TextDecoder().decode(body) : '' };
      requests.push(request);
      if (path.endsWith('/editing')) {
        if (method === 'PUT' && firstPut) {
          firstPut = false;
          throw new TypeError('connection lost after Runtime accepted request');
        }
        const payload = JSON.parse(request.body);
        return { status: 200, headers: {}, body: json({ data: { ...payload,
          active: method === 'PUT', expires_in_seconds: method === 'PUT' ? 10 : 0 } }) };
      }
      if (path.endsWith('/commit')) {
        return { status: 200, headers: {}, body: json(acceptedCommit(
          { revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' })) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', transport });
    const leaseBody = { tab_session_id: 'retry-owner', sequence: 1 };

    await expect(client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, leaseBody)).rejects.toThrow(TypeError);
    await client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, leaseBody);
    await client.commitTimeline(PROJECT_ID, TIMELINE_ID, wireBody, 'retry-body-key');

    const puts = requests.filter(request => request.method === 'PUT' && request.path.endsWith('/editing'));
    const commit = requests.find(request => request.method === 'POST' && request.path.endsWith('/commit'))!;
    expect(puts).toHaveLength(2);
    expect(puts.map(request => JSON.parse(request.body))).toEqual([leaseBody, leaseBody]);
    expect(commit.headers['X-Timeline-Editing-Session']).toBe('retry-owner');
    expect(commit.headers['Idempotency-Key']).toBe('retry-body-key');
    expect(JSON.parse(commit.body)).toEqual(wireBody);
  });

  it('keeps same-generation renewals usable when acknowledgements arrive out of order', async () => {
    const fixture = runtimeFixture();
    const renewalReplies = new Map<number, (value: Awaited<ReturnType<Transport>>) => void>();
    const commits: Array<{ key?: string; headers: Record<string, string>; body: string }> = [];
    const transport: Transport = async (method, path, headers, body) => {
      if (path.endsWith('/editing')) {
        const request = JSON.parse(new TextDecoder().decode(body));
        if (method === 'PUT') {
          return await new Promise(resolve => renewalReplies.set(request.sequence, resolve));
        }
        return { status: 200, headers: {}, body: json({ data: { ...request,
          active: method === 'PUT', expires_in_seconds: method === 'PUT' ? 10 : 0 } }) };
      }
      if (path.endsWith('/commit')) {
        commits.push({ key: headers['Idempotency-Key'] ?? headers['idempotency-key'], headers, body: new TextDecoder().decode(body) });
        return { status: 200, headers: {}, body: json(acceptedCommit(
          { revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' })) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', transport });
    const wireBody: CommitRequest = {
      api_version: 1, project_id: PROJECT_ID, timeline_id: TIMELINE_ID,
      base_revision_id: 'r0', base_publication_id: 'p0', source: { via: 'app' },
      commands: [{ schema_version: 1, op: 'track.set', version: '1', select: 'parent/track:V1', args: { values: { label: 'App' } } }],
    };
    const sendCommit = () => client.commitTimeline(PROJECT_ID, TIMELINE_ID, wireBody, 'same-body-key');

    const initial = client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'stable-owner', sequence: 1 });
    const earlier = client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'stable-owner', sequence: 2 });
    const later = client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'stable-owner', sequence: 3 });
    await waitForRenewalReplies(renewalReplies, [1, 2, 3]);

    // The initial successful acknowledgment arrives while renewals 2 and 3 are pending.
    // It must make the cold-start owner usable even though newer requests were already sent.
    renewalReplies.get(1)!({ status: 200, headers: {}, body: json({ data: {
      tab_session_id: 'stable-owner', sequence: 1, active: true, expires_in_seconds: 10,
    } }) });
    await initial;
    await sendCommit();

    // A later successful renewal remains usable while the newest request is still in flight.
    renewalReplies.get(2)!({ status: 200, headers: {}, body: json({ data: {
      tab_session_id: 'stable-owner', sequence: 2, active: true, expires_in_seconds: 10,
    } }) });
    await earlier;
    await sendCommit();

    // A later request is acknowledged first; the delayed lower sequence must not fence it.
    const newest = client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'stable-owner', sequence: 4 });
    await waitForRenewalReplies(renewalReplies, [4]);
    renewalReplies.get(4)!({ status: 200, headers: {}, body: json({ data: {
      tab_session_id: 'stable-owner', sequence: 4, active: true, expires_in_seconds: 10,
    } }) });
    await newest;
    renewalReplies.get(3)!({ status: 200, headers: {}, body: json({ data: {
      tab_session_id: 'stable-owner', sequence: 3, active: true, expires_in_seconds: 10,
    } }) });
    await later;
    await sendCommit();

    expect(commits).toHaveLength(3);
    expect(commits.map(commit => commit.key)).toEqual(['same-body-key', 'same-body-key', 'same-body-key']);
    expect(commits.map(commit => commit.headers['X-Timeline-Editing-Session'])).toEqual(['stable-owner', 'stable-owner', 'stable-owner']);
    expect(commits.map(commit => commit.body)).toEqual([JSON.stringify(wireBody), JSON.stringify(wireBody), JSON.stringify(wireBody)]);
  });

  it('sends only its acknowledged timeline lease credential and fences late renewal acknowledgements after release', async () => {
    const fixture = runtimeFixture();
    const sent: Array<{ path: string; credential?: string }> = [];
    let finishRenewal: (() => void) | undefined;
    let holdRenewal = false;
    const transport: Transport = async (method, path, headers, body) => {
      if (path.endsWith('/editing')) {
        const request = JSON.parse(new TextDecoder().decode(body));
        if (method === 'PUT' && holdRenewal) await new Promise<void>(resolve => { finishRenewal = resolve; });
        return { status: 200, headers: {}, body: json({ data: { ...request,
          active: method === 'PUT', expires_in_seconds: method === 'PUT' ? 10 : 0 } }) };
      }
      if (path.endsWith('/commit')) {
        sent.push({ path, credential: headers['X-Timeline-Editing-Session'] });
        return { status: 200, headers: {}, body: json(acceptedCommit(
          { revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' })) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', transport });
    const commit = (timelineId = TIMELINE_ID) => client.commitTimeline(PROJECT_ID, timelineId, {
      api_version: 1, project_id: PROJECT_ID, timeline_id: timelineId,
      base_revision_id: 'r0', base_publication_id: 'p0', source: { via: 'app' },
      commands: [{ schema_version: 1, op: 'track.set', version: '1', select: 'parent/track:V1', args: { values: { label: 'App' } } }],
    }, 'same-body-key');
    await commit();
    await client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'opaque-app-tab', sequence: 1 });
    await commit();
    await commit('other-timeline');
    holdRenewal = true;
    const renewal = client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'opaque-app-tab', sequence: 2 });
    await new Promise<void>(resolve => { const poll = () => finishRenewal ? resolve() : setTimeout(poll, 0); poll(); });
    await client.releaseTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'opaque-app-tab', sequence: 3 });
    finishRenewal!();
    await renewal;
    await commit();
    expect(sent.map(request => request.credential)).toEqual([undefined, 'opaque-app-tab', undefined, undefined]);
  });

  it('attaches the acknowledged owner only to restore and fences a late renewal after release', async () => {
    const fixture = runtimeFixture();
    const requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }> = [];
    let finishRenewal: ((value: Awaited<ReturnType<Transport>>) => void) | undefined;
    let holdRenewal = false;
    const transport: Transport = async (method, path, headers, body) => {
      const request = { method, path, headers, body: body ? new TextDecoder().decode(body) : '' };
      requests.push(request);
      if (path.endsWith('/editing')) {
        const payload = JSON.parse(request.body);
        if (method === 'PUT' && holdRenewal) {
          return await new Promise(resolve => { finishRenewal = resolve; });
        }
        return { status: 200, headers: {}, body: json({ data: { ...payload,
          active: method === 'PUT', expires_in_seconds: method === 'PUT' ? 10 : 0 } }) };
      }
      if (path.endsWith('/restore')) {
        return { status: 200, headers: {}, body: json(acceptedCommit(
          { revision_id: 'r2', publication_id: 'p2' }, { revision_id: 'r1', publication_id: 'p1' })) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', transport });
    const restore = (key: string) => client.restoreProjectParentCompositionRevision(
      PROJECT_ID, TIMELINE_ID, 'revision/one', 'head/one', 'publication/one', key,
    );
    await client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'restore-owner', sequence: 1 });
    await restore('restore-key-1');

    holdRenewal = true;
    const renewal = client.updateTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'restore-owner', sequence: 2 });
    for (let attempt = 0; attempt < 100 && !finishRenewal; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(finishRenewal).toBeDefined();
    await client.releaseTimelineEditing(PROJECT_ID, TIMELINE_ID, { tab_session_id: 'restore-owner', sequence: 3 });
    finishRenewal!({ status: 200, headers: {}, body: json({ data: {
      tab_session_id: 'restore-owner', sequence: 2, active: true, expires_in_seconds: 10,
    } }) });
    await renewal;
    await restore('restore-key-2');

    const restores = requests.filter(request => request.path.endsWith('/restore'));
    expect(restores).toHaveLength(2);
    expect(restores.map(request => request.headers['X-Timeline-Editing-Session'])).toEqual(['restore-owner', undefined]);
    expect(restores.map(request => request.headers['Idempotency-Key'])).toEqual(['restore-key-1', 'restore-key-2']);
    expect(restores.map(request => JSON.parse(request.body))).toEqual([
      { expected_head: 'head/one', expected_publication_id: 'publication/one' },
      { expected_head: 'head/one', expected_publication_id: 'publication/one' },
    ]);
  });

  it('uses the T1 PUT and DELETE route, body shape, and authenticated mutation boundary', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = async (method, path, _headers, body) => {
      const payload = body ? JSON.parse(new TextDecoder().decode(body)) : undefined;
      requests.push({ method, path, ...(payload ? { body: payload } : {}) });
      if (path === '/v1/health') return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_epoch: 1, runtime_instance_id: 'runtime-1' }) };
      if (path === '/v1/handshake') return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, session_id: 'session-1', actor_id: 'astrid-product-r3', realm_id: 'realm-1', scopes: RUNTIME_CLIENT_SCOPES, capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] }) };
      if (path === '/v1/realm') return { status: 200, headers: {}, body: json({ realm_id: 'realm-1', display_name: 'Test', version: 1, created_at: '2026-01-01T00:00:00Z' }) };
      return { status: 200, headers: {}, body: json({ data: { tab_session_id: 'tab-1', sequence: 1, active: method === 'PUT', expires_in_seconds: method === 'PUT' ? 10 : 0 } }) };
    };
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', transport });
    await client.updateTimelineEditing('project/1', 'timeline/1', { tab_session_id: 'tab-1', sequence: 1, ttl_seconds: 10 });
    await client.releaseTimelineEditing('project/1', 'timeline/1', { tab_session_id: 'tab-1', sequence: 2 });

    expect(requests.filter((request) => request.method === 'PUT' || request.method === 'DELETE')).toEqual([
      { method: 'PUT', path: '/v1/projects/project%2F1/timelines/timeline%2F1/editing', body: { tab_session_id: 'tab-1', sequence: 1, ttl_seconds: 10 } },
      { method: 'DELETE', path: '/v1/projects/project%2F1/timelines/timeline%2F1/editing', body: { tab_session_id: 'tab-1', sequence: 2 } },
    ]);
  });

  it('composes the lease capability through RuntimeDataProvider with its bound project id', async () => {
    const fixture = runtimeFixture();
    const leaseCalls: Array<{ method: string; path: string; body: unknown }> = [];
    const transport: Transport = async (method, path, headers, body) => {
      if (path.endsWith('/editing')) {
        const request = body ? JSON.parse(new TextDecoder().decode(body)) : undefined;
        leaseCalls.push({ method, path, body: request });
        return { status: 200, headers: {}, body: json({ data: {
          tab_session_id: request.tab_session_id, sequence: request.sequence,
          active: method === 'PUT', expires_in_seconds: method === 'PUT' ? 10 : 0,
        } }) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport });
    await provider.timelineEditingLease!.renew(TIMELINE_ID, 'tab-provider', 4, 10);
    await provider.timelineEditingLease!.release(TIMELINE_ID, 'tab-provider', 5);
    expect(leaseCalls).toEqual([
      { method: 'PUT', path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/editing`, body: { tab_session_id: 'tab-provider', sequence: 4, ttl_seconds: 10 } },
      { method: 'DELETE', path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/editing`, body: { tab_session_id: 'tab-provider', sequence: 5 } },
    ]);
  });
});
