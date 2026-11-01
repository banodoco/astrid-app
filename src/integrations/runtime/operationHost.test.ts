import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceClient } from './generated.ts';
import { RUNTIME_CLIENT_SCOPES, initializeWorkspaceRuntimeIdentity } from './client.ts';
import { RUNTIME_SCHEMA_DIGEST, RUNTIME_TARGETED_EXECUTION_CAPABILITY } from './contract-metadata.ts';
import { acceptedCommit } from './__tests__/timelineCommitFixture.ts';
import { RuntimeOperationHost } from './operationHost.ts';
import { setRuntimeOrigin } from './connection.ts';

vi.mock('./client.ts', async (original) => ({
  ...await original<typeof import('./client.ts')>(),
  initializeWorkspaceRuntimeIdentity: vi.fn(),
}));
const O = '/runtime-config/v1/operation';
const H = 'X-Astrid-Operation-Handle';
const launch = { actorId: 'astrid-app', realmId: 'realm', runtimeInstanceId: 'instance' };
const scope = { ...launch, projectId: 'project-commit', timelineId: 'timeline-commit' };
const commit = acceptedCommit({ revision_id: 'r2', publication_id: 'p2' }, { revision_id: 'r1', publication_id: 'p1' });
const saved = { method: 'POST', path: '/v1/projects/project-commit/timelines/timeline-commit/commit',
  body: '{ "project_id":"project-commit", "timeline_id":"timeline-commit", "note":"café 🎞" }\n', key: 'original-key' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function reply(value: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { status, ok: status >= 200 && status < 300, headers: new Headers(),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.buffer } as Response;
}
function fixture() {
  let nextHandle = 0;
  const health: Record<string, unknown> = { status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_instance_id: launch.runtimeInstanceId };
  const handshake: Record<string, unknown> = { protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
    actor_id: launch.actorId, realm_id: launch.realmId, scopes: [...RUNTIME_CLIENT_SCOPES], capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] };
  const calls: { path: string; options: RequestInit }[] = [];
  let intercept: ((path: string, options: RequestInit, response: Response) => Response | Promise<Response>) | undefined;
  let data: unknown = { task_id: 'task', items: [], next_cursor: null };
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, options: RequestInit = {}) => {
    const path = String(url);
    calls.push({ path, options });
    let response: Response;
    if (path === O) response = options.method === 'POST'
      ? reply({ schemaVersion: 1, handle: (++nextHandle).toString(16).padStart(64, '0'), identity: { ...launch } }, 201)
      : reply(null, 204);
    else if (path.endsWith('/v1/health')) response = reply(health);
    else if (path.endsWith('/v1/handshake')) response = reply(handshake);
    else if (path.endsWith('/v1/realm')) response = reply({ realm_id: launch.realmId });
    else if (path.endsWith('/commit')) response = reply(commit);
    else response = reply(data);
    return intercept ? intercept(path, options, response) : response;
  });
  const host = new RuntimeOperationHost(fetchImpl as typeof fetch);
  return { host, calls, fetchImpl, health, handshake,
    intercept(fn: typeof intercept) { intercept = fn; }, setData(value: unknown) { data = value; } };
}
const hosts: RuntimeOperationHost[] = [];
function env() { const f = fixture(); hosts.push(f.host); return f; }
beforeEach(() => { vi.mocked(initializeWorkspaceRuntimeIdentity).mockResolvedValue({ ...launch }); });
afterEach(() => { hosts.splice(0).forEach(host => host.dispose()); vi.restoreAllMocks(); });

// These exercise the real handwritten client and generated Transport with local bytes only.
describe('same-origin operation owner (inactive)', () => {
  it('uses one handle for negotiation, admission, reads and original UTF-8 transmission', async () => {
    const f = env();
    const op = await f.host.bind();
    expect(op.isCurrentIdentity(launch)).toBe(true);
    const copy = await op.getRecoverableIdentity(); copy.actorId = 'forged';
    expect(await op.getRecoverableIdentity()).toEqual({ actorId: launch.actorId, realmId: launch.realmId });
    f.setData({ data: { task_id: 'task' }, receipt: {} });
    await op.admitTask({} as Parameters<typeof op.admitTask>[0], 'admission-key');
    await op.getTask('task');
    f.setData({ items: [], next_cursor: null });
    await op.listManagedOutputs('task'); await op.getManagedOutput('association');
    await op.getProjectMediaSelection('project', { association_id: 'association', object_id: 'object', version: 1 });
    await op.getObject('object'); await op.headObject('object');
    f.setData({ items: [], next_cursor: null });
    await op.listCapabilities(); await op.listProjectObjects('project');
    f.setData({ asset: 'variant', generation_id: 'generation', variant_id: 'variant', object_id: 'object', catalog_digest: 'catalog' });
    await op.getProjectVerifiedMedia('project', { association_id: 'association', object_id: 'object', version: 1 });
    f.setData({ data: { task_id: 'task', run_id: 'run', project_id: 'project', state: 'queued' }, receipt: {} });
    await op.admitPreparedTask({ method: 'POST', path: '/v1/tasks', body: '{}', key: 'prepared-key' });
    const result = await op.transmit(scope, saved);
    expect(result.accepted).toEqual({ revisionId: 'r2', publicationId: 'p2' });
    const bound = f.calls.filter(call => call.path.startsWith(`${O}/runtime/`));
    expect(new Set(bound.map(call => new Headers(call.options.headers).get(H))).size).toBe(1);
    expect(bound.some(call => call.path.endsWith('/v1/health'))).toBe(true);
    expect(bound.some(call => call.path.endsWith('/v1/handshake'))).toBe(true);
    expect(bound.some(call => call.path.endsWith('/v1/realm'))).toBe(true);
    const sent = bound.find(call => call.path.endsWith('/commit'))!;
    expect(sent.options.body).toEqual(new TextEncoder().encode(saved.body));
    expect(new Headers(sent.options.headers).get('Idempotency-Key')).toBe(saved.key);
    for (const { options } of f.calls) {
      expect(options).toMatchObject({ cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error' });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(options.headers).has('Authorization')).toBe(false);
    }
    expect('client' in op || 'handshakeInfo' in op || 'objectContentUrl' in op).toBe(false);
  });

  it.each(['bind', 'reconnect', 'dispose', 'failed-acquire'] as const)('retires callbacks synchronously before %s', async action => {
    const f = env(); const old = await f.host.bind();
    const request = { method: 'POST', path: '/v1/tasks', body: '{}', key: 'pending' };
    old.beginTaskSubmission(request, () => {});
    expect(old.isTaskSubmissionActive(request)).toBe(true);
    if (action === 'failed-acquire') f.intercept((path, options, response) => path === O && options.method === 'POST' ? reply({}, 503) : response);
    const pending = action === 'dispose' ? Promise.resolve(f.host.dispose()) : action === 'reconnect' ? f.host.reconnect() : f.host.bind();
    expect(old.isCurrentIdentity(launch)).toBe(false);
    expect(old.isTaskSubmissionActive(request)).toBe(false);
    await expect(old.getTask('late')).rejects.toThrow(/retired/);
    if (action === 'failed-acquire') await expect(pending).rejects.toThrow(); else await pending;
    if (action === 'dispose') await expect(f.host.bind()).rejects.toThrow();
  });

  it('late acquire A after B is cleaned up and never installed', async () => {
    const f = env(); const gate = deferred<Response>(); const entered = deferred<Response>();
    let first = true;
    f.intercept((path, options, response) => {
      if (path === O && options.method === 'POST' && first) { first = false; entered.resolve(response); return gate.promise; }
      return response;
    });
    const a = f.host.bind(); const caught = a.catch(error => error);
    const original = await entered.promise;
    const b = await f.host.bind();
    gate.resolve(original);
    expect(await caught).toBeInstanceOf(Error);
    expect(b.isCurrentIdentity(launch)).toBe(true);
    expect(f.calls.filter(call => call.options.method === 'DELETE').map(call => new Headers(call.options.headers).get(H)))
      .toContain('1'.padStart(64, '0'));
  });

  it.each(['/v1/health', '/v1/handshake', '/v1/realm', '/v1/tasks/task', '/commit'])('fences fetch and body awaits at %s', async suffix => {
    for (const stage of ['fetch', 'body'] as const) {
      const f = env(); const op = suffix.startsWith('/v1/tasks') || suffix === '/commit' ? await f.host.bind() : undefined;
      const gate = deferred<Response>(); const bodyGate = deferred<ArrayBuffer>(); const entered = deferred<Response>();
      f.intercept((path, _options, response) => {
        if (!path.endsWith(suffix)) return response;
        entered.resolve(response);
        return stage === 'fetch' ? gate.promise : { ...response, arrayBuffer: () => bodyGate.promise } as Response;
      });
      const pending = op ? suffix === '/commit' ? op.transmit(scope, saved) : op.getTask('task') : f.host.bind();
      const caught = pending.catch(error => error);
      const response = await entered.promise;
      f.host.dispose();
      gate.resolve(response); bodyGate.resolve(await response.arrayBuffer());
      expect(await caught).toBeInstanceOf(Error);
      if (op) expect(op.isCurrentIdentity(launch)).toBe(false);
      const requests = f.calls.filter(call => call.path.startsWith(`${O}/runtime`));
      expect(requests.find(call => call.path.endsWith(suffix))?.options.signal?.aborted).toBe(true);
      if (suffix === '/v1/health') expect(requests.some(call => call.path.endsWith('/v1/realm'))).toBe(false);
    }
  });

  it.each(['/v1/health', '/v1/handshake', '/v1/realm'])('fences promise propagation microtasks after %s', async suffix => {
    for (let tick = 0; tick < 14; tick++) {
      const f = env(); const reached = deferred<void>();
      f.intercept((path, _options, response) => {
        if (!path.endsWith(suffix)) return response;
        return { ...response, arrayBuffer: async () => { const bytes = await response.arrayBuffer(); reached.resolve(); return bytes; } } as Response;
      });
      const pending = f.host.bind(); const caught = pending.catch(error => error);
      await reached.promise;
      for (let count = 0; count < tick; count++) await Promise.resolve();
      f.host.dispose();
      const result = await caught;
      if (!(result instanceof Error)) expect(result.isCurrentIdentity(launch)).toBe(false);
      const count = f.calls.length;
      await Promise.resolve(); await Promise.resolve();
      expect(f.calls.length).toBe(count);
    }
  });

  it.each([
    ['actor_id', 7], ['realm_id', []], ['schema_digest', 3], ['protocol', null],
    ['scopes', RUNTIME_CLIENT_SCOPES.join(',')], ['scopes', [...RUNTIME_CLIENT_SCOPES, 'admin']],
    ['scopes', [...RUNTIME_CLIENT_SCOPES.slice(1), RUNTIME_CLIENT_SCOPES[1]]],
    ['capabilities', `prefix-${RUNTIME_TARGETED_EXECUTION_CAPABILITY}-suffix`],
    ['capabilities', []], ['actor_id', 'owner'],
  ])('rejects malformed handshake %s=%j before realm dispatch', async (field, value) => {
    const f = env(); f.handshake[field] = value;
    await expect(f.host.bind()).rejects.toThrow();
    expect(f.calls.some(call => call.path.endsWith('/v1/realm'))).toBe(false);
  });

  it.each(['protocol', 'schema_digest', 'runtime_instance_id', 'status'])('rejects malformed health %s', async field => {
    const f = env(); f.health[field] = 3;
    await expect(f.host.bind()).rejects.toThrow();
    expect(f.calls.some(call => call.path.endsWith('/v1/realm'))).toBe(false);
  });

  it('does not adopt the public mutable handshake alias during a realm await', async () => {
    const f = env(); const gate = deferred<Response>(); const entered = deferred<Response>();
    let alias: Awaited<ReturnType<WorkspaceClient['handshake']>> | undefined;
    const original = WorkspaceClient.prototype.handshake;
    vi.spyOn(WorkspaceClient.prototype, 'handshake').mockImplementation(async function (...args) {
      alias = await original.apply(this, args); return alias;
    });
    f.intercept((path, _options, response) => { if (path.endsWith('/v1/realm')) { entered.resolve(response); return gate.promise; } return response; });
    const pending = f.host.bind(); const response = await entered.promise;
    alias!.actor_id = 'forged'; alias!.scopes.length = 0; alias!.schema_digest = 'forged';
    gate.resolve(response);
    const result = await pending;
    expect(result.isCurrentIdentity({ actorId: 'forged', realmId: launch.realmId })).toBe(false);
    expect(await result.getRecoverableIdentity()).toEqual({ actorId: launch.actorId, realmId: launch.realmId });
  });

  it('captures authority before the public handshake setter can mutate it', async () => {
    const f = env();
    const original = WorkspaceClient.prototype.handshake;
    vi.spyOn(WorkspaceClient.prototype, 'handshake').mockImplementation(function (...args) {
      Object.defineProperty(this, 'handshakeInfo', { configurable: true, set(value) { value.actor_id = 'forged'; value.scopes = []; } });
      return original.apply(this, args);
    });
    await expect(f.host.bind()).rejects.toThrow();
    expect(f.calls.some(call => call.path.endsWith('/v1/realm'))).toBe(false);
  });

  it('keeps a late A ACK retired while B retries exactly under equal identity', async () => {
    const f = env(); const a = await f.host.bind(); const gate = deferred<Response>(); const entered = deferred<Response>();
    let first = true;
    f.intercept((path, _options, response) => { if (path.endsWith('/commit') && first) { first = false; entered.resolve(response); return gate.promise; } return response; });
    const pending = a.transmit(scope, saved); const caught = pending.catch(error => error);
    const ack = await entered.promise;
    const b = await f.host.bind(); gate.resolve(ack);
    expect(await caught).toBeInstanceOf(Error);
    expect((await b.transmit(scope, saved)).accepted.publicationId).toBe('p2');
    const sends = f.calls.filter(call => call.path.endsWith('/commit'));
    expect(sends).toHaveLength(2);
    expect(sends[0].options.body).toEqual(sends[1].options.body);
    expect(new Headers(sends[0].options.headers).get('Idempotency-Key')).toBe(new Headers(sends[1].options.headers).get('Idempotency-Key'));
    expect(new Headers(sends[0].options.headers).get(H)).not.toBe(new Headers(sends[1].options.headers).get(H));
    expect(a.isCurrentIdentity(launch)).toBe(false); expect(b.isCurrentIdentity(launch)).toBe(true);
  });

  it('rejects a new acquire instance instead of using it as its own launch expectation', async () => {
    const f = env(); await f.host.bind();
    f.intercept((path, options, response) => path === O && options.method === 'POST'
      ? reply({ schemaVersion: 1, handle: 'a'.repeat(64), identity: { ...launch, runtimeInstanceId: 'replacement' } }, 201) : response);
    await expect(f.host.bind()).rejects.toThrow(/launch/);
    expect(f.calls.filter(call => call.path.endsWith('/v1/handshake'))).toHaveLength(1);
  });

  it('refuses absent launch policy before acquire', async () => {
    const f = env(); vi.mocked(initializeWorkspaceRuntimeIdentity).mockResolvedValue(undefined);
    await expect(f.host.bind()).rejects.toThrow(/launch identity/); expect(f.calls).toHaveLength(0);
  });

  it.each([401, 403, 410, 503])('retires on received %s and preserves unknown-outcome classification', async status => {
    const f = env(); const op = await f.host.bind();
    f.intercept((path, _options, response) => path.endsWith('/commit') ? reply({}, status) : response);
    const error = await op.transmit(scope, saved).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect('status' in error).toBe(false);
    expect(op.isCurrentIdentity(launch)).toBe(false);
  });

  it.each([409, 422])('keeps semantic %s errors and a live binding for ordinary classification', async status => {
    const f = env(); const op = await f.host.bind();
    f.intercept((path, _options, response) => path.endsWith('/commit') ? reply({ code: 'conflict', details: { status: 'conflict' } }, status) : response);
    await expect(op.transmit(scope, saved)).rejects.toMatchObject({ status, details: { status: 'conflict' } });
    expect(op.isCurrentIdentity(launch)).toBe(true);
  });

  it.each([{}, { items: [] }, { items: null, next_cursor: null }])('refuses missing/malformed managed output pages %j', async value => {
    const f = env(); const op = await f.host.bind(); f.setData(value);
    await expect(op.listManagedOutputs('task')).rejects.toThrow(/invalid page/);
    expect(op.isCurrentIdentity(launch)).toBe(false);
  });

  it.each([{ data: { status: 'preview' }, receipt: null }, {}, { ...commit, receipt: {} }])('never treats an invalid acceptance as ACK', async value => {
    const f = env(); const op = await f.host.bind();
    f.intercept((path, _options, response) => path.endsWith('/commit') ? reply(value) : response);
    await expect(op.transmit(scope, saved)).rejects.toThrow();
    expect(op.isCurrentIdentity(launch)).toBe(false);
  });

  it.each([
    { ...saved, method: 'GET' }, { ...saved, path: '/v1/projects/other/timelines/timeline-commit/commit' },
    { ...saved, body: '{"project_id":"other","timeline_id":"timeline-commit"}' },
  ])('does not dispatch a saved request outside its original scope', async request => {
    const f = env(); const op = await f.host.bind(); const before = f.calls.length;
    await expect(op.transmit(scope, request)).rejects.toThrow();
    expect(f.calls.slice(before).every(call => call.options.method === 'DELETE')).toBe(true);
  });

  it('does not acquire after retirement during the launch-policy await', async () => {
    const f = env(); const gate = deferred<typeof launch>();
    vi.mocked(initializeWorkspaceRuntimeIdentity).mockReturnValue(gate.promise);
    const pending = f.host.bind(); const caught = pending.catch(error => error);
    f.host.dispose(); gate.resolve({ ...launch });
    expect(await caught).toBeInstanceOf(Error); expect(f.calls).toHaveLength(0);
  });

  it('cleans a late acquire body after disposal without negotiating', async () => {
    const f = env(); const gate = deferred<unknown>(); const entered = deferred<void>();
    f.intercept((path, options, response) => path === O && options.method === 'POST'
      ? { ...response, json: () => { entered.resolve(); return gate.promise; } } as Response : response);
    const pending = f.host.bind(); const caught = pending.catch(error => error);
    await entered.promise; f.host.dispose();
    gate.resolve({ schemaVersion: 1, handle: 'a'.repeat(64), identity: { ...launch } });
    expect(await caught).toBeInstanceOf(Error);
    expect(f.calls.filter(call => call.options.method === 'DELETE')).toHaveLength(1);
    expect(f.calls.some(call => call.path.startsWith(`${O}/runtime`))).toBe(false);
  });

  it.each(['admit', 'transmit'])('pre-write health retirement prevents actual %s dispatch', async method => {
    const f = env(); const op = await f.host.bind(); const gate = deferred<Response>(); const entered = deferred<Response>();
    f.intercept((path, _options, response) => { if (path.endsWith('/v1/health')) { entered.resolve(response); return gate.promise; } return response; });
    const pending = method === 'transmit' ? op.transmit(scope, saved) : op.admitTask({} as Parameters<typeof op.admitTask>[0], 'key');
    const caught = pending.catch(error => error); const response = await entered.promise;
    f.host.dispose(); gate.resolve(response);
    expect(await caught).toBeInstanceOf(Error);
    expect(f.calls.some(call => call.path.endsWith('/commit') || call.path.endsWith('/v1/tasks'))).toBe(false);
  });

  it('copies saved scope and exact request before its first await', async () => {
    const f = env(); const op = await f.host.bind(); const gate = deferred<Response>(); const entered = deferred<Response>();
    f.intercept((path, _options, response) => { if (path.endsWith('/v1/health')) { entered.resolve(response); return gate.promise; } return response; });
    const request = { ...saved }; const selected = { ...scope };
    const pending = op.transmit(selected, request); const health = await entered.promise;
    request.body = '{}'; request.key = 'changed'; request.path = '/v1/other'; selected.actorId = 'forged'; selected.projectId = 'other';
    gate.resolve(health); expect((await pending).accepted.publicationId).toBe('p2');
    const sent = f.calls.find(call => call.path.endsWith('/commit'))!;
    expect(sent.options.body).toEqual(new TextEncoder().encode(saved.body));
    expect(new Headers(sent.options.headers).get('Idempotency-Key')).toBe(saved.key);
  });

  it('checks retirement before recovery identity publication', async () => {
    const f = env(); const op = await f.host.bind();
    const identity = op.getRecoverableIdentity(); f.host.dispose();
    await expect(identity).rejects.toThrow(/retired/);
  });

  it.each(['fetch', 'body'])('retires on %s failure without reviving callbacks', async stage => {
    const f = env(); const op = await f.host.bind();
    f.intercept((path, _options, response) => {
      if (!path.endsWith('/v1/tasks/task')) return response;
      if (stage === 'fetch') throw new Error('connection lost');
      return { ...response, arrayBuffer: async () => { throw new Error('body lost'); } } as Response;
    });
    await expect(op.getTask('task')).rejects.toThrow();
    expect(op.isCurrentIdentity(launch)).toBe(false);
    await expect(op.getTask('task')).rejects.toThrow(/retired/);
  });

  it('refuses a malformed realm identity', async () => {
    const f = env(); f.intercept((path, _options, response) => path.endsWith('/v1/realm') ? reply({ realm_id: 3 }) : response);
    await expect(f.host.bind()).rejects.toThrow();
  });

  it('checks instance on exact transmission even after a successful negotiation', async () => {
    const f = env(); const op = await f.host.bind(); f.health.runtime_instance_id = 'replacement';
    await expect(op.transmit(scope, saved)).rejects.toThrow(/relaunch/);
    expect(f.calls.some(call => call.path.endsWith('/commit'))).toBe(false);
    expect(op.isCurrentIdentity(launch)).toBe(false);
  });

  it('refuses hosted transport before acquisition', async () => {
    // Last test: connection configuration is intentionally immutable for the page.
    setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: 'http://127.0.0.1:17340' });
    const f = env(); await expect(f.host.bind()).rejects.toThrow(/same-origin/);
    expect(f.calls).toHaveLength(0);
  });
});
