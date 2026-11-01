import { describe, expect, it } from 'vitest';
import { RUNTIME_CLIENT_SCOPES } from './client.ts';
import { RUNTIME_SCHEMA_DIGEST, RUNTIME_TARGETED_EXECUTION_CAPABILITY } from './contract-metadata.ts';
import { RuntimeDataProvider } from './dataProvider.ts';
import { resolveRuntimeProjectId } from './resolveProjectSelector.ts';

const CANONICAL = '811a657af5fe43e4b2b48a670de1f3e8';
const SLUG = 'almost-ready';
const TIMELINE = '01M4GGKMHZ3J8V402C8CWSCE95';
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

// Mirrors the Runtime: selectors match `id OR slug`, responses carry the canonical id.
function runtimeTransport() {
  const ok = (body: unknown) => ({ status: 200, headers: {}, body: json(body) });
  return async (method: string, path: string) => {
    if (path === '/v1/health') return ok({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_epoch: 1, runtime_instance_id: 'ri' });
    if (path === '/v1/handshake') return ok({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, session_id: 's', actor_id: 'astrid-product-connector', realm_id: 'r', scopes: RUNTIME_CLIENT_SCOPES, capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] });
    if (path === '/v1/realm') return ok({ realm_id: 'r', display_name: 'x', version: 1, created_at: '2026-09-11T00:00:00Z' });
    const project = /^\/v1\/projects\/([^/]+)$/.exec(path);
    if (method === 'GET' && project) {
      const selector = decodeURIComponent(project[1]);
      if (selector !== CANONICAL && selector !== SLUG) {
        return { status: 404, headers: {}, body: json({ code: 'not_found', message: 'project not found', details: { project: selector } }) };
      }
      return ok({ project_id: CANONICAL, realm_id: 'r', slug: SLUG, name: 'Almost Ready', metadata: {}, version: 1, created_at: 'x', updated_at: 'x' });
    }
    const timeline = new RegExp(`^/v1/projects/${CANONICAL}/timelines/${TIMELINE}$`).exec(path);
    if (method === 'GET' && timeline) {
      return ok({
        project_id: CANONICAL,
        timeline_id: TIMELINE,
        version: 1,
        name: 'Almost Ready timeline',
        archived: false,
        shots: [],
        references: [],
        head_revision_id: 'rev-1',
        head_publication_id: 'publication-1',
      });
    }
    if (path.endsWith('/inspect')) {
      return ok({ representation: 'canonical_head', authority: 'runtime_parent_composition', project_id: CANONICAL, timeline_id: TIMELINE, revision_id: 'rev-1', head_revision_id: 'rev-1', is_current_head: true });
    }
    if (path.includes('/composition-revisions/')) {
      return ok({ revision_id: 'rev-1', project_id: CANONICAL, timeline_id: TIMELINE, content_digest: `sha256:${'1'.repeat(64)}`, payload: { config: { tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }], clips: [] }, registry: { assets: {} }, clips: [], occurrences: [] }, created_at: 'x' });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
}

describe('resolveRuntimeProjectId', () => {
  it('resolves a slug to the canonical id so the provider passes its identity checks', async () => {
    const transport = runtimeTransport() as never;
    const id = await resolveRuntimeProjectId(SLUG, { transport });
    expect(id).toBe(CANONICAL);
    const provider = new RuntimeDataProvider({ projectId: id, transport });
    await expect(provider.loadTimeline(TIMELINE)).resolves.toMatchObject({ head: { projectId: CANONICAL } });
  });

  it('keeps a canonical id as is', async () => {
    expect(await resolveRuntimeProjectId(CANONICAL, { transport: runtimeTransport() as never })).toBe(CANONICAL);
  });

  it('reports an unknown selector as project not found, not an identity mismatch', async () => {
    await expect(resolveRuntimeProjectId('nope', { transport: runtimeTransport() as never }))
      .rejects.toThrow(/project "nope" not found/i);
  });

  it('shows the failure being fixed: an unresolved slug fails the identity guard', async () => {
    const provider = new RuntimeDataProvider({ projectId: SLUG, transport: runtimeTransport() as never });
    await expect(provider.loadTimeline(TIMELINE)).rejects.toThrow(/not almost-ready/);
  });
});
