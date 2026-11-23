import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestBody, Transport } from '@/integrations/runtime/generated.ts';
import { json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { FAKE_RUNTIME_ACTOR_ID, FAKE_RUNTIME_INSTANCE_ID, FAKE_RUNTIME_REALM_ID } from '@/test/fakeRuntimeIdentity.mjs';

let VideoEditorPage: typeof import('./VideoEditorPage.tsx').default;
let setRuntimeOrigin: typeof import('@/integrations/runtime/connection.ts').setRuntimeOrigin;

vi.mock('../hooks/useRuntimeEditorDiscovery.ts', () => {
  const projects = [
    { project_id: 'project-one', name: 'First project', slug: 'first-project', metadata: {} },
    { project_id: 'project-two', name: 'Second project', slug: 'second-project', metadata: {} },
  ];
  const timelines = [{ timeline_id: 'timeline-one', name: 'Main', slug: 'main' }];
  return {
    chooseRuntimeTimeline: () => timelines[0],
    useRuntimeEditorDiscovery: ({ projectId }: { projectId: string }) => ({
      project: projects.find(project => project.project_id === projectId),
      projectsQuery: { data: projects, isSuccess: true, error: null },
      timelinesQuery: { data: timelines, isSuccess: true, error: null },
    }),
  };
});
vi.mock('../hooks/useNativeEditorRecovery.ts', () => ({
  useNativeEditorRecovery: () => ({ retrying: false, reportFailure: vi.fn() }),
}));
vi.mock('../runtime/useRuntimePackExtensions', () => ({
  runtimePackKey: () => null,
  useRuntimePackExtensions: () => ({ resolvedExtensions: [], diagnostics: {} }),
}));
vi.mock('@/shared/hooks/useHomeNavigation.ts', () => ({
  useHomeNavigation: () => ({ targetPath: '/tools/video-editor' }),
}));
vi.mock('../tour/runner/useEditorTourHost.ts', () => ({ useEditorTourHost: vi.fn() }));
vi.mock('../contexts/VideoEditorProvider.tsx', () => ({
  VideoEditorProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../components/AstridVideoEditorShell.tsx', () => ({
  AstridVideoEditorShell: () => <div>Editor mounted</div>,
}));

const SELECTION_ROUTE = '/v1/projects/selection';
const SELECTED_AT = '2026-09-11T00:00:00Z';
const HOSTED_RUNTIME_ORIGIN = 'http://127.0.0.1:17340';
const WORKSPACE_CONFIG_ROUTE = '/runtime-config/v1/workspace.json';
const LOCAL_WORKSPACE_ORIGIN_HEADER = 'x-astrid-local-workspace-origin';
type RuntimeRoute = 'local proxy' | 'paired relay' | 'hosted door';
const workspaceSelection = (projectId: string) => ({
  actor_id: FAKE_RUNTIME_ACTOR_ID,
  scope: 'workspace',
  project: {
    project_id: projectId, realm_id: FAKE_RUNTIME_REALM_ID, slug: projectId, name: projectId,
    metadata: {}, version: 1, created_at: SELECTED_AT, updated_at: SELECTED_AT, archived: false,
  },
  updated_at: SELECTED_AT,
});
const response = (status: number, value: unknown) => ({ status, headers: {}, body: json(value) });

function setupRuntime(initialProject: string | null = null, beforeWrite?: (projectId: string) => Promise<void>, route: RuntimeRoute = 'local proxy') {
  const fixture = runtimeFixture();
  let selectedProject = initialProject;
  const writes: Array<{ project: string; scope: string; key: string | undefined }> = [];
  const readSelection = vi.fn(async () => selectedProject
    ? response(200, workspaceSelection(selectedProject))
    : response(404, { code: 'not_found', message: 'no project is selected' }));
  const transport: Transport = async (method, path, headers, body) => {
    if (path !== SELECTION_ROUTE) return fixture.transport(method, path, headers, body);
    if (method === 'GET') return readSelection();
    if (method !== 'PUT') throw new Error(`Unexpected selection method ${method}`);
    const request = JSON.parse(new TextDecoder().decode(body as Uint8Array));
    writes.push({ ...request, key: headers['Idempotency-Key'] });
    if (beforeWrite) await beforeWrite(request.project);
    selectedProject = request.project;
    return response(200, { data: workspaceSelection(request.project), receipt: {} });
  };
  if (route === 'hosted door') setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: HOSTED_RUNTIME_ORIGIN });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === WORKSPACE_CONFIG_ROUTE) {
      return Response.json({
        schemaVersion: 1, endpoint: 'http://127.0.0.1:17890', actorId: FAKE_RUNTIME_ACTOR_ID,
        realmId: FAKE_RUNTIME_REALM_ID, runtimeInstanceId: FAKE_RUNTIME_INSTANCE_ID,
      }, { headers: route === 'local proxy' ? { [LOCAL_WORKSPACE_ORIGIN_HEADER]: url.origin } : {} });
    }
    const runtimeOrigin = route === 'hosted door' ? HOSTED_RUNTIME_ORIGIN : window.location.origin;
    if (url.origin !== runtimeOrigin || !url.pathname.startsWith('/api/runtime/')) {
      throw new Error(`Unexpected request to ${url.href}`);
    }
    const path = url.pathname.slice('/api/runtime'.length) + url.search;
    const headers = init?.headers as Record<string, string>;
    const reply = await transport(init?.method ?? 'GET', path, headers, init?.body as RequestBody | undefined);
    return new Response(new Uint8Array(reply.body), reply);
  });
  vi.stubGlobal('fetch', fetch);
  return { writes, readSelection, currentProject: () => selectedProject };
}

function ProjectSwitch() {
  const [, setParams] = useSearchParams();
  return <button onClick={() => setParams({ project: 'project-two', timeline: 'timeline-one' })}>Switch project</button>;
}

function openEditor(projectId = 'project-one') {
  const view = render(
    <MemoryRouter initialEntries={[`/tools/video-editor?project=${projectId}&timeline=timeline-one`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ProjectSwitch />
      <VideoEditorPage />
    </MemoryRouter>,
  );
  expect(screen.getByText('Editor mounted')).toBeInTheDocument();
  return view;
}

async function settleSelection() {
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
}

function deferredWrite() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('VideoEditorPage workspace project selection', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    ({ setRuntimeOrigin } = await import('@/integrations/runtime/connection.ts'));
    ({ default: VideoEditorPage } = await import('./VideoEditorPage.tsx'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('selects a missing workspace project and reopens it without a second mutation', async () => {
    const { writes, readSelection } = setupRuntime();
    const first = openEditor();
    await settleSelection();
    expect(writes).toEqual([{ project: 'project-one', scope: 'workspace', key: expect.any(String) }]);
    first.unmount();

    openEditor();
    await settleSelection();
    expect(writes).toHaveLength(1);
    expect(readSelection).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a different project', response(200, workspaceSelection('project-two'))],
    ['a different actor', response(200, { ...workspaceSelection('project-one'), actor_id: 'other-actor' })],
    ['a user fallback', response(200, { ...workspaceSelection('project-one'), scope: 'user' })],
    ['a malformed project', response(200, { ...workspaceSelection('project-one'), project: { project_id: 'project-one' } })],
    ['a malformed selection timestamp', response(200, { ...workspaceSelection('project-one'), updated_at: null })],
    ['an unexpected selection field', response(200, { ...workspaceSelection('project-one'), additional: true })],
    ['an unexpected project field', response(200, { ...workspaceSelection('project-one'), project: { ...workspaceSelection('project-one').project, additional: true } })],
    ['an oversized project slug', response(200, { ...workspaceSelection('project-one'), project: { ...workspaceSelection('project-one').project, slug: 's'.repeat(129) } })],
    ['an oversized project name', response(200, { ...workspaceSelection('project-one'), project: { ...workspaceSelection('project-one').project, name: 'n'.repeat(513) } })],
    ['an unsupported read', response(405, { code: 'method_not_allowed' })],
  ])('writes the workspace selection after %s', async (_name, selection) => {
    const { writes, readSelection } = setupRuntime();
    readSelection.mockResolvedValueOnce(selection);
    openEditor();
    await settleSelection();
    expect(writes).toEqual([{ project: 'project-one', scope: 'workspace', key: expect.any(String) }]);
  });

  it.each(['created_at', 'updated_at'] as const)('writes the workspace selection when project %s omits seconds', async (field) => {
    const { writes, readSelection } = setupRuntime();
    const selection = workspaceSelection('project-one');
    selection.project[field] = '2026-09-11T12:00Z';
    readSelection.mockResolvedValueOnce(response(200, selection));
    openEditor();
    await settleSelection();

    expect(writes).toEqual([{ project: 'project-one', scope: 'workspace', key: expect.any(String) }]);
  });

  it.each([
    { field: 'name', limit: 512 },
    { field: 'slug', limit: 128 },
  ] as const)('accepts a project $field with $limit Unicode code points', async ({ field, limit }) => {
    const { writes, readSelection } = setupRuntime();
    const selection = workspaceSelection('project-one');
    selection.project[field] = 'a'.repeat(limit - 1) + '🎬';
    selection.project.created_at = '2026-09-11T12:00:00.123456+00:00';
    selection.project.updated_at = '2026-09-11T12:00:00.123456+00:00';
    readSelection.mockResolvedValueOnce(response(200, selection));
    openEditor();
    await settleSelection();

    expect(readSelection).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it.each(['switching project', 'unmounting'])('ignores the old pending selection read after %s', async (change) => {
    const { writes, readSelection } = setupRuntime();
    let finishRead!: (selection: ReturnType<typeof response>) => void;
    readSelection.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const editor = openEditor();
    await settleSelection();
    expect(readSelection).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);

    if (change === 'switching project') {
      fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
      await settleSelection();
    } else {
      editor.unmount();
    }
    await act(async () => { finishRead(response(404, { code: 'not_found' })); });
    expect(writes.map(write => write.project)).toEqual(change === 'switching project' ? ['project-two'] : []);
  });

  it('preserves the later project selection when the earlier PUT is still pending', async () => {
    const earlierWrite = deferredWrite();
    const { writes, currentProject, readSelection } = setupRuntime('project-two', async project => {
      if (project === 'project-one') await earlierWrite.promise;
    });
    openEditor();
    await settleSelection();
    expect(writes.map(write => write.project)).toEqual(['project-one']);
    expect(currentProject()).toBe('project-two');

    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
    await settleSelection();
    await act(async () => { earlierWrite.resolve(); });

    expect(currentProject()).toBe('project-two');
    expect(writes.map(write => write.project)).toEqual(['project-one', 'project-two']);
    expect(readSelection).toHaveBeenCalledTimes(2);
  });

  it('drops the waiting project selection when the editor unmounts before the earlier PUT settles', async () => {
    const earlierWrite = deferredWrite();
    const { writes, readSelection } = setupRuntime('project-two', () => earlierWrite.promise);
    const editor = openEditor();
    await settleSelection();
    expect(writes.map(write => write.project)).toEqual(['project-one']);

    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
    await settleSelection();
    editor.unmount();
    await act(async () => { earlierWrite.resolve(); });

    expect(readSelection).toHaveBeenCalledOnce();
    expect(writes.map(write => write.project)).toEqual(['project-one']);
  });

  it('preserves the reopened project selection when the unmounted editor still has a pending PUT', async () => {
    const earlierWrite = deferredWrite();
    const { writes, currentProject, readSelection } = setupRuntime('project-two', async project => {
      if (project === 'project-one') await earlierWrite.promise;
    });
    const first = openEditor();
    await settleSelection();
    expect(writes.map(write => write.project)).toEqual(['project-one']);
    expect(currentProject()).toBe('project-two');
    first.unmount();

    openEditor('project-two');
    await settleSelection();
    const readsWhilePending = readSelection.mock.calls.length;
    await act(async () => { earlierWrite.resolve(); });

    expect(currentProject()).toBe('project-two');
    expect(readsWhilePending).toBe(1);
    expect(readSelection).toHaveBeenCalledTimes(2);
    expect(writes.map(write => write.project)).toEqual(['project-one', 'project-two']);
  });

  it.each(['paired relay', 'hosted door'] as const)('uses only a workspace PUT on the %s', async (route) => {
    const { writes, readSelection } = setupRuntime('project-one', undefined, route);
    openEditor();
    await settleSelection();

    expect(readSelection).not.toHaveBeenCalled();
    expect(writes).toEqual([{ project: 'project-one', scope: 'workspace', key: expect.any(String) }]);
  });
});
