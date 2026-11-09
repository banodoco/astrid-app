// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same-origin page: no separate Runtime origin, so the page reads the launcher's status.
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeOrigin: () => '', runtimeApiBase: () => '/api/runtime' }));

import { loadPageUpdateStatus } from './pageUpdateStatus.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the launcher path names the install manager from the Runtime identity', () => {
  it('a Pinokio-managed Runtime gives managedBy pinokio, since the launcher status does not report the manager', async () => {
    vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/__astrid/local-update-status')) {
        return json({ app: 'a'.repeat(40), release: 11, servedApp: 'b'.repeat(40), servedRelease: 11, behind: false, self_update: true });
      }
      if (url.endsWith('/v1/health')) {
        return json({ status: 'ok', protocol: 'workspace.v1', schema_digest: 'schema-test', runtime_instance_id: 'instance-a', runtime_session_id: 's', runtime_epoch: 1, identity: { managed_by: 'pinokio', release: 11 } });
      }
      return new Response('{}', { status: 404 });
    }));
    expect((await loadPageUpdateStatus())?.managedBy).toBe('pinokio');
  });
});
