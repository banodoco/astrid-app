// @vitest-environment-options {"url":"https://astrid.haus/tools/video-editor"}
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { classifyBrowserEntry } from '@/app/entryClassification.ts';
import { RUNTIME_CLIENT_SCOPES } from '@/integrations/runtime/client.ts';
import { setRuntimeOrigin } from '@/integrations/runtime/connection.ts';
import { SLOW_PROBE_TIMEOUT_MS } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { RUNTIME_SCHEMA_DIGEST, RUNTIME_TARGETED_EXECUTION_CAPABILITY } from '@/integrations/runtime/contract-metadata.ts';
import type { Health, Handshake, MutationReceipt, Project, Realm } from '@/integrations/runtime/generated.ts';
import { WelcomeFlow } from './WelcomeFlow.tsx';
import { PENDING_STARTER_PROJECT_KEY } from './StarterProjectHandoff.tsx';
import { entryFor, readWelcomePhase, writeWelcomePhase } from './welcomeProgress.ts';

// One mounted journey keeps the mode chooser, permission/reachability gate, project handoff,
// Runtime client negotiation and canonical timeline creation real. Only the browser permission
// service, Runtime HTTP door and document navigation are simulated. The 3D tour is not mounted;
// BrowserTourEditor.integration.test.tsx covers that renderer separately.
const GATEWAY = 'http://127.0.0.1:17340';
const REALM = 'onboarding-journey-realm';
const PROJECT = 'onboarding-journey-project';
const NOW = '2026-10-01T00:00:00Z';
const navigate = vi.fn();
const replaceNavigate = vi.fn();
const permission = {
  state: 'prompt',
  onchange: null as ((this: unknown, event: Event) => unknown) | null,
};
const permissions = { query: vi.fn(async () => permission) };

function changePermission(state: 'prompt' | 'denied' | 'granted') {
  permission.state = state;
  permission.onchange?.call(permission, new Event('change'));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function committed(data: unknown, commandKind: string, key: string | null) {
  const receipt: MutationReceipt = { receipt_id: `${commandKind}-committed`, command_kind: commandKind,
    idempotency_key: key!, request_hash: '0'.repeat(64), project_id: PROJECT,
    project_seq: [1, 1], event_ids: ['journey-event'], result: data, created_at: NOW };
  return { data, receipt };
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  const body = init?.body;
  return JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array));
}

function runtimeDoor({ unavailable = false, failDiscovery = false } = {}) {
  let project: Project | null = null;
  let timeline: Record<string, unknown> | null = null;
  let allowPrompt = false;
  const requests: { method: string; path: string; body?: Record<string, unknown>; key: string | null }[] = [];
  const unexpected: string[] = [];
  const fetchDoor = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/runtime', '');
    const body = init?.body ? bodyOf(init) : undefined;
    const key = new Headers(init?.headers).get('Idempotency-Key');
    requests.push({ method, path, body, key });
    if (url.origin !== GATEWAY || !url.pathname.startsWith('/api/runtime/v1/')) {
      unexpected.push(`${method} ${url.href}`);
      throw new Error(`Unexpected request: ${method} ${url.href}`);
    }
    if (path === '/v1/health') {
      if (permission.state === 'prompt') {
        changePermission(allowPrompt ? 'granted' : 'denied');
        if (!allowPrompt) throw new TypeError('Failed to fetch');
      }
      if (unavailable) return json({ error: 'runtime_unavailable' }, 503);
      return json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
        runtime_epoch: 1, runtime_session_id: 'journey-runtime-session', runtime_instance_id: 'onboarding-journey-instance' } satisfies Health);
    }
    if (path === '/v1/handshake' && method === 'POST') {
      expect(body).toMatchObject({ protocol: 'workspace.v1', client_name: 'astrid-browser', requested_scopes: RUNTIME_CLIENT_SCOPES });
      return json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
        session_id: 'journey-session', actor_id: 'astrid-product', realm_id: REALM,
        scopes: [...RUNTIME_CLIENT_SCOPES], capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] } satisfies Handshake);
    }
    if (path === '/v1/realm') return json({ realm_id: REALM, display_name: 'My computer', version: 1, created_at: NOW } satisfies Realm);
    if (path === '/v1/projects' && method === 'GET') {
      if (failDiscovery) return json({ code: 'service_unavailable', message: 'Project index unavailable', request_id: 'journey-failure' }, 503);
      return json({ items: project ? [project] : [], next_cursor: null });
    }
    if (path === '/v1/projects' && method === 'POST') {
      project = { project_id: PROJECT, realm_id: REALM, slug: String(body?.slug), name: String(body?.name),
        metadata: body?.metadata as Record<string, unknown>, version: 1, created_at: NOW, updated_at: NOW };
      return json(committed(project, 'project.create', key), 201);
    }
    if (path === `/v1/projects/${PROJECT}` && method === 'GET') return json(project);
    if (path === `/v1/projects/${PROJECT}` && method === 'PATCH' && project) {
      project = { ...project, metadata: body?.metadata as Record<string, unknown>, version: project.version + 1 };
      return json(project);
    }
    if (path === `/v1/projects/${PROJECT}/timelines` && method === 'GET') return json({ items: timeline ? [timeline] : [], next_cursor: null });
    if (path === `/v1/projects/${PROJECT}/timelines` && method === 'POST') {
      timeline = { timeline_id: body?.timeline_id, project_id: PROJECT, slug: 'main', name: body?.name ?? 'Main', head_revision_id: 'journey-head', archived: false };
      return json(committed(timeline, 'timeline.create', key), 201);
    }
    if (path.startsWith(`/v1/projects/${PROJECT}/timelines/`) && path.endsWith('/composition-revisions') && method === 'POST') {
      timeline = { timeline_id: body?.timeline_id, project_id: PROJECT, slug: 'main', name: 'Main',
        head_revision_id: body?.parent_revision_id, archived: false };
      return json(committed(timeline, 'composition.publish', key));
    }
    unexpected.push(`${method} ${url.href}`);
    throw new Error(`Unexpected Runtime request: ${method} ${url.href}`);
  });
  vi.stubGlobal('fetch', fetchDoor);
  return { requests, unexpected, acceptNextPrompt: () => { allowPrompt = true; },
    get project() { return project; }, get timeline() { return timeline; } };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  writeWelcomePhase(null);
  navigate.mockReset();
  replaceNavigate.mockReset();
  permissions.query.mockClear();
  permission.state = 'prompt';
  permission.onchange = null;
  setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: GATEWAY });
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Chrome/141.0.0.0 Safari/537.36');
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: permissions });
  // jsdom cannot navigate documents and its Location methods are unforgeable. Keep the real
  // window/document/events, replacing only the navigation boundary the handoff calls.
  const browserWindow = window;
  const location = { href: browserWindow.location.href, origin: browserWindow.location.origin,
    pathname: browserWindow.location.pathname, search: '', hash: '', assign: navigate, replace: replaceNavigate };
  vi.stubGlobal('window', new Proxy(browserWindow, { get(target, property) {
    if (property === 'location') return location;
    const value = Reflect.get(target, property, target);
    return ['addEventListener', 'removeEventListener', 'dispatchEvent'].includes(String(property))
      ? value.bind(target) : value;
  } }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  writeWelcomePhase(null);
});

function chooseHosted() {
  render(<WelcomeFlow entry="choose" />);
  expect(screen.getByRole('radio', { name: 'Use the hosted version' })).toBeChecked();
  expect(fetch).not.toHaveBeenCalled();
  expect(permissions.query).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Continue in this tab' }));
  expect(screen.getByRole('main', { name: 'Set up Astrid' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Astrid' }));
}

function destination() {
  expect(replaceNavigate).toHaveBeenCalledOnce();
  return new URL(replaceNavigate.mock.calls[0][0] as string, window.location.origin);
}

it('recovers from hosted permission denial, creates a real canonical starter timeline, and hands its selection to normal editor entry', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const door = runtimeDoor();
  chooseHosted();
  expect(await screen.findByRole('heading', { name: 'Allow Astrid in Chrome' })).toBeInTheDocument();
  expect(permission.state).toBe('denied');
  expect(door.requests.map(request => request.path)).toEqual(['/v1/health']);
  expect(screen.queryByRole('main', { name: 'Opening your project' })).not.toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
  expect(readWelcomePhase()).toBe('connection');

  door.acceptNextPrompt();
  act(() => changePermission('prompt'));
  await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_PROBE_TIMEOUT_MS); });
  fireEvent.focus(window);
  expect(door.requests.map(request => request.path)).toEqual(['/v1/health']);
  expect(screen.queryByRole('main', { name: 'Opening your project' })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(replaceNavigate).toHaveBeenCalledOnce(), { timeout: 10_000 });

  const url = destination();
  expect(url.pathname).toBe('/tools/video-editor');
  expect(url.searchParams.get('project')).toBe(PROJECT);
  expect(url.searchParams.get('timeline')).toBe(door.timeline?.timeline_id);
  expect(entryFor(url, readWelcomePhase())).toBe('editor');
  expect(classifyBrowserEntry(url)).toBe('app');
  expect(readWelcomePhase()).toBe('complete');
  expect(localStorage.getItem(PENDING_STARTER_PROJECT_KEY)).toBeNull();
  const create = door.requests.filter(request => request.path === '/v1/projects' && request.method === 'POST');
  expect(create).toHaveLength(1);
  const intent = door.project?.metadata.astrid_onboarding_intent;
  expect(intent).toMatch(/^[a-f0-9-]{36}$/);
  expect(create[0].key).toBe(`astrid-onboarding-project-${intent}`);
  const timelineCreate = door.requests.filter(request => request.path === `/v1/projects/${PROJECT}/timelines` && request.method === 'POST');
  expect(timelineCreate).toHaveLength(1);
  expect(timelineCreate[0].body?.timeline_id).toBe(door.timeline?.timeline_id);
  expect(timelineCreate[0].key).toBe(`astrid-first-timeline-${PROJECT}`);
  expect(door.timeline?.head_revision_id).toBe('journey-head');
  expect(door.project?.metadata.default_timeline_id).toBe(url.searchParams.get('timeline'));
  expect(door.timeline?.head_revision_id).toBeTruthy();
  expect(door.unexpected).toEqual([]);
});

it('keeps an absent Runtime in setup, and Back returns to the real chooser so local setup remains available', async () => {
  permission.state = 'granted';
  const door = runtimeDoor({ unavailable: true });
  chooseHosted();
  await waitFor(() => expect(door.requests).toHaveLength(1));
  // A second independent reading confirms absence without waiting for the polling interval.
  fireEvent.focus(window);
  expect(await screen.findByRole('heading', { name: "Astrid isn't answering on this computer" })).toBeInTheDocument();
  expect(door.requests.every(request => request.path === '/v1/health')).toBe(true);
  expect(screen.queryByRole('main', { name: 'Opening your project' })).not.toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
  expect(readWelcomePhase()).toBe('connection');

  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(await screen.findByRole('heading', { name: 'How do you want to run the app?' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Use the hosted version' })).toBeChecked();
  expect(readWelcomePhase()).toBe('choose');
  expect(permission.onchange).toBeNull();
  const readsBeforeLocalSetup = door.requests.length;
  fireEvent.click(screen.getByRole('radio', { name: 'Run app on your computer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Set up with your agent' }));
  expect(await screen.findByRole('heading', { name: 'Have your agent set it up' })).toBeInTheDocument();
  expect(readWelcomePhase()).toBe('setup');
  expect(door.requests).toHaveLength(readsBeforeLocalSetup);
  expect(navigate).not.toHaveBeenCalled();
  expect(door.unexpected).toEqual([]);
});

it('offers Open editor after real project discovery fails, with a reload-safe editor entry when browser storage is unavailable', async () => {
  permission.state = 'granted';
  const door = runtimeDoor({ failDiscovery: true });
  for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError'); });
  }
  chooseHosted();
  expect(await screen.findByRole('heading', { name: "Couldn't open your project" })).toBeInTheDocument();
  expect(door.requests.some(request => request.path === '/v1/handshake')).toBe(true);
  expect(door.requests.some(request => request.path === '/v1/projects' && request.method === 'GET')).toBe(true);
  expect(door.requests.some(request => request.path === '/v1/projects' && request.method === 'POST')).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open editor' }));

  const url = destination();
  expect(url.searchParams.get('entry')).toBe('editor');
  expect(url.searchParams.has('project')).toBe(false);
  expect(url.searchParams.has('timeline')).toBe(false);
  // A new document cannot read this visit's in-memory welcome phase.
  expect(entryFor(url, readWelcomePhase())).toBe('editor');
  expect(classifyBrowserEntry(url)).toBe('app');
  expect(door.unexpected).toEqual([]);
});
