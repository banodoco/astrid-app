import { describe, expect, it } from 'vitest';
import { acceptedCommit, fixtureDigest } from './__tests__/timelineCommitFixture.ts';
import { WorkspaceClient, type CanonicalDocument, type CommitPreviewResponse, type Transport } from './generated.ts';
import { classifyRuntimeCommitFailure, AstridRuntimeClient } from './client.ts';
import { decodeAcceptedTimelineCommit } from './dataProvider.ts';
import { ApiError } from './generated.ts';
import { RuntimeDataProvider } from './dataProvider.ts';
import { RUNTIME_SCHEMA_DIGEST } from './contract-metadata.ts';

const PROJECT_ID = 'project-commit';
const TIMELINE_ID = 'timeline-commit';

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function accepted(revisionId: string, publicationId: string, baseRevisionId: string, basePublicationId: string, idMap: Record<string, string> = {}) {
  const response = acceptedCommit(
    { revision_id: revisionId, publication_id: publicationId },
    { revision_id: baseRevisionId, publication_id: basePublicationId },
  );
  response.data.id_map = idMap;
  return response;
}

function transportFor(response: unknown, requests: Array<{ method: string; path: string; body?: unknown }>): Transport {
  return async (method, path, _headers, body) => {
    const parsed = body ? JSON.parse(new TextDecoder().decode(body)) : undefined;
    requests.push({ method, path, ...(parsed === undefined ? {} : { body: parsed }) });
    if (path === '/v1/health') return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_epoch: 1, runtime_instance_id: 'instance-1' }) };
    if (path === '/v1/handshake') return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, session_id: 'session-1', actor_id: 'actor-1', realm_id: 'realm-1', scopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'], capabilities: ['execution_binding.targeted.v1'] }) };
    if (path === '/v1/realm') return { status: 200, headers: {}, body: json({ realm_id: 'realm-1', display_name: 'fixture', version: 1, created_at: '2026-10-19T00:00:00Z' }) };
    if (path.endsWith('/commit')) return { status: 200, headers: {}, body: json(response) };
    if (path.endsWith('/commits?limit=50')) return { status: 200, headers: {}, body: json({ items: [], next_cursor: null, head: { revision_id: 'r1', publication_id: 'p1' } }) };
    if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
      const acceptedResponse = response as { data: { accepted_revision_id: string }; receipt: { receipt_id: string } };
      return { status: 200, headers: {}, body: json({
        project_id: PROJECT_ID,
        timeline_id: TIMELINE_ID,
        version: 1,
        name: TIMELINE_ID,
        archived: false,
        shots: [],
        references: [],
        head_revision_id: acceptedResponse.data.accepted_revision_id,
        head_publication_id: acceptedResponse.receipt.receipt_id,
      }) };
    }
    throw new Error(`unexpected Runtime request: ${method} ${path}`);
  };
}

function request(baseRevisionId = 'r0', basePublicationId = 'p0') {
  return {
    api_version: 1 as const,
    project_id: PROJECT_ID,
    timeline_id: TIMELINE_ID,
    base_revision_id: baseRevisionId,
    base_publication_id: basePublicationId,
    commands: [{ schema_version: 1 as const, op: 'clip.move', version: '1', select: 'parent/clip:x', args: { on: 7 } }],
  };
}

describe('Runtime timeline commit capability', () => {
  it('projects the exact accepted closure and retains publication identity without a latest read', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      baseUrl: 'http://runtime.test',
      token: 'token',
      transport: transportFor(accepted('r1', 'p1', 'r0', 'p0'), requests),
    });
    const result = await provider.commitTimeline(request(), 'key-p1');
    expect(result.accepted).toEqual({ revisionId: 'r1', publicationId: 'p1' });
    expect(result.receipt.receipt_id).toBe('p1');
    expect(result.receipt.result).toEqual(result.response.data);
    expect(result.response.data.document_digest).toBe(fixtureDigest(result.canonicalDocument));
    expect(result.canonicalDocument.parent_revision.content_digest).toBe(fixtureDigest(result.canonicalDocument.parent_revision.payload));
    expect(Object.keys(result)).toContain('receipt');
    expect(result.canonicalDocument.parent_revision.payload).toMatchObject({ bundle: null, unknown: { nested: ['value', null] } });
    expect(result.graph).toMatchObject({
      accepted_identity: { revision_id: 'r1', publication_id: 'p1' },
      primary_timeline: { head: { revision_id: 'r1', publication_id: 'p1' } },
    });
    expect(requests.some(({ path }) => path.includes('/inspect') || path.includes('/composition-revisions/'))).toBe(false);
  });

  it('keeps same revision acknowledgements distinct by publication', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const responses = [accepted('r1', 'p1', 'r0', 'p0'), accepted('r1', 'p2', 'r1', 'p1')];
    const transport = async (...args: Parameters<Transport>) => {
      if (args[1].endsWith('/commit')) return { status: 200, headers: {}, body: json(responses.shift()) };
      return transportFor(accepted('r1', 'p1', 'r0', 'p0'), requests)(...args);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'token', transport });
    const first = await provider.commitTimeline(request(), 'key-p1');
    const second = await provider.commitTimeline(request('r1', 'p1'), 'key-p2');
    expect(first.accepted).toEqual({ revisionId: 'r1', publicationId: 'p1' });
    expect(second.accepted).toEqual({ revisionId: 'r1', publicationId: 'p2' });
  });

  it('builds an explicit timeline.inverse command through the same capability', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const response = accepted('r2', 'p2', 'r1', 'p1');
    response.data.commands = [{ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: ['p-a', 'p-b'] } }];
    response.receipt.request_hash = fixtureDigest({ operation: 'commitTimeline', path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/commit`, publisher: 'actor-1', request: { ...request('r1', 'p1'), commands: response.data.commands } }).slice(7);
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'token', transport: transportFor(response, requests) });
    await provider.undoTimeline({ projectId: PROJECT_ID, timelineId: TIMELINE_ID, headRevisionId: 'r1', headPublicationId: 'p1' }, ['p-a', 'p-b'], 'key-p2');
    const commit = requests.find((entry) => entry.path.endsWith('/commit'));
    expect(commit?.body).toMatchObject({
      base_revision_id: 'r1',
      base_publication_id: 'p1',
      commands: [{ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: ['p-a', 'p-b'] } }],
    });
  });

  it('rejects a nonidentity id_map and classifies typed failures', async () => {
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'token', transport: transportFor(accepted('r1', 'p1', 'r0', 'p0', { 'parent/clip:x': 'parent/clip:y' }), []) });
    await expect(provider.commitTimeline(request(), 'key-p1')).rejects.toThrow('non-identity id_map');
    expect(classifyRuntimeCommitFailure(new ApiError(409, 'conflict', 'conflict', '', { status: 'conflict' }))).toBe('conflict');
    expect(classifyRuntimeCommitFailure(new ApiError(409, 'conflict', 'busy', '', { status: 'refused', reason: 'head_busy' }))).toBe('unknown');
    expect(classifyRuntimeCommitFailure(new ApiError(422, 'invalid', 'bad'))).toBe('validation');
    expect(classifyRuntimeCommitFailure(new ApiError(503, 'not_ready', 'unknown'))).toBe('unknown');
  });

  it('accepts the v2 merged status in the shared commit decoder', () => {
    const response = accepted('r1', 'p1', 'r0', 'p0');
    response.data.status = 'merged';
    expect(decodeAcceptedTimelineCommit(response, PROJECT_ID, TIMELINE_ID).accepted).toEqual({
      revisionId: 'r1',
      publicationId: 'p1',
    });
  });

  it('accepts a complete merged closure through the generated WorkspaceClient', async () => {
    const change = {
      op: 'set' as const,
      ref: 'parent',
      path: ['clips', 'id:x', 'meta', 'org.example.notes', 'note'],
      before: { state: 'absent' as const },
      value: 'B',
    };
    const command = {
      schema_version: 1 as const,
      op: 'doc.patch' as const,
      version: '1',
      select: null,
      args: { changes: [change] },
    };
    const step = {
      id: 'note-1',
      label: 'Revise the first note',
      intent: 'Clarify the opening',
      tags: ['notes'],
      command_ordinals: [0] as [number],
      patch: [change],
      dependencies: [],
    };
    const mergedRequest = {
      ...request(),
      commands: [command] as [typeof command],
      label: 'Clarify opening note',
      steps: [step] as [typeof step],
      merge: 'fields' as const,
      reads: [],
      dry_run: false,
    };
    const response = acceptedCommit(
      { revision_id: 'r2', publication_id: 'p2' },
      { revision_id: 'r0', publication_id: 'p0' },
      { commands: mergedRequest.commands },
    );
    response.data.status = 'merged';
    response.data.previous_revision_id = 'r1';
    response.data.previous_publication_id = 'p1';
    response.data.rebased_onto = { revision_id: 'r1', publication_id: 'p1' };
    response.data.merge_mode = 'fields';
    response.data.label = mergedRequest.label;
    response.data.steps = [step];
    response.receipt.idempotency_key = 'merged-key';
    response.receipt.request_hash = fixtureDigest({
      operation: 'commitTimeline',
      path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/commit`,
      publisher: response.data.publisher,
      request: mergedRequest,
    }).slice(7);

    const sent: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
    const fakeHTTP: Transport = async (method, path, headers, body) => {
      sent.push({
        method,
        path,
        headers,
        body: JSON.parse(new TextDecoder().decode(body as Uint8Array)),
      });
      return { status: 200, headers: {}, body: json(response) };
    };
    const client = new WorkspaceClient('http://runtime.test', 'token', fakeHTTP);

    const result = await client.commitTimeline(PROJECT_ID, TIMELINE_ID, mergedRequest, 'merged-key');

    expect(result.data.status).toBe('merged');
    expect(result.data.canonical_document.parent_revision.revision_id).toBe('r2');
    expect(result.data.steps).toEqual([step]);
    expect(result.receipt).toMatchObject({
      receipt_id: 'p2',
      idempotency_key: 'merged-key',
      result: response.data,
    });
    expect(sent).toEqual([{
      method: 'POST',
      path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/commit`,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'merged-key',
      },
      body: mergedRequest,
    }]);
  });

  it('replays an authentic historical rebased receipt through the generated WorkspaceClient', async () => {
    const historicalRequest = request();
    const response = acceptedCommit(
      { revision_id: 'r2', publication_id: 'p2' },
      { revision_id: 'r0', publication_id: 'p0' },
    );
    response.data.status = 'rebased';
    response.data.previous_revision_id = 'r1';
    response.data.previous_publication_id = 'p1';
    response.data.rebased_onto = { revision_id: 'r1', publication_id: 'p1' };
    response.receipt.idempotency_key = 'historical-key';
    response.receipt.request_hash = fixtureDigest({
      operation: 'commitTimeline',
      path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/commit`,
      publisher: response.data.publisher,
      request: historicalRequest,
    }).slice(7);

    const sent: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
    const fakeHTTP: Transport = async (method, path, headers, body) => {
      sent.push({
        method,
        path,
        headers,
        body: JSON.parse(new TextDecoder().decode(body as Uint8Array)),
      });
      return { status: 200, headers: {}, body: json(response) };
    };
    const client = new WorkspaceClient('http://runtime.test', 'token', fakeHTTP);

    const result = await client.commitTimeline(PROJECT_ID, TIMELINE_ID, historicalRequest, 'historical-key');

    expect(result).toEqual(response);
    expect(result.data.status).toBe('rebased');
    expect(result.data.rebased_onto).toEqual({ revision_id: 'r1', publication_id: 'p1' });
    expect(result.receipt).toMatchObject({ result: response.data });
    expect(Object.hasOwn(response.data, 'label')).toBe(false);
    expect(Object.hasOwn(response.data, 'merge_mode')).toBe(false);
    expect(Object.hasOwn(response.data, 'steps')).toBe(false);
    expect(sent).toEqual([{
      method: 'POST',
      path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/commit`,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'historical-key',
      },
      body: historicalRequest,
    }]);
  });

  it('accepts an authentic merged preview with authoritative step dependencies through the generated WorkspaceClient', async () => {
    const read = { kind: 'scope' as const, ref: 'timeline', path: [] };
    const change = {
      op: 'set' as const,
      ref: 'parent',
      path: ['meta', 'org.example.notes', 'note'],
      before: { state: 'absent' as const },
      value: 'B',
    };
    const command = {
      schema_version: 1 as const,
      op: 'doc.patch' as const,
      version: '1',
      select: null,
      args: { changes: [change] },
    };
    const requestedStep = {
      id: 'note-1',
      label: 'Revise the first note',
      intent: 'Clarify the opening',
      tags: ['notes'],
      command_ordinals: [0] as [number],
      patch: [change],
      reads: [read],
    };
    const authoritativeStep = { ...requestedStep, dependencies: [read] };
    const previewRequest = {
      ...request(),
      commands: [command] as [typeof command],
      label: 'Clarify opening note',
      steps: [requestedStep] as [typeof requestedStep],
      merge: 'fields' as const,
      reads: [read],
      dry_run: true,
    };
    const acceptedResponse = acceptedCommit(
      { revision_id: 'r2', publication_id: 'p2' },
      { revision_id: 'r0', publication_id: 'p0' },
      { commands: previewRequest.commands },
    );
    const response: CommitPreviewResponse = {
      data: {
        status: 'preview',
        would_status: 'merged',
        base_revision_id: previewRequest.base_revision_id,
        base_publication_id: previewRequest.base_publication_id,
        evaluated_head: { revision_id: 'r1', publication_id: 'p1' },
        canonical_document: acceptedResponse.data.canonical_document,
        document_digest: acceptedResponse.data.document_digest,
        commands: acceptedResponse.data.commands,
        id_map: acceptedResponse.data.id_map,
        provider_version: acceptedResponse.data.provider_version,
        compiler_version: acceptedResponse.data.compiler_version,
        merge_mode: 'fields',
        steps: [authoritativeStep],
      },
      receipt: null,
    };

    const sent: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
    const fakeHTTP: Transport = async (method, path, headers, body) => {
      sent.push({
        method,
        path,
        headers,
        body: JSON.parse(new TextDecoder().decode(body as Uint8Array)),
      });
      return { status: 200, headers: {}, body: json(response) };
    };
    const client = new WorkspaceClient('http://runtime.test', 'token', fakeHTTP);

    const result = await client.commitTimeline(PROJECT_ID, TIMELINE_ID, previewRequest, 'preview-merged-key');

    expect(result).toEqual(response);
    expect(result.data.would_status).toBe('merged');
    expect(result.data.canonical_document).toEqual(acceptedResponse.data.canonical_document);
    expect(result.data.merge_mode).toBe('fields');
    expect(result.data.steps).toEqual([authoritativeStep]);
    expect(result.receipt).toBeNull();
    expect(sent).toEqual([{
      method: 'POST',
      path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/commit`,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'preview-merged-key',
      },
      body: previewRequest,
    }]);
  });

  it('accepts a complete receipt and refuses a partial receipt through the generated WorkspaceClient', async () => {
    const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' });
    let currentResponse: unknown = response;
    const client = new WorkspaceClient('http://runtime.test', 'token', async () => ({ status: 200, headers: {}, body: json(currentResponse) }));

    await expect(client.commitTimeline(PROJECT_ID, TIMELINE_ID, request(), response.receipt.idempotency_key)).resolves.toEqual(response);
    delete (response.receipt as unknown as Record<string, unknown>).result;
    currentResponse = response;
    await expect(client.commitTimeline(PROJECT_ID, TIMELINE_ID, request(), response.receipt.idempotency_key)).rejects.toThrow('invalid commit receipt');
  });

  it('accepts a complete preview and refuses a preview without would_status through the generated WorkspaceClient', async () => {
    const acceptedResponse = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' });
    const response = {
      data: { ...acceptedResponse.data, status: 'preview' as const, would_status: 'accepted' as const, evaluated_head: { revision_id: 'r1', publication_id: 'p1' } },
      receipt: null,
    } as CommitPreviewResponse;
    let currentResponse: unknown = response;
    const client = new WorkspaceClient('http://runtime.test', 'token', async () => ({ status: 200, headers: {}, body: json(currentResponse) }));
    const previewRequest = { ...request(), dry_run: true };

    await expect(client.commitTimeline(PROJECT_ID, TIMELINE_ID, previewRequest, 'preview-key')).resolves.toEqual(response);
    delete (response.data as unknown as Record<string, unknown>).would_status;
    currentResponse = response;
    await expect(client.commitTimeline(PROJECT_ID, TIMELINE_ID, previewRequest, 'preview-key')).rejects.toThrow('invalid commit preview');
  });

  it('preserves repeated occurrences, scoped child images, opaque fields and explicit nulls', async () => {
    const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' }, { children: true });
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'token', transport: transportFor(response, requests) });
    const result = await provider.commitTimeline(request(), response.receipt.idempotency_key);
    const document = response.data.canonical_document;
    expect(result.canonicalDocument).toEqual(document);
    expect(result.graph.canonical_document).toEqual(document);
    expect(result.graph.parent_composition).toEqual(document.parent_revision.payload);
    expect(result.graph.occurrences).toMatchObject(document.parent_revision.payload.occurrences as object[]);
    expect(result.graph.shot_revisions).toMatchObject([{
      ...document.shot_revisions[0].payload,
      internal_timeline_revision: {
        timeline_id: 'child-timeline',
        revision_id: 'internal-r1',
        content_digest: document.internal_timeline_revisions[0].content_digest,
        timeline: document.internal_timeline_revisions[0].payload,
      },
    }]);
    expect(document.internal_timeline_revisions[0].content_digest).toBe(fixtureDigest(document.internal_timeline_revisions[0].payload));
    expect(document.shot_revisions[0].content_digest).toBe(fixtureDigest(document.shot_revisions[0].payload));
    expect(requests.filter(({ path }) => path.includes('/revisions/') || path.includes('/inspect'))).toEqual([]);
  });

  const malformedClosures: Array<[string, (document: CanonicalDocument) => void]> = [
    ['wrong project', (d) => { d.project_id = 'other'; }],
    ['wrong timeline', (d) => { d.timeline_id = 'other'; }],
    ['wrong accepted revision', (d) => { d.parent_revision.revision_id = 'other'; }],
    ['malformed parent digest', (d) => { d.parent_revision.content_digest = 'sha256:parent'; }],
    ['missing shot manifest', (d) => { d.dependency_manifest.shots = []; }],
    ['duplicate shot manifest', (d) => { d.dependency_manifest.shots.push(d.dependency_manifest.shots[0]); }],
    ['mismatched shot manifest', (d) => { d.dependency_manifest.shots[0].internal_timeline_revision_id = 'other'; }],
    ['missing internal manifest', (d) => { d.dependency_manifest.internal_timelines = []; }],
    ['duplicate internal manifest', (d) => { d.dependency_manifest.internal_timelines.push(d.dependency_manifest.internal_timelines[0]); }],
    ['wrong internal scope', (d) => { d.dependency_manifest.internal_timelines[0].timeline_id = 'other'; }],
    ['mismatched internal digest', (d) => { d.dependency_manifest.internal_timelines[0].content_digest = fixtureDigest('other'); }],
    ['missing shot image', (d) => { d.shot_revisions = []; }],
    ['duplicate shot image', (d) => { d.shot_revisions.push(d.shot_revisions[0]); }],
    ['malformed shot payload', (d) => { d.shot_revisions[0].payload = null as unknown as Record<string, unknown>; }],
    ['malformed shot digest', (d) => { d.shot_revisions[0].content_digest = 'sha256:shot'; d.dependency_manifest.shots[0].content_digest = 'sha256:shot'; }],
    ['mismatched payload internal pin', (d) => { d.shot_revisions[0].payload.internal_timeline_revision_id = 'other'; }],
    ['missing internal image', (d) => { d.internal_timeline_revisions = []; }],
    ['duplicate internal image', (d) => { d.internal_timeline_revisions.push(d.internal_timeline_revisions[0]); }],
    ['ambiguous internal link', (d) => {
      d.internal_timeline_revisions.push({ ...d.internal_timeline_revisions[0], timeline_id: 'other-child' });
      d.dependency_manifest.internal_timelines.push({ ...d.dependency_manifest.internal_timelines[0], timeline_id: 'other-child' });
    }],
    ['missing linked internal', (d) => {
      d.internal_timeline_revisions[0].revision_id = 'other';
      d.dependency_manifest.internal_timelines[0].revision_id = 'other';
    }],
    ['malformed internal payload', (d) => { d.internal_timeline_revisions[0].payload = [] as unknown as Record<string, unknown>; }],
    ['missing occurrences', (d) => { delete d.parent_revision.payload.occurrences; }],
    ['missing occurrence pin', (d) => { delete (d.parent_revision.payload.occurrences as Record<string, unknown>[])[0].shot_revision_id; }],
    ['unresolved occurrence', (d) => { (d.parent_revision.payload.occurrences as Record<string, unknown>[])[0].shot_id = 'other'; }],
    ['duplicate occurrence', (d) => {
      const occurrences = d.parent_revision.payload.occurrences as Record<string, unknown>[];
      occurrences.push(occurrences[0]);
    }],
    ['duplicate media pin', (d) => {
      const pin = { media_id: fixtureDigest('media'), content_digest: fixtureDigest('media') };
      d.dependency_manifest.media = [pin, pin];
    }],
    ['duplicate document pin', (d) => {
      const pin = { document_id: 'transcript', version: 1, content_digest: fixtureDigest('words') };
      d.dependency_manifest.documents = [pin, pin];
    }],
  ];
  it.each(malformedClosures)('refuses %s without a readback fallback', async (_label, mutate) => {
    const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' }, { children: true });
    mutate(response.data.canonical_document);
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'token', transport: transportFor(response, requests) });
    await expect(provider.commitTimeline(request(), response.receipt.idempotency_key)).rejects.toThrow();
    expect(requests.filter(({ path }) => path.includes('/revisions/') || path.includes('/inspect'))).toEqual([]);
  });

  it('returns late A exactly without regressing an independently observed newer C cache', async () => {
    const a = accepted('r1', 'p1', 'r0', 'p0');
    const c = accepted('r3', 'p3', 'r2', 'p2');
    c.data.canonical_document.parent_revision.payload.registry = { assets: {}, marker: 'C' };
    c.data.canonical_document.parent_revision.content_digest = fixtureDigest(c.data.canonical_document.parent_revision.payload);
    c.data.document_digest = fixtureDigest(c.data.canonical_document);
    let release!: (response: Awaited<ReturnType<Transport>>) => void;
    let started!: () => void;
    const startedCommit = new Promise<void>((resolve) => { started = resolve; });
    let parentReads = 0;
    const transport: Transport = async (...args) => {
      const path = args[1];
      if (path.endsWith('/commit')) {
        started();
        return new Promise((resolve) => { release = resolve; });
      }
      if (path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
        return { status: 200, headers: {}, body: json({
          project_id: PROJECT_ID,
          timeline_id: TIMELINE_ID,
          version: 1,
          name: TIMELINE_ID,
          archived: false,
          shots: [],
          references: [],
          head_revision_id: 'r3',
          head_publication_id: 'p3',
        }) };
      }
      if (path.endsWith('/inspect')) return { status: 200, headers: {}, body: json({
        project_id: PROJECT_ID, timeline_id: TIMELINE_ID, representation: 'canonical_head',
        authority: 'runtime_parent_composition', is_current_head: true,
        head_revision_id: 'r3', revision_id: 'r3', head_publication_id: 'p3',
      }) };
      if (path.endsWith('/composition-revisions/r3')) {
        parentReads += 1;
        return { status: 200, headers: {}, body: json({ project_id: PROJECT_ID, timeline_id: TIMELINE_ID, ...c.data.canonical_document.parent_revision }) };
      }
      return transportFor(a, [])(...args);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'token', transport });
    const pendingA = provider.commitTimeline(request(), a.receipt.idempotency_key);
    await startedCommit;
    const knownC = await provider.loadTimeline(TIMELINE_ID);
    release({ status: 200, headers: {}, body: json(a) });
    const resultA = await pendingA;
    expect(resultA.response).toEqual(a);
    expect(resultA.accepted).toEqual({ revisionId: 'r1', publicationId: 'p1' });
    const stillC = await provider.loadTimeline(TIMELINE_ID);
    expect(stillC.head).toEqual(knownC.head);
    expect(stillC.configVersion).toBe(knownC.configVersion);
    expect(parentReads).toBe(1);
    expect(await provider.loadAssetRegistry(TIMELINE_ID)).toMatchObject({ marker: 'C' });
  });

  it.each([
    [409, 'head_busy'],
    [503, 'runtime_unavailable'],
  ])('keeps %s %s retryable with its typed reason and exact request', async (status, reason) => {
    const response = accepted('r1', 'p1', 'r0', 'p0');
    const requests: Array<{ body: unknown; key: string | undefined }> = [];
    const transport: Transport = async (...args) => {
      if (!args[1].endsWith('/commit')) return transportFor(response, [])(...args);
      requests.push({ body: JSON.parse(new TextDecoder().decode(args[3] as Uint8Array)), key: args[2]['Idempotency-Key'] });
      if (requests.length === 1) return { status, headers: {}, body: json({ code: status === 409 ? 'conflict' : 'not_ready', message: 'arbitrary prose', details: { status: 'refused', reason } }) };
      return { status: 200, headers: {}, body: json(response) };
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'token', transport });
    const error = await provider.commitTimeline(request(), response.receipt.idempotency_key).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(classifyRuntimeCommitFailure(error)).toBe('unknown');
    expect((error as ApiError).details.reason).toBe(reason);
    await expect(provider.commitTimeline(request(), response.receipt.idempotency_key)).resolves.toHaveProperty('accepted');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it.each(['project', 'command kind', 'document digest'])('refuses a malformed acceptance %s', async (field) => {
    const response = accepted('r1', 'p1', 'r0', 'p0');
    if (field === 'project') response.receipt.project_id = 'other';
    if (field === 'command kind') response.receipt.command_kind = 'other';
    if (field === 'document digest') response.data.document_digest = 'sha256:document';
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'token', transport: transportFor(response, []) });
    await expect(provider.commitTimeline(request(), response.receipt.idempotency_key)).rejects.toThrow('invalid');
  });

  it('keeps recoverable identity scoped to the authenticated actor and realm', async () => {
    const client = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', token: 'token', transport: transportFor(accepted('r1', 'p1', 'r0', 'p0'), []) });
    await expect(client.getRecoverableIdentity()).resolves.toEqual({ actorId: 'actor-1', realmId: 'realm-1' });
  });
});
