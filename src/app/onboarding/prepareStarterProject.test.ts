import { describe, expect, it, vi } from 'vitest';
import type { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import type { Project } from '@/integrations/runtime/generated.ts';
import { prepareStarterProject, STARTER_PROJECT_INTENT_METADATA } from './prepareStarterProject.ts';

function project(id: string, extra: Partial<Project> = {}): Project {
  return { project_id: id, realm_id: 'realm', slug: id, name: id, metadata: {}, version: 1,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...extra };
}
function workspace(initial: Project[] = []) {
  const projects = [...initial];
  const timelines = new Map<string, Record<string, unknown>[]>();
  const creations = new Map<string, Project>();
  const methods = {
    listProjects: vi.fn(async () => [...projects]),
    createProject: vi.fn(async (name: string, key: string, slug: string, metadata: Record<string, unknown>) => {
      let created = creations.get(key);
      if (!created) {
        created = project('created-project', { name, slug, metadata });
        creations.set(key, created);
        projects.push(created);
      }
      return created;
    }),
    listTimelines: vi.fn(async (id: string) => timelines.get(id) ?? []),
    getProject: vi.fn(async (id: string) => projects.find(row => row.project_id === id)!),
    // Catalog creation installs the canonical bootstrap atomically (createDefaultTimeline.ts).
    createTimeline: vi.fn(async (id: string, timelineId: string, _key: string, name?: string) => {
      timelines.set(id, [{ timeline_id: timelineId, head_revision_id: 'head', slug: 'main', name }]);
      return { data: { timeline_id: timelineId } };
    }),
    updateProject: vi.fn(async (id: string, _key: string, _version: number, _name: string | undefined, metadata: Record<string, unknown>) => {
      const row = projects.find(item => item.project_id === id)!;
      row.metadata = metadata;
      return row;
    }),
  };
  return { methods, projects, timelines, client: methods as unknown as AstridRuntimeClient };
}

describe('prepareStarterProject', () => {
  it('creates one blank project and canonical Main timeline after successful empty discovery', async () => {
    const { client, methods } = workspace();
    const result = await prepareStarterProject({ intentId: 'intent-1', client });
    expect(result.projectId).toBe('created-project');
    expect(result.timelineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(methods.createProject).toHaveBeenCalledWith('My first project', 'astrid-onboarding-project-intent-1',
      'my-first-project-intent-1', { aspect_ratio: '16:9', [STARTER_PROJECT_INTENT_METADATA]: 'intent-1' });
    expect(methods.createTimeline).toHaveBeenCalledWith('created-project', result.timelineId,
      'astrid-first-timeline-created-project', 'Main');
  });

  it('never interprets failed discovery as an empty workspace', async () => {
    const { client, methods } = workspace();
    methods.listProjects.mockRejectedValue(new Error('offline'));
    await expect(prepareStarterProject({ intentId: 'intent-1', client })).rejects.toThrow('offline');
    expect(methods.createProject).not.toHaveBeenCalled();
  });

  it('does not publish into an unconfirmed project after a malformed create response', async () => {
    const { client, methods } = workspace();
    methods.createProject.mockResolvedValue({ name: 'My first project' } as Project);
    await expect(prepareStarterProject({ intentId: 'intent-1', client })).rejects.toThrow('did not confirm');
    expect(methods.createTimeline).not.toHaveBeenCalled();
  });

  it('reopens the last project and its chosen timeline without mutating existing work', async () => {
    const { client, methods, timelines } = workspace([
      project('last', { metadata: { default_timeline_id: 'chosen-alias' } }),
      project('newest', { created_at: '2026-10-20T00:00:00Z' }),
    ]);
    timelines.set('last', [{ timeline_id: 'chosen', timeline_ulid: 'chosen-alias', head_revision_id: 'head' }]);
    expect(await prepareStarterProject({ intentId: 'intent-1', preferredProjectId: 'last', client }))
      .toEqual({ projectId: 'last', timelineId: 'chosen' });
    expect(methods.createProject).not.toHaveBeenCalled();
    expect(methods.createTimeline).not.toHaveBeenCalled();
    expect(methods.updateProject).not.toHaveBeenCalled();
  });

  it('does not create a timeline in an existing empty project', async () => {
    const { client, methods } = workspace([project('existing')]);
    expect(await prepareStarterProject({ intentId: 'intent-1', client })).toEqual({ projectId: 'existing', timelineId: null });
    expect(methods.createTimeline).not.toHaveBeenCalled();
    expect(methods.createProject).not.toHaveBeenCalled();
  });

  it('falls back to the newest existing project when the saved project is absent', async () => {
    const { client, methods } = workspace([project('old'), project('new', { created_at: '2026-10-20T00:00:00Z' })]);
    expect(await prepareStarterProject({ intentId: 'intent-1', preferredProjectId: 'missing', client }))
      .toEqual({ projectId: 'new', timelineId: null });
    expect(methods.createProject).not.toHaveBeenCalled();
  });

  it('does not replace existing work when its timeline discovery fails', async () => {
    const { client, methods } = workspace([project('existing')]);
    methods.listTimelines.mockRejectedValue(new Error('timeline read failed'));
    await expect(prepareStarterProject({ intentId: 'intent-1', client })).rejects.toThrow('timeline read failed');
    expect(methods.createProject).not.toHaveBeenCalled();
    expect(methods.createTimeline).not.toHaveBeenCalled();
    expect(methods.updateProject).not.toHaveBeenCalled();
  });

  it('recovers a committed project after a lost response without creating a second one', async () => {
    const { client, methods, projects } = workspace();
    methods.createProject.mockImplementationOnce(async () => {
      projects.push(project('committed', { metadata: { [STARTER_PROJECT_INTENT_METADATA]: 'intent-1' } }));
      throw new Error('response lost');
    });
    await expect(prepareStarterProject({ intentId: 'intent-1', client })).rejects.toThrow('response lost');
    const recovered = await prepareStarterProject({ intentId: 'intent-1', client });
    expect(recovered.projectId).toBe('committed');
    expect(recovered.timelineId).toBeTruthy();
    expect(methods.createProject).toHaveBeenCalledTimes(1);
  });

  it('repairs a failed timeline publication in the same project on retry', async () => {
    const { client, methods, projects } = workspace();
    methods.createTimeline.mockRejectedValueOnce(new Error('publication failed'));
    await expect(prepareStarterProject({ intentId: 'intent-1', client })).rejects.toThrow('publication failed');
    const recovered = await prepareStarterProject({ intentId: 'intent-1', client });
    expect(projects).toHaveLength(1);
    expect(methods.createProject).toHaveBeenCalledTimes(1);
    expect(methods.createTimeline.mock.calls[0][1]).toBe(recovered.timelineId);
    expect(methods.createTimeline.mock.calls[1][1]).toBe(recovered.timelineId);
  });

  it('uses the same Runtime creation key for overlapping attempts', async () => {
    const { client, projects, methods } = workspace();
    const results = await Promise.all([
      prepareStarterProject({ intentId: 'intent-1', client }),
      prepareStarterProject({ intentId: 'intent-1', client }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(projects).toHaveLength(1);
    expect(new Set(methods.createProject.mock.calls.map(call => call[1])).size).toBe(1);
  });

  it('does not replay an archived starter project intent', async () => {
    const { client, methods } = workspace([project('archived', {
      archived: true, metadata: { [STARTER_PROJECT_INTENT_METADATA]: 'intent-1' },
    })]);
    await expect(prepareStarterProject({ intentId: 'intent-1', client })).rejects.toThrow('Your only project is archived. Unarchive it or create a new one in the editor.');
    expect(methods.createProject).not.toHaveBeenCalled();
  });
});
