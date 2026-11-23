import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '@/integrations/runtime/generated.ts';
import { json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { FAKE_RUNTIME_ACTOR_ID, FAKE_RUNTIME_REALM_ID } from '@/test/fakeRuntimeIdentity.mjs';
import VideoEditorPage from './VideoEditorPage.tsx';

const runtime = vi.hoisted(() => ({ transport: vi.fn<Transport>() }));

vi.mock('@/integrations/runtime/client.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/integrations/runtime/client.ts')>();
  return {
    ...original,
    AstridRuntimeClient: class extends original.AstridRuntimeClient {
      constructor() { super({ baseUrl: 'http://runtime.test', transport: runtime.transport }); }
    },
  };
});
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

function setupRuntime(initialProject: string | null = null) {
  const fixture = runtimeFixture();
  let selectedProject = initialProject;
  const writes: Array<{ project: string; scope: string; key: string | undefined }> = [];
  const readSelection = vi.fn(async () => selectedProject
    ? response(200, workspaceSelection(selectedProject))
    : response(404, { code: 'not_found', message: 'no project is selected' }));
  runtime.transport.mockImplementation(async (method, path, headers, body) => {
    if (path !== SELECTION_ROUTE) return fixture.transport(method, path, headers, body);
    if (method === 'GET') return readSelection();
    if (method !== 'PUT') throw new Error(`Unexpected selection method ${method}`);
    const request = JSON.parse(new TextDecoder().decode(body as Uint8Array));
    selectedProject = request.project;
    writes.push({ ...request, key: headers['Idempotency-Key'] });
    return response(200, { data: workspaceSelection(request.project), receipt: {} });
  });
  return { writes, readSelection };
}

function ProjectSwitch() {
  const [, setParams] = useSearchParams();
  return <button onClick={() => setParams({ project: 'project-two', timeline: 'timeline-one' })}>Switch project</button>;
}

function openEditor() {
  const view = render(
    <MemoryRouter initialEntries={['/tools/video-editor?project=project-one&timeline=timeline-one']}
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

describe('VideoEditorPage workspace project selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    ['an unsupported read', response(405, { code: 'method_not_allowed' })],
  ])('writes the workspace selection after %s', async (_name, selection) => {
    const { writes, readSelection } = setupRuntime();
    readSelection.mockResolvedValueOnce(selection);
    openEditor();
    await settleSelection();
    expect(writes).toEqual([{ project: 'project-one', scope: 'workspace', key: expect.any(String) }]);
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
});
