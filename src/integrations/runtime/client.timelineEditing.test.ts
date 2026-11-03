import { describe, expect, it } from 'vitest';
import { AstridRuntimeClient, RUNTIME_CLIENT_SCOPES } from './client.ts';
import { RuntimeDataProvider } from './dataProvider.ts';
import type { Transport } from './generated.ts';
import { RUNTIME_SCHEMA_DIGEST, RUNTIME_TARGETED_EXECUTION_CAPABILITY } from './contract-metadata.ts';
import { PROJECT_ID, TIMELINE_ID, json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { acceptedCommit } from './__tests__/timelineCommitFixture.ts';

describe('Runtime timeline editing lease client', () => {
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
