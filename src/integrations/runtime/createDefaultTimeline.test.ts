import { describe, expect, it, vi } from 'vitest';
import { AstridRuntimeClient } from './client.ts';
import { ApiError } from './generated.ts';
import { json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { createCanonicalTimeline, ensureProjectHasTimeline } from './createDefaultTimeline.ts';

function runtimeClient(timelines: Record<string, unknown>[]) {
  return {
    getProject: vi.fn(async () => ({ project_id: 'project-id', version: 1, metadata: { unrelated: true } })),
    updateProject: vi.fn(async (_id, _key, _version, _name, metadata) => ({ project_id: 'project-id', version: 2, metadata })),
    listTimelines: vi.fn(async () => timelines),
    createTimeline: vi.fn(async () => ({ head_revision_id: 'parent-head', head_publication_id: 'publication' })),
  } as unknown as AstridRuntimeClient;
}

describe('ensureProjectHasTimeline', () => {
  it('reuses an existing canonical timeline head instead of creating a duplicate', async () => {
    const client = runtimeClient([
      { timeline_id: 'older', head_revision_id: 'head-older', slug: 'reference' },
      { timeline_id: 'main-id', head_revision_id: 'head-main', slug: 'main', is_default: true },
    ]);

    await expect(ensureProjectHasTimeline('project-id', client)).resolves.toBe('main-id');
    expect(client.createTimeline).not.toHaveBeenCalled();
  });

  it('asks Runtime to create and bootstrap the first timeline atomically', async () => {
    const client = runtimeClient([]);
    const created = await ensureProjectHasTimeline('project-id', client);
    expect(created).toBeTruthy();
    expect(client.createTimeline).toHaveBeenCalledWith('project-id', created, 'astrid-first-timeline-project-id', 'Main');
  });

  it('adopts an existing headless shell without overwriting its name or creating another timeline', async () => {
    const client = runtimeClient([{ timeline_id: 'headless-shell', head_revision_id: null, name: 'My timeline' }]);
    await expect(ensureProjectHasTimeline('project-id', client)).resolves.toBe('headless-shell');
    expect(client.createTimeline).toHaveBeenCalledWith('project-id', 'headless-shell', 'astrid-first-timeline-project-id');
  });

  it('honors a reassigned Main pointer over a timeline named main without changing either composition', async () => {
    const client = runtimeClient([
      { timeline_id: 'original', slug: 'main', head_revision_id: 'h1' },
      { timeline_id: 'chosen', slug: 'other', head_revision_id: 'h2' },
    ]);
    vi.mocked(client.getProject).mockResolvedValue({ version: 1, metadata: { default_timeline_id: 'chosen' } } as never);
    expect(await ensureProjectHasTimeline('project-id', client)).toBe('chosen');
    expect(client.createTimeline).not.toHaveBeenCalled();
    expect(client.updateProject).not.toHaveBeenCalled();
  });

  it('returns the canonical ID when the project primary metadata contains a timeline alias', async () => {
    const client = runtimeClient([
      { timeline_id: 'timeline-canonical', timeline_ulid: 'timeline-alias', head_revision_id: 'head' },
    ]);
    vi.mocked(client.getProject).mockResolvedValue({
      version: 1,
      metadata: { default_timeline_id: 'timeline-alias' },
    } as never);

    await expect(ensureProjectHasTimeline('project-id', client)).resolves.toBe('timeline-canonical');
    expect(client.updateProject).not.toHaveBeenCalled();
  });

  it('prefers an exact canonical ID over another timeline alias collision', async () => {
    const client = runtimeClient([
      { timeline_id: 'alias-match', timeline_ulid: 'shared-ref', head_revision_id: 'alias-head' },
      { timeline_id: 'shared-ref', timeline_ulid: 'other-alias', head_revision_id: 'canonical-head' },
    ]);
    vi.mocked(client.getProject).mockResolvedValue({
      version: 1,
      metadata: { default_timeline_id: 'shared-ref' },
    } as never);

    await expect(ensureProjectHasTimeline('project-id', client)).resolves.toBe('shared-ref');
    expect(client.updateProject).not.toHaveBeenCalled();
  });

  it('refetches timelines and preserves a concurrent primary assignment by canonical ID', async () => {
    const client = runtimeClient([
      { timeline_id: 'original', head_revision_id: 'old-head' },
    ]);
    vi.mocked(client.getProject)
      .mockResolvedValueOnce({ version: 1, metadata: {} } as never)
      .mockResolvedValueOnce({ version: 2, metadata: { default_timeline_id: 'new-alias' } } as never);
    vi.mocked(client.listTimelines)
      .mockResolvedValueOnce([{ timeline_id: 'original', head_revision_id: 'old-head' }] as never)
      .mockResolvedValueOnce([{
        timeline_id: 'concurrent-canonical',
        timeline_ulid: 'new-alias',
        head_revision_id: 'new-head',
      }] as never);

    await expect(ensureProjectHasTimeline('project-id', client)).resolves.toBe('concurrent-canonical');
    expect(client.updateProject).not.toHaveBeenCalled();
    expect(client.listTimelines).toHaveBeenCalledTimes(2);
  });

  it('throws a retryable error instead of returning an unresolved concurrent alias', async () => {
    const client = runtimeClient([{ timeline_id: 'original', head_revision_id: 'old-head' }]);
    vi.mocked(client.getProject)
      .mockResolvedValueOnce({ version: 1, metadata: {} } as never)
      .mockResolvedValueOnce({ version: 2, metadata: { default_timeline_id: 'unresolved-alias' } } as never)
      .mockResolvedValueOnce({ version: 2, metadata: { default_timeline_id: 'unresolved-alias' } } as never);
    vi.mocked(client.listTimelines)
      .mockResolvedValueOnce([{ timeline_id: 'original', head_revision_id: 'old-head' }] as never)
      .mockResolvedValueOnce([{ timeline_id: 'original', head_revision_id: 'old-head' }] as never);

    await expect(ensureProjectHasTimeline('project-id', client)).rejects.toThrow(
      'could not be resolved to a canonical timeline ID; retry',
    );
    expect(client.updateProject).not.toHaveBeenCalled();
  });

  it('merges a newly created Main pointer with concurrent chat metadata after a CAS conflict', async () => {
    const client = runtimeClient([]);
    vi.mocked(client.getProject).mockResolvedValueOnce({ version: 1, metadata: {} } as never)
      .mockResolvedValueOnce({ version: 1, metadata: {} } as never)
      .mockResolvedValue({ version: 2, metadata: { chat: { keep: true } } } as never);
    vi.mocked(client.updateProject).mockRejectedValueOnce(new ApiError(409, 'version_conflict', 'changed'));
    const id = await ensureProjectHasTimeline('project-id', client);
    expect(client.updateProject).toHaveBeenLastCalledWith('project-id', expect.any(String), 2, undefined,
      { chat: { keep: true }, default_timeline_id: id });
    expect(client.createTimeline).toHaveBeenCalledTimes(1);
  });

  it('creates an additional canonical timeline with its own idempotency key', async () => {
    const client = runtimeClient([]);

    await expect(createCanonicalTimeline('project-id', {
      name: 'Timeline 2',
      timelineId: 'project-timeline-2',
    }, client)).resolves.toBe('project-timeline-2');
    expect(client.createTimeline).toHaveBeenCalledWith('project-id', 'project-timeline-2',
      'astrid-timeline-create-project-id-project-timeline-2', 'Timeline 2');
  });

  it('retries catalog creation with the exact key and body after a lost response', async () => {
    const fixture = runtimeFixture({ projectId: 'project-id', timelineExists: false });
    let lost = false;
    const creates: Array<{ path: string; key: string; body: unknown }> = [];
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', transport: async (method, path, headers, body) => {
      // Simulate stale discovery after the lost create ACK; Runtime still owns exact-key replay.
      if (method === 'GET' && path.endsWith('/timelines?limit=200')) return { status: 200, headers: {}, body: json({ items: [], next_cursor: null }) };
      const response = await fixture.transport(method, path, headers, body);
      if (method === 'POST' && path.endsWith('/timelines')) {
        creates.push({ path, key: headers['Idempotency-Key'], body: JSON.parse(new TextDecoder().decode(body as Uint8Array)) });
        if (!lost) { lost = true; throw new Error('simulated lost response after commit'); }
      }
      return response;
    } });
    await expect(ensureProjectHasTimeline('project-id', client)).rejects.toThrow('simulated lost response');
    const timelineId = await ensureProjectHasTimeline('project-id', client);
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual(creates[1]);
    expect(creates[0]).toEqual({ path: '/v1/projects/project-id/timelines', key: 'astrid-first-timeline-project-id',
      body: { timeline_id: timelineId, name: 'Main' } });
    expect(fixture.read().parentComposition).toMatchObject({ config: { clips: [], tracks: [] }, clips: [], occurrences: [] });
    expect((await client.getProject('project-id')).metadata.default_timeline_id).toBe(timelineId);
  });
});
