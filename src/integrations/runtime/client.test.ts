import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Transport } from './generated.ts';
import { AstridRuntimeClient, RuntimeCompatibilityError, isRuntimeCanonicalPayloadConflict, isRuntimeConflict, type ObservedRuntimeIdentities } from './client.ts';
import { ApiError } from './generated.ts';
import {
  RUNTIME_ACCEPTED_SCHEMA_DIGESTS,
  RUNTIME_SCHEMA_DIGEST,
  RUNTIME_TARGETED_EXECUTION_CAPABILITY,
} from './contract-metadata.ts';

const PROJECT_ID = 'project/r2';
const CAPABILITY_ID = 'astrid.image_generation';
const CAPABILITY_DIGEST = `sha256:${'a'.repeat(64)}`;
const INPUT_OBJECT_ID = `sha256:${'1'.repeat(64)}`;
const MEDIA_OBJECT_ID = 'object-r4-media';
const MEDIA_OBJECT_DIGEST = `sha256:${'c'.repeat(64)}`;
const MANAGED_OUTPUT_ASSOCIATION_ID = 'managed-output-r3';
const MANAGED_OUTPUT_OBJECT_ID = `sha256:${'d'.repeat(64)}`;
const EXPECTED_IDENTITY = {
  actorId: 'astrid-product-r3',
  realmId: 'realm-r2',
  runtimeInstanceId: 'runtime-instance-r2',
};

const exactGenTaskInput = {
  project: PROJECT_ID,
  capability_id: CAPABILITY_ID,
  capability_digest: CAPABILITY_DIGEST,
  schema_version: '1' as const,
  input_object_ids: [INPUT_OBJECT_ID],
  spec: {
    family: 'image_generation',
    params: { prompt: 'a lighthouse' },
    output_policy: {},
  },
  storage_estimate: { scratch_bytes: 0, output_bytes: 0 },
  generation_intent: {
    version: 1,
    modality: 'video',
    partial_success_policy: 'allow',
    groups: [
      {
        group_key: 'main',
        selectors: [
          { selector: 'video', ordinal: 0, variant_key: 'original' },
        ],
      },
    ],
  },
  settlement_effect: {},
};

const generation = {
  generation_id: 'generation-r2',
  project_id: PROJECT_ID,
  source_task_id: 'task-r3',
  type: 'image',
  status: 'created',
  metadata: { tool_type: 'image-gen' },
  version: 4,
  created_at: '2026-09-11T00:00:00Z',
  updated_at: '2026-09-11T00:01:00Z',
};

const variant = {
  variant_id: 'variant-r2',
  generation_id: generation.generation_id,
  object_id: `sha256:${'2'.repeat(64)}`,
  variant_type: 'original',
  metadata: { is_primary: true },
  created_at: '2026-09-11T00:00:30Z',
};

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function receipt(commandKind: string, key: string, projectId = PROJECT_ID) {
  return {
    receipt_id: `${commandKind}:${key}`,
    command_kind: commandKind,
    idempotency_key: key,
    request_hash: `sha256:${'b'.repeat(64)}`,
    project_id: projectId,
    project_seq: [1, 1],
    event_ids: [],
    result: {},
    created_at: '2026-09-11T00:00:00Z',
  };
}

function createTransport(options: {
  revokeFirstMediaRead?: boolean;
  schemaDigest?: string;
  capabilities?: string[];
  actorId?: string;
  realmId?: string;
  runtimeInstanceId?: string;
  scopes?: string[];
  realmResponseId?: string;
} = {}) {
  const schemaDigest = options.schemaDigest ?? RUNTIME_SCHEMA_DIGEST;
  const capabilities = options.capabilities ?? [RUNTIME_TARGETED_EXECUTION_CAPABILITY];
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
  let mediaReads = 0;
  const task = {
    task_id: 'task-r3',
    run_id: 'run-r3',
    project_id: PROJECT_ID,
    state: 'queued' as 'queued' | 'cancelled' | 'retrying',
    version: 1,
    capability_id: CAPABILITY_ID,
    capability_digest: CAPABILITY_DIGEST,
    idempotency_key: 'astrid.admit:r3',
    created_at: '2026-09-11T00:00:00Z',
    updated_at: '2026-09-11T00:00:00Z',
    attempt_id: null,
    runtime_epoch: 7,
    input_object_ids: [INPUT_OBJECT_ID],
    spec: exactGenTaskInput.spec,
    generation_intent: exactGenTaskInput.generation_intent,
    result: null,
  };

  const transport: Transport = async (method, path, headers, body) => {
    if (body !== undefined && !types.isUint8Array(body)) {
      throw new Error('JSON fixture expected a Uint8Array request body');
    }
    const parsedBody = body === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(
        new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      )) as Record<string, unknown>;
    requests.push({ method, path, headers, ...(parsedBody ? { body: parsedBody } : {}) });

    if (path === '/v1/health') {
      return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: schemaDigest, runtime_epoch: 7, runtime_instance_id: options.runtimeInstanceId ?? EXPECTED_IDENTITY.runtimeInstanceId }) };
    }
    if (path === '/v1/handshake') {
      return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: schemaDigest, session_id: 'session-r2-r3', actor_id: options.actorId ?? EXPECTED_IDENTITY.actorId, realm_id: options.realmId ?? EXPECTED_IDENTITY.realmId, scopes: options.scopes ?? ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'], capabilities }) };
    }
    if (path === '/v1/realm') {
      return { status: 200, headers: {}, body: json({ realm_id: options.realmResponseId ?? EXPECTED_IDENTITY.realmId, display_name: 'R2/R3 fixture', version: 1, created_at: '2026-09-11T00:00:00Z' }) };
    }
    if (path === '/v1/capabilities?limit=50') {
      return {
        status: 200,
        headers: {},
        body: json({
          items: [{
            capability_id: CAPABILITY_ID,
            definition_digest: CAPABILITY_DIGEST,
            status: 'ready',
            required_resource_keys: [],
            estimated_scratch_bytes: 0,
            estimated_output_bytes: 0,
          }],
          next_cursor: null,
        }),
      };
    }
    if (path === `/v1/projects/${encodeURIComponent(PROJECT_ID)}/generations?limit=2&cursor=generations-7`) {
      return { status: 200, headers: {}, body: json({ items: [generation], next_cursor: 'generations-8' }) };
    }
    if (path === `/v1/generations/${generation.generation_id}/variants?limit=2&cursor=variants-3`) {
      return { status: 200, headers: {}, body: json({ items: [variant], next_cursor: 'variants-4' }) };
    }
    if (path === `/v1/objects/${MEDIA_OBJECT_ID}` && (method === 'GET' || method === 'HEAD')) {
      if (options.revokeFirstMediaRead && mediaReads++ === 0) {
        return { status: 401, headers: {}, body: json({ code: 'unauthorized', message: 'credential revoked' }) };
      }
      const ranged = headers.Range !== undefined;
      return {
        status: ranged ? 206 : 200,
        headers: {
          ETag: `"${MEDIA_OBJECT_DIGEST}"`,
          'Accept-Ranges': 'bytes',
          ...(ranged ? { 'Content-Range': 'bytes 0-3/4' } : {}),
        },
        body: method === 'HEAD' ? new Uint8Array() : new Uint8Array([1, 2, 3, 4]),
      };
    }
    if (method === 'POST' && path === '/v1/tasks') {
      expect(headers['Idempotency-Key']).toBe('astrid.admit:r3');
      expect(parsedBody).toEqual(exactGenTaskInput);
      return { status: 201, headers: {}, body: json({ data: task, receipt: receipt('task.create', 'astrid.admit:r3') }) };
    }
    if (method === 'GET' && path === '/v1/tasks/task-r3') {
      return { status: 200, headers: {}, body: json(task) };
    }
    if (method === 'GET' && path === `/v1/projects/${encodeURIComponent(PROJECT_ID)}/tasks?limit=1&cursor=tasks-2`) {
      return { status: 200, headers: {}, body: json({ items: [task], next_cursor: 'tasks-3' }) };
    }
    if (method === 'POST' && path === `/v1/managed-outputs/${MANAGED_OUTPUT_ASSOCIATION_ID}/export`) {
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Idempotency-Key']).toBeTruthy();
      expect(parsedBody).toEqual({
        destination_filename: 'retained-output.mp4',
        expected: {
          project_id: PROJECT_ID,
          run_id: 'run-r3',
          task_id: 'task-r3',
          attempt_id: 'attempt-r3',
          association_id: MANAGED_OUTPUT_ASSOCIATION_ID,
          output_port: 'video',
          role: 'output',
          object_id: MANAGED_OUTPUT_OBJECT_ID,
          digest: MANAGED_OUTPUT_OBJECT_ID,
          size: 4,
          filename: 'retained-output.mp4',
          media_type: 'video/mp4',
          executor_id: 'executor-r3',
          lease_id: 'lease-r3',
          fence: 6,
          runtime_epoch: 7,
        },
      });
      return {
        status: 200,
        headers: {},
        body: json({
          data: {
            export_id: 'export-r3',
            association_id: MANAGED_OUTPUT_ASSOCIATION_ID,
            project_id: PROJECT_ID,
            run_id: 'run-r3',
            task_id: 'task-r3',
            attempt_id: 'attempt-r3',
            executor_id: 'executor-r3',
            lease_id: 'lease-r3',
            fence: 6,
            runtime_epoch: 7,
            output_port: 'video',
            role: 'output',
            object_id: MANAGED_OUTPUT_OBJECT_ID,
            digest: MANAGED_OUTPUT_OBJECT_ID,
            size: 4,
            filename: 'retained-output.mp4',
            media_type: 'video/mp4',
            producer: { capability_id: 'rendering.render' },
            destination: { root: '/runtime/export-root', filename: 'retained-output.mp4' },
            source_provenance: { task_id: 'task-r3', attempt_id: 'attempt-r3' },
            exported_at: '2026-09-11T00:02:00Z',
          },
          receipt: receipt('managed_output.export', headers['Idempotency-Key'] ?? ''),
        }),
      };
    }
    if (method === 'POST' && path === '/v1/tasks/task-r3/cancel') {
      expect(headers['Idempotency-Key']).toBe('astrid.cancel:r3');
      expect(parsedBody).toEqual({ expected_version: 1 });
      task.state = 'cancelled';
      task.version = 2;
      return { status: 200, headers: {}, body: json({ data: task, receipt: receipt('task.cancel', 'astrid.cancel:r3') }) };
    }
    if (method === 'POST' && path === '/v1/tasks/task-r3/retry') {
      expect(headers['Idempotency-Key']).toBe('astrid.retry:r3');
      expect(parsedBody).toEqual({ expected_version: 2 });
      task.state = 'retrying';
      task.version = 3;
      return { status: 200, headers: {}, body: json({ data: task, receipt: receipt('task.retry', 'astrid.retry:r3') }) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };

  return { requests, task, transport };
}

function clientFor(fixture: ReturnType<typeof createTransport>, options: { token?: boolean; expectedIdentity?: typeof EXPECTED_IDENTITY } = {}) {
  return new AstridRuntimeClient({
    baseUrl: 'http://runtime.test',
    ...(options.token ? { token: 'fixture-token' } : {}),
    expectedIdentity: options.expectedIdentity ?? EXPECTED_IDENTITY,
    transport: fixture.transport,
  });
}

describe('AstridRuntimeClient project creation', () => {
  it('selects the project through the workspace mutation route with the requested scope', async () => {
    const fixture = createTransport();
    let selection: { headers: Record<string, string>; body: unknown } | undefined;
    const transport: Transport = async (method, path, headers, body) => {
      if (method === 'PUT' && path === '/v1/projects/selection') {
        selection = { headers, body: JSON.parse(new TextDecoder().decode(body as Uint8Array)) };
        return { status: 200, headers: {}, body: json({ data: { project: PROJECT_ID, scope: 'workspace' }, receipt: receipt('project.select', headers['Idempotency-Key'] ?? '') }) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', expectedIdentity: EXPECTED_IDENTITY, transport });

    await expect(client.selectProject(PROJECT_ID, 'workspace')).resolves.toMatchObject({ project: PROJECT_ID });
    expect(selection?.body).toEqual({ project: PROJECT_ID, scope: 'workspace' });
    expect(selection?.headers['Idempotency-Key']).toBeTruthy();
  });

  it('sends the caller’s stable retry key through the authenticated mutation path', async () => {
    const fixture = createTransport();
    let creation: { headers: Record<string, string>; body: unknown } | undefined;
    const transport: Transport = async (method, path, headers, body) => {
      if (method === 'POST' && path === '/v1/projects') {
        creation = { headers, body: JSON.parse(new TextDecoder().decode(body as Uint8Array)) };
        return { status: 201, headers: {}, body: json({ data: { project_id: PROJECT_ID }, receipt: receipt('project.create', 'first-project-intent') }) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', expectedIdentity: EXPECTED_IDENTITY, transport });
    expect(await client.createProject('My first project', 'first-project-intent', 'first-project', { aspect_ratio: '16:9' }))
      .toMatchObject({ project_id: PROJECT_ID });
    expect(creation?.headers['Idempotency-Key']).toBe('first-project-intent');
    expect(creation?.body).toEqual({ name: 'My first project', slug: 'first-project', metadata: { aspect_ratio: '16:9' } });
    expect(fixture.requests.some(request => request.path === '/v1/handshake')).toBe(true);
  });

  it('refuses project creation from a read-only discovery client', async () => {
    const fixture = createTransport();
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', readOnly: true, transport: fixture.transport });
    await expect(client.createProject('First', 'intent')).rejects.toThrow('read-only');
    expect(fixture.requests).toEqual([]);
  });

  it('fences project creation when the Runtime changes after connection', async () => {
    const options = { runtimeInstanceId: EXPECTED_IDENTITY.runtimeInstanceId };
    const fixture = createTransport(options);
    const client = clientFor(fixture);
    await client.ensureSession();
    options.runtimeInstanceId = 'replacement-runtime';
    await expect(client.createProject('First', 'intent')).rejects.toThrow('Runtime restarted');
    expect(fixture.requests.some(request => request.path === '/v1/projects')).toBe(false);
  });
});

describe('AstridRuntimeClient paired restart detection without build-time ids', () => {
  // No expectedIdentity: the paired path has no VITE_WORKSPACE_RUNTIME_EXPECTED_* ids.
  const store: ObservedRuntimeIdentities = new Map();
  const unbound = (fixture: ReturnType<typeof createTransport>, baseUrl: string) => new AstridRuntimeClient({ baseUrl, transport: fixture.transport, identityStore: store });

  it('binds the first observed Runtime instance and flags a replacement from any client', async () => {
    const options = { runtimeInstanceId: 'instance-a' };
    const fixture = createTransport(options);
    const baseUrl = 'http://paired-restart-a.test';
    await unbound(fixture, baseUrl).ensureSession();
    // A reconnect to the same instance is fine, from the same or another client object.
    await unbound(fixture, baseUrl).reconnect();
    options.runtimeInstanceId = 'instance-b';
    const later = unbound(fixture, baseUrl);
    await expect(later.ensureSession()).rejects.toMatchObject({
      name: 'RuntimeCompatibilityError',
      kind: 'identity',
      detail: expect.stringContaining('Runtime restarted—relaunch workspace'),
    });
    await expect(later.updateProject(PROJECT_ID, 'restart-no-write', 1, 'edited', {}))
      .rejects.toThrow('Runtime restarted—relaunch workspace');
    expect(fixture.requests.filter(({ method, path }) => method !== 'GET' && path !== '/v1/handshake')).toEqual([]);
  });

  it('makes every client sharing a binding refuse writes once any client sees the restart', async () => {
    const options = { runtimeInstanceId: 'instance-a' };
    const fixture = createTransport(options);
    const baseUrl = 'http://paired-restart-d.test';
    const cached = unbound(fixture, baseUrl);
    await cached.ensureSession();
    options.runtimeInstanceId = 'instance-b';
    await expect(unbound(fixture, baseUrl).ensureSession()).rejects.toMatchObject({ name: 'RuntimeCompatibilityError' });
    await expect(cached.updateProject(PROJECT_ID, 'cached-write', 1, 'edited', {}))
      .rejects.toThrow('Runtime restarted—relaunch workspace');
    expect(fixture.requests.filter(({ method }) => method === 'PATCH')).toEqual([]);
  });

  it('revalidates the Runtime instance before a mutation on a cached session', async () => {
    const options = { runtimeInstanceId: 'instance-a' };
    const fixture = createTransport(options);
    const cached = unbound(fixture, 'http://paired-restart-e.test');
    await cached.ensureSession();
    options.runtimeInstanceId = 'instance-b';
    await expect(cached.updateProject(PROJECT_ID, 'cached-write', 1, 'edited', {}))
      .rejects.toThrow('Runtime restarted—relaunch workspace');
    expect(fixture.requests.filter(({ method }) => method === 'PATCH')).toEqual([]);
  });

  it('fences transcript document writes on a cached session after a Runtime restart', async () => {
    const options = { runtimeInstanceId: 'instance-a' };
    const fixture = createTransport(options);
    const cached = unbound(fixture, 'http://paired-restart-document.test');
    await cached.ensureSession();
    options.runtimeInstanceId = 'instance-b';
    const documentId = `transcript:${'a'.repeat(64)}`;
    await expect(cached.createDocument(PROJECT_ID, documentId, 'transcript', {}, 'doc-create'))
      .rejects.toThrow('Runtime restarted—relaunch workspace');
    await expect(cached.updateDocument(PROJECT_ID, documentId, 1, {}, 'doc-update'))
      .rejects.toThrow('Runtime restarted—relaunch workspace');
    expect(fixture.requests.filter(({ method, path }) => (method === 'POST' || method === 'PATCH') && path.includes('/documents'))).toEqual([]);
  });

  it('requires a non-empty instance id and commits the binding only after the realm agrees', async () => {
    const options: { runtimeInstanceId: string; realmResponseId?: string } = { runtimeInstanceId: '' };
    const fixture = createTransport(options);
    const baseUrl = 'http://paired-restart-f.test';
    await expect(unbound(fixture, baseUrl).ensureSession()).rejects.toMatchObject({ name: 'RuntimeCompatibilityError' });
    options.runtimeInstanceId = 'instance-a';
    options.realmResponseId = 'some-other-realm';
    await expect(unbound(fixture, baseUrl).ensureSession()).rejects.toMatchObject({ name: 'RuntimeCompatibilityError' });
    expect(store.has(baseUrl)).toBe(false);
    options.realmResponseId = undefined;
    await unbound(fixture, baseUrl).ensureSession();
    options.runtimeInstanceId = 'instance-b';
    await expect(unbound(fixture, baseUrl).ensureSession()).rejects.toThrow('Runtime restarted—relaunch workspace');
  });

  it('flags a changed realm the same way and keeps other base URLs independent', async () => {
    const options = { realmId: 'realm-one', realmResponseId: 'realm-one' };
    const fixture = createTransport(options);
    await unbound(fixture, 'http://paired-restart-b.test').ensureSession();
    options.realmId = 'realm-two'; options.realmResponseId = 'realm-two';
    await expect(unbound(fixture, 'http://paired-restart-b.test').ensureSession())
      .rejects.toMatchObject({ name: 'RuntimeCompatibilityError' });
    await expect(unbound(fixture, 'http://paired-restart-c.test').ensureSession()).resolves.toBeDefined();
  });
});

describe('AstridRuntimeClient canonical Runtime reads and browser task seam', () => {
  it('rejects a replacement Runtime instance on reconnect without rebinding or writing', async () => {
    const options = { runtimeInstanceId: EXPECTED_IDENTITY.runtimeInstanceId };
    const fixture = createTransport(options);
    const client = clientFor(fixture);
    await client.ensureSession();
    options.runtimeInstanceId = 'replacement-runtime-same-realm';
    await expect(client.reconnect()).rejects.toMatchObject({
      name: 'RuntimeCompatibilityError',
      kind: 'identity',
      detail: expect.stringContaining('Runtime restarted—relaunch workspace'),
    });
    await expect(client.updateProject(PROJECT_ID, 'restart-no-write', 1, 'edited', {}))
      .rejects.toThrow('Runtime restarted—relaunch workspace');
    expect(fixture.requests.filter(({ method, path }) => method !== 'GET' && path !== '/v1/handshake'))
      .toEqual([]);
    expect(fixture.requests.filter(({ path }) => path === '/v1/realm')).toHaveLength(1);
  });

  it.each(RUNTIME_ACCEPTED_SCHEMA_DIGESTS)('negotiates the compatible Runtime contract %s', async (schemaDigest) => {
    const client = clientFor(createTransport({ schemaDigest }));
    const session = await client.ensureSession();
    expect(session.health.schema_digest).toBe(schemaDigest);
    expect(session.handshake.schema_digest).toBe(schemaDigest);
    expect(session.realm.realm_id).toBe(EXPECTED_IDENTITY.realmId);
  });

  it('accepts the vendored current Runtime contract digest during handshake', async () => {
    // The digest comes from the vendored contract metadata; runtime.lock.json pins those bytes to the producer.
    const selectedRuntimeDigest = RUNTIME_SCHEMA_DIGEST;
    expect(selectedRuntimeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const fixture = createTransport();
    const client = clientFor(fixture);

    const session = await client.ensureSession();

    expect(session.health.schema_digest).toBe(selectedRuntimeDigest);
    expect(session.handshake.schema_digest).toBe(selectedRuntimeDigest);
    expect(fixture.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/health',
      'POST /v1/handshake',
      'GET /v1/realm',
    ]);
  });

  it('rejects the previous Runtime singleton digest before loading the realm', async () => {
    const fixture = createTransport({
      schemaDigest: 'sha256:d2f5a6d546f5220b0e33b52dec114e502d1aa9be58f83a376d6efc9ede8d7860',
    });
    const client = clientFor(fixture);

    await expect(client.ensureSession()).rejects.toMatchObject({
      name: 'RuntimeCompatibilityError',
      code: 'runtime_incompatible',
      kind: 'schema',
    });
    expect(fixture.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/health',
      'POST /v1/handshake',
    ]);
  });
  it('fails closed on a Runtime schema digest mismatch', async () => {
    const fixture = createTransport({ schemaDigest: `sha256:${'0'.repeat(64)}` });
    const client = clientFor(fixture);

    await expect(client.ensureSession()).rejects.toMatchObject({ code: 'runtime_incompatible', kind: 'schema' });
  });

  it('fails closed on a stale additive Runtime contract', async () => {
    const fixture = createTransport({
      schemaDigest: 'sha256:5da488052a7a281a4ce9c9336e19cdf0bf840ed211d244dd101e8326cb9d4f00',
    });
    const client = clientFor(fixture);

    await expect(client.ensureSession()).rejects.toMatchObject({
      name: 'RuntimeCompatibilityError',
      code: 'runtime_incompatible',
    });
  });

  it('fails closed when the targeted execution capability is absent', async () => {
    const fixture = createTransport({ capabilities: [] });
    const client = clientFor(fixture);

    await expect(client.ensureSession()).rejects.toMatchObject({
      name: 'RuntimeCompatibilityError',
      kind: 'capability',
      detail: expect.stringContaining('execution_binding.targeted.v1'),
    });
  });

  it('uses kind-specific recovery actions so only schema failures ask for an update', async () => {
    const schema = new RuntimeCompatibilityError('schema', 'digest mismatch', '/runtime');
    const capability = new RuntimeCompatibilityError('capability', 'missing operation', '/runtime');
    const identity = new RuntimeCompatibilityError('identity', 'wrong realm', '/runtime');
    expect(schema.recoveryAction).toMatch(/Update Astrid/);
    expect(capability.recoveryAction).toMatch(/supports this capability/);
    expect(identity.recoveryAction).toMatch(/Restart the selected Astrid Runtime/);
  });

  it('rejects owner, worker, wrong actor/realm/instance and non-exact connector scopes', async () => {
    const cases = [
      ['owner actor', { actorId: 'owner' }, /actor or granted scopes/],
      ['worker actor with reduced scopes', { actorId: 'astrid-pack-host', scopes: ['handshake', 'projects:read', 'tasks:read'] }, /actor or granted scopes/],
      ['unexpected product actor', { actorId: 'another-product-actor' }, /actor or realm/],
      ['unexpected realm', { realmId: 'another-realm' }, /actor or realm/],
      ['unexpected Runtime instance', { runtimeInstanceId: 'another-runtime' }, /Runtime restarted—relaunch workspace/],
      ['missing requested scope', { scopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'tasks:read', 'tasks:write'] }, /actor or granted scopes/],
      ['additional admin scope', { scopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write', 'admin'] }, /actor or granted scopes/],
      ['realm endpoint substitution', { realmResponseId: 'another-realm' }, /realm endpoint/],
    ] as const;

    for (const [label, transportOptions, expectedReason] of cases) {
      const fixture = createTransport(transportOptions);
      const client = clientFor(fixture);
      const error = await client.ensureSession().then(() => null, (failure) => failure);
      if (!error) throw new Error(`${label}: expected the Runtime identity check to fail`);
      expect(error).toMatchObject({
        name: 'RuntimeCompatibilityError',
        kind: 'identity',
        detail: expect.stringMatching(expectedReason),
      });
      expect(fixture.requests.some(({ path }) => path === '/v1/projects')).toBe(false);
      if (label !== 'realm endpoint substitution') {
        expect(fixture.requests.some(({ path }) => path === '/v1/realm')).toBe(false);
      }
    }
  });

  it('preserves generated generation/variant cursors and managed identities', async () => {
    const fixture = createTransport();
    const client = clientFor(fixture, { token: true });

    const generations = await client.listGenerations(PROJECT_ID, 'generations-7', 2);
    const variants = await client.listVariants(generation.generation_id, 'variants-3', 2);
    expect(generations).toEqual({ items: [generation], next_cursor: 'generations-8' });
    expect(variants).toEqual({ items: [variant], next_cursor: 'variants-4' });
    expect(generations.items[0]?.generation_id).toBe('generation-r2');
    expect(variants.items[0]?.object_id).toBe(`sha256:${'2'.repeat(64)}`);
    expect(fixture.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/health',
      'POST /v1/handshake',
      'GET /v1/realm',
      'GET /v1/projects/project%2Fr2/generations?limit=2&cursor=generations-7',
      'GET /v1/generations/generation-r2/variants?limit=2&cursor=variants-3',
    ]);
  });

  it('reopens the cached handshake and preserves generated Range/ETag media identity', async () => {
    const fixture = createTransport();
    const client = clientFor(fixture, { token: true });

    await client.ensureSession();
    const ranged = await client.getObject(MEDIA_OBJECT_ID, [0, 3]);
    const metadata = await client.headObject(MEDIA_OBJECT_ID);
    await client.reconnect();

    expect(ranged.status).toBe(206);
    expect(ranged.etag).toBe(`"${MEDIA_OBJECT_DIGEST}"`);
    expect(ranged.content_range).toBe('bytes 0-3/4');
    expect(metadata.status).toBe(200);
    expect(metadata.etag).toBe(`"${MEDIA_OBJECT_DIGEST}"`);
    expect(fixture.requests.filter(({ path }) => path === '/v1/handshake')).toHaveLength(2);
    expect(fixture.requests.find(({ method, path }) => method === 'GET' && path === `/v1/objects/${MEDIA_OBJECT_ID}`)?.headers.Range)
      .toBe('bytes=0-3');
    expect(fixture.requests.find(({ method, path }) => method === 'HEAD' && path === `/v1/objects/${MEDIA_OBJECT_ID}`)?.headers.Range)
      .toBeUndefined();
  });

  it('clears the cached session and reports a revoked credential truthfully', async () => {
    const fixture = createTransport({ revokeFirstMediaRead: true });
    const client = clientFor(fixture, { token: true });

    await expect(client.getObject(MEDIA_OBJECT_ID)).rejects.toMatchObject({
      name: 'RuntimeAuthenticationError',
      code: 'runtime_authentication',
      status: 401,
      recoveryAction: 'Provide an authenticated connector credential and retry.',
    });

    await expect(client.getObject(MEDIA_OBJECT_ID)).resolves.toMatchObject({
      status: 200,
      etag: `"${MEDIA_OBJECT_DIGEST}"`,
    });
    expect(fixture.requests.filter(({ path }) => path === '/v1/handshake')).toHaveLength(2);
  });

  it('exports one selected managed output with exact identity assertions and a durable receipt', async () => {
    const fixture = createTransport();
    const client = clientFor(fixture, { token: true });

    const exported = await client.exportManagedOutput(
      MANAGED_OUTPUT_ASSOCIATION_ID,
      'retained-output.mp4',
      {
        project_id: PROJECT_ID,
        run_id: 'run-r3',
        task_id: 'task-r3',
        attempt_id: 'attempt-r3',
        association_id: MANAGED_OUTPUT_ASSOCIATION_ID,
        output_port: 'video',
        role: 'output',
        object_id: MANAGED_OUTPUT_OBJECT_ID,
        digest: MANAGED_OUTPUT_OBJECT_ID,
        size: 4,
        filename: 'retained-output.mp4',
        media_type: 'video/mp4',
        executor_id: 'executor-r3',
        lease_id: 'lease-r3',
        fence: 6,
        runtime_epoch: 7,
      },
    );

    expect(exported).toMatchObject({
      export_id: 'export-r3',
      association_id: MANAGED_OUTPUT_ASSOCIATION_ID,
      object_id: MANAGED_OUTPUT_OBJECT_ID,
      digest: MANAGED_OUTPUT_OBJECT_ID,
      size: 4,
      filename: 'retained-output.mp4',
      runtime_epoch: 7,
    });
    expect(exported.receipt).toMatchObject({
      command_kind: 'managed_output.export',
      project_id: PROJECT_ID,
      event_ids: [],
    });
    expect(fixture.requests.at(-1)?.path).toBe(`/v1/managed-outputs/${MANAGED_OUTPUT_ASSOCIATION_ID}/export`);
  });

  it('uses the exact GEN/UE admission mapping and keeps task lifecycle browser-bounded', async () => {
    const fixture = createTransport();
    const client = clientFor(fixture, { token: true });

    const capabilities = await client.listCapabilities();
    expect(capabilities.items[0]).toMatchObject({
      capability_id: CAPABILITY_ID,
      definition_digest: CAPABILITY_DIGEST,
      status: 'ready',
    });
    expect(exactGenTaskInput.capability_digest).toBe(capabilities.items[0]?.definition_digest);

    const admitted = await client.admitTask(exactGenTaskInput, 'astrid.admit:r3');
    expect(admitted).toMatchObject({
      task_id: 'task-r3',
      project_id: PROJECT_ID,
      capability_id: CAPABILITY_ID,
      capability_digest: CAPABILITY_DIGEST,
      input_object_ids: [INPUT_OBJECT_ID],
      generation_intent: exactGenTaskInput.generation_intent,
      state: 'queued',
      version: 1,
    });
    expect(admitted.receipt.command_kind).toBe('task.create');

    await expect(client.getTask('task-r3')).resolves.toMatchObject({ task_id: 'task-r3', state: 'queued' });
    await expect(client.listProjectTasks(PROJECT_ID, 'tasks-2', 1)).resolves.toEqual({ items: [fixture.task], next_cursor: 'tasks-3' });

    const cancelled = await client.cancelTask('task-r3', 'astrid.cancel:r3', 1);
    expect(cancelled).toMatchObject({ task_id: 'task-r3', state: 'cancelled', version: 2 });
    const retried = await client.retryTask('task-r3', 'astrid.retry:r3', 2);
    expect(retried).toMatchObject({ task_id: 'task-r3', state: 'retrying', version: 3 });
    expect(retried.receipt.command_kind).toBe('task.retry');

    expect(fixture.requests.filter(({ path }) => path === '/v1/tasks').map(({ method }) => method)).toEqual(['POST']);
    expect(fixture.requests.some(({ path }) => path === '/v1/tasks/claim')).toBe(false);
    expect(fixture.requests.some(({ path }) => path.includes('/settle'))).toBe(false);
  });
});

describe('isRuntimeConflict classification of the Runtime stale-head 409', () => {
  // Verbatim body from a live Runtime publish that lost the head race
  // (Runtime test_stale_head_conflict_carries_machine_readable_reason_over_http).
  const RUNTIME_STALE_HEAD_BODY = JSON.parse(
    '{"code": "conflict", "details": {"actual_head": "parent-1", "expected_head": null, "reason": "stale_head"}, "message": "parent composition head is stale", "request_id": "a70bb823c77b4cc7ae3ef643457b772e"}',
  ) as { code: string; message: string; request_id: string; details: Record<string, unknown> };
  const fromBody = (body: typeof RUNTIME_STALE_HEAD_BODY, status = 409) =>
    new ApiError(status, body.code, body.message, body.request_id, body.details);

  it('classifies the exact Runtime body as a conflict', () => {
    expect(isRuntimeConflict(fromBody(RUNTIME_STALE_HEAD_BODY))).toBe(true);
  });

  it('classifies by details.reason, not message wording', () => {
    expect(isRuntimeConflict(fromBody({ ...RUNTIME_STALE_HEAD_BODY, message: 'someone else got there first' }))).toBe(true);
  });

  it('does not treat other 409s or other statuses as a stale head', () => {
    const idempotency = { code: 'conflict', message: 'idempotency key was already used with different input', request_id: 'r', details: {} };
    expect(isRuntimeConflict(fromBody(idempotency))).toBe(false);
    expect(isRuntimeConflict(fromBody(RUNTIME_STALE_HEAD_BODY, 500))).toBe(false);
    // Other Runtime 409s whose message merely contains a head/version/timeline word.
    const wrongProject = { code: 'conflict', message: 'timeline belongs to a different project', request_id: 'r', details: {} };
    expect(isRuntimeConflict(fromBody(wrongProject))).toBe(false);
  });

  it('still classifies Runtime version CAS conflicts by their expected/actual details', () => {
    const version = { code: 'conflict', message: 'any wording', request_id: 'r', details: { expected: 3, actual: 4 } };
    expect(isRuntimeConflict(fromBody(version))).toBe(true);
  });
});

describe('isRuntimeCanonicalPayloadConflict classification', () => {
  // Body shape the Runtime sends (ConflictError.as_dict plus request_id; Runtime test
  // test_canonical_payload_mismatch_conflict_carries_machine_readable_reason).
  const BODY = JSON.parse(
    '{"code": "conflict", "details": {"reason": "canonical_payload_mismatch"}, "message": "canonical parent clips and config.clips disagree", "request_id": "a70bb823c77b4cc7ae3ef643457b772e"}',
  ) as { code: string; message: string; request_id: string; details: Record<string, unknown> };
  const fromBody = (body: typeof BODY) => new ApiError(409, body.code, body.message, body.request_id, body.details);

  it('classifies the exact Runtime body', () => {
    expect(isRuntimeCanonicalPayloadConflict(fromBody(BODY))).toBe(true);
  });

  it('classifies by details.reason regardless of message wording', () => {
    expect(isRuntimeCanonicalPayloadConflict(fromBody({ ...BODY, message: 'parent and config clips differ' }))).toBe(true);
  });

  it('does not match on message text alone or on a stale head', () => {
    expect(isRuntimeCanonicalPayloadConflict(fromBody({ ...BODY, details: {} }))).toBe(false);
    expect(isRuntimeCanonicalPayloadConflict(fromBody({ ...BODY, message: 'parent composition head is stale', details: { reason: 'stale_head' } }))).toBe(false);
  });
});
