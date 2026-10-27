import { describe, expect, it, vi } from 'vitest';
import { checkHostedUpdate, checkLocalUpdate } from './updateStatus.ts';

const health = (release?: number) => ({ status: 'ok', protocol: 'workspace.v1', schema_digest: 'digest', runtime_epoch: 1, runtime_session_id: 's', runtime_instance_id: 'i', ...(release === undefined ? {} : { release }) }) as never;
function response(value: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) } as Response;
}

describe('update status queries', () => {
  it('uses zero for an absent installed release and queries the live build and manifest without cache', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ app: 'served-build', release: 4 }))
      .mockResolvedValueOnce(response({ release: 4 }));
    const result = await checkHostedUpdate(health(), fetcher);
    expect(fetcher.mock.calls.map(([url, options]) => [url, options?.cache])).toEqual([
      ['/build.json', 'no-store'], ['/install-manifest.json', 'no-store'],
    ]);
    expect(result.release).toBe(0);
    expect(result.behind).toBe(true);
    expect(result.resolution.installedRelease).toBe(0);
  });

  it('handles equal, behind, ahead, and required release facts', async () => {
    for (const [installed, served, behind] of [[4, 4, false], [3, 4, true], [5, 4, false]] as const) {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(response({ app: 'served-build', release: served }))
        .mockResolvedValueOnce(response({ release: served }));
      const result = await checkHostedUpdate(health(installed), fetcher);
      expect(result.behind).toBe(behind);
    }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ app: 'served-build', release: 4 }))
      .mockResolvedValueOnce(response({ release: 4, required: { release: 5, reason: 'Security fix' } }));
    const required = await checkHostedUpdate(health(3), fetcher);
    expect(required.resolution).toMatchObject({ requiredRelease: 5, requiredReason: 'Security fix' });
  });

  it('asks only the local launcher for git based status and rejects failed status reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ app: 'local-head', servedApp: 'served-head', release: 3, servedRelease: 4, behind: true }));
    const result = await checkLocalUpdate(fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/__astrid/local-update-status');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '', cache: 'no-store' });
    expect(result).toMatchObject({ app: 'local-head', servedApp: 'served-head', behind: true });
    await expect(checkLocalUpdate(vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'unavailable' }, 503)))).rejects.toThrow('HTTP 503');
  });
});
