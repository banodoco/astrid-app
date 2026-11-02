import { describe, expect, it } from 'vitest';
import { AstridRuntimeClient, RUNTIME_CLIENT_SCOPES } from './client.ts';
import { RuntimeDataProvider } from './dataProvider.ts';
import type { Transport } from './generated.ts';
import { RUNTIME_SCHEMA_DIGEST, RUNTIME_TARGETED_EXECUTION_CAPABILITY } from './contract-metadata.ts';
import { PROJECT_ID, TIMELINE_ID, json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';

function json(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)); }

describe('Runtime timeline editing lease client', () => {
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
