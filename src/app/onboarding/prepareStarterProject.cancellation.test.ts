import { describe, expect, it, vi } from 'vitest';
import type { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import type { Project } from '@/integrations/runtime/generated.ts';
import { prepareStarterProject, STARTER_PROJECT_INTENT_METADATA } from './prepareStarterProject.ts';

function project(id: string, metadata: Record<string, unknown> = {}): Project {
  return {
    project_id: id, realm_id: 'realm', slug: id, name: id, metadata, version: 1,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  };
}

describe('prepareStarterProject cancellation recovery', () => {
  it('recovers a committed slow create on retry without creating a second project', async () => {
    const committed = project('committed-project', { [STARTER_PROJECT_INTENT_METADATA]: 'slow-intent' });
    const projects: Project[] = [];
    const timelines = new Map<string, Record<string, unknown>[]>();
    let resolveCreate!: (value: Project) => void;
    const createResponse = new Promise<Project>(resolve => { resolveCreate = resolve; });
    let createStarted!: () => void;
    const creating = new Promise<void>(resolve => { createStarted = resolve; });
    const methods = {
      listProjects: vi.fn(async () => [...projects]),
      createProject: vi.fn(() => {
        if (!projects.some(row => row.project_id === committed.project_id)) projects.push(committed);
        createStarted();
        return createResponse;
      }),
      listTimelines: vi.fn(async (id: string) => timelines.get(id) ?? []),
      getProject: vi.fn(async (id: string) => projects.find(row => row.project_id === id)!),
      // Catalog creation installs the canonical bootstrap atomically (createDefaultTimeline.ts).
      createTimeline: vi.fn(async (id: string, timelineId: string, _key: string, name?: string) => {
        timelines.set(id, [{ timeline_id: timelineId, head_revision_id: 'head', slug: 'main', name }]);
        return { data: { timeline_id: timelineId } };
      }),
      updateProject: vi.fn(async (id: string, _key: string, _version: number, _name: string | undefined,
        metadata: Record<string, unknown>) => {
        const row = projects.find(item => item.project_id === id)!;
        row.metadata = metadata;
        return row;
      }),
    };
    const client = methods as unknown as AstridRuntimeClient;
    const controller = new AbortController();
    const firstAttempt = prepareStarterProject({ intentId: 'slow-intent', client, signal: controller.signal });

    await creating;
    expect(methods.createProject).toHaveBeenCalledOnce();
    expect(projects).toHaveLength(1); // The server committed even though its response is still pending.
    controller.abort();
    const firstAttemptRejected = expect(firstAttempt).rejects.toThrow();

    const recovered = await prepareStarterProject({ intentId: 'slow-intent', client });
    resolveCreate(committed);
    await firstAttemptRejected;

    expect(recovered.projectId).toBe('committed-project');
    expect(recovered.timelineId).toBeTruthy();
    expect(projects).toHaveLength(1);
    expect(methods.createProject).toHaveBeenCalledOnce();
    expect(methods.createProject).toHaveBeenCalledWith('My first project', 'astrid-onboarding-project-slow-intent',
      'my-first-project-slow-int', { aspect_ratio: '16:9', [STARTER_PROJECT_INTENT_METADATA]: 'slow-intent' });
  });
});
